import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readControllerOperation, readControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { sessionBinding } from "../../../src/session/protocol.js";

const journalVersion = currentSqliteVersion(controllerJournalFormat);
const databases: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const database of databases.splice(0)) if (database.open) database.close(); });
const fixture = () => {
  const home = path.resolve(import.meta.dirname, "../../../../../.tmp/journal-upgrades", randomUUID());
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "managed", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const database = createMemoryDatabase(); databases.push(database);
  return { home, file: database, ticket };
};
// Fixtures reproduce the shipped statements rather than calling the current
// format definition or removing columns from its latest schema.
const unversionedJournal = (db: Database.Database, ticket: ControllerLaunchTicket, owner: number | null) => {
  db.exec("CREATE TABLE execution (id INTEGER PRIMARY KEY CHECK(id=1), ticket_hash TEXT NOT NULL, owner_pid INTEGER, snapshot TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0); CREATE TABLE operations (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE outbox (sequence INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  const snapshot = JSON.stringify({ executionId: ticket.executionId, ...sessionBinding(ticket), sessionId: ticket.sessionId, executionGeneration: "1", controllerInstanceId: ticket.controllerInstanceId, controllerProcess: null });
  const operation = JSON.stringify({ operationId: ticket.initialOperationId, kind: "initial", state: "unknown", payload: { text: "original" } });
  db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot,last_sequence) VALUES(1,?,?,?,3)").run("old-ticket", owner, snapshot);
  db.prepare("INSERT INTO operations(id,value) VALUES(?,?)").run(ticket.initialOperationId, operation);
  db.prepare("INSERT INTO outbox(sequence,value) VALUES(3,?)").run('{ "kind": "state", "payload": { "original": true } }');
  db.pragma("user_version=0");
  return { snapshot, operation };
};

test.each([null, 2_000_000_000])("unversioned journals discard historical evidence after admitting owner %s", async owner => {
  const f = fixture(); unversionedJournal(f.file, f.ticket, owner);
  expect(readControllerSnapshot(f.file)).toBeNull();
  expect(readControllerOperation(f.file, f.ticket.initialOperationId)).toBeNull();
  const check = f.file;
  try { expect(check.pragma("user_version", { simple: true })).toBe(journalVersion); expect(check.prepare("SELECT count(*) AS total FROM execution").get()).toEqual({ total: 0 }); }
  finally { check.close(); }
});

test.each(["active", "unknown"] as const)("an unversioned journal's %s owner blocks reset and preserves evidence", async owner => {
  const f = fixture(), original = unversionedJournal(f.file, f.ticket, process.pid);
  if (owner === "unknown") vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Owner status is unavailable"), { code: "EPERM" }); });
  expect(() => readControllerSnapshot(f.file)).toThrow("upgrade-blocked");
  const check = f.file;
  try {
    expect(check.pragma("user_version", { simple: true })).toBe(0);
    expect(check.prepare("SELECT snapshot,owner_pid FROM execution").get()).toEqual({ snapshot: original.snapshot, owner_pid: process.pid });
    expect(check.prepare("SELECT value FROM operations").get()).toEqual({ value: original.operation });
  } finally { check.close(); }
});

test.each(["table", "view"] as const)("case-insensitive %s owner evidence blocks an unversioned journal reset", async kind => {
  const f = fixture(), db = f.file;
  db.exec(kind === "table" ? "CREATE TABLE ExEcUtIoN(id INTEGER, owner_pid INTEGER, sentinel TEXT)" : "CREATE TABLE owner_evidence(id INTEGER, owner_pid INTEGER, sentinel TEXT); CREATE VIEW ExEcUtIoN AS SELECT * FROM owner_evidence");
  db.prepare(`INSERT INTO ${kind === "table" ? "ExEcUtIoN" : "owner_evidence"} VALUES(1,?, 'preserved')`).run(process.pid);
  expect(() => readControllerSnapshot(f.file)).toThrow("upgrade-blocked");
  const check = f.file;
  try { expect(check.pragma("user_version", { simple: true })).toBe(0); expect(check.prepare("SELECT owner_pid,sentinel FROM execution").get()).toEqual({ owner_pid: process.pid, sentinel: "preserved" }); }
  finally { check.close(); }
});

test.each(["id", "owner_pid"] as const)("missing %s owner metadata prevents unversioned reset", async column => {
  const f = fixture(), db = f.file;
  db.exec(column === "id" ? "CREATE TABLE execution(owner_pid INTEGER, sentinel TEXT); INSERT INTO execution VALUES(NULL, 'preserved')" : "CREATE TABLE execution(id INTEGER, sentinel TEXT); INSERT INTO execution VALUES(1, 'preserved')");
  expect(() => readControllerSnapshot(f.file)).toThrow();
  const check = f.file;
  try { expect(check.pragma("user_version", { simple: true })).toBe(0); expect(check.prepare("SELECT sentinel FROM execution").get()).toEqual({ sentinel: "preserved" }); }
  finally { check.close(); }
});

test.each([1, journalVersion, journalVersion + 1])("unknown nonzero journal version %s is rejected without migration", async version => {
  const f = fixture(), db = f.file;
  db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('preserved')"); db.pragma(`user_version=${version}`);
  expect(() => readControllerSnapshot(f.file)).toThrow(version === journalVersion + 1 ? "unsupported-version" : "invalid-format");
  const check = f.file;
  try { expect(check.pragma("user_version", { simple: true })).toBe(version); expect(check.prepare("SELECT value FROM sentinel").get()).toEqual({ value: "preserved" }); }
  finally { check.close(); }
});
