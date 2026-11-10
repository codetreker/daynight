import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { MessageOptions } from "@github/copilot-sdk";

export type CopilotBridgeInputImage = { readonly path: string; readonly byteLength: string; readonly sha256: string; readonly mimeType: string; readonly displayName?: string };
export type CopilotBridgeImageInput = { readonly prompt: string; readonly mode: "immediate"; readonly attachments: readonly CopilotBridgeInputImage[] };
export type CopilotBridgeMediaSlot = { readonly path: readonly (string | number)[]; readonly transferId?: string; readonly error?: string };
export type CopilotBridgeExport = { value: unknown; images: CopilotBridgeMediaSlot[] };
const IMAGE_BYTES = 10_485_760;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The helper encodes the complete immutable input before its single SDK send. */
export const encodeCopilotBridgeImages = async (input: CopilotBridgeImageInput): Promise<MessageOptions> => {
  if (typeof input.prompt !== "string" || !input.prompt.isWellFormed() || input.mode !== "immediate" || !Array.isArray(input.attachments) || input.attachments.length < 1 || input.attachments.length > 8) throw new Error("Invalid Copilot image input.");
  let total = 0;
  for (const image of input.attachments) {
    if (!image || typeof image.path !== "string" || !path.isAbsolute(image.path) || image.path.includes("\0") || typeof image.byteLength !== "string" || !/^[1-9][0-9]*$/.test(image.byteLength) || !/^[a-f0-9]{64}$/.test(image.sha256) || !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) || image.displayName !== undefined && (typeof image.displayName !== "string" || !image.displayName.isWellFormed() || /[\0\r\n]/.test(image.displayName) || Buffer.byteLength(image.displayName) > 1024)) throw new Error("Invalid Copilot image lease.");
    const size = Number(image.byteLength); total += size;
    if (!Number.isSafeInteger(size) || size > IMAGE_BYTES || total > 20_971_520) throw new Error("Copilot image input exceeds its byte budget.");
  }
  const attachments: NonNullable<MessageOptions["attachments"]> = [];
  for (const image of input.attachments) {
    const before = await lstat(image.path), handle = await open(image.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await handle.stat();
      if (!before.isFile() || before.isSymbolicLink() || !current.isFile() || current.ino !== before.ino || current.dev !== before.dev || current.size !== Number(image.byteLength) || process.platform !== "win32" && (current.mode & 0o077) !== 0) throw new Error("Copilot image lease identity differs.");
      const bytes = Buffer.alloc(current.size);
      let offset = 0;
      while (offset < bytes.length) { const result = await handle.read(bytes, offset, Math.min(65_536, bytes.length - offset), offset); if (!result.bytesRead) throw new Error("Copilot image lease is incomplete."); offset += result.bytesRead; }
      const after = await handle.stat();
      if (after.dev !== current.dev || after.ino !== current.ino || after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs || createHash("sha256").update(bytes).digest("hex") !== image.sha256) throw new Error("Copilot image lease integrity differs.");
      attachments.push({ type: "blob", data: bytes.toString("base64"), mimeType: image.mimeType, ...(image.displayName === undefined ? {} : { displayName: image.displayName }) });
    } finally { await handle.close(); }
  }
  return { prompt: input.prompt, mode: "immediate", attachments };
};

/** Extract only SDK-documented fields; arbitrary structuredContent is never a media source. */
export const exportCopilotBridgeMedia = async (value: unknown, kind: "event" | "events" | "eventLog" | "metadata",
  transfer: (data: string, mimeType: string) => Promise<{ transferId?: string; error?: string }>): Promise<CopilotBridgeExport> => {
  const images: CopilotBridgeMediaSlot[] = [];
  const replace = async (container: Record<string, unknown>, key: string, mime: unknown, location: readonly (string | number)[]) => {
    const encoded = container[key]; if (typeof encoded !== "string") return;
    container[key] = null;
    const result = typeof mime === "string" && ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(mime)
      ? await transfer(encoded, mime) : { error: "unsupported_media_type" };
    images.push({ path: [...location, key], ...result });
  };
  const event = async (input: unknown, prefix: readonly (string | number)[]) => {
    const original = object(input), data = { ...object(original.data) }, next = { ...original, data };
    if (original.type === "session.binary_asset") await replace(data, "data", data.mimeType, [...prefix, "data"]);
    else if (original.type === "user.message" && Array.isArray(data.attachments)) {
      const attachments: unknown[] = [];
      for (const [index, raw] of data.attachments.entries()) {
        const item = { ...object(raw) };
        if (item.type === "blob") await replace(item, "data", item.mimeType, [...prefix, "data", "attachments", index]);
        attachments.push(item);
      }
      data.attachments = attachments;
    } else if (original.type === "tool.execution_complete") {
      const result = { ...object(data.result) }; data.result = result;
      for (const field of ["contents", "binaryResultsForLlm"] as const) {
        if (!Array.isArray(result[field])) continue;
        const items: unknown[] = [];
        // Decode one media item at a time; event-wide image bytes are not an input-message limit.
        for (const [index, raw] of result[field].entries()) {
          const item = { ...object(raw) };
          if (item.type === "image" || item.type === "audio") await replace(item, "data", item.mimeType, [...prefix, "data", "result", field, index]);
          else if (item.type === "resource") { const resource = { ...object(item.resource) }; item.resource = resource; await replace(resource, "blob", resource.mimeType, [...prefix, "data", "result", field, index, "resource"]); }
          items.push(item);
        }
        result[field] = items;
      }
    }
    return next;
  };
  let result: unknown = value;
  if (kind === "event") result = await event(value, []);
  else if (kind === "events" && Array.isArray(value)) {
    const events: unknown[] = []; for (const [index, item] of value.entries()) events.push(await event(item, [index])); result = events;
  } else if (kind === "eventLog") {
    const response = { ...object(value) };
    if (Array.isArray(response.events)) { const events: unknown[] = []; for (const [index, item] of response.events.entries()) events.push(await event(item, ["events", index])); response.events = events; }
    result = response;
  }
  return { value: result, images };
};
