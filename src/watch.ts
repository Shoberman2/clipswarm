/**
 * Watches: "every 6h, find new videos about X and clip them."
 *
 * A watch is a YouTube search plus filters. Each run finds videos it hasn't
 * seen and auto-clips them: an AI pass via the local Claude Code CLI picks
 * moments and writes hooks, falling back to YouTube's "Most replayed" peaks and
 * then a transcript heuristic. Anything it can't clip, and live streams, land
 * in an inbox for an AI agent.
 *
 * State lives in ~/.clipswarm/state.json (override with CLIPSWARM_HOME).
 * Scheduling is external and stateless: `clipswarm watch run` runs whatever is
 * due, so launchd, cron, `watch daemon` or an agent loop can all drive it.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createClips,
  exec,
  formatTime,
  getRawInfo,
  getTranscript,
  limiter,
  slug,
  ytdlp,
  type ClipJob,
  type RawInfo,
  type TranscriptSegment,
  type Word,
} from "./core.js";
import { sanitize, transcribeUrl } from "./viral.js";
import { hasClaudeCli, pickFromTranscript, pickWithAI, type Moment } from "./pick.js";

export interface Watch {
  id: string;
  /** What to look for, as you'd type it into YouTube search. */
  query: string;
  everyMinutes: number;
  /** Only videos uploaded within this many hours. Default 72. */
  maxAgeHours?: number;
  minViews?: number;
  /** Default 120: skips Shorts and trailers. */
  minDurationSec?: number;
  /** Default 4h. */
  maxDurationSec?: number;
  /** New videos to process per run. Default 3. */
  maxVideosPerRun?: number;
  /** Auto-clip new videos. Default true. Off = inbox only. */
  autoClip?: boolean;
  /** How to choose moments. Default "auto": AI (Claude Code CLI) → most-replayed → transcript heuristic. */
  picker?: Picker;
  /** Default 2. */
  clipsPerVideo?: number;
  /** Target clip length. Default 45. */
  clipSeconds?: number;
  /** Default "viral". */
  style?: "viral" | "plain";
  /** Also surface streams that are live right now. Default false. */
  includeLive?: boolean;
  /** Default ~/clipswarm/<id>. */
  outDir?: string;
  createdAt: string;
  lastRunAt?: string;
}

export type InboxStatus = "clipped" | "needs_agent" | "live" | "failed" | "done" | "dismissed";

export interface InboxItem {
  watchId: string;
  videoId: string;
  url: string;
  title: string;
  channel?: string;
  durationSec?: number | null;
  views?: number | null;
  uploadedAt?: string;
  foundAt: string;
  status: InboxStatus;
  clips?: string[];
  note?: string;
}

interface State {
  watches: Watch[];
  /** Video ids each watch has already handled. */
  seen: Record<string, string[]>;
  inbox: InboxItem[];
}

// ---------- state ----------

export const HOME = process.env.CLIPSWARM_HOME ?? path.join(os.homedir(), ".clipswarm");
const STATE = () => path.join(HOME, "state.json");

async function load(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE(), "utf8")) as State;
  } catch {
    return { watches: [], seen: {}, inbox: [] };
  }
}

/**
 * Read-modify-write under a lock directory, so a scheduled run and the MCP
 * server never clobber each other's writes. Locks older than 2 min are stale.
 */
async function update<T>(fn: (s: State) => T | Promise<T>): Promise<T> {
  await mkdir(HOME, { recursive: true });
  const lock = path.join(HOME, "state.lock");
  for (let i = 0; ; i++) {
    try {
      await mkdir(lock);
      break;
    } catch {
      const { mtimeMs } = await stat(lock).catch(() => ({ mtimeMs: 0 }));
      if (Date.now() - mtimeMs > 120_000) await rm(lock, { recursive: true, force: true });
      else if (i > 200) throw new Error(`Timed out waiting for ${lock}`);
      else await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    const state = await load();
    const result = await fn(state);
    // Keep the inbox and seen-lists bounded.
    state.inbox = state.inbox.slice(-500);
    for (const k of Object.keys(state.seen)) state.seen[k] = state.seen[k].slice(-2000);
    await writeFile(STATE() + ".tmp", JSON.stringify(state, null, 2));
    await rename(STATE() + ".tmp", STATE());
    return result;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

// ---------- watch management ----------

/** "90", "30m", "6h", "1d" -> minutes. */
export function parseInterval(s: string | number): number {
  let minutes: number;
  if (typeof s === "number") minutes = s;
  else {
    const m = /^(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|d|day|days)?$/i.exec(s.trim());
    if (!m) throw new Error(`Invalid interval "${s}". Use e.g. 30m, 6h, 1d.`);
    const n = Number(m[1]);
    const unit = (m[2] ?? "m").toLowerCase()[0];
    minutes = unit === "d" ? n * 1440 : unit === "h" ? n * 60 : n;
  }
  if (!Number.isFinite(minutes) || minutes < 5) throw new Error("Minimum interval is 5 minutes.");
  return Math.round(minutes);
}

export async function addWatch(input: Omit<Watch, "id" | "createdAt"> & { id?: string }): Promise<Watch> {
  if (!input.query?.trim()) throw new Error("A watch needs a query (the category to search for).");
  const watch: Watch = { ...input, id: slug(input.id ?? input.query), createdAt: new Date().toISOString() };
  return update((s) => {
    s.watches = s.watches.filter((w) => w.id !== watch.id).concat(watch);
    return watch;
  });
}

export async function listWatches(): Promise<(Watch & { nextRunAt: string })[]> {
  const s = await load();
  return s.watches.map((w) => ({ ...w, nextRunAt: new Date(nextRun(w)).toISOString() }));
}

export async function removeWatch(id: string): Promise<boolean> {
  return update((s) => {
    const before = s.watches.length;
    s.watches = s.watches.filter((w) => w.id !== id);
    delete s.seen[id];
    return s.watches.length < before;
  });
}

export async function getInbox(filter: { status?: InboxStatus; watchId?: string } = {}): Promise<InboxItem[]> {
  const s = await load();
  return s.inbox.filter((i) => (!filter.status || i.status === filter.status) && (!filter.watchId || i.watchId === filter.watchId));
}

export async function setInboxStatus(videoId: string, status: InboxStatus, note?: string): Promise<boolean> {
  return update((s) => {
    const items = s.inbox.filter((i) => i.videoId === videoId);
    for (const i of items) Object.assign(i, { status }, note ? { note } : {});
    return items.length > 0;
  });
}

const nextRun = (w: Watch) => (w.lastRunAt ? Date.parse(w.lastRunAt) : 0) + w.everyMinutes * 60_000;
export const isDue = (w: Watch, now = Date.now()) => nextRun(w) <= now;

// ---------- picking moments ----------

/**
 * Turns the "Most replayed" heatmap into clip windows: the highest peaks,
 * skipping the intro spike everyone watches and the outro, non-overlapping.
 */
export function pickMoments(
  heatmap: { start_time: number; end_time: number; value: number }[],
  duration: number,
  count: number,
  clipSec: number,
): { start: number; end: number; score: number }[] {
  const usable = heatmap.filter((b) => b.start_time >= Math.max(15, duration * 0.03) && b.end_time <= duration * 0.97);
  const values = usable.map((b) => b.value).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)] ?? 0;
  const picks: { start: number; end: number; score: number }[] = [];
  for (const b of [...usable].sort((a, b) => b.value - a.value)) {
    if (picks.length >= count) break;
    if (b.value < median * 1.15) break; // flat curve: no real peak left
    const mid = (b.start_time + b.end_time) / 2;
    // Peaks mark the payoff, so start well before it.
    const start = Math.max(0, mid - clipSec * 0.65);
    const end = Math.min(duration, start + clipSec);
    if (picks.some((p) => start < p.end + 5 && end > p.start - 5)) continue;
    picks.push({ start, end, score: b.value });
  }
  return picks.sort((a, b) => a.start - b.start);
}

/** Moves a window's edges to caption-line boundaries so clips don't cut mid-sentence. */
export function snapToSentences(win: { start: number; end: number }, segs: TranscriptSegment[], maxShift = 6) {
  const starts = segs.map((s) => s.start).filter((t) => Math.abs(t - win.start) <= maxShift);
  const ends = segs.map((s) => s.end).filter((t) => Math.abs(t - win.end) <= maxShift);
  const nearest = (arr: number[], t: number) => arr.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), arr[0]);
  const start = starts.length ? nearest(starts, win.start) : win.start;
  const end = ends.length ? nearest(ends, win.end) : win.end;
  return end - start > 8 ? { start: Math.max(0, start - 0.3), end: end + 0.3 } : win;
}

/** Groups whisper words into caption-like lines (break on sentence ends, pauses, or ~12 words). */
export function wordsToSegments(words: Word[]): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    segs.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(" "), words: cur });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 0.8 || cur.length >= 12)) flush();
    cur.push(w);
    if (/[.?!]$/.test(w.text)) flush();
  }
  flush();
  return segs;
}

/** A video title cleaned up for the header card. */
export function hookFromTitle(title: string): string {
  let t = sanitize(title)
    .replace(/\s*[|•–—-]\s*[^|•–—-]*$/, (m) => (m.length < title.length / 2 ? "" : m)) // trailing "| Channel"
    .replace(/#\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t === t.toUpperCase() && /[A-Z]/.test(t)) t = t.toLowerCase().replace(/(^|[.!?]\s+)([a-z])/g, (m) => m.toUpperCase());
  return t.length > 90 ? t.slice(0, 87).replace(/\s+\S*$/, "") + "…" : t;
}

// ---------- discovery ----------

export function searchUrl(query: string, live: boolean): string {
  // sp=CAI%3D sorts by upload date; EgJAAQ%3D%3D filters to live now.
  const params = new URLSearchParams({ search_query: query, sp: live ? "EgJAAQ==" : "CAI=" });
  return `https://www.youtube.com/results?${params}`;
}

interface FlatEntry {
  id: string;
  title?: string;
  channel?: string;
  duration?: number | null;
  view_count?: number | null;
}

async function search(query: string, live: boolean, limit: number): Promise<FlatEntry[]> {
  const out = await ytdlp(["--flat-playlist", "-J", "--no-warnings", "--playlist-end", String(limit), searchUrl(query, live)]);
  return ((JSON.parse(out) as { entries?: FlatEntry[] }).entries ?? []).filter((e) => e.id && e.id.length === 11);
}

// ---------- running ----------

export interface RunReport {
  watchId: string;
  found: number;
  clipped: number;
  inbox: InboxItem[];
  errors: string[];
}

export type Picker = "auto" | "ai" | "heatmap" | "transcript";

/**
 * Picks moments with the best available method:
 *  ai: the local Claude Code CLI reads the transcript, picks moments and writes hooks
 *  heatmap: YouTube's "Most replayed" peaks (only on videos a few days old or more)
 *  transcript: a free heuristic over the captions
 * "auto" tries them in that order.
 */
async function chooseMoments(watch: Watch, info: RawInfo, segs: TranscriptSegment[]): Promise<{ moments: Moment[]; method: string; warnings: string[] }> {
  const duration = info.duration ?? 0;
  const count = watch.clipsPerVideo ?? 2;
  const clipSec = watch.clipSeconds ?? 45;
  const picker = watch.picker ?? "auto";
  const warnings: string[] = [];
  const peaks = pickMoments(info.heatmap ?? [], duration, count, clipSec);

  if ((picker === "auto" || picker === "ai") && segs.length && (await hasClaudeCli())) {
    try {
      const peakMids = peaks.map((p) => p.start + clipSec * 0.65);
      const moments = await pickWithAI(info.title, segs, duration, count, clipSec, peakMids);
      if (moments.length) return { moments, method: "AI (Claude)", warnings };
      warnings.push("AI picker returned no usable moments.");
    } catch (e) {
      warnings.push(`AI picker failed: ${(e as Error).message}`);
    }
  } else if (picker === "ai") warnings.push(segs.length ? "Claude Code CLI not found." : "No transcript for the AI picker.");

  if ((picker === "auto" || picker === "heatmap") && peaks.length)
    return { moments: peaks.map((p) => snapToSentences(p, segs)), method: "most-replayed peaks", warnings };
  if (picker === "auto" || picker === "transcript") {
    const moments = pickFromTranscript(segs, duration, count, clipSec);
    if (moments.length) return { moments, method: "transcript heuristic", warnings };
  }
  return { moments: [], method: "none", warnings };
}

async function clipVideo(watch: Watch, info: RawInfo, url: string): Promise<Pick<InboxItem, "status" | "clips" | "note">> {
  let transcriptNote = "";
  let segs = await getTranscript(url, "en").catch((e) => {
    transcriptNote = (e as Error).message;
    return [] as TranscriptSegment[];
  });
  if (!segs.length && (info.duration ?? 0) <= 2 * 3600) {
    // Captions missing or rate-limited: transcribe the audio locally instead.
    const words = await limiter.run(() => transcribeUrl(url)).catch((e) => {
      transcriptNote += ` Local transcription failed: ${(e as Error).message}`;
      return undefined;
    });
    if (words?.length) segs = wordsToSegments(words);
    else if (words === undefined && !transcriptNote.includes("Local"))
      transcriptNote += " Install whisper.cpp and run `clipswarm setup` to transcribe locally when captions are unavailable.";
  }
  const { moments, method, warnings } = await chooseMoments(watch, info, segs);
  if (!segs.length && transcriptNote) warnings.push(transcriptNote);
  if (!moments.length)
    return { status: "needs_agent", note: [segs.length ? "Couldn't pick moments automatically." : "No transcript available.", ...warnings].join(" ") };
  const fallbackHook = hookFromTitle(info.title);
  const day = new Date().toISOString().slice(0, 10);
  const jobs: ClipJob[] = moments.map((m, i) => ({
    url,
    start: Number(m.start.toFixed(2)),
    end: Number(m.end.toFixed(2)),
    style: watch.style ?? "viral",
    title: m.hook ?? fallbackHook,
    label: `${day}-${slug(info.title).slice(0, 40)}-${i + 1}`,
  }));
  const results = await createClips(jobs, watch.outDir ?? path.join(os.homedir(), "clipswarm", watch.id));
  const ok = results.filter((r) => r.ok).map((r) => r.path!);
  const errs = results.filter((r) => !r.ok).map((r) => r.error);
  const summary = moments.map((m) => `${formatTime(m.start)}${m.hook ? ` "${m.hook}"` : ""}`).join(", ");
  return ok.length
    ? { status: "clipped", clips: ok, note: [`Picked by ${method}: ${summary}`, ...warnings, ...errs].join(" | ") }
    : { status: "failed", note: [...errs, ...warnings].join("; ") };
}

/** Runs one watch now: finds new videos, clips them, updates the inbox. */
export async function runWatch(id: string): Promise<RunReport> {
  const state = await load();
  const watch = state.watches.find((w) => w.id === id);
  if (!watch) throw new Error(`No watch "${id}".`);
  const report: RunReport = { watchId: id, found: 0, clipped: 0, inbox: [], errors: [] };
  const now = Date.now();
  const maxAge = (watch.maxAgeHours ?? 72) * 3600_000;
  const seen = new Set(state.seen[id] ?? []);

  const fresh: FlatEntry[] = [];
  try {
    for (const e of await search(watch.query, false, 40)) {
      if (seen.has(e.id)) continue;
      if (e.duration != null && (e.duration < (watch.minDurationSec ?? 120) || e.duration > (watch.maxDurationSec ?? 4 * 3600))) continue;
      if (watch.minViews && (e.view_count ?? 0) < watch.minViews) continue;
      fresh.push(e);
    }
  } catch (e) {
    report.errors.push(`Search failed: ${(e as Error).message}`);
  }

  // Take the newest qualifying videos (the full metadata has the upload time).
  const handled: string[] = [];
  const picked: { url: string; info: RawInfo }[] = [];
  for (const e of fresh) {
    if (picked.length >= (watch.maxVideosPerRun ?? 3)) break;
    const url = `https://www.youtube.com/watch?v=${e.id}`;
    try {
      const info = await getRawInfo(url);
      handled.push(e.id); // too-old ones are marked seen too, so they aren't re-fetched
      const uploaded = (info.timestamp ?? info.release_timestamp ?? 0) * 1000;
      if (uploaded && now - uploaded > maxAge) continue;
      if (info.is_live || info.live_status === "is_upcoming") continue;
      picked.push({ url, info });
    } catch (err) {
      report.errors.push(`${e.id}: ${(err as Error).message}`);
    }
  }
  report.found = picked.length;

  // Clip the videos in parallel; the shared limiter keeps the machine from overloading.
  const newItems: InboxItem[] = await Promise.all(
    picked.map(async ({ url, info }) => {
      const uploaded = (info.timestamp ?? info.release_timestamp ?? 0) * 1000;
      const item: InboxItem = {
        watchId: id,
        videoId: info.id,
        url,
        title: info.title,
        channel: info.channel ?? info.uploader,
        durationSec: info.duration,
        views: info.view_count,
        uploadedAt: uploaded ? new Date(uploaded).toISOString() : undefined,
        foundAt: new Date().toISOString(),
        status: "needs_agent",
      };
      if (watch.autoClip === false) item.note = "Auto-clip is off for this watch.";
      else
        Object.assign(
          item,
          await clipVideo(watch, info, url).catch((e) => ({ status: "failed" as const, note: (e as Error).message })),
        );
      if (item.status === "clipped") report.clipped += item.clips!.length;
      return item;
    }),
  );

  if (watch.includeLive) {
    try {
      for (const e of await search(watch.query, true, 5)) {
        if (seen.has(`live:${e.id}`)) continue;
        handled.push(`live:${e.id}`);
        newItems.push({
          watchId: id,
          videoId: e.id,
          url: `https://www.youtube.com/watch?v=${e.id}`,
          title: e.title ?? e.id,
          channel: e.channel,
          foundAt: new Date().toISOString(),
          status: "live",
          note: 'Live now. Clip recent moments with start: -60, end: "now".',
        });
      }
    } catch (e) {
      report.errors.push(`Live search failed: ${(e as Error).message}`);
    }
  }

  await update((s) => {
    s.seen[id] = [...(s.seen[id] ?? []), ...handled];
    for (const item of newItems) {
      const idx = s.inbox.findIndex((i) => i.watchId === id && i.videoId === item.videoId);
      if (idx >= 0) s.inbox[idx] = item;
      else s.inbox.push(item);
    }
    const w = s.watches.find((x) => x.id === id);
    if (w) w.lastRunAt = new Date(now).toISOString();
  });
  report.inbox = newItems;
  if (report.clipped) await notify(`${report.clipped} new clip${report.clipped > 1 ? "s" : ""} for "${watch.query}"`);
  return report;
}

/** Runs every watch that's due (or all of them with force). Safe to call often. */
export async function runDue(force = false): Promise<RunReport[]> {
  const due = (await load()).watches.filter((w) => force || isDue(w));
  const reports: RunReport[] = [];
  for (const w of due) {
    try {
      reports.push(await runWatch(w.id));
    } catch (e) {
      reports.push({ watchId: w.id, found: 0, clipped: 0, inbox: [], errors: [(e as Error).message] });
    }
  }
  return reports;
}

async function notify(message: string) {
  if (process.platform !== "darwin" || process.env.CLIPSWARM_NO_NOTIFY) return;
  const esc = message.replace(/["\\]/g, "\\$&");
  await exec("osascript", ["-e", `display notification "${esc}" with title "clipswarm"`]).catch(() => {});
}

// ---------- scheduling ----------

const LABEL = "dev.clipswarm.watch";
const WIN_TASK = "clipswarm-watch";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

/**
 * Installs a background job that runs `clipswarm watch run` every few minutes
 * (each watch still only runs at its own interval). launchd on macOS; on
 * other platforms, returns a crontab line to add.
 */
export async function installScheduler(cliPath: string, checkEveryMin = 5): Promise<string> {
  const args = [process.execPath, cliPath, "watch", "run"];
  if (process.platform === "win32") {
    await mkdir(HOME, { recursive: true });
    // Task Scheduler runs the command through cmd, which handles the log redirect.
    const log = path.join(HOME, "watch.log");
    const tr = `cmd /c ""${process.execPath}" "${cliPath}" watch run >> "${log}" 2>&1"`;
    await exec("schtasks", ["/Create", "/F", "/SC", "MINUTE", "/MO", String(checkEveryMin), "/TN", WIN_TASK, "/TR", tr]);
    return `Installed scheduled task "${WIN_TASK}": checks every ${checkEveryMin} min. Log: ${log}`;
  }
  if (process.platform !== "darwin")
    return `Add this line with \`crontab -e\`:\n*/${checkEveryMin} * * * * PATH=${process.env.PATH} ${args.join(" ")} >> ${path.join(HOME, "watch.log")} 2>&1`;
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>StartInterval</key><integer>${checkEveryMin * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string>
    ${process.env.CLIPSWARM_HOME ? `<key>CLIPSWARM_HOME</key><string>${xml(HOME)}</string>` : ""}
  </dict>
  <key>StandardOutPath</key><string>${xml(path.join(HOME, "watch.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(HOME, "watch.log"))}</string>
</dict></plist>
`;
  await mkdir(path.dirname(PLIST), { recursive: true });
  await mkdir(HOME, { recursive: true });
  await writeFile(PLIST, plist);
  const uid = String(process.getuid?.() ?? 501);
  await exec("launchctl", ["bootout", `gui/${uid}`, PLIST]).catch(() => {});
  await exec("launchctl", ["bootstrap", `gui/${uid}`, PLIST]);
  const npxWarning = cliPath.includes("_npx")
    ? "\nNote: this points at an npx cache copy, which npm may delete. For a durable install run `npm i -g clipswarm` and re-run `clipswarm watch install`."
    : "";
  return `Installed background job ${LABEL}: checks every ${checkEveryMin} min. Log: ${path.join(HOME, "watch.log")}${npxWarning}`;
}

export async function uninstallScheduler(): Promise<string> {
  if (process.platform === "win32") {
    await exec("schtasks", ["/Delete", "/F", "/TN", WIN_TASK]).catch(() => {});
    return `Removed scheduled task "${WIN_TASK}".`;
  }
  if (process.platform !== "darwin") return "Remove the clipswarm line with `crontab -e`.";
  const uid = String(process.getuid?.() ?? 501);
  await exec("launchctl", ["bootout", `gui/${uid}`, PLIST]).catch(() => {});
  await rm(PLIST, { force: true });
  return `Removed background job ${LABEL}.`;
}

export async function schedulerStatus(): Promise<{ installed: boolean; detail: string }> {
  if (process.platform === "win32") {
    const ok = await exec("schtasks", ["/Query", "/TN", WIN_TASK]).then(() => true, () => false);
    return { installed: ok, detail: ok ? `Scheduled task "${WIN_TASK}" is installed.` : "Not installed. Run `clipswarm watch install`." };
  }
  if (process.platform !== "darwin") return { installed: false, detail: "Check `crontab -l` for a clipswarm line." };
  if (!existsSync(PLIST)) return { installed: false, detail: "Not installed. Run `clipswarm watch install`." };
  const uid = String(process.getuid?.() ?? 501);
  const loaded = await exec("launchctl", ["print", `gui/${uid}/${LABEL}`]).then(() => true, () => false);
  return { installed: loaded, detail: loaded ? `Running (${PLIST})` : `Plist exists but isn't loaded: ${PLIST}` };
}
