import { afterEach, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { encodeClaudeLiveInput, exportClaudeLiveMedia } from "../../../src/commands/controller/providers/claude-live-media.js";
import { limited } from "../../../src/commands/controller/providers/projection.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  await mkdir(".tmp", { recursive: true }); const root = await mkdtemp(path.resolve(".tmp/claude-live-image-")); roots.push(root);
  const bytes = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]), localPath = path.join(root, "image.png"); await writeFile(localPath, bytes, { mode: 0o400 });
  return { bytes, image: { type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), localPath } };
};
test("Claude helper creates one ordered native user message, including image-only input", async () => {
  const f = await fixture(), uuid = randomUUID(), sessionId = randomUUID();
  const message = await encodeClaudeLiveInput({ uuid, sessionId, input: { content: [{ type: "text", text: "look" }, f.image] } });
  expect(message).toEqual({ type: "user", uuid, session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: f.bytes.toString("base64") } }] } });
  expect((await encodeClaudeLiveInput({ uuid, sessionId, input: { content: [f.image] } })).message.content).toHaveLength(1);
});
test.each(["integrity", "missing"])("a later %s failure prevents the entire SDK user message from being created", async failure => {
  const first = await fixture(), second = await fixture();
  if (failure === "missing") await rm(second.image.localPath);
  else second.image.sha256 = "f".repeat(64);
  await expect(encodeClaudeLiveInput({ uuid: randomUUID(), sessionId: randomUUID(), input: { content: [first.image, second.image] } })).rejects.toThrow(failure === "missing" ? "ENOENT" : "integrity");
});
test.skipIf(process.platform === "win32")("POSIX writable originals cannot become SDK user messages", async () => {
  const f = await fixture();
  await chmod(f.image.localPath, 0o600);
  await expect(encodeClaudeLiveInput({ uuid: randomUUID(), sessionId: randomUUID(), input: { content: [f.image] } })).rejects.toThrow("immutable");
});
test("live assistant, nested tool output and stream images leave only private media references in metadata", async () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }, transferred: string[] = [];
  const transfer = async (data: string) => { transferred.push(data); return { transferId: randomUUID() }; };
  for (const raw of [
    { type: "assistant", message: { content: [{ type: "text", text: "before" }, image, { type: "text", text: "after" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call", content: [image] }] } },
    { type: "stream_event", event: { type: "content_block_start", index: 2, content_block: image } },
  ]) {
    const result = await exportClaudeLiveMedia(raw, transfer); expect(result.images).toHaveLength(1); expect(JSON.stringify(result)).not.toContain("AQID");
  }
  expect(transferred).toEqual(["AQID", "AQID", "AQID"]); expect(image.source.data).toBe("AQID");
});

const readImage = async () => {
  const pixels = Buffer.alloc(520 * 520 * 3, 73);
  const bytes = await sharp(pixels, { raw: { width: 520, height: 520, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  expect((await sharp(bytes).raw().toBuffer()).equals(pixels)).toBe(true);
  const data = bytes.toString("base64"); expect(data.length).toBeGreaterThan(1_048_576);
  const dimensions = { originalWidth: 520, originalHeight: 520, displayWidth: 520, displayHeight: 520 };
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data } };
  const value = { type: "user", uuid: randomUUID(), parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read-image", content: [{ type: "text", text: "before" }, image, { type: "text", text: "after" }] }] }, tool_use_result: { type: "image", file: { base64: data, type: "image/png", originalSize: bytes.length, dimensions } } };
  return { bytes, data, value };
};

test.each(["available", "unavailable"])("a FileReadOutput image copy shares its matching tool-result transfer and %s outcome", async outcome => {
  const f = await readImage(), transferred: { data: string; mediaType: string }[] = [], transferId = randomUUID();
  const receipt = outcome === "available" ? { transferId } : { error: "capacity_exceeded" };
  const result = await exportClaudeLiveMedia(f.value, async (data, mediaType) => { transferred.push({ data, mediaType }); return receipt; });
  expect(transferred).toEqual([{ data: f.data, mediaType: "image/png" }]);
  expect(result.images).toEqual([
    { path: ["message", "content", 0, "content", 1, "source", "data"], ...receipt },
    { path: ["tool_use_result", "file", "base64"], ...receipt },
  ]);
  expect(result.value.tool_use_result).toEqual({ ...f.value.tool_use_result, file: { ...f.value.tool_use_result.file, base64: null } });
  expect(result.value.message).toMatchObject({ content: [{ tool_use_id: "read-image", content: [{ type: "text", text: "before" }, { type: "image", source: { data: null } }, { type: "text", text: "after" }] }] });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1_048_576 - 4096);
  expect(f.value.tool_use_result.file.base64).toBe(f.data);
  expect(f.value.message.content[0]!.content[1]).toMatchObject({ source: { data: f.data } });
});

test.each(["different image", "different MIME", "unknown shape", "unknown metadata"])("FileReadOutput extraction does not exempt %s from the live metadata limit", async variant => {
  const f = await readImage();
  if (variant === "different image") f.value.tool_use_result.file.base64 = "A" + f.data.slice(1);
  else if (variant === "different MIME") f.value.tool_use_result.file.type = "image/jpeg";
  else if (variant === "unknown shape") f.value.tool_use_result.type = "unknown";
  const input = variant === "unknown metadata" ? { ...f.value, metadata: { opaque: f.data } } : f.value;
  await expect(exportClaudeLiveMedia(input, async () => ({ transferId: randomUUID() }))).rejects.toThrow("frame limit");
});

test.each(["string", "text block"])("large tool-result %s content reaches the existing display truncation without losing neighboring blocks", async variant => {
  const text = "a".repeat(199_999) + "😀" + "tail".repeat(300_000), before = { type: "text", text: "before" }, after = { type: "text", text: "after" };
  const content = variant === "string" ? text : [before, { type: "text", text }, after];
  const input = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "large-output", content }] } };
  const result = await exportClaudeLiveMedia(input, async () => { throw new Error("This event has no image"); });
  const tool = (result.value.message as typeof input.message).content[0]!;
  const exportedText = typeof tool.content === "string" ? tool.content : tool.content[1]!.text;
  expect(exportedText.length).toBeLessThanOrEqual(200_002); expect(exportedText.isWellFormed()).toBe(true);
  expect(limited(exportedText)).toBe(limited(text));
  if (Array.isArray(tool.content)) { expect(tool.content[0]).toEqual(before); expect(tool.content[2]).toEqual(after); }
  expect(input.message.content[0]!.content).toEqual(content); expect(result.images).toEqual([]);
});

test("large strings outside recognized user tool-result text remain subject to the live metadata limit", async () => {
  const text = "unknown".repeat(160_000);
  for (const value of [
    { type: "user", message: { content: [{ type: "unknown", content: text }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "unknown", text }] }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "short", metadata: { text } }] } },
    { type: "assistant", message: { content: [{ type: "tool_result", content: text }] } },
  ]) await expect(exportClaudeLiveMedia(value, async () => { throw new Error("This event has no image"); })).rejects.toThrow("frame limit");
});

test("the FileReadOutput alias participates in the existing 1000-position metadata limit", async () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } };
  const value = (count: number) => ({ type: "user", message: { content: [{ type: "tool_result", content: Array.from({ length: count }, () => image) }] }, tool_use_result: { type: "image", file: { base64: "AQID", type: "image/png", originalSize: 3 } } });
  const transfer = async () => ({ transferId: randomUUID() });
  expect((await exportClaudeLiveMedia(value(999), transfer)).images).toHaveLength(1000);
  await expect(exportClaudeLiveMedia(value(1000), transfer)).rejects.toThrow("metadata limit");
});
