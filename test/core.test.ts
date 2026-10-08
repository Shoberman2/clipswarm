import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createClip, formatTime, parseTime } from "../src/core.js";

for (const [name, value, message] of [
  ["CLIPSWARM_CONCURRENCY", "0", "a positive integer"],
  ["CLIPSWARM_MAX_CLIP_SEC", "NaN", "a finite number greater than 0"],
  ["CLIPSWARM_RETRIES", "-1", "a non-negative integer"],
] as const) {
  test(`${name} rejects invalid values with a clear startup error`, () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", "await import('./src/core.ts')"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, [name]: value } },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${name} must be ${message}`));
  });
}

test("parseTime accepts seconds and timestamps", () => {
  assert.equal(parseTime(83), 83);
  assert.equal(parseTime("83"), 83);
  assert.equal(parseTime("1:23"), 83);
  assert.equal(parseTime("1:01:23.5"), 3683.5);
  assert.throws(() => parseTime("1:xx"));
});

test("formatTime pads and round-trips", () => {
  assert.equal(formatTime(8.93), "0:08.93");
  assert.equal(formatTime(848.93), "14:08.93");
  assert.equal(formatTime(3683), "1:01:23");
  assert.equal(formatTime(59.999), "1:00");
  for (const t of [0, 5, 83, 3683.5]) assert.equal(parseTime(formatTime(t)), t);
});

test("createClip rejects bad ranges without touching the network", async () => {
  const r = await createClip({ url: "https://youtu.be/x", start: "5:00", end: "4:00" }, "/tmp");
  assert.equal(r.ok, false);
  assert.match(r.error!, /must be after/);
  const long = await createClip({ url: "https://youtu.be/x", start: 0, end: 99999 }, "/tmp");
  assert.match(long.error!, /max is/);
});

import { parsePlaylist, resolveLiveTime } from "../src/core.js";

const PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-PROGRAM-DATE-TIME:2026-10-08T00:00:00.000+00:00
#EXTINF:5.0,
https://example.com/seg100.ts
#EXTINF:5.0,
https://example.com/seg101.ts
#EXTINF:5.0,
https://example.com/seg102.ts
`;

test("parsePlaylist tracks sequence numbers, offsets and wall clock", () => {
  const segs = parsePlaylist(PLAYLIST);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs.map((s) => s.seq), [100, 101, 102]);
  assert.deepEqual(segs.map((s) => s.start), [0, 5, 10]);
  assert.equal(new Date(segs[2].pdt!).toISOString(), "2026-10-08T00:00:10.000Z");
});

test("negative times parse as offsets", () => {
  assert.equal(parseTime("-1:30"), -90);
  assert.equal(parseTime(-5), -5);
});

test("resolveLiveTime handles now, negative offsets and ISO times", () => {
  const segs = parsePlaylist(PLAYLIST);
  assert.equal(resolveLiveTime("now", segs), 15);
  assert.equal(resolveLiveTime(-10, segs), 5);
  assert.equal(resolveLiveTime("-0:05", segs), 10);
  assert.equal(resolveLiveTime("2026-10-08T00:00:07Z", segs), 7);
  assert.throws(() => resolveLiveTime(30, segs), /negative offsets/);
});

import { buildCaptionFrames, fitText, renderCaption, renderHeader } from "../src/viral.js";
import opentype from "opentype.js";
import { readFileSync } from "node:fs";

test("glyph paths never contain NaN (opentype.js 2.0 regression)", () => {
  const b = readFileSync(new URL("../assets/fonts/Montserrat-Black.ttf", import.meta.url));
  const f = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const t = "Steve Jobs' best advice QWERTYUIOPASDFGHJKLZXCVBNM?!.,0123456789";
  for (let x = 0; x < 1000; x += 13.7) for (const size of [44, 64, 84]) assert.ok(!f.getPath(t, x, 120, size).toPathData(2).includes("NaN"));
});

test("header and caption render to PNG", () => {
  const h = renderHeader("Steve Jobs' best advice in 30 seconds");
  assert.equal(h.png.subarray(1, 4).toString(), "PNG");
  assert.ok(h.height > 100 && h.height < 500);
  assert.equal(renderCaption(["STAY", "HUNGRY"], 1, "#FFE600").subarray(1, 4).toString(), "PNG");
});

test("fitText shrinks long text and truncates past maxLines", () => {
  const short = fitText("Short hook", 900, 3, 72, 44);
  assert.equal(short.size, 72);
  const long = fitText("word ".repeat(80).trim(), 900, 3, 72, 44);
  assert.equal(long.lines.length, 3);
  assert.ok(long.lines[2].endsWith("…"));
});

test("caption frames: chunks of <=3 words, one frame per word, in order", () => {
  const words = "so stay hungry. stay foolish and thank you".split(" ").map((text, i) => ({ start: i * 0.4, end: i * 0.4 + 0.35, text }));
  const frames = buildCaptionFrames(words, 10);
  assert.equal(frames.length, words.length);
  assert.ok(frames.every((f) => f.words.length <= 3 && f.end > f.start));
  assert.deepEqual(frames[2].words, ["SO", "STAY", "HUNGRY."]); // breaks after punctuation
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].start >= frames[i - 1].start);
});

import { limiter } from "../src/core.js";

test("limiter never runs more than its max at once", async () => {
  let active = 0;
  let peak = 0;
  const max = Number(process.env.CLIPSWARM_CONCURRENCY ?? 0) || (limiter as unknown as { max: number }).max;
  await Promise.all(
    Array.from({ length: 40 }, () =>
      limiter.run(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        active--;
      }),
    ),
  );
  assert.ok(peak <= max, `peak ${peak} > max ${max}`);
});

import { computeLayout } from "../src/viral.js";

test("layout never crops: the whole frame fits in 1080x1920 at its own aspect ratio", () => {
  for (const [w, h] of [[1920, 1080], [1280, 720], [1080, 1920], [720, 1280], [1080, 1080], [640, 480], [2560, 1080], [600, 1400]]) {
    for (const headerH of [0, 285]) {
      const l = computeLayout(w, h, headerH, 360);
      assert.ok(l.fgW <= 1080 && l.fgH <= 1920, `${w}x${h} overflows`);
      assert.ok(l.videoX >= 0 && l.videoTop >= 0 && l.videoX + l.fgW <= 1080 && l.videoTop + l.fgH <= 1920, `${w}x${h} off-canvas`);
      assert.ok(Math.abs(l.fgW / l.fgH - w / h) < 0.01, `${w}x${h} distorted`);
      assert.ok(l.fgW === 1080 || l.fgH === 1920, `${w}x${h} not as large as possible`);
    }
  }
});

test("widescreen: header above the video, captions below, nothing overlapping", () => {
  const l = computeLayout(1920, 1080, 285, 360);
  assert.equal(l.fgW, 1080);
  assert.ok(l.headerY + 285 <= l.videoTop);
  assert.ok(l.captionY >= l.videoTop + l.fgH);
  assert.ok(l.captionY + 360 <= 1920);
});
