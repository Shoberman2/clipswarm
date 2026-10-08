import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate state before the module reads CLIPSWARM_HOME.
process.env.CLIPSWARM_HOME = mkdtempSync(path.join(os.tmpdir(), "clipswarm-home-"));
process.env.CLIPSWARM_NO_NOTIFY = "1";
const w = await import("../src/watch.js");

const heat = (duration: number, peaks: Record<number, number>) =>
  Array.from({ length: 100 }, (_, i) => {
    const start = (i * duration) / 100;
    return { start_time: start, end_time: start + duration / 100, value: peaks[i] ?? 0.2 };
  });

test("parseInterval", () => {
  assert.equal(w.parseInterval("30m"), 30);
  assert.equal(w.parseInterval("6h"), 360);
  assert.equal(w.parseInterval("1d"), 1440);
  assert.equal(w.parseInterval("90"), 90);
  assert.throws(() => w.parseInterval("2m"), /Minimum/);
  assert.throws(() => w.parseInterval(2), /Minimum/);
  assert.throws(() => w.parseInterval(Number.NaN), /Minimum/);
  assert.throws(() => w.parseInterval(Number.POSITIVE_INFINITY), /Minimum/);
  assert.throws(() => w.parseInterval("often"), /Invalid/);
});

test("search URLs encode YouTube's upload and live filters once", () => {
  const upload = new URL(w.searchUrl("ai research", false));
  assert.equal(upload.searchParams.get("search_query"), "ai research");
  assert.equal(upload.searchParams.get("sp"), "CAI=");
  const live = new URL(w.searchUrl("ai research", true));
  assert.equal(live.searchParams.get("search_query"), "ai research");
  assert.equal(live.searchParams.get("sp"), "EgJAAQ==");
});

test("pickMoments takes the top non-overlapping peaks and ignores the intro spike", () => {
  const m = w.pickMoments(heat(1000, { 0: 1, 1: 0.95, 40: 0.9, 41: 0.85, 70: 0.7 }), 1000, 3, 45);
  assert.equal(m.length, 2, "intro spike ignored; adjacent bucket 41 overlaps 40");
  assert.ok(m[0].start < 405 && m[0].end > 405, "first window covers the bucket-40 peak");
  assert.ok(m[1].start < 705 && m[1].end > 705);
  assert.ok(m.every((x) => Math.abs(x.end - x.start - 45) < 0.01));
});

test("pickMoments returns nothing for a flat curve", () => {
  assert.deepEqual(w.pickMoments(heat(600, {}), 600, 2, 45), []);
});

test("snapToSentences moves edges to caption boundaries", () => {
  const segs = [
    { start: 98, end: 101, text: "a" },
    { start: 101.5, end: 140.2, text: "b" },
    { start: 141, end: 150, text: "c" },
  ];
  const r = w.snapToSentences({ start: 100, end: 143 }, segs);
  assert.equal(r.start, 101.2); // nearest sentence start (101.5) minus 0.3s padding
  assert.equal(r.end, 140.5);
});

test("hookFromTitle cleans titles for the header", () => {
  assert.equal(w.hookFromTitle("Netflix Stock Is FINALLY A Buy! 🔥 #stocks"), "Netflix Stock Is FINALLY A Buy!");
  assert.equal(w.hookFromTitle("WHY THE MARKET CRASHED TODAY. WHAT NOW?"), "Why the market crashed today. What now?");
  assert.ok(w.hookFromTitle("word ".repeat(40)).length <= 90);
});

test("watches persist, are due on schedule, and can be removed", async () => {
  const watch = await w.addWatch({ query: "Netflix stock analysis", everyMinutes: 360 });
  assert.equal(watch.id, "netflix-stock-analysis");
  const [listed] = await w.listWatches();
  assert.equal(listed.query, "Netflix stock analysis");
  assert.ok(w.isDue(listed), "never-run watch is due");
  assert.ok(!w.isDue({ ...listed, lastRunAt: new Date().toISOString() }));
  assert.ok(w.isDue({ ...listed, lastRunAt: new Date(Date.now() - 361 * 60_000).toISOString() }));
  // Concurrent writers don't lose updates.
  await Promise.all(Array.from({ length: 10 }, (_, i) => w.addWatch({ query: `topic ${i}`, everyMinutes: 60 })));
  assert.equal((await w.listWatches()).length, 11);
  assert.ok(await w.removeWatch("netflix-stock-analysis"));
  assert.equal((await w.listWatches()).length, 10);
});

test("wordsToSegments groups whisper words into caption lines", () => {
  const words = "Netflix is cheap. Here is why it matters to you".split(" ").map((text, i) => ({ start: i * 0.4 + (i >= 6 ? 2 : 0), end: i * 0.4 + 0.35 + (i >= 6 ? 2 : 0), text }));
  const segs = w.wordsToSegments(words);
  assert.deepEqual(segs.map((s) => s.text), ["Netflix is cheap.", "Here is why", "it matters to you"]);
  assert.equal(segs[0].words!.length, 3);
});
