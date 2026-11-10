import { afterEach, expect, test } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openClaudeTranscript } from "../../../src/commands/controller/providers/claude-transcript.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  const base = path.resolve(".tmp"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "claude-transcript-")); roots.push(root);
  const nativeHome = path.join(root, "native"), cwd = path.join(root, "workspace"), nativeSessionId = randomUUID();
  const transcriptPath = path.join(nativeHome, "projects", "authorized-project", `${nativeSessionId}.jsonl`), indexDirectory = path.join(root, "index");
  await mkdir(path.dirname(transcriptPath), { recursive: true }); await mkdir(cwd); await mkdir(indexDirectory, { mode: 0o700 });
  const record = (uuid: string, parentUuid: string | null, type: string, content: unknown, extra: Record<string, unknown> = {}) => ({ uuid, parentUuid, type, sessionId: nativeSessionId, cwd, message: { role: type, content }, ...extra });
  const write = async (records: unknown[]) => writeFile(transcriptPath, records.map(record => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
  return { root, nativeHome, cwd, nativeSessionId, transcriptPath, indexDirectory, record, write };
};

test("selects the root parent chain and assistant siblings independently of physical page boundaries", async () => {
  const f = await fixture();
  await f.write([
    f.record("u1", null, "user", "first"),
    f.record("a1", "u1", "assistant", [{ type: "text", text: "A" }], { timestamp: "1", message: { id: "msg-one", role: "assistant", content: [{ type: "text", text: "A" }] } }),
    f.record("a2", "u1", "assistant", [{ type: "text", text: "B" }], { timestamp: "2", message: { id: "msg-one", role: "assistant", content: [{ type: "text", text: "B" }] } }),
    f.record("tool", "a1", "user", [{ type: "tool_result", tool_use_id: "call-one", content: "done" }], { timestamp: "3" }),
    f.record("next", "a2", "user", "next"),
    f.record("side", null, "assistant", "do not import", { isSidechain: true }),
  ]);
  const reader = await openClaudeTranscript(f);
  try {
    const first = await reader.nextPage({ maxRecords: 2 });
    expect(first.records.map(record => record.value.uuid)).toEqual(["u1", "a2"]);
    expect(first.records[1]?.assistantBlockOffset).toBe(0);
    expect(await reader.nextPage({ maxRecords: 2 })).toEqual(first);
    await expect(reader.acknowledge("wrong cursor")).rejects.toThrow("cursor");
    await reader.acknowledge(first.cursor);
    const second = await reader.nextPage({ maxRecords: 2 });
    expect(second.records.map(record => record.value.uuid)).toEqual(["a1", "tool"]);
    expect(second.records[0]?.assistantBlockOffset).toBe(1);
    await reader.acknowledge(second.cursor);
    const third = await reader.nextPage(); expect(third.records.map(record => record.value.uuid)).toEqual(["next"]); expect(third.done).toBe(true);
  } finally { await reader.close(); }
});

test("indexes image strings without publishing bytes and reads only an acknowledged selected occurrence", async () => {
  const f = await fixture(), bytes = Buffer.from([1, 2, 3, 4, 5]);
  const image = { source: { data: bytes.toString("base64"), media_type: "image/png", type: "base64" }, type: "image" };
  await f.write([f.record("u", null, "user", [{ type: "text", text: "before" }, image, { type: "text", text: "after" }])]);
  const reader = await openClaudeTranscript(f);
  try {
    const page = await reader.nextPage(), record = page.records[0]!;
    expect(record.value.message).toMatchObject({ content: [{ type: "text", text: "before" }, { type: "image", source: { type: "base64", media_type: "image/png" } }, { type: "text", text: "after" }] });
    expect(JSON.stringify(page)).not.toContain(bytes.toString("base64")); expect(JSON.stringify(page)).not.toContain(f.transcriptPath);
    expect(record.media).toHaveLength(1); expect(record.media[0]).toMatchObject({ path: ["message", "content", 1, "source", "data"], byteLength: 5, state: "available" });
    const received: Buffer[] = [];
    await expect(reader.readMedia(record.media[0]!.mediaId, chunk => { received.push(Buffer.from(chunk)); })).rejects.toThrow("acknowledged");
    expect(received).toEqual([]); await reader.acknowledge(page.cursor);
    await reader.readMedia(record.media[0]!.mediaId, chunk => { received.push(Buffer.from(chunk)); });
    expect(Buffer.concat(received)).toEqual(bytes);
    await expect(reader.readMedia("not-selected", () => {})).rejects.toThrow("selected");
  } finally { await reader.close(); }
});

test("preservedMessages rewrites the selected chain while preserving the explicit array order", async () => {
  const f = await fixture();
  await f.write([
    f.record("old", null, "user", "old"), f.record("keep2", "old", "assistant", "two"), f.record("keep1", "old", "user", "one"),
    { uuid: "compact", parentUuid: null, type: "system", subtype: "compact_boundary", sessionId: f.nativeSessionId, cwd: f.cwd, compactMetadata: { preservedMessages: { anchorUuid: "compact", uuids: ["keep1", "keep2"] } } },
    f.record("last", "compact", "user", "last"),
  ]);
  const reader = await openClaudeTranscript(f);
  try { expect((await reader.nextPage()).records.map(record => record.value.uuid)).toEqual(["compact", "keep1", "keep2", "last"]); }
  finally { await reader.close(); }
});

test("rejects missing parent links instead of importing an unproved suffix", async () => {
  const f = await fixture(); await f.write([f.record("u", "missing", "user", "orphan")]);
  await expect(openClaudeTranscript(f)).rejects.toThrow("chain");
});

test("ignores an unfinished tail and verifies the old prefix before accepting append", async () => {
  const f = await fixture(); await f.write([f.record("u", null, "user", "first")]);
  const partial = JSON.stringify(f.record("a", "u", "assistant", "second")); await appendFile(f.transcriptPath, partial.slice(0, -4));
  const reader = await openClaudeTranscript(f);
  try {
    const first = await reader.nextPage(); expect(first.records.map(record => record.value.uuid)).toEqual(["u"]); await reader.acknowledge(first.cursor);
    await appendFile(f.transcriptPath, partial.slice(-4) + "\n");
    const original = reader.snapshot.snapshotId; await reader.refresh(); expect(reader.snapshot.snapshotId).not.toBe(original);
    expect((await reader.nextPage()).records.map(record => record.value.uuid)).toEqual(["u", "a"]);
    const data = await readFile(f.transcriptPath, "utf8"); await writeFile(f.transcriptPath, data.replace("first", "other"));
    await expect(reader.refresh()).rejects.toThrow("prefix");
  } finally { await reader.close(); }
});

test("does not read replaced or truncated files through a retained descriptor", async () => {
  const f = await fixture(); await f.write([f.record("u", null, "user", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }])]);
  const reader = await openClaudeTranscript(f);
  try {
    const page = await reader.nextPage(); await reader.acknowledge(page.cursor);
    await rename(f.transcriptPath, f.transcriptPath + ".original"); await f.write([f.record("u", null, "user", "replacement")]);
    await expect(reader.readMedia(page.records[0]!.media[0]!.mediaId, () => {})).rejects.toThrow("identity");
    await rm(f.transcriptPath); await rename(f.transcriptPath + ".original", f.transcriptPath); await truncate(f.transcriptPath, 1);
    await expect(reader.refresh()).rejects.toThrow("truncated");
  } finally { await reader.close(); }
});

test("refuses an untrusted transcript path and mismatched native identity", async () => {
  const f = await fixture(); await f.write([f.record("u", null, "user", "hello")]);
  const outside = path.join(f.root, `${f.nativeSessionId}.jsonl`); await writeFile(outside, await readFile(f.transcriptPath));
  await expect(openClaudeTranscript({ ...f, transcriptPath: outside })).rejects.toThrow("authorized");
  await rm(f.transcriptPath); await symlink(outside, f.transcriptPath);
  await expect(openClaudeTranscript(f)).rejects.toThrow("symbolic"); await rm(f.transcriptPath);
  await f.write([f.record("u", null, "user", "hello", { sessionId: randomUUID() })]);
  await expect(openClaudeTranscript(f)).rejects.toThrow("session");
});

test("decodes escaped image strings across input buffers and retains surrounding text", async () => {
  const f = await fixture(), bytes = Buffer.alloc(96_001, 255);
  const line = JSON.stringify(f.record("u", null, "user", [{ type: "text", text: "前" }, { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } }, { type: "text", text: "後" }]));
  await writeFile(f.transcriptPath, line.replaceAll("/", "\\/").replace('"message"', '"\\u006dessage"') + "\n");
  const reader = await openClaudeTranscript(f);
  try {
    const page = await reader.nextPage(); await reader.acknowledge(page.cursor);
    expect(page.records[0]?.media[0]).toMatchObject({ byteLength: bytes.length, state: "available" });
    const chunks: Buffer[] = []; await reader.readMedia(page.records[0]!.media[0]!.mediaId, chunk => { expect(chunk.length).toBeLessThanOrEqual(49_152); chunks.push(Buffer.from(chunk)); });
    expect(chunks.length).toBeGreaterThan(1); expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(JSON.stringify(page)).toContain("前"); expect(JSON.stringify(page)).toContain("後");
  } finally { await reader.close(); }
});

test("marks malformed or noncanonical Base64 unavailable without losing sibling content", async () => {
  const f = await fixture();
  await f.write([f.record("u", null, "user", [...["AB==", "AQ=", "AQ==extra"].map(data => ({ type: "image", source: { type: "base64", media_type: "image/png", data } })), { type: "text", text: "retained" }])]);
  const reader = await openClaudeTranscript(f);
  try {
    const page = await reader.nextPage(); await reader.acknowledge(page.cursor);
    expect(page.records[0]?.media.map(media => media.error)).toEqual(["invalid_base64", "invalid_base64", "invalid_base64"]);
    expect(JSON.stringify(page)).toContain("retained");
    await expect(reader.readMedia(page.records[0]!.media[0]!.mediaId, () => { throw new Error("must not consume"); })).rejects.toThrow("unavailable");
  } finally { await reader.close(); }
});

test("fails closed on duplicate keys, invalid UTF-8 and excessive JSON depth", async () => {
  const f = await fixture();
  const valid = JSON.stringify(f.record("u", null, "user", "valid"));
  await writeFile(f.transcriptPath, valid.replace('"type":"user"', '"type":"user","type":"assistant"') + "\n");
  await expect(openClaudeTranscript(f)).rejects.toThrow("duplicate");
  await writeFile(f.transcriptPath, Buffer.concat([Buffer.from(valid.slice(0, -1) + ',"invalid":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
  await expect(openClaudeTranscript(f)).rejects.toThrow();
  await writeFile(f.transcriptPath, valid.slice(0, -1) + ',"deep":' + "[".repeat(65) + "0" + "]".repeat(65) + "}\n");
  await expect(openClaudeTranscript(f)).rejects.toThrow("depth");
  expect(await readdir(f.indexDirectory)).toEqual([]);
});

test("rejects unexpected native image data shapes before they can cross a metadata page", async () => {
  const f = await fixture();
  for (const data of [["AQID"], { value: "AQID" }, 123, null]) {
    await f.write([f.record("u", null, "user", [{ type: "image", source: { type: "base64", media_type: "image/png", data } }])]);
    await expect(openClaudeTranscript(f)).rejects.toThrow("JSON string");
  }
  expect(await readdir(f.indexDirectory)).toEqual([]);
});

test("restores a committed cursor only for the same file snapshot and selected chain", async () => {
  const f = await fixture(); await f.write([f.record("u", null, "user", "one"), f.record("a", "u", "assistant", "two")]);
  const first = await openClaudeTranscript(f), page = await first.nextPage({ maxRecords: 1 }); await first.acknowledge(page.cursor); await first.close();
  const reopened = await openClaudeTranscript({ ...f, resumeCursor: page.cursor });
  try { expect((await reopened.nextPage()).records.map(row => row.value.uuid)).toEqual(["a"]); } finally { await reopened.close(); }
  await appendFile(f.transcriptPath, JSON.stringify(f.record("last", "a", "user", "three")) + "\n");
  await expect(openClaudeTranscript({ ...f, resumeCursor: page.cursor })).rejects.toThrow("another snapshot");
  expect(await readdir(f.indexDirectory)).toEqual([]);
});

test("rewrites preserved segments and rejects selected parent cycles", async () => {
  const f = await fixture();
  await f.write([
    f.record("old", null, "user", "old"), f.record("head", "old", "assistant", "head"), f.record("tail", "head", "user", "tail"),
    { uuid: "compact", parentUuid: null, type: "system", subtype: "compact_boundary", sessionId: f.nativeSessionId, cwd: f.cwd, compactMetadata: { preservedSegment: { anchorUuid: "compact", headUuid: "head", tailUuid: "tail" } } },
    f.record("last", "compact", "user", "last"),
  ]);
  const reader = await openClaudeTranscript(f);
  try { expect((await reader.nextPage()).records.map(row => row.value.uuid)).toEqual(["compact", "head", "tail", "last"]); } finally { await reader.close(); }
  await f.write([f.record("u", "a", "user", "u"), f.record("a", "u", "assistant", "a"), f.record("last", "a", "user", "last")]);
  await expect(openClaudeTranscript(f)).rejects.toThrow("cycle");
});

test("cleans the actual SQLite files when a later metadata reservation is refused", async () => {
  const f = await fixture(); await f.write([f.record("u", null, "user", "one")]);
  let reservations = 0, releases = 0;
  await expect(openClaudeTranscript({ ...f, reserveIndex: async () => { if (++reservations === 2) throw new Error("shared metadata budget full"); return { release: () => { releases++; } }; } })).rejects.toThrow("metadata budget");
  expect(releases).toBe(1); expect(await readdir(f.indexDirectory)).toEqual([]);
});
