import { afterEach, beforeEach, expect, test } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ClaudeBotRecovery, type ClaudeBotRecoveryOptions } from "../../../src/commands/controller/providers/claude-bot-recovery.js";
import { sqliteFilename } from "../../../src/platform/sqlite-filename.js";

const nativeId = "00000000-0000-4000-8000-000000000001", turnId = "00000000-0000-4000-8000-000000000002";
const version = { sdkVersion: "0.3.247", cliVersion: "2.1.247" };
let root: string, options: ClaudeBotRecoveryOptions, nativeFile: string;
const stores: ClaudeBotRecovery[] = [];
const key = () => ({ projectKey: "workspace", sessionId: nativeId });
const records = () => [
  { type: "user", uuid: turnId, sessionId: nativeId, cwd: options.cwd, parentUuid: null, message: { role: "user", content: [{ type: "text", text: "保护中文内容" }] } },
  { type: "assistant", uuid: "00000000-0000-4000-8000-000000000003", sessionId: nativeId, cwd: options.cwd, parentUuid: turnId, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "42" }] } },
];
const create = (value = options) => { const store = new ClaudeBotRecovery(value); stores.push(store); return store; };
const rawState = () => {
  const db = new Database(sqliteFilename(path.join(options.directory, "recovery.sqlite")));
  try { return JSON.parse((db.prepare("SELECT data FROM state WHERE id=1").get() as { data: string }).data); } finally { db.close(); }
};
const writeNative = async (value: unknown[] = records()) => {
  await mkdir(path.dirname(nativeFile), { recursive: true }); await writeFile(nativeFile, value.map(entry => JSON.stringify(entry)).join("\n") + "\n");
};
const protect = async () => {
  const store = create(); await store.prepare(null); store.validateVersion(version); store.markDirty();
  await store.append(key(), records()); await store.protect(nativeId, turnId); return store;
};
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true });
  root = await mkdtemp(path.join(process.cwd(), ".tmp", "claude-bot-recovery-"));
  options = { directory: path.join(root, "owned"), cwd: root, nativeHome: path.join(root, "native"), identity: {
    serverOrigin: "https://daynight.example", ownerUserId: randomUUID(), botId: randomUUID(), sessionId: randomUUID(),
  } };
  nativeFile = path.join(options.nativeHome, "projects", "workspace", `${nativeId}.jsonl`);
});
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await rm(root, { recursive: true, force: true }); });

test("a protected SQLite mirror reconstructs only its missing original transcript", async () => {
  const first = await protect(); first.close();
  const next = create(); await next.prepare(nativeId); next.validateVersion(version);
  expect(next.protectedThroughTurn).toBe(turnId);
  expect(next.transcriptPath).toBe(nativeFile);
  expect((await readFile(nativeFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))).toEqual(records());
  expect(rawState()).toMatchObject({ dirty: false, nativeSessionId: nativeId, protectedThroughTurn: turnId, version });
  const config = path.join(options.nativeHome, "settings.json"); await writeFile(config, '{"model":"current-model"}'); next.close();
  await create().prepare(nativeId); expect(await readFile(config, "utf8")).toBe('{"model":"current-model"}');
});

test("equal native entries retain their original bytes and UUID updates remain resumable", async () => {
  const first = await protect(), changed = records(); changed[1]!.message.content[0]!.text = "84";
  first.markDirty(); await first.append(key(), changed); await first.append(key(), changed); await first.protect(nativeId, turnId); first.close();
  await writeNative([...records(), changed[1]!]); const original = await readFile(nativeFile);
  await create().prepare(nativeId); expect(await readFile(nativeFile)).toEqual(original);
});

test.each(["extra input", "partial record", "altered response", "invalid UTF-8"])("%s in the original transcript blocks recovery without overwriting it", async mode => {
  (await protect()).close(); await writeNative();
  if (mode === "extra input") await appendFile(nativeFile, JSON.stringify({ ...records()[0], uuid: randomUUID() }) + "\n");
  if (mode === "partial record") await appendFile(nativeFile, '{"type":');
  if (mode === "altered response") await writeFile(nativeFile, (await readFile(nativeFile, "utf8")).replace('"42"', '"changed"'));
  if (mode === "invalid UTF-8") await appendFile(nativeFile, Buffer.from([0xff, 0x0a]));
  const original = await readFile(nativeFile); await expect(create().prepare(nativeId)).rejects.toThrow();
  expect(await readFile(nativeFile)).toEqual(original);
});

test("dirty state survives close and refuses rollback to a previously protected turn", async () => {
  const first = await protect(); first.markDirty(); first.close();
  await expect(create().prepare(nativeId)).rejects.toMatchObject({ code: "outcome_unknown" });
  expect(rawState().protectedThroughTurn).toBe(turnId);
  await expect(readFile(nativeFile)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an empty unsubmitted startup can retry but cannot resume an invented Session", async () => {
  const first = create(); await first.prepare(null); first.close();
  const retry = create(); await retry.prepare(null); retry.close();
  await expect(create().prepare(nativeId)).rejects.toMatchObject({ code: "recovery_material_missing" });
});

test("missing recovery material does not adopt a public transcript", async () => {
  await writeNative(); await expect(create().prepare(nativeId)).rejects.toMatchObject({ code: "recovery_material_missing" });
  const first = await protect(); first.close(); await unlink(path.join(options.directory, "recovery.sqlite"));
  await expect(create().prepare(nativeId)).rejects.toMatchObject({ code: "recovery_material_missing" });
});

test.each(["bot", "owner", "session", "service", "cwd", "nativeHome", "nativeId"])("mismatched %s cannot restore the mirror", async field => {
  (await protect()).close(); const changed = structuredClone(options);
  if (field === "bot") changed.identity.botId = randomUUID();
  if (field === "owner") changed.identity.ownerUserId = randomUUID();
  if (field === "session") changed.identity.sessionId = randomUUID();
  if (field === "service") changed.identity.serverOrigin = "https://other.example";
  if (field === "cwd") { changed.cwd = path.join(root, "other"); await mkdir(changed.cwd); }
  if (field === "nativeHome") changed.nativeHome = path.join(root, "other");
  await expect(create(changed).prepare(field === "nativeId" ? randomUUID() : nativeId)).rejects.toMatchObject({ code: "recovery_material_invalid" });
});

test.each([{ ...version, sdkVersion: "0.3.248" }, { ...version, cliVersion: "2.1.258" }, { sdkVersion: "unknown", cliVersion: "unknown" }])("unverified runtime %j is refused", async profile => {
  const store = create(); await store.prepare(null);
  expect(() => store.validateVersion(profile)).toThrow(/recovery_version_unsupported/);
  expect(rawState()).toMatchObject({ version: null, dirty: false });
});

test.each(["format", "version", "digest"])("tampered %s fails before native restoration", async field => {
  (await protect()).close(); const db = new Database(sqliteFilename(path.join(options.directory, "recovery.sqlite")));
  try {
    const state = rawState(); if (field === "format") state.format = 2;
    if (field === "version") state.version.cliVersion = "2.1.259";
    if (field === "digest") state.digest = "0".repeat(64);
    db.prepare("UPDATE state SET data=? WHERE id=1").run(JSON.stringify(state));
  } finally { db.close(); }
  await expect(create().prepare(nativeId)).rejects.toMatchObject({ code: field === "digest" ? "recovery_material_invalid" : "recovery_version_unsupported" });
  await expect(readFile(nativeFile)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["subpath", "other-session", "unsafe-key", "image", "subagent", "compact", "checkpoint"])("unsupported %s is retained as an unrecoverable dirty operation", async mode => {
  const store = await protect(); store.markDirty(); const entries: Record<string, unknown>[] = records(); const altered = key() as ReturnType<typeof key> & { subpath?: string };
  if (mode === "subpath") altered.subpath = "subagents/agent-1";
  if (mode === "other-session") altered.sessionId = randomUUID();
  if (mode === "unsafe-key") altered.projectKey = "../outside";
  if (mode === "image") entries.push({ type: "user", message: { content: [{ type: "image", source: { type: "base64", data: "AA==" } }] } });
  if (mode === "subagent") entries.push({ type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", input: {} }] } });
  if (mode === "compact") entries.push({ type: "system", subtype: "compact_boundary" });
  if (mode === "checkpoint") entries.push({ type: "file-history-snapshot" });
  await expect(store.append(altered, entries as never)).rejects.toMatchObject({ code: "recovery_material_invalid" });
  await expect(store.append(key(), records())).rejects.toMatchObject({ code: "recovery_material_invalid" });
  await expect(store.protect(nativeId, turnId)).rejects.toMatchObject({ code: "recovery_material_invalid" });
  expect(rawState().dirty).toBe(true);
});

test("SQLite write failure cannot be cleared by the SDK append retry", async () => {
  const store = await protect(); store.markDirty();
  const lock = new Database(sqliteFilename(path.join(options.directory, "recovery.sqlite"))); lock.exec("BEGIN IMMEDIATE");
  try { await expect(store.append(key(), [{ type: "tag", tag: "later" }])).rejects.toMatchObject({ code: "outcome_unknown" }); }
  finally { lock.exec("ROLLBACK"); lock.close(); }
  await expect(store.append(key(), records())).rejects.toMatchObject({ code: "outcome_unknown" });
  await expect(store.protect(nativeId, turnId)).rejects.toMatchObject({ code: "outcome_unknown" });
  expect(rawState().dirty).toBe(true);
});

test("late mirrored metadata updates the protected digest without losing the watermark", async () => {
  const store = await protect(); const metadata = { type: "custom-title", customTitle: "Later title" };
  await store.append(key(), [metadata]); store.close(); await writeNative([...records(), metadata]);
  const next = create(); await next.prepare(nativeId); expect(next.protectedThroughTurn).toBe(turnId); expect(rawState().dirty).toBe(false);
});

test("a successful result cannot protect a missing or superseded input", async () => {
  const store = create(); await store.prepare(null); store.validateVersion(version); store.markDirty();
  await store.append(key(), [...records(), { ...records()[0]!, uuid: randomUUID() }]);
  await expect(store.protect(nativeId, turnId)).rejects.toMatchObject({ code: "recovery_material_invalid" }); expect(rawState().dirty).toBe(true);
});

test("completed native queues and tool results protect together with SDK title metadata", async () => {
  const store = create(); await store.prepare(null); expect(store.transcriptPath).toBeNull(); store.validateVersion(version); store.markDirty();
  const entries = [
    { type: "queue-operation", operation: "enqueue", sessionId: nativeId, content: "Append once." },
    { type: "queue-operation", operation: "dequeue", sessionId: nativeId },
    records()[0]!, { type: "ai-title", aiTitle: "Append once", sessionId: nativeId }, { type: "atis-latch", atis: "", sessionId: nativeId },
    { ...records()[1]!, message: { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "printf 'tick\\n' >> counter.txt" } }] } },
    { ...records()[0]!, uuid: randomUUID(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "" }] } },
    { ...records()[1]!, uuid: randomUUID() },
  ];
  await store.append(key(), entries); await store.protect(nativeId, turnId); store.close();
  await create().prepare(nativeId);
  expect((await readFile(nativeFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))).toEqual(entries);
});

test.each(["queued input", "unresolved tool"])("%s cannot become a protected recovery point", async mode => {
  const store = create(); await store.prepare(null); store.validateVersion(version); store.markDirty();
  const entries: Record<string, unknown>[] = records();
  if (mode === "queued input") entries.push({ type: "queue-operation", operation: "enqueue", sessionId: nativeId, content: "Run later." });
  else entries.push({ ...records()[1]!, uuid: randomUUID(), message: { role: "assistant", content: [{ type: "tool_use", id: "tool-2", name: "Bash", input: {} }] } });
  await store.append(key(), entries as never);
  await expect(store.protect(nativeId, turnId)).rejects.toMatchObject({ code: "recovery_material_incomplete" }); expect(rawState().dirty).toBe(true);
});

test("an incomplete assistant mirror cannot be protected by a later success receipt", async () => {
  const store = create(); await store.prepare(null); store.validateVersion(version); store.markDirty();
  const entries = records(); entries[1]!.message.stop_reason = "tool_use";
  await store.append(key(), entries);
  await expect(store.protect(nativeId, turnId)).rejects.toMatchObject({ code: "recovery_material_incomplete" }); expect(rawState().dirty).toBe(true);
});

test.each([
  { type: "agent_listing_delta", addedTypes: ["general-purpose"], addedLines: ["General-purpose agent"], removedTypes: [], isInitial: true, showConcurrencyNote: true },
  { type: "skill_listing", content: "Available skills", skillCount: 1, isInitial: true, names: ["using-daynight"] },
  { type: "auto_mode", autoModeConsentFlow: false, bashFirst: false, steerOnly: false, bypass: true },
])("inline configuration attachment $type remains complete in the restored transcript", async attachment => {
  const store = create(); await store.prepare(null); store.validateVersion(version); store.markDirty();
  const entry = { type: "attachment", uuid: randomUUID(), sessionId: nativeId, cwd: options.cwd, parentUuid: turnId, attachment };
  const entries = [records()[0]!, entry, records()[1]!];
  await store.append(key(), entries); await store.protect(nativeId, turnId); store.close();
  await create().prepare(nativeId);
  expect((await readFile(nativeFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))).toEqual(entries);
});

test.each([
  { type: "file", filename: "outside.txt", path: "/outside.txt" },
  { type: "image", source: { type: "file", path: "/image.png" } },
  { type: "skill_listing", content: "Available skills", skillCount: 0, isInitial: true, names: [], path: "/external-state" },
  { type: "agent_listing_delta", addedTypes: [], addedLines: [{ path: "/external-state" }], removedTypes: [], isInitial: true, showConcurrencyNote: false },
])("attachment dependencies are not accepted as inline configuration: $type", async attachment => {
  const store = await protect(); store.markDirty();
  await expect(store.append(key(), [{ type: "attachment", uuid: randomUUID(), sessionId: nativeId, cwd: options.cwd, attachment }])).rejects.toMatchObject({ code: "recovery_material_invalid" });
  expect(rawState()).toMatchObject({ dirty: true, protectedThroughTurn: turnId });
});

test.skipIf(process.platform === "win32")("a symlink destination cannot redirect transcript restoration", async () => {
  (await protect()).close(); const outside = path.join(root, "outside"); await mkdir(outside);
  await mkdir(options.nativeHome); await symlink(outside, path.join(options.nativeHome, "projects"));
  await expect(create().prepare(nativeId)).rejects.toMatchObject({ code: "recovery_material_invalid" });
});
