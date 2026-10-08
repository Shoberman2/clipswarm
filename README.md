# clipswarm

**Parallel YouTube clipping for AI agents.** An MCP server and CLI that let any number of agents find moments in YouTube videos and cut clips from them at the same time.

```
"Clip the 3 best moments from each of these 10 podcasts as vertical shorts"
        │
        ├─ agent 1 ─┐
        ├─ agent 2 ─┼─► clipswarm MCP ─► yt-dlp (section-only downloads) ─► ffmpeg ─► clips/*.mp4
        └─ agent N ─┘        ▲ shared concurrency limit, cached metadata + transcripts
```

## Why this exists

Tools like OpusClip, [SupoClip](https://github.com/FujiwaraChoki/supoclip) and autoclip are full apps: you give them a video and their AI picks "viral" moments. Other YouTube MCP servers download or transcribe whole videos.

clipswarm is the small piece in between, a **clipping primitive for your own agents**:

- **Agent-first tools**: `search_transcript` gives an agent timestamps, and `create_clips` turns those timestamps into files. Your agent decides what's worth clipping.
- **Built for parallelism**: batch jobs across many videos, many simultaneous callers, and one shared limit on concurrent work so you don't fork-bomb yt-dlp.
- **Section-only downloads**: a 30-second clip from a 3-hour stream downloads about 30 seconds of video, not 3 hours.
- **Failures are per job**: one bad timestamp doesn't sink a batch of 50, and intermittent YouTube 403s are retried with backoff.
- **No API keys, no GPU, no LLM inside**: bring your own agent (Claude Code, Claude Desktop, Cursor, or anything that speaks MCP).

## Install

Requires Node 20+, [yt-dlp](https://github.com/yt-dlp/yt-dlp) and ffmpeg.

```bash
brew install yt-dlp ffmpeg        # or: pip install -U yt-dlp && apt install ffmpeg
git clone https://github.com/<you>/clipswarm && cd clipswarm
npm install && npm run build
```

> Keep yt-dlp up to date (`yt-dlp -U` / `brew upgrade yt-dlp`). YouTube regularly breaks older versions. This is the #1 cause of failures.

## Use with Claude Code

This repo ships a `.mcp.json` and a `clipper` subagent. Open the folder in Claude Code and ask:

> Spawn a clipper agent for each of these videos in parallel and get me 3 vertical clips of the strongest moments from each: <url1> <url2> <url3>

Each `clipper` subagent reads its own video's transcript, picks moments, and calls `create_clips`. They all run at once against the same server.

To use clipswarm from any project:

```bash
claude mcp add clipswarm -- node /path/to/clipswarm/dist/cli.js mcp --out ./clips
```

Other MCP clients (Claude Desktop, Cursor, …) use the same command: `node /path/to/clipswarm/dist/cli.js mcp`.

## MCP tools

| Tool | What it does |
|---|---|
| `get_video_info` | Title, channel, duration, chapters |
| `get_transcript` | Timestamped transcript as compact `[m:ss] text` lines, optionally windowed with `from`/`to` |
| `search_transcript` | Finds where a phrase is said and returns padded time windows ready to clip |
| `create_clips` | Cuts many clips in parallel across any number of videos. Options: `label`, `vertical` (9:16), `maxHeight` |

## CLI

```bash
clipswarm clip <url> 1:23 1:58 --label hook --vertical
clipswarm batch examples/jobs.json --out clips     # writes clips/manifest.json
clipswarm search <url> stay hungry
clipswarm transcript <url>
clipswarm info <url>
```

## Configuration

| Env var | Default | |
|---|---|---|
| `CLIPSWARM_CONCURRENCY` | `min(6, cpus)` | Max simultaneous yt-dlp/ffmpeg jobs (shared across all callers) |
| `CLIPSWARM_MAX_CLIP_SEC` | `600` | Guards against accidentally downloading whole videos |
| `CLIPSWARM_RETRIES` | `3` | Retries per job for transient YouTube errors |

## Responsible use

Only clip content you have the rights to use: your own videos, content you've licensed, or uses covered by fair use in your jurisdiction. Downloading may be restricted by YouTube's Terms of Service. You are responsible for how you use this tool.

## Roadmap (help wanted)

Driven by what users ask for. Open an issue.

- [ ] Burned-in word-level captions
- [ ] Face-tracked vertical crop (instead of center crop)
- [ ] Local-file and non-YouTube sources (anything yt-dlp supports already mostly works)
- [ ] HTTP/SSE transport for remote agents

## License

MIT
