# Contributing

Thanks for helping. clipswarm aims to stay small: a reliable clipping primitive that agents call. Clip *selection* belongs to the agent, not to us.

## Dev setup

```bash
brew install yt-dlp ffmpeg   # or your platform's equivalent
npm install
npm run build
npm test                     # offline unit tests
npm run dev -- clip <url> 0:10 0:20   # run from source
```

## Guidelines

- Open an issue before large features so we can agree on scope.
- Keep tools' output compact. Agents pay for every token.
- Every new failure mode should come back as a per-job `error` string, never a crash that sinks the batch.
- Add a unit test for anything that doesn't need the network.

## Reporting bugs

Please include `yt-dlp --version`, `ffmpeg -version | head -1`, your OS, and the failing URL and timestamps. Most failures go away after `yt-dlp -U`.
