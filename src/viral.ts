/**
 * "Viral" rendering: 1080x1920 with a hook header card, the source video on a
 * blurred backdrop, and word-by-word animated captions.
 *
 * Text is rendered here (font -> vector paths -> PNG) rather than with ffmpeg's
 * drawtext/subtitles filters, because many ffmpeg builds (including Homebrew's)
 * ship without libfreetype/libass. This works with any ffmpeg.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import { Resvg } from "@resvg/resvg-js";
import { exec, type Word } from "./core.js";

export interface ViralOptions {
  /** Header hook text. Omit or "" for no header. */
  title?: string;
  /** Word-by-word captions. Default true. */
  captions?: boolean;
  /** "fit" (default): whole frame on a blurred backdrop. "fill": crop to 9:16. */
  layout?: "fit" | "fill";
  /** Highlight colour for the word being spoken. Default "#FFE600". */
  accent?: string;
  /** Seconds to drop from the start of the source (e.g. a live clip's keyframe lead-in). */
  trimStart?: number;
}

const W = 1080;
const H = 1920;
const FPS = 30;

// ---------- text rendering ----------

const FONT_PATH =
  process.env.CLIPSWARM_FONT ?? fileURLToPath(new URL("../assets/fonts/Montserrat-Black.ttf", import.meta.url));
let font: opentype.Font | undefined;

function getFont(): opentype.Font {
  if (!font) {
    const b = readFileSync(FONT_PATH);
    font = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }
  return font;
}

/** Drops characters the font can't draw (emoji etc.) so they don't render as boxes. */
export function sanitize(text: string): string {
  const f = getFont();
  return [...text]
    .filter((c) => /\s/.test(c) || f.charToGlyph(c).index !== 0)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

const measure = (text: string, size: number) => getFont().getAdvanceWidth(text, size);

export function wrap(text: string, size: number, maxW: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(" ").filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || measure(next, size) <= maxW) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Largest font size (stepping down) at which the text fits in maxLines. */
export function fitText(text: string, maxW: number, maxLines: number, maxSize: number, minSize: number) {
  for (let size = maxSize; size >= minSize; size -= 2) {
    const lines = wrap(text, size, maxW);
    if (lines.length <= maxLines && lines.every((l) => measure(l, size) <= maxW)) return { lines, size };
  }
  let lines = wrap(text, minSize, maxW);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…";
  }
  return { lines, size: minSize };
}

const pathAt = (text: string, x: number, baseline: number, size: number) =>
  getFont().getPath(text, x, baseline, size).toPathData(2);

const png = (svg: string) => new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();

/** White rounded card with bold black text: the classic viral-clip header. */
export function renderHeader(title: string): { png: Buffer; height: number } {
  const padX = 52;
  const padY = 40;
  const { lines, size } = fitText(title, W - 80 - padX * 2, 3, 72, 44);
  const lineH = size * 1.18;
  const textW = Math.max(...lines.map((l) => measure(l, size)));
  const cardW = Math.min(W - 80, textW + padX * 2);
  const cardH = lines.length * lineH + padY * 2 - (lineH - size);
  const margin = 24; // room for the shadow
  const height = Math.ceil(cardH + margin * 2);
  const x0 = (W - cardW) / 2;
  const ascent = size * 0.78;
  const paths = lines
    .map((l, i) => `<path d="${pathAt(l, (W - measure(l, size)) / 2, margin + padY + ascent + i * lineH, size)}"/>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}">
<defs><filter id="s" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000" flood-opacity="0.35"/></filter></defs>
<rect x="${x0}" y="${margin}" width="${cardW}" height="${cardH}" rx="30" fill="#fff" filter="url(#s)"/>
<g fill="#111">${paths}</g></svg>`;
  return { png: png(svg), height };
}

const CAPTION_H = 360;

/** One caption frame: the chunk's words, with word `active` highlighted. */
export function renderCaption(words: string[], active: number, accent: string): Buffer {
  const text = words.join(" ");
  const { size } = fitText(text, W - 120, 2, 84, 56);
  const space = measure(" ", size);
  // Lay words out into centred lines.
  const lines: { word: string; idx: number }[][] = [[]];
  let lineW = 0;
  words.forEach((word, idx) => {
    const w = measure(word, size);
    if (lines[lines.length - 1].length && lineW + space + w > W - 120) {
      lines.push([]);
      lineW = 0;
    }
    lineW += (lineW ? space : 0) + w;
    lines[lines.length - 1].push({ word, idx });
  });
  const lineH = size * 1.12;
  const top = (CAPTION_H - lines.length * lineH) / 2 + size * 0.8;
  let stroke = "";
  let fill = "";
  lines.forEach((line, li) => {
    const total = line.reduce((n, w, i) => n + measure(w.word, size) + (i ? space : 0), 0);
    let x = (W - total) / 2;
    for (const { word, idx } of line) {
      const d = pathAt(word, x, top + li * lineH, size);
      stroke += `<path d="${d}"/>`;
      fill += `<path d="${d}" fill="${idx === active ? accent : "#fff"}"/>`;
      x += measure(word, size) + space;
    }
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${CAPTION_H}">
<g fill="none" stroke="#000" stroke-width="${Math.round(size * 0.2)}" stroke-linejoin="round" opacity="0.92">${stroke}</g>
<g>${fill}</g></svg>`;
  return png(svg);
}

// ---------- caption timing ----------

export interface CaptionFrame {
  words: string[];
  active: number;
  start: number;
  end: number;
}

/** Groups words into short punchy chunks (≤3 words) and yields one frame per spoken word. */
export function buildCaptionFrames(words: Word[], duration: number): CaptionFrame[] {
  const clean = words
    .map((w) => ({ ...w, text: sanitize(w.text).toUpperCase() }))
    .filter((w) => w.text && w.start < duration);
  const chunks: (typeof clean)[] = [];
  for (const w of clean) {
    const cur = chunks[chunks.length - 1];
    const prev = cur?.[cur.length - 1];
    const chars = cur ? cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length : 0;
    if (!cur || cur.length >= 3 || chars > 18 || w.start - prev!.end > 0.6 || /[.?!,]$/.test(prev!.text)) chunks.push([w]);
    else cur.push(w);
  }
  const frames: CaptionFrame[] = [];
  chunks.forEach((chunk, ci) => {
    const nextStart = chunks[ci + 1]?.[0].start ?? duration;
    const last = chunk[chunk.length - 1];
    // Hold the chunk until the next one starts, unless there's a long pause.
    const chunkEnd = Math.min(duration, nextStart - last.end < 1 ? nextStart : last.end + 0.3);
    chunk.forEach((w, i) => {
      frames.push({
        words: chunk.map((x) => x.text),
        active: i,
        start: Math.max(0, w.start),
        end: i < chunk.length - 1 ? chunk[i + 1].start : chunkEnd,
      });
    });
  });
  return frames.filter((f) => f.end - f.start > 0.02);
}

// ---------- local transcription (whisper.cpp) ----------

export const WHISPER_MODEL =
  process.env.CLIPSWARM_WHISPER_MODEL ?? path.join(os.homedir(), ".cache", "clipswarm", "ggml-base.en.bin");

async function findWhisper(): Promise<string | undefined> {
  for (const bin of ["whisper-cli", "whisper-cpp"]) {
    try {
      await exec("which", [bin]);
      return bin;
    } catch {}
  }
  return undefined;
}

/**
 * Word-level transcript of a local file with whisper.cpp, or undefined if
 * whisper isn't set up. Used for live streams and videos without captions.
 */
export async function transcribeLocal(videoPath: string): Promise<Word[] | undefined> {
  const bin = await findWhisper();
  if (!bin || !existsSync(WHISPER_MODEL)) return undefined;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clipswarm-asr-"));
  try {
    const wav = path.join(tmp, "a.wav");
    await exec("ffmpeg", ["-y", "-loglevel", "error", "-i", videoPath, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    const base = path.join(tmp, "out");
    await exec(bin, ["-m", WHISPER_MODEL, "-f", wav, "-ml", "1", "-sow", "-oj", "-of", base, "-np"]);
    const json = JSON.parse(await readFile(`${base}.json`, "utf8")) as {
      transcription: { offsets: { from: number; to: number }; text: string }[];
    };
    return json.transcription
      .map((t) => ({ start: t.offsets.from / 1000, end: t.offsets.to / 1000, text: t.text.trim() }))
      // Drop non-speech markers: [BLANK_AUDIO], (music), ♪♪
      .filter((w) => w.text && !/^\[.*\]$|^\(.*\)$|^[♪♫\s]+$/.test(w.text));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------- compositing ----------

let encoderArgs: Promise<string[]> | undefined;

/** Hardware H.264 on macOS when available (several times faster), libx264 elsewhere. */
export function videoEncoder(): Promise<string[]> {
  encoderArgs ??= (async () => {
    if (process.platform === "darwin") {
      const enc = await exec("ffmpeg", ["-hide_banner", "-encoders"]).catch(() => "");
      if (enc.includes("h264_videotoolbox")) return ["-c:v", "h264_videotoolbox", "-b:v", "10M", "-allow_sw", "1"];
    }
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"];
  })();
  return encoderArgs;
}

async function probe(file: string): Promise<{ width: number; height: number; duration: number; hasAudio: boolean }> {
  const out = JSON.parse(
    await exec("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file]),
  ) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
  const v = out.streams.find((s) => s.codec_type === "video");
  if (!v?.width || !v.height) throw new Error("Clip has no video stream.");
  return {
    width: v.width,
    height: v.height,
    duration: Number(out.format.duration),
    hasAudio: out.streams.some((s) => s.codec_type === "audio"),
  };
}

/** Composites a plain clip into the viral 9:16 format. */
export async function renderViral(src: string, dest: string, words: Word[] | undefined, opts: ViralOptions): Promise<void> {
  const probed = await probe(src);
  const { width, height, hasAudio } = probed;
  const trim = Math.max(0, opts.trimStart ?? 0);
  const duration = probed.duration - trim;
  const title = sanitize(opts.title ?? "");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clipswarm-viral-"));
  try {
    // Geometry. "fit" keeps the whole frame, centred on a blurred copy of itself.
    const fgH = Math.round((W / width) * height / 2) * 2;
    const fill = opts.layout === "fill" || fgH > 1100; // vertical sources already fill the frame
    const videoTop = fill ? 0 : Math.round((H - fgH) / 2);
    const header = title ? renderHeader(title) : undefined;
    const headerY = fill ? 170 : Math.max(40, videoTop - (header?.height ?? 0) - 10);
    const captionY = fill ? Math.round(H * 0.6) : Math.min(H - CAPTION_H - 80, videoTop + fgH + 20);

    const inputs: string[] = [...(trim > 0.01 ? ["-ss", trim.toFixed(3)] : []), "-i", src];
    const filters: string[] = [];
    if (fill) {
      filters.push(`[0:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[v0]`);
    } else {
      filters.push(
        `[0:v]fps=${FPS},split=2[a][b]`,
        `[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,gblur=sigma=12,scale=${W}:${H},eq=brightness=-0.2:saturation=1.2[bg]`,
        `[b]scale=${W}:${fgH}[fg]`,
        `[bg][fg]overlay=0:${videoTop},setsar=1[v0]`,
      );
    }
    let last = "v0";
    let n = 1;

    if (header) {
      await writeFile(path.join(tmp, "header.png"), header.png);
      inputs.push("-loop", "1", "-i", path.join(tmp, "header.png"));
      filters.push(`[${last}][${n}:v]overlay=0:${headerY}:shortest=1[v${n}]`);
      last = `v${n++}`;
    }

    const frames = opts.captions === false || !words?.length ? [] : buildCaptionFrames(words, duration);
    if (frames.length) {
      await writeFile(path.join(tmp, "blank.png"), png(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${CAPTION_H}"/>`));
      const accent = opts.accent ?? "#FFE600";
      const list = ["ffconcat version 1.0"];
      let t = 0;
      for (const [i, f] of frames.entries()) {
        if (f.start - t > 0.02) list.push("file blank.png", `duration ${(f.start - t).toFixed(3)}`);
        const name = `c${i}.png`;
        await writeFile(path.join(tmp, name), renderCaption(f.words, f.active, accent));
        list.push(`file ${name}`, `duration ${(f.end - Math.max(f.start, t)).toFixed(3)}`);
        t = f.end;
      }
      list.push("file blank.png", `duration ${Math.max(0.1, duration - t).toFixed(3)}`, "file blank.png");
      await writeFile(path.join(tmp, "captions.txt"), list.join("\n"));
      inputs.push("-f", "concat", "-safe", "0", "-i", path.join(tmp, "captions.txt"));
      filters.push(`[${n}:v]format=rgba[cap]`, `[${last}][cap]overlay=0:${captionY}:eof_action=pass[v${n}]`);
      last = `v${n++}`;
    }

    filters.push(`[${last}]format=yuv420p[out]`);
    await exec("ffmpeg", [
      "-y", "-loglevel", "error",
      ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", "[out]", ...(hasAudio ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", "160k"] : []),
      ...(await videoEncoder()),
      "-t", duration.toFixed(3),
      "-movflags", "+faststart",
      // Write to a temp name so a half-rendered file never appears at `dest`.
      `${dest}.part.mp4`,
    ]);
    await rename(`${dest}.part.mp4`, dest);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
