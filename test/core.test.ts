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
