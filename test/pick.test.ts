import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPickPrompt, parsePicks, pickFromTranscript } from "../src/pick.js";

const segs = Array.from({ length: 120 }, (_, i) => ({
  start: i * 5,
  end: i * 5 + 5,
  text: i === 60 ? "Why did nobody see this billion dollar mistake coming?" : "and then we talked about the numbers for a while",
}));

test("parsePicks extracts valid, non-overlapping moments from model output", () => {
  const text = `Here you go:\n[{"start": 100, "end": 140, "hook": "\\"The $5B mistake\\"", "why": "x"},
    {"start": 120, "end": 150, "hook": "overlaps"}, {"start": 300, "end": 302, "hook": "too short"},
    {"start": "abc", "end": 10}, {"start": 400, "end": 9999, "hook": "clamped"}]`;
  const picks = parsePicks(text, 600);
  assert.deepEqual(picks.map((p) => [p.start, p.end]), [[100, 140], [400, 600]]);
  assert.equal(picks[0].hook, "The $5B mistake");
  assert.deepEqual(parsePicks("no json here", 600), []);
});

test("pickFromTranscript favours hook-like windows and skips the intro", () => {
  const picks = pickFromTranscript(segs, 600, 1, 40);
  assert.equal(picks.length, 1);
  assert.ok(picks[0].start <= 300 && picks[0].end >= 305, `expected the window with the hook line, got ${JSON.stringify(picks)}`);
  assert.ok(pickFromTranscript(segs, 600, 3, 40).every((p) => p.start >= 20));
});

test("buildPickPrompt includes the transcript, peaks and the JSON contract, and stays bounded", () => {
  const p = buildPickPrompt("My Video", segs, 600, 2, 45, [300]);
  assert.match(p, /"My Video"/);
  assert.match(p, /most replayed/);
  assert.match(p, /\[300\] Why did nobody/);
  assert.match(p, /ONLY a JSON array/);
  const huge = Array.from({ length: 40000 }, (_, i) => ({ start: i, end: i + 1, text: "lots of words in this caption line" }));
  assert.ok(buildPickPrompt("x", huge, 40000, 2, 45).length < 110_000);
});
