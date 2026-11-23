import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { workerStoreFormat } from "../../../src/commands/worker/store-format.js";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openBotExecutionStore } from "../../../src/commands/worker/bots/execution-store.js";
import type { Bot } from "../../../src/commands/worker/bots/types.js";
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
