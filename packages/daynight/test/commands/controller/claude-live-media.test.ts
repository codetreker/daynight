import { afterEach, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeClaudeLiveInput, exportClaudeLiveMedia } from "../../../src/commands/controller/providers/claude-live-media.js";
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
