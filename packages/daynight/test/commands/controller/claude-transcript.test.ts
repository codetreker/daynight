import { afterEach, expect, test, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openClaudeTranscript } from "../../../src/commands/controller/providers/claude-transcript.js";
import { ClaudeImageInputs } from "../../../src/commands/controller/providers/claude-image-input.js";
import { ClaudeProjection } from "../../../src/commands/controller/providers/claude-image-projection.js";
import { limited } from "../../../src/commands/controller/providers/projection.js";
import type { NativeInput, ProviderEntry, ProviderOptions } from "../../../src/commands/controller/providers/types.js";

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

test.each([{ error: "authentication_failed" }, { error: "invalid_request" }, { isApiErrorMessage: true }])("history preserves assistant failure evidence before matching the original image input: %j", async failure => {
  const f = await fixture(), operationId = randomUUID(), state = new Map<string, unknown>();
  const input: NativeInput = { content: [{ type: "image", imageId: randomUUID(), resourceId: randomUUID(), mediaType: "image/png", byteLength: "3", sha256: "a".repeat(64), localPath: "/unused-original" }] };
  const intent = { sha256: "b".repeat(64), state: "unknown", command: { kind: "send_message", operationId, payload: { expectedTurnId: null, target: { expectedNativeSessionId: f.nativeSessionId }, content: input.content } } };
  const options = { imageRuntime: { getIntent: (id: string) => id === operationId ? intent : null, readState: (key: string) => state.get(key) ?? null, writeState: (key: string, value: unknown) => state.set(key, structuredClone(value)) }, onInputObserved: vi.fn(() => true) } as unknown as ProviderOptions;
  const inputs = new ClaudeImageInputs(options, f.nativeSessionId); inputs.prepare(input, operationId);
  await f.write([f.record(operationId, null, "user", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }]), f.record("progress", operationId, "progress", "waiting"), f.record("failure", "progress", "assistant", [{ type: "text", text: "API request failed" }], failure)]);
  const reader = await openClaudeTranscript(f);
  try {
    const first = await reader.nextPage({ maxRecords: 1 }); await reader.acknowledge(first.cursor);
    const row = (await reader.nextPage()).records[0]!;
    expect(row.rootInputUuid).toBe(operationId);
    expect(inputs.observe({ ...row.value, user_message_uuid: row.rootInputUuid }, true)).toBeNull();
    expect(inputs.observe({ type: "result", session_id: f.nativeSessionId, user_message_uuid: operationId, is_error: true }, true)).toBeNull();
    expect(options.onInputObserved).not.toHaveBeenCalled(); expect(row.value).toMatchObject(failure);
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

test.each(["string", "nested"] as const)("large %s tool text reaches projection with the existing text limit and adjacent content intact", async kind => {
  const f = await fixture(), text = "x".repeat(199_999) + "😀" + "tail".repeat(300_000), entries: ProviderEntry[] = [];
  const content = kind === "string" ? text : [{ text, type: "text" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }, { type: "text", text: "after image" }];
  await f.write([f.record("root", null, "user", "question"), f.record("tool", "root", "assistant", [{ type: "tool_use", id: "call", name: "Read", input: {} }]), f.record("result", "tool", "user", [{ content, tool_use_id: "call", type: "tool_result" }, { type: "text", text: "adjacent user text" }]), f.record("answer", "result", "assistant", [{ type: "text", text: "finished" }])]);
  const reader = await openClaudeTranscript(f), projection = new ClaudeProjection({ cwd: f.cwd, model: null, args: [], resumeNativeSessionId: f.nativeSessionId, onTimeline: entry => entries.push(entry), onState: () => { throw new Error("History projection must not change provider state."); }, onSpawn: () => { throw new Error("History projection must not start a provider."); } }, f.nativeSessionId, () => null);
  try {
    const page = await reader.nextPage(); expect(page.records.map(row => row.value.uuid)).toEqual(["root", "tool", "result", "answer"]);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1_048_576);
    for (const row of page.records) projection.message(row.value, { row, reader });
    const output = entries.findLast(entry => entry.kind === "tool_call" && entry.status === "completed");
    expect(output).toMatchObject({ output: [{ type: "text", text: limited(text) }, ...(kind === "nested" ? [{ type: "image_unavailable" }, { type: "text", text: "after image" }] : [])] });
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "user_message", content: [{ type: "text", text: "adjacent user text" }] }), expect.objectContaining({ kind: "assistant_message", content: [{ type: "text", text: "finished" }] })]));
  } finally { await projection.close(); await reader.close(); }
});

test("escaped large tool text is bounded by decoded characters before metadata admission", async () => {
  const f = await fixture(), text = "a".repeat(210_000);
  const line = JSON.stringify(f.record("result", null, "user", [{ content: "ESCAPED_TOOL_TEXT", type: "tool_result", tool_use_id: "call" }])).replace('"ESCAPED_TOOL_TEXT"', '"' + "\\u0061".repeat(text.length) + '"');
  await writeFile(f.transcriptPath, line + "\n");
  const reader = await openClaudeTranscript(f);
  try {
    const row = (await reader.nextPage()).records[0]!, content = (row.value.message as { content: { content: string }[] }).content[0]!.content;
    expect(content.length).toBeLessThanOrEqual(200_002); expect(limited(content)).toBe(limited(text));
  } finally { await reader.close(); }
});

test("large non-ASCII tool text keeps complete UTF-8 characters across scanner buffers", async () => {
  const f = await fixture(), text = "汉😀".repeat(180_000);
  await f.write([f.record("result", null, "user", [{ content: text, type: "tool_result", tool_use_id: "call" }])]);
  const reader = await openClaudeTranscript(f);
  try {
    const row = (await reader.nextPage()).records[0]!, content = (row.value.message as { content: { content: string }[] }).content[0]!.content;
    expect(content.isWellFormed()).toBe(true); expect(limited(content)).toBe(limited(text));
  } finally { await reader.close(); }
});

test.each(["escaped prefix", "aggregate"] as const)("bounded tool text still respects the %s metadata byte ceiling", async kind => {
  const f = await fixture();
  const content = kind === "escaped prefix" ? [{ type: "tool_result", tool_use_id: "call", content: "\0".repeat(210_000) }]
    : Array.from({ length: 6 }, (_, index) => ({ type: "tool_result", tool_use_id: `call-${index}`, content: "x".repeat(210_000) }));
  await f.write([f.record("result", null, "user", content)]);
  await expect(openClaudeTranscript(f)).rejects.toThrow("metadata"); expect(await readdir(f.indexDirectory)).toEqual([]);
});

test.each(["escape", "utf8", "unclosed", "duplicate"] as const)("truncated tool text still rejects an invalid %s tail", async kind => {
  const f = await fixture(), line = JSON.stringify(f.record("result", null, "user", [{ content: "x".repeat(1_048_576) + "INVALID_TAIL", type: "tool_result", tool_use_id: "call" }]));
  const offset = line.indexOf("INVALID_TAIL");
  const bytes = kind === "utf8" ? Buffer.concat([Buffer.from(line.slice(0, offset)), Buffer.from([255]), Buffer.from(line.slice(offset + 12) + "\n")])
    : Buffer.from(kind === "escape" ? line.replace("INVALID_TAIL", "\\q") + "\n" : kind === "unclosed" ? line.slice(0, offset) + "\n" : line.replace('"type":"tool_result"', '"type":"tool_result","type":"tool_result"') + "\n");
  await writeFile(f.transcriptPath, bytes);
  await expect(openClaudeTranscript(f)).rejects.toThrow(kind === "escape" ? /escape/ : kind === "utf8" ? /encoded data|UTF-8/ : kind === "unclosed" ? /complete Claude transcript/ : /duplicate/);
  expect(await readdir(f.indexDirectory)).toEqual([]);
});

test.each(["unknown block", "assistant tool", "unknown child"] as const)("large %s text cannot bypass the metadata limit through a tool-like path", async kind => {
  const f = await fixture(), text = "x".repeat(1_048_576), content = kind === "unknown child" ? [{ text, type: "unknown" }] : text;
  await f.write([f.record("result", null, kind === "assistant tool" ? "assistant" : "user", [{ content, type: kind === "unknown block" ? "unknown" : "tool_result", tool_use_id: "call" }])]);
  await expect(openClaudeTranscript(f)).rejects.toThrow("metadata"); expect(await readdir(f.indexDirectory)).toEqual([]);
});

test("an unknown text field within the original metadata budget is retained in full", async () => {
  const f = await fixture(), text = "x".repeat(300_000);
  await f.write([f.record("result", null, "user", [{ content: text, type: "unknown" }])]);
  const reader = await openClaudeTranscript(f);
  try { expect((await reader.nextPage()).records[0]!.value.message).toMatchObject({ content: [{ content: text, type: "unknown" }] }); }
  finally { await reader.close(); }
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
