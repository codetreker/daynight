import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { readSqliteDatabase } from "../../../src/platform/sqlite-access.js";
import { InstanceLockHeldError } from "../../../src/platform/instance-lock.js";
import { SqliteAccessError } from "../../../src/platform/sqlite-error.js";
import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";
import { openTimelineStore } from "../../../src/commands/controller/content/timeline-store.js";
import { openResourceFiles } from "../../../src/commands/controller/content/resource-files.js";
import { CONTROLLER_METADATA_BYTES } from "../../../src/commands/controller/media/metadata-budget.js";
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
    openResourceFiles(f.file, f.ticket.sessionId);
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
    try { expect(readSqliteDatabase({ ...controllerJournalReadOptions(db), onMissing: () => -1 }, current => current.pragma("user_version", { simple: true }))).toBe(currentSqliteVersion(controllerJournalFormat)); }
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
    expect(db.open).toBe(true); expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat));
  } finally { db.close(); permit.release(); }
});

test("a fresh writer is prepared without committing a generation and accepts a separately leased native resume", async () => {
  const f = await fixture(), permit = acquireControllerStoragePermit(f.file);
  try {
    const ticket = { ...f.ticket, resumeNativeSessionId: randomUUID() };
    expect(prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "writer", ticket }, permit, () => {})).toEqual({ kind: "prepared", snapshot: null, legacyTimelineCleanupPending: false });
    const db = new Database(f.file, { readonly: true });
    try { expect(db.prepare("SELECT COUNT(*) AS count FROM execution").get()).toEqual({ count: 0 }); expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat)); }
    finally { db.close(); }
    assertControllerStoragePermit(permit, f.file);
  } finally { permit.release(); }
});

test("an empty execution cannot admit a later-generation writer", async () => {
  const f = await fixture(), permit = acquireControllerStoragePermit(f.file);
  try {
    let failure: unknown;
    try { prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "writer", ticket: { ...f.ticket, executionGeneration: "2" } }, permit, () => {}); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ kind: "migration-failed", outcome: "rolled-back", connectionClosed: true, cause: { cause: { message: "Controller storage requires the original first-generation ticket or stopped predecessor." } } });
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
    const db = new Database(f.file, { readonly: true }); try { expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat)); } finally { db.close(); }
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
  expect(readSqliteDatabase({ ...controllerJournalReadOptions(f.file), onMissing: () => -1, onMigration: () => {} }, db => db.pragma("user_version", { simple: true }))).toBe(currentSqliteVersion(controllerJournalFormat));
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


test("a real held gate with a close failure stays a cleanup error and retains its open connection", async () => {
  const f = await fixture(), permit = acquireControllerStoragePermit(f.file), leaked: Database.Database[] = [];
  const closeFailure = new Error("ownership gate close failed"), originalClose = Database.prototype.close;
  const close = vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
    if (this.name === f.file && leaked.length === 0) { leaked.push(this); throw closeFailure; }
    return originalClose.call(this);
  });
  try {
    let failure: unknown;
    try { acquireControllerStoragePermit(f.file); } catch (error) { failure = error; }
    expect(isControllerStorageLockHeld(failure)).toBe(false);
    expect(failure).toMatchObject({ cause: { errors: [expect.any(InstanceLockHeldError), closeFailure] } });
    expect(leaked).toHaveLength(1);
    expect(leaked[0]!.open).toBe(true);
    assertControllerStoragePermit(permit, f.file);
  } finally {
    close.mockRestore();
    for (const db of leaked) if (db.open) db.close();
    permit.release();
  }
});

test("pure wrapped busy aggregates stay retryable while independent cleanup failures stay visible", () => {
  const held = new InstanceLockHeldError(process.pid), wrapped = new Error("admission blocked", { cause: held });
  expect(isControllerStorageLockHeld(new AggregateError([held, wrapped], "both blocked", { cause: held }))).toBe(true);
  expect(isControllerStorageLockHeld(new Error("outer", { cause: new AggregateError([wrapped, held], "both blocked") }))).toBe(true);
  const cleanup = new SqliteAccessError("cleanup-failed", { database: "controller-journal", phase: "release" }, { cause: held, connectionClosed: false });
  expect(isControllerStorageLockHeld(cleanup)).toBe(false);
  expect(isControllerStorageLockHeld(new AggregateError([held, cleanup], "blocked and cleanup failed"))).toBe(false);
  expect(isControllerStorageLockHeld(new AggregateError([held, new Error("release failed")], "blocked and release failed"))).toBe(false);
});


const versionZeroSource = (file: string, variant: "owner-only" | "invalid-json", owner: number | null): void => {
  const db = new Database(file);
  try {
    db.exec(variant === "owner-only"
      ? "CREATE TABLE execution(id INTEGER PRIMARY KEY, owner_pid INTEGER)"
      : "CREATE TABLE execution(id INTEGER PRIMARY KEY, owner_pid INTEGER, snapshot TEXT, ticket_hash TEXT)");
    if (variant === "owner-only") db.prepare("INSERT INTO execution VALUES(1,?)").run(owner);
    else db.prepare("INSERT INTO execution VALUES(1,?,'discarded invalid { JSON','discarded ticket')").run(owner);
    db.exec("CREATE TABLE discarded(value TEXT); INSERT INTO discarded VALUES('original evidence')");
    db.pragma("user_version=0");
  } finally { db.close(); }
};

const versionZeroPreparationCases = (["writer", "upgrade-only"] as const).flatMap(mode => (["owner-only", "invalid-json"] as const).flatMap(variant => ([null, 2147483647] as const).map(owner => ({ mode, variant, owner }))));
test.each(versionZeroPreparationCases)("$mode resets version zero $variant after admitting owner $owner", async ({ mode, variant, owner }) => {
  const f = await fixture(); versionZeroSource(f.file, variant, owner);
  const permit = acquireControllerStoragePermit(f.file, undefined, { fileMustExist: true });
  try {
    const request = mode === "writer" ? { journalFile: f.file, stateDirectory: f.root, mode, ticket: f.ticket } : { journalFile: f.file, stateDirectory: f.root, mode };
    expect(prepareControllerStorage(request, permit, () => {})).toEqual({ kind: "prepared", snapshot: null, legacyTimelineCleanupPending: false });
    const db = new Database(f.file, { readonly: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat));
      expect(db.prepare("SELECT COUNT(*) AS count FROM execution").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='discarded'").get()).toBeUndefined();
      expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='input_message_origins'").get()).toBeDefined();
    } finally { db.close(); }
  } finally { permit.release(); }
});

const unsafeVersionZeroCases = (["writer", "upgrade-only"] as const).flatMap(mode => (["live", "unknown", "missing-id", "missing-owner"] as const).map(variant => ({ mode, variant })));
test.each(unsafeVersionZeroCases)("$mode retains version zero $variant owner evidence and schema", async ({ mode, variant }) => {
  const f = await fixture(), original = new Database(f.file);
  let schema: unknown, rows: unknown;
  try {
    if (variant === "missing-id") original.exec("CREATE TABLE execution(owner_pid INTEGER,sentinel TEXT); INSERT INTO execution VALUES(NULL,'owner evidence')");
    else if (variant === "missing-owner") original.exec("CREATE TABLE execution(id INTEGER,sentinel TEXT); INSERT INTO execution VALUES(1,'owner evidence')");
    else { original.exec("CREATE TABLE execution(id INTEGER,owner_pid INTEGER,sentinel TEXT)"); original.prepare("INSERT INTO execution VALUES(1,?,'owner evidence')").run(process.pid); }
    original.exec("CREATE TABLE discarded(value TEXT); INSERT INTO discarded VALUES('original evidence')");
    original.pragma("user_version=0");
    schema = original.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
    rows = original.prepare("SELECT * FROM execution").all();
  } finally { original.close(); }
  const permit = acquireControllerStoragePermit(f.file, undefined, { fileMustExist: true });
  if (variant === "unknown") vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("owner status unavailable"), { code: "EPERM" }); });
  try {
    const request = mode === "writer" ? { journalFile: f.file, stateDirectory: f.root, mode, ticket: f.ticket } : { journalFile: f.file, stateDirectory: f.root, mode };
    let failure: unknown;
    try { prepareControllerStorage(request, permit, () => {}); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ kind: "upgrade-blocked", outcome: "rolled-back", connectionClosed: true });
    const db = new Database(f.file, { readonly: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(0);
      expect(db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all()).toEqual(schema);
      expect(db.prepare("SELECT * FROM execution").all()).toEqual(rows);
      expect(db.prepare("SELECT value FROM discarded").get()).toEqual({ value: "original evidence" });
    } finally { db.close(); }
  } finally { permit.release(); }
});

test("version zero writer reset rolls back when retained pending content has no original execution", async () => {
  const f = await fixture(); versionZeroSource(f.file, "owner-only", null);
  const directory = `${f.file}.pending-content`, entry = { entryId: randomUUID(), entrySeq: "1", revision: "1", kind: "reasoning", text: "retained original" };
  await mkdir(path.join(directory, "entries"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, sessionId: f.ticket.sessionId }), { mode: 0o600 });
  const orphan = path.join(directory, "entries", `${randomUUID()}.json`), bytes = JSON.stringify(entry);
  await writeFile(orphan, bytes, { mode: 0o600 });
  const permit = acquireControllerStoragePermit(f.file, undefined, { fileMustExist: true });
  try {
    let failure: unknown;
    try { prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "writer", ticket: f.ticket }, permit, () => {}); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ kind: "migration-failed", outcome: "rolled-back", connectionClosed: true, cause: { cause: { message: "Pending archive source has no original controller execution." } } });
    const db = new Database(f.file, { readonly: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(0);
      expect(db.prepare("PRAGMA table_info(execution)").all().map(row => (row as { name: string }).name)).toEqual(["id", "owner_pid"]);
      expect(db.prepare("SELECT * FROM execution").get()).toEqual({ id: 1, owner_pid: null });
      expect(db.prepare("SELECT value FROM discarded").get()).toEqual({ value: "original evidence" });
    } finally { db.close(); }
    expect(await readFile(orphan, "utf8")).toBe(bytes);
  } finally { permit.release(); }
});


test("automatic v9 reading uses its original peak reservation above normal metadata capacity and leaves stopped maintenance pending", async () => {
  const f = await fixture(), db = new Database(f.file);
  const snapshot = { ...stoppedSnapshot(f.ticket), lifecycle: "stopping", nativeStopped: false, stoppedAt: null };
  const entry = { entryId: randomUUID(), entrySeq: "9007199254740993", revision: "3", kind: "reasoning", text: "original committed Ω body" };
  const body = JSON.stringify(entry), candidate = `${randomUUID()}.json`, orphan = `${randomUUID()}.json`;
  try {
    db.pragma("journal_mode=WAL");
    for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 9)) db.exec(step.sql);
    db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot) VALUES(1,?,NULL,?)").run(controllerPayloadHash(f.ticket), JSON.stringify(snapshot));
    db.prepare("INSERT INTO content_index VALUES(?,?,?,?,?,?,?)").run(entry.entryId, controllerPayloadHash(entry), entry.revision, entry.entrySeq, candidate, createHash("sha256").update(body).digest("hex"), Buffer.byteLength(body));
    db.pragma("user_version=9");
  } finally { db.close(); }
  openResourceFiles(f.file, f.ticket.sessionId);
  const directory = path.join(`${f.file}.pending-content`, "entries");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(directory, candidate), body, { mode: 0o600 });
  await writeFile(path.join(directory, orphan), "", { mode: 0o600 });
  await truncate(path.join(directory, orphan), CONTROLLER_METADATA_BYTES + 1048576);
  const actual = readSqliteDatabase({ ...controllerJournalReadOptions(f.file), onMissing: () => { throw new Error("Original journal disappeared."); }, onMigration: () => {} }, reader => {
    const timeline = openTimelineStore(reader, { assertWrite: () => { throw new Error("Read is not a writer."); } });
    return { entry: timeline.get(entry.entryId), totals: timeline.totals(), row: reader.prepare("SELECT snapshot,legacy_timeline_cleanup_pending AS pending FROM execution WHERE id=1").get() };
  });
  expect(actual).toEqual({ entry, totals: { entryCount: 1, byteLength: Buffer.byteLength(body), timelineBytes: 14 + Buffer.byteLength(body) }, row: { snapshot: JSON.stringify(snapshot), pending: 1 } });
  expect(await readFile(path.join(directory, candidate), "utf8")).toBe(body);
  expect((await stat(path.join(directory, orphan))).size).toBe(CONTROLLER_METADATA_BYTES + 1048576);
  await expect(stat(path.join(f.root, "storage.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  const permit = acquireControllerStoragePermit(f.file);
  try {
    expect(() => prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "stopped-maintenance", ticket: f.ticket }, permit, () => {})).toThrow(expect.objectContaining({ kind: "migration-failed", cause: expect.objectContaining({ cause: expect.objectContaining({ message: "Controller storage maintenance requires the original stopped generation." }) }) }));
    const current = new Database(f.file, { readonly: true });
    try { expect(current.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat)); expect(current.prepare("SELECT legacy_timeline_cleanup_pending AS pending FROM execution").get()).toEqual({ pending: 1 }); }
    finally { current.close(); }
  } finally { permit.release(); }
});
