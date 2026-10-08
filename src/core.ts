import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { renderViral, transcribeLocal, WHISPER_MODEL } from "./viral.js";

export interface ClipJob {
  url: string;
  start: string | number;
  end: string | number;
  /** Used for the output filename. Defaults to `<videoId>_<start>-<end>`. */
  label?: string;
  /** 9:16 (1080x1920) for Shorts / Reels / TikTok: the whole frame on black, never cropped. */
  vertical?: boolean;
  /** Max video height to download. Default 1080. */
  maxHeight?: number;
  /**
   * Live streams only: re-encode for frame-accurate cuts. By default live clips
   * are stream-copied (fast) and start on the previous keyframe, up to ~5s early.
   */
  precise?: boolean;
  /**
   * "viral": 1080x1920 with a hook header, the video on a blurred backdrop and
   * word-by-word captions. "plain" (default): the clip as-is.
   */
  style?: "plain" | "viral";
  /** Viral only: header hook text. Defaults to the video title; "" for none. */
  title?: string;
  /** Viral only: animated captions. Default true. */
  captions?: boolean;
  /** Viral only: background behind the video, a hex colour (default "#000000") or "blur". */
  background?: string;
  /** Viral only: highlight colour for the spoken word. Default "#FFE600". */
  accent?: string;
}

export interface ClipResult {
  ok: boolean;
  job: ClipJob;
  path?: string;
  durationSec?: number;
  bytes?: number;
  error?: string;
  elapsedMs: number;
  /** Set for clips cut from a live stream: wall-clock time the clip covers. */
  live?: { from?: string; to?: string };
  /** Where the clip starts in the source video, in seconds (VODs). */
  sourceStart?: number;
  /** Live stream-copy clips: seconds of extra footage before the requested start (keyframe snap). */
  leadIn?: number;
  videoTitle?: string;
  /** Non-fatal issues, e.g. captions skipped. */
  warnings?: string[];
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** Word-level timings: exact for YouTube auto-captions, interpolated for manual ones. */
  words?: Word[];
}

export interface Word {
  start: number;
  end: number;
  text: string;
}

export interface VideoInfo {
  id: string;
  title: string;
  channel?: string;
  /** null for live streams. */
  durationSec: number | null;
  /** "is_live" | "was_live" | "is_upcoming" | "not_live" | "post_live" */
  liveStatus?: string;
  chapters: { title: string; start: number; end: number }[];
}

function numericEnv(name: string, fallback: number, valid: (value: number) => boolean, expected: string): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!valid(value)) throw new Error(`${name} must be ${expected}; got ${JSON.stringify(raw)}.`);
  return value;
}

const MAX_CLIP_SEC = numericEnv("CLIPSWARM_MAX_CLIP_SEC", 600, (n) => Number.isFinite(n) && n > 0, "a finite number greater than 0");

// ---------- time helpers ----------

/** Accepts 83, "83", "1:23", "01:01:23.5", and negatives like "-1:30". Returns seconds. */
export function parseTime(t: string | number): number {
  if (typeof t === "number") return t;
  t = t.trim();
  if (t.startsWith("-")) return -parseTime(t.slice(1));
  const parts = t.split(":").map(Number);
  if (!t || parts.some((p) => Number.isNaN(p))) throw new Error(`Invalid timestamp: "${t}"`);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function formatTime(sec: number): string {
  sec = Math.round(sec * 100) / 100;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const rem = Math.round((sec % 60) * 100) / 100;
  const s = (rem < 10 ? "0" : "") + (Number.isInteger(rem) ? rem : rem.toFixed(2));
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// ---------- concurrency ----------

/**
 * Process-wide limiter. Every agent/tool call shares it, so ten agents each
 * asking for ten clips can't launch a hundred yt-dlp processes at once.
 */
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++;
    // A releasing job hands its slot straight to us, so `active` never overshoots.
    else await new Promise<void>((r) => this.queue.push(r));
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export const limiter = new Semaphore(
  numericEnv(
    "CLIPSWARM_CONCURRENCY",
    Math.max(2, Math.min(6, os.cpus().length)),
    (n) => Number.isInteger(n) && n > 0,
    "a positive integer",
  ),
);

// ---------- process helpers ----------

export function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) =>
      reject(new Error(`Failed to run ${cmd}: ${e.message}. Is it installed and on PATH?`)),
    );
    p.on("close", (code) => {
      if (code === 0) return resolve(out);
      let msg = `${cmd} exited ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`;
      // YouTube breaks old yt-dlp versions regularly; this is by far the most common failure.
      if (cmd === "yt-dlp" && /403|ffmpeg exited|Sign in to confirm|nsig/i.test(err))
        msg += " — try updating yt-dlp (`yt-dlp -U`, `brew upgrade yt-dlp`, or `pip install -U yt-dlp`).";
      reject(new Error(msg));
    });
  });
}

const RETRIES = numericEnv("CLIPSWARM_RETRIES", 3, (n) => Number.isInteger(n) && n >= 0, "a non-negative integer");

/** YouTube intermittently 403s individual stream requests; a fresh attempt usually succeeds. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= RETRIES) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
    }
  }
}

let jsRuntimeArgs: Promise<string[]> | undefined;

/**
 * yt-dlp needs a JavaScript runtime to download from YouTube and only enables
 * Deno by default. Node is always present when clipswarm runs, so offer it.
 */
function ytdlp(args: string[]): Promise<string> {
  jsRuntimeArgs ??= exec("yt-dlp", ["--help"]).then(
    (help) => (help.includes("--js-runtimes") ? ["--js-runtimes", `node:${process.execPath}`] : []),
    () => [],
  );
  return jsRuntimeArgs.then((extra) => exec("yt-dlp", [...extra, ...args]));
}

// ---------- video info + transcript ----------

interface RawInfo {
  id: string;
  title: string;
  channel?: string;
  uploader?: string;
  duration: number | null;
  is_live?: boolean;
  live_status?: string;
  formats?: RawFormat[];
  chapters?: { title: string; start_time: number; end_time: number }[] | null;
  subtitles?: Record<string, { ext: string; url: string }[]>;
  automatic_captions?: Record<string, { ext: string; url: string }[]>;
}

interface RawFormat {
  format_id: string;
  url: string;
  protocol?: string;
  vcodec?: string;
  acodec?: string;
  height?: number | null;
  tbr?: number | null;
}

// Many agents often work on the same video; fetch its metadata once.
// Live streams move (and their stream URLs expire), so those entries go stale fast.
const infoCache = new Map<string, { at: number; p: Promise<RawInfo> }>();
const LIVE_INFO_TTL_MS = 20_000;

async function getRawInfo(url: string): Promise<RawInfo> {
  const hit = infoCache.get(url);
  if (hit) {
    const info = await hit.p;
    if (!info.is_live || Date.now() - hit.at < LIVE_INFO_TTL_MS) return info;
  }
  const p = limiter
    .run(() => withRetry(() => ytdlp(["-J", "--no-playlist", "--no-warnings", url])))
    .then((s) => JSON.parse(s) as RawInfo);
  p.catch(() => infoCache.delete(url));
  infoCache.set(url, { at: Date.now(), p });
  return p;
}

export async function getVideoInfo(url: string): Promise<VideoInfo> {
  const r = await getRawInfo(url);
  return {
    id: r.id,
    title: r.title,
    channel: r.channel ?? r.uploader,
    durationSec: r.is_live ? null : r.duration,
    liveStatus: r.live_status,
    chapters: (r.chapters ?? []).map((c) => ({ title: c.title, start: c.start_time, end: c.end_time })),
  };
}

const transcriptCache = new Map<string, Promise<TranscriptSegment[]>>();

/**
 * Timestamped transcript from YouTube captions. `prefer: "manual"` (default)
 * favours human captions for accurate text; `"auto"` favours auto-captions,
 * which carry exact per-word timing (what animated captions need).
 */
export function getTranscript(url: string, lang = "en", prefer: "manual" | "auto" = "manual"): Promise<TranscriptSegment[]> {
  const key = `${url}::${lang}::${prefer}`;
  let p = transcriptCache.get(key);
  if (!p) {
    p = fetchTranscript(url, lang, prefer);
    p.catch(() => transcriptCache.delete(key));
    transcriptCache.set(key, p);
  }
  return p;
}

/** Words spoken between `from` and `to` (seconds), re-based so `from` is 0. */
export async function getWords(url: string, from: number, to: number, lang = "en"): Promise<Word[]> {
  const segs = await getTranscript(url, lang, "auto");
  const words: Word[] = [];
  for (const seg of segs)
    for (const w of seg.words ?? [])
      if (w.end > from && w.start < to)
        words.push({ start: Math.max(0, w.start - from), end: Math.min(to, w.end) - from, text: w.text });
  return words;
}

async function fetchTranscript(url: string, lang: string, prefer: "manual" | "auto"): Promise<TranscriptSegment[]> {
  const info = await getRawInfo(url);
  const pick = (tracks?: Record<string, { ext: string; url: string }[]>) => {
    if (!tracks) return undefined;
    const key =
      Object.keys(tracks).find((k) => k === lang) ??
      Object.keys(tracks).find((k) => k.startsWith(`${lang}-`) && !k.includes("-orig")) ??
      Object.keys(tracks).find((k) => k.startsWith(lang));
    return key ? tracks[key].find((t) => t.ext === "json3") : undefined;
  };
  const track =
    prefer === "manual"
      ? pick(info.subtitles) ?? pick(info.automatic_captions)
      : pick(info.automatic_captions) ?? pick(info.subtitles);
  if (!track)
    throw new Error(
      info.is_live
        ? "Transcripts aren't available while a stream is live. Clip by time instead (e.g. start: -120, end: \"now\")."
        : `No "${lang}" captions available for this video.`,
    );

  const res = await fetch(track.url);
  if (!res.ok) throw new Error(`Caption download failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8: string; tOffsetMs?: number }[] }[];
  };
  return parseJson3(data.events ?? []);
}

export function parseJson3(
  events: { tStartMs?: number; dDurationMs?: number; segs?: { utf8: string; tOffsetMs?: number }[] }[],
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const e of events) {
    if (!e.segs || e.tStartMs === undefined) continue;
    const text = e.segs.map((s) => s.utf8).join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const start = e.tStartMs / 1000;
    const end = start + (e.dDurationMs ?? 0) / 1000;

    let words: Word[];
    if (e.segs.length > 1 || e.segs[0].tOffsetMs !== undefined) {
      // Auto-captions: one seg per word, each with its own offset.
      words = e.segs
        .map((s) => ({ start: start + (s.tOffsetMs ?? 0) / 1000, text: s.utf8.trim() }))
        .filter((w) => w.text)
        .map((w, i, arr) => ({ ...w, end: arr[i + 1]?.start ?? end }));
    } else {
      // Manual captions: spread the line's words across its duration, weighted by length.
      const parts = text.split(" ");
      const total = parts.reduce((n, w) => n + w.length + 1, 0);
      let t = start;
      words = parts.map((w) => {
        const d = ((w.length + 1) / total) * (end - start);
        const word = { start: t, end: t + d, text: w };
        t += d;
        return word;
      });
    }
    segments.push({ start, end, text, words });
  }
  // Auto-caption events overlap (each line stays up until the next one ends); clamp word ends.
  const all = segments.flatMap((s) => s.words ?? []);
  for (let i = 0; i < all.length - 1; i++) all[i].end = Math.min(all[i].end, all[i + 1].start);
  return segments;
}

/** Case-insensitive search; returns matching segments with surrounding context. */
export async function searchTranscript(
  url: string,
  query: string,
  opts: { lang?: string; contextSec?: number; limit?: number } = {},
): Promise<{ start: number; end: number; timestamp: string; text: string }[]> {
  const segs = await getTranscript(url, opts.lang);
  const ctx = opts.contextSec ?? 15;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: { start: number; end: number; timestamp: string; text: string }[] = [];
  for (const s of segs) {
    const t = s.text.toLowerCase();
    if (!terms.every((term) => t.includes(term))) continue;
    // Skip hits already covered by the previous hit's window.
    if (hits.length && s.start < hits[hits.length - 1].end) continue;
    const start = Math.max(0, s.start - ctx);
    const end = s.end + ctx;
    const text = segs.filter((x) => x.end > start && x.start < end).map((x) => x.text).join(" ");
    hits.push({ start, end, timestamp: formatTime(s.start), text });
    if (hits.length >= (opts.limit ?? 20)) break;
  }
  return hits;
}

// ---------- clipping ----------

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "clip";
}

function isAbsolute(t: string | number): boolean {
  return typeof t === "string" && (/^now$/i.test(t.trim()) || /^\d{4}-\d{2}-\d{2}T/.test(t.trim()));
}

function checkLength(start: number, end: number, job: ClipJob) {
  if (!(end > start)) throw new Error(`end (${job.end}) must be after start (${job.start})`);
  if (end - start > MAX_CLIP_SEC)
    throw new Error(`Clip is ${Math.round(end - start)}s; max is ${MAX_CLIP_SEC}s (set CLIPSWARM_MAX_CLIP_SEC to raise).`);
}

/**
 * Cuts one clip. VODs download only the requested section (yt-dlp
 * --download-sections), so a 30-second clip from a 3-hour stream doesn't
 * pull the whole video. Live streams are cut from YouTube's DVR window.
 */
export async function createClip(job: ClipJob, outDir: string): Promise<ClipResult> {
  if (job.style === "viral") return createViralClip(job, outDir);
  const t0 = Date.now();
  try {
    // Catch obviously bad ranges before touching the network.
    if (!isAbsolute(job.start) && !isAbsolute(job.end)) {
      const a = parseTime(job.start);
      const b = parseTime(job.end);
      if ((a >= 0 && b >= 0) || (a < 0 && b <= 0)) checkLength(a, b, job);
    }

    await mkdir(outDir, { recursive: true });
    const info = await getRawInfo(job.url);
    if (info.live_status === "is_upcoming") throw new Error("This stream hasn't started yet.");
    if (info.is_live) return await createLiveClip(job, info, outDir, t0);

    if (isAbsolute(job.start) || isAbsolute(job.end))
      throw new Error('"now" and ISO timestamps only apply to live streams; use offsets like "1:23".');
    // Negative times count back from the end of the video.
    const rel = (t: number) => (t < 0 ? (info.duration ?? 0) + t : t);
    const start = rel(parseTime(job.start));
    const end = rel(parseTime(job.end));
    checkLength(start, end, job);

    const finalPath = outputPath(job, info, outDir, `${formatTime(start)}-${formatTime(end)}`);
    const h = job.maxHeight ?? 1080;

    await limiter.run(async () => {
      const raw = job.vertical ? finalPath.replace(/\.mp4$/, ".src.mp4") : finalPath;
      await withRetry(() => ytdlp([
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "--force-overwrites",
        "-f",
        `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b`,
        "--download-sections",
        `*${start}-${end}`,
        "--force-keyframes-at-cuts",
        "--merge-output-format",
        "mp4",
        "-o",
        raw,
        job.url,
      ]));
      if (job.vertical) {
        const rendered = finalPath + ".tmp.mp4";
        try {
          await exec("ffmpeg", [
            "-y", "-loglevel", "error", "-i", raw,
            "-vf", VERTICAL_FILTER,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy",
            rendered,
          ]);
          await rename(rendered, finalPath);
        } finally {
          await Promise.all([rm(raw, { force: true }), rm(rendered, { force: true })]);
        }
      }
    });

    const { size } = await stat(finalPath);
    return {
      ok: true,
      job,
      path: finalPath,
      durationSec: end - start,
      bytes: size,
      elapsedMs: Date.now() - t0,
      sourceStart: start,
      videoTitle: info.title,
    };
  } catch (e) {
    return { ok: false, job, error: (e as Error).message, elapsedMs: Date.now() - t0 };
  }
}

// Fit the whole frame into 9:16 and pad with black. Never crop: what matters may be anywhere in the frame.
const VERTICAL_FILTER = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1";

function outputPath(job: ClipJob, info: RawInfo, outDir: string, range: string): string {
  const name = slug(job.label ?? `${info.id}_${range}`);
  return path.resolve(outDir, `${name}${job.vertical ? "_vertical" : ""}.mp4`);
}

// ---------- live streams ----------

interface HlsSegment {
  seq: number;
  /** Seconds from the start of the playlist window. */
  start: number;
  dur: number;
  url: string;
  /** Wall-clock start, epoch ms (from EXT-X-PROGRAM-DATE-TIME). */
  pdt?: number;
}

export function parsePlaylist(text: string): HlsSegment[] {
  const segs: HlsSegment[] = [];
  let seq = 0;
  let t = 0;
  let dur = 0;
  let pdt: number | undefined;
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (l.startsWith("#EXT-X-MEDIA-SEQUENCE:")) seq = Number(l.slice(22));
    else if (l.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) pdt = Date.parse(l.slice(25));
    else if (l.startsWith("#EXTINF:")) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith("#")) {
      segs.push({ seq, start: t, dur, url: l, pdt });
      seq++;
      t += dur;
      if (pdt !== undefined) pdt += dur * 1000;
    }
  }
  return segs;
}

async function fetchPlaylist(url: string): Promise<HlsSegment[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Live playlist request failed: HTTP ${res.status}`);
  const segs = parsePlaylist(await res.text());
  if (!segs.length) throw new Error("Live playlist is empty.");
  return segs;
}

/**
 * Resolves a live-stream time to seconds within the DVR window.
 * Accepts "now", negative offsets from the live edge (-90, "-1:30"), or ISO timestamps.
 */
export function resolveLiveTime(t: string | number, segs: HlsSegment[]): number {
  const last = segs[segs.length - 1];
  const edge = last.start + last.dur;
  if (typeof t === "string" && /^now$/i.test(t.trim())) return edge;
  if (typeof t === "string" && /^\d{4}-\d{2}-\d{2}T/.test(t.trim())) {
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) throw new Error(`Invalid timestamp: "${t}"`);
    if (segs[0].pdt === undefined) throw new Error("This stream doesn't expose wall-clock times; use offsets like -90.");
    return (ms - segs[0].pdt) / 1000;
  }
  const v = parseTime(t);
  if (v > 0)
    throw new Error(
      `For live streams, use "now", negative offsets from the live edge (e.g. start: -90, end: -30), or ISO timestamps. Got "${t}".`,
    );
  return edge + v;
}

function pickLiveFormats(info: RawInfo, maxHeight: number) {
  const hls = (info.formats ?? []).filter((f) => f.protocol?.startsWith("m3u8") && f.url);
  const video = hls
    .filter((f) => f.vcodec && f.vcodec !== "none" && (f.height ?? 0) <= maxHeight)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0))[0];
  if (!video) throw new Error("No HLS stream found for this live video.");
  // YouTube's live HLS video renditions are usually video-only; pair with the best audio rendition.
  const audio =
    video.acodec && video.acodec !== "none"
      ? undefined
      : hls
          // yt-dlp often reports live audio renditions' acodec as unknown (null).
          .filter((f) => f.vcodec === "none" && f.acodec !== "none")
          .sort((a, b) => (b.tbr ?? 0) - (a.tbr ?? 0) || Number(b.format_id) - Number(a.format_id))[0];
  return { video, audio };
}

async function downloadSegments(segs: HlsSegment[], file: string): Promise<void> {
  const bufs: Buffer[] = new Array(segs.length);
  let next = 0;
  const worker = async () => {
    while (next < segs.length) {
      const i = next++;
      bufs[i] = await withRetry(async () => {
        const r = await fetch(segs[i].url);
        if (!r.ok) throw new Error(`Segment ${segs[i].seq} failed: HTTP ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, segs.length) }, worker));
  await writeFile(file, Buffer.concat(bufs));
}

async function createLiveClip(job: ClipJob, info: RawInfo, outDir: string, t0: number): Promise<ClipResult> {
  const { video, audio } = pickLiveFormats(info, job.maxHeight ?? 1080);
  const [vSegs, aSegs] = await Promise.all([fetchPlaylist(video.url), audio ? fetchPlaylist(audio.url) : undefined]);

  const window = vSegs[vSegs.length - 1].start + vSegs[vSegs.length - 1].dur;
  const start = resolveLiveTime(job.start, vSegs);
  const end = resolveLiveTime(job.end, vSegs);
  checkLength(start, end, job);
  if (start < 0)
    throw new Error(`That's further back than YouTube keeps for this stream (about the last ${Math.floor(window / 60)} min).`);
  if (end > window + 1) throw new Error("end is in the future. Wait until it has aired, then retry.");

  const vSel = vSegs.filter((s) => s.start + s.dur > start && s.start < end);
  const seqs = new Set(vSel.map((s) => s.seq));
  const aSel = aSegs?.filter((s) => seqs.has(s.seq));
  // Re-encoding 720p60+ is slow, so by default copy streams and start on the
  // segment's keyframe. YouTube live segments each begin with one.
  const reencode = !!(job.vertical || job.precise);
  const from = reencode ? start : vSel[0].start;
  const offset = from - vSel[0].start;
  const wall = (sec: number) =>
    vSegs[0].pdt !== undefined ? new Date(vSegs[0].pdt + sec * 1000).toISOString() : undefined;

  const stamp = (wall(from) ?? `${Date.now()}`).replace(/[:.]/g, "-").slice(0, 19);
  const finalPath = outputPath(job, info, outDir, `live-${stamp}`);

  await limiter.run(async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "clipswarm-"));
    try {
      const vFile = path.join(tmp, "v.ts");
      const aFile = path.join(tmp, "a.ts");
      await Promise.all([downloadSegments(vSel, vFile), aSel?.length ? downloadSegments(aSel, aFile) : undefined]);
      const hasAudio = !!aSel?.length;
      const aOffset = hasAudio ? from - vSel.find((s) => s.seq === aSel![0].seq)!.start : 0;
      await exec("ffmpeg", [
        "-y", "-loglevel", "error",
        ...(offset > 0 ? ["-ss", String(offset)] : []), "-i", vFile,
        ...(hasAudio ? [...(aOffset > 0 ? ["-ss", String(aOffset)] : []), "-i", aFile] : []),
        "-t", String(end - from),
        "-map", "0:v:0", ...(hasAudio ? ["-map", "1:a:0"] : ["-map", "0:a?"]),
        ...(job.vertical ? ["-vf", VERTICAL_FILTER] : []),
        ...(reencode ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"] : ["-c:v", "copy"]),
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        `${finalPath}.part.mp4`,
      ]);
      await rename(`${finalPath}.part.mp4`, finalPath);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  const { size } = await stat(finalPath);
  return {
    ok: true,
    job,
    path: finalPath,
    durationSec: end - from,
    bytes: size,
    elapsedMs: Date.now() - t0,
    live: { from: wall(from), to: wall(end) },
    leadIn: start - from,
    videoTitle: info.title,
  };
}

/**
 * Cuts a plain clip into a temp dir, gets word timings (YouTube captions for
 * VODs, local whisper.cpp for live streams or videos without captions), then
 * renders the 9:16 viral version.
 */
async function createViralClip(job: ClipJob, outDir: string): Promise<ClipResult> {
  const t0 = Date.now();
  let tmp: string | undefined;
  try {
    tmp = await mkdtemp(path.join(os.tmpdir(), "clipswarm-src-"));
    const base = await createClip({ ...job, style: "plain", vertical: false, label: "src" }, tmp);
    if (!base.ok) return { ...base, job, elapsedMs: Date.now() - t0 };

    const warnings: string[] = [];
    const lead = base.leadIn ?? 0;
    let words: Word[] | undefined;
    if (job.captions !== false) {
      if (base.sourceStart !== undefined)
        words = await getWords(job.url, base.sourceStart, base.sourceStart + base.durationSec!).catch(() => undefined);
      if (!words?.length) words = await limiter.run(() => transcribeLocal(base.path!)).then(
        // Re-base whisper's timings past any keyframe lead-in that renderViral trims off.
        (w) => w?.map((x) => ({ ...x, start: x.start - lead, end: x.end - lead })).filter((x) => x.end > 0),
      ).catch((e) => {
        warnings.push(`Local transcription failed: ${(e as Error).message}`);
        return undefined;
      });
      const transcribed = words !== undefined;
      if (!words?.length && transcribed && !warnings.length) warnings.push("No speech detected in this clip; rendered without captions.");
      else if (!words?.length && !warnings.length)
        warnings.push(
          `No captions: ${base.live ? "live streams have no YouTube captions" : "this video has no captions"}. ` +
            `Install whisper.cpp and run \`clipswarm setup\` to transcribe locally (model: ${WHISPER_MODEL}).`,
        );
    }

    const at = base.sourceStart !== undefined ? formatTime(base.sourceStart) : base.live?.from ?? String(Date.now());
    const name = slug(job.label ?? `${(base.videoTitle ?? "clip").slice(0, 40)}-${at}`);
    const dest = path.resolve(outDir, `${name}_viral.mp4`);
    await mkdir(outDir, { recursive: true });
    await limiter.run(() =>
      renderViral(base.path!, dest, words, {
        title: job.title ?? base.videoTitle,
        captions: job.captions,
        background: job.background,
        accent: job.accent,
        trimStart: lead,
      }),
    );
    const { size } = await stat(dest);
    const live = base.live?.from
      ? { ...base.live, from: new Date(Date.parse(base.live.from) + lead * 1000).toISOString() }
      : base.live;
    return {
      ...base,
      job,
      path: dest,
      live,
      leadIn: undefined,
      durationSec: base.durationSec! - lead,
      bytes: size,
      elapsedMs: Date.now() - t0,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (e) {
    return { ok: false, job, error: (e as Error).message, elapsedMs: Date.now() - t0 };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

/** Runs all jobs concurrently (bounded by the shared limiter). Never throws; check `ok` per result. */
export function createClips(jobs: ClipJob[], outDir: string): Promise<ClipResult[]> {
  return Promise.all(jobs.map((j) => createClip(j, outDir)));
}
