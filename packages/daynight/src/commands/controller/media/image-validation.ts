import sharp from "sharp";
import { constants } from "node:fs";
import { open, lstat, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ValidatedImage } from "../../../session/image-values.js";
export type { ValidatedImage } from "../../../session/image-values.js";

export const IMAGE_VALIDATION_BUILD_ID = "daynight-image-validation-v1-sharp-0.35.5";
export type ImageValidationRequest = { version: 1; policy: "image-validation-v1"; inputPath: string; expectedByteLength: string; expectedSha256: string };
export const IMAGE_VALIDATION_ERROR_CODES = ["image_format_unsupported", "image_integrity_failed", "image_geometry_exceeded", "image_decode_failed", "image_too_large"] as const;
export class ImageValidationError extends Error {
  constructor(readonly code: typeof IMAGE_VALIDATION_ERROR_CODES[number], message: string) { super(message); }
}
const fail = (code: ImageValidationError["code"], message: string): never => { throw new ImageValidationError(code, message); };
export const parseImageValidationRequest = (input: unknown): ImageValidationRequest => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid image validation request.");
  const v = input as Record<string, unknown>;
  const keys = ["version", "policy", "inputPath", "expectedByteLength", "expectedSha256"];
  if (Object.keys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key)) || v.version !== 1 || v.policy !== "image-validation-v1" || typeof v.inputPath !== "string" || !path.isAbsolute(v.inputPath) || !v.inputPath.isWellFormed() || /\p{Cc}/u.test(v.inputPath) || typeof v.expectedByteLength !== "string" || !/^[1-9][0-9]{0,18}$/.test(v.expectedByteLength) || typeof v.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.expectedSha256)) throw new Error("Invalid image validation request.");
  if (BigInt(v.expectedByteLength) > 10_485_760n) return fail("image_too_large", "Image original exceeds the byte limit.");
  return v as unknown as ImageValidationRequest;
};
const sniff = (bytes: Buffer): ValidatedImage["mediaType"] => {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp" && /avif|avis/.test(bytes.subarray(8, 64).toString("ascii"))) return "image/avif";
  return fail("image_format_unsupported", "Image format is not supported.");
};
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); return crc;
});
const readExact = async (file: FileHandle, offset: number, length: number): Promise<Buffer> => {
  const buffer = Buffer.alloc(length); let read = 0;
  while (read < length) { const result = await file.read(buffer, read, length - read, offset + read); if (!result.bytesRead) return fail("image_decode_failed", "Image container is truncated."); read += result.bytesRead; }
  return buffer;
};
/** Decoders can accept complete pixels from a truncated ancillary container. */
const validateContainer = async (file: FileHandle, mediaType: ValidatedImage["mediaType"], length: number): Promise<number | null> => {
  if (mediaType === "image/png") {
    let offset = 8, index = 0, imageData = false, ended = false, animationFrames: number | null = null;
    const block = Buffer.alloc(524_288);
    while (offset < length) {
      if (length - offset < 12) return fail("image_decode_failed", "PNG container is truncated.");
      const header = await readExact(file, offset, 8), size = header.readUInt32BE(), type = header.subarray(4).toString("ascii");
      if (!/^[A-Za-z]{4}$/.test(type) || size > length - offset - 12 || index === 0 && (type !== "IHDR" || size !== 13) || index !== 0 && type === "IHDR") return fail("image_decode_failed", "PNG container structure is invalid.");
      let crc = 0xffffffff;
      for (const byte of header.subarray(4)) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
      let through = 0;
      while (through < size) {
        const count = Math.min(block.length, size - through), result = await file.read(block, 0, count, offset + 8 + through);
        if (!result.bytesRead) return fail("image_decode_failed", "PNG container is truncated.");
        for (let at = 0; at < result.bytesRead; at++) crc = (crc >>> 8) ^ crcTable[(crc ^ block[at]!) & 255]!;
        through += result.bytesRead;
      }
      if (((crc ^ 0xffffffff) >>> 0) !== (await readExact(file, offset + 8 + size, 4)).readUInt32BE()) return fail("image_decode_failed", "PNG container checksum is invalid.");
      if (type === "acTL") { if (size !== 8 || animationFrames !== null || imageData) return fail("image_decode_failed", "PNG animation control is invalid."); animationFrames = (await readExact(file, offset + 8, 8)).readUInt32BE(); if (animationFrames < 1 || animationFrames > 256) return fail("image_geometry_exceeded", "PNG animation frame count exceeds its bound."); }
      if (type === "IDAT") imageData = true;
      offset += size + 12; index++;
      if (type === "IEND") { if (size !== 0 || !imageData || offset !== length) return fail("image_decode_failed", "PNG container ending is invalid."); ended = true; break; }
    }
    if (!ended) return fail("image_decode_failed", "PNG container ending is missing.");
    return animationFrames ?? 1;
  }
  if (mediaType === "image/jpeg") {
    const ending = await readExact(file, Math.max(0, length - 2), 2);
    if (ending[0] !== 255 || ending[1] !== 217) return fail("image_decode_failed", "JPEG container ending is missing.");
    return null;
  }
  if (mediaType === "image/gif") {
    const header = await readExact(file, 0, 13); let offset = 13, frames = 0, cacheStart = 0, cache: Buffer = Buffer.alloc(0);
    const take = async (count: number): Promise<Buffer> => {
      if (offset + count > length) return fail("image_decode_failed", "GIF container is truncated.");
      if (offset < cacheStart || offset + count > cacheStart + cache.length) { cacheStart = offset; cache = await readExact(file, offset, Math.min(524_288, length - offset)); }
      const bytes = cache.subarray(offset - cacheStart, offset - cacheStart + count); offset += count; return bytes;
    };
    const skip = (count: number) => { if (offset + count > length) return fail("image_decode_failed", "GIF container is truncated."); offset += count; };
    const subBlocks = async () => { for (;;) { const size = (await take(1))[0]!; if (!size) return; skip(size); } };
    if (header[10]! & 128) skip(3 * 2 ** ((header[10]! & 7) + 1));
    while (offset < length) {
      const kind = (await take(1))[0];
      if (kind === 59) { if (!frames || offset !== length) return fail("image_decode_failed", "GIF container ending is invalid."); return frames; }
      if (kind === 33) { await take(1); await subBlocks(); continue; }
      if (kind !== 44) return fail("image_decode_failed", "GIF container block is invalid.");
      const descriptor = await take(9); if (descriptor[8]! & 128) skip(3 * 2 ** ((descriptor[8]! & 7) + 1));
      await take(1); await subBlocks(); frames++;
      if (frames > 256) return fail("image_geometry_exceeded", "GIF animation frame count exceeds its bound.");
    }
    return fail("image_decode_failed", "GIF container ending is missing.");
  }
  if (mediaType === "image/webp") {
    if (length < 20 || (await readExact(file, 4, 4)).readUInt32LE() !== length - 8) return fail("image_decode_failed", "WebP container length differs.");
    let offset = 12, frames = 0;
    while (offset < length) { if (length - offset < 8) return fail("image_decode_failed", "WebP container is truncated."); const chunk = await readExact(file, offset, 8), size = chunk.readUInt32LE(4), next = offset + 8 + size + size % 2; if (next > length) return fail("image_decode_failed", "WebP container is truncated."); if (chunk.subarray(0, 4).toString("ascii") === "ANMF") frames++; if (frames > 256) return fail("image_geometry_exceeded", "WebP animation frame count exceeds its bound."); offset = next; }
    return frames || 1;
  }
  let offset = 0;
  while (offset < length) {
    if (length - offset < 8) return fail("image_decode_failed", "AVIF container is truncated.");
    const header = await readExact(file, offset, 8), compact = header.readUInt32BE(); let size = compact, headerSize = 8;
    if (compact === 1) { if (length - offset < 16) return fail("image_decode_failed", "AVIF container is truncated."); const wide = (await readExact(file, offset + 8, 8)).readBigUInt64BE(); if (wide > BigInt(length - offset)) return fail("image_decode_failed", "AVIF container is truncated."); size = Number(wide); headerSize = 16; }
    else if (compact === 0) size = length - offset;
    if (size < headerSize || size > length - offset) return fail("image_decode_failed", "AVIF container box length differs.");
    offset += size;
  }
  return null;
};
/** Each frame is decoded to RGBA and consumed; metadata alone is insufficient. */
export const validateImageFile = async (input: ImageValidationRequest): Promise<ValidatedImage> => {
  const request = parseImageValidationRequest(input);
  const file = await open(request.inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || String(before.size) !== request.expectedByteLength) return fail("image_integrity_failed", "Image integrity does not match its declared original.");
    const digest = createHash("sha256"), chunk = Buffer.alloc(524_288);
    let offset = 0, header = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      if (offset === 0) header = Buffer.from(chunk.subarray(0, Math.min(bytesRead, 64)));
      digest.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
      if (offset > 10_485_760) return fail("image_too_large", "Image original exceeds the byte limit.");
    }
    if (String(offset) !== request.expectedByteLength || digest.digest("hex") !== request.expectedSha256) return fail("image_integrity_failed", "Image integrity does not match its declared original.");
    const mediaType = sniff(header);
    const containerFrames = await validateContainer(file, mediaType, offset);
    sharp.cache(false); sharp.concurrency(1);
    // Sharp also reports IO and internal failures without structured codes.
    // Only explicit validation checks establish a confirmed content rejection.
    const metadata = await sharp(request.inputPath, { failOn: "warning", limitInputPixels: 33_554_432 }).metadata();
    const formats: Readonly<Record<string, ValidatedImage["mediaType"] | undefined>> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", heif: "image/avif" };
    const format = formats[metadata.format ?? ""];
    if (format !== mediaType) return fail("image_format_unsupported", "Image format differs from its decoded container.");
    const width = metadata.width ?? 0, height = metadata.pageHeight ?? metadata.height ?? 0, frameCount = metadata.pages ?? 1;
    if (containerFrames !== null && containerFrames !== frameCount) return fail("image_format_unsupported", "This image animation cannot be completely decoded by the pinned component.");
    if (![width, height, frameCount].every(value => Number.isSafeInteger(value) && value > 0) || width > 16_384 || height > 16_384 || width * height > 33_554_432 || frameCount > 256 || width * height * frameCount > 67_108_864) return fail("image_geometry_exceeded", "Image geometry exceeds the complete decoding policy.");
    let total = 0;
    for (let page = 0; page < frameCount; page++) {
      const decoder = sharp(request.inputPath, { failOn: "warning", limitInputPixels: 33_554_432, page, pages: 1 }).toColourspace("srgb").ensureAlpha().raw();
      let frameBytes = 0;
      for await (const pixels of decoder) {
        frameBytes += (pixels as Buffer).length; total += (pixels as Buffer).length;
        if (total > 268_435_456 || frameBytes > width * height * 4) { decoder.destroy(); return fail("image_geometry_exceeded", "Image decoded pixels exceed the output budget."); }
      }
      if (frameBytes !== width * height * 4) return fail("image_decode_failed", "Image decode did not consume a complete canvas.");
    }
    const after = await file.stat(), named = await lstat(request.inputPath);
    if (named.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.ino !== named.ino || after.dev !== named.dev) return fail("image_integrity_failed", "Image integrity changed during complete decoding.");
    return { mediaType, byteLength: request.expectedByteLength, sha256: request.expectedSha256, width, height, frameCount };
  } finally { await file.close(); }
};
