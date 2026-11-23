import { restoreControllerJournalVersion } from "../../helpers/controller-journal-version.js";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateLegacyBot, readMigratedBotHistory, readMigratedBotRecoveryBinding } from "../../../src/commands/worker/bots/migration.js";
import * as migrationFiles from "../../../src/commands/worker/bots/migration-files.js";
import { openLocalBotStores } from "../../../src/commands/worker/bots/local-store.js";
import { resolveBotPaths } from "../../../src/commands/worker/bots/paths.js";
import { createBotProcess } from "../../../src/commands/worker/bots/process.js";
import { acquireInstanceLockSync } from "../../../src/platform/instance-lock.js";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import { readCurrentControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { currentSqliteVersion, inspectSqlite, type SqliteFormat } from "../../../src/platform/sqlite-format.js";
import { cleanupMigrations, migrationFixture, recoveredAliasFixture, id, owner } from "./bot-migration.fixtures.js";

afterEach(cleanupMigrations);

const previousJournalFixture = async (version: 16 | 17 | 18 = 16) => {
  const fixture = await migrationFixture();
  const journal = fixture.openRaw(fixture.record.intent!.journalPath, false);
  restoreControllerJournalVersion(journal, version);
  expect(inspectSqlite(journal, controllerJournalFormat)).toEqual({ kind: "outdated", version });
  journal.close();
  return fixture;
};

describe("legacy Bot storage migration", () => {
  it.each([16, 17, 18] as const)("preserves checksummed v%i history and recovery copies with the v19 reader", async version => {
    const f = await previousJournalFixture(version), original = readFileSync(f.record.intent!.journalPath);
    expect(() => readCurrentControllerSnapshot(f.record.intent!.journalPath, f.ticket)).toThrow(/current journal format/);
    const manifest = await migrateLegacyBot(f.input), paths = resolveBotPaths(f.stateDirectory, f.botId);
    expect(readFileSync(f.record.intent!.journalPath)).toEqual(original);
    const copies = new Map(manifest.files.map(file => {
      const destination = path.join(paths.directory, file.destination);
      return [destination, readFileSync(destination)] as const;
    }));
    copies.set(path.join(paths.directory, "migration.json"), readFileSync(path.join(paths.directory, "migration.json")));
    rmSync(path.dirname(f.record.intent!.journalPath), { recursive: true });
    rmSync(f.record.intent!.ticketPath);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(readMigratedBotHistory(f.input)).toMatchObject({ snapshot: f.snapshot, entries: [{ ...f.entry, entrySeq: "1" }] });
      expect(readMigratedBotRecoveryBinding(f.input)).toEqual({
        sessionId: f.record.intent!.sessionId, testExecutionId: f.record.intent!.executionId, nativeSessionId: f.snapshot.nativeSessionId,
      });
      migrationFiles.verifyMigrationFiles(f.stateDirectory, manifest);
      for (const [file, bytes] of copies) expect(readFileSync(file), file).toEqual(bytes);
    }
    const copiedJournal = path.join(paths.directory, manifest.journal!);
    expect(() => readCurrentControllerSnapshot(copiedJournal, f.ticket)).toThrow(/current journal format/);
  });

  it.each(["future", "unversioned", "schema", "ticket"] as const)("refuses a protected v16 copy with invalid %s evidence", async conflict => {
    const f = await previousJournalFixture(), manifest = await migrateLegacyBot(f.input);
    const paths = resolveBotPaths(f.stateDirectory, f.botId), journal = path.join(paths.directory, manifest.journal!);
    const db = f.openRaw(journal, false);
    if (conflict === "future") db.pragma(`user_version=${currentSqliteVersion(controllerJournalFormat) + 1}`);
    else if (conflict === "unversioned") db.pragma("user_version=0");
    else if (conflict === "schema") db.exec("DROP TABLE timeline_entries");
    else db.prepare("UPDATE execution SET ticket_hash=? WHERE id=1").run("b".repeat(64));
    db.close();
    const altered = { ...manifest, files: manifest.files.map(file => file.destination === manifest.journal ? { ...file, ...migrationFiles.migrationFileDigest(journal) } : file) };
    writeFileSync(path.join(paths.directory, "migration.json"), JSON.stringify(altered), { mode: 0o600 });
    const bytes = readFileSync(journal);
    expect(() => readMigratedBotHistory(f.input)).toThrow();
    expect(() => readMigratedBotRecoveryBinding(f.input)).toThrow();
    expect(readFileSync(journal)).toEqual(bytes);
  });

  it("reads the native recovery binding from the verified copy after original Controller files disappear", async () => {
    const f = await migrationFixture();
    expect(f.record.intent!.nativeSessionId).toBeNull();
    const manifest = await migrateLegacyBot(f.input);
    rmSync(path.dirname(f.record.intent!.journalPath), { recursive: true });
    rmSync(f.record.intent!.ticketPath);
    expect(readMigratedBotRecoveryBinding(f.input)).toEqual({
      sessionId: f.record.intent!.sessionId, testExecutionId: f.record.intent!.executionId, nativeSessionId: f.snapshot.nativeSessionId,
    });
    expect(JSON.parse(readFileSync(path.join(resolveBotPaths(f.stateDirectory, f.botId).directory, "migration.json"), "utf8"))).toEqual(manifest);
  });

  it("retains an explicitly null native binding only for a proven unsubmitted migration without a journal", async () => {
    const f = await migrationFixture({ submitted: false, nativeSessionId: null });
    rmSync(f.record.intent!.journalPath);
    await migrateLegacyBot(f.input);
    expect(readMigratedBotRecoveryBinding(f.input)).toEqual({
      sessionId: f.record.intent!.sessionId, testExecutionId: f.record.intent!.executionId, nativeSessionId: null,
    });
  });

  it.each(["sessionId", "executionGeneration", "nativeSessionId"] as const)("rejects a copied recovery snapshot with conflicting %s", async field => {
    const f = await migrationFixture(), manifest = await migrateLegacyBot(f.input);
    const directory = resolveBotPaths(f.stateDirectory, f.botId).directory;
    const journal = path.join(directory, manifest.journal!);
    const db = f.openRaw(journal, false);
    db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...f.snapshot, [field]: field === "executionGeneration" ? "2" : id(99) }));
    db.close();
    const altered = { ...manifest, files: manifest.files.map(file => file.destination === manifest.journal ? { ...file, ...migrationFiles.migrationFileDigest(journal) } : file) };
    writeFileSync(path.join(directory, "migration.json"), JSON.stringify(altered), { mode: 0o600 });
    expect(() => readMigratedBotRecoveryBinding(f.input)).toThrow();
  });

  it("refuses a missing copied journal instead of falling back to the original Controller", async () => {
    const f = await migrationFixture(), manifest = await migrateLegacyBot(f.input);
    rmSync(path.join(resolveBotPaths(f.stateDirectory, f.botId).directory, manifest.journal!));
    expect(existsSync(f.record.intent!.journalPath)).toBe(true);
    expect(() => readMigratedBotRecoveryBinding(f.input)).toThrow();
  });

  it.each([null, "prepared", "copied"] as const)("preserves mixed alias ownership after legacy recovery (interrupted=%s)", async interrupted => {
    const f = await recoveredAliasFixture();
    const paths = resolveBotPaths(f.stateDirectory, f.botId);
    expect(f.record.intent!.executionGeneration).toBe("2");
    expect(f.record.intent!.journalPath.startsWith(paths.directory + path.sep)).toBe(false);
    expect(f.execution.aliasDirectory!.startsWith(paths.directory + path.sep)).toBe(true);
    expect(f.execution.retainedAliasDirectories).toEqual([path.join(f.stateDirectory, "agent-cli-aliases", "execution-original")]);
    if (interrupted !== null) await expect(migrateLegacyBot({ ...f.input, onPhase: phase => {
      if (phase === interrupted) throw new Error("mixed alias copy interrupted");
    } })).rejects.toThrow(/mixed alias copy interrupted/);
    const manifest = await migrateLegacyBot(f.input);
    const shared = manifest.files.find(file => file.source === path.join(f.execution.retainedAliasDirectories[0]!, "daynight.cmd"))!;
    const dedicated = manifest.files.find(file => file.source === path.join(f.execution.aliasDirectory!, "daynight.cmd"))!;
    expect(shared.destination).not.toBe(dedicated.destination);
    expect(readFileSync(path.join(paths.directory, shared.destination), "utf8")).toBe("original shared alias bytes");
    expect(readFileSync(path.join(paths.directory, dedicated.destination), "utf8")).toBe("recovered Bot-owned alias bytes");
    expect(manifest.original.record).toEqual(f.record);
    expect(manifest.original.execution).toEqual(f.execution);
    const history = readMigratedBotHistory(f.input);
    expect(history.snapshot?.executionGeneration).toBe("2");
    expect(history.snapshot?.nativeSessionId).toBe(id(20));
    expect(history.entries).toEqual([{ ...f.entry, entrySeq: "1" }]);
    expect(await migrateLegacyBot(f.input)).toEqual(manifest);
  });

  it("refuses an alias directory owned by a different Bot", async () => {
    const f = await migrationFixture();
    const foreign = path.join(resolveBotPaths(f.stateDirectory, id(99)).directory, "agent-cli-aliases", "execution-original");
    mkdirSync(foreign, { recursive: true, mode: 0o700 });
    const file = path.join(foreign, "daynight.cmd"); writeFileSync(file, "another Bot's alias", { mode: 0o600 });
    const raw = f.openRaw(f.legacyDatabaseFile, false);
    raw.prepare("UPDATE bot_executions SET record=? WHERE bot_id=?").run(JSON.stringify({ ...f.execution, aliasDirectory: foreign }), f.botId);
    await expect(migrateLegacyBot(f.input)).rejects.toThrow(/alias.*ownership/i);
    expect(readFileSync(file, "utf8")).toBe("another Bot's alias");
    expect(f.bots.get(owner, f.botId)).toEqual(f.record);
    expect(existsSync(resolveBotPaths(f.stateDirectory, f.botId).databaseFile)).toBe(false);
  });

  it("fences an older Bot reader before it can ignore migration responsibility", async () => {
    const f = await migrationFixture();
    await migrateLegacyBot(f.input);
    const db = f.openRaw(resolveBotPaths(f.stateDirectory, f.botId).databaseFile);
    const oldFormat: SqliteFormat = {
      name: "Bot state before migration support", baseline: { version: 1, create: () => { throw new Error("unexpected creation"); } },
      migrations: [], validateVersioned: () => { throw new Error("old schema validation must not run for a future version"); },
    };
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThan(1);
    try { inspectSqlite(db, oldFormat); throw new Error("old reader accepted migrated storage"); }
    catch (error) { expect(error).toMatchObject({ kind: "unsupported-version" }); }
  });

  it("preserves original identities, history and unknown operations in dedicated storage", async () => {
    const f = await migrationFixture();
    const ticketBytes = readFileSync(f.record.intent!.ticketPath);
    const resource = path.join(path.dirname(f.record.intent!.journalPath), "resource.bin");
    const resourceBytes = Buffer.from([0, 255, 17, 128]);
    writeFileSync(resource, resourceBytes, { mode: 0o600 });
    const unrelated = f.bots.observe(owner, { ...f.record.definition!, id: id(80), sessionId: null, testExecutionId: null }, 3);
    const result = await migrateLegacyBot(f.input);
    expect(result).toMatchObject({ phase: "committed", registration: "pending" });
    expect(f.confirmStopped).toHaveBeenCalled();
    const local = openLocalBotStores(f.input);
    try {
      const current = local.store.get(owner, f.botId)!;
      expect(current).toMatchObject({ ...f.record, migration: { state: "registration_pending" } });
      expect(local.executions.get(current)).toEqual(f.execution);
      expect(local.store.list(owner).map(record => record.botId)).toEqual([f.botId, unrelated.botId]);
      expect(local.store.get(owner, unrelated.botId)).toEqual(unrelated);
    } finally { local.close(); }
    const history = readMigratedBotHistory(f.input);
    expect(history.snapshot).toEqual(f.snapshot);
    expect(history.entries).toEqual([{ ...f.entry, entrySeq: "1" }]);
    expect(readFileSync(f.record.intent!.ticketPath)).toEqual(ticketBytes);
    const paths = resolveBotPaths(f.stateDirectory, f.botId);
    const journal = f.openRaw(path.join(paths.directory, result.journal!));
    const operation = journal.prepare("SELECT value FROM operations WHERE id=?").get(id(51)) as { value: string };
    expect(JSON.parse(operation.value)).toMatchObject({ operationId: id(51), state: "dispatching", payload: { text: "original unknown dispatch" } });
    expect(readFileSync(path.join(paths.directory, result.ticket!))).toEqual(ticketBytes);
    const copiedResource = result.files.find(file => file.source === resource)!;
    expect(readFileSync(path.join(paths.directory, copiedResource.destination))).toEqual(resourceBytes);
    const dedicated = f.openRaw(paths.databaseFile);
    expect(dedicated.prepare("SELECT bot_id FROM bots").all()).toEqual([{ bot_id: f.botId }]);
    expect(dedicated.prepare("SELECT name FROM sqlite_schema WHERE name='tasks'").get()).toBeUndefined();
  });

  it.each(["prepared", "copied", "verified", "committed"] as const)("resumes after a durable %s interruption without changing identities", async interruption => {
    const f = await migrationFixture();
    await expect(migrateLegacyBot({ ...f.input, onPhase: phase => {
      if (phase === interruption) throw new Error(`interrupted after ${phase}`);
    } })).rejects.toThrow(`interrupted after ${interruption}`);
    const result = await migrateLegacyBot(f.input);
    expect(result.phase).toBe("committed");
    const history = readMigratedBotHistory(f.input);
    expect(history.snapshot).toEqual(f.snapshot);
    expect(history.entries).toEqual([{ ...f.entry, entrySeq: "1" }]);
    expect(await migrateLegacyBot(f.input)).toEqual(result);
  });

  it("reopens a committed migration after ordinary inventory observations advance", async () => {
    const f = await migrationFixture(), committed = await migrateLegacyBot(f.input);
    const local = openLocalBotStores(f.input);
    try {
      const current = local.store.get(owner, f.botId)!;
      const updated = local.store.observe(owner, { ...current.observed, version: "3" }, 100);
      expect(updated.observed.version).toBe("3");
      expect(updated.observedAt).toBe(100);
      expect(updated.intent).toEqual(f.record.intent);
      expect(updated.migration).toEqual(current.migration);
    } finally { local.close(); }
    expect(await migrateLegacyBot(f.input)).toEqual(committed);
    expect(readMigratedBotHistory(f.input).entries).toEqual([{ ...f.entry, entrySeq: "1" }]);
    expect(f.confirmStopped).toHaveBeenCalledTimes(1);
  });

  it("refuses restored legacy rows after authority was committed to dedicated storage", async () => {
    const f = await migrationFixture();
    await migrateLegacyBot(f.input);
    const raw = f.openRaw(f.legacyDatabaseFile, false);
    raw.prepare("INSERT INTO bots VALUES(?,?,?,?,?)").run(owner.serverOrigin, owner.ownerUserId, owner.workerId, f.botId, JSON.stringify(f.record));
    await expect(migrateLegacyBot(f.input)).rejects.toThrow(/conflicts.*authority/);
    expect(raw.prepare("SELECT count(*) AS n FROM bots WHERE bot_id=?").get(f.botId)).toEqual({ n: 1 });
    expect(raw.prepare("SELECT count(*) AS n FROM bot_migrations WHERE bot_id=?").get(f.botId)).toEqual({ n: 1 });
  });

  it("resumes from the empty database left by an interrupted first identity insert", async () => {
    const f = await migrationFixture();
    const prepare = Database.prototype.prepare;
    let injected = false;
    const fault = vi.spyOn(Database.prototype, "prepare").mockImplementation(function(this: Database.Database, sql: string) {
      if (!injected && /^INSERT INTO bot_identity\b/.test(sql)) {
        injected = true;
        throw new Error("identity insert interrupted");
      }
      return prepare.call(this, sql);
    });
    try { await expect(migrateLegacyBot(f.input)).rejects.toThrow(); }
    finally { fault.mockRestore(); }
    expect(injected).toBe(true);
    const file = resolveBotPaths(f.stateDirectory, f.botId).databaseFile;
    expect(existsSync(file)).toBe(true);
    const remaining = f.openRaw(file);
    expect(remaining.pragma("user_version", { simple: true })).toBe(0);
    expect(remaining.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all()).toEqual([]);
    remaining.close();
    expect(f.bots.get(owner, f.botId)).toEqual(f.record);
    expect((await migrateLegacyBot(f.input)).phase).toBe("committed");
    expect(readMigratedBotHistory(f.input).entries).toEqual([{ ...f.entry, entrySeq: "1" }]);
  });

  it("includes committed WAL content while the main SQLite file still has an older snapshot", async () => {
    const f = await migrationFixture({ keepWal: true });
    expect(statSync(`${f.record.intent!.journalPath}-wal`).size).toBeGreaterThan(32);
    // The pinned reader began before history was inserted. Its old transaction
    // prevents checkpointing those committed pages into the main database.
    expect(f.pin!.prepare("SELECT count(*) AS count FROM timeline_entries").get()).toEqual({ count: 0 });
    await migrateLegacyBot(f.input);
    expect(readMigratedBotHistory(f.input).entries).toEqual([{ ...f.entry, entrySeq: "1" }]);
  });

  it("keeps migrated history discoverable after removal of public Worker and Controller storage", async () => {
    const f = await migrationFixture();
    await migrateLegacyBot(f.input);
    f.bots.close(); f.executions.close(); f.releaseWorker();
    rmSync(path.join(f.stateDirectory, "worker"), { recursive: true });
    rmSync(path.join(f.stateDirectory, "controller"), { recursive: true });
    const local = openLocalBotStores(f.input);
    try {
      expect(local.store.list(owner)).toMatchObject([{ botId: f.botId, migration: { state: "registration_pending" } }]);
      expect(readMigratedBotHistory(f.input).entries).toEqual([{ ...f.entry, entrySeq: "1" }]);
    } finally { local.close(); }
  });

  it("retains readable history when native session identity is missing without declaring recovery ready", async () => {
    const f = await migrationFixture({ nativeSessionId: null });
    const result = await migrateLegacyBot(f.input);
    expect(result).toMatchObject({ registration: "pending", nativeRecovery: "missing" });
    expect(readMigratedBotHistory(f.input)).toMatchObject({ snapshot: { nativeSessionId: null }, entries: [{ entryId: f.entry.entryId }] });
  });

  it.each([false, true])("never resumes a known native ID from an absent or empty native home (exists=%s)", async exists => {
    const f = await migrationFixture();
    if (exists) mkdirSync(f.ticket.nativeHome, { mode: 0o700 });
    const result = await migrateLegacyBot(f.input);
    expect(result.nativeRecovery).toBe(exists ? "unverified" : "missing");
    expect(readMigratedBotHistory(f.input).snapshot?.nativeSessionId).toBe(id(20));
    const local = openLocalBotStores(f.input);
    const launch = vi.fn(async () => { throw new Error("unexpected native launch"); });
    const grant = vi.fn(async () => { throw new Error("unexpected execution grant"); });
    const botProcess = createBotProcess({ homeDirectory: f.homeDirectory, packageDirectory: f.homeDirectory,
      store: local.store, executions: local.executions, recoveryLimit: 3, canAdmitNewExecution: () => true,
      sessionApi: { grant } as never, dependencies: { launch },
      jobLeases: { enabled: false, retainBirthCleanup: () => () => {}, cleanupBirth: async () => {}, adopt: () => { throw new Error("Unexpected native launch ownership in this fixture."); }, retain: async () => undefined, get: async () => undefined, release: async () => {}, close: async () => {} },
    });
    try {
      const current = local.store.get(owner, f.botId)!;
      const execution = local.executions.get(current);
      await expect(botProcess.advance(current, new AbortController().signal)).rejects.toThrow(/registration.*pending|migration.*committed/);
      expect(launch).not.toHaveBeenCalled();
      expect(grant).not.toHaveBeenCalled();
      expect(local.executions.get(current)).toEqual(execution);
    } finally { await botProcess.close(); local.close(); }
  });

  it("refuses an unknown original process before publishing dedicated authority", async () => {
    const f = await migrationFixture();
    await expect(migrateLegacyBot({ ...f.input, confirmStopped: async () => { throw new Error("original process state unknown"); } })).rejects.toThrow(/process state unknown/);
    expect(f.bots.get(owner, f.botId)).toEqual(f.record);
    expect(existsSync(resolveBotPaths(f.stateDirectory, f.botId).databaseFile)).toBe(false);
  });

  it("does not infer an unsubmitted launch when its execution row is lost but the original ticket remains", async () => {
    const f = await migrationFixture();
    const raw = f.openRaw(f.legacyDatabaseFile, false);
    raw.prepare("DELETE FROM bot_executions WHERE bot_id=?").run(f.botId);
    rmSync(f.record.intent!.journalPath);
    expect(existsSync(f.record.intent!.ticketPath)).toBe(true);
    await expect(migrateLegacyBot(f.input)).rejects.toThrow(/unsubmitted.*incomplete process evidence/);
    expect(f.bots.get(owner, f.botId)).toEqual(f.record);
    expect(existsSync(resolveBotPaths(f.stateDirectory, f.botId).databaseFile)).toBe(false);
    expect(f.confirmStopped).not.toHaveBeenCalled();
  });

  it("rejects a live lifecycle through the production stop guard", async () => {
    const f = await migrationFixture();
    const snapshot = { ...f.snapshot, lifecycle: "ready" as const, nativeStopped: false, stoppedAt: null };
    const db = f.openRaw(f.record.intent!.journalPath, false);
    db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(snapshot));
    db.close(); f.executions.update(f.record, { snapshot });
    const { confirmStopped: _controlled, ...input } = f.input;
    await expect(migrateLegacyBot(input)).rejects.toThrow(/stop|running|process/i);
    expect(f.bots.get(owner, f.botId)).toEqual(f.record);
    expect(existsSync(resolveBotPaths(f.stateDirectory, f.botId).databaseFile)).toBe(false);
  });

  it("retains the original Bot lock when another local owner holds it", async () => {
    const f = await migrationFixture(), paths = resolveBotPaths(f.stateDirectory, f.botId);
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    const competitor = acquireInstanceLockSync(paths.lockFile, paths.ownershipGateFile);
    const original = readFileSync(paths.lockFile);
    try {
      await expect(migrateLegacyBot(f.input)).rejects.toThrow(/instance lock/i);
      expect(readFileSync(paths.lockFile)).toEqual(original);
      expect(f.bots.get(owner, f.botId)).toEqual(f.record);
    } finally { competitor.release(); }
  });

  it("does not snapshot or switch a Controller whose storage lock is held", async () => {
    const f = await migrationFixture();
    const permit = acquireControllerStoragePermit(f.record.intent!.journalPath);
    try {
      await expect(migrateLegacyBot(f.input)).rejects.toThrow(/instance lock/i);
      expect(f.bots.get(owner, f.botId)).toEqual(f.record);
    } finally { permit.release(); }
  });

  it.each([
    { ...owner, serverOrigin: "https://different.example" },
    { ...owner, ownerUserId: id(90) },
    { ...owner, workerId: id(91) },
  ])("rejects migration under another service, account or Worker", async changedOwner => {
    const f = await migrationFixture();
    await expect(migrateLegacyBot({ ...f.input, owner: changedOwner })).rejects.toThrow();
    expect(f.bots.get(owner, f.botId)).toEqual(f.record);
    expect(existsSync(resolveBotPaths(f.stateDirectory, f.botId).databaseFile)).toBe(false);
  });

  it("rejects a ticket from a different session instead of migrating its journal", async () => {
    const f = await migrationFixture();
    writeFileSync(f.record.intent!.ticketPath, JSON.stringify({ ...f.ticket, sessionId: id(92) }));
    await expect(migrateLegacyBot(f.input)).rejects.toThrow();
    expect(f.bots.get(owner, f.botId)).toEqual(f.record);
  });

  it("rejects stale copied data when the legacy inventory changes before commit", async () => {
    const f = await migrationFixture();
    await expect(migrateLegacyBot({ ...f.input, onPhase: phase => {
      if (phase === "copied") throw new Error("copy interrupted");
    } })).rejects.toThrow(/copy interrupted/);
    const changed = f.bots.observe(owner, { ...f.record.observed, version: "3" }, 3);
    await expect(migrateLegacyBot(f.input)).rejects.toThrow();
    expect(f.bots.get(owner, f.botId)).toEqual(changed);
  });

  it("rolls back the receipt and both legacy rows when the authority transaction fails", async () => {
    const f = await migrationFixture();
    const raw = f.openRaw(f.legacyDatabaseFile, false);
    await expect(migrateLegacyBot({ ...f.input, onPhase: phase => {
      if (phase === "verified") raw.exec("CREATE TRIGGER interrupt_migration BEFORE DELETE ON bots BEGIN SELECT RAISE(ABORT, 'authority commit interrupted'); END");
    } })).rejects.toThrow(/authority commit interrupted/);
    try {
      expect(f.bots.get(owner, f.botId)).toEqual(f.record);
      expect(f.executions.get(f.record)).toEqual(f.execution);
      expect(raw.prepare("SELECT count(*) AS n FROM bot_migrations WHERE bot_id=?").get(f.botId)).toEqual({ n: 0 });
    } finally { raw.exec("DROP TRIGGER interrupt_migration"); }
    expect((await migrateLegacyBot(f.input)).phase).toBe("committed");
  });

  it("recovers the committed source receipt when final manifest publication fails", async () => {
    const f = await migrationFixture();
    const save = migrationFiles.saveMigrationManifest;
    const fault = vi.spyOn(migrationFiles, "saveMigrationManifest").mockImplementation((file, manifest) => {
      if (manifest.phase === "committed") throw new Error("committed manifest publication interrupted");
      save(file, manifest);
    });
    try { await expect(migrateLegacyBot(f.input)).rejects.toThrow(/committed manifest publication interrupted/); }
    finally { fault.mockRestore(); }
    const raw = f.openRaw(f.legacyDatabaseFile);
    expect(raw.prepare("SELECT count(*) AS n FROM bots WHERE bot_id=?").get(f.botId)).toEqual({ n: 0 });
    expect(raw.prepare("SELECT count(*) AS n FROM bot_executions WHERE bot_id=?").get(f.botId)).toEqual({ n: 0 });
    expect(raw.prepare("SELECT count(*) AS n FROM bot_migrations WHERE bot_id=?").get(f.botId)).toEqual({ n: 1 });
    const manifestPath = path.join(resolveBotPaths(f.stateDirectory, f.botId).directory, "migration.json");
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).phase).toBe("verified");
    expect(() => readMigratedBotHistory(f.input)).toThrow(/committed/);
    expect((await migrateLegacyBot(f.input)).phase).toBe("committed");
    expect(readMigratedBotHistory(f.input).entries).toEqual([{ ...f.entry, entrySeq: "1" }]);
  });

  it.each(["prepared", "copied", "verified"] as const)("prevents ordinary storage writes while migration is %s", async interruption => {
    const f = await migrationFixture();
    await expect(migrateLegacyBot({ ...f.input, onPhase: phase => {
      if (phase === interruption) throw new Error("migration interrupted");
    } })).rejects.toThrow(/migration interrupted/);
    const local = openLocalBotStores(f.input);
    try {
      expect(() => local.store.observe(owner, { ...f.record.observed, version: "3" }, 3)).toThrow(/migration/);
      expect(f.bots.get(owner, f.botId)).toEqual(f.record);
    } finally { local.close(); }
  });

  it("does not infer a committed migration from missing source rows without a receipt", async () => {
    const f = await migrationFixture();
    await expect(migrateLegacyBot({ ...f.input, onPhase: phase => {
      if (phase === "verified") throw new Error("before commit");
    } })).rejects.toThrow(/before commit/);
    const raw = f.openRaw(f.legacyDatabaseFile, false);
    raw.transaction(() => {
      raw.prepare("DELETE FROM bot_executions WHERE bot_id=?").run(f.botId);
      raw.prepare("DELETE FROM bots WHERE bot_id=?").run(f.botId);
    }).immediate();
    expect(raw.prepare("SELECT count(*) AS n FROM bot_migrations WHERE bot_id=?").get(f.botId)).toEqual({ n: 0 });
    await expect(migrateLegacyBot(f.input)).rejects.toThrow(/original.*changed|unavailable/);
    expect(() => readMigratedBotHistory(f.input)).toThrow(/committed/);
  });

  it("rejects modified copied evidence before reading migrated history", async () => {
    const f = await migrationFixture();
    const result = await migrateLegacyBot(f.input);
    const ticket = path.join(resolveBotPaths(f.stateDirectory, f.botId).directory, result.ticket!);
    writeFileSync(ticket, JSON.stringify({ ...f.ticket, sessionId: id(93) }), { mode: 0o600 });
    expect(() => readMigratedBotHistory(f.input)).toThrow(/digest|identity|ticket/);
  });

  it("rejects an escaping manifest destination without reading another file", async () => {
    const f = await migrationFixture();
    const result = await migrateLegacyBot(f.input);
    const paths = resolveBotPaths(f.stateDirectory, f.botId);
    const manifestPath = path.join(paths.directory, "migration.json");
    const altered = { ...result, files: result.files.map((file, index) => index === 0 ? { ...file, destination: "legacy/../../unrelated" } : file) };
    writeFileSync(manifestPath, JSON.stringify(altered), { mode: 0o600 });
    expect(() => readMigratedBotHistory(f.input)).toThrow(/escapes|manifest/);
  });
});
