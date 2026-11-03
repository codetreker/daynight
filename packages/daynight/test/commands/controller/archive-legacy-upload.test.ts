import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { uploadStoppedControllerArchive } from "../../../src/commands/controller/archive-upload.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore, type ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

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
    db.prepare("INSERT INTO operations(id,value) VALUES(?,?)").run(operation.operationId, JSON.stringify(operation));
    if (version >= 3) db.exec("UPDATE operations SET acknowledged=1;");
    db.prepare("INSERT INTO outbox VALUES(9,?)").run(JSON.stringify({ kind: "timeline_upsert", payload: entry }));
    if (version >= 2) db.prepare("INSERT INTO projection VALUES(?,?,3,?)").run(entry.entryId, "legacy-content-hash", JSON.stringify(entry));
  } finally { db.close(); }
  return { home, ticket, journalPath, snapshot, entry, operation };
};
const unavailable = { state: "unavailable", sha256: null, byteLength: null, errorCode: null };
const receiver = (bodies: string[], fail?: () => boolean): typeof fetch => async (_url, init) => {
  if (init?.method !== "PUT") return Response.json({ archive: unavailable });
  const body = String(init.body); bodies.push(body);
  if (fail?.()) return new Response(null, { status: 503 });
  return Response.json({ archive: { state: "ready", sha256: createHash("sha256").update(body).digest("hex"), byteLength: String(Buffer.byteLength(body)), errorCode: null } });
};
const inspect = <T>(file: string, action: (db: Database.Database) => T): T => {
  const db = new Database(file); try { return action(db); } finally { db.close(); }
};

test.each([2, 3, 4, 5] as const)("uploads a stopped v%i journal without acquiring its writer lease or changing execution identity", async version => {
  const f = await fixture(version), bodies: string[] = [];
  // A stale lease must remain untouched, even when its PID belongs to this process.
  inspect(f.journalPath, db => db.prepare("UPDATE execution SET owner_pid=?").run(process.pid));
  const identity = inspect(f.journalPath, db => db.prepare("SELECT ticket_hash,owner_pid,snapshot,last_sequence FROM execution").get());
  expect((await uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).state).toBe("ready");
  expect(bodies).toHaveLength(1);
  expect(JSON.parse(bodies[0]!)).toMatchObject({ executionGeneration: "1", nativeSessionId: f.snapshot.nativeSessionId, entries: [{ ...f.entry, entrySeq: "1" }] });
  inspect(f.journalPath, db => {
    expect(db.pragma("user_version", { simple: true })).toBe(6);
    expect(db.prepare("SELECT ticket_hash,owner_pid,snapshot,last_sequence FROM execution").get()).toEqual(identity);
    expect(db.prepare("SELECT value,acknowledged FROM operations").get()).toEqual({ value: JSON.stringify(f.operation), acknowledged: version >= 3 ? 1 : 0 });
    expect(db.prepare("SELECT sequence,value FROM outbox").get()).toEqual({ sequence: 9, value: JSON.stringify({ kind: "timeline_upsert", payload: f.entry }) });
  });
});

test("failed intermediate schema migration rolls back before exporting and can retry", async () => {
  const f = await fixture(2), bodies: string[] = [];
  inspect(f.journalPath, db => db.exec("CREATE TABLE resources (unrelated TEXT);"));
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).rejects.toThrow("resources");
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
  expect(JSON.parse(bodies[0]!).entries).toEqual([{ ...f.entry, entrySeq: "1" }]);
});

test("interrupted legacy content export keeps SQL originals and reuses the already written entry on retry", async () => {
  const f = await fixture(2), bodies: string[] = [];
  const second = { ...f.entry, entryId: randomUUID(), content: [{ type: "text", text: "second answer" }] };
  inspect(f.journalPath, db => db.prepare("INSERT INTO projection VALUES(?,?,1,?)").run(second.entryId, "second", "{}"));
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).rejects.toThrow();
  inspect(f.journalPath, db => {
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    expect(db.prepare("SELECT count(*) AS n FROM projection").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT snapshot FROM execution").get()).toEqual({ snapshot: JSON.stringify(f.snapshot) });
    db.prepare("UPDATE projection SET value=? WHERE id=?").run(JSON.stringify(second), second.entryId);
  });
  expect(await readdir(`${f.journalPath}.pending-content/timeline`)).toHaveLength(1);
  await uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) });
  expect(JSON.parse(bodies[0]!).entries).toEqual([{ ...f.entry, entrySeq: "1" }, { ...second, entrySeq: "2" }]);
});

test("upload retries preserve identical bytes after upgrading a stopped v2 journal", async () => {
  const f = await fixture(2), bodies: string[] = []; let fail = true;
  const request = receiver(bodies, () => fail);
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request })).rejects.toThrow("503");
  expect(inspect(f.journalPath, db => db.pragma("user_version", { simple: true }))).toBe(6);
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
  expect(inspect(f.journalPath, db => db.pragma("user_version", { simple: true }))).toBe(6);
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

test.each([1, 7] as const)("rejects archive journal version %i without changing its schema or identity", async version => {
  const f = await fixture(1), bodies: string[] = [];
  inspect(f.journalPath, db => db.pragma(`user_version=${version}`));
  await expect(uploadStoppedControllerArchive({ ...f, serverToken: "test", request: receiver(bodies) })).rejects.toThrow("Unsupported controller archive journal");
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
    expect(inspect(f.journalPath, db => db.pragma("user_version", { simple: true }))).toBe(6);
  } finally { store.close(); }
});
