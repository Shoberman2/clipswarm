import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderViral } from "../src/viral.js";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("renderViral produces a 1080x1920 clip with audio", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "clipswarm-test-"));
  const src = path.join(dir, "src.mp4");
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", src,
  ]);
  const words = "this is a viral clip test".split(" ").map((text, i) => ({ start: 0.2 + i * 0.4, end: 0.55 + i * 0.4, text }));
  for (const layout of ["fit", "fill"] as const) {
    const out = path.join(dir, `out-${layout}.mp4`);
    await renderViral(src, out, words, { title: "A hook header that wraps onto two lines", layout });
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", out]).toString();
    const { streams, format } = JSON.parse(probe);
    const v = streams.find((s: { codec_type: string }) => s.codec_type === "video");
    assert.equal(v.width, 1080);
    assert.equal(v.height, 1920);
    assert.ok(streams.some((s: { codec_type: string }) => s.codec_type === "audio"));
    assert.ok(Math.abs(Number(format.duration) - 3) < 0.2);
  }
});
