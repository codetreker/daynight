import { NativeRpcError } from "./native-rpc.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { IMAGE_LIMITS } from "../../../session/image-values.js";
import type { NativeImagePart, NativeInput } from "./types.js";

const invalid = (message: string): never => { throw new NativeRpcError(-32602, message); };
/** The canonical input preserves one optional text prefix and ordered originals. */
export const validateNativeInput = (input: NativeInput): { text: string; images: readonly NativeImagePart[] } => {
  if (!input || !Array.isArray(input.content) || !input.content.length) return invalid("Native input is empty.");
  const images: NativeImagePart[] = [], texts: string[] = [];
  for (const part of input.content) {
    if (!part || typeof part !== "object") return invalid("Native input is invalid.");
    if (part.type === "text") {
      if (images.length) return invalid("Native input order must place text before images.");
      if (typeof part.text !== "string" || !part.text.isWellFormed()) return invalid("Native text input is invalid.");
      texts.push(part.text);
    } else if (part.type === "image") {
      if (texts.length > 1 || typeof part.imageId !== "string" || !part.imageId || typeof part.resourceId !== "string" || !part.resourceId || typeof part.localPath !== "string" || !path.isAbsolute(part.localPath) || !part.localPath.isWellFormed() || /\p{Cc}/u.test(part.localPath) || !["image/png", "image/jpeg", "image/webp"].includes(part.mediaType) || typeof part.byteLength !== "string" || !/^[1-9][0-9]{0,8}$/.test(part.byteLength) || typeof part.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(part.sha256)) return invalid("Native image input is invalid.");
      if (Number(part.byteLength) > IMAGE_LIMITS.imageBytes || images.length >= IMAGE_LIMITS.images) return invalid("Native image input exceeds its bound.");
      images.push(part);
    } else return invalid("Native input is invalid.");
  }
  if (images.reduce((sum, image) => sum + Number(image.byteLength), 0) > IMAGE_LIMITS.messageBytes) return invalid("Native image input exceeds its message bound.");
  const text = texts.join("\n");
  if (!images.length && !text.length) return invalid("Native input is empty.");
  return { text, images };
};

/** Full decoding is owned by the input lease; adapters verify its immutable bytes. */
export const verifyNativeImageFiles = async (images: readonly NativeImagePart[]): Promise<void> => {
  if (!images.length) return;
  validateNativeInput({ content: images });
  for (const image of images) {
    const file = await open(image.localPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || String(before.size) !== image.byteLength || process.platform !== "win32" && (before.mode & 0o277) !== 0) return invalid("Native image is not a private immutable regular file.");
      const hash = createHash("sha256"), block = Buffer.alloc(65_536);
      let offset = 0, header = Buffer.alloc(0);
      while (offset < before.size) {
        const { bytesRead } = await file.read(block, 0, Math.min(block.length, before.size - offset), offset);
        if (!bytesRead) return invalid("Native image integrity changed.");
        if (!offset) header = Buffer.from(block.subarray(0, Math.min(bytesRead, 12)));
        hash.update(block.subarray(0, bytesRead)); offset += bytesRead;
      }
      const mime = header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" : header[0] === 255 && header[1] === 216 && header[2] === 255 ? "image/jpeg" : header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : null;
      if (mime !== image.mediaType) return invalid("Native image MIME differs from its original.");
      if (hash.digest("hex") !== image.sha256) return invalid("Native image integrity differs from its original.");
      const after = await file.stat(), named = await lstat(image.localPath);
      if (!named.isFile() || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return invalid("Native image integrity changed during verification.");
    } finally { await file.close(); }
  }
};

export const textNativeInput = (text: string): NativeInput => ({ content: [{ type: "text", text }] });

/** Text adapters fail before mutation when the whole input needs an image encoder. */
export const nativeInputText = (input: NativeInput): string => {
  if (!input || !Array.isArray(input.content) || input.content.length === 0) throw new NativeRpcError(-32602, "Native input is empty.");
  if (input.content.some(part => part.type === "image")) throw new NativeRpcError(-32602, "Native image input is not supported by this provider revision.");
  if (input.content.some(part => part.type !== "text" || typeof part.text !== "string" || !part.text.isWellFormed())) throw new NativeRpcError(-32602, "Native text input is invalid.");
  return input.content.map(part => part.type === "text" ? part.text : "").join("\n");
};
