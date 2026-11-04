import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBotExecutionStore, type BotExecutionPatch } from "../../../src/commands/worker/bots/execution-store.js";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import type { BotDefinition, BotOwner, BotRecord } from "../../../src/commands/worker/bots/types.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import type { ProcessProof } from "../../../src/commands/controller/process-proof.js";

const root = fileURLToPath(new URL("../../../../../.tmp/bot-execution-store-tests/", import.meta.url));
const dirs: string[] = [], handles: { close(): void }[] = [];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: BotOwner = { serverOrigin: "https://daynight.example", ownerUserId: id(1), workerId: id(2) };
const definition = (): BotDefinition => ({ id: id(3), workerId: owner.workerId, version: "1", deletion: null, ownerUserId: owner.ownerUserId, name: "Assistant", creationOrder: "1", requestedOverrides: {}, resolvedConfiguration: { workerId: owner.workerId, cwd: root, provider: "codex", model: null, args: [] }, roleConfiguration: null, sessionId: null, testExecutionId: null, startupResult: { state: "pending", code: null }, createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z" });
const proof: ProcessProof = { pid: 123, parentPid: 12, processGroupId: 123, startedAt: "Wed Nov 4 12:00:00 2026", commandHash: "a".repeat(64) };
const fixture = () => {
  mkdirSync(root, { recursive: true }); const home = mkdtempSync(path.join(root, "case-")); dirs.push(home);
  const file = path.join(home, "state.sqlite"), bots = openBotStore(file, { onMigration: () => {} }); handles.push(bots);
  bots.observe(owner, definition(), 1); bots.prepare(owner, id(3), { homeDirectory: home, recoveryLimit: 3 });
  const intent = bots.get(owner, id(3))!.intent!;
  bots.observe(owner, { ...definition(), version: "2", sessionId: id(10), testExecutionId: intent.executionId }, 2);
  const record = bots.get(owner, id(3))!;
  const open = () => { const store = openBotExecutionStore(file, { onMigration: () => {} }); handles.push(store); return store; };
  return { home, file, bots, record, open, store: open() };
};
const snapshot = (record: BotRecord): ControllerSnapshot => ({ executionId: record.intent!.executionId, testExecutionId: record.intent!.executionId, sessionId: record.intent!.sessionId!, executionGeneration: record.intent!.executionGeneration, controllerInstanceId: record.intent!.registration.controllerInstanceId, lifecycle: "ready", nativeSessionId: id(20), initialInputState: "not_required", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: false, respond: false }, controllerProcess: proof, nativeProcesses: [], nativeStopped: false, stoppedAt: null, error: null });
afterEach(() => { vi.restoreAllMocks(); for (const handle of handles.splice(0)) handle.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Bot execution evidence", () => {
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
    const f = fixture(), db = new Database(f.file); handles.push(db); const before = db.prepare("SELECT record FROM bots").get();
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
  it("rejects malformed startup observations on writes and persisted reads", () => {
    const f = fixture(); f.store.prepare(f.record);
    for (const startup of [{ state: "failed", reasonCode: "ready" }, { state: "ready", reasonCode: "ready", extra: true }, { state: "lost", reasonCode: "evidence_missing" }]) {
      expect(() => f.store.update(f.record, { startup } as BotExecutionPatch)).toThrow();
    }
    const db = new Database(f.file); handles.push(db);
    db.prepare("UPDATE bot_executions SET record=json_set(record, '$.startup', json(?))").run(JSON.stringify({ state: "ready", reasonCode: "native_rejected" }));
    expect(() => f.store.get(f.record)).toThrow();
  });
  it("refuses stale or replacement launch identity even if a caller manufactures a record", () => {
    const f = fixture(); f.store.prepare(f.record);
    for (const changed of [{ launchId: id(30) }, { executionId: id(31) }, { executionGeneration: "2" }]) {
      const record = { ...f.record, intent: { ...f.record.intent!, ...changed } };
      expect(() => f.store.prepare(record)).toThrow(/intent|identity|generation/i);
      expect(() => f.store.update(record, { lastError: "replacement" })).toThrow(/intent|identity|generation/i);
    }
    expect(() => f.store.update(f.record, { launchId: id(30) } as BotExecutionPatch)).toThrow(/field|identity/i);
    expect(f.store.get(f.record)?.launchSubmission).toBe("not-submitted");
  });
  it("rejects snapshots from another fence, initial user input, native replacement and lost proof", () => {
    const f = fixture(); f.store.prepare(f.record); f.store.update(f.record, { launchSubmission: "unknown", controllerProcess: proof });
    const observed = snapshot(f.record); f.store.update(f.record, { launchSubmission: "acknowledged", snapshot: observed });
    for (const changed of [{ sessionId: id(30) }, { testExecutionId: id(30) }, { executionGeneration: "2" }, { controllerInstanceId: id(30) }, { claimId: id(30) }, { initialInputState: "confirmed" }, { nativeSessionId: id(30) }, { nativeSessionId: null }]) {
      expect(() => f.store.update(f.record, { snapshot: { ...observed, ...changed } as ControllerSnapshot })).toThrow();
      expect(f.store.get(f.record)?.snapshot).toEqual(observed);
    }
    expect(() => f.store.update(f.record, { controllerProcess: null })).toThrow(/process/i);
    expect(() => f.store.update(f.record, { controllerProcess: { ...proof, startedAt: "replacement" } })).toThrow(/process/i);
    expect(() => f.store.update(f.record, { snapshot: null })).toThrow(/snapshot/i);
  });
  it("permits the Windows Job Object to enrich the original captured process proof", () => {
    const f = fixture(); f.store.prepare(f.record); f.store.update(f.record, { launchSubmission: "unknown", controllerProcess: proof });
    const controllerProcess = { ...proof, jobObjectName: "Local\\daynight-original" }, observed = { ...snapshot(f.record), controllerProcess };
    expect(f.store.update(f.record, { controllerProcess, snapshot: observed, launchSubmission: "acknowledged" }).controllerProcess).toEqual(controllerProcess);
    expect(() => f.store.update(f.record, { controllerProcess: proof })).toThrow(/process/i);
  });
  it("retains the original process identity after its parent exits", () => {
    const f = fixture(); f.store.prepare(f.record); f.store.update(f.record, { launchSubmission: "unknown", controllerProcess: proof });
    const controllerProcess = { ...proof, parentPid: 1 };
    const observed = { ...snapshot(f.record), controllerProcess };
    expect(f.store.update(f.record, { snapshot: observed, launchSubmission: "acknowledged" }).snapshot?.controllerProcess).toEqual(controllerProcess);
  });
  it("preserves ownership under deletion and refuses a new preparation", () => {
    const f = fixture(); f.store.prepare(f.record); f.store.update(f.record, { launchSubmission: "unknown", aliasDirectory: path.join(f.home, "aliases") });
    f.bots.observe(owner, { id: id(3), workerId: owner.workerId, version: "3", deletion: { deletionId: id(40), requestedVersion: "2", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } }, 3);
    const deleted = f.bots.get(owner, id(3))!;
    expect(f.store.get(deleted)?.launchSubmission).toBe("unknown"); expect(() => f.store.prepare(deleted)).toThrow(/delet/i);
    expect(() => f.store.update(deleted, { aliasDirectory: path.join(f.home, "other") })).toThrow(/alias/i);
    expect(f.store.update(deleted, { lastError: "Deletion awaits stop proof" }).lastError).toContain("Deletion");
  });
  it("refuses corrupt stored evidence and a changed database format", () => {
    const f = fixture(); f.store.prepare(f.record); const db = new Database(f.file); handles.push(db);
    db.prepare("UPDATE bot_executions SET record=json_set(record, '$.launchSubmission', 'lost')").run();
    expect(() => f.store.get(f.record)).toThrow(/submission/i);
    db.pragma("user_version=10"); expect(() => f.store.get(f.record)).toThrow(/unsupported-version/); db.pragma("user_version=9");
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
    expect(db.pragma("user_version", { simple: true })).toBe(9); expect(db.prepare("SELECT * FROM bots").all()).toEqual(rows);
    expect(db.prepare("SELECT * FROM projects").get()).toMatchObject({ project_id: id(4), local_path: home });
  });
});
