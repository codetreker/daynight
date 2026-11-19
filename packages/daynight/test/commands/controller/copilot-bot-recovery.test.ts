import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { CopilotBotRecovery, type CopilotBotRecoveryOptions } from "../../../src/commands/controller/providers/copilot-bot-recovery.js";
import { sqliteFilename } from "../../../src/platform/sqlite-filename.js";

const nativeId = randomUUID(), turnId = randomUUID(), messageId = randomUUID();
const version = { sdkVersion: "1.0.11", cliVersion: "1.0.105" };
let root: string, options: CopilotBotRecoveryOptions;
const stores: CopilotBotRecovery[] = [];
const create = (value = options) => { const store = new CopilotBotRecovery(value); stores.push(store); return store; };
const event = (type: string, data: Record<string, unknown> = {}, id = randomUUID()) => ({ id, type, data, timestamp: "2026-11-19T00:00:00Z" });
const records = () => [
  event("session.start", { sessionId: nativeId, copilotVersion: "1.0.105", context: { cwd: options.cwd } }),
  event("user.message", { content: "保护中文内容" }, messageId),
  event("tool.execution_start", { toolCallId: "counter" }),
  event("tool.execution_complete", { toolCallId: "counter", success: true }),
  event("assistant.message", { content: "Count is one." }),
  event("assistant.turn_end", { turnId: "0" }),
];
const writeNative = async (filename: string, content: string) => { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, content); };
const encode = (events: unknown[]) => events.map(value => JSON.stringify(value)).join("\n") + "\n";
const state = () => {
  const db = new Database(sqliteFilename(path.join(options.directory, "recovery.sqlite")));
  try { return JSON.parse((db.prepare("SELECT data FROM state WHERE id=1").get() as { data: string }).data); } finally { db.close(); }
};
const alterState = (update: (value: any) => void) => {
  const value = state(); update(value);
  const db = new Database(sqliteFilename(path.join(options.directory, "recovery.sqlite")));
  try { db.prepare("UPDATE state SET data=? WHERE id=1").run(JSON.stringify(value)); } finally { db.close(); }
};
const prepared = async () => { const store = create(); await store.prepare(nativeId, false); store.validateVersion(version); store.markDirty(); await mkdir(store.sourceDirectory, { recursive: true }); return store; };
const protectedStore = async () => {
  const store = await prepared(); await writeNative(path.join(store.sourceDirectory, "events.jsonl"), encode(records()));
  await store.protect(nativeId, turnId, messageId); return store;
};
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true });
  root = await mkdtemp(path.join(process.cwd(), ".tmp", "copilot-bot-recovery-"));
  options = { directory: path.join(root, "owned"), cwd: root, nativeHome: path.join(root, "native"), identity: { serverOrigin: "https://daynight.example", ownerUserId: randomUUID(), botId: randomUUID(), sessionId: randomUUID() } };
});
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); await rm(root, { recursive: true, force: true }); });

test("a protected private snapshot restores native files and SQLite without replaying a tool", async () => {
  const first = await prepared();
  await writeNative(path.join(first.sourceDirectory, "events.jsonl"), encode(records()));
  await writeNative(path.join(first.sourceDirectory, "checkpoints", "index.md"), "checkpoint 中文");
  const nativeDb = new Database(sqliteFilename(path.join(first.sourceDirectory, "session.db")));
  nativeDb.pragma("journal_mode=WAL"); nativeDb.exec("CREATE TABLE counter(value INTEGER NOT NULL); INSERT INTO counter VALUES(1)");
  try { await first.protect(nativeId, turnId, messageId); } finally { nativeDb.close(); }
  expect(state()).toMatchObject({ dirty: false, nativeSessionId: nativeId, protectedThroughTurn: turnId, nativeUserMessageId: messageId, version });
  await appendFile(path.join(first.sourceDirectory, "events.jsonl"), encode([event("session.shutdown")]));
  await first.close(); await rm(first.sourceDirectory, { recursive: true });
  const next = create(); await next.prepare(nativeId, true); next.validateVersion(version);
  expect(next.protectedThroughTurn).toBe(turnId);
  expect(await readFile(path.join(next.sourceDirectory, "checkpoints", "index.md"), "utf8")).toBe("checkpoint 中文");
  const restored = new Database(sqliteFilename(path.join(next.sourceDirectory, "session.db")));
  try { expect(restored.prepare("SELECT value FROM counter").all()).toEqual([{ value: 1 }]); } finally { restored.close(); }
  expect((await readFile(path.join(next.sourceDirectory, "events.jsonl"), "utf8")).includes("session.shutdown")).toBe(false);
});

test("the dirty barrier survives restart and preserves the last protected snapshot", async () => {
  const first = await protectedStore(), snapshot = state().snapshot; first.markDirty(); await first.close();
  await expect(create().prepare(nativeId, true)).rejects.toMatchObject({ code: "outcome_unknown" });
  expect(state()).toMatchObject({ dirty: true, snapshot, protectedThroughTurn: turnId });
  expect(await readdir(path.join(options.directory, "snapshots"))).toEqual([snapshot]);
});

test("a second committed point replaces the snapshot only after all native material is copied", async () => {
  const first = await protectedStore(), original = state().snapshot, secondMessage = randomUUID(), secondTurn = randomUUID();
  first.markDirty(); await appendFile(path.join(first.sourceDirectory, "events.jsonl"), encode([
    event("user.message", { content: "Next turn" }, secondMessage), event("assistant.message", { content: "Two" }), event("assistant.turn_end"),
  ]));
  await first.protect(nativeId, secondTurn, secondMessage);
  expect(state()).toMatchObject({ dirty: false, protectedThroughTurn: secondTurn }); expect(state().snapshot).not.toBe(original);
  expect(await readdir(path.join(options.directory, "snapshots"))).toEqual([state().snapshot]);
});

test.each(["missing manifest", "missing snapshot", "altered snapshot"])("%s fails recovery without replacing live files", async mode => {
  const first = await protectedStore(), saved = state(); await first.close();
  const live = path.join(first.sourceDirectory, "events.jsonl"), original = await readFile(live);
  if (mode === "missing manifest") await rm(path.join(options.directory, "recovery.sqlite"));
  else if (mode === "missing snapshot") await rm(path.join(options.directory, "snapshots", saved.snapshot), { recursive: true });
  else await appendFile(path.join(options.directory, "snapshots", saved.snapshot, "events.jsonl"), "changed");
  await expect(create().prepare(nativeId, true)).rejects.toThrow(); expect(await readFile(live)).toEqual(original);
});

test.each(["owner", "bot", "session", "service", "cwd", "native home", "native", "format", "version"])("%s mismatch cannot adopt protected data", async mode => {
  const first = await protectedStore(); await first.close();
  const changed = structuredClone(options); let id = nativeId;
  if (mode === "owner") changed.identity.ownerUserId = randomUUID();
  if (mode === "bot") changed.identity.botId = randomUUID();
  if (mode === "session") changed.identity.sessionId = randomUUID();
  if (mode === "service") changed.identity.serverOrigin = "https://other.example";
  if (mode === "cwd") { changed.cwd = path.join(root, "other"); await mkdir(changed.cwd); }
  if (mode === "native home") changed.nativeHome = path.join(root, "other-native");
  if (mode === "native") id = randomUUID();
  if (mode === "format") alterState(value => { value.format = 2; });
  if (mode === "version") alterState(value => { value.version.cliVersion = "1.0.106"; });
  await expect(create(changed).prepare(id, true)).rejects.toMatchObject({ code: ["format", "version"].includes(mode) ? "recovery_version_unsupported" : "recovery_material_invalid" });
});

test("unsubmitted initialization can reopen but cannot impersonate a protected Session", async () => {
  const first = create(); await first.prepare(nativeId, false); await first.close();
  const second = create(); await second.prepare(nativeId, false); await second.close();
  await expect(create().prepare(nativeId, true)).rejects.toMatchObject({ code: "recovery_material_missing" });
});

test.each(["partial", "no input", "no response", "no terminal", "unresolved tool", "unmatched result", "later input", "error", "foreign session", "foreign cwd", "duplicate event"])("%s refuses protection and retains dirty", async mode => {
  const store = await prepared(), events = records();
  if (mode === "no input") events.splice(1, 1);
  if (mode === "no response") events.splice(4, 1);
  if (mode === "no terminal") events.pop();
  if (mode === "unresolved tool") events.splice(3, 1);
  if (mode === "unmatched result") events.splice(2, 1);
  if (mode === "later input") events.push(event("user.message"));
  if (mode === "error") events.push(event("session.error"));
  if (mode === "foreign session") events[0]!.data.sessionId = randomUUID();
  if (mode === "foreign cwd") events[0]!.data.context = { cwd: path.join(root, "other") };
  if (mode === "duplicate event") events.push(events[4]!);
  await writeNative(path.join(store.sourceDirectory, "events.jsonl"), mode === "partial" ? encode(events).trimEnd() : encode(events));
  await expect(store.protect(nativeId, turnId, messageId)).rejects.toThrow(); expect(state().dirty).toBe(true);
  expect(() => store.markDirty()).toThrow();
});

test("version validation precedes protection and rejects unqualified runtime versions", async () => {
  const store = create(); await store.prepare(nativeId, false);
  expect(() => store.validateVersion({ ...version, sdkVersion: "1.0.12" })).toThrow(/recovery_version_unsupported/);
  await expect(store.protect(nativeId, turnId, messageId)).rejects.toMatchObject({ code: "recovery_version_unsupported" });
});

test("normal native shutdown metadata and execution lock removal preserve the original source", async () => {
  const first = await prepared(); await writeNative(path.join(first.sourceDirectory, "events.jsonl"), encode(records()));
  await writeFile(path.join(first.sourceDirectory, ".workspace-fork.lock"), "");
  await writeFile(path.join(first.sourceDirectory, "inuse.1234.lock"), "1234");
  await writeFile(path.join(first.sourceDirectory, "inuse.1234.hold"), "held");
  await first.protect(nativeId, turnId, messageId);
  expect(state().files.map((entry: any) => entry.path)).toEqual(["events.jsonl"]);
  await appendFile(path.join(first.sourceDirectory, "events.jsonl"), encode([event("session.shutdown", { shutdownType: "routine" })]));
  await first.close(); const original = await readFile(path.join(first.sourceDirectory, "events.jsonl"));
  const second = create(); await second.prepare(nativeId, true);
  expect(await readFile(path.join(second.sourceDirectory, "events.jsonl"))).toEqual(original);
});

test.each(["later input", "changed prefix", "partial suffix", "changed file", "partial restore"])("%s in the native source is never overwritten", async mode => {
  const first = await protectedStore(); await first.close(); const source = first.sourceDirectory;
  if (mode === "later input") await appendFile(path.join(source, "events.jsonl"), encode([event("user.message", { content: "unknown" })]));
  if (mode === "changed prefix") await writeFile(path.join(source, "events.jsonl"), encode(records()));
  if (mode === "partial suffix") await appendFile(path.join(source, "events.jsonl"), '{"type":"session.shutdown"');
  if (mode === "changed file") await writeFile(path.join(source, "settings.json"), "changed");
  if (mode === "partial restore") { await rm(source, { recursive: true }); await mkdir(source); await writeFile(path.join(source, "partial"), "preserve"); }
  const before = await readdir(source);
  const contents = await Promise.all(before.map(name => readFile(path.join(source, name))));
  await expect(create().prepare(nativeId, true)).rejects.toThrow();
  expect(await readdir(source)).toEqual(before);
  expect(await Promise.all(before.map(name => readFile(path.join(source, name))))).toEqual(contents);
});

test("a committed WAL snapshot also matches its unchanged native database after checkpoint", async () => {
  const first = await prepared(); await writeNative(path.join(first.sourceDirectory, "events.jsonl"), encode(records()));
  const db = new Database(sqliteFilename(path.join(first.sourceDirectory, "session.db")));
  db.pragma("journal_mode=WAL"); db.exec("CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(1)");
  try { await first.protect(nativeId, turnId, messageId); } finally { db.close(); }
  await first.close(); await create().prepare(nativeId, true);
});

test("a native write during SQLite backup refuses publication and retains the last point", async () => {
  const first = await protectedStore(), original = state().snapshot; first.markDirty();
  const db = new Database(sqliteFilename(path.join(first.sourceDirectory, "session.db"))); db.exec("CREATE TABLE counter(value INTEGER)"); db.close();
  const backup = Database.prototype.backup;
  vi.spyOn(Database.prototype, "backup").mockImplementation(async function(this: Database.Database, ...args: Parameters<typeof backup>) {
    const result = await backup.apply(this, args);
    await appendFile(path.join(first.sourceDirectory, "events.jsonl"), encode([event("user.message")])); return result;
  });
  await expect(first.protect(nativeId, turnId, messageId)).rejects.toMatchObject({ code: "recovery_material_invalid" });
  expect(state()).toMatchObject({ dirty: true, snapshot: original, protectedThroughTurn: turnId });
});

test("lost native ownership immediately before commit cannot clear the dirty barrier", async () => {
  const first = await protectedStore(), original = state().snapshot; first.markDirty();
  await expect(first.protect(nativeId, turnId, messageId, () => { throw new Error("native disconnected"); })).rejects.toMatchObject({ code: "outcome_unknown" });
  expect(state()).toMatchObject({ dirty: true, snapshot: original, protectedThroughTurn: turnId });
});

test("an orphan SQLite sidecar is not silently omitted from the recovery closure", async () => {
  const first = await protectedStore(); first.markDirty();
  await writeFile(path.join(first.sourceDirectory, "missing.db-wal"), "orphan");
  await expect(first.protect(nativeId, turnId, messageId)).rejects.toThrow(); expect(state().dirty).toBe(true);
});

test.each(["session.compaction_complete", "subagent.started", "autopilot.started"])("historical %s cannot inherit the ordinary recovery profile", async type => {
  const first = await prepared(), events = records(); events.splice(1, 0, event(type));
  await writeNative(path.join(first.sourceDirectory, "events.jsonl"), encode(events));
  await expect(first.protect(nativeId, turnId, messageId)).rejects.toMatchObject({ code: "recovery_material_incomplete" });
});

test("native and mirror directories cannot recursively contain each other", async () => {
  const source = path.join(options.nativeHome, "session-state", nativeId);
  await expect(create({ ...options, directory: path.join(source, "nested") }).prepare(nativeId, false)).rejects.toMatchObject({ code: "recovery_material_invalid" });
  await expect(create({ ...options, directory: options.nativeHome }).prepare(nativeId, false)).rejects.toMatchObject({ code: "recovery_material_invalid" });
});

test.skipIf(process.platform === "win32")("native symlinks cannot redirect source copying or restoration", async () => {
  const first = await prepared(), outside = path.join(root, "outside"); await mkdir(outside);
  await writeNative(path.join(first.sourceDirectory, "events.jsonl"), encode(records()));
  await symlink(outside, path.join(first.sourceDirectory, "link"));
  await expect(first.protect(nativeId, turnId, messageId)).rejects.toMatchObject({ code: "recovery_material_invalid" });
  expect(await readdir(outside)).toEqual([]);
});
