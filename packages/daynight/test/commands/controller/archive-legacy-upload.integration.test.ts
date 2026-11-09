import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { uploadStoppedControllerArchive } from "../../../src/commands/controller/archive-upload.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore, readControllerOperation, readControllerSnapshot, recordStoppedControllerGeneration, type ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { archiveTestReceiver } from "./archive-test-transport.js";
import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// Build each historical schema independently of the current lifecycle opener.
const fixture = async (version: 1 | 2 | 3 | 4 | 5) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/archive-tests");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "legacy-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: path.join(home, "removed-worktree"), nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "managed task", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const snapshot: ControllerSnapshot = { executionId: ticket.executionId, claimId: ticket.claimId, sessionId: ticket.sessionId, executionGeneration: "1", controllerInstanceId: ticket.controllerInstanceId, lifecycle: "stopped", nativeSessionId: randomUUID(), initialInputState: "confirmed", activity: "stopped", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, controllerProcess: null, nativeProcesses: [], nativeStopped: true, stoppedAt: new Date().toISOString(), error: null };
  const entry = { entryId: randomUUID(), revision: "3", kind: "assistant_message", content: [{ type: "text", text: "original legacy answer" }] };
  const operation = { executionGeneration: "1", operationId: ticket.initialOperationId, kind: "initial", payload: { text: ticket.initialPrompt }, payloadHash: "original-hash", state: "confirmed", result: { completed: true }, error: null, createdAt: 1, updatedAt: 2 };
  const journalPath = path.join(home, "journal.sqlite"), db = new Database(journalPath);
  try {
    db.exec("CREATE TABLE execution (id INTEGER PRIMARY KEY CHECK(id=1), ticket_hash TEXT NOT NULL, owner_pid INTEGER, snapshot TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0); CREATE TABLE operations (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE outbox (sequence INTEGER PRIMARY KEY, value TEXT NOT NULL);");
    if (version >= 2) db.exec("ALTER TABLE execution ADD COLUMN last_acknowledged INTEGER NOT NULL DEFAULT 0; CREATE TABLE projection (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL);");
    if (version >= 3) db.exec("ALTER TABLE operations ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0;");
    if (version >= 4) db.exec("ALTER TABLE execution ADD COLUMN projection_gap TEXT;");
    if (version >= 5) db.exec("ALTER TABLE execution ADD COLUMN source_floor INTEGER NOT NULL DEFAULT 0; CREATE TABLE resources (id TEXT PRIMARY KEY, descriptor TEXT NOT NULL, content BLOB);");
    db.pragma(`user_version=${version}`);
    db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot,last_sequence) VALUES(1,?,NULL,?,9)").run(controllerPayloadHash(ticket), JSON.stringify(snapshot));
    // Historical replay keeps only the last retained row; the service already
    // acknowledged the preceding source stream before this stopped snapshot.
    if (version >= 2) db.exec("UPDATE execution SET last_acknowledged=9;");
    db.prepare("INSERT INTO operations(id,value) VALUES(?,?)").run(operation.operationId, JSON.stringify(operation));
    if (version >= 3) db.exec("UPDATE operations SET acknowledged=1;");
    db.prepare("INSERT INTO outbox VALUES(9,?)").run(JSON.stringify({ kind: "timeline_upsert", payload: entry }));
    if (version >= 2) db.prepare("INSERT INTO projection VALUES(?,?,3,?)").run(entry.entryId, "legacy-content-hash", JSON.stringify(entry));
  } finally { db.close(); }
  return { home, ticket, journalPath, snapshot, entry, operation };
};
const unavailable = { state: "unavailable", sha256: null, byteLength: null, errorCode: null };
const receivers: ReturnType<typeof archiveTestReceiver>[]=[];
const receiver = (bodies:string[],fail?:()=>boolean):typeof fetch => { const result=archiveTestReceiver({bodies,sourceThrough:"9",...(fail?{fail}:{})});receivers.push(result);return result.request; };
const entries = (manifest:string):unknown => {const id=JSON.parse(manifest).timeline.fileId;const found=receivers.findLast(receiver=>receiver.files.has(id));return found?.entries(manifest);};
const inspect = <T>(file: string, action: (db: Database.Database) => T): T => {
  const db = new Database(file); try { return action(db); } finally { db.close(); }
};

test.each([2, 3, 4, 5] as const)("uploads a stopped v%i journal without acquiring its writer lease or changing execution identity", async version => {
  const f = await fixture(version), bodies: string[] = [];
  // A dead writer lease must stay unchanged; migration does not acquire it.
  inspect(f.journalPath, db => db.prepare("UPDATE execution SET owner_pid=?").run(2_000_000_000));
  const identity = inspect(f.journalPath, db => db.prepare("SELECT ticket_hash,owner_pid,snapshot,last_sequence FROM execution").get());
  expect((await uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).state).toBe("ready");
  expect(bodies).toHaveLength(1);
  expect(JSON.parse(bodies[0]!)).toMatchObject({ schemaVersion:3, fence:{executionGeneration: "1"}, nativeSessionId: f.snapshot.nativeSessionId });
  expect(entries(bodies[0]!)).toEqual([{ ...f.entry, entrySeq: "1" }]);
  inspect(f.journalPath, db => {
    expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat));
    expect(db.prepare("SELECT ticket_hash,owner_pid,snapshot,last_sequence FROM execution").get()).toEqual(identity);
    expect(db.prepare("SELECT value,acknowledged FROM operations").get()).toEqual({ value: JSON.stringify(f.operation), acknowledged: version >= 3 ? 1 : 0 });
    expect(db.prepare("SELECT sequence,value FROM outbox").get()).toEqual({ sequence: 9, value: JSON.stringify({ kind: "timeline_upsert", payload: f.entry }) });
  });
});

test("invalid legacy schema is rejected before exporting and can retry after repair", async () => {
  const f = await fixture(2), bodies: string[] = [];
  inspect(f.journalPath, db => db.exec("CREATE TABLE resources (unrelated TEXT);"));
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).rejects.toMatchObject({ kind: "invalid-format" });
  inspect(f.journalPath, db => {
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect((db.pragma("table_info(operations)") as { name: string }[]).map(row => row.name)).toEqual(["id", "value"]);
    expect((db.pragma("table_info(execution)") as { name: string }[]).map(row => row.name)).not.toContain("projection_gap");
    expect(db.prepare("SELECT value FROM projection").get()).toEqual({ value: JSON.stringify(f.entry) });
    db.exec("DROP TABLE resources;");
  });
  expect(bodies).toEqual([]);
  await expect(stat(`${f.journalPath}.pending-content`)).rejects.toMatchObject({ code: "ENOENT" });
  await uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) });
  expect(entries(bodies[0]!)).toEqual([{ ...f.entry, entrySeq: "1" }]);
});

test.each(["active", "unknown"] as const)("archive migration rejects an %s writer before changing schema or exporting files", async owner => {
  const f = await fixture(2), bodies: string[] = [];
  inspect(f.journalPath, db => db.prepare("UPDATE execution SET owner_pid=?").run(process.pid));
  if (owner === "unknown") vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Owner status unavailable"), { code: "EPERM" }); });
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).rejects.toMatchObject({ kind: "upgrade-blocked", outcome: "rolled-back", connectionClosed: true });
  inspect(f.journalPath, db => {
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(db.prepare("SELECT owner_pid,snapshot FROM execution").get()).toEqual({ owner_pid: process.pid, snapshot: JSON.stringify(f.snapshot) });
  });
  await expect(stat(`${f.journalPath}.pending-content`)).rejects.toMatchObject({ code: "ENOENT" });
  expect(bodies).toEqual([]);
});

test("v6 DDL failure rolls back every intermediate version while preserving exported files for retry", async () => {
  const f = await fixture(2), bodies: string[] = [], original = Database.prototype.exec;
  const exec = vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
    if (this.name === f.journalPath && sql.includes("CREATE TABLE content_index")) throw new Error("Injected content schema failure");
    return original.call(this, sql);
  });
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).rejects.toMatchObject({ kind: "migration-failed", outcome: "rolled-back", connectionClosed: true });
  exec.mockRestore();
  inspect(f.journalPath, db => {
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(db.prepare("SELECT value FROM projection").get()).toEqual({ value: JSON.stringify(f.entry) });
    expect((db.pragma("table_info(operations)") as { name: string }[]).map(row => row.name)).toEqual(["id", "value"]);
  });
  expect(await readdir(`${f.journalPath}.pending-content/timeline`)).toHaveLength(1);
  await uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) });
  expect(entries(bodies[0]!)).toEqual([{ ...f.entry, entrySeq: "1" }]);
});

test.each([2, 6] as const)("v%i archive rechecks stopped evidence after the receipt network boundary", async version => {
  const f = await fixture(2), bodies: string[] = [];
  if (version === 6) await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies, () => true) })).rejects.toThrow("503");
  await writeFile(`${f.journalPath}.archive-receipt-1.json`, JSON.stringify({ state: "ready", sha256: "a".repeat(64), byteLength: "1", errorCode: null }));
  const request: typeof fetch = async (_url, init) => {
    if (init?.method === "GET") inspect(f.journalPath, db => db.prepare("UPDATE execution SET snapshot=?").run(JSON.stringify({ ...f.snapshot, executionGeneration: "2" })));
    if (init?.method === "PUT") throw new Error("A changed execution must not upload");
    return Response.json({ archive: unavailable });
  };
  const result = uploadStoppedControllerArchive({ ...f, serverToken: "test", request });
  await expect(result).rejects.toThrow("differs from the confirmed receipt");
  expect(inspect(f.journalPath, db => db.pragma("user_version", { simple: true }))).toBe(version === 6 ? currentSqliteVersion(controllerJournalFormat) : version);
});

test("interrupted legacy export retains SQL originals and rejects a different source under the same migration", async () => {
  const f = await fixture(2), bodies: string[] = [];
  const second = { ...f.entry, entryId: randomUUID(), content: [{ type: "text", text: "second answer" }] };
  inspect(f.journalPath, db => db.prepare("INSERT INTO projection VALUES(?,?,1,?)").run(second.entryId, "second", "{}"));
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).rejects.toThrow();
  inspect(f.journalPath, db => {
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(db.prepare("SELECT count(*) AS n FROM projection").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT snapshot FROM execution").get()).toEqual({ snapshot: JSON.stringify(f.snapshot) });
    db.prepare("UPDATE projection SET value=? WHERE id=?").run(JSON.stringify(second), second.entryId);
  });
  expect(await readdir(`${f.journalPath}.pending-content/timeline`)).toHaveLength(1);
  const failure = await uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) }).then(() => null, error => error as Error & { kind: string });
  expect(failure).toMatchObject({ kind: "migration-failed" });
  let cause: unknown = failure;
  while (cause instanceof Error && cause.message !== "Legacy migration source changed before verification.") cause = cause.cause;
  expect(cause).toBeInstanceOf(Error);
  expect(bodies).toEqual([]);expect(inspect(f.journalPath,db=>db.pragma("user_version",{simple:true}))).toBe(2);
});

test("upload retries preserve identical bytes after upgrading a stopped v2 journal", async () => {
  const f = await fixture(2), bodies: string[] = []; let fail = true;
  const request = receiver(bodies, () => fail);
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request })).rejects.toThrow("503");
  expect(inspect(f.journalPath, db => db.pragma("user_version", { simple: true }))).toBe(currentSqliteVersion(controllerJournalFormat));
  fail = false;
  await uploadStoppedControllerArchive({ ...f, serverToken: "test", request });
  expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
});

test("a legacy projection gap still prevents publishing a complete archive", async () => {
  const f = await fixture(4), bodies: string[] = [];
  inspect(f.journalPath, db => db.exec("UPDATE execution SET projection_gap='Native output was lost';"));
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).rejects.toThrow("unresolved projection gap");
  expect(bodies).toEqual([]);
  expect(inspect(f.journalPath, db => db.prepare("SELECT projection_gap,archive_incomplete FROM execution").get())).toEqual({ projection_gap: "Native output was lost", archive_incomplete: 1 });
});

test("a migrated v6 journal cannot recreate a missing source manifest and publish it", async () => {
  const f = await fixture(2), bodies: string[] = [];
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies, () => true) })).rejects.toThrow("503");
  await rm(`${f.journalPath}.pending-content/manifest.json`);
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).rejects.toThrow("Pending archive source is missing");
  expect(bodies).toHaveLength(1);
  expect(inspect(f.journalPath, db => db.pragma("user_version", { simple: true }))).toBe(currentSqliteVersion(controllerJournalFormat));
  await expect(stat(`${f.journalPath}.pending-content/manifest.json`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("unproven stop evidence prevents migration before touching the legacy schema", async () => {
  const f = await fixture(2), bodies: string[] = [];
  inspect(f.journalPath, db => db.prepare("UPDATE execution SET snapshot=?").run(JSON.stringify({ ...f.snapshot, nativeStopped: false })));
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).rejects.toThrow("original stopped controller generation");
  expect(inspect(f.journalPath, db => db.pragma("user_version", { simple: true }))).toBe(2);
  expect(bodies).toEqual([]);
  await expect(stat(`${f.journalPath}.pending-content`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("archive opening reports an inaccessible journal as a typed failure without creating it", async () => {
  const f = await fixture(2), bodies: string[] = [];
  await rm(f.journalPath);
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).rejects.toMatchObject({ kind: "invalid-format", connectionClosed: true, context: { phase: "archive-open" } });
  await expect(stat(f.journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(bodies).toEqual([]);
});

test.each([1, 999] as const)("rejects archive journal version %i without changing its schema or identity", async version => {
  const f = await fixture(1), bodies: string[] = [];
  inspect(f.journalPath, db => db.pragma(`user_version=${version}`));
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).rejects.toMatchObject({ kind: "unsupported-version" });
  inspect(f.journalPath, db => {
    expect(db.pragma("user_version", { simple: true })).toBe(version);
    expect(db.prepare("SELECT snapshot FROM execution").get()).toEqual({ snapshot: JSON.stringify(f.snapshot) });
  });
  expect(bodies).toEqual([]);
});

test.each([1, 2, 3, 4, 5] as const)("normal lifecycle opening retains v%i upgrade and writer-lease behavior", async version => {
  const f = await fixture(version);
  const store = openControllerLifecycleStore(f.journalPath, f.ticket);
  try {
    expect(store.getSnapshot()).toEqual(f.snapshot);
    expect(store.getOperation(f.operation.operationId)).toEqual(f.operation);
    expect(() => openControllerLifecycleStore(f.journalPath, f.ticket)).toThrow("writer is still running");
    expect(inspect(f.journalPath, db => db.pragma("user_version", { simple: true }))).toBe(currentSqliteVersion(controllerJournalFormat));
  } finally { store.close(); }
});

test.each((["stop", "snapshot", "operation", "writer"] as const).flatMap(entrypoint => [false, true].map(drained => [entrypoint, drained] as const)))("%s upgrade cannot turn a v1 source into a complete archive (outbox drained: %s)", async (entrypoint, drained) => {
  const f = await fixture(1), bodies: string[] = [];
  if (drained) inspect(f.journalPath, db => db.exec("DELETE FROM outbox"));
  if (entrypoint === "snapshot") expect(readControllerSnapshot(f.journalPath)).toEqual(f.snapshot);
  else if (entrypoint === "operation") expect(readControllerOperation(f.journalPath, f.operation.operationId)).toEqual(f.operation);
  else if (entrypoint === "writer") {
    const store = openControllerLifecycleStore(f.journalPath, f.ticket);
    // Delivery may drain the old outbox without supplying a complete local history.
    store.acknowledgeEvents("9");
    store.close();
  }
  const stopped = { ...f.snapshot, controllerProcess: { pid: 2_000_000_000, parentPid: 1, processGroupId: 2_000_000_000, startedAt: "original", commandHash: "a".repeat(64) } };
  inspect(f.journalPath, db => db.prepare("UPDATE execution SET snapshot=?").run(JSON.stringify(stopped)));
  // Only process-tree inspection is substituted; stop reconciliation and both
  // database openings are real and preserve their migration transactions.
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  expect(await recordStoppedControllerGeneration(f.journalPath, f.ticket)).toEqual(stopped);
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).rejects.toThrow("unresolved projection gap");
  expect(bodies).toEqual([]);
  inspect(f.journalPath, db => {
    expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat));
    expect(db.prepare("SELECT archive_incomplete FROM execution").get()).toEqual({ archive_incomplete: 1 });
    expect(db.prepare("SELECT value FROM outbox").all()).toEqual(drained || entrypoint === "writer" ? [] : [{ value: JSON.stringify({ kind: "timeline_upsert", payload: f.entry }) }]);
  });
});
