import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createHash, type randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { validateNativeInput, verifyNativeImageFiles } from "./native-input.js";
import type { NativeInput } from "./types.js";

export type ClaudeLiveInput = { readonly uuid: string; readonly sessionId: string; readonly input: NativeInput };
export type ClaudeLiveExport = { value: Record<string, unknown>; images: { path: (string | number)[]; transferId?: string; error?: string }[] };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Only the isolated SDK helper assembles Base64, after verifying the complete input. */
export const encodeClaudeLiveInput = async (value: ClaudeLiveInput): Promise<SDKUserMessage> => {
  if (!/^[a-f0-9-]{36}$/.test(value.uuid) || !/^[a-f0-9-]{36}$/.test(value.sessionId)) throw new Error("Claude input identity is invalid.");
  const { text, images } = validateNativeInput(value.input); await verifyNativeImageFiles(images);
  const content: ({ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/webp"; data: string } })[] = [];
  if (text) content.push({ type: "text", text });
  for (const image of images) {
    const handle = await open(image.localPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || String(before.size) !== image.byteLength || process.platform !== "win32" && (before.mode & 0o277) !== 0) throw new Error("Claude image lease is not an immutable regular file.");
      const bytes = Buffer.alloc(before.size);
      for (let offset = 0; offset < bytes.length;) { const { bytesRead } = await handle.read(bytes, offset, Math.min(65_536, bytes.length - offset), offset); if (!bytesRead) throw new Error("Claude image lease is truncated."); offset += bytesRead; }
      const after = await handle.stat(), named = await lstat(image.localPath);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino || createHash("sha256").update(bytes).digest("hex") !== image.sha256) throw new Error("Claude image lease integrity differs.");
      content.push({ type: "image", source: { type: "base64", media_type: image.mediaType as "image/png" | "image/jpeg" | "image/webp", data: bytes.toString("base64") } });
    } finally { await handle.close(); }
  }
  return { type: "user", uuid: value.uuid as ReturnType<typeof randomUUID>, session_id: value.sessionId, parent_tool_use_id: null, message: { role: "user", content: images.length ? content : text } };
};

/** Whitelisted SDK image slots are extracted before any message enters Controller IPC. */
export const exportClaudeLiveMedia = async (input: unknown, transfer: (data: string, mediaType: string) => Promise<{ transferId?: string; error?: string }>): Promise<ClaudeLiveExport> => {
  const images: ClaudeLiveExport["images"] = [];
  const visit = async (raw: unknown, at: (string | number)[], depth: number): Promise<Record<string, unknown>> => {
    if (depth > 32 || images.length >= 1000) throw new Error("Claude media metadata limit exceeded.");
    const part = { ...object(raw) };
    if (part.type === "image") {
      const source = { ...object(part.source) }; part.source = source;
      if (source.type === "base64") {
        const encoded = source.data; source.data = null;
        const result = typeof encoded === "string" && ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(String(source.media_type)) ? await transfer(encoded, String(source.media_type)) : { error: "unsupported_media_source" };
        images.push({ path: [...at, "source", "data"], ...result });
      }
    } else if (part.type === "tool_result" && Array.isArray(part.content)) {
      const content: unknown[] = [];
      for (const [index, child] of part.content.entries()) content.push(await visit(child, [...at, "content", index], depth + 1));
      part.content = content;
    }
    return part;
  };
  const value = { ...object(input) };
  if (value.type === "user" || value.type === "assistant") {
    const message = { ...object(value.message) }; value.message = message;
    if (Array.isArray(message.content)) {
      const content: unknown[] = [];
      for (const [index, part] of message.content.entries()) content.push(await visit(part, ["message", "content", index], 0));
      message.content = content;
    }
  } else if (value.type === "stream_event") {
    const event = { ...object(value.event) }; value.event = event;
    if (event.type === "content_block_start") event.content_block = await visit(event.content_block, ["event", "content_block"], 0);
  }
  const result = { value, images };
  if (Buffer.byteLength(JSON.stringify(result)) > 1_048_576 - 4096) throw new Error("Claude live metadata exceeds its frame limit.");
  return result;
};
