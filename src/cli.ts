#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClips, formatTime, hasCommand, getTranscript, getVideoInfo, searchTranscript, type ClipJob } from "./core.js";
import { startMcpServer } from "./mcp.js";

const HELP = `clipswarm — parallel YouTube clipping for humans and AI agents

Usage:
  clipswarm clip <url> <start> <end> [--label name] [--out dir]
      [--viral] [--title "hook text"] [--no-captions] [--accent "#FFE600"] [--background "#000000"|blur]
      [--vertical] [--precise]
  clipswarm batch <jobs.json> [--out dir]       Run many clips concurrently
  clipswarm info <url>                          Title, duration, chapters
  clipswarm transcript <url> [--lang en]        Timestamped transcript
  clipswarm search <url> <query...>             Find where something is said
  clipswarm mcp [--out dir]                     Start the MCP server (stdio)
  clipswarm setup                               Download the whisper model for live-stream captions

Watches (find new videos on a schedule and auto-clip them):
  clipswarm watch add "<category>" --every 6h [--max-age 72h] [--min-views 1000]
      [--clips 2] [--seconds 45] [--videos 3] [--picker auto|ai|heatmap|transcript]
      [--plain] [--no-auto] [--live] [--name id] [--out dir]
  clipswarm watch list | remove <id> | run [id] [--force] | inbox [--status s]
  clipswarm watch install | uninstall | status    Background job (launchd on macOS)
  clipswarm watch daemon                          Or keep a foreground loop running

jobs.json: [{ "url": "...", "start": "1:23", "end": "1:58", "label": "hook", "vertical": true }, ...]

Live streams: times are relative to now, e.g. \`clipswarm clip <live-url> -60 now\` = the last minute.
Negative times on regular videos count back from the end.

Env: CLIPSWARM_CONCURRENCY (default min(6, cpus)), CLIPSWARM_MAX_CLIP_SEC (default 600)`;

const BOOLEAN_FLAGS = new Set(["--vertical", "--precise", "--viral", "--no-captions", "--plain", "--no-auto", "--live", "--force"]);

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !BOOLEAN_FLAGS.has(a)) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const outDir = path.resolve(typeof flags.out === "string" ? flags.out : "clips");
  const lang = typeof flags.lang === "string" ? flags.lang : undefined;

  switch (cmd) {
    case "mcp":
      return startMcpServer(outDir);

    case "clip": {
      const [url, start, end] = pos;
      if (!url || start === undefined || end === undefined) throw new Error("usage: clipswarm clip <url> <start> <end>");
      const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
      const job: ClipJob = {
        url, start, end,
        label: str("label"),
        vertical: !!flags.vertical,
        precise: !!flags.precise,
        style: flags.viral ? "viral" : undefined,
        title: str("title"),
        captions: flags["no-captions"] ? false : undefined,
        background: str("background"),
        accent: str("accent"),
      };
      return report(await createClips([job], outDir), outDir);
    }

    case "batch": {
      if (!pos[0]) throw new Error("usage: clipswarm batch <jobs.json>");
      const jobs = JSON.parse(await readFile(pos[0], "utf8")) as ClipJob[];
      return report(await createClips(jobs, outDir), outDir);
    }

    case "setup":
      return setup();

    case "watch":
      return watchCmd(pos, flags);

    case "info":
      return console.log(JSON.stringify(await getVideoInfo(pos[0]), null, 2));

    case "transcript":
      for (const s of await getTranscript(pos[0], lang)) console.log(`[${formatTime(s.start)}] ${s.text}`);
      return;

    case "search": {
      const [url, ...q] = pos;
      for (const h of await searchTranscript(url, q.join(" "), { lang }))
        console.log(`${h.timestamp}  (${formatTime(h.start)}-${formatTime(h.end)})  ${h.text}\n`);
      return;
    }

    default:
      console.log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

async function watchCmd(pos: string[], flags: Record<string, string | true>) {
  const w = await import("./watch.js");
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const num = (k: string) => (str(k) !== undefined ? Number(str(k)) : undefined);
  const [sub, arg] = pos;
  switch (sub) {
    case "add": {
      if (!arg) throw new Error('usage: clipswarm watch add "<category>" --every 6h');
      const maxAge = str("max-age");
      const watch = await w.addWatch({
        query: arg,
        id: str("name"),
        everyMinutes: w.parseInterval(str("every") ?? "6h"),
        maxAgeHours: maxAge ? w.parseInterval(maxAge.match(/^\d+$/) ? `${maxAge}h` : maxAge) / 60 : undefined,
        minViews: num("min-views"),
        clipsPerVideo: num("clips"),
        clipSeconds: num("seconds"),
        maxVideosPerRun: num("videos"),
        style: flags.plain ? "plain" : undefined,
        autoClip: flags["no-auto"] ? false : undefined,
        includeLive: flags.live ? true : undefined,
        picker: str("picker") as never,
        outDir: str("out") ? path.resolve(str("out")!) : undefined,
      });
      console.log(`✓ Watching "${watch.query}" every ${watch.everyMinutes} min (id: ${watch.id})`);
      const { installed } = await w.schedulerStatus();
      if (!installed) console.log("  Start the background job with: clipswarm watch install   (or run now: clipswarm watch run --force)");
      return;
    }
    case "list":
    case undefined: {
      const list = await w.listWatches();
      if (!list.length) return console.log('No watches. Add one: clipswarm watch add "ai news" --every 6h');
      for (const x of list)
        console.log(`${x.id}  "${x.query}"  every ${x.everyMinutes}m  last: ${x.lastRunAt ?? "never"}  next: ${x.nextRunAt}`);
      console.log(`\nScheduler: ${(await w.schedulerStatus()).detail}`);
      return;
    }
    case "remove":
      return console.log((await w.removeWatch(arg)) ? `✓ Removed ${arg}` : `No watch "${arg}"`);
    case "run": {
      const reports = arg ? [await w.runWatch(arg)] : await w.runDue(!!flags.force);
      if (!reports.length) console.log(`[${new Date().toISOString()}] nothing due`);
      for (const r of reports) {
        console.log(`[${new Date().toISOString()}] ${r.watchId}: ${r.found} new video(s), ${r.clipped} clip(s)`);
        for (const i of r.inbox) console.log(`  ${i.status.padEnd(15)} ${i.title}${i.clips ? `\n${i.clips.map((c) => `                  → ${c}`).join("\n")}` : ""}${i.note ? `\n                  ${i.note}` : ""}`);
        for (const e of r.errors) console.log(`  ✗ ${e}`);
      }
      return;
    }
    case "inbox": {
      const items = await w.getInbox({ status: str("status") as never, watchId: arg });
      for (const i of items) console.log(`${i.status.padEnd(15)} [${i.watchId}] ${i.title}  ${i.url}${i.clips ? `\n${i.clips.map((c) => `                → ${c}`).join("\n")}` : ""}`);
      if (!items.length) console.log("Inbox is empty.");
      return;
    }
    case "install":
      return console.log(await w.installScheduler(fileURLToPath(import.meta.url)));
    case "uninstall":
      return console.log(await w.uninstallScheduler());
    case "status":
      return console.log((await w.schedulerStatus()).detail);
    case "daemon":
      console.log("clipswarm watch daemon: checking every minute (Ctrl+C to stop)");
      for (;;) {
        for (const r of await w.runDue()) console.log(`[${new Date().toISOString()}] ${r.watchId}: ${r.found} new, ${r.clipped} clips${r.errors.length ? `, ${r.errors.length} errors` : ""}`);
        await new Promise((r) => setTimeout(r, 60_000));
      }
    default:
      throw new Error(`Unknown watch command "${sub}". Try: add, list, remove, run, inbox, install, uninstall, status, daemon`);
  }
}

async function setup() {
  const { WHISPER_MODEL } = await import("./viral.js");
  const { existsSync } = await import("node:fs");
  const { mkdir, rename } = await import("node:fs/promises");
  const win = process.platform === "win32";
  const checks: [string, string, boolean][] = [
    ["yt-dlp", win ? "winget install yt-dlp.yt-dlp" : "brew install yt-dlp  |  pip install -U yt-dlp", true],
    ["ffmpeg", win ? "winget install Gyan.FFmpeg" : "brew install ffmpeg  |  sudo apt install ffmpeg", true],
    ["whisper-cli", win ? "download a whisper.cpp release (optional: captions for live streams)" : "brew install whisper-cpp  (optional: captions for live streams)", false],
    ["claude", "npm i -g @anthropic-ai/claude-code  (optional: AI-picked moments for watches)", false],
  ];
  let missing = false;
  for (const [bin, hint, required] of checks) {
    const ok = hasCommand(bin);
    if (!ok && required) missing = true;
    console.log(`${ok ? "✓" : required ? "✗" : "–"} ${bin}${ok ? "" : `  →  ${hint}`}`);
  }
  if (missing) process.exitCode = 1;
  if (!hasCommand("whisper-cli") && !hasCommand("whisper-cpp")) return console.log("Skipping the whisper model (whisper.cpp not installed).");
  if (existsSync(WHISPER_MODEL)) return console.log(`✓ whisper model at ${WHISPER_MODEL}`);
  console.log(`Downloading whisper model (~140MB) to ${WHISPER_MODEL} ...`);
  const res = await fetch("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin");
  if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status}`);
  await mkdir(path.dirname(WHISPER_MODEL), { recursive: true });
  await writeFile(WHISPER_MODEL + ".part", Buffer.from(await res.arrayBuffer()));
  await rename(WHISPER_MODEL + ".part", WHISPER_MODEL);
  console.log("✓ whisper model ready");
}

async function report(results: Awaited<ReturnType<typeof createClips>>, outDir: string) {
  for (const r of results)
    console.log(
      r.ok
        ? `✓ ${r.path}  (${(r.elapsedMs / 1000).toFixed(1)}s)${r.warnings ? `\n  ⚠ ${r.warnings.join("\n  ⚠ ")}` : ""}`
        : `✗ ${r.job.url} ${r.job.start}-${r.job.end}: ${r.error}`,
    );
  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(results, null, 2)).catch(() => {});
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
