# Architecture

How clipswarm is put together, for people who want to change it. Line references are to `src/` as of v0.1.0. If they drift, search for the function name.

clipswarm is small on purpose: about 1,300 lines of TypeScript that coordinate three external programs (yt-dlp, ffmpeg, and optionally whisper.cpp). It has no LLM inside. **Your agent decides what to clip. clipswarm makes the cut.**

## The big picture

```
 clipper agent 1 ─┐
 clipper agent 2 ─┼─ MCP over stdio ─► mcp.ts ──► core.ts ──┬─► yt-dlp ───► section / HLS URLs
 clipper agent N ─┘   (JSON-RPC)        (zod     createClips│   (-J metadata, --download-sections)
                                        schemas)      │     ├─► fetch() ───► json3 captions, HLS segments
       you ──────► cli.ts ────────────────────────────┘     ├─► ffmpeg ────► cut / crop / composite
                                                            └─► viral.ts ──► whisper.cpp, opentype.js + resvg
                                                                     │
                                         one shared Semaphore ───────┘      ──► clips/*.mp4
```

- An **agent** (for example the `clipper` subagent) calls MCP tools. Claude Code starts clipswarm as a child process (`clipswarm mcp`) and talks to it over stdin/stdout.
- **`mcp.ts`** validates arguments and hands them to `core.ts`.
- **`core.ts`** fetches metadata and captions, works out exactly which bytes to download, and runs yt-dlp/ffmpeg.
- **`viral.ts`** turns a plain clip into a 1080x1920 short.
- Everything runs in one Node process, so all callers share the same caches and the same concurrency limit.

## Modules

### `src/cli.ts`: entry point (the `clipswarm` bin)

- `main` (`src/cli.ts:43`) dispatches subcommands: `clip`, `batch`, `info`, `transcript`, `search`, `mcp`, `setup`.
- `parseArgs` (`src/cli.ts:29`) is a hand-rolled flag parser. `BOOLEAN_FLAGS` (`src/cli.ts:27`) lists flags that never take a value. Without it, `--viral -60 now` would read `-60` as the flag's value.
- `setup` (`src/cli.ts:100`) checks for `yt-dlp`, `ffmpeg` and `whisper-cli` on PATH and downloads `ggml-base.en.bin` (~140MB) to `WHISPER_MODEL`. It writes to `.part` and then renames, so an interrupted download never leaves a half-written model behind.
- `report` (`src/cli.ts:118`) prints ✓/✗ for each job, writes `manifest.json`, and exits with code 1 if any job failed.

### `src/mcp.ts`: the MCP server

- `startMcpServer` (`src/mcp.ts:16`) registers four tools on an `McpServer` and connects a `StdioServerTransport` (`src/mcp.ts:16`).
  - `get_video_info` (`:19`) and `search_transcript` (`:59`) return pretty-printed JSON.
  - `get_transcript` (`:34`) returns compact `[m:ss] text` lines instead of JSON, because agents pay for every token.
  - `create_clips` (`:80`) takes an array of jobs and returns `{ succeeded, failed, results }`.
- Input schemas are zod objects. Their `.describe()` strings are the documentation the agent actually reads, so treat them as UI copy. The shared `time` schema (`src/mcp.ts:10`) explains every accepted time format, including live ones.
- Errors come back as `isError: true` text results (`fail`, `src/mcp.ts:8`), never as thrown exceptions.

### `src/core.ts`: fetching, cutting, orchestration

| Area | Key functions |
|---|---|
| Types | `ClipJob` (`:7`), `ClipResult` (`:37`), `TranscriptSegment` / `Word` (`:54`, `:62`), `VideoInfo` (`:68`) |
| Time | `parseTime` (`:84`) accepts `83`, `"1:23"`, `"1:01:23.5"` and negatives. `formatTime` (`:93`) |
| Concurrency | `Semaphore` (`:108`), shared `limiter` (`:124`) |
| Processes | `exec` (`:130`), `withRetry` (`:154`), `ytdlp` (`:171`) |
| Metadata | `getRawInfo` (`:210`) with `infoCache`, `getVideoInfo` (`:224`) |
| Captions | `getTranscript` (`:243`), `fetchTranscript` (`:265`), `parseJson3` (`:294`), `getWords` (`:255`), `searchTranscript` (`:333`) |
| VOD clips | `createClip` (`:377`), `VERTICAL_FILTER` (`:450`), `outputPath` (`:452`) |
| Live clips | `parsePlaylist` (`:469`), `resolveLiveTime` (`:502`), `pickLiveFormats` (`:520`), `downloadSegments` (`:537`), `createLiveClip` (`:554`) |
| Viral | `createViralClip` (`:623`) |
| Batch | `createClips` (`:677`) |

`exec` wraps `child_process.spawn`. It never uses a shell, so arguments can't be injected. On failure it reports the last three stderr lines, and for yt-dlp errors that look like YouTube breakage (403, nsig, "Sign in to confirm") it adds a hint to run `yt-dlp -U`.

### `src/viral.ts`: text rendering, transcription, compositing

| Area | Key functions |
|---|---|
| Font | `getFont` (`:39`) loads `assets/fonts/Montserrat-Black.ttf` (override with `CLIPSWARM_FONT`). `sanitize` (`:48`) drops glyphs the font lacks, such as emoji |
| Layout | `wrap` (`:59`), `fitText` (`:75`) steps the size down 2px at a time until the text fits, then truncates with `…` |
| Rasterising | `pathAt` (`:88`) turns glyphs into SVG path data. `png` (`:91`) renders SVG to PNG with resvg |
| Images | `renderHeader` (`:94`) draws a white rounded card with a drop shadow. `renderCaption` (`:119`) draws a ≤2-line caption with the active word in the accent colour |
| Timing | `buildCaptionFrames` (`:165`) |
| ASR | `WHISPER_MODEL` (`:197`), `findWhisper` (`:200`), `transcribeLocal` (`:214`) |
| Encode | `videoEncoder` (`:240`), `probe` (`:251`), `renderViral` (`:266`) |

## Life of a request

All three cases start the same way. The agent calls `create_clips`, `mcp.ts` calls `createClips(jobs, outDir)`, and that runs `Promise.all` over `createClip` for every job (`src/core.ts:381`).

### (a) Plain clip from a regular video

1. **Cheap validation first.** If both times are relative, `createClip` parses them and runs `checkLength` (`src/core.ts:370`) before any network call. A reversed range or a range over `CLIPSWARM_MAX_CLIP_SEC` (default 600) fails immediately. The test suite relies on this (`test/core.test.ts:21`).
2. **Metadata.** `getRawInfo` runs `yt-dlp -J --no-playlist` once per URL. The result is cached and shared with every other caller.
3. **Resolve times.** Negative times count back from `info.duration` (`src/core.ts:214`). `"now"` and ISO timestamps are rejected because they only make sense for live streams.
4. **Section-only download** (`src/core.ts:408`), inside one limiter slot:
   - Format selection prefers mp4+m4a at or below `maxHeight` (default 1080).
   - `--download-sections "*start-end"` makes yt-dlp's ffmpeg fetch just that range, so a 30s clip from a 3h video downloads about 30s.
   - `--force-keyframes-at-cuts` gives frame-accurate edges.
5. **Optional vertical crop.** With `vertical: true`, ffmpeg applies `VERTICAL_FILTER`: a centre crop to 9:16, then a scale to 1080x1920. It writes to `.tmp.mp4` and renames, so a half-written file never sits at the final path.
6. Returns a `ClipResult` with `path`, `bytes`, `durationSec`, `sourceStart` and `videoTitle`.

### (b) Clip from a livestream

When `info.is_live` is set, `createClip` hands off to `createLiveClip` (`src/core.ts:558`). yt-dlp isn't used for the download here. clipswarm reads YouTube's HLS DVR window directly.

1. **Pick renditions.** `pickLiveFormats` (`src/core.ts:524`) takes the highest m3u8 video rendition at or below `maxHeight`. YouTube's live video renditions are usually video-only, so it pairs them with the best audio-only rendition. That audio's `acodec` is often reported as `null` rather than `"none"`, which is why the filter tests `!== "none"`.
2. **Fetch playlists.** Video and audio playlists are fetched in parallel. `parsePlaylist` (`src/core.ts:473`) turns each one into segments with:
   - `seq` (from `#EXT-X-MEDIA-SEQUENCE`, then incremented)
   - `start` (seconds into the window)
   - `dur` (from `#EXTINF`)
   - `pdt`, the wall-clock time from `#EXT-X-PROGRAM-DATE-TIME`, advanced by each segment's duration
3. **Resolve times.** `resolveLiveTime` (`src/core.ts:506`) maps each time into window seconds:
   - `"now"` is the end of the last segment (the live edge).
   - Negative offsets count back from the live edge.
   - ISO timestamps are measured against the first segment's `pdt`.
   - Positive offsets are rejected with an explanation.

   Requests older than the window (about an hour) or later than the live edge fail with a clear message.
4. **Select segments.** Video segments that overlap `[start, end)` are kept. Audio segments are matched **by sequence number**, not by time, so the two tracks line up even if their playlists start at different points.
5. **Download** (`downloadSegments`, `src/core.ts:541`). Eight workers per track fetch segments with `withRetry`, then concatenate them into `v.ts` and `a.ts` in a temp dir.
6. **Cut** with ffmpeg (`src/core.ts:158`):
   - **Default: stream copy.** `-c:v copy` is fast, but the clip starts at the first selected segment's beginning (`from = vSel[0].start`), up to ~5s early.
   - **`precise` or `vertical`:** re-encodes with libx264, seeks with `-ss` to the exact start, and applies the crop if requested.

   Audio is always re-encoded to AAC 160k with `+faststart`.
7. **Report the real range.** `live.from` / `live.to` are ISO wall-clock times computed from `pdt`. A stream-copied clip therefore says honestly where it actually begins.

### (c) A "viral" clip

`createClip` sees `style: "viral"` and calls `createViralClip` (`src/core.ts:628`).

1. **Base clip.** It calls `createClip` recursively with `style: "plain", vertical: false` into a temp dir, so case (a) or (b) runs unchanged. The viral path reuses all the cutting logic.
2. **Word timings** (unless `captions: false`):
   - **VODs** (`sourceStart` is set): `getWords` (`src/core.ts:259`) asks for the transcript with `prefer: "auto"`. YouTube's json3 auto-captions carry one segment per word with its own `tOffsetMs`, which gives exact word timing. `parseJson3` (`src/core.ts:298`) handles both caption kinds:
     - Manual captions have no word timings, so their words are spread across the line weighted by length.
     - Overlapping auto-caption events are clamped so each word ends where the next begins.
     - Words are re-based so the clip starts at 0.
   - **Live clips, or no captions:** `transcribeLocal` (`src/viral.ts:216`) extracts 16kHz mono WAV with ffmpeg and runs `whisper-cli -ml 1 -sow -oj` (one word per segment, JSON output). Markers like `[BLANK_AUDIO]` and `♪♪` are filtered out. If whisper or the model is missing it returns `undefined`, and the clip renders without captions plus a `warnings` entry telling you to run `clipswarm setup`.
3. **Render** (`renderViral`, `src/viral.ts:268`, inside one limiter slot):
   - **Geometry.** `probe` reads the source size. In `fit` layout the frame is scaled to 1080 wide and centred on a blurred copy of itself: downscale to 270x480, `gblur`, upscale, darken. `fill` crops to 9:16. Sources that would be taller than 1100px when scaled are treated as `fill` automatically.
   - **Header.** `renderHeader` returns a PNG. It's added with `-loop 1` and overlaid above the video with `shortest=1`.
   - **Captions.** `buildCaptionFrames` (`src/viral.ts:167`) groups words into chunks. A new chunk starts at 3 words, at more than 18 characters, after a pause over 0.6s, or after punctuation. Each word gets one frame with that word highlighted. `renderViral` writes one PNG per frame, plus `blank.png` for gaps, and an `ffconcat` list with per-file `duration`s. That list becomes a single image-sequence input through ffmpeg's **concat demuxer**, overlaid with `eof_action=pass`. The last entry is repeated because the concat demuxer ignores the final file's duration.
   - **Encode.** `videoEncoder` (`src/viral.ts:242`) uses `h264_videotoolbox` at 10 Mbps on macOS when ffmpeg has it (several times faster) and falls back to `libx264 -preset veryfast -crf 21` elsewhere. The output is trimmed with `-t` to the source duration.
4. The temp dir is removed in `finally`. The result is the base clip's result with the new `path`/`bytes` and any `warnings`.

## Concurrency and resilience

- **One shared `Semaphore`** (`src/core.ts:110`, `limiter` at `:124`). This is a module-level singleton, so every MCP call from every agent shares it. The default is `min(6, max(2, cpus))`, overridable with `CLIPSWARM_CONCURRENCY`. It wraps:
  - `yt-dlp -J`
  - each VOD download+crop
  - each live segment download+cut
  - each viral render

  Ten agents asking for ten clips each queue up instead of forking a hundred yt-dlp processes. A job holds the limiter during its own step only. The viral path releases its slot after the base cut and takes a new one for the render, so nothing nests and nothing deadlocks.
- **Caches store promises, not values.** Concurrent callers on the same URL await one in-flight request.
  - `infoCache` (`src/core.ts:211`) keeps VOD metadata for the life of the process. Live entries expire after `LIVE_INFO_TTL_MS` = 20s (`:208`), because the DVR window moves and the HLS URLs expire.
  - `transcriptCache` (`:236`) is keyed by `url::lang::prefer`.
  - Both caches delete an entry when its promise rejects, so a failure isn't cached.
- **`withRetry`** (`src/core.ts:158`) retries up to `CLIPSWARM_RETRIES` (default 3) times with exponential backoff plus jitter (1s, 2s, 4s, + up to 0.5s). It wraps yt-dlp calls and every individual HLS segment fetch, because YouTube intermittently 403s single requests.
- **One bad job never sinks a batch.** `createClip` and `createViralClip` catch everything and return `{ ok: false, error }`. `createClips` is therefore a `Promise.all` that doesn't reject, and the agent gets a result per job. This is a project rule (see CONTRIBUTING.md): new failure modes must surface as a per-job `error` string.

## Design decisions (and why)

- **Text is drawn by clipswarm, not by ffmpeg.** Homebrew's ffmpeg, like many builds, ships without libfreetype/libass, so `drawtext` and `subtitles` aren't available. clipswarm converts font glyphs to vector paths with opentype.js, wraps them in SVG, rasterises with resvg (`loadSystemFonts: false`, so output is identical on every machine), and overlays PNGs. That works with any ffmpeg.
- **opentype.js stays on 1.x** (`^1.3.4`, which excludes 2.0). 2.0 emits `NaN` coordinates in some glyph paths, which corrupts the SVG. `test/core.test.ts:69` guards against this regression across many x positions and sizes.
- **Node is yt-dlp's JS runtime.** YouTube now requires running JavaScript to get stream URLs, and yt-dlp only enables Deno by default. `ytdlp()` (`src/core.ts:175`) checks once whether yt-dlp supports `--js-runtimes` and, if so, passes `node:<process.execPath>`. Node is guaranteed to be present because clipswarm is running on it.
- **Live clips are stream-copied by default.** YouTube live segments are about 5s long and each begins on a keyframe, so a copy cut at a segment boundary is clean and almost instant. Re-encoding 720p60+ is slow. Accuracy is opt-in with `precise`, and the returned `live.from` is honest about the real start.
- **Live audio is matched by sequence number,** not by timestamp, because the two playlists can begin at different points.
- **Section-only VOD downloads** use `--download-sections` plus `--force-keyframes-at-cuts`, trading a small re-encode at the edges for not downloading hours of video.
- **Hardware encoding on macOS.** VideoToolbox makes viral renders several times faster. `-allow_sw 1` keeps it working on machines without the hardware block.
- **Captions prefer auto-captions for word timing.** Human captions have better text but only line-level timing. `get_transcript` (what the agent reads) prefers manual. `getWords` (what gets animated) prefers auto.
- **Compact tool output.** `get_transcript` returns plain lines, and `searchTranscript` merges overlapping hits. Agent context is expensive.

## Testing

`npm test` runs `tsx --test test/*.test.ts`. CI (`.github/workflows/ci.yml`) builds and tests on Node 20, 22 and 24, then smoke-tests `node dist/cli.js --help`.

- `test/core.test.ts` covers the pure logic: time parsing and round-trips, range validation without network, `parsePlaylist` (sequence numbers, offsets, wall clock), `resolveLiveTime`, the opentype NaN guard, header/caption PNG output, `fitText` truncation, and caption chunking.
- `test/render.test.ts` builds a synthetic 3s clip with lavfi, runs `renderViral` in both layouts, and checks for 1080x1920 output with audio and the right duration. It is skipped if ffmpeg is missing.
- Nothing in the suite touches YouTube. Network paths are tested by hand (`npm run dev -- clip <url> 0:10 0:20`).

## Distribution

- **npm package** `clipswarm`: `bin` is `dist/cli.js`, and the package ships `dist` and `assets`, which includes the font.
- **`.mcp.json`** runs the local build (`node dist/cli.js mcp`) when the repo is opened in Claude Code.
- **Claude Code plugin.** `.claude-plugin/marketplace.json` points to `plugins/clipswarm/`. Its `plugin.json` starts the server with `npx -y clipswarm mcp --out ./clips` and bundles its own copy of the `clipper` agent.
  - The two `clipper.md` files differ only in tool names (`mcp__clipswarm__*` versus `mcp__plugin_clipswarm_clipswarm__*`). Keep their prompts in sync.
- **`server.json`** is the MCP registry entry (`io.github.Shoberman2/clipswarm`, stdio).
- **Versions.** `0.1.0` appears in `package.json`, `server.json`, `plugin.json` and the `McpServer` constructor (`src/mcp.ts:17`). Bump all four together.

## Known limitations

- **YouTube only, in practice.** The live path assumes YouTube's HLS layout, and caption parsing assumes json3. Other yt-dlp sites may work for plain VOD clips.
- **Transcripts aren't available while a stream is live.** Agents have to clip live streams by time. Viral live clips need whisper.cpp for captions.
- **The DVR window is about an hour**, and that limit is set by YouTube.
- **Vertical crop is a fixed centre crop** (`VERTICAL_FILTER`), and `fill` uses a centre crop too.
- **Captions use one font and one style.** Glyphs the font doesn't have (emoji, CJK) are dropped by `sanitize`.
- **Some light work bypasses the limiter.** Caption PNG rendering and HLS playlist fetches run outside it (whisper.cpp transcription and all ffmpeg/yt-dlp work go through it).
- **Caches never evict VOD entries.** That's fine for a per-session MCP process, but worth revisiting for long-lived servers.
- **There's only a stdio transport.** HTTP/SSE is on the roadmap.

## Where to add things

- **Face-tracked vertical crop.** Replace the constant `VERTICAL_FILTER` (`src/core.ts:454`) and the `fill` branch in `renderViral` (`src/viral.ts:268`) with a crop computed per clip, for example from a detection pass that produces a `crop=...:x=...` expression or a `sendcmd` track. Add an option to `ClipJob` and to the `create_clips` zod schema.
- **New caption styles.** Add a field to `ViralOptions` (`src/viral.ts:18`), `ClipJob` and the zod schema. Branch in `renderCaption` (the drawing) and/or `buildCaptionFrames` (the chunking and timing). The concat-demuxer pipeline doesn't care what the PNGs look like. For new header looks, edit `renderHeader`.
- **New fonts.** Drop the `.ttf` into `assets/fonts/` (with its licence) or point `CLIPSWARM_FONT` at it.
- **New MCP tools.** Register them in `startMcpServer`. Return compact text, and route errors through `fail`.
- **New sources** (local files, other sites). Branch early in `createClip` next to the `is_live` check. Keep the "return `{ ok: false }`, never throw" contract.
- **Anything slow or external.** Run it through `limiter.run`, and wrap flaky network calls in `withRetry`.
