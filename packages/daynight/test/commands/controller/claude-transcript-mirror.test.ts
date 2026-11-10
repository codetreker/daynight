import { afterEach, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { openClaudeTranscript } from "../../../src/commands/controller/providers/claude-transcript.js";
import { ClaudeTranscriptJson } from "../../../src/commands/controller/providers/claude-transcript-json.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/claude-transcript-mirror-")); roots.push(root);
  const nativeHome = path.join(root, "native"), cwd = path.join(root, "workspace"), nativeSessionId = randomUUID(), indexDirectory = path.join(root, "index");
  const transcriptPath = path.join(nativeHome, "projects", "authorized-project", `${nativeSessionId}.jsonl`);
  await mkdir(path.dirname(transcriptPath), { recursive: true }); await mkdir(cwd); await mkdir(indexDirectory, { mode: 0o700 });
  const record = (data: string, before = false, copies = 1) => {
    const toolUseResult = { type: "image", file: { base64: data, type: "image/png", originalSize: 4_000_000, dimensions: { originalWidth: 1000, originalHeight: 1000, displayWidth: 520, displayHeight: 520 } } };
    const value = { uuid: "read-result", parentUuid: null, type: "user", sessionId: nativeSessionId, cwd, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read-image", content: [{ type: "text", text: "before" }, ...Array.from({ length: copies }, () => ({ type: "image", source: { type: "base64", media_type: "image/png", data } })), { type: "text", text: "after" }] }] } };
    return before ? { toolUseResult, ...value } : { ...value, toolUseResult };
  };
  return { nativeHome, cwd, nativeSessionId, indexDirectory, transcriptPath, record };
};
const png = async () => {
  const pixels = Buffer.alloc(520 * 520 * 3, 73), bytes = await sharp(pixels, { raw: { width: 520, height: 520, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  expect(bytes.toString("base64").length).toBeGreaterThan(1_048_576);
  return { pixels, bytes, data: bytes.toString("base64") };
};

test.each(["before", "after", "escaped", "repeated image"] as const)("persisted Read mirror %s the message preserves only authoritative image sources across reopen", async order => {
  const f = await fixture(), image = await png(), copies = order === "repeated image" ? 2 : 1;
  const record = f.record(image.data, order === "before", copies);
  let source = JSON.stringify(record);
  if (order === "escaped") {
    record.toolUseResult.file.base64 = "MIRROR_DATA";
    source = JSON.stringify(record).replace('"MIRROR_DATA"', '"' + image.data.replaceAll("A", "\\u0041") + '"');
  }
  source += "\n"; await writeFile(f.transcriptPath, source);
  let firstMedia: string[] | undefined, firstSnapshot: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const reader = await openClaudeTranscript(f);
    try {
      const page = await reader.nextPage(), row = page.records[0]!;
      expect(row.media).toHaveLength(copies); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1_048_576);
      expect(JSON.stringify(page)).not.toContain(image.data);
      expect(row.value.message).toMatchObject({ content: [{ tool_use_id: "read-image", content: [{ type: "text", text: "before" }, ...Array.from({ length: copies }, () => ({ type: "image", source: { type: "base64", media_type: "image/png" } })), { type: "text", text: "after" }] }] });
      const mediaIds = row.media.map(media => media.mediaId);
      if (firstMedia) { expect(mediaIds).toEqual(firstMedia); expect(reader.snapshot.snapshotId).toBe(firstSnapshot); }
      else { firstMedia = mediaIds; firstSnapshot = reader.snapshot.snapshotId; }
      expect(reader.snapshot.prefixSha256).toBe(createHash("sha256").update(source).digest("hex"));
      await expect(reader.readMedia(mediaIds[0]!, () => {})).rejects.toThrow("acknowledged");
      await reader.acknowledge(page.cursor);
      for (const media of row.media) {
        expect(media.path.slice(0, 2)).toEqual(["message", "content"]);
        const chunks: Buffer[] = [];
        await reader.readMedia(media.mediaId, chunk => { expect(chunk.length).toBeLessThanOrEqual(49_152); chunks.push(Buffer.from(chunk)); });
        const bytes = Buffer.concat(chunks); expect(bytes.equals(image.bytes)).toBe(true); expect((await sharp(bytes).raw().toBuffer()).equals(image.pixels)).toBe(true);
      }
    } finally { await reader.close(); }
    expect(await readdir(f.indexDirectory)).toEqual([]);
  }
  expect(await readFile(f.transcriptPath, "utf8")).toBe(source);
});

test.each(["different data", "different MIME", "unknown shape", "only mirror", "not tool", "assistant", "unknown metadata"] as const)("persisted Read %s keeps its original metadata admission", async variant => {
  const f = await fixture(), image = await png(), value = f.record(image.data, true);
  if (variant === "different data") value.toolUseResult.file.base64 = "A" + image.data.slice(1);
  if (variant === "different MIME") value.toolUseResult.file.type = "image/jpeg";
  if (variant === "unknown shape") value.toolUseResult.type = "unknown";
  if (variant === "only mirror") value.message.content = [];
  if (variant === "not tool") value.message.content[0]!.type = "unknown";
  if (variant === "assistant") value.type = "assistant";
  await writeFile(f.transcriptPath, JSON.stringify(variant === "unknown metadata" ? { ...value, metadata: { base64: image.data } } : value) + "\n");
  await expect(openClaudeTranscript(f)).rejects.toThrow("metadata"); expect(await readdir(f.indexDirectory)).toEqual([]);
});

test("an unproved small Read mirror retains its complete original value", () => {
  const value = { type: "user", toolUseResult: { type: "image", file: { type: "image/png", base64: "BA==", originalSize: 4 } }, message: { content: [{ type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }] }] } };
  const scanner = new ClaudeTranscriptJson(); scanner.write(Buffer.from(JSON.stringify(value)), 0);
  const line = scanner.finish()!;
  expect(line.value.toolUseResult).toEqual(value.toolUseResult); expect(line.media).toHaveLength(1);
});

test.each([undefined, null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "4"])("Read originalSize %s does not prove a native mirror", originalSize => {
  const toolUseResult = { type: "image", file: { type: "image/png", base64: "AQID", originalSize } };
  const value = { type: "user", toolUseResult, message: { content: [{ type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }] }] } };
  const scanner = new ClaudeTranscriptJson(); scanner.write(Buffer.from(JSON.stringify(value)), 0);
  expect(scanner.finish()!.value.toolUseResult).toEqual(JSON.parse(JSON.stringify(toolUseResult)));
});

test.each<{ kind: string; mediaType: unknown }>([{ kind: "array", mediaType: ["image/png"] }, { kind: "null", mediaType: null }, { kind: "object", mediaType: {} }, { kind: "non-callable toString", mediaType: { toString: 0 } }])("unknown Read MIME $kind retains the original mirror metadata", ({ mediaType }) => {
  const toolUseResult = { type: "image", file: { type: mediaType, base64: "AQID", originalSize: 3 } };
  const value = { type: "user", toolUseResult, message: { content: [{ type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }] }] } };
  const scanner = new ClaudeTranscriptJson(); scanner.write(Buffer.from(JSON.stringify(value)), 0);
  expect(scanner.finish()!.value.toolUseResult).toEqual(toolUseResult);
});

test.each([true, false])("logical JSON strings retain every code unit across byte boundaries (matching=%s)", matching => {
  const data = 'é😀\ud800/"\\\b\f\n\r\t\0', mirror = matching ? data : data.replace("\ud800", "\ud801");
  const source = { data: "SOURCE_DATA", media_type: "image/png", type: "base64" };
  const toolUseResult = { file: { base64: mirror, originalSize: 0, type: "image/png" }, type: "image" };
  const value = { toolUseResult, message: { content: [{ content: [{ source, type: "image" }], type: "tool_result" }] }, type: "user" };
  const escaped = Array.from({ length: data.length }, (_, i) => "\\u" + data.charCodeAt(i).toString(16).padStart(4, "0")).join("");
  const bytes = Buffer.from(JSON.stringify(value).replace('"SOURCE_DATA"', '"' + escaped + '"'));
  const scanner = new ClaudeTranscriptJson();
  for (let i = 0; i < bytes.length; i++) scanner.write(bytes.subarray(i, i + 1), i);
  const line = scanner.finish()!;
  expect(line.media).toHaveLength(1); expect(line.media[0]!.error).toBe("invalid_base64");
  expect(line.value.toolUseResult).toEqual(matching ? { ...toolUseResult, file: { originalSize: 0, type: "image/png" } } : toolUseResult);
});

test.each(["invalid_base64", "image_too_large"] as const)("a matching persisted mirror retains authoritative %s without creating another media position", async error => {
  const f = await fixture(), data = error === "invalid_base64" ? "A".repeat(1_048_580) + "é😀\0" : Buffer.alloc(10_485_761, 73).toString("base64");
  const record = f.record(data, true); record.toolUseResult.file.base64 = "MIRROR_DATA";
  const mirror = JSON.stringify(data).replaceAll("é", "\\u00e9").replaceAll("😀", "\\ud83d\\ude00");
  await writeFile(f.transcriptPath, JSON.stringify(record).replace('"MIRROR_DATA"', mirror) + "\n");
  const reader = await openClaudeTranscript(f);
  try {
    const page = await reader.nextPage(); expect(page.records[0]!.media).toHaveLength(1); expect(page.records[0]!.media[0]).toMatchObject({ state: "unavailable", error });
    await reader.acknowledge(page.cursor); await expect(reader.readMedia(page.records[0]!.media[0]!.mediaId, () => {})).rejects.toThrow("unavailable");
  } finally { await reader.close(); }
});

test("different invalid characters cannot prove a persisted mirror", async () => {
  const f = await fixture(), data = "A".repeat(1_048_580) + "é😀\0", value = f.record(data);
  value.toolUseResult.file.base64 = data.replace("é", "è");
  await writeFile(f.transcriptPath, JSON.stringify(value) + "\n");
  await expect(openClaudeTranscript(f)).rejects.toThrow("metadata");
});

test.each(["escape", "duplicate"] as const)("persisted mirror handling still validates the %s tail", async kind => {
  const f = await fixture(), image = await png(), value = f.record(image.data), marker = "MIRROR_DATA";
  value.toolUseResult.file.base64 = marker;
  const source = JSON.stringify(value).replace('"' + marker + '"', kind === "escape" ? '"' + image.data + '\\q"' : '"' + image.data + '","base64":"duplicate"');
  await writeFile(f.transcriptPath, source + "\n");
  await expect(openClaudeTranscript(f)).rejects.toThrow(kind === "escape" ? /escape/ : /duplicate/); expect(await readdir(f.indexDirectory)).toEqual([]);
});
