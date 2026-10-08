import { spawn } from "node:child_process";
import { mkdir, rm, stat, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface ClipJob {
  url: string;
  start: string | number;
  end: string | number;
  /** Used for the output filename. Defaults to `<videoId>_<start>-<end>`. */
  label?: string;
  /** Crop to 9:16 (1080x1920) for Shorts / Reels / TikTok. */
  vertical?: boolean;
  /** Max video height to download. Default 1080. */
  maxHeight?: number;
}

export interface ClipResult {
  ok: boolean;
  job: ClipJob;
  path?: string;
  durationSec?: number;
  bytes?: number;
  error?: string;
  elapsedMs: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface VideoInfo {
  id: string;
  title: string;
  channel?: string;
  durationSec: number;
  chapters: { title: string; start: number; end: number }[];
}

const MAX_CLIP_SEC = Number(process.env.CLIPSWARM_MAX_CLIP_SEC ?? 600);

// ---------- time helpers ----------

/** Accepts 83, "83", "1:23", "01:01:23.5". Returns seconds. */
export function parseTime(t: string | number): number {
  if (typeof t === "number") return t;
  const parts = t.trim().split(":").map(Number);
  if (parts.some((p) => Number.isNaN(p))) throw new Error(`Invalid timestamp: "${t}"`);
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
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export const limiter = new Semaphore(
  Number(process.env.CLIPSWARM_CONCURRENCY ?? Math.max(2, Math.min(6, os.cpus().length))),
);

// ---------- process helpers ----------

function exec(cmd: string, args: string[]): Promise<string> {
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

const RETRIES = Number(process.env.CLIPSWARM_RETRIES ?? 3);

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

// ---------- video info + transcript ----------

interface RawInfo {
  id: string;
  title: string;
  channel?: string;
  uploader?: string;
  duration: number;
  chapters?: { title: string; start_time: number; end_time: number }[] | null;
  subtitles?: Record<string, { ext: string; url: string }[]>;
  automatic_captions?: Record<string, { ext: string; url: string }[]>;
}

// Many agents often work on the same video; fetch its metadata once.
const infoCache = new Map<string, Promise<RawInfo>>();

function getRawInfo(url: string): Promise<RawInfo> {
  let p = infoCache.get(url);
  if (!p) {
    p = limiter
      .run(() => withRetry(() => exec("yt-dlp", ["-J", "--no-playlist", "--no-warnings", url])))
      .then((s) => JSON.parse(s) as RawInfo);
    p.catch(() => infoCache.delete(url));
    infoCache.set(url, p);
  }
  return p;
}

export async function getVideoInfo(url: string): Promise<VideoInfo> {
  const r = await getRawInfo(url);
  return {
    id: r.id,
    title: r.title,
    channel: r.channel ?? r.uploader,
    durationSec: r.duration,
    chapters: (r.chapters ?? []).map((c) => ({ title: c.title, start: c.start_time, end: c.end_time })),
  };
}

const transcriptCache = new Map<string, Promise<TranscriptSegment[]>>();

/** Timestamped transcript from YouTube captions (manual preferred, auto as fallback). */
export function getTranscript(url: string, lang = "en"): Promise<TranscriptSegment[]> {
  const key = `${url}::${lang}`;
  let p = transcriptCache.get(key);
  if (!p) {
    p = fetchTranscript(url, lang);
    p.catch(() => transcriptCache.delete(key));
    transcriptCache.set(key, p);
  }
  return p;
}

async function fetchTranscript(url: string, lang: string): Promise<TranscriptSegment[]> {
  const info = await getRawInfo(url);
  const pick = (tracks?: Record<string, { ext: string; url: string }[]>) => {
    if (!tracks) return undefined;
    const key =
      Object.keys(tracks).find((k) => k === lang) ??
      Object.keys(tracks).find((k) => k.startsWith(`${lang}-`) && !k.includes("-orig")) ??
      Object.keys(tracks).find((k) => k.startsWith(lang));
    return key ? tracks[key].find((t) => t.ext === "json3") : undefined;
  };
  const track = pick(info.subtitles) ?? pick(info.automatic_captions);
  if (!track) throw new Error(`No "${lang}" captions available for this video.`);

  const res = await fetch(track.url);
  if (!res.ok) throw new Error(`Caption download failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8: string }[] }[];
  };

  const segments: TranscriptSegment[] = [];
  for (const e of data.events ?? []) {
    if (!e.segs || e.tStartMs === undefined) continue;
    const text = e.segs.map((s) => s.utf8).join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const start = e.tStartMs / 1000;
    segments.push({ start, end: start + (e.dDurationMs ?? 0) / 1000, text });
  }
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

/**
 * Downloads only the requested section (yt-dlp --download-sections), so a
 * 30-second clip from a 3-hour stream doesn't pull the whole video.
 */
export async function createClip(job: ClipJob, outDir: string): Promise<ClipResult> {
  const t0 = Date.now();
  try {
    const start = parseTime(job.start);
    const end = parseTime(job.end);
    if (!(end > start)) throw new Error(`end (${job.end}) must be after start (${job.start})`);
    if (end - start > MAX_CLIP_SEC)
      throw new Error(`Clip is ${end - start}s; max is ${MAX_CLIP_SEC}s (set CLIPSWARM_MAX_CLIP_SEC to raise).`);

    await mkdir(outDir, { recursive: true });
    const info = await getRawInfo(job.url);
    const name = slug(job.label ?? `${info.id}_${formatTime(start)}-${formatTime(end)}`);
    const finalPath = path.resolve(outDir, `${name}${job.vertical ? "_vertical" : ""}.mp4`);
    const h = job.maxHeight ?? 1080;

    await limiter.run(async () => {
      const raw = job.vertical ? finalPath.replace(/\.mp4$/, ".src.mp4") : finalPath;
      await withRetry(() => exec("yt-dlp", [
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
        await exec("ffmpeg", [
          "-y", "-loglevel", "error", "-i", raw,
          "-vf", "crop='min(iw,ih*9/16)':ih,scale=1080:1920",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy",
          finalPath + ".tmp.mp4",
        ]);
        await rename(finalPath + ".tmp.mp4", finalPath);
        await rm(raw, { force: true });
      }
    });

    const { size } = await stat(finalPath);
    return { ok: true, job, path: finalPath, durationSec: end - start, bytes: size, elapsedMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, job, error: (e as Error).message, elapsedMs: Date.now() - t0 };
  }
}

/** Runs all jobs concurrently (bounded by the shared limiter). Never throws; check `ok` per result. */
export function createClips(jobs: ClipJob[], outDir: string): Promise<ClipResult[]> {
  return Promise.all(jobs.map((j) => createClip(j, outDir)));
}
