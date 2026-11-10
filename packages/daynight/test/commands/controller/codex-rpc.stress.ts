import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, createReadStream, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomFillSync } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { validateImageFile } from "../../../src/commands/controller/media/image-validation.js";
import { CodexRpc } from "../../../src/commands/controller/providers/codex-rpc.js";
import { codexMedia, type CodexMediaLease, type CodexMediaSpool } from "../../../src/commands/controller/providers/codex-rpc-json.js";

// The producer holds one 48 KiB raw chunk, including when its complete frame
// carries more media than the input-message or pending-raw-image budget.
const producer = String.raw`
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const { createReadStream } = require("node:fs");
const rows = createInterface({ input: process.stdin });
rows.once("line", async line => {
  const request = JSON.parse(line);
  const send = async value => { if (!process.stdout.write(value)) await once(process.stdout, "drain"); };
  await send('{"method":"item/completed","params":{"threadId":"native","item":{"result":{"content":[');
  for (let image = 0; image < Number(process.argv[1]); image++) {
    if (image) await send(',');
    await send('{"data":"');
    if (process.argv[3]) for await (const chunk of createReadStream(process.argv[3], { highWaterMark: 49152 })) await send(chunk.toString("base64"));
    else { let remaining = Number(process.argv[2]); while (remaining) { const count = Math.min(49152, remaining); await send(Buffer.alloc(count, image + 1).toString("base64")); remaining -= count; } }
    await send('","mimeType":' + JSON.stringify(process.argv[4] || "image/png") + ',"type":"image"}');
  }
  await send(']},"id":"tool","type":"mcpToolCall"}}}\n');
  await send(JSON.stringify({ id: request.id, result: { status: "control-progressed", producerMaxRSSKiB: process.resourceUsage().maxRSS } }) + "\n");
});
`;

const run = async (count: number, imageBytes: number, sourcePath?: string, mediaType = "image/png", expectedFrames = 1) => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-rpc-stress-")), files: string[] = [], leases: CodexMediaLease[] = [];
  let maxWrite = 0, liveBytes = 0, peakBytes = 0, delivered = 0;
  const createSpool = (limit: number): CodexMediaSpool => {
    const filename = path.join(root, String(files.length)); files.push(filename);
    let fd: number | null = openSync(filename, "wx", 0o600), size = 0, removed = false;
    return { path: filename, write(bytes) { if (fd === null || size + bytes.length > limit) throw new Error("Spool limit."); writeSync(fd, bytes); maxWrite = Math.max(maxWrite, bytes.length); size += bytes.length; liveBytes += bytes.length; peakBytes = Math.max(peakBytes, liveBytes); },
      seal() { if (fd !== null) { closeSync(fd); fd = null; } },
      *read() { const reader = openSync(filename, "r"), bytes = Buffer.alloc(65536); try { let offset = 0; while (offset < size) { const n = readSync(reader, bytes, 0, Math.min(bytes.length, size - offset), offset); if (!n) throw new Error("Short read."); offset += n; yield bytes.subarray(0, n); } } finally { closeSync(reader); } },
      remove() { if (removed) return; if (fd !== null) { closeSync(fd); fd = null; } unlinkSync(filename); removed = true; liveBytes -= size; },
    };
  };
  let originalSha: string | null = null;
  if (sourcePath) { const hash = createHash("sha256"); for await (const bytes of createReadStream(sourcePath)) hash.update(bytes); originalSha = hash.digest("hex"); }
  const child = spawn(process.execPath, ["-e", producer, String(count), String(imageBytes), sourcePath ?? "", mediaType], { stdio: ["pipe", "pipe", "pipe"] });
  const exit = once(child, "exit"); let stderr = ""; child.stderr.on("data", bytes => { stderr += String(bytes).slice(0, 4096); });
  const rssBefore = process.resourceUsage().maxRSS, started = performance.now();
  const rpc = new CodexRpc(child, event => {
    const content = ((event.params as any).item.result.content) as any[];
    expect(content).toHaveLength(count);
    for (const [index, part] of content.entries()) {
      const media = codexMedia(part.data)!; expect(media.status).toBe("available"); expect(media.byteLength).toBe(imageBytes);
      let expectedSha = originalSha;
      if (!expectedSha) { const hash = createHash("sha256"), raw = Buffer.alloc(49152, index + 1); let remaining = imageBytes; while (remaining) { const n = Math.min(remaining, raw.length); hash.update(raw.subarray(0, n)); remaining -= n; } expectedSha = hash.digest("hex"); }
      expect(media.sha256).toBe(expectedSha); leases.push(media.retain());
    }
    delivered += 1;
  }, { createSpool });
  try {
    const receipt = await rpc.request("read", {}) as { status: string; producerMaxRSSKiB: number }; expect(receipt.status).toBe("control-progressed");
    expect(delivered).toBe(1); expect(leases).toHaveLength(count); expect(leases.every(lease => existsSync(lease.path))).toBe(true);
    expect(maxWrite).toBeLessThanOrEqual(65536); expect(liveBytes).toBe(count * imageBytes);
    if (sourcePath) for (const lease of leases) {
      const validated = await validateImageFile({ version: 1, policy: "image-validation-v1", inputPath: lease.path, expectedByteLength: String(imageBytes), expectedSha256: originalSha! });
      expect(validated.mediaType).toBe(mediaType); expect(validated.frameCount).toBe(expectedFrames);
    }
    for (const lease of leases) lease.release(); leases.length = 0;
    expect(liveBytes).toBe(0); expect(files.every(file => !existsSync(file))).toBe(true);
    console.log(JSON.stringify({ count, imageBytes, mediaType, validatedFrames: sourcePath ? expectedFrames : null, maxWrite, peakSpoolBytes: peakBytes, elapsedMs: Math.round(performance.now() - started), maxRSSBeforeKiB: rssBefore, maxRSSAfterKiB: process.resourceUsage().maxRSS, producerMaxRSSKiB: receipt.producerMaxRSSKiB, nodeVersion: process.version, evidence: sourcePath ? "controlled-native-pipe and actual complete image decoding; no model" : "controlled-native-pipe; no real model or image decoder" }));
  } finally {
    for (const lease of leases) lease.release(); rpc.dispose(); await rpc.stopped;
    child.kill("SIGTERM"); await exit; rmSync(root, { recursive: true, force: true });
    expect(stderr).toBe("");
  }
};

test.each([[1, 10 * 1024 * 1024], [5, 9 * 1024 * 1024]])("streams %i images of %i bytes through real pipes and files without waiting on retained readers", (count, imageBytes) => run(count, imageBytes), 60_000);

test("valid large PNG originals and animated GIF frames survive the native reader and complete decoder", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-valid-image-stress-"));
  try {
    const png = path.join(root, "large.png"), gif = path.join(root, "animated.gif");
    const pixels = randomFillSync(Buffer.alloc(2048 * 1152 * 4));
    await sharp(pixels, { raw: { width: 2048, height: 1152, channels: 4 } }).png({ compressionLevel: 0 }).toFile(png);
    const frames = Buffer.alloc(8 * 16 * 4, 255); frames.fill(0, 0, 8 * 8 * 4);
    writeFileSync(gif, await sharp(frames, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).gif({ loop: 0, delay: [40, 40] }).toBuffer());
    expect(statSync(png).size).toBeGreaterThan(9 * 1024 * 1024);
    expect(statSync(png).size).toBeLessThan(10 * 1024 * 1024);
    await run(5, statSync(png).size, png); await run(1, statSync(gif).size, gif, "image/gif", 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
