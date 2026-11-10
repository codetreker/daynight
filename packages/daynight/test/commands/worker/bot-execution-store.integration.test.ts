import { loadSqliteSequence, sqliteSchemaSnapshots } from "../../../src/platform/sqlite-sql.js";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBotExecutionStore, type BotExecutionPatch } from "../../../src/commands/worker/bots/execution-store.js";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import type { BotRecord } from "../../../src/commands/worker/bots/types.js";
import { workerStoreFormat } from "../../../src/commands/worker/store-format.js";
import { openSqliteDatabase } from "../../../src/platform/sqlite-access.js";
import { assertCurrentSqlite, currentSqliteVersion } from "../../../src/platform/sqlite-format.js";

import { cleanupBotExecutions, createBotExecutionFixture, dirs, handles, id, owner, proof, root, snapshot, stopped, submitted } from "./bot-execution-store.fixtures.js";

const fixture = () => createBotExecutionFixture(home => path.join(home, "state.sqlite"));
afterEach(cleanupBotExecutions);

const formatTenFixture = () => {
  const f = fixture(); submitted(f);
  const legacyFormat = { ...workerStoreFormat, migrations: workerStoreFormat.migrations.filter(step => step.toVersion <= 10) };
  const file = path.join(f.home, "format-ten.sqlite");
  const db = openSqliteDatabase({ file, format: legacyFormat, allowCreate: true, onMigration: () => {} }); handles.push(db);
  const keys = [owner.serverOrigin, owner.ownerUserId, owner.workerId, id(3)];
  db.prepare("INSERT INTO bots VALUES (?,?,?,?,?)").run(...keys, JSON.stringify(f.record));
  db.prepare("INSERT INTO bot_executions VALUES (?,?,?,?,?)").run(...keys, JSON.stringify(f.store.get(f.record)));
  db.prepare("INSERT INTO projects VALUES (?,?,?)").run(id(40), "https://example.test/repository", f.home);
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?)").run(id(40), id(41), id(42), "active", "codex", id(43), "web");
  db.prepare("INSERT INTO cleanup_schedules VALUES (?,?,?,?,?,?,?,?,?)").run(id(40), id(41), id(42), id(44), 1234, 2, 5678, "backend-close", "retained failure");
  const tables = ["bots", "bot_executions", "projects", "tasks", "cleanup_schedules"];
  const columns = new Map(tables.map(table => [table, (db.pragma(`table_info(${table})`) as { name: string }[]).map(column => `"${column.name}"`).join(",")]));
  const rows = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT ${columns.get(table)!} FROM ${table}`).all()]));
  return { ...f, database: file, db, legacyFormat, rows };
};

describe("Bot execution file persistence and migration", () => {
  it("retains unknown submission and process ownership when the Worker reopens", () => {
    const f = fixture(); expect(f.store.get(f.record)).toBeNull();
    expect(f.store.prepare(f.record)).toMatchObject({ launchId: f.record.intent!.launchId, executionId: f.record.intent!.executionId, executionGeneration: "1", launchSubmission: "not-submitted", controllerProcess: null, snapshot: null, aliasDirectory: null, lastError: null, startup: null });
    const aliasDirectory = path.join(f.home, "aliases");
    f.store.update(f.record, { aliasDirectory, launchSubmission: "unknown" }); f.store.update(f.record, { controllerProcess: proof, lastError: "IPC unavailable" });
    const reopened = f.open();
    expect(reopened.prepare(f.record)).toMatchObject({ launchSubmission: "unknown", controllerProcess: proof, aliasDirectory, lastError: "IPC unavailable" });
    expect(() => reopened.update(f.record, { launchSubmission: "not-submitted" })).toThrow(/submission/i);
    expect(reopened.get(f.record)?.launchSubmission).toBe("unknown");
  });
  it("stores authenticated observations without changing the registered intent or Task rows", () => {
    const f = fixture(), db = new Database(f.database); handles.push(db); const before = db.prepare("SELECT record FROM bots").get();
    f.store.prepare(f.record); f.store.update(f.record, { launchSubmission: "unknown", controllerProcess: proof });
    const result = f.store.update(f.record, { launchSubmission: "acknowledged", snapshot: snapshot(f.record), lastError: null });
    expect(f.open().get(f.record)).toEqual(result); expect(result.snapshot?.nativeSessionId).toBe(id(20));
    expect(db.prepare("SELECT record FROM bots").get()).toEqual(before);
    expect(db.prepare("SELECT * FROM tasks").all()).toEqual([]); expect(db.prepare("SELECT * FROM cleanup_schedules").all()).toEqual([]);
  });
  it("persists a rejected OS launch for reporting again without losing its submission barrier", () => {
    const f = fixture(); f.store.prepare(f.record);
    const startup = { state: "failed", reasonCode: "controller_launch_failed" } as const;
    f.store.update(f.record, { launchSubmission: "unknown", startup } as BotExecutionPatch);
    const reopened = f.open();
    expect(reopened.get(f.record)).toMatchObject({ startup, launchSubmission: "unknown", controllerProcess: null });
    expect(reopened.update(f.record, { lastError: "Report unavailable" })).toMatchObject({ startup });
    expect(reopened.update(f.record, { startup } as BotExecutionPatch)).toMatchObject({ startup });
    for (const changed of [null, { state: "unknown", reasonCode: "controller_start_unknown" }, { state: "starting", reasonCode: "initializing" }, { state: "ready", reasonCode: "ready" }, { state: "failed", reasonCode: "native_rejected" }]) {
      expect(() => reopened.update(f.record, { startup: changed } as BotExecutionPatch)).toThrow(/startup/i);
      expect(reopened.get(f.record)).toMatchObject({ startup, launchSubmission: "unknown" });
    }
  });
  it("keeps initialization readiness when later observations are unavailable", () => {
    const f = fixture(); f.store.prepare(f.record);
    f.store.update(f.record, { startup: { state: "unknown", reasonCode: "evidence_missing" } } as BotExecutionPatch);
    const startup = { state: "ready", reasonCode: "ready" } as const;
    f.store.update(f.record, { launchSubmission: "acknowledged", startup, snapshot: snapshot(f.record) } as BotExecutionPatch);
    for (const changed of [null, { state: "unknown", reasonCode: "native_timeout" }, { state: "starting", reasonCode: "initializing" }, { state: "failed", reasonCode: "native_rejected" }]) {
      expect(() => f.store.update(f.record, { startup: changed } as BotExecutionPatch)).toThrow(/startup/i);
    }
    expect(f.open().get(f.record)).toMatchObject({ startup });
  });
  it("migrates version 8 without rewriting inventory and rolls back a failed migration", () => {
    mkdirSync(root, { recursive: true }); const home = mkdtempSync(path.join(root, "migration-")); dirs.push(home);
    const file = path.join(home, "state.sqlite"), db = new Database(file); handles.push(db);
    for (const name of ["005-baseline.sql", "006-cleanup-schedules.sql", "007-resource-cleanup-intent.sql", "008-bot-inventory.sql"]) db.exec(readFileSync(new URL(`../../../src/commands/worker/sqlite/${name}`, import.meta.url), "utf8"));
    db.pragma("user_version=8"); db.prepare("INSERT INTO bots VALUES (?,?,?,?,?)").run(owner.serverOrigin, owner.ownerUserId, owner.workerId, id(3), JSON.stringify({ preserved: true })); db.prepare("INSERT INTO projects VALUES (?,?,?)").run(id(4), "https://example.test/repo", home);
    const schema = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(), rows = db.prepare("SELECT * FROM bots").all(), exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database, sql: string) { const result = exec.call(this, sql); if (sql.includes("CREATE TABLE bot_executions")) throw new Error("injected migration failure"); return result; });
    expect(() => openBotExecutionStore(file, { onMigration: () => {} })).toThrow(/migration/);
    expect(db.pragma("user_version", { simple: true })).toBe(8); expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(schema); expect(db.prepare("SELECT * FROM bots").all()).toEqual(rows);
    vi.restoreAllMocks(); const store = openBotExecutionStore(file, { onMigration: () => {} }); handles.push(store);
    expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(workerStoreFormat)); expect(db.prepare("SELECT * FROM bots").all()).toEqual(rows);
    expect(db.prepare("SELECT * FROM projects").get()).toMatchObject({ project_id: id(4), local_path: home });
  });
  it("atomically replaces a stopped generation while preserving registration, role and original conversation", () => {
    const f = fixture(); submitted(f);
    const next = f.store.beginRecovery(f.record, stopped(f.record), f.home);
    expect(next.intent).toMatchObject({ registration: f.record.intent!.registration, executionId: f.record.intent!.executionId, sessionId: f.record.intent!.sessionId, nativeSessionId: id(20), executionGeneration: "2", initialOperationId: f.record.intent!.initialOperationId, journalPath: f.record.intent!.journalPath, credentialFile: f.record.intent!.credentialFile });
    expect(next.intent!.controllerInstanceId).not.toBe(f.record.intent!.controllerInstanceId);
    expect(next.intent!.launchId).not.toBe(f.record.intent!.launchId);
    expect(f.open().get(next)).toMatchObject({ launchId: next.intent!.launchId, executionGeneration: "2", launchSubmission: "not-submitted", snapshot: null, controllerProcess: null, recoveryCount: 1, restartAfterShutdown: false, recoveryBlocked: null, previous: { launchId: f.record.intent!.launchId, generation: "1", instanceId: f.record.intent!.controllerInstanceId, recordId: next.intent!.launchId }, retainedLaunchIds: [f.record.intent!.launchId], retainedAliasDirectories: [path.join(f.home, "aliases-1")] });
    expect(() => f.store.beginRecovery(f.record, stopped(f.record), f.home)).toThrow(/current durable launch intent/);
  });
  it("migrates existing format 9 intents and execution evidence atomically without replacing ownership", () => {
    const f = fixture(); submitted(f);
    const original = structuredClone(f.record) as BotRecord;
    const legacyIntent = original.intent! as unknown as Record<string, unknown>;
    delete legacyIntent.controllerInstanceId;
    const execution = structuredClone(f.store.get(f.record)!) as unknown as Record<string, unknown>;
    for (const field of ["recoveryCount", "restartAfterShutdown", "recoveryBlocked", "previous", "retainedLaunchIds", "retainedAliasDirectories"]) delete execution[field];
    const file = path.join(f.home, "legacy.sqlite"), db = new Database(file); handles.push(db);
    for (const name of ["005-baseline.sql", "006-cleanup-schedules.sql", "007-resource-cleanup-intent.sql", "008-bot-inventory.sql", "009-bot-executions.sql"]) db.exec(readFileSync(new URL(`../../../src/commands/worker/sqlite/${name}`, import.meta.url), "utf8"));
    db.pragma("user_version=9");
    const keys = [owner.serverOrigin, owner.ownerUserId, owner.workerId, id(3)];
    db.prepare("INSERT INTO bots VALUES (?,?,?,?,?)").run(...keys, JSON.stringify(original));
    db.prepare("INSERT INTO bot_executions VALUES (?,?,?,?,?)").run(...keys, JSON.stringify(execution));
    const before = db.prepare("SELECT record FROM bots").get(), beforeExecution = db.prepare("SELECT record FROM bot_executions").get();
    const exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database, sql: string) { const result = exec.call(this, sql); if (sql.includes("UPDATE bot_executions")) throw new Error("recovery migration interrupted"); return result; });
    expect(() => openBotExecutionStore(file, { onMigration: () => {} })).toThrow(/migration/);
    expect(db.pragma("user_version", { simple: true })).toBe(9);
    expect(db.prepare("SELECT record FROM bots").get()).toEqual(before);
    expect(db.prepare("SELECT record FROM bot_executions").get()).toEqual(beforeExecution);
    vi.restoreAllMocks();
    const bots = openBotStore(file, { onMigration: () => {} }), store = openBotExecutionStore(file, { onMigration: () => {} }); handles.push(bots, store);
    const record = bots.get(owner, id(3))!;
    expect(record).toEqual(f.record);
    expect(store.get(record)).toEqual(f.store.get(f.record));
    expect(db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(workerStoreFormat));
  });
  it("upgrades format ten without rewriting Bot execution, inventory or Task cleanup responsibility", () => {
    const f = formatTenFixture(), rows = f.rows();
    const bots = openBotStore(f.database, { onMigration: () => {} }), executions = openBotExecutionStore(f.database, { onMigration: () => {} }); handles.push(bots, executions);
    expect(f.db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(workerStoreFormat));
    expect(f.rows()).toEqual(rows);
    expect(f.db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all()).toEqual(sqliteSchemaSnapshots(loadSqliteSequence(new URL("../../../src/commands/worker/sqlite/", import.meta.url))).get(currentSqliteVersion(workerStoreFormat)));
    expect(f.db.prepare("SELECT * FROM claim_native_configurations").all()).toEqual([]);
    expect(bots.get(owner, id(3))).toEqual(f.record);
    expect(executions.get(f.record)).toEqual(f.store.get(f.record));
  });
  it("refuses format ten readers and already-open writers after admitting Bot deletion responsibility", () => {
    const f = formatTenFixture();
    const legacyRead = () => f.db.transaction(() => { assertCurrentSqlite(f.db, f.legacyFormat); return f.db.prepare("SELECT record FROM bots").get(); }).deferred();
    expect(legacyRead()).toEqual({ record: JSON.stringify(f.record) });
    const upgraded = openBotStore(f.database, { onMigration: () => {} }); handles.push(upgraded);
    const rows = f.rows();
    expect(() => openSqliteDatabase({ file: f.database, format: f.legacyFormat, allowCreate: false, onMigration: () => {} })).toThrow(/unsupported-version/);
    expect(legacyRead).toThrow(/unsupported-version/);
    expect(() => f.db.transaction(() => {
      assertCurrentSqlite(f.db, f.legacyFormat);
      f.db.prepare("UPDATE bots SET record=?").run(JSON.stringify(f.record));
    }).immediate()).toThrow(/unsupported-version/);
    expect(f.rows()).toEqual(rows);
  });
  it("rolls back a failed deletion format guard without altering preexisting responsibility", () => {
    const f = formatTenFixture(), rows = f.rows();
    const exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database, sql: string) {
      const result = exec.call(this, sql);
      if (sql.includes("SELECT 1;")) throw new Error("deletion format admission interrupted");
      return result;
    });
    expect(() => openBotStore(f.database, { onMigration: () => {} })).toThrow(/migration/);
    expect(f.db.pragma("user_version", { simple: true })).toBe(10);
    expect(f.rows()).toEqual(rows);
    vi.restoreAllMocks();
    const reopened = openBotStore(f.database, { onMigration: () => {} }); handles.push(reopened);
    expect(f.db.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(workerStoreFormat));
    expect(f.rows()).toEqual(rows);
  });
});
