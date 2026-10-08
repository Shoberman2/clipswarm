import { test } from "node:test";
import assert from "node:assert/strict";
import { createClip, formatTime, parseTime } from "../src/core.js";

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
