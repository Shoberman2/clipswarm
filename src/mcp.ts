import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
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
              vertical: z.boolean().optional().describe("Crop to 9:16 for Shorts/Reels/TikTok"),
              maxHeight: z.number().optional().describe("Max resolution height, default 1080"),
              style: z
                .enum(["plain", "viral"])
                .optional()
                .describe('"viral" = ready-to-post 1080x1920 short: hook header + video on blurred backdrop + word-by-word captions'),
              title: z.string().optional().describe("Viral: the header hook (write a punchy one, ≤ ~10 words). Defaults to the video title"),
              captions: z.boolean().optional().describe("Viral: animated captions, default true"),
              layout: z.enum(["fit", "fill"]).optional().describe('Viral: "fit" (default) shows the whole frame; "fill" crops to fill 9:16 (best for a single centred speaker)'),
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

  await server.connect(new StdioServerTransport());
}
