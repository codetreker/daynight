import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { readSqliteDatabase } from "../../../src/platform/sqlite-access.js";
import { SqliteAccessError } from "../../../src/platform/sqlite-error.js";
import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { acquireControllerStoragePermit, assertControllerStoragePermit, controllerStorageConnectionIsOpen, isControllerStorageLockHeld } from "../../../src/commands/controller/storage-lock.js";
import { controllerJournalReadOptions, prepareControllerStorage } from "../../../src/commands/controller/storage-preparation.js";
import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { sessionBinding } from "../../../src/session/protocol.js";
import { ControllerMediaBudgetError } from "../../../src/commands/controller/media/budget-ledger.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/storage-ownership");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "s-")); roots.push(root);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: root, nativeHome: path.join(root, "native"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original input", resumeNativeSessionId: null, credentialFile: path.join(root, "grant.json"), ipcEndpoint: path.join(root, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  return { root, file: path.join(root, "journal.sqlite"), ticket };
};
const stoppedSnapshot = (ticket: ControllerLaunchTicket) => ({ executionId: ticket.executionId, ...sessionBinding(ticket), sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "stopped", activity: "stopped", initialInputState: "confirmed", nativeSessionId: randomUUID(), nativeStopped: true, stoppedAt: new Date().toISOString(), controllerProcess: null, nativeProcesses: [], currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, error: null });
const initialize = (f: Awaited<ReturnType<typeof fixture>>, snapshot?: ReturnType<typeof stoppedSnapshot>, owner: number | null = null) => {
  const permit = acquireControllerStoragePermit(f.file);
  try {
    expect(prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "writer", ticket: f.ticket }, permit, () => {})).toMatchObject({ kind: "prepared", snapshot: null });
    const db = new Database(f.file);
    try { if (snapshot !== undefined) db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot) VALUES(1,?,?,?)").run(controllerPayloadHash(f.ticket), owner, JSON.stringify(snapshot)); }
    finally { db.close(); }
  } finally { permit.release(); }
};

test("storage permits exclude another writer, retain exact ownership, and reject forged or released reuse", async () => {
  const f = await fixture(), permit = acquireControllerStoragePermit(f.file);
  expect(() => acquireControllerStoragePermit(f.file)).toThrow();
  const busy = (() => { try { acquireControllerStoragePermit(f.file); } catch (error) { return error; } })();
  expect(isControllerStorageLockHeld(busy)).toBe(true);
  expect(() => assertControllerStoragePermit({ ...permit }, f.file)).toThrow(/invalid/);
  expect(() => assertControllerStoragePermit(permit, path.join(f.root, "other.sqlite"))).toThrow(/another/);
  if (process.platform !== "win32") expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  permit.release(); permit.release();
  expect(() => assertControllerStoragePermit(permit, f.file)).toThrow(/released/);
  const next = acquireControllerStoragePermit(f.file);
  expect(next.owner).not.toBe(permit.owner); next.release();
});

test.each(["EPERM", "malformed"])("unknown %s predecessor evidence is retained", async kind => {
  const f = await fixture(), lock = path.join(f.root, "storage.lock");
  const content = kind === "malformed" ? "incomplete" : JSON.stringify({ owner: randomUUID(), pid: 2147483647, startedAt: new Date().toISOString() });
  await writeFile(lock, content);
  if (kind === "EPERM") vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("unavailable"), { code: "EPERM" }); });
  expect(() => acquireControllerStoragePermit(f.file)).toThrow();
  expect(await readFile(lock, "utf8")).toBe(content);
});

test("an explicitly dead predecessor may be replaced without inheriting its process-stop proof", async () => {
  const f = await fixture(), lock = path.join(f.root, "storage.lock"), previous = randomUUID();
  await writeFile(lock, JSON.stringify({ owner: previous, pid: 2147483647, startedAt: new Date().toISOString() }));
  const permit = acquireControllerStoragePermit(f.file);
  expect(permit.owner).not.toBe(previous); permit.release();
});

test("current-schema reads do not reacquire the writer's storage lock or invoke a migration context", async () => {
  const f = await fixture(); initialize(f);
  const permit = acquireControllerStoragePermit(f.file);
  try {
    expect(readSqliteDatabase({ ...controllerJournalReadOptions(f.file), onMissing: () => -1 }, db => db.pragma("user_version", { simple: true }))).toBe(currentSqliteVersion(controllerJournalFormat));
    const db = new Database(f.file);
    try { expect(readSqliteDatabase({ ...controllerJournalReadOptions(db), onMissing: () => -1 }, current => current.pragma("user_version", { simple: true }))).toBe(9); }
    finally { db.close(); }
    assertControllerStoragePermit(permit, f.file);
  } finally { permit.release(); }
});

test("a borrowed outdated connection requires an explicit original migration permit", async () => {
  const f = await fixture(), permit = acquireControllerStoragePermit(f.file), db = new Database(f.file);
  try {
    expect(() => readSqliteDatabase({ ...controllerJournalReadOptions(db), onMissing: () => null }, () => null)).toThrow(/migration-failed/);
    expect(db.open).toBe(true); expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(readSqliteDatabase({ ...controllerJournalReadOptions(db, permit), onMissing: () => null }, () => "ready")).toBe("ready");
    expect(db.open).toBe(true); expect(db.pragma("user_version", { simple: true })).toBe(9);
  } finally { db.close(); permit.release(); }
});

test("a fresh writer is prepared without committing a generation and accepts a separately leased native resume", async () => {
  const f = await fixture(), permit = acquireControllerStoragePermit(f.file);
  try {
    const ticket = { ...f.ticket, resumeNativeSessionId: randomUUID() };
    expect(prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "writer", ticket }, permit, () => {})).toEqual({ kind: "prepared", snapshot: null, legacyTimelineCleanupPending: false });
    const db = new Database(f.file, { readonly: true });
    try { expect(db.prepare("SELECT COUNT(*) AS count FROM execution").get()).toEqual({ count: 0 }); expect(db.pragma("user_version", { simple: true })).toBe(9); }
    finally { db.close(); }
    assertControllerStoragePermit(permit, f.file);
  } finally { permit.release(); }
});

test("an empty execution cannot admit a later-generation writer", async () => {
  const f = await fixture(), permit = acquireControllerStoragePermit(f.file);
  try {
    expect(() => prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "writer", ticket: { ...f.ticket, executionGeneration: "2" } }, permit, () => {})).toThrow(/upgrade-blocked/);
    const db = new Database(f.file, { readonly: true }); try { expect(db.pragma("user_version", { simple: true })).toBe(0); } finally { db.close(); }
  } finally { permit.release(); }
});

test("upgrade-only preserves a stopping snapshot while maintenance refuses unproven stop", async () => {
  const f = await fixture(), snapshot = { ...stoppedSnapshot(f.ticket), lifecycle: "stopping", nativeStopped: false, stoppedAt: null };
  initialize(f, snapshot as unknown as ReturnType<typeof stoppedSnapshot>);
  const permit = acquireControllerStoragePermit(f.file);
  try {
    expect(prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "upgrade-only" }, permit)).toMatchObject({ kind: "prepared", snapshot });
    expect(() => prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "stopped-maintenance", ticket: f.ticket }, permit)).toThrow(/migration-failed/);
    const db = new Database(f.file, { readonly: true }); try { expect(JSON.parse((db.prepare("SELECT snapshot FROM execution").get() as { snapshot: string }).snapshot)).toEqual(snapshot); } finally { db.close(); }
  } finally { permit.release(); }
});

test.skipIf(process.platform === "win32")("writer preparation accepts only the exact stopped predecessor and keeps its durable generation", async () => {
  const f = await fixture(), snapshot = stoppedSnapshot(f.ticket); initialize(f, snapshot);
  const permit = acquireControllerStoragePermit(f.file);
  const next = { ...f.ticket, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "2", resumeNativeSessionId: snapshot.nativeSessionId };
  try {
    expect(prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "writer", ticket: next }, permit)).toMatchObject({ kind: "prepared", snapshot });
    expect(() => prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "writer", ticket: { ...next, executionGeneration: "3" } }, permit)).toThrow();
    expect(() => prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "writer", ticket: { ...next, resumeNativeSessionId: randomUUID() } }, permit)).toThrow();
    expect(() => prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "writer", ticket: f.ticket }, permit)).toThrow();
  } finally { permit.release(); }
});

test.each(["live", "unknown"])("a %s original owner blocks storage preparation even before it adopts a storage lock", async kind => {
  const f = await fixture(); initialize(f, stoppedSnapshot(f.ticket), process.pid);
  const permit = acquireControllerStoragePermit(f.file);
  if (kind === "unknown") vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("unavailable"), { code: "EPERM" }); });
  try { expect(() => prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "upgrade-only" }, permit)).toThrow(/migration-failed/); }
  finally { permit.release(); }
});

test("only typed capacity refusal becomes a waiting result and closes the local connection", async () => {
  const f = await fixture(); initialize(f);
  const permit = acquireControllerStoragePermit(f.file);
  try {
    // The persistent file uses actual stat bytes; a typed ledger refusal tests
    // admission without allocating a large physical fixture.
    const ledgerFile = path.join(f.root, "controller", "media", "budget.sqlite"), ledger = new Database(ledgerFile);
    try { ledger.prepare("INSERT INTO allocations VALUES(?,?)").run(randomUUID(), 8_589_934_592); }
    finally { ledger.close(); }
    const result = prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "writer", ticket: f.ticket }, permit);
    expect(result).toMatchObject({ kind: "waiting", reason: "physical_capacity" });
    if (result.kind === "waiting") {
      let cause: unknown = result.cause;
      while (cause instanceof Error && cause.cause !== undefined) cause = cause.cause;
      expect(cause).toBeInstanceOf(ControllerMediaBudgetError);
      expect(controllerStorageConnectionIsOpen(result.cause)).toBe(false);
    }
  } finally { permit.release(); }
});

test("the connection-state classifier trusts the outer SQLite cleanup result", () => {
  const open = new SqliteAccessError("cleanup-failed", { database: "controller-journal", phase: "close" }, { connectionClosed: false });
  const closed = new SqliteAccessError("migration-failed", { database: "controller-journal", phase: "prepare" }, { cause: open, connectionClosed: true, outcome: "unknown" });
  expect(controllerStorageConnectionIsOpen(open)).toBe(true);
  expect(controllerStorageConnectionIsOpen(closed)).toBe(false);
  expect(controllerStorageConnectionIsOpen(new AggregateError([new Error("primary"), open]))).toBe(true);
});

test("storage acquisition honors the same absolute cleanup deadline under a real SQLite writer", async () => {
  const f = await fixture(); initialize(f);
  const db = new Database(f.file); db.exec("BEGIN IMMEDIATE");
  const start = Date.now();
  try {
    expect(() => acquireControllerStoragePermit(f.file, start + 120)).toThrow();
    expect(Date.now() - start).toBeLessThan(1500);
    expect(() => assertControllerStoragePermit({ journalFile: f.file, owner: "unclaimed", release() {} }, f.file)).toThrow();
  } finally { db.exec("ROLLBACK"); db.close(); }
  const permit = acquireControllerStoragePermit(f.file); permit.release();
});

test("a deadline crossed after schema commit reports the committed outcome and closes its connection", async () => {
  const f = await fixture(), permit = acquireControllerStoragePermit(f.file), now = Date.now(), deadline = now + 1000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    let failure: unknown;
    try { prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "writer", ticket: f.ticket, deadline }, permit, event => { if (event.kind === "completed") clock.mockReturnValue(deadline); }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: "SqliteAccessError", outcome: "committed", connectionClosed: true });
    const db = new Database(f.file, { readonly: true }); try { expect(db.pragma("user_version", { simple: true })).toBe(9); } finally { db.close(); }
    expect(controllerStorageConnectionIsOpen(failure)).toBe(false);
  } finally { clock.mockRestore(); permit.release(); }
});

test("an automatic file upgrade acquires and releases its own permit while a busy old journal stays unchanged", async () => {
  const f = await fixture(), permit = acquireControllerStoragePermit(f.file), lockFile = path.join(f.root, "storage.lock");
  const owner = await readFile(lockFile, "utf8");
  expect(() => readSqliteDatabase({ ...controllerJournalReadOptions(f.file), onMissing: () => -1, onMigration: () => {} }, db => db.pragma("user_version", { simple: true }))).toThrow(/upgrade-blocked/);
  expect(await readFile(lockFile, "utf8")).toBe(owner);
  const old = new Database(f.file, { readonly: true }); try { expect(old.pragma("user_version", { simple: true })).toBe(0); } finally { old.close(); }
  permit.release();
  expect(readSqliteDatabase({ ...controllerJournalReadOptions(f.file), onMissing: () => -1, onMigration: () => {} }, db => db.pragma("user_version", { simple: true }))).toBe(9);
  await expect(readFile(lockFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("existing-only observation ownership preserves the absence of a journal and lock", async () => {
  const f = await fixture();
  expect(() => acquireControllerStoragePermit(f.file, undefined, { fileMustExist: true })).toThrow(/ENOENT/);
  await expect(stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(path.join(f.root, "storage.lock"))).rejects.toMatchObject({ code: "ENOENT" });
});


test.each([null, {}, [], { executionId: "invalid", sessionId: "invalid" }])("upgrade-only rejects corrupt current identity %j without rewriting its evidence", async value => {
  const f = await fixture(); initialize(f, stoppedSnapshot(f.ticket));
  const raw = new Database(f.file), original = JSON.stringify(value);
  try { raw.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(original); } finally { raw.close(); }
  const permit = acquireControllerStoragePermit(f.file);
  try {
    expect(() => prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "upgrade-only" }, permit)).toThrow(/migration-failed/);
    const db = new Database(f.file, { readonly: true });
    try { expect((db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }).snapshot).toBe(original); } finally { db.close(); }
  } finally { permit.release(); }
});


test("a proven live permit holder keeps gate contention retryable with the original SQLite cause", async () => {
  const f = await fixture(); initialize(f);
  const permit = acquireControllerStoragePermit(f.file), db = new Database(f.file);
  db.exec("BEGIN IMMEDIATE");
  try {
    let failure: unknown;
    try { acquireControllerStoragePermit(f.file, Date.now() + 100); } catch (error) { failure = error; }
    expect(isControllerStorageLockHeld(failure)).toBe(true);
    expect(failure).toMatchObject({ cause: { name: "InstanceLockHeldError", pid: process.pid, cause: { code: "SQLITE_BUSY" } } });
  } finally { db.exec("ROLLBACK"); db.close(); permit.release(); }
});

test.each(["missing", "malformed", "stale", "unknown"])("gate contention with %s ownership never becomes a live-lock wait", async kind => {
  const f = await fixture(); initialize(f);
  const lockFile = path.join(f.root, "storage.lock");
  const original = kind === "malformed" ? "invalid" : JSON.stringify({ owner: randomUUID(), pid: kind === "stale" ? 2147483647 : process.pid, startedAt: new Date().toISOString() });
  if (kind !== "missing") await writeFile(lockFile, original);
  const db = new Database(f.file); db.exec("BEGIN IMMEDIATE");
  if (kind === "unknown") vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("unavailable"), { code: "EPERM" }); });
  try {
    let failure: unknown;
    try { acquireControllerStoragePermit(f.file, Date.now() + 100); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(isControllerStorageLockHeld(failure)).toBe(false);
    if (kind === "missing") expect(failure).toMatchObject({ cause: { code: "SQLITE_BUSY" } });
    else expect(await readFile(lockFile, "utf8")).toBe(original);
  } finally { db.exec("ROLLBACK"); db.close(); }
});
