import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { randomFillSync } from "node:crypto";
import sharp from "sharp";

test("one native frame preserves five nine-MiB tool images through sequential bridge spooling", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-bridge-stress"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  const child = spawn(process.execPath, ["--unhandled-rejections=strict", path.resolve(import.meta.dirname, "fixtures/copilot-bridge-check.mjs"), root, "many-images"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 55_000);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    expect(result, stderr).toEqual({ code: 0, signal: null }); expect(stderr).toBe("");
    const metrics = JSON.parse(stdout); expect(metrics).toMatchObject({ mode: "many-images", processesJoined: 2, metrics: { mediaBytes: 0, mediaCount: 0 } });
    expect(metrics.maxFrameBytes).toBeLessThanOrEqual(1_048_576);
    // Samples include SDK heap and native allocations, not an operating-system memory guarantee.
    process.stdout.write(stdout);
  } finally { clearTimeout(timeout); await rm(root, { recursive: true, force: true }); }
}, 60_000);

test.each(["valid-many-images", "valid-animation"] as const)("%s preserves valid originals through the bridge and complete decoder", async mode => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-bridge-stress"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "valid-"));
  const animated = mode === "valid-animation", mediaType = animated ? "image/gif" : "image/png", filename = path.join(root, animated ? "original.gif" : "original.png");
  if (animated) {
    const frames = Buffer.alloc(8 * 16 * 4, 255); frames.fill(0, 0, 8 * 8 * 4);
    await sharp(frames, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).gif({ loop: 0, delay: [40, 40] }).toFile(filename);
  } else {
    const pixels = randomFillSync(Buffer.alloc(2048 * 1152 * 4));
    const metadata = await sharp(pixels, { raw: { width: 2048, height: 1152, channels: 4 } }).png({ compressionLevel: 0 }).toFile(filename);
    expect(metadata.size).toBeGreaterThan(9 * 1_048_576); expect(metadata.size).toBeLessThan(10 * 1_048_576);
  }
  const child = spawn(process.execPath, ["--unhandled-rejections=strict", path.resolve(import.meta.dirname, "fixtures/copilot-bridge-check.mjs"), root, mode, filename, mediaType, animated ? "2" : "1"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 55_000);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    expect(result, stderr).toEqual({ code: 0, signal: null }); expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ mode, decodedImages: animated ? 1 : 5, expectedFrames: animated ? 2 : 1, processesJoined: 2, metrics: { mediaBytes: 0, mediaCount: 0 } });
    process.stdout.write(stdout);
  } finally { clearTimeout(timeout); await rm(root, { recursive: true, force: true }); }
}, 60_000);
