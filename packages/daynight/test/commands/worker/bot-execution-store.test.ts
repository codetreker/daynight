import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotExecutionPatch } from "../../../src/commands/worker/bots/execution-store.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { cleanupBotExecutions, createBotExecutionFixture, id, owner, proof, snapshot, stopped, submitted } from "./bot-execution-store.fixtures.js";

const fixture = () => createBotExecutionFixture(() => createMemoryDatabase());
afterEach(cleanupBotExecutions);

describe("Bot execution evidence", () => {
  it("rejects malformed startup observations on writes and persisted reads", () => {
    const f = fixture(); f.store.prepare(f.record);
    for (const startup of [{ state: "failed", reasonCode: "ready" }, { state: "ready", reasonCode: "ready", extra: true }, { state: "lost", reasonCode: "evidence_missing" }]) {
      expect(() => f.store.update(f.record, { startup } as BotExecutionPatch)).toThrow();
    }
    const db = f.database;
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
    const f = fixture(); f.store.prepare(f.record); const db = f.database;
    db.prepare("UPDATE bot_executions SET record=json_set(record, '$.launchSubmission', 'lost')").run();
    expect(() => f.store.get(f.record)).toThrow(/submission/i);
    db.pragma("user_version=12"); expect(() => f.store.get(f.record)).toThrow(/unsupported-version/); db.pragma("user_version=11");
  });
});

describe("Bot recovery storage", () => {
  it("retains abnormal counts through four normal restarts and refuses exhausted failure laundering", () => {
    const f = fixture(); submitted(f);
    let record = f.store.beginRecovery(f.record, stopped(f.record), f.home);
    for (let n = 0; n < 4; n++) {
      submitted(f, record); f.store.markShutdown(record, true);
      record = f.store.beginRecovery(record, stopped(record), f.home);
      expect(f.store.get(record)?.recoveryCount).toBe(1);
    }
    submitted(f, record); record = f.store.beginRecovery(record, stopped(record), f.home);
    submitted(f, record); record = f.store.beginRecovery(record, stopped(record), f.home);
    expect(f.store.get(record)?.recoveryCount).toBe(3);
    submitted(f, record); f.store.update(record, { snapshot: { ...snapshot(record), lifecycle: "failed", error: "native failed" } });
    f.store.markShutdown(record, true);
    expect(f.store.get(record)?.restartAfterShutdown).toBe(false);
    expect(() => f.store.beginRecovery(record, stopped(record), f.home)).toThrow(/budget/);
    expect(f.store.get(record)?.recoveryCount).toBe(3);
  });
  it("permits an orderly restart at the limit without erasing a previously blocked failure", () => {
    const f = fixture(); submitted(f);
    let record = f.record;
    for (let n = 0; n < 3; n++) { record = f.store.beginRecovery(record, stopped(record), f.home); submitted(f, record); }
    f.store.markShutdown(record, true);
    record = f.store.beginRecovery(record, stopped(record), f.home);
    expect(f.store.get(record)?.recoveryCount).toBe(3);
    submitted(f, record); f.store.blockRecovery(record, "authorization revoked"); f.store.markShutdown(record, true);
    expect(f.store.get(record)).toMatchObject({ restartAfterShutdown: false, recoveryBlocked: "authorization revoked", recoveryCount: 3 });
    expect(() => f.store.beginRecovery(record, stopped(record), f.home)).toThrow(/authorization revoked/);
  });
  it("rejects incomplete or conflicting stop evidence and arbitrary recovery patches", () => {
    const f = fixture(); submitted(f);
    for (const patch of [{ nativeStopped: false }, { stoppedAt: null }, { controllerProcess: null }, { nativeSessionId: null }, { nativeSessionId: id(99) }, { executionGeneration: "2" }, { controllerInstanceId: id(99) }, { sessionId: id(99) }, { lifecycle: "ready" }, { controllerProcess: { ...proof, commandHash: "b".repeat(64) } }]) {
      expect(() => f.store.beginRecovery(f.record, { ...stopped(f.record), ...patch } as ControllerSnapshot, f.home)).toThrow();
      expect(f.bots.get(owner, id(3))!.intent!.executionGeneration).toBe("1");
    }
    for (const patch of [{ recoveryCount: 0 }, { restartAfterShutdown: true }, { recoveryBlocked: null }, { previous: null }, { retainedLaunchIds: [] }, { retainedAliasDirectories: [] }]) expect(() => f.store.update(f.record, patch as BotExecutionPatch)).toThrow(/fields/);
  });
  it("rolls back both intent and execution when the replacement evidence write fails", () => {
    const f = fixture(); submitted(f); const before = f.store.get(f.record);
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function(this: Database.Database, sql: string) {
      const statement = prepare.call(this, sql);
      if (!sql.includes("INSERT INTO bot_executions")) return statement;
      return new Proxy(statement, { get(target, key) { if (key === "run") return (...args: unknown[]) => { Reflect.apply(target.run, target, args); throw new Error("replacement rejected"); }; const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
    });
    expect(() => f.store.beginRecovery(f.record, stopped(f.record), f.home)).toThrow(/replacement rejected/);
    vi.restoreAllMocks();
    expect(f.bots.get(owner, id(3))).toEqual(f.record); expect(f.store.get(f.record)).toEqual(before);
  });
});

it("refuses recovery into a different private execution home", () => {
  const f = fixture(); submitted(f);
  expect(() => f.store.beginRecovery(f.record, stopped(f.record), path.join(f.home, "replacement"))).toThrow(/home/);
  expect(f.bots.get(owner, id(3))).toEqual(f.record);
});
