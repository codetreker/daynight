import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";
import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openControllerLifecycleStore, readControllerOperation, readControllerSnapshot, readCurrentControllerSnapshot, readProvenWindowsStoppedControllerGeneration, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openResourceFiles } from "../../../src/commands/controller/content/resource-files.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { sessionBinding } from "../../../src/session/protocol.js";

const journalVersion = currentSqliteVersion(controllerJournalFormat);
const proof = vi.hoisted(() => ({ stopped: vi.fn() }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ confirmControllerProcessesStopped: proof.stopped }));
const roots: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const fixturePlatforms = process.platform === "win32" ? ["host"] : ["host", "win32"];
const selectFixturePlatform = (value: string): void => { if (value === "win32") Object.defineProperty(process, "platform", { ...platform, value: "win32" }); };
const jobLease = {} as ControllerJobLease;
const recordFixtureStop = (file: string, ticket: ControllerLaunchTicket, deadline?: number) => process.platform === "win32"
  ? recordStoppedControllerGeneration(file, ticket, { stateDirectory: path.dirname(file), ...(deadline === undefined ? {} : { deadline }), jobLease })
  : recordStoppedControllerGeneration(file, ticket, { stateDirectory: path.dirname(file), ...(deadline === undefined ? {} : { deadline }) });
beforeEach(() => { proof.stopped.mockReset().mockResolvedValue(true); });
afterEach(async () => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/journal-upgrades"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "managed", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  return { home, file: path.join(home, "journal.sqlite"), ticket };
};

const currentStopFixture = async () => {
  const f = await fixture();
  const journal = openControllerLifecycleStore(f.file, f.ticket, { onMigration: () => {} });
  journal.patchSnapshot({ controllerProcess: { pid: 123, parentPid: 12, processGroupId: process.platform === "win32" ? null : 123, startedAt: "original", commandHash: "a".repeat(64), ...(process.platform === "win32" ? { jobObjectName: `Local\\Daynight-${f.ticket.launchId}` } : {}) } });
  journal.close();
  return f;
};

test.each(fixturePlatforms)("does not write stopped if complete proof consumes the stop deadline (%s)", async mode => {
  selectFixturePlatform(mode);
  const f = await currentStopFixture(), now = Date.now(), deadline = now + 100;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  proof.stopped.mockImplementationOnce(async () => { clock.mockReturnValue(deadline); return true; });
  await expect(recordFixtureStop(f.file, f.ticket, deadline)).rejects.toThrow(/deadline/);
  if (process.platform === "win32") expect(proof.stopped).toHaveBeenCalledWith(expect.anything(), [], deadline, jobLease);
  else expect(proof.stopped).toHaveBeenCalledWith(expect.anything(), [], deadline);
  expect(readControllerSnapshot(f.file)).toMatchObject({ nativeStopped: false, stoppedAt: null });
});

test.each(fixturePlatforms)("refreshes the SQLite busy timeout before starting the write transaction (%s)", async mode => {
  selectFixturePlatform(mode);
  const f = await currentStopFixture(), now = Date.now(), deadline = now + 100;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now), execute = Database.prototype.exec;
  let writeTimeout: unknown;
  proof.stopped.mockImplementationOnce(async () => { clock.mockReturnValue(now + 60); return true; });
  vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
    if (sql === "BEGIN IMMEDIATE") writeTimeout = this.pragma("busy_timeout", { simple: true });
    return execute.call(this, sql);
  });
  await recordFixtureStop(f.file, f.ticket, deadline);
  expect(writeTimeout).toBe(40);
});

test.each(fixturePlatforms)("does not begin a write transaction when timeout configuration exhausts the deadline (%s)", async mode => {
  selectFixturePlatform(mode);
  const f = await currentStopFixture(), now = Date.now(), deadline = now + 100;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now), pragma = Database.prototype.pragma, execute = vi.spyOn(Database.prototype, "exec");
  proof.stopped.mockImplementationOnce(async () => { clock.mockReturnValue(deadline - 1); return true; });
  vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source: string, options?: { simple?: boolean | undefined }) {
    const result = pragma.call(this, source, options);
    if (source === "busy_timeout = 1") clock.mockReturnValue(deadline);
    return result;
  });
  await expect(recordFixtureStop(f.file, f.ticket, deadline)).rejects.toThrow(/stop-deadline/);
  expect(execute.mock.calls.some(([sql]) => sql === "BEGIN IMMEDIATE")).toBe(false);
  expect(readControllerSnapshot(f.file)).toMatchObject({ nativeStopped: false, stoppedAt: null });
});

test.each(fixturePlatforms)("bounds an actual journal write lock and retains the original SQLite failure (%s)", async mode => {
  selectFixturePlatform(mode);
  const f = await currentStopFixture(), locked = new Database(f.file);
  locked.exec("BEGIN IMMEDIATE");
  try {
    const error = await recordFixtureStop(f.file, f.ticket, Date.now() + 200).catch(error => error);
    if (error.cause instanceof AggregateError) {
      expect(error).toMatchObject({ context: { phase: "stop-deadline" }, outcome: "not-started" });
      expect(error.cause.errors[0]).toMatchObject({ code: "SQLITE_BUSY" });
    } else expect(error).toMatchObject({ cause: { code: "SQLITE_BUSY" } });
    expect(readControllerSnapshot(f.file)).toMatchObject({ nativeStopped: false, stoppedAt: null });
  } finally { locked.exec("ROLLBACK"); locked.close(); }
});

test.each(fixturePlatforms)("reports a committed stop honestly when COMMIT crosses the deadline (%s)", async mode => {
  selectFixturePlatform(mode);
  const f = await currentStopFixture(), now = Date.now(), deadline = now + 100;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now), execute = Database.prototype.exec;
  vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
    const result = execute.call(this, sql);
    if (sql === "COMMIT") clock.mockReturnValue(deadline);
    return result;
  });
  const error = await recordFixtureStop(f.file, f.ticket, deadline).catch(error => error);
  expect(error).toMatchObject({ name: "SqliteAccessError", outcome: "committed", connectionClosed: true, context: { phase: "stop-deadline" } });
  expect(readControllerSnapshot(f.file)).toMatchObject({ nativeStopped: true, lifecycle: "stopped" });
});

const windowsStopFixture = async () => {
  const f = await fixture();
  const journal = openControllerLifecycleStore(f.file, f.ticket, { onMigration: () => {} });
  journal.patchSnapshot({ controllerProcess: { pid: 123, parentPid: 12, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${f.ticket.launchId}` } });
  journal.close();
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  return f;
};

test("atomically records a Windows lease stop proof and reuses it after reopening", async () => {
  const f = await windowsStopFixture(), deadline = Date.now() + 5000;
  const stopped = await recordStoppedControllerGeneration(f.file, f.ticket, { stateDirectory: f.home, deadline, jobLease });
  expect(stopped.windowsJobStopProof).toMatchObject({ version: 1, ticketHash: expect.stringMatching(/^[a-f0-9]{64}$/), snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(proof.stopped).toHaveBeenCalledExactlyOnceWith(stopped.controllerProcess, stopped.nativeProcesses, deadline, jobLease);
  const db = new Database(f.file, { readonly: true });
  expect(db.pragma("user_version", { simple: true })).toBe(journalVersion); db.close();
  expect(readProvenWindowsStoppedControllerGeneration(f.file, f.ticket)).toEqual(stopped);
  proof.stopped.mockClear();
  expect(await recordStoppedControllerGeneration(f.file, f.ticket, { stateDirectory: f.home })).toEqual(stopped);
  expect(proof.stopped).not.toHaveBeenCalled();
});

test("blocks legacy Windows stopped records without a lease proof", async () => {
  const f = await windowsStopFixture(), db = new Database(f.file);
  const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string };
  const nativeSessionId = randomUUID();
  db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...JSON.parse(row.snapshot), lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString(), nativeSessionId })); db.close();
  expect(() => readProvenWindowsStoppedControllerGeneration(f.file, f.ticket)).toThrow(/proof is unavailable/);
  await expect(recordStoppedControllerGeneration(f.file, f.ticket, { stateDirectory: f.home })).rejects.toThrow(/lease are unavailable/);
  expect(proof.stopped).not.toHaveBeenCalled();
  const next = { ...f.ticket, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "2", resumeNativeSessionId: nativeSessionId };
  expect(() => openControllerLifecycleStore(f.file, next, { onMigration: () => {} })).toThrow(/proof is unavailable/);
});

test.each(["snapshot", "marker", "ticket", "row ticket"])('blocks a Windows stopped proof with changed %s evidence', async field => {
  const f = await windowsStopFixture();
  await recordStoppedControllerGeneration(f.file, f.ticket, { stateDirectory: f.home, deadline: Date.now() + 5000, jobLease });
  const db = new Database(f.file), row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }, value = JSON.parse(row.snapshot);
  if (field === "snapshot") value.nativeProcesses = [{ pid: 456, parentPid: 123, processGroupId: null, startedAt: "other", commandHash: "b".repeat(64) }];
  if (field === "marker") value.windowsJobStopProof.snapshotHash = "b".repeat(64);
  db.prepare("UPDATE execution SET snapshot=?,ticket_hash=? WHERE id=1").run(JSON.stringify(value), field === "row ticket" ? "c".repeat(64) : value.windowsJobStopProof.ticketHash); db.close();
  const ticket = field === "ticket" ? { ...f.ticket, launchId: randomUUID() } : f.ticket;
  expect(() => readProvenWindowsStoppedControllerGeneration(f.file, ticket)).toThrow(/conflicts/);
  await expect(recordStoppedControllerGeneration(f.file, ticket, { stateDirectory: f.home })).rejects.toThrow(/conflicts/);
});

test("rejects a changed ticket hash between Windows stop observation and commit", async () => {
  const f = await windowsStopFixture();
  proof.stopped.mockImplementationOnce(async () => { const db = new Database(f.file); db.prepare("UPDATE execution SET ticket_hash=? WHERE id=1").run("b".repeat(64)); db.close(); return true; });
  await expect(recordStoppedControllerGeneration(f.file, f.ticket, { stateDirectory: f.home, deadline: Date.now() + 5000, jobLease })).rejects.toThrow(/state changed/);
  expect(readControllerSnapshot(f.file)).toMatchObject({ lifecycle: "starting", nativeStopped: false });
  expect(readControllerSnapshot(f.file)!.windowsJobStopProof).toBeUndefined();
});

test("rolls back both Windows stopped state and proof when the transaction fails", async () => {
  const f = await windowsStopFixture(), execute = Database.prototype.exec, failure = new Error("commit failed");
  proof.stopped.mockImplementationOnce(async () => {
    let writing = false;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql === "BEGIN IMMEDIATE") writing = true;
      if (writing && sql === "COMMIT") { writing = false; throw failure; }
      return execute.call(this, sql);
    });
    return true;
  });
  await expect(recordStoppedControllerGeneration(f.file, f.ticket, { stateDirectory: f.home, deadline: Date.now() + 5000, jobLease })).rejects.toThrow("commit failed");
  expect(readControllerSnapshot(f.file)).toMatchObject({ lifecycle: "starting", nativeStopped: false });
  expect(readControllerSnapshot(f.file)!.windowsJobStopProof).toBeUndefined();
});

test("reports a committed Windows proof when COMMIT crosses the deadline", async () => {
  const f = await windowsStopFixture(), now = Date.now(), deadline = now + 100, execute = Database.prototype.exec;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  proof.stopped.mockImplementationOnce(async () => {
    let writing = false;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql === "BEGIN IMMEDIATE") writing = true;
      const result = execute.call(this, sql);
      if (writing && sql === "COMMIT") { writing = false; clock.mockReturnValue(deadline); }
      return result;
    });
    return true;
  });
  const error = await recordStoppedControllerGeneration(f.file, f.ticket, { stateDirectory: f.home, deadline, jobLease }).catch(error => error);
  expect(error).toMatchObject({ name: "SqliteAccessError", outcome: "committed", connectionClosed: true, context: { phase: "stop-deadline" } });
  expect(readProvenWindowsStoppedControllerGeneration(f.file, f.ticket).windowsJobStopProof).toMatchObject({ version: 1 });
});

test("retains committed outcome and uncertain connection close at the deadline", async () => {
  const f = await windowsStopFixture(), now = Date.now(), deadline = now + 100, close = Database.prototype.close;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  let retained: Database.Database | undefined, closeSpy: ReturnType<typeof vi.spyOn> | undefined;
  proof.stopped.mockImplementationOnce(async () => {
    closeSpy = vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) { retained = this; clock.mockReturnValue(deadline); throw new Error("close failed"); });
    return true;
  });
  try {
    const error = await recordStoppedControllerGeneration(f.file, f.ticket, { stateDirectory: f.home, deadline, jobLease }).catch(error => error);
    expect(error).toMatchObject({ name: "SqliteAccessError", outcome: "committed", connectionClosed: false, context: { phase: "stop-deadline" } });
    expect(error.cause.errors[0]).toMatchObject({ context: { phase: "close" }, outcome: "committed", connectionClosed: false });
  } finally { closeSpy?.mockRestore(); if (retained) close.call(retained); }
  expect(readProvenWindowsStoppedControllerGeneration(f.file, f.ticket).windowsJobStopProof).toMatchObject({ version: 1 });
});

test("does not inherit a Windows stop proof into the next generation", async () => {
  const f = await windowsStopFixture(), db = new Database(f.file);
  const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string };
  const nativeSessionId = randomUUID();
  db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...JSON.parse(row.snapshot), nativeSessionId })); db.close();
  await recordStoppedControllerGeneration(f.file, f.ticket, { stateDirectory: f.home, deadline: Date.now() + 5000, jobLease });
  const next = { ...f.ticket, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "2", resumeNativeSessionId: nativeSessionId };
  const journal = openControllerLifecycleStore(f.file, next, { onMigration: () => {} });
  expect(journal.getSnapshot().windowsJobStopProof).toBeUndefined(); journal.close();
});
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

const legacyCandidateSource = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const db = new Database(f.file);
  const entry = { entryId: randomUUID(), entrySeq: "1", revision: "1", kind: "reasoning", text: "original execution history" }, body = JSON.stringify(entry), filename = `${randomUUID()}.json`;
  const snapshot = JSON.stringify({ executionId: f.ticket.executionId, ...sessionBinding(f.ticket), sessionId: f.ticket.sessionId, executionGeneration: "1", controllerInstanceId: f.ticket.controllerInstanceId, controllerProcess: null });
  try {
    for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 9)) db.exec(step.sql);
    db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot) VALUES(1,?,NULL,?)").run(controllerPayloadHash(f.ticket), snapshot);
    db.prepare("INSERT INTO content_index VALUES(?,?,?,?,?,?,?)").run(entry.entryId, controllerPayloadHash(entry), entry.revision, entry.entrySeq, filename, createHash("sha256").update(body).digest("hex"), Buffer.byteLength(body));
    db.pragma("user_version=9");
  } finally { db.close(); }
  openResourceFiles(f.file, f.ticket.sessionId);
  const directory = path.join(`${f.file}.pending-content`, "entries");
  await mkdir(directory, { mode: 0o700 }); await writeFile(path.join(directory, filename), body, { mode: 0o600 });
  return { snapshot, body, file: path.join(directory, filename) };
};

test("Windows stop-proof reads do not migrate an older journal", async () => {
  const f = await fixture(); historical(f.file, 1, f.ticket);
  expect(() => readProvenWindowsStoppedControllerGeneration(f.file, f.ticket)).toThrow(/current journal format/);
  const db = new Database(f.file, { readonly: true });
  expect(db.pragma("user_version", { simple: true })).toBe(1); db.close();
});

test("current controller snapshot verifies the full ticket without writing the current journal", async () => {
  const f = await currentStopFixture();
  const before = new Database(f.file, { readonly: true });
  const row = before.prepare("SELECT snapshot,ticket_hash FROM execution WHERE id=1").get();
  expect(before.pragma("user_version", { simple: true })).toBe(journalVersion); before.close();
  expect(readCurrentControllerSnapshot(f.file, f.ticket)).toMatchObject({ executionId: f.ticket.executionId });
  expect(() => readCurrentControllerSnapshot(f.file, { ...f.ticket, ipcSecret: "b".repeat(64) })).toThrow(/conflicts/);
  const after = new Database(f.file, { readonly: true });
  expect(after.prepare("SELECT snapshot,ticket_hash FROM execution WHERE id=1").get()).toEqual(row);
  expect(after.pragma("user_version", { simple: true })).toBe(journalVersion); after.close();
});

test("current controller snapshot rejects malformed retained process evidence and expired reads", async () => {
  const f = await currentStopFixture(), db = new Database(f.file);
  const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string };
  const value = JSON.parse(row.snapshot); value.nativeProcesses = [{ pid: 0 }];
  db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(value)); db.close();
  expect(() => readCurrentControllerSnapshot(f.file, f.ticket)).toThrow(/snapshot format/);
  expect(() => readCurrentControllerSnapshot(f.file, f.ticket, Date.now() - 1)).toThrow(/deadline/);
});

test("current controller snapshot rejects v8 without migrating it", async () => {
  const f = await currentStopFixture();
  const current = new Database(f.file, { readonly: true });
  const original = current.prepare("SELECT ticket_hash,owner_pid,snapshot FROM execution WHERE id=1").get() as { ticket_hash: string; owner_pid: number | null; snapshot: string };
  current.close(); await rm(f.file);
  const db = new Database(f.file);
  for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 8)) db.exec(step.sql);
  db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot) VALUES(1,?,?,?)").run(original.ticket_hash, original.owner_pid, original.snapshot);
  db.pragma("user_version=8"); db.close();
  expect(() => readCurrentControllerSnapshot(f.file, f.ticket)).toThrow(/current journal format/);
  const after = new Database(f.file, { readonly: true });
  expect(after.pragma("user_version", { simple: true })).toBe(8);
  expect(after.prepare("SELECT name FROM sqlite_schema WHERE name='input_message_origins'").get()).toBeUndefined(); after.close();
});

test.each([1, 2, 3, 4])("readonly helpers upgrade journal v%s without claiming or rewriting execution evidence", async version => {
  const f = await fixture(), original = historical(f.file, version, f.ticket);
  expect(readControllerOperation(f.file, f.ticket.initialOperationId)).toMatchObject({ state: "unknown", payload: { text: "original" } });
  expect(readControllerSnapshot(f.file)).toMatchObject({ executionId: f.ticket.executionId });
  const db = new Database(f.file, { readonly: true });
  try {
    expect(db.pragma("user_version", { simple: true })).toBe(journalVersion);
    expect(db.prepare("SELECT owner_pid,snapshot,ticket_hash,last_sequence,last_acknowledged,source_floor,projection_gap FROM execution").get()).toEqual({ owner_pid: null, snapshot: original.snapshot, ticket_hash: "old-ticket", last_sequence: 3, last_acknowledged: 0, source_floor: 0, projection_gap: null });
    expect(db.prepare("SELECT value,acknowledged FROM operations").get()).toEqual({ value: original.operation, acknowledged: 0 });
    expect(db.prepare("SELECT value FROM outbox").get()).toEqual({ value: '{ "kind": "state", "payload": { "original": true } }' });
    expect(db.prepare("SELECT count(*) AS total FROM timeline_entries").get()).toEqual({ total: 0 });
  } finally { db.close(); }
});

test.each(["UTF-8", "UTF-16le"] as const)("upgrades a nonempty v10 %s journal once and retains exact UTF-8 totals on reopen", async encoding => {
  const f = await fixture(), db = new Database(f.file);
  db.pragma(`encoding = '${encoding}'`);
  for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 10)) db.exec(step.sql);
  const snapshot = JSON.stringify({ executionId: f.ticket.executionId, ...sessionBinding(f.ticket), sessionId: f.ticket.sessionId, executionGeneration: "1", controllerInstanceId: f.ticket.controllerInstanceId, controllerProcess: null });
  const values = ['{"text":"中文😀"}', '{"text":"\\n\\\""}', '{"value":"再见"}'];
  db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot,last_sequence) VALUES(1,?,NULL,?,3)").run("old-ticket", snapshot);
  values.forEach((value, index) => db.prepare("INSERT INTO outbox(sequence,value) VALUES(?,?)").run(index + 1, value));
  db.pragma("user_version=10"); db.close();
  expect(readControllerSnapshot(f.file)).toMatchObject({ executionId: f.ticket.executionId });
  const check = new Database(f.file, { readonly: true });
  try {
    expect(check.pragma("user_version", { simple: true })).toBe(journalVersion);
    expect(String(check.pragma("encoding", { simple: true })).toLowerCase()).toBe(encoding.toLowerCase());
    expect(check.prepare("SELECT byte_length FROM outbox_totals WHERE id=1").get()).toEqual({ byte_length: values.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) });
    expect((check.prepare("SELECT value FROM outbox ORDER BY sequence").all() as { value: string }[]).map(row => row.value)).toEqual(values);
  } finally { check.close(); }
  const prepare = vi.spyOn(Database.prototype, "prepare");
  expect(readControllerSnapshot(f.file)).toMatchObject({ executionId: f.ticket.executionId });
  expect(prepare.mock.calls.some(([statement]) => /^SELECT value FROM outbox ORDER BY sequence$/i.test(statement))).toBe(false);
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
  expect(() => openControllerLifecycleStore(f.file, { ...f.ticket, executionId: randomUUID() }, { onMigration: () => {} })).toThrow(expect.objectContaining({ cause: expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining("another execution") }) }) }));
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
    expect(check.pragma("user_version", { simple: true })).toBe(journalVersion);
    expect(check.prepare("SELECT name FROM sqlite_schema WHERE name='original_data'").get()).toBeUndefined();
    expect(check.prepare("SELECT count(*) AS total FROM timeline_entries").get()).toEqual({ total: 0 });
  } finally { check.close(); }
});

test("current journal reads do not recreate or rewrite pending content files", async () => {
  const f = await fixture(), store = openControllerLifecycleStore(f.file, f.ticket, { onMigration: () => {} });
  store.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "text", text: "retained" }] });
  store.close();
  const index = `${f.file}.pending-content/index.json`, manifest = `${f.file}.pending-content/manifest.json`;
  const originalIndex = await readFile(index), originalStat = await stat(index);
  await rm(manifest);
  expect(readControllerSnapshot(f.file)).toMatchObject({ sessionId: f.ticket.sessionId });
  expect(readControllerOperation(f.file, f.ticket.initialOperationId)).toBeNull();
  expect(await readFile(index)).toEqual(originalIndex);
  expect((await stat(index)).mtimeMs).toBe(originalStat.mtimeMs);
  await expect(stat(manifest)).rejects.toMatchObject({ code: "ENOENT" });
  expect(() => openControllerLifecycleStore(f.file, f.ticket, { onMigration: () => {} })).toThrow("Pending archive source is missing");
});

test("unversioned reset preserves unrelated pending source and rejects a new session", async () => {
  const f = await fixture(), store = openControllerLifecycleStore(f.file, f.ticket, { onMigration: () => {} }); store.close();
  const manifest = `${f.file}.pending-content/manifest.json`, retained = await readFile(manifest);
  const evidence = `${f.file}.pending-content/evidence.txt`; await writeFile(evidence, "retained source");
  const db = new Database(f.file); db.pragma("user_version=0"); db.close();
  expect(() => openControllerLifecycleStore(f.file, { ...f.ticket, sessionId: randomUUID() }, { onMigration: () => {} })).toThrow(expect.objectContaining({ kind: "migration-failed", cause: expect.objectContaining({ cause: expect.objectContaining({ message: "Pending archive source has no original controller execution." }) }) }));
  expect(await readFile(manifest)).toEqual(retained);
  expect(await readFile(evidence, "utf8")).toBe("retained source");
  const check = new Database(f.file); try { expect(check.pragma("user_version", { simple: true })).toBe(0); } finally { check.close(); }
});

test.each([false, true])("unversioned reset preserves nonempty legacy history after read attempt=%s", async resetByRead => {
  const f = await fixture(), source = await legacyCandidateSource(f);
  const pending = `${f.file}.pending-content`, manifest = await readFile(`${pending}/manifest.json`);
  const database = new Database(f.file); database.pragma("user_version=0"); database.close();
  if (resetByRead) expect(() => readControllerSnapshot(f.file)).toThrow(expect.objectContaining({ kind: "migration-failed", cause: expect.objectContaining({ cause: expect.objectContaining({ message: "Pending archive source has no original controller execution." }) }) }));
  const next = { ...f.ticket, executionId: randomUUID(), claimId: randomUUID() };
  expect(() => openControllerLifecycleStore(f.file, next, { onMigration: () => {} })).toThrow(expect.objectContaining({ kind: "migration-failed", cause: expect.objectContaining({ cause: expect.objectContaining({ message: "Pending archive source has no original controller execution." }) }) }));
  expect(await readFile(`${pending}/manifest.json`)).toEqual(manifest);
  expect(await readFile(source.file, "utf8")).toBe(source.body);
  const check = new Database(f.file);
  try {
    expect(check.pragma("user_version", { simple: true })).toBe(0);
    expect(check.prepare("SELECT snapshot FROM execution").get()).toEqual({ snapshot: source.snapshot });
    expect(check.prepare("SELECT content_file FROM content_index").get()).toEqual({ content_file: path.basename(source.file) });
  } finally { check.close(); }
});

test("an ownerless legacy projection cannot be dropped by the file migration", async () => {
  const f = await fixture(); historical(f.file, 5, f.ticket);
  const db = new Database(f.file);
  db.exec("DELETE FROM execution; INSERT INTO projection VALUES('orphan','hash',1,'{}')"); db.close();
  expect(() => readControllerSnapshot(f.file)).toThrow("migration-failed");
  const check = new Database(f.file);
  try {
    expect(check.pragma("user_version", { simple: true })).toBe(5);
    expect(check.prepare("SELECT id FROM projection").get()).toEqual({ id: "orphan" });
  } finally { check.close(); }
});

test("missing and invalid journal paths preserve their distinct read contracts", async () => {
  const f = await fixture(); expect(readControllerSnapshot(f.file)).toBeNull();
  expect(() => readControllerOperation(f.file, randomUUID())).toThrow("does not exist");
  const bad = path.join(f.file, "child.sqlite"); const db = new Database(f.file); db.exec("CREATE TABLE unexpected(id)"); db.close();
  expect(() => readControllerSnapshot(bad)).toThrow();
});

test.each(fixturePlatforms)("stopped-generation writing rejects a format change during asynchronous process proof (%s)", async mode => {
  selectFixturePlatform(mode);
  const f = await fixture(), store = openControllerLifecycleStore(f.file, f.ticket, { onMigration: () => {} });
  store.patchSnapshot({ controllerProcess: { pid: 987, parentPid: 1, processGroupId: process.platform === "win32" ? null : 987, startedAt: "original", commandHash: "a".repeat(64), ...(process.platform === "win32" ? { jobObjectName: `Local\\Daynight-${f.ticket.launchId}` } : {}) } }); store.close();
  proof.stopped.mockImplementationOnce(async () => { const changed = new Database(f.file); changed.pragma(`user_version=${journalVersion + 1}`); changed.close(); return true; });
  await expect(recordFixtureStop(f.file, f.ticket)).rejects.toThrow("unsupported-version");
  const db = new Database(f.file); try { expect(JSON.parse((db.prepare("SELECT snapshot FROM execution").get() as { snapshot: string }).snapshot).nativeStopped).toBe(false); } finally { db.close(); }
});

test("journal.close refuses stale-version SQL while still closing its handle", async () => {
  const f = await fixture(), store = openControllerLifecycleStore(f.file, f.ticket, { onMigration: () => {} });
  const db = new Database(f.file); db.pragma(`user_version=${journalVersion + 1}`);
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


test("stop verification owns storage without holding a SQL transaction and rejects a changed owner PID", async () => {
  const f = await currentStopFixture();
  proof.stopped.mockImplementationOnce(async () => {
    expect(() => acquireControllerStoragePermit(f.file)).toThrow("Cannot acquire instance lock");
    const observer = new Database(f.file);
    try {
      observer.exec("BEGIN IMMEDIATE");
      observer.prepare("UPDATE execution SET owner_pid=? WHERE id=1").run(123456);
      observer.exec("COMMIT");
    } finally { observer.close(); }
    return true;
  });
  await expect(recordFixtureStop(f.file, f.ticket)).rejects.toThrow("state changed");
  expect(readControllerSnapshot(f.file)).toMatchObject({ nativeStopped: false, stoppedAt: null });
});
