/**
 * Choosing which moments to clip when no agent is in the loop (scheduled
 * watches). Best first: an AI pass through the local Claude Code CLI, then a
 * free transcript heuristic.
 */
import { spawn } from "node:child_process";
import { formatTime, resolveCommand, type TranscriptSegment } from "./core.js";

export interface Moment {
  start: number;
  end: number;
  /** Header text. AI picks write their own; others fall back to the video title. */
  hook?: string;
  why?: string;
}

// ---------- AI picker (Claude Code CLI) ----------

let claudeAvailable: Promise<boolean> | undefined;

export function hasClaudeCli(): Promise<boolean> {
  claudeAvailable ??= Promise.resolve(resolveCommand("claude") !== undefined);
  return claudeAvailable;
}

function runClaude(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // No tools, no MCP servers, no saved session: a single pure-text answer.
    // npm installs `claude` as a .cmd shim on Windows, which Node can only launch via a shell.
    // All args are constants (the prompt goes over stdin), so the shell is safe here.
    const bin = resolveCommand("claude") ?? "claude";
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const p = spawn(
      shell ? `"${bin}"` : bin,
      ["-p", "--output-format", "json", "--tools", shell ? '""' : "", "--strict-mcp-config", "--no-session-persistence"],
      { stdio: ["pipe", "pipe", "pipe"], shell },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill("SIGTERM");
      reject(new Error(`claude timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.trim().slice(-300)}`));
      try {
        const parsed = JSON.parse(out) as { result?: string; is_error?: boolean };
        if (parsed.is_error) return reject(new Error(`claude error: ${parsed.result}`));
        resolve(parsed.result ?? "");
      } catch {
        resolve(out);
      }
    });
    p.stdin.end(prompt);
  });
}

export function buildPickPrompt(
  title: string,
  segs: TranscriptSegment[],
  duration: number,
  count: number,
  clipSec: number,
  peaks: number[] = [],
): string {
  // Keep the prompt bounded on very long videos (~25k tokens of transcript).
  let lines = segs.map((s) => `[${Math.round(s.start)}] ${s.text}`);
  const budget = 100_000;
  while (lines.join("\n").length > budget) lines = lines.filter((_, i) => i % 2 === 0);
  return `You are choosing clips for short-form vertical video (TikTok / Reels / Shorts).

Video: "${title}" (${formatTime(duration)} long)
${peaks.length ? `YouTube's "most replayed" peaks (seconds): ${peaks.map(Math.round).join(", ")}. Treat these as strong hints.\n` : ""}
Pick the ${count} best self-contained moments, each roughly ${clipSec} seconds (between ${Math.round(clipSec * 0.6)} and ${Math.round(clipSec * 1.6)}). A good clip:
- hooks in its first 3 seconds (a bold claim, a surprising number, a question, conflict)
- covers one complete idea and ends on a payoff or punchline, not mid-thought
- makes sense without the rest of the video
- starts at the beginning of a sentence and ends at the end of one
Avoid intros, sponsor reads, "like and subscribe" and outros. Clips must not overlap.

For each clip also write a "hook": the on-screen header, at most 10 words, specific and curiosity-driven, in plain text (no emoji, no hashtags, no quotes around it). It should not just repeat the video title.

Transcript (each line starts with its time in seconds):
${lines.join("\n")}

Reply with ONLY a JSON array, no prose:
[{"start": <seconds>, "end": <seconds>, "hook": "<header text>", "why": "<one short reason>"}]`;
}

export function parsePicks(text: string, duration: number): Moment[] {
  const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const picks: Moment[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const start = Number(r.start);
    const end = Number(r.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 5 || start < 0) continue;
    const m: Moment = { start, end: Math.min(end, duration || end) };
    if (typeof r.hook === "string" && r.hook.trim()) m.hook = r.hook.trim().replace(/^["']|["']$/g, "");
    if (typeof r.why === "string") m.why = r.why;
    if (!picks.some((p) => m.start < p.end && m.end > p.start)) picks.push(m);
  }
  return picks.sort((a, b) => a.start - b.start);
}

/** Asks the local Claude Code CLI to pick moments and write hooks. */
export async function pickWithAI(
  title: string,
  segs: TranscriptSegment[],
  duration: number,
  count: number,
  clipSec: number,
  peaks: number[] = [],
): Promise<Moment[]> {
  const text = await runClaude(buildPickPrompt(title, segs, duration, count, clipSec, peaks), 240_000);
  return parsePicks(text, duration).slice(0, count);
}

// ---------- transcript heuristic (free, offline) ----------

const STRONG =
  /\b(never|always|biggest|secret|mistake|crazy|insane|best|worst|truth|wrong|million|billion|why|how|stop|warning|huge|shocking|actually|nobody|everyone|problem|important|lesson|money)\b/gi;

/**
 * Scores sliding windows of the transcript for hook-like signals: questions,
 * numbers, strong words, exclamations and fast delivery. No AI needed.
 */
export function pickFromTranscript(segs: TranscriptSegment[], duration: number, count: number, clipSec: number): Moment[] {
  if (!segs.length) return [];
  const lo = Math.max(20, duration * 0.04);
  const hi = duration * 0.96;
  const scored: { start: number; end: number; score: number }[] = [];
  for (let i = 0; i < segs.length; i++) {
    const start = segs[i].start;
    if (start < lo) continue;
    let j = i;
    while (j + 1 < segs.length && segs[j + 1].end - start <= clipSec) j++;
    const end = segs[j].end;
    if (end > hi || end - start < clipSec * 0.6) continue;
    const window = segs.slice(i, j + 1);
    const text = window.map((s) => s.text).join(" ");
    const first = segs[i].text;
    const words = text.split(/\s+/).length;
    const score =
      (text.match(/\?/g)?.length ?? 0) * 1.5 +
      (text.match(/[$%]|\b\d[\d,.]*\b/g)?.length ?? 0) * 1 +
      (text.match(STRONG)?.length ?? 0) * 1.2 +
      (text.match(/!/g)?.length ?? 0) * 0.8 +
      (first.match(STRONG)?.length ?? 0) * 2 + // hook in the opening line
      (/\?/.test(first) ? 2 : 0) +
      Math.min(3, words / (end - start) - 2) * 1.5; // energetic delivery
    scored.push({ start, end, score });
  }
  const picks: Moment[] = [];
  for (const s of scored.sort((a, b) => b.score - a.score)) {
    if (picks.length >= count) break;
    if (picks.some((p) => s.start < p.end + 5 && s.end > p.start - 5)) continue;
    picks.push({ start: Math.max(0, s.start - 0.3), end: s.end + 0.3 });
  }
  return picks.sort((a, b) => a.start - b.start);
}
