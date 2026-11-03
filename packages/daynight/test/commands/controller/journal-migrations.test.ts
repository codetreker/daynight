import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openControllerLifecycleStore, readControllerOperation, readControllerSnapshot, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { sessionBinding } from "../../../src/session/protocol.js";

const proof = vi.hoisted(() => ({ stopped: vi.fn() }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ confirmControllerProcessesStopped: proof.stopped }));
const roots: string[] = [];
beforeEach(() => { proof.stopped.mockReset().mockResolvedValue(true); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/journal-upgrades"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "managed", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  return { home, file: path.join(home, "journal.sqlite"), ticket };
};
// Fixtures reproduce the shipped statements rather than calling the current
// format definition or removing columns from its latest schema.
const historical = (file: string, version: number, ticket: ControllerLaunchTicket, owner: number | null = null) => {
  const db = new Database(file);
  db.exec("CREATE TABLE execution (id INTEGER PRIMARY KEY CHECK(id=1), ticket_hash TEXT NOT NULL, owner_pid INTEGER, snapshot TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0); CREATE TABLE operations (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE outbox (sequence INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  if (version >= 2) db.exec("ALTER TABLE execution ADD COLUMN last_acknowledged INTEGER NOT NULL DEFAULT 0; CREATE TABLE projection (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL)");
  if (version >= 3) db.exec("ALTER TABLE operations ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0");
  if (version >= 4) db.exec("ALTER TABLE execution ADD COLUMN projection_gap TEXT");
  if (version >= 5) db.exec("ALTER TABLE execution ADD COLUMN source_floor INTEGER NOT NULL DEFAULT 0; CREATE TABLE resources (id TEXT PRIMARY KEY, descriptor TEXT NOT NULL, content BLOB)");
  const snapshot = JSON.stringify({ executionId: ticket.executionId, ...sessionBinding(ticket), sessionId: ticket.sessionId, executionGeneration: "1", controllerInstanceId: ticket.controllerInstanceId, controllerProcess: null });
  const operation = JSON.stringify({ operationId: ticket.initialOperationId, kind: "initial", state: "unknown", payload: { text: "original" } });
  db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot,last_sequence) VALUES(1,?,?,?,3)").run("old-ticket", owner, snapshot);
  db.prepare("INSERT INTO operations(id,value) VALUES(?,?)").run(ticket.initialOperationId, operation);
  db.prepare("INSERT INTO outbox(sequence,value) VALUES(3,?)").run('{ "kind": "state", "payload": { "original": true } }');
  db.pragma(`user_version=${version}`); db.close();
  return { snapshot, operation };
};

test.each([1, 2, 3, 4])("readonly helpers upgrade journal v%s without claiming or rewriting execution evidence", async version => {
  const f = await fixture(), original = historical(f.file, version, f.ticket);
  expect(readControllerOperation(f.file, f.ticket.initialOperationId)).toMatchObject({ state: "unknown", payload: { text: "original" } });
  expect(readControllerSnapshot(f.file)).toMatchObject({ executionId: f.ticket.executionId });
  const db = new Database(f.file, { readonly: true });
  try {
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    expect(db.prepare("SELECT owner_pid,snapshot,ticket_hash,last_sequence,last_acknowledged,source_floor,projection_gap FROM execution").get()).toEqual({ owner_pid: null, snapshot: original.snapshot, ticket_hash: "old-ticket", last_sequence: 3, last_acknowledged: 0, source_floor: 0, projection_gap: null });
    expect(db.prepare("SELECT value,acknowledged FROM operations").get()).toEqual({ value: original.operation, acknowledged: 0 });
    expect(db.prepare("SELECT value FROM outbox").get()).toEqual({ value: '{ "kind": "state", "payload": { "original": true } }' });
    expect(db.prepare("SELECT count(*) AS total FROM resources").get()).toEqual({ total: 0 });
  } finally { db.close(); }
});

test("an active old journal writer blocks DDL while current-format reads stay available", async () => {
  const f = await fixture(); historical(f.file, 2, f.ticket, process.pid);
  expect(() => readControllerSnapshot(f.file)).toThrow("upgrade-blocked");
  const db = new Database(f.file);
  expect(db.pragma("user_version", { simple: true })).toBe(2);
  expect((db.pragma("table_info(execution)") as { name: string }[]).map(row => row.name)).not.toContain("projection_gap");
  db.close();
  const current = await fixture(); const store = openControllerLifecycleStore(current.file, current.ticket, { onMigration: () => {} });
  const writer = new Database(current.file);
  try {
    writer.exec("BEGIN IMMEDIATE"); writer.prepare("UPDATE execution SET snapshot=?").run('{"uncommitted":true}');
    expect(readControllerSnapshot(current.file)).toMatchObject({ executionId: current.ticket.executionId });
    expect(writer.prepare("SELECT owner_pid FROM execution").get()).toEqual({ owner_pid: process.pid });
  } finally { writer.exec("ROLLBACK"); writer.close(); store.close(); }
});

test("startup admission failure rolls back the complete preceding migration", async () => {
  const f = await fixture(), original = historical(f.file, 1, f.ticket);
  expect(() => openControllerLifecycleStore(f.file, { ...f.ticket, executionId: randomUUID() }, { onMigration: () => {} })).toThrow("another execution");
  const db = new Database(f.file);
  try {
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(db.prepare("SELECT snapshot,owner_pid FROM execution").get()).toEqual({ snapshot: original.snapshot, owner_pid: null });
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='projection'").get()).toBeUndefined();
  } finally { db.close(); }
});

test.each(["snapshot", "operation", "writer"] as const)("%s resets an unknown unversioned journal through its normal entrypoint", async entrypoint => {
  const f = await fixture(), db = new Database(f.file);
  db.exec("CREATE TABLE original_data(value TEXT); INSERT INTO original_data VALUES ('discarded')"); db.close();
  if (entrypoint === "snapshot") expect(readControllerSnapshot(f.file)).toBeNull();
  else if (entrypoint === "operation") expect(readControllerOperation(f.file, f.ticket.initialOperationId)).toBeNull();
  else {
    const store = openControllerLifecycleStore(f.file, f.ticket, { onMigration: () => {} });
    try { expect(store.getSnapshot().executionId).toBe(f.ticket.executionId); expect(store.appendEvent({ text: "new" }).sequence).toBe("1"); }
    finally { store.close(); }
  }
  const check = new Database(f.file);
  try {
    expect(check.pragma("user_version", { simple: true })).toBe(5);
    expect(check.prepare("SELECT name FROM sqlite_schema WHERE name='original_data'").get()).toBeUndefined();
    expect(check.prepare("SELECT count(*) AS total FROM resources").get()).toEqual({ total: 0 });
  } finally { check.close(); }
});

test.each([null, 2_000_000_000])("unversioned journals discard historical evidence after admitting owner %s", async owner => {
  const f = await fixture(); historical(f.file, 0, f.ticket, owner);
  expect(readControllerSnapshot(f.file)).toBeNull();
  expect(readControllerOperation(f.file, f.ticket.initialOperationId)).toBeNull();
  const check = new Database(f.file);
  try { expect(check.pragma("user_version", { simple: true })).toBe(5); expect(check.prepare("SELECT count(*) AS total FROM execution").get()).toEqual({ total: 0 }); }
  finally { check.close(); }
});

test.each(["active", "unknown"] as const)("an unversioned journal's %s owner blocks reset and preserves evidence", async owner => {
  const f = await fixture(), original = historical(f.file, 0, f.ticket, process.pid);
  if (owner === "unknown") vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Owner status is unavailable"), { code: "EPERM" }); });
  expect(() => readControllerSnapshot(f.file)).toThrow("upgrade-blocked");
  const check = new Database(f.file);
  try {
    expect(check.pragma("user_version", { simple: true })).toBe(0);
    expect(check.prepare("SELECT snapshot,owner_pid FROM execution").get()).toEqual({ snapshot: original.snapshot, owner_pid: process.pid });
    expect(check.prepare("SELECT value FROM operations").get()).toEqual({ value: original.operation });
  } finally { check.close(); }
});

test.each(["table", "view"] as const)("case-insensitive %s owner evidence blocks an unversioned journal reset", async kind => {
  const f = await fixture(), db = new Database(f.file);
  db.exec(kind === "table" ? "CREATE TABLE ExEcUtIoN(id INTEGER, owner_pid INTEGER, sentinel TEXT)" : "CREATE TABLE owner_evidence(id INTEGER, owner_pid INTEGER, sentinel TEXT); CREATE VIEW ExEcUtIoN AS SELECT * FROM owner_evidence");
  db.prepare(`INSERT INTO ${kind === "table" ? "ExEcUtIoN" : "owner_evidence"} VALUES(1,?, 'preserved')`).run(process.pid); db.close();
  expect(() => readControllerSnapshot(f.file)).toThrow("upgrade-blocked");
  const check = new Database(f.file);
  try { expect(check.pragma("user_version", { simple: true })).toBe(0); expect(check.prepare("SELECT owner_pid,sentinel FROM execution").get()).toEqual({ owner_pid: process.pid, sentinel: "preserved" }); }
  finally { check.close(); }
});

test.each(["id", "owner_pid"] as const)("missing %s owner metadata prevents unversioned reset", async column => {
  const f = await fixture(), db = new Database(f.file);
  db.exec(column === "id" ? "CREATE TABLE execution(owner_pid INTEGER, sentinel TEXT); INSERT INTO execution VALUES(NULL, 'preserved')" : "CREATE TABLE execution(id INTEGER, sentinel TEXT); INSERT INTO execution VALUES(1, 'preserved')"); db.close();
  expect(() => readControllerSnapshot(f.file)).toThrow();
  const check = new Database(f.file);
  try { expect(check.pragma("user_version", { simple: true })).toBe(0); expect(check.prepare("SELECT sentinel FROM execution").get()).toEqual({ sentinel: "preserved" }); }
  finally { check.close(); }
});

test.each([1, 6])("unknown nonzero journal version %s is rejected without migration", async version => {
  const f = await fixture(), db = new Database(f.file);
  db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('preserved')"); db.pragma(`user_version=${version}`); db.close();
  expect(() => readControllerSnapshot(f.file)).toThrow(version === 6 ? "unsupported-version" : "invalid-format");
  const check = new Database(f.file);
  try { expect(check.pragma("user_version", { simple: true })).toBe(version); expect(check.prepare("SELECT value FROM sentinel").get()).toEqual({ value: "preserved" }); }
  finally { check.close(); }
});

test("missing and invalid journal paths preserve their distinct read contracts", async () => {
  const f = await fixture(); expect(readControllerSnapshot(f.file)).toBeNull();
  expect(() => readControllerOperation(f.file, randomUUID())).toThrow("does not exist");
  const bad = path.join(f.file, "child.sqlite"); const db = new Database(f.file); db.exec("CREATE TABLE unexpected(id)"); db.close();
  expect(() => readControllerSnapshot(bad)).toThrow();
});

test("stopped-generation writing rejects a format change during asynchronous process proof", async () => {
  const f = await fixture(), store = openControllerLifecycleStore(f.file, f.ticket, { onMigration: () => {} });
  store.patchSnapshot({ controllerProcess: { pid: 987, parentPid: 1, processGroupId: 987, startedAt: "original", commandHash: "a".repeat(64) } }); store.close();
  proof.stopped.mockImplementationOnce(async () => { const changed = new Database(f.file); changed.pragma("user_version=6"); changed.close(); return true; });
  await expect(recordStoppedControllerGeneration(f.file, f.ticket)).rejects.toThrow("unsupported-version");
  const db = new Database(f.file); try { expect(JSON.parse((db.prepare("SELECT snapshot FROM execution").get() as { snapshot: string }).snapshot).nativeStopped).toBe(false); } finally { db.close(); }
});

test("journal.close refuses stale-version SQL while still closing its handle", async () => {
  const f = await fixture(), store = openControllerLifecycleStore(f.file, f.ticket, { onMigration: () => {} });
  const db = new Database(f.file); db.pragma("user_version=6");
  expect(() => store.close()).toThrow("unsupported-version");
  expect(db.prepare("SELECT owner_pid FROM execution").get()).toEqual({ owner_pid: process.pid });
  expect(() => store.getSnapshot()).toThrow(); db.close();
});

test("journal close keeps committed ownership removal distinct from a close failure", async () => {
  const f = await fixture(), store = openControllerLifecycleStore(f.file, f.ticket, { onMigration: () => {} }), originalClose = Database.prototype.close;
  let fail = true;
  const closing = vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
    if (this.name === f.file && fail) { fail = false; throw new Error("Injected close failure"); }
    return originalClose.call(this);
  });
  try {
    expect(() => store.close()).toThrow(expect.objectContaining({ kind: "cleanup-failed", outcome: "committed" }));
    const check = new Database(f.file); try { expect(check.prepare("SELECT owner_pid FROM execution").get()).toEqual({ owner_pid: null }); } finally { check.close(); }
    store.close(); expect(() => store.getSnapshot()).toThrow();
  } finally { closing.mockRestore(); }
});
