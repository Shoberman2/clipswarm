import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { createClips, formatTime, getTranscript, getVideoInfo, parseTime, searchTranscript } from "./core.js";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true });

const time = z.union([z.string(), z.number()]).describe('Seconds (83) or timestamp ("1:23", "1:02:03.5")');

export async function startMcpServer(defaultOutDir: string) {
  const server = new McpServer({ name: "clipswarm", version: "0.1.0" });

  server.registerTool(
    "get_video_info",
    {
      description: "Get a YouTube video's title, channel, duration and chapters. Use chapters to find natural clip boundaries.",
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
        "Cut one or more clips from YouTube videos in parallel. Only the requested sections are downloaded. Jobs can span different videos. Returns a result per job; failures don't abort the batch.",
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
            }),
          )
          .min(1),
        outDir: z.string().optional().describe(`Output directory, default ${defaultOutDir}`),
      },
    },
    async ({ clips, outDir }) => {
      const results = await createClips(clips, path.resolve(outDir ?? defaultOutDir));
      return json({
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      });
    },
  );

  await server.connect(new StdioServerTransport());
}
