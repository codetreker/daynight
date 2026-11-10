import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { validateImageFile } from "../../../src/commands/controller/media/image-validation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sample = async (bytes: Buffer) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-validation-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "v-")); roots.push(root);
  const inputPath = path.join(root, "image.bin"); await writeFile(inputPath, bytes, { mode: 0o400 });
  return { version: 1 as const, policy: "image-validation-v1" as const, inputPath, expectedByteLength: String(bytes.length), expectedSha256: createHash("sha256").update(bytes).digest("hex") };
};

test("complete decoding verifies original bytes and geometry without transcoding", async () => {
  const bytes = await sharp({ create: { width: 17, height: 13, channels: 4, background: "red" } }).png().toBuffer();
  const request = await sample(bytes);
  await expect(validateImageFile(request)).resolves.toEqual({ mediaType: "image/png", byteLength: request.expectedByteLength, sha256: request.expectedSha256, width: 17, height: 13, frameCount: 1 });
  await expect(validateImageFile({ ...request, expectedSha256: "f".repeat(64) })).rejects.toThrow("integrity");
});

test("executable formats and truncated pixels are rejected even when declared hash and length match", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');
  await expect(validateImageFile(await sample(svg))).rejects.toThrow("format");
  const png = await sharp({ create: { width: 50, height: 40, channels: 4, background: "red" } }).png().toBuffer();
  await expect(validateImageFile(await sample(png.subarray(0, Math.floor(png.length / 2))))).rejects.toMatchObject({ code: "image_decode_failed" });
});

test("every animated frame is consumed and contributes to the validated frame count", async () => {
  const framePixels = Buffer.alloc(8 * 8 * 4 * 2, 255);
  framePixels.fill(0, 8 * 8 * 4);
  const gif = await sharp(framePixels, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).gif({ loop: 0, delay: [40, 40] }).toBuffer();
  await expect(validateImageFile(await sample(gif))).resolves.toMatchObject({ mediaType: "image/gif", width: 8, height: 8, frameCount: 2 });
});

const pngCrcTable = Uint32Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); return crc; });
const paddedPng = (png: Buffer, byteLength: number): Buffer => {
  const data = Buffer.alloc(byteLength - png.length - 12), type = Buffer.from("raNd"), chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); type.copy(chunk, 4); data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, chunk.length - 4)) crc = (crc >>> 8) ^ pngCrcTable[(crc ^ byte) & 255]!;
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
};
test("real PNG originals above the old 8 MiB limit decode through the exact 10 MiB boundary", async () => {
  const png = await sharp({ create: { width: 7, height: 5, channels: 4, background: "red" } }).png().toBuffer();
  for (const size of [8_388_609, 10_485_759, 10_485_760]) {
    const request = await sample(paddedPng(png, size));
    await expect(validateImageFile(request)).resolves.toMatchObject({ byteLength: String(size), width: 7, height: 5 });
  }
  await expect(validateImageFile(await sample(paddedPng(png, 10_485_761)))).rejects.toThrow("byte limit");
});

test.each(["jpeg", "webp", "avif"] as const)("%s originals are fully decoded and truncated containers are rejected", async format => {
  const bytes = await sharp({ create: { width: 31, height: 23, channels: 4, background: "blue" } })[format]().toBuffer();
  await expect(validateImageFile(await sample(bytes))).resolves.toMatchObject({ mediaType: `image/${format}`, width: 31, height: 23, frameCount: 1 });
  await expect(validateImageFile(await sample(bytes.subarray(0, Math.floor(bytes.length / 2))))).rejects.toThrow();
});
test("animated WebP consumes every frame", async () => {
  const framePixels = Buffer.alloc(8 * 8 * 4 * 2, 255); framePixels.fill(0, 0, 8 * 8 * 4);
  const bytes = await sharp(framePixels, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).webp({ loop: 0, delay: [40, 40] }).toBuffer();
  await expect(validateImageFile(await sample(bytes))).resolves.toMatchObject({ mediaType: "image/webp", width: 8, height: 8, frameCount: 2 });
});


test("complete pixels cannot hide a truncated or corrupt PNG ancillary container", async () => {
  const png = await sharp({ create: { width: 7, height: 5, channels: 4, background: "red" } }).png().toBuffer();
  const padded = paddedPng(png, 4096);
  await expect(validateImageFile(await sample(padded.subarray(0, 2048)))).rejects.toMatchObject({ code: "image_decode_failed" });
  const corrupted = Buffer.from(padded); corrupted[corrupted.length - 20] = corrupted[corrupted.length - 20]! ^ 1;
  await expect(validateImageFile(await sample(corrupted))).rejects.toMatchObject({ code: "image_decode_failed" });
});
