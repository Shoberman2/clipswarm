#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClips, formatTime, getTranscript, getVideoInfo, searchTranscript, type ClipJob } from "./core.js";
import { startMcpServer } from "./mcp.js";

const HELP = `clipswarm — parallel YouTube clipping for humans and AI agents

Usage:
  clipswarm clip <url> <start> <end> [--label name] [--vertical] [--precise] [--out dir]
  clipswarm batch <jobs.json> [--out dir]       Run many clips concurrently
  clipswarm info <url>                          Title, duration, chapters
  clipswarm transcript <url> [--lang en]        Timestamped transcript
  clipswarm search <url> <query...>             Find where something is said
  clipswarm mcp [--out dir]                     Start the MCP server (stdio)

jobs.json: [{ "url": "...", "start": "1:23", "end": "1:58", "label": "hook", "vertical": true }, ...]

Live streams: times are relative to now, e.g. \`clipswarm clip <live-url> -60 now\` = the last minute.
Negative times on regular videos count back from the end.

Env: CLIPSWARM_CONCURRENCY (default min(6, cpus)), CLIPSWARM_MAX_CLIP_SEC (default 600)`;

const BOOLEAN_FLAGS = new Set(["--vertical", "--precise"]);

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
      const label = typeof flags.label === "string" ? flags.label : undefined;
      return report(await createClips([{ url, start, end, label, vertical: !!flags.vertical, precise: !!flags.precise }], outDir), outDir);
    }

    case "batch": {
      if (!pos[0]) throw new Error("usage: clipswarm batch <jobs.json>");
      const jobs = JSON.parse(await readFile(pos[0], "utf8")) as ClipJob[];
      return report(await createClips(jobs, outDir), outDir);
    }

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

async function report(results: Awaited<ReturnType<typeof createClips>>, outDir: string) {
  for (const r of results)
    console.log(r.ok ? `✓ ${r.path}  (${(r.elapsedMs / 1000).toFixed(1)}s)` : `✗ ${r.job.url} ${r.job.start}-${r.job.end}: ${r.error}`);
  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(results, null, 2)).catch(() => {});
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
