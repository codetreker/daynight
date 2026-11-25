import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { workerStoreFormat } from "../../../src/commands/worker/store-format.js";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openBotExecutionStore } from "../../../src/commands/worker/bots/execution-store.js";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import Database from "better-sqlite3";
import path from "node:path";
import { matchesInitializationDeletionStop, type Bot, type BotInitializationDeletionEvidence } from "../../../src/commands/worker/bots/types.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { bot, cleanupBotStores, createBotStoreFixture, handles, id, owner } from "./bot-store.fixtures.js";

const fixture = () => createBotStoreFixture(() => createMemoryDatabase());
afterEach(cleanupBotStores);

describe("durable Bot inventory", () => {
  it("keeps Bot records out of task inventory and cleanup budget", () => {
    const f = fixture(); const worker = openWorkerStore(f.database, { onMigration: () => {} }); handles.push(worker);
    worker.registerProject({ projectId: id(4), repoUrl: "https://example.test/repo", localPath: f.home });
    const claim = { projectId: id(4), taskId: id(5), claimId: id(6), agent: "codex" as const, agentControlMode: "web" as const };
    worker.registerPending(claim); worker.saveCleanupSchedule({ ...claim, worktreeId: id(7) }, { deadline: 100, failures: 2, nextAttemptAt: 50, stage: "archive", lastError: "retained" });
    const before = { tasks: worker.listUnfinishedTasks(), cleanup: worker.listCleanupSchedules() };
    f.store.observe(owner, bot(), 1); f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 });
    expect({ tasks: worker.listUnfinishedTasks(), cleanup: worker.listCleanupSchedules() }).toEqual(before);
    expect(f.store.list(owner)).toHaveLength(1);
  });

  it("preserves frozen definition and launch responsibility under deletion projection", () => {
    const f = fixture(); f.store.observe(owner, bot(), 1);
    const intent = f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 });
    const deletion: Bot = { id: id(3), workerId: owner.workerId, version: "2", deletion: { deletionId: id(8), requestedVersion: "1", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } };
    f.store.observe(owner, deletion, 2);
    expect(f.store.get(owner, id(3))).toMatchObject({ definition: bot(), intent, observed: deletion });
    expect(() => f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 })).toThrow(/delet/);
    expect(() => f.store.observe(owner, { ...bot(), version: "3" }, 3)).toThrow(/delet/);
  });

  it("rejects owner, configuration, stale-version and stable-session conflicts", () => {
    const f = fixture(); const original = bot(); f.store.observe(owner, original, 1);
    expect(() => f.store.observe(owner, { ...original, ownerUserId: id(9) } as Bot, 2)).toThrow(/owner/i);
    if (original.deletion !== null) throw new Error("fixture");
    expect(() => f.store.observe(owner, { ...original, version: "2", resolvedConfiguration: { ...original.resolvedConfiguration, cwd: "/different" } }, 2)).toThrow(/configuration/);
    f.store.observe(owner, { ...original, version: "2", sessionId: id(10), testExecutionId: id(11) }, 2);
    expect(() => f.store.observe(owner, original, 3)).toThrow(/version/);
    expect(() => f.store.observe(owner, { ...original, version: "3", sessionId: id(12), testExecutionId: id(11) }, 3)).toThrow(/session/i);
    expect(() => f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 })).toThrow(/existing|bound/i);
    expect(f.store.list({ ...owner, ownerUserId: id(9) })).toEqual([]);
  });

  it("refuses malformed observations and a changed open database format without altering inventory", () => {
    const f = fixture(); f.store.observe(owner, bot(), 1); const before = f.store.get(owner, id(3));
    for (const changed of [{ version: "9007199254740993.0" }, { workerId: id(9) }, { sessionId: id(10), testExecutionId: null }]) {
      expect(() => f.store.observe(owner, { ...bot(), ...changed } as Bot, 2)).toThrow();
      expect(f.store.get(owner, id(3))).toEqual(before);
    }
    const db = f.database; db.pragma(`user_version = ${currentSqliteVersion(workerStoreFormat) + 1}`);
    expect(() => f.store.observe(owner, { ...bot(), version: "2" }, 2)).toThrow(/unsupported-version/);
    expect(() => f.store.list(owner)).toThrow(/unsupported-version/);
    db.pragma(`user_version = ${currentSqliteVersion(workerStoreFormat)}`); expect(f.store.get(owner, id(3))).toEqual(before);
  });
});

describe("Bot deletion responsibility", () => {
  const initializationDeletion = (authorization: BotInitializationDeletionEvidence["authorization"] = "not_prepared", disk = false) => {
    const f = disk ? createBotStoreFixture(home => new Database(path.join(home, "initialization-deletion.sqlite"))) : fixture(), original = bot();
    if (original.deletion !== null) throw new Error("fixture");
    f.store.observe(owner, original, 1);
    const intent = f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 2 });
    const registered = f.store.observe(owner, { ...original, version: "2", sessionId: id(4), testExecutionId: intent.executionId }, 2);
    const executions = openBotExecutionStore(f.database, { onMigration: () => {} }); handles.push(executions);
    const execution = executions.prepare(registered);
    const target = { ...registered, intent: { ...registered.intent!, launchId: id(20), controllerInstanceId: id(21), executionGeneration: "2" } };
    const previous = { launchId: intent.launchId, generation: "1", instanceId: intent.controllerInstanceId, recordId: id(20), stoppedAt: "2026-11-23T00:00:00Z",
      initializationEvidence: { version: 1, state: "not_dispatched" },
      initializationRetryEvidence: { version: 1, kind: "legacy_codex_version_gate", ticketHash: "a".repeat(64), snapshotHash: "b".repeat(64) } };
    f.database.prepare("UPDATE bots SET record=?").run(JSON.stringify(target));
    const targetExecution = { ...execution, launchId: id(20), executionGeneration: "2", previous, retainedLaunchIds: [intent.launchId], recoveryCount: 1,
      initializationGrantState: authorization === "not_prepared" ? "not_submitted" : "refused" };
    f.database.prepare("UPDATE bot_executions SET record=?").run(JSON.stringify(targetExecution));
    const record = f.store.observe(owner, { id: id(3), workerId: owner.workerId, version: "3", deletion: { deletionId: id(8), requestedVersion: "2", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } }, 3);
    const stop = { protocol: "daynight.session.v1" as const, sessionId: id(4), testExecutionId: intent.executionId, executionGeneration: "1", controllerId: intent.registration.controllerId, controllerInstanceId: intent.controllerInstanceId,
      stopProof: { recordId: previous.recordId, previousControllerInstanceId: intent.controllerInstanceId, stoppedAt: previous.stoppedAt } };
    const evidence: BotInitializationDeletionEvidence = { version: 1, targetLaunchId: id(20), targetExecutionGeneration: "2", targetControllerInstanceId: id(21), predecessorLaunchId: intent.launchId,
      ticketHash: previous.initializationRetryEvidence.ticketHash, snapshotHash: previous.initializationRetryEvidence.snapshotHash, authorization };
    return { ...f, record, stop, evidence, targetExecution };
  };

  it.each(["not_prepared", "rejected"] as const)("retains an ungranted initialization target while deleting its exact stopped predecessor (%s)", authorization => {
    const f = initializationDeletion(authorization);
    expect(() => f.store.prepareDeletion(f.record, f.stop, [])).toThrow("original execution intent");
    const recorded = f.store.recordInitializationDeletion(f.record, f.stop, f.evidence);
    expect(recorded.intent).toEqual(f.record.intent);
    expect(matchesInitializationDeletionStop(recorded, f.stop)).toBe(true);
    const refreshed = f.store.observe(owner, recorded.observed, 4);
    expect(refreshed.initializationDeletion).toEqual(recorded.initializationDeletion);
    const prepared = f.store.prepareDeletion(refreshed, f.stop, []);
    expect(prepared.intent?.executionGeneration).toBe("2");
    expect(prepared.cleanup?.stop?.executionGeneration).toBe("1");
    const completed = f.store.finishDeletion(prepared);
    expect(completed).toMatchObject({ intent: null, definition: null, cleanup: { stop: f.stop, localCompleted: true } });
    expect(completed.initializationDeletion).toEqual(recorded.initializationDeletion);
    expect(matchesInitializationDeletionStop(completed, f.stop)).toBe(true);
    expect(f.database.prepare("SELECT 1 FROM bot_executions").get()).toBeUndefined();
  });

  it("retains predecessor receipt provenance across SQLite reopen after logical erasure", () => {
    const f = initializationDeletion("rejected", true), file = f.database.name;
    const recorded = f.store.recordInitializationDeletion(f.record, f.stop, f.evidence);
    const prepared = f.store.prepareDeletion(recorded, f.stop, []);
    f.store.close();
    const reopened = openBotStore(file, { onMigration: () => {} }); handles.push(reopened);
    const retained = reopened.get(owner, id(3))!;
    expect(retained).toEqual(prepared);
    const completed = reopened.finishDeletion(retained);
    reopened.close();
    const finished = openBotStore(file, { onMigration: () => {} }); handles.push(finished);
    expect(finished.get(owner, id(3))).toEqual(completed);
    expect(matchesInitializationDeletionStop(finished.get(owner, id(3))!, f.stop)).toBe(true);
    expect(completed.intent).toBeNull();
    expect(completed.initializationDeletion?.evidence).toEqual(f.evidence);
  });

  it.each(["unknown", "acknowledged", "missing-grant-state", "submitted", "process", "snapshot", "previous-hash"])("refuses initialization predecessor deletion with %s target evidence", mode => {
    const f = initializationDeletion();
    const changed = structuredClone(f.targetExecution) as unknown as Record<string, unknown>;
    if (mode === "unknown" || mode === "acknowledged") changed.initializationGrantState = mode;
    if (mode === "missing-grant-state") delete changed.initializationGrantState;
    if (mode === "submitted") changed.launchSubmission = "unknown";
    if (mode === "process") changed.controllerProcess = { pid: 10 };
    if (mode === "snapshot") changed.snapshot = {};
    if (mode === "previous-hash") (changed.previous as { initializationRetryEvidence: { ticketHash: string } }).initializationRetryEvidence.ticketHash = "c".repeat(64);
    f.database.prepare("UPDATE bot_executions SET record=?").run(JSON.stringify(changed));
    expect(() => f.store.recordInitializationDeletion(f.record, f.stop, f.evidence)).toThrow("unsubmitted execution");
    expect(f.store.get(owner, id(3))?.initializationDeletion).toBeUndefined();
    expect(f.store.get(owner, id(3))?.intent).toEqual(f.record.intent);
  });

  it("rejects another stop or deletion and rechecks target submission before capturing cleanup", () => {
    const f = initializationDeletion();
    expect(() => f.store.recordInitializationDeletion(f.record, { ...f.stop, stopProof: { ...f.stop.stopProof, kind: "never_started" } }, f.evidence)).toThrow("original execution");
    expect(() => f.store.recordInitializationDeletion(f.record, { ...f.stop, controllerInstanceId: id(90) }, f.evidence)).toThrow("original execution");
    const recorded = f.store.recordInitializationDeletion(f.record, f.stop, f.evidence);
    expect(() => f.store.recordInitializationDeletion(recorded, f.stop, { ...f.evidence, snapshotHash: "c".repeat(64) })).toThrow("cannot be replaced");
    expect(matchesInitializationDeletionStop({ ...recorded, observed: { ...recorded.observed, deletion: { ...recorded.observed.deletion!, deletionId: id(99) } } }, f.stop)).toBe(false);
    f.database.prepare("UPDATE bot_executions SET record=?").run(JSON.stringify({ ...f.targetExecution, initializationGrantState: "unknown" }));
    expect(() => f.store.prepareDeletion(recorded, f.stop, [])).toThrow("unsubmitted execution");
    expect(f.store.get(owner, id(3))?.cleanup).toBeUndefined();
  });

  it("binds never-started recovery only with its exact retained execution and preserves the binding across erasure", () => {
    const f = fixture(), original = bot();
    if (original.deletion !== null) throw new Error("fixture");
    f.store.observe(owner, original, 1);
    const intent = f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 0 });
    const registered = f.store.observe(owner, { ...original, version: "2", sessionId: id(4), testExecutionId: intent.executionId }, 2);
    const executions = openBotExecutionStore(f.database, { onMigration: () => {} }); handles.push(executions);
    const execution = executions.prepare(registered);
    const record = f.store.observe(owner, { id: id(3), workerId: owner.workerId, version: "3", deletion: { deletionId: id(8), requestedVersion: "2",
      workerCleanup: { state: "failed", code: "execution_evidence_missing" }, serverCleanup: { state: "pending", code: null } } }, 3);
    const stop = { protocol: "daynight.session.v1" as const, sessionId: id(4), testExecutionId: intent.executionId, executionGeneration: "1",
      controllerId: intent.registration.controllerId, controllerInstanceId: intent.controllerInstanceId,
      stopProof: { kind: "never_started" as const, recordId: intent.launchId, previousControllerInstanceId: intent.controllerInstanceId, stoppedAt: "2026-11-23T00:00:00Z" } };
    const prepared = f.store.prepareDeletion(record, stop, []);
    for (const changed of [{ ...execution, launchSubmission: "unknown" }, { ...execution, launchId: id(99) }]) {
      f.database.prepare("UPDATE bot_executions SET record = ?").run(JSON.stringify(changed));
      expect(() => f.store.bindDeletionWorker(prepared, owner.workerId)).toThrow();
      expect(f.store.get(owner, id(3))!.cleanup).not.toHaveProperty("workerId");
    }
    f.database.prepare("UPDATE bot_executions SET record = ?").run(JSON.stringify(execution));
    const bound = f.store.bindDeletionWorker(prepared, owner.workerId);
    expect(() => f.store.bindDeletionWorker(bound, id(20))).toThrow(/Worker/);
    const finished = f.store.finishDeletion(bound);
    expect(f.open().get(owner, id(3))).toMatchObject({ intent: null, definition: null, cleanup: { workerId: owner.workerId, stop, localCompleted: true, targets: [] } });
    expect(f.store.bindDeletionWorker(finished, owner.workerId)).toEqual(finished);
    f.store.rejectNeverStartedDeletion(finished);
    const rejected = f.open().get(owner, id(3))!;
    expect(rejected.cleanup).not.toHaveProperty("workerId");
    expect(() => f.store.bindDeletionWorker(rejected, owner.workerId)).toThrow(/evidence/);
  });

  it("retains one cleanup Worker across final erasure and rejects malformed or replacement ownership", () => {
    const f = fixture(), original = bot();
    if (original.deletion !== null) throw new Error("fixture");
    f.store.observe(owner, original, 1);
    const intent = f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 0 });
    f.store.observe(owner, { ...original, version: "2", sessionId: id(4), testExecutionId: intent.executionId }, 2);
    const record = f.store.observe(owner, { id: id(3), workerId: owner.workerId, version: "3", deletion: { deletionId: id(8), requestedVersion: "2",
      workerCleanup: { state: "failed", code: "execution_evidence_missing" }, serverCleanup: { state: "pending", code: null } } }, 3);
    const stop = { protocol: "daynight.session.v1" as const, sessionId: id(4), testExecutionId: intent.executionId, executionGeneration: "1",
      controllerId: intent.registration.controllerId, controllerInstanceId: intent.controllerInstanceId,
      stopProof: { recordId: intent.launchId, previousControllerInstanceId: intent.controllerInstanceId, stoppedAt: "2026-11-23T00:00:00Z" } };
    const prepared = f.store.prepareDeletion(record, stop, []);
    expect(f.open().get(owner, id(3))!.cleanup).not.toHaveProperty("workerId");
    expect(() => f.store.bindDeletionWorker(prepared, "invalid")).toThrow();
    const bound = f.store.bindDeletionWorker(prepared, id(20));
    expect(() => f.store.bindDeletionWorker(bound, id(21))).toThrow(/Worker/);
    expect(() => f.store.bindDeletionWorker({ ...bound, observed: { ...bound.observed, deletion: { ...bound.observed.deletion!, deletionId: id(99) } } }, id(20))).toThrow(/identity/);
    const finished = f.store.finishDeletion(bound);
    expect(f.open().get(owner, id(3))).toMatchObject({ intent: null, definition: null, cleanup: { workerId: id(20), stop, localCompleted: true, targets: [] } });
    for (const cleanup of [{ ...finished.cleanup, workerId: "invalid" }, { ...finished.cleanup, stop: null }]) {
      f.database.prepare("UPDATE bots SET record = ?").run(JSON.stringify({ ...finished, cleanup }));
      expect(() => f.store.get(owner, id(3))).toThrow();
    }
    f.database.prepare("UPDATE bots SET record = ?").run(JSON.stringify(finished));
  });

  it("rejects stale intent and replacement deletion identity without modifying progress",()=>{
    const f=fixture();const initial=f.store.observe(owner,bot(),1);
    f.store.prepare(owner,id(3),{homeDirectory:f.home,recoveryLimit:3});
    const deleted:Bot={id:id(3),workerId:owner.workerId,version:"2",deletion:{deletionId:id(8),requestedVersion:"1",workerCleanup:{state:"pending",code:null},serverCleanup:{state:"pending",code:null}}};
    const record=f.store.observe(owner,deleted,2);
    expect(()=>f.store.prepareDeletion({...record,intent:initial.intent},null,[])).toThrow(/intent|identity/);
    expect(()=>f.store.prepareDeletion(record,null,[])).toThrow(/stop proof/);
    // Retain the uncertain registration identity rather than erase it.
    expect(f.store.get(owner,id(3))?.intent).toEqual(record.intent);
    const prepared=record;
    expect(()=>f.store.finishDeletion({...prepared,observed:{...deleted,deletion:{...deleted.deletion!,deletionId:id(9)}}})).toThrow(/identity/);
    expect(f.store.get(owner,id(3))?.cleanup).toEqual(prepared.cleanup);
  });
});
