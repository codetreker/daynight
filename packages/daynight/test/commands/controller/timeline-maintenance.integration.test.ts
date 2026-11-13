import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import { controllerJournalReadOptions, prepareControllerStorage } from "../../../src/commands/controller/storage-preparation.js";
import { maintainControllerTimeline, createTimelineMaintenanceReservation } from "../../../src/commands/controller/content/maintenance.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { type ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { sessionBinding, type TimelineEntry } from "../../../src/session/protocol.js";
import { controllerMetadataBudget, CONTROLLER_METADATA_BYTES } from "../../../src/commands/controller/media/metadata-budget.js";
import { ControllerMediaBudgetError, openMediaBudgetLedger } from "../../../src/commands/controller/media/budget-ledger.js";
import { openTimelineStore } from "../../../src/commands/controller/content/timeline-store.js";
import { assertControllerStorageCapacity } from "../../../src/commands/controller/storage-capacity.js";
import { SqliteAccessError } from "../../../src/platform/sqlite-error.js";
import { readSqliteDatabase, type SqliteMigrationEvent } from "../../../src/platform/sqlite-access.js";
import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";
import { openResourceFiles, retireLegacyTimelineReferences } from "../../../src/commands/controller/content/resource-files.js";
import { openSessionContent } from "../../../src/commands/controller/content/session-content.js";
import { syncDirectory } from "../../../src/platform/durable-json.js";
import { withStoppedControllerStorage } from "../../../src/commands/controller/stopped-storage.js";

vi.mock("node:fs", async importOriginal => { const original = await importOriginal<typeof import("node:fs")>(); return { ...original, unlinkSync: vi.fn(original.unlinkSync), fsyncSync: vi.fn(original.fsyncSync), rmdirSync: vi.fn(original.rmdirSync), renameSync: vi.fn(original.renameSync), existsSync: vi.fn(original.existsSync) }; });

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

const restoreMocks = (): void => {
  vi.restoreAllMocks();
  vi.mocked(fs.unlinkSync).mockImplementation(actualFs.unlinkSync);
  vi.mocked(fs.fsyncSync).mockImplementation(actualFs.fsyncSync);
  vi.mocked(fs.rmdirSync).mockImplementation(actualFs.rmdirSync);
  vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
  vi.mocked(fs.existsSync).mockImplementation(actualFs.existsSync);
};

const failureOf = (action: () => unknown): unknown => { try { action(); } catch (cause) { return cause; } throw new Error("Expected preparation to fail."); };
const roots: string[] = [];
afterEach(() => { restoreMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const fixture = (version: 7 | 9 = 9) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/timeline-maintenance");
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(base, "s-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: root, nativeHome: path.join(root, "native"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original input", resumeNativeSessionId: null, credentialFile: path.join(root, "grant.json"), ipcEndpoint: path.join(root, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const snapshot: ControllerSnapshot = { executionId: ticket.executionId, ...sessionBinding(ticket), sessionId: ticket.sessionId, executionGeneration: "1", controllerInstanceId: ticket.controllerInstanceId, lifecycle: "stopped", activity: "stopped", initialInputState: "confirmed", nativeSessionId: randomUUID(), nativeStopped: true, stoppedAt: new Date().toISOString(), controllerProcess: { pid: 12345, parentPid: 1, processGroupId: null, startedAt: new Date().toISOString(), commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` }, nativeProcesses: [], currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, error: null };
  snapshot.windowsJobStopProof = { version: 1, ticketHash: controllerPayloadHash(ticket), snapshotHash: controllerPayloadHash(snapshot) };
  const permit = acquireControllerStoragePermit(file);
  const db = new Database(file);
  const entry: TimelineEntry = { entryId: randomUUID(), entrySeq: "1", revision: "1", kind: "reasoning", text: "当前正文 Ω" };
  try {
    db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL"); db.pragma("wal_autocheckpoint=1000");
    for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= version)) db.exec(step.sql);
    db.pragma(`user_version=${version}`);
    db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot) VALUES(1,?,NULL,?)").run(controllerPayloadHash(ticket), JSON.stringify(snapshot));
    if (version === 9) {
      openResourceFiles(file, ticket.sessionId);
      const directory = path.join(`${file}.pending-content`, "entries"), name = `${randomUUID()}.json`, bytes = Buffer.from(JSON.stringify(entry));
      fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });
      db.prepare("INSERT INTO content_index VALUES(?,?,?,?,?,?,?)").run(entry.entryId, controllerPayloadHash(entry), entry.revision, entry.entrySeq, name, createHash("sha256").update(bytes).digest("hex"), bytes.length);
    } else {
      openResourceFiles(file, ticket.sessionId);
      const directory = path.join(`${file}.pending-content`, "timeline"), name = `${createHash("sha256").update(entry.entryId).digest("hex")}.json`;
      fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, name), JSON.stringify(entry), { mode: 0o600 });
      db.prepare("INSERT INTO content_index VALUES(?,?,?,?)").run(entry.entryId, controllerPayloadHash(entry), entry.revision, entry.entrySeq);
    }
  } finally { db.close(); }
  fs.mkdirSync(path.join(`${file}.pending-content`, "entries"), { recursive: true, mode: 0o700 });
  const old = path.join(`${file}.pending-content`, "entries", `${randomUUID()}.json`);
  fs.writeFileSync(old, "interrupted candidate", { mode: 0o600 });
  const request = { journalFile: file, stateDirectory: root, mode: "stopped-maintenance" as const, ticket };
  return { root, file, ticket, snapshot, permit, entry, old, request };
};
const upgrade = (f: ReturnType<typeof fixture>) => {
  expect(prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "upgrade-only" }, f.permit, () => {})).toMatchObject({ kind: "prepared", legacyTimelineCleanupPending: true });
  return new Database(f.file);
};
const marker = (db: Database.Database): number => (db.prepare("SELECT legacy_timeline_cleanup_pending AS pending FROM execution").get() as { pending: number }).pending;
const charge = (f: ReturnType<typeof fixture>): number => {
  const ledger = new Database(path.join(f.root, "controller", "media", "budget.sqlite"), { readonly: true });
  try { return (ledger.prepare("SELECT reserved_bytes AS bytes FROM allocations WHERE execution_id=?").get(f.ticket.executionId) as { bytes: number }).bytes; } finally { ledger.close(); }
};

const legacyIndexFixture = () => {
  const f = fixture(7), cached = openResourceFiles(f.file, f.ticket.sessionId), bytes = Buffer.from("retained legacy resource");
  const resource = { resourceId: randomUUID(), status: "available" as const, name: "retained.bin", mediaType: "application/octet-stream", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), error: null };
  cached.writeResource(resource, bytes); cached.pinResource(resource.resourceId, "retained-reference");
  const root = `${f.file}.pending-content`, resourceName = `${createHash("sha256").update(resource.resourceId).digest("hex")}.json`, entryName = `${createHash("sha256").update(f.entry.entryId).digest("hex")}.json`;
  const index = { entries: [entryName], resources: [resourceName] }, indexPath = path.join(root, "index.json"), legacyFile = path.join(root, "timeline", entryName);
  fs.writeFileSync(indexPath, JSON.stringify(index), { mode: 0o600 });
  const retainedPaths = [path.join(root, "manifest.json"), path.join(root, "resource-pins.json"), path.join(root, "resources", resourceName), path.join(root, "blobs", resourceName.replace(/\.json$/, ".bin"))];
  const retainedBytes = retainedPaths.map(file => fs.readFileSync(file));
  const assertRetained = () => { retainedPaths.forEach((file, i) => expect(fs.readFileSync(file)).toEqual(retainedBytes[i])); expect(JSON.parse(fs.readFileSync(indexPath, "utf8")).resources).toEqual(index.resources); };
  const reopen = (db: Database.Database) => openSessionContent(f.file, f.ticket.sessionId, db, { assertWrite: () => { throw new Error("Reopen is read-only."); }, read: action => db.inTransaction ? action() : db.transaction(action).deferred() });
  return { ...f, cached: openResourceFiles(f.file, f.ticket.sessionId), bytes, resource, index, indexPath, legacyFile, assertRetained, reopen };
};

test("supported nonempty legacy inventory retires into a fully reopenable SQL composition without changing resources", () => {
  const f = legacyIndexFixture(), lease = f.cached.acquireResource(f.resource.resourceId);
  let db = upgrade(f);
  try {
    expect(JSON.parse(fs.readFileSync(f.indexPath, "utf8"))).toEqual(f.index);
    expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toMatchObject({ kind: "prepared", legacyTimelineCleanupPending: false });
    db.close(); db = new Database(f.file);
    const reopened = f.reopen(db);
    expect(reopened.timeline.get(f.entry.entryId)).toEqual(f.entry);
    expect(reopened.resourceFiles.resources.get(f.resource.resourceId)).toEqual({ resource: f.resource, data: null });
    expect(() => reopened.resourceFiles.releaseResource(f.resource.resourceId)).toThrow("lease or reference");
    expect(lease.read("0", 524288)).toEqual(f.bytes); f.assertRetained();
    expect(JSON.parse(fs.readFileSync(f.indexPath, "utf8")).entries).toEqual([]);
    expect(fs.existsSync(f.legacyFile)).toBe(false); expect(marker(db)).toBe(0);
  } finally { lease.close(); db.close(); f.permit.release(); }
});

test.each(["rename", ...(process.platform === "win32" ? [] : ["directory-fsync"])] as const)("legacy inventory publication %s failure preserves every body and retries durably", fault => {
  const f = legacyIndexFixture(), db = upgrade(f), rename = actualFs.renameSync, fsync = actualFs.fsyncSync, unlink = actualFs.unlinkSync;
  let published = false;
  try {
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === f.indexPath && fault === "rename") throw new Error("legacy index publication failure");
      rename(from, to); if (to === f.indexPath) published = true;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (published && fault === "directory-fsync" && fs.fstatSync(fd).isDirectory()) throw new Error("legacy index directory publication failure");
      fsync(fd);
    });
    expect(() => maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toThrow(/legacy index/);
    expect(marker(db)).toBe(1); expect(fs.existsSync(f.legacyFile)).toBe(true); expect(fs.existsSync(f.old)).toBe(true);
    expect(JSON.parse(fs.readFileSync(f.indexPath, "utf8")).entries).toEqual(fault === "rename" ? f.index.entries : []);
    expect(charge(f)).toBeGreaterThan(controllerMetadataBudget(f.file, db).bytes()); f.assertRetained();
    restoreMocks();
    let republished = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (to === f.indexPath) republished = true; rename(from, to); });
    vi.spyOn(fs, "unlinkSync").mockImplementation(file => { if (file === f.legacyFile || file === f.old) expect(republished).toBe(true); return unlink(file); });
    expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toMatchObject({ kind: "prepared", legacyTimelineCleanupPending: false });
    expect(republished).toBe(true); expect(f.reopen(db).timeline.get(f.entry.entryId)).toEqual(f.entry); f.assertRetained();
  } finally { db.close(); f.permit.release(); }
});

test("interruption after legacy inventory publication retains recoverable files and pending state", () => {
  const f = legacyIndexFixture(), db = upgrade(f), unlink = actualFs.unlinkSync;
  try {
    let interrupted = false;
    vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
      if (!interrupted && (file === f.old || file === f.legacyFile || String(file).includes(`${path.sep}entries${path.sep}`))) {
        interrupted = true;
        expect(JSON.parse(fs.readFileSync(f.indexPath, "utf8"))).toEqual({ entries: [], resources: f.index.resources });
        throw new Error("interrupted after index publication");
      }
      unlink(file);
    });
    expect(() => maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toThrow(/interrupted after index/);
    expect(interrupted).toBe(true); expect(marker(db)).toBe(1); expect(fs.existsSync(f.legacyFile)).toBe(true); expect(fs.existsSync(f.old)).toBe(true);
    expect(f.reopen(db).timeline.get(f.entry.entryId)).toEqual(f.entry); f.assertRetained();
    restoreMocks(); expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toMatchObject({ kind: "prepared" });
    expect(f.reopen(db).timeline.get(f.entry.entryId)).toEqual(f.entry); f.assertRetained();
  } finally { db.close(); f.permit.release(); }
});

test("a cached resource owner cannot resurrect legacy references during later inventory writes or rollback", () => {
  const f = legacyIndexFixture(), db = upgrade(f), rename = actualFs.renameSync;
  const pending = { resourceId: randomUUID(), status: "pending" as const, name: "later.bin", mediaType: null, byteLength: null, sha256: null, error: null };
  try {
    expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toMatchObject({ kind: "prepared" });
    f.cached.saveResource({ resource: pending, data: null });
    const inventory = JSON.parse(fs.readFileSync(f.indexPath, "utf8"));
    expect(inventory.entries).toEqual([]); expect(inventory.resources).toContain(f.index.resources[0]); expect(inventory.resources).toHaveLength(2);
    let failed = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (!failed && to === f.indexPath) { failed = true; throw new Error("later inventory failure"); } rename(from, to); });
    expect(() => f.cached.releaseResource(pending.resourceId)).toThrow(/later inventory/);
    expect(JSON.parse(fs.readFileSync(f.indexPath, "utf8"))).toEqual(inventory);
    expect(f.cached.resources.has(pending.resourceId)).toBe(true);
    restoreMocks(); f.cached.releaseResource(pending.resourceId); f.assertRetained();
    expect(f.reopen(db).timeline.get(f.entry.entryId)).toEqual(f.entry);
  } finally { db.close(); f.permit.release(); }
});

test("a current SQL snapshot can finish opening across an already-barriered legacy inventory retirement", () => {
  const f = legacyIndexFixture(), db = upgrade(f), reader = new Database(f.file, { readonly: true }), exists = actualFs.existsSync;
  try {
    expect(db.pragma("wal_checkpoint(TRUNCATE)")).toEqual([{ busy: 0, log: 0, checkpointed: 0 }]);
    reader.exec("BEGIN DEFERRED"); reader.prepare("SELECT COUNT(*) FROM timeline_entries").get();
    let retired = false;
    vi.spyOn(fs, "existsSync").mockImplementation(file => {
      if (!retired && file === f.legacyFile) {
        retired = true;
        // The barrier precedes this new current-format snapshot; its file inventory can
        // still be captured immediately before the owner publishes retirement.
        retireLegacyTimelineReferences(f.file, f.ticket.sessionId);
        fs.unlinkSync(f.legacyFile); syncDirectory(path.dirname(f.legacyFile));
      }
      return exists(file);
    });
    const content = f.reopen(reader);
    expect(retired).toBe(true); expect(reader.inTransaction).toBe(true);
    expect(content.timeline.get(f.entry.entryId)).toEqual(f.entry);
    expect(content.resourceFiles.resources.get(f.resource.resourceId)).toEqual({ resource: f.resource, data: null });
    expect(marker(db)).toBe(1); f.assertRetained();
    reader.exec("COMMIT"); restoreMocks();
    expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toMatchObject({ kind: "prepared" });
    expect(f.reopen(db).timeline.get(f.entry.entryId)).toEqual(f.entry); f.assertRetained();
  } finally { if (reader.inTransaction) reader.exec("ROLLBACK"); reader.close(); db.close(); f.permit.release(); }
});

test("a changed inventory which still references a missing legacy body remains an incomplete source", () => {
  const f = legacyIndexFixture(), db = upgrade(f), exists = actualFs.existsSync;
  try {
    let changed = false;
    vi.spyOn(fs, "existsSync").mockImplementation(file => {
      if (!changed && file === f.legacyFile) {
        changed = true;
        fs.writeFileSync(f.indexPath, JSON.stringify(f.index) + "\n", { mode: 0o600 }); fs.unlinkSync(f.legacyFile);
      }
      return exists(file);
    });
    expect(() => f.reopen(db)).toThrow("Pending archive source is incomplete.");
    expect(changed).toBe(true); expect(marker(db)).toBe(1); f.assertRetained();
  } finally { db.close(); f.permit.release(); }
});

test("isolated upgrade preserves stopped evidence and original files, then real maintenance retires and compacts under an idle connection", () => {
  const f = fixture(), fragment = new Database(f.file);
  fragment.prepare("INSERT INTO outbox(sequence,value) VALUES(1,?)").run(JSON.stringify({ retained: "x".repeat(2 * 1048576) }));
  fragment.pragma("wal_checkpoint(TRUNCATE)"); fragment.prepare("DELETE FROM outbox WHERE sequence=1").run(); fragment.pragma("wal_checkpoint(TRUNCATE)"); fragment.close();
  const db = upgrade(f), idle = new Database(f.file, { readonly: true }), pragma = db.pragma.bind(db);
  idle.prepare("SELECT COUNT(*) FROM timeline_entries").get();
  let checkpoints = 0, sawUnshrunkMain = false;
  vi.spyOn(db, "pragma").mockImplementation((source, options) => {
    if (source === "wal_checkpoint(TRUNCATE)" && ++checkpoints === 3) {
      const pageBytes = Number(pragma("page_count", { simple: true })) * Number(pragma("page_size", { simple: true }));
      expect(fs.statSync(f.file).size).toBeGreaterThan(pageBytes); expect(fs.statSync(`${f.file}-wal`).size).toBeGreaterThan(0); sawUnshrunkMain = true;
    }
    return pragma(source, options);
  });
  try {
    expect(JSON.parse((db.prepare("SELECT snapshot FROM execution").get() as { snapshot: string }).snapshot)).toEqual(f.snapshot);
    expect(fs.existsSync(f.old)).toBe(true);
    const beforeCharge = charge(f), events: SqliteMigrationEvent[] = [];
    expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: event => { events.push(event); } })).toMatchObject({ kind: "prepared", legacyTimelineCleanupPending: false });
    expect(events.map(event => event.phase)).toContain("legacy-timeline-retirement"); expect(events.map(event => event.phase)).toContain("journal-compaction"); expect(events.map(event => event.phase)).toContain("storage-admission");
    const compacted = events.find(event => event.phase === "journal-compaction" && event.kind === "completed")!;
    expect(compacted.storage).toMatchObject({ executionId: f.ticket.executionId, sessionId: f.ticket.sessionId, claimId: f.ticket.claimId, generation: "1", role: "stopped-maintenance", roleResult: "admitted", entryCount: 1, byteLength: Buffer.byteLength(JSON.stringify(f.entry)), oldFileCount: 0, oldFileBytes: 0, freePageCount: 0, freePageBytes: 0, databaseBytes: expect.any(Number), walBytes: 0, shmBytes: expect.any(Number), preCheckpointBusy: 0, preCheckpointLogFrames: 0, preCheckpointedFrames: 0, preCheckpointRemainingFrames: 0, postCheckpointBusy: 0, postCheckpointLogFrames: 0, postCheckpointedFrames: 0, postCheckpointRemainingFrames: 0 });
    expect(events.find(event => event.phase === "journal-compaction" && event.kind === "started")!.storage!.freePageBytes).toBeGreaterThan(0);
    expect(sawUnshrunkMain).toBe(true); expect(marker(db)).toBe(0); expect(fs.existsSync(f.old)).toBe(false);
    expect(fs.readdirSync(path.join(`${f.file}.pending-content`, "entries"))).toEqual([]);
    expect(openTimelineStore(db, { assertWrite: () => { throw new Error("read only"); } }).get(f.entry.entryId)).toEqual(f.entry);
    expect(fs.statSync(f.file).size).toBe(Number(db.pragma("page_count", { simple: true })) * Number(db.pragma("page_size", { simple: true })));
    expect(charge(f)).toBe(144 * 1048576); expect(beforeCharge).toBeGreaterThan(fs.statSync(f.file).size);
    expect(() => acquireControllerStoragePermit(f.file)).toThrow();
  } finally { idle.close(); db.close(); f.permit.release(); }
});

test("a held v9 WAL snapshot prevents retirement and retains the absolute reservation until a reentrant retry", () => {
  const f = fixture(), reader = new Database(f.file, { readonly: true });
  reader.exec("BEGIN"); reader.prepare("SELECT * FROM content_index").all();
  const db = upgrade(f);
  try {
    const result = maintainControllerTimeline({ db, request: { ...f.request, deadline: Date.now() + 1000 }, storagePermit: f.permit, onMigration: () => {} });
    expect(result).toMatchObject({ kind: "waiting", reason: "reader_busy" });
    expect(marker(db)).toBe(1); expect(fs.existsSync(f.old)).toBe(true); expect(charge(f)).toBeGreaterThan(controllerMetadataBudget(f.file, db).bytes());
    expect(openTimelineStore(db, { assertWrite: () => {} }).get(f.entry.entryId)).toEqual(f.entry);
    reader.exec("ROLLBACK");
    expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toMatchObject({ kind: "prepared" });
    expect(marker(db)).toBe(0);
  } finally { reader.close(); db.close(); f.permit.release(); }
});

test("an incident source beyond the ordinary metadata ceiling imports using its own peak and settles after retirement", () => {
  const f = fixture();
  fs.truncateSync(f.old, CONTROLLER_METADATA_BYTES + 1048576);
  try {
    expect(prepareControllerStorage(f.request, f.permit, () => {})).toMatchObject({ kind: "prepared", legacyTimelineCleanupPending: false });
    expect(fs.existsSync(f.old)).toBe(false); expect(charge(f)).toBe(144 * 1048576);
  } finally { f.permit.release(); }
});

for (const kind of ["unknown", "symlink"]) test.skipIf(kind === "symlink" && process.platform === "win32")(`retirement preserves a ${kind} source and its pending state`, () => {
  const f = fixture(), db = upgrade(f), file = path.join(`${f.file}.pending-content`, "entries", kind === "unknown" ? "foreign.json" : `${randomUUID()}.json`);
  try {
    if (kind === "symlink") { fs.symlinkSync(f.old, file); } else fs.writeFileSync(file, "foreign", { mode: 0o600 });
    expect(() => maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toThrow(/unrecognized|unsafe|symbolic link/);
    expect(fs.existsSync(file)).toBe(true); expect(fs.existsSync(f.old)).toBe(true); expect(marker(db)).toBe(1);
  } finally { db.close(); f.permit.release(); }
});

test.each(["unlink", ...(process.platform === "win32" ? [] : ["fsync"]), "vacuum"])("%s failure exposes the committed phase and reentry completes without importing again", fault => {
  const f = fixture(), db = upgrade(f);
  try {
    const failure = new Error(`injected ${fault}`);
    if (fault === "unlink") vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => { throw failure; });
    else if (fault === "fsync") vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw failure; });
    else {
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation(source => { if (source === "VACUUM") throw failure; return exec(source); });
    }
    expect(() => maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat)); expect(marker(db)).toBe(1);
    expect(openTimelineStore(db, { assertWrite: () => {} }).get(f.entry.entryId)).toEqual(f.entry);
    restoreMocks();
    const fsync = vi.spyOn(fs, "fsyncSync");
    let persistedRetirement = false;
    expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: event => { if (event.phase === "journal-compaction" && event.kind === "started") { persistedRetirement = fsync.mock.calls.length > 0; } } })).toMatchObject({ kind: "prepared" });
    if (fault === "fsync") expect(persistedRetirement).toBe(true);
  } finally { db.close(); f.permit.release(); }
});

test.each(["busy", "failure"])("post-VACUUM checkpoint %s retains pending and reservation after the files have retired", fault => {
  const f = fixture(), db = upgrade(f), original = db.pragma.bind(db); let checkpoints = 0;
  try {
    vi.spyOn(db, "pragma").mockImplementation((source, options) => {
      if (source === "wal_checkpoint(TRUNCATE)" && ++checkpoints === 3) { if (fault === "busy") return [{ busy: 1, log: 12, checkpointed: 4 }]; throw new Error("injected post checkpoint"); }
      return original(source, options);
    });
    if (fault === "busy") expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toMatchObject({ kind: "waiting", reason: "reader_busy" });
    else expect(() => maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toThrow(/post checkpoint/);
    expect(marker(db)).toBe(1); expect(fs.existsSync(f.old)).toBe(false); expect(charge(f)).toBeGreaterThan(controllerMetadataBudget(f.file, db).bytes());
    restoreMocks(); expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toMatchObject({ kind: "prepared" });
  } finally { db.close(); f.permit.release(); }
});

test("an unknown successful marker COMMIT is read back and preserves the high reservation until a later settlement", () => {
  const f = fixture(), db = upgrade(f), exec = db.exec.bind(db); let intercept = true;
  try {
    vi.spyOn(db, "exec").mockImplementation(source => { const result = exec(source); if (source === "COMMIT" && intercept) { intercept = false; throw new Error("unknown successful commit"); } return result; });
    expect(() => maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toThrow(/unknown successful commit/);
    expect(marker(db)).toBe(0); expect(charge(f)).toBeGreaterThan(controllerMetadataBudget(f.file, db).bytes());
    restoreMocks(); expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toMatchObject({ kind: "prepared" }); expect(charge(f)).toBe(144 * 1048576);
  } finally { db.close(); f.permit.release(); }
});

test("a settlement refusal leaves the actual cleared marker and sufficient allocation for a later retry", () => {
  const f = fixture(), db = upgrade(f), reservation = createTimelineMaintenanceReservation(db, { ...f.request, storagePermit: f.permit });
  try {
    const original = reservation.settleNormalAdmission;
    reservation.settleNormalAdmission = () => { throw new ControllerMediaBudgetError("stateDirectory"); };
    expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, reservation, onMigration: () => {} })).toMatchObject({ kind: "waiting", reason: "physical_capacity" });
    expect(marker(db)).toBe(0); expect(charge(f)).toBeGreaterThan(controllerMetadataBudget(f.file, db).bytes());
    reservation.settleNormalAdmission = original;
    expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, reservation, onMigration: () => {} })).toMatchObject({ kind: "prepared" });
  } finally { db.close(); f.permit.release(); }
});

test.each(["maintenance", "preparation", "upgrade-only"] as const)("completed cleanup uses ordinary admission without an unused compaction peak through %s", entry => {
  const f = fixture(), db = upgrade(f);
  try {
    expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toMatchObject({ kind: "prepared" });
    expect(marker(db)).toBe(0);
    const space = fs.statfsSync(f.root, { bigint: true });
    vi.spyOn(fs, "statfsSync").mockReturnValue({ ...space, bsize: 1n, bavail: 536870913n });
    expect(() => assertControllerStorageCapacity(f.file, db, f.root, f.ticket.executionId)).not.toThrow();
    const result = entry === "maintenance"
      ? maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })
      : prepareControllerStorage(entry === "preparation" ? f.request : { journalFile: f.file, stateDirectory: f.root, mode: "upgrade-only" }, f.permit, () => {});
    expect(result).toMatchObject({ kind: "prepared", legacyTimelineCleanupPending: false });
    expect(charge(f)).toBe(144 * 1048576);
  } finally { db.close(); f.permit.release(); }
});

test.each(["maintenance", "preparation"] as const)("completed cleanup retains its allocation when actual old metadata fails ordinary admission through %s", entry => {
  const f = fixture(), db = upgrade(f);
  try {
    expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toMatchObject({ kind: "prepared" });
    const ledger = openMediaBudgetLedger(f.root, f.ticket.executionId);
    try { ledger.reserve(400 * 1048576); } finally { ledger.close(); }
    fs.writeFileSync(f.old, "retained source", { mode: 0o600 }); fs.truncateSync(f.old, CONTROLLER_METADATA_BYTES + 1048576);
    const before = charge(f), retainedBytes = controllerMetadataBudget(f.file, db).bytes();
    expect(retainedBytes).toBeGreaterThan(CONTROLLER_METADATA_BYTES);
    const result = entry === "maintenance"
      ? maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })
      : prepareControllerStorage(f.request, f.permit, () => {});
    expect(result).toMatchObject({ kind: "waiting", reason: "physical_capacity" });
    expect(marker(db)).toBe(0); expect(fs.existsSync(f.old)).toBe(true);
    expect(charge(f)).toBe(before); expect(charge(f)).toBeGreaterThan(retainedBytes);
  } finally { db.close(); f.permit.release(); }
});

test("upgrade-only preserves stopping evidence while exact stopped maintenance refuses it", () => {
  const f = fixture(), db = new Database(f.file);
  try {
    const snapshot = { ...f.snapshot, lifecycle: "stopping", nativeStopped: false, stoppedAt: null };
    db.prepare("UPDATE execution SET snapshot=?").run(JSON.stringify(snapshot)); db.close();
    expect(prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "upgrade-only" }, f.permit, () => {})).toMatchObject({ kind: "prepared", snapshot, legacyTimelineCleanupPending: true });
    expect(failureOf(() => prepareControllerStorage(f.request, f.permit, () => {}))).toMatchObject({ kind: "migration-failed", cause: { cause: { message: expect.stringMatching(/stopped generation/) } } });
    expect(fs.existsSync(f.old)).toBe(true);
  } finally { if (db.open) db.close(); f.permit.release(); }
});

test.each([false, true])("VACUUM restores the exact temporary environment after failure=%s", fail => {
  const f = fixture(), db = upgrade(f), exec = db.exec.bind(db);
  const names = ["SQLITE_TMPDIR", "TMPDIR", "TMP", "TEMP"] as const;
  const initial = names.map(name => ({ name, present: Object.hasOwn(process.env, name), value: process.env[name] }));
  delete process.env.SQLITE_TMPDIR; process.env.TMPDIR = f.root;
  const before = names.map(name => ({ name, present: Object.hasOwn(process.env, name), value: process.env[name] }));
  try {
    let sawScope = false;
    vi.spyOn(db, "exec").mockImplementation(source => {
      if (source === "VACUUM") { for (const name of names) expect(process.env[name]).toBe(`${f.file}.timeline-maintenance`); sawScope = true; if (fail) throw new Error("injected vacuum failure"); }
      return exec(source);
    });
    const action = () => maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} });
    if (fail) expect(action).toThrow(/injected vacuum/); else expect(action()).toMatchObject({ kind: "prepared" });
    expect(sawScope).toBe(true);
    expect(names.map(name => ({ name, present: Object.hasOwn(process.env, name), value: process.env[name] }))).toEqual(before);
    expect(fs.existsSync(`${f.file}.timeline-maintenance`)).toBe(false);
    expect(marker(db)).toBe(fail ? 1 : 0);
  } finally {
    for (const old of initial) { if (old.present) process.env[old.name] = old.value!; else delete process.env[old.name]; }
    db.close(); f.permit.release();
  }
});

test("temporary directory cleanup failure retains pending and can be completed in place", () => {
  const f = fixture(), db = upgrade(f);
  try {
    vi.spyOn(fs, "rmdirSync").mockImplementationOnce(() => { throw new Error("temporary cleanup failure"); });
    expect(() => maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toThrow(/temporary cleanup failure/);
    expect(marker(db)).toBe(1); expect(fs.existsSync(`${f.file}.timeline-maintenance`)).toBe(true);
    restoreMocks(); expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toMatchObject({ kind: "prepared" });
    expect(fs.existsSync(`${f.file}.timeline-maintenance`)).toBe(false);
  } finally { db.close(); f.permit.release(); }
});

test("reporter and failure-marker observation errors retain the actual operation failure", () => {
  const f = fixture(), db = upgrade(f), exec = db.exec.bind(db), prepare = db.prepare.bind(db); let markerReads = 0;
  try {
    const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    vi.spyOn(db, "exec").mockImplementation(source => { if (source === "VACUUM") throw new Error("actual vacuum failure"); return exec(source); });
    vi.spyOn(db, "prepare").mockImplementation(source => { if (source.startsWith("SELECT legacy_timeline_cleanup_pending") && ++markerReads > 1) throw new Error("marker observation failure"); return prepare(source); });
    expect(() => maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => { throw new Error("reporter failure"); } })).toThrow(/actual vacuum failure/);
    expect(warnings).toHaveBeenCalled();
  } finally { db.close(); f.permit.release(); }
});

test("unknown cleanup COMMIT with a failed readback preserves both errors and does not settle", () => {
  const f = fixture(), db = upgrade(f), exec = db.exec.bind(db), prepare = db.prepare.bind(db); let committed = false;
  const events: SqliteMigrationEvent[] = [];
  try {
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    vi.spyOn(db, "exec").mockImplementation(source => { const result = exec(source); if (source === "COMMIT") { committed = true; throw new Error("actual unknown commit"); } return result; });
    vi.spyOn(db, "prepare").mockImplementation(source => { if (committed && source.startsWith("SELECT legacy_timeline_cleanup_pending")) throw new Error("marker readback failure"); return prepare(source); });
    let failure: unknown;
    try { maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: event => { events.push(event); } }); } catch (cause) { failure = cause; }
    expect(failure).toBeInstanceOf(SqliteAccessError);
    expect(failure).toMatchObject({ outcome: "unknown", context: { phase: "timeline-cleanup-marker", fromVersion: currentSqliteVersion(controllerJournalFormat), toVersion: currentSqliteVersion(controllerJournalFormat) } });
    expect(((failure as Error).cause as AggregateError).errors.map(error => error.message)).toEqual(["actual unknown commit", "marker readback failure"]);
    expect(events.at(-1)).toMatchObject({ kind: "failed", phase: "storage-admission", outcome: "unknown", storage: { pending: "unknown" } });
    restoreMocks(); expect(marker(db)).toBe(0); expect(charge(f)).toBeGreaterThan(controllerMetadataBudget(f.file, db).bytes());
  } finally { db.close(); f.permit.release(); }
});

test("preparation close failure retains an unknown cleanup marker outcome after its readback fails", () => {
  const f = fixture(), db = upgrade(f); db.close();
  const exec = Database.prototype.exec, prepare = Database.prototype.prepare, close = Database.prototype.close;
  let committed = false;
  try {
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, source: string) {
      const clearing = this.name === f.file && source === "COMMIT" && (prepare.call(this, "SELECT legacy_timeline_cleanup_pending AS pending FROM execution WHERE id=1") as Database.Statement<[], { pending: number }>).get()!.pending === 0;
      const value = exec.call(this, source);
      if (clearing) { committed = true; throw new Error("actual unknown marker commit"); }
      return value;
    });
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, source: string) {
      if (committed && this.name === f.file && source.startsWith("SELECT legacy_timeline_cleanup_pending")) throw new Error("actual marker readback failure");
      return prepare.call(this, source);
    });
    vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
      const value = close.call(this);
      if (committed && this.name === f.file && !this.readonly) throw new Error("actual preparation close failure");
      return value;
    });
    let failure: unknown;
    try { prepareControllerStorage(f.request, f.permit, () => {}); } catch (cause) { failure = cause; }
    expect(failure).toBeInstanceOf(SqliteAccessError);
    expect(failure).toMatchObject({ kind: "cleanup-failed", outcome: "unknown", connectionClosed: true, context: { phase: "timeline-preparation-close" } });
    const causes = ((failure as Error).cause as AggregateError).errors;
    expect(causes[0]).toMatchObject({ outcome: "unknown", context: { phase: "timeline-cleanup-marker" } });
    expect(causes[1]).toMatchObject({ kind: "cleanup-failed", outcome: "unknown" });
    restoreMocks();
    const actual = new Database(f.file);
    try { expect(actual.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat)); expect(marker(actual)).toBe(0); expect(charge(f)).toBeGreaterThan(controllerMetadataBudget(f.file, actual).bytes()); }
    finally { actual.close(); }
    expect(prepareControllerStorage(f.request, f.permit, () => {})).toMatchObject({ kind: "prepared", legacyTimelineCleanupPending: false });
  } finally { restoreMocks(); f.permit.release(); }
});

test("actual occupation verification failure cannot clear pending or lower its reservation", () => {
  const f = fixture(), db = upgrade(f), pragma = db.pragma.bind(db); let checkpoints = 0;
  try {
    vi.spyOn(db, "pragma").mockImplementation((source, options) => {
      const result = pragma(source, options);
      if (source === "wal_checkpoint(TRUNCATE)" && ++checkpoints === 3) {
        const lstat = fs.lstatSync;
        vi.spyOn(fs, "lstatSync").mockImplementation((file, options) => { if (file === f.file) throw new Error("actual occupation failure"); return lstat(file, options); });
      }
      return result;
    });
    expect(() => maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toThrow(/actual occupation failure/);
    restoreMocks(); expect(marker(db)).toBe(1); expect(charge(f)).toBeGreaterThan(controllerMetadataBudget(f.file, db).bytes());
  } finally { db.close(); f.permit.release(); }
});

test("isolated preparation recognizes only a pure wrapped capacity refusal as waiting and retains v9 sources", () => {
  const f = fixture();
  try {
    const space = fs.statfsSync(f.root, { bigint: true });
    vi.spyOn(fs, "statfsSync").mockReturnValue({ ...space, bavail: 0n });
    expect(prepareControllerStorage(f.request, f.permit, () => {})).toMatchObject({ kind: "waiting", reason: "physical_capacity" });
    restoreMocks(); const db = new Database(f.file, { readonly: true });
    try { expect(db.pragma("user_version", { simple: true })).toBe(9); expect(fs.existsSync(f.old)).toBe(true); } finally { db.close(); }
  } finally { f.permit.release(); }
});

test("current v11 cannot adopt SQL rows or retained files without the original execution", () => {
  const f = fixture(), db = upgrade(f);
  try {
    db.prepare("DELETE FROM execution").run(); db.close();
    expect(failureOf(() => prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "upgrade-only" }, f.permit, () => {}))).toMatchObject({ kind: "migration-failed", cause: { cause: { message: expect.stringMatching(/no original/) } } });
    expect(fs.existsSync(f.old)).toBe(true);
  } finally { if (db.open) db.close(); f.permit.release(); }
});

test("a memory connection cannot authorize retirement from a different physical journal", () => {
  const f = fixture(), db = new Database(":memory:");
  try { expect(() => maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toThrow(/original idle connection/); expect(fs.existsSync(f.old)).toBe(true); }
  finally { db.close(); f.permit.release(); }
});

test("stopped archive storage preserves a held legacy reader and completes maintenance before invoking its action", () => {
  const f = fixture(), reader = new Database(f.file, { readonly: true });
  reader.exec("BEGIN"); reader.prepare("SELECT * FROM content_index").all(); f.permit.release();
  const pragma = Database.prototype.pragma;
  vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source, options) {
    return pragma.call(this, source.startsWith("busy_timeout =") ? "busy_timeout = 10" : source, options);
  });
  let invoked = false;
  const original = (db: Database.Database) => expect(JSON.parse((db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }).snapshot)).toEqual(f.snapshot);
  const action = () => withStoppedControllerStorage({ journalPath: f.file, stateDirectory: f.root, ticket: f.ticket, assertOriginal: original }, db => {
    invoked = true;
    expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(controllerJournalFormat)); expect(marker(db)).toBe(0); expect(fs.existsSync(f.old)).toBe(false);
    expect(openTimelineStore(db, { assertWrite: () => { throw new Error("Archive readback is read-only."); } }).get(f.entry.entryId)).toEqual(f.entry);
  });
  try {
    expect(failureOf(action)).toMatchObject({ reason: "reader_busy" }); expect(invoked).toBe(false); expect(fs.existsSync(f.old)).toBe(true);
    reader.exec("ROLLBACK"); action(); expect(invoked).toBe(true);
  } finally { reader.close(); f.permit.release(); }
});

test("completed stopped settlement retains its 8 MiB allowance while a replacement writer still waits for normal admission", () => {
  const f = fixture(), db = upgrade(f);
  expect(maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: () => {} })).toMatchObject({ kind: "prepared" });
  db.close(); f.permit.release();
  const retained = path.join(`${f.file}.pending-content`, "retained-metadata"); fs.writeFileSync(retained, "", { mode: 0o600 }); fs.truncateSync(retained, CONTROLLER_METADATA_BYTES + 1048576);
  expect(withStoppedControllerStorage({ journalPath: f.file, stateDirectory: f.root, ticket: f.ticket, assertOriginal: connection => expect(marker(connection)).toBe(0) }, connection => openTimelineStore(connection, { assertWrite: () => {} }).totals().entryCount)).toBe(1);
  const permit = acquireControllerStoragePermit(f.file);
  try {
    const ticket = { ...f.ticket, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "2", resumeNativeSessionId: f.snapshot.nativeSessionId };
    expect(prepareControllerStorage({ journalFile: f.file, stateDirectory: f.root, mode: "writer", ticket }, permit, () => {})).toMatchObject({ kind: "waiting", reason: "physical_capacity" });
    expect(fs.statSync(retained).size).toBe(CONTROLLER_METADATA_BYTES + 1048576);
  } finally { permit.release(); }
});

test("an empty current journal still reports a committed deadline failure after its preparation transaction", () => {
  const f = fixture(), directory = path.join(f.root, "empty-current"); fs.mkdirSync(directory, { mode: 0o700 });
  const file = path.join(directory, "journal.sqlite"), permit = acquireControllerStoragePermit(file);
  try {
    const ticket = { ...f.ticket, executionId: randomUUID(), sessionId: randomUUID() };
    expect(prepareControllerStorage({ journalFile: file, stateDirectory: f.root, mode: "writer", ticket }, permit, () => {})).toMatchObject({ kind: "prepared", snapshot: null });
    const now = Date.now(), exec = Database.prototype.exec; let expired = false, immediate = false;
    vi.spyOn(Date, "now").mockImplementation(() => now + (expired ? 100 : 0));
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, source) {
      const result = exec.call(this, source);
      if (this.name === file) {
        if (source.startsWith("BEGIN")) immediate = source === "BEGIN IMMEDIATE";
        if (source === "COMMIT" && immediate) expired = true;
      }
      return result;
    });
    const reporter = vi.fn<(event: SqliteMigrationEvent) => undefined>(() => { throw new Error("Current preparation must not report a migration."); });
    expect(failureOf(() => prepareControllerStorage({ journalFile: file, stateDirectory: f.root, mode: "upgrade-only", deadline: now + 50 }, permit, reporter))).toMatchObject({ kind: "migration-failed", outcome: "committed", connectionClosed: true, cause: { message: expect.stringMatching(/deadline/) } });
    expect(expired).toBe(true); expect(reporter).not.toHaveBeenCalled();
  } finally { permit.release(); f.permit.release(); }
});

test.each(["automatic-read", "stopped-storage"] as const)("%s emits the canonical journal migration stage through the existing production envelope", mode => {
  const f = fixture(); f.permit.release();
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); return true; });
  try {
    if (mode === "automatic-read") {
      expect(readSqliteDatabase({ ...controllerJournalReadOptions(f.file), onMissing: () => { throw new Error("Original source disappeared."); } }, db => openTimelineStore(db, { assertWrite: () => {} }).get(f.entry.entryId))).toEqual(f.entry);
    } else {
      withStoppedControllerStorage({ journalPath: f.file, stateDirectory: f.root, ticket: f.ticket, assertOriginal: db => expect(JSON.parse((db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }).snapshot)).toEqual(f.snapshot) }, db => expect(marker(db)).toBe(0));
    }
    const envelopes = writes.flatMap(text => text.split("\n").filter(Boolean).map(line => JSON.parse(line) as { kind: string; sqlite: SqliteMigrationEvent })).filter(item => item.sqlite?.file === f.file);
    const events = envelopes.map(item => item.sqlite), imported = events.filter(event => event.phase === "journal-migration");
    expect(imported.map(event => event.kind)).toEqual(["started", "completed"]);
    expect(envelopes.every(item => item.kind === `sqlite-migration-${item.sqlite.kind}`)).toBe(true);
    expect(imported[0]).toMatchObject({ fromVersion: 9, toVersion: currentSqliteVersion(controllerJournalFormat), outcome: "not-started", storage: { role: "upgrade-only", roleResult: "pending", sqlitePhase: "begin" } });
    expect(imported[1]).toMatchObject({ fromVersion: 9, toVersion: currentSqliteVersion(controllerJournalFormat), outcome: "committed", storage: { executionId: f.ticket.executionId, sessionId: f.ticket.sessionId, claimId: f.ticket.claimId, generation: "1", role: "upgrade-only", roleResult: "admitted", sqlitePhase: "commit", entryCount: 1, byteLength: Buffer.byteLength(JSON.stringify(f.entry)), databaseBytes: expect.any(Number), walBytes: expect.any(Number), freePageCount: expect.any(Number), freePageBytes: expect.any(Number), oldFileCount: 2, oldFileBytes: Buffer.byteLength(JSON.stringify(f.entry)) + Buffer.byteLength("interrupted candidate") } });
    if (mode === "stopped-storage") {
      expect(new Set(events.map(event => event.phase))).toEqual(new Set(["journal-migration", "legacy-timeline-retirement", "journal-compaction", "storage-admission"]));
      expect(events.at(-1)).toMatchObject({ phase: "storage-admission", kind: "completed", fromVersion: currentSqliteVersion(controllerJournalFormat), toVersion: currentSqliteVersion(controllerJournalFormat), storage: { admission: "settlement", role: "stopped-maintenance", roleResult: "admitted", executionId: f.ticket.executionId } });
    }
    const serialized = JSON.stringify(envelopes);
    expect(serialized).not.toContain(f.entry.kind === "reasoning" ? f.entry.text : "not-a-real-body"); expect(serialized).not.toContain(f.ticket.initialPrompt); expect(serialized).not.toContain(f.ticket.ipcSecret);
  } finally { f.permit.release(); }
});

test.each(["before-open", "after-open"] as const)("stopped settlement reports the actual version on %s failure", point => {
  const f = fixture(); f.permit.release();
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); return true; });
  if (point === "after-open") vi.mocked(fs.unlinkSync).mockImplementation(file => { if (String(file).startsWith(`${f.file}.pending-content`)) throw new Error("retirement failure"); return actualFs.unlinkSync(file); });
  expect(() => withStoppedControllerStorage({ journalPath: f.file, stateDirectory: f.root, ticket: f.ticket, assertOriginal: () => { if (point === "before-open") throw new Error("original refusal"); } }, () => { throw new Error("action must not run"); })).toThrow(point === "before-open" ? /original refusal/ : /retirement failure/);
  const events = writes.flatMap(text => text.split("\n").filter(Boolean).map(line => (JSON.parse(line) as { sqlite: SqliteMigrationEvent }).sqlite)).filter(event => event?.file === f.file);
  expect(events.at(-1)).toMatchObject({ kind: "failed", phase: "storage-admission", fromVersion: point === "before-open" ? 9 : currentSqliteVersion(controllerJournalFormat), toVersion: currentSqliteVersion(controllerJournalFormat), storage: { role: "stopped-maintenance", roleResult: "rejected" } });
  const db = new Database(f.file, { readonly: true });
  try { expect(db.pragma("user_version", { simple: true })).toBe(point === "before-open" ? 9 : currentSqliteVersion(controllerJournalFormat)); } finally { db.close(); }
});

test("an automatic upgrade's supplied reporter cannot override committed storage, and current reads remain reporter-free under a held writer permit", () => {
  const f = fixture(); f.permit.release();
  const events: SqliteMigrationEvent[] = [], warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const reporter = vi.fn<(event: SqliteMigrationEvent) => undefined>(event => { events.push(event); throw new Error("injected reporter failure"); });
  const read = () => readSqliteDatabase({ ...controllerJournalReadOptions(f.file, undefined, reporter), onMissing: () => { throw new Error("Original source disappeared."); } }, db => openTimelineStore(db, { assertWrite: () => {} }).get(f.entry.entryId));
  expect(read()).toEqual(f.entry); expect(events.map(event => event.phase)).toEqual(["journal-migration", "journal-migration"]); expect(events.at(-1)).toMatchObject({ kind: "completed", outcome: "committed", storage: { executionId: f.ticket.executionId } }); expect(warnings).toHaveBeenCalled();
  const permit = acquireControllerStoragePermit(f.file);
  try { reporter.mockClear(); expect(read()).toEqual(f.entry); expect(reporter).not.toHaveBeenCalled(); }
  finally { permit.release(); f.permit.release(); }
});

test("corrupt stored totals fail the real operation without leaking their value as a metric", () => {
  const f = fixture(), db = upgrade(f), events: SqliteMigrationEvent[] = [], secret = "private-stored-total-value";
  try {
    db.prepare("UPDATE timeline_totals SET byte_length=? WHERE id=1").run(secret);
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    expect(() => maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: event => { events.push(event); } })).toThrow(/totals are corrupt/);
    expect(events.at(-1)).toMatchObject({ kind: "failed", phase: "storage-admission", storage: { executionId: f.ticket.executionId, roleResult: "admitted" } });
    expect(events.at(-1)!.storage).not.toHaveProperty("byteLength"); expect(JSON.stringify(events)).not.toContain(secret);
  } finally { db.close(); f.permit.release(); }
});

test("an unresolved marker transaction reports its physical evidence without claiming uncommitted SQL statistics", () => {
  const f = fixture(), db = upgrade(f), exec = db.exec.bind(db), events: SqliteMigrationEvent[] = [];
  try {
    vi.spyOn(db, "exec").mockImplementation(source => { if (source === "COMMIT" || source === "ROLLBACK") throw new Error(`injected ${source} uncertainty`); return exec(source); });
    const failure = failureOf(() => maintainControllerTimeline({ db, request: f.request, storagePermit: f.permit, onMigration: event => { events.push(event); } }));
    expect(failure).toMatchObject({ kind: "cleanup-failed", outcome: "unknown", connectionClosed: false }); expect(db.inTransaction).toBe(true);
    const reported = events.at(-1)!;
    expect(reported).toMatchObject({ phase: "storage-admission", kind: "failed", outcome: "unknown", storage: { executionId: f.ticket.executionId, generation: "1", pending: "unknown", databaseBytes: expect.any(Number), walBytes: expect.any(Number) } });
    for (const name of ["entryCount", "byteLength", "timelineBytes", "pageCount", "freePageCount", "freePageBytes"]) expect(reported.storage).not.toHaveProperty(name);
    const observer = new Database(f.file, { readonly: true });
    try { expect(marker(observer)).toBe(1); } finally { observer.close(); }
  } finally { restoreMocks(); if (db.inTransaction) db.exec("ROLLBACK"); db.close(); f.permit.release(); }
});
