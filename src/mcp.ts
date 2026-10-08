import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClip, formatTime, getTranscript, getVideoInfo, parseTime, searchTranscript, type ClipResult } from "./core.js";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true });

// Many MCP clients time out tool calls after ~60s, so long batches return
// early with a jobId and the agent collects the rest via get_clips.
const DEFAULT_WAIT = 40;

interface Batch {
  results: (ClipResult | undefined)[];
  done: number;
  all?: Promise<void>;
}

const batches = new Map<string, Batch>();

async function report(jobId: string, batch: Batch, waitSec = DEFAULT_WAIT) {
  await Promise.race([batch.all, new Promise((r) => setTimeout(r, Math.max(0, waitSec) * 1000))]);
  const finished = batch.results.filter((r): r is ClipResult => r !== undefined);
  const pending = batch.results.length - finished.length;
  return {
    ...(pending ? { jobId, pending, note: `Still rendering. Call get_clips with jobId "${jobId}".` } : {}),
    succeeded: finished.filter((r) => r.ok).length,
    failed: finished.filter((r) => !r.ok).length,
    results: finished,
  };
}

const time = z
  .union([z.string(), z.number()])
  .describe(
    'Seconds (83) or "1:23" / "1:02:03.5". Negative = from the end ("-0:30"). For LIVE streams: "now", negative offsets from the live edge (-90), or ISO time ("2026-10-08T00:40:00Z"); roughly the last hour is available.',
  );

export async function startMcpServer(defaultOutDir: string) {
  const server = new McpServer({ name: "clipswarm", version: "0.1.0" });

  server.registerTool(
    "get_video_info",
    {
      description: "Get a YouTube video's title, channel, duration, chapters and liveStatus (\"is_live\" means it's streaming now: clip it with times relative to \"now\"). Use chapters to find natural clip boundaries.",
      inputSchema: { url: z.string().describe("YouTube URL") },
    },
    async ({ url }) => {
      try {
        return json(await getVideoInfo(url));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_transcript",
    {
      description:
        "Get the timestamped transcript of a YouTube video. Optionally limit to a time window to keep output small. Read it to decide which moments to clip.",
      inputSchema: {
        url: z.string(),
        lang: z.string().optional().describe('Caption language code, default "en"'),
        from: time.optional(),
        to: time.optional(),
      },
    },
    async ({ url, lang, from, to }) => {
      try {
        const a = from === undefined ? 0 : parseTime(from);
        const b = to === undefined ? Infinity : parseTime(to);
        const segs = (await getTranscript(url, lang)).filter((s) => s.end > a && s.start < b);
        // Compact "[m:ss] text" lines are far cheaper in context than JSON.
        return { content: [{ type: "text" as const, text: segs.map((s) => `[${formatTime(s.start)}] ${s.text}`).join("\n") }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "search_transcript",
    {
      description: "Find where a phrase is said in a YouTube video. Returns time windows with surrounding text, ready to pass to create_clips.",
      inputSchema: {
        url: z.string(),
        query: z.string().describe("Words to find (all must appear in the caption line)"),
        contextSec: z.number().optional().describe("Seconds of padding around each hit, default 15"),
        lang: z.string().optional(),
        limit: z.number().optional(),
      },
    },
    async ({ url, query, ...opts }) => {
      try {
        return json(await searchTranscript(url, query, opts));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_clips",
    {
      description:
        "Cut one or more clips from YouTube videos (including streams that are live right now) in parallel. Only the requested sections are downloaded. Jobs can span different videos. Returns a result per job; failures don't abort the batch. Live results include the wall-clock range covered. Viral clips take ~15-60s each; if the batch isn't done within waitSec, you get finished results plus a jobId: call get_clips with it until pending is 0.",
      inputSchema: {
        clips: z
          .array(
            z.object({
              url: z.string(),
              start: time,
              end: time,
              label: z.string().optional().describe("Short name used for the output file"),
              vertical: z.boolean().optional().describe("Plain 9:16 version: whole frame on black, no header/captions"),
              maxHeight: z.number().optional().describe("Max resolution height, default 1080"),
              style: z
                .enum(["plain", "viral"])
                .optional()
                .describe('"viral" = ready-to-post 1080x1920 short: hook header + the full video frame (never cropped, laid out to suit its shape) + word-by-word captions'),
              title: z.string().optional().describe("Viral: the header hook (write a punchy one, ≤ ~10 words). Defaults to the video title"),
              captions: z.boolean().optional().describe("Viral: animated captions, default true"),
              background: z.string().optional().describe('Viral: background colour behind the video, default "#000000". The full frame is always shown, never cropped.'),
              accent: z.string().optional().describe('Viral: highlight colour for the spoken word, default "#FFE600"'),
              precise: z.boolean().optional().describe("Live only: frame-accurate cut (slower re-encode). Default snaps start to a keyframe ≤5s earlier."),
            }),
          )
          .min(1),
        outDir: z.string().optional().describe(`Output directory, default ${defaultOutDir}`),
        waitSec: z
          .number()
          .optional()
          .describe(`Seconds to wait before returning, default ${DEFAULT_WAIT}. If clips are still rendering, the response includes a jobId; collect the rest with get_clips.`),
      },
    },
    async ({ clips, outDir, waitSec }, extra) => {
      const dir = path.resolve(outDir ?? defaultOutDir);
      const id = `clips_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const batch: Batch = { results: new Array(clips.length), done: 0 };
      const token = extra._meta?.progressToken;
      batch.all = Promise.all(
        clips.map((job, i) =>
          createClip(job, dir).then((r) => {
            batch.results[i] = r;
            batch.done++;
            if (token !== undefined)
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { progressToken: token, progress: batch.done, total: clips.length, message: `${r.ok ? "✓" : "✗"} ${job.label ?? job.url}` },
                })
                .catch(() => {});
          }),
        ),
      ).then(() => {});
      batches.set(id, batch);
      return json(await report(id, batch, waitSec));
    },
  );

  server.registerTool(
    "get_clips",
    {
      description:
        "Get results of a create_clips batch that was still running (create_clips returns a jobId when it doesn't finish within waitSec). Waits up to waitSec for more clips to finish. Call repeatedly until pending is 0.",
      inputSchema: {
        jobId: z.string(),
        waitSec: z.number().optional().describe(`Seconds to wait for completion before returning, default ${DEFAULT_WAIT}`),
      },
    },
    async ({ jobId, waitSec }) => {
      const batch = batches.get(jobId);
      if (!batch) return fail(new Error(`Unknown jobId "${jobId}". Jobs are kept in memory until the server restarts.`));
      return json(await report(jobId, batch, waitSec));
    },
  );

  // ---------- watches ----------

  const statuses = ["clipped", "needs_agent", "live", "failed", "done", "dismissed"] as const;

  server.registerTool(
    "create_watch",
    {
      description:
        "Watch a category: on a schedule, search YouTube for new videos about it and auto-clip the best moments into viral shorts (moments and hooks picked by the local Claude Code CLI if installed, else YouTube's most-replayed peaks, else a transcript heuristic). Anything it can't clip (and live streams, if enabled) goes to the inbox for you. Replaces a watch with the same id. Runs via the background scheduler (see watch_scheduler).",
      inputSchema: {
        query: z.string().describe('The category, phrased like a YouTube search, e.g. "netflix stock analysis"'),
        every: z.string().describe('How often to check: "30m", "6h", "1d" (min 5m)'),
        id: z.string().optional().describe("Short name; defaults to a slug of the query"),
        maxAgeHours: z.number().optional().describe("Only videos uploaded within this many hours (default 72)"),
        minViews: z.number().optional(),
        minDurationSec: z.number().optional().describe("Default 120 (skips Shorts)"),
        maxDurationSec: z.number().optional().describe("Default 14400"),
        maxVideosPerRun: z.number().optional().describe("Default 3"),
        clipsPerVideo: z.number().optional().describe("Default 2"),
        clipSeconds: z.number().optional().describe("Target clip length, default 45"),
        style: z.enum(["viral", "plain"]).optional(),
        autoClip: z.boolean().optional().describe("Default true. false = only collect videos into the inbox"),
        picker: z.enum(["auto", "ai", "heatmap", "transcript"]).optional().describe('How moments are chosen. Default "auto"'),
        includeLive: z.boolean().optional().describe("Also surface streams that are live right now"),
        outDir: z.string().optional().describe("Default ~/clipswarm/<id>"),
      },
    },
    async ({ every, ...rest }) => {
      try {
        const w = await import("./watch.js");
        const watch = await w.addWatch({ ...rest, everyMinutes: w.parseInterval(every) });
        const sched = await w.schedulerStatus();
        return json({ watch, scheduler: sched.detail, ...(sched.installed ? {} : { next: "Call watch_scheduler with action \"install\" so it runs in the background." }) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_watches",
    { description: "List watches with their schedule, last and next run, plus scheduler status.", inputSchema: {} },
    async () => {
      const w = await import("./watch.js");
      return json({ watches: await w.listWatches(), scheduler: (await w.schedulerStatus()).detail });
    },
  );

  server.registerTool(
    "delete_watch",
    { description: "Stop and remove a watch.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const w = await import("./watch.js");
      return json({ removed: await w.removeWatch(id) });
    },
  );

  server.registerTool(
    "run_watch",
    {
      description:
        "Run a watch right now instead of waiting for its schedule. Runs in the background (searching and rendering takes minutes); check get_inbox afterwards.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const w = await import("./watch.js");
      if (!(await w.listWatches()).some((x) => x.id === id)) return fail(new Error(`No watch "${id}".`));
      void w.runWatch(id).catch(() => {});
      return json({ started: true, next: `Call get_inbox with watchId "${id}" in a minute or two.` });
    },
  );

  server.registerTool(
    "get_inbox",
    {
      description:
        'Videos found by watches. "clipped" = auto-clipped (paths in clips; note says how moments were picked). "needs_agent" = couldn\'t be clipped automatically: read the transcript, pick moments, call create_clips, then mark it "done". "live" = streaming now. "failed" = see note.',
      inputSchema: {
        status: z.enum(statuses).optional(),
        watchId: z.string().optional(),
        limit: z.number().optional().describe("Most recent N, default 30"),
      },
    },
    async ({ status, watchId, limit }) => {
      const w = await import("./watch.js");
      return json((await w.getInbox({ status, watchId })).slice(-(limit ?? 30)));
    },
  );

  server.registerTool(
    "update_inbox_item",
    {
      description: 'Mark an inbox video as handled ("done") or not worth clipping ("dismissed").',
      inputSchema: { videoId: z.string(), status: z.enum(statuses), note: z.string().optional() },
    },
    async ({ videoId, status, note }) => {
      const w = await import("./watch.js");
      return json({ updated: await w.setInboxStatus(videoId, status, note) });
    },
  );

  server.registerTool(
    "watch_scheduler",
    {
      description:
        "Status, install or uninstall the background job that runs due watches every 5 minutes (launchd on macOS; returns a crontab line elsewhere). Install only when the user wants watches to run automatically.",
      inputSchema: { action: z.enum(["status", "install", "uninstall"]) },
    },
    async ({ action }) => {
      try {
        const w = await import("./watch.js");
        if (action === "install") return json({ result: await w.installScheduler(fileURLToPath(new URL("./cli.js", import.meta.url))) });
        if (action === "uninstall") return json({ result: await w.uninstallScheduler() });
        return json(await w.schedulerStatus());
      } catch (e) {
        return fail(e);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
