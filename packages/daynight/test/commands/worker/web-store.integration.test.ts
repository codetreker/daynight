import path from "node:path";
import { controllerTicketPath } from "../../../src/commands/controller/launch-ticket.js";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { openSqliteDatabase } from "../../../src/platform/sqlite-access.js";
import { webExecutionStoreFormat } from "../../../src/commands/worker/backends/web-store-format.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { createWebStoreFixtures } from "./web-store.fixtures.js";

import { frozenToolLaunch } from "../../helpers/tool-launch.js";

const { id, stores, open, close, connect, externalContentFixture, fixture, blockedInitialFixture } = createWebStoreFixtures("file");

it("persists a distinct web execution without inventing Herdr resources or workspace closure", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { toolLaunch: frozenToolLaunch(), agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const started = store.initializeWebExecution(claim, 3);
  expect(started.nativeExecution).toBeNull(); expect(started.resources.herdr).toBeNull();
  const operationId = started.webExecution!.initialOperationId;
  close(store); const reopened = open(file);
  expect(reopened.initializeWebExecution(claim, 4).webExecution!.initialOperationId).toBe(operationId);
  const cleaning = reopened.beginCleanup(claim, { kind: "shutdown", deadline: 100 }, 5);
  expect(cleaning.cleanup).toEqual({ kind: "shutdown", startedAt: 5, deadline: 100, discardRecording: false });
  expect(reopened.getTask(claim)?.cleanup).toEqual(cleaning.cleanup);
  expect(connect(file).pragma("user_version", { simple: true })).toBe(5);
});

it("migrates version-two records intact, persists independent blockers, and fences old readers", () => {
  const { file, store, project, claim } = fixture();
  const original = store.register({ ...claim, project, configuration: { toolLaunch: frozenToolLaunch(), agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 }, userId: id(6) }, 1);
  close(store);
  const db = connect(file); db.exec("DROP TABLE orchestration_blockers"); db.pragma("user_version=2");
  const upgraded = open(file);
  expect(upgraded.getTask(claim)).toEqual(original);
  const blocker = upgraded.blockOrchestration(claim, { source: "worktree", code: "branch_mismatch", message: "Original branch differs." }, 2);
  close(upgraded);
  const reopened = open(file);
  expect(reopened.getOrchestrationBlocker(claim)).toEqual(blocker);
  expect(reopened.getTask(claim)?.recovery).toEqual({ count: 0, pauseReason: null, retryAuthorized: false });
  const oldFormat = { ...webExecutionStoreFormat, migrations: webExecutionStoreFormat.migrations.slice(0, 1) };
  expect(() => openSqliteDatabase({ file, format: oldFormat, allowCreate: true })).toThrow("unsupported-version");
  expect(reopened.getOrchestrationBlocker(claim)).toEqual(blocker);
  expect(() => reopened.clearOrchestration(claim, { ...blocker, observedAt: 3 }, null, 4)).toThrow("changed during verification");
});

it("retains shutdown provenance across worker reopen without resetting recovery state", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { toolLaunch: frozenToolLaunch(), agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 0 }, userId: id(6) }, 1);
  store.initializeWebExecution(claim, 3);
  store.updateWebExecution(claim, { launchSubmission: "acknowledged" }, 4);
  store.bindNativeSession(claim, { source: "controller", sessionId: id(7) }, 5);
  store.beginCleanup(claim, { kind: "shutdown", deadline: 100 }, 6);
  store.clearShutdown(claim, 10); close(store); const reopened = open(file);
  const task = reopened.getTask(claim)!;
  expect(task.webExecution).toHaveProperty("restartAfterShutdown", true);
  const next = reopened.beginWebGeneration(claim, { executionGeneration: task.webExecution!.executionGeneration, controllerInstanceId: task.webExecution!.controllerInstanceId, nativeSessionId: id(7), nativeStopped: true }, 11);
  expect(next.webExecution).toHaveProperty("restartAfterShutdown", false);
  expect(next.recovery).toEqual(task.recovery);
});

it.each([false, true])("binds the first verified native identity and its blocker atomically across shutdown and reopen (retry=%s)", retry => {
  const f = blockedInitialFixture();
  if (retry) f.store.pauseRecovery(f.task, "Original native failure", 5);
  f.store.beginCleanup(f.task, { kind: "shutdown", deadline: 100 }, 6);
  const bound = f.store.bindNativeSession(f.task, { source: "controller", sessionId: id(7) }, 7, f.observed);
  const expected = { ...f.blocker, identity: { ...f.blocker.identity, nativeSessionId: id(7) } };
  expect(f.store.getOrchestrationBlocker(f.task)).toEqual(expected);
  expect(bound.webExecution).toEqual(f.task.webExecution);
  expect(f.store.bindNativeSession(f.task, { source: "controller", sessionId: id(7) }, 8).resources).toEqual(bound.resources);
  close(f.store);
  const reopened = open(f.file);
  expect(reopened.getOrchestrationBlocker(f.task)).toEqual(expected);
  reopened.clearShutdown(f.task, 9);
  if (retry) reopened.authorizeRecoveryRetry(f.task, 10);
  const before = reopened.getTask(f.task)!;
  const cleared = reopened.clearOrchestration(f.task, expected, f.observed, 11);
  expect(cleared.recovery).toEqual(before.recovery);
  expect(reopened.getOrchestrationBlocker(f.task)).toBeNull();
  expect(cleared.resources.nativeSession?.sessionId).toBe(id(7));
});

it("binds a blocked native identity using the original Windows launch Job enrichment", () => {
  const f = blockedInitialFixture();
  const controllerProcess = { ...f.observed.controllerProcess!, processGroupId: null };
  const task = f.store.updateWebExecution(f.task, { controllerProcess }, 5);
  const observed = { ...f.observed, controllerProcess: { ...controllerProcess, jobObjectName: `Local\\Daynight-${task.webExecution!.launchId}` } };
  expect(() => f.store.bindNativeSession(task, { source: "controller", sessionId: id(7) }, 6, { ...observed, controllerProcess: { ...observed.controllerProcess, jobObjectName: `Local\\Daynight-${id(90)}` } })).toThrow("original generation");
  expect(f.store.getOrchestrationBlocker(task)).toEqual(f.blocker);
  const bound = f.store.bindNativeSession(task, { source: "controller", sessionId: id(7) }, 7, observed);
  expect(bound.resources.nativeSession?.sessionId).toBe(id(7));
  expect(f.store.getOrchestrationBlocker(task)?.identity.nativeSessionId).toBe(id(7));
  close(f.store);
  expect(open(f.file).getTask(task)?.resources.nativeSession?.sessionId).toBe(id(7));
});

it("keeps completed versioned executions available for archive backfill after reopening", () => {
  const { file, store, project, claim } = fixture();
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  store.register({ ...claim, project, configuration, userId: id(6) }, 1);
  const started = store.initializeWebExecution(claim, 2);
  store.updateWebExecution(claim, { launchSubmission: "acknowledged", sessionId: id(7) }, 3);
  store.beginCleanup(claim, { kind: "terminal", deadline: 100 }, 4);
  const completed = store.completeTask(claim, 9);
  const active = { ...claim, claimId: id(8), taskId: id(9), worktreeId: id(10) };
  store.register({ ...active, project, configuration, userId: id(6) }, 10);
  close(store);
  const reopened = open(file);
  expect(reopened.listCompletedTasks()).toEqual([completed]);
  expect(reopened.listCompletedTasks()[0]?.webExecution).toMatchObject({ executionId: started.webExecution!.executionId, launchSubmission: "acknowledged", sessionId: id(7) });
  expect(reopened.listUnfinishedTasks().map(task => task.claimId)).toEqual([active.claimId]);
});

it("migrates the previous cleanup format and preserves a one-way discard decision after completion", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  store.initializeWebExecution(claim, 2);
  store.beginCleanup(claim, { kind: "terminal", deadline: 100 }, 3);
  close(store);
  const db = connect(file);
  db.exec("UPDATE executions SET data=json_remove(data,'$.cleanup.discardRecording')");
  db.pragma("user_version=4");
  const upgraded = open(file);
  expect(upgraded.getTask(claim)?.cleanup?.discardRecording).toBe(false);
  upgraded.completeTask(claim, 4);
  expect(upgraded.discardRecording(claim, 5).cleanup?.discardRecording).toBe(true);
  close(upgraded);
  expect(open(file).getTask(claim)?.cleanup?.discardRecording).toBe(true);
});

it.each([false, true])("migrates version-one cleanup receipts to resource intent without trusting their outcome (%s)", observed => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { toolLaunch: frozenToolLaunch(), agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  store.initializeWebExecution(claim, 2);
  store.updateWebExecution(claim, { cleanupOperationId: id(7) }, 3);
  const original = store.beginCleanup(claim, { kind: "terminal", deadline: 100 }, 4);
  close(store);
  const db = connect(file);
  const legacy = { ...original, cleanup: { ...original.cleanup, mode: "web", input: "submitted", baseline: { stateChangeSeq: 5, completionSeq: 3 }, result: "completed", error: null, agentStopped: observed, workspaceClosed: null, backendResourcesClosed: observed, worktreeDeleted: observed } };
  db.prepare("UPDATE executions SET data=?").run(JSON.stringify(legacy));
  db.exec("DROP TABLE orchestration_blockers"); db.pragma("user_version=1");
  const events: unknown[] = [];
  const upgraded = openWebExecutionStore(file, { onMigration: event => { events.push(event); } }); stores.add(upgraded);
  expect(upgraded.getTask(claim)).toEqual(original);
  expect(upgraded.getTask(claim)?.cleanup).toEqual({ kind: "terminal", startedAt: 4, deadline: 100, discardRecording: false });
  expect(upgraded.getTask(claim)?.webExecution?.cleanupOperationId).toBe(id(7));
  expect(db.pragma("user_version", { simple: true })).toBe(5);
  expect(events).toMatchObject([{ kind: "started", fromVersion: 1, toVersion: 5 }, { kind: "completed", fromVersion: 1, toVersion: 5 }]);
  close(upgraded);
  expect(open(file).getTask(claim)).toEqual(original);
});

it("rebuilds the current unversioned schema and discards its execution records", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { toolLaunch: frozenToolLaunch(), agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  store.initializeWebExecution(claim, 2);
  close(store);
  const db = connect(file); db.pragma("user_version = 0");
  const events: unknown[] = [];
  const rebuilt = openWebExecutionStore(file, { onMigration: event => { events.push(event); } }); stores.add(rebuilt);
  expect(db.pragma("user_version", { simple: true })).toBe(5);
  expect(db.prepare("SELECT * FROM executions").all()).toEqual([]);
  expect(rebuilt.getTask(claim)).toBeNull();
  expect(events).toMatchObject([{ kind: "started", fromVersion: 0, toVersion: 5 }, { kind: "completed", fromVersion: 0, toVersion: 5 }]);
  close(rebuilt); events.length = 0;
  const reopened = openWebExecutionStore(file, { onMigration: event => { events.push(event); } }); stores.add(reopened);
  expect(events).toEqual([]);
});

it("restores FTS5 external content and its index when the Web baseline fails after cleanup", () => {
  const { file, db } = externalContentFixture();
  const schema = db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all();
  const rows = db.prepare("SELECT * FROM search_content ORDER BY id").all();
  const matches = db.prepare("SELECT rowid, body FROM search WHERE search MATCH 'searchable OR retained' ORDER BY rowid").all();
  expect(matches).toEqual([{ rowid: 1, body: "original searchable content" }, { rowid: 2, body: "retained external row" }]);
  const failure = new Error("Web baseline failed"), exec = Database.prototype.exec;
  let cleaned = false;
  vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
    if (sql.includes("CREATE TABLE executions (")) {
      expect(this.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all()).toEqual([]);
      expect(this.pragma("writable_schema", { simple: true })).toBe(0);
      cleaned = true;
      exec.call(this, sql);
      throw failure;
    }
    return exec.call(this, sql);
  });
  expect(() => open(file)).toThrow("migration-failed");
  expect(cleaned).toBe(true);
  expect(db.pragma("user_version", { simple: true })).toBe(0);
  expect(db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
  expect(db.prepare("SELECT * FROM search_content ORDER BY id").all()).toEqual(rows);
  expect(db.prepare("SELECT rowid, body FROM search WHERE search MATCH 'searchable OR retained' ORDER BY rowid").all()).toEqual(matches);
});

it("rejects newer and unknown nonzero table formats without deleting state", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { toolLaunch: frozenToolLaunch(), agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  close(store);
  const db = connect(file), before = db.prepare("SELECT * FROM executions").all();
  db.pragma("user_version=6");
  expect(() => open(file)).toThrow("unsupported-version");
  expect(db.pragma("user_version", { simple: true })).toBe(6);
  expect(db.prepare("SELECT * FROM executions").all()).toEqual(before);
  db.pragma("user_version=4"); db.exec("CREATE TABLE unexpected(value TEXT); INSERT INTO unexpected VALUES('retained')");
  expect(() => open(file)).toThrow("invalid-format");
  expect(db.pragma("user_version", { simple: true })).toBe(4);
  expect(db.prepare("SELECT * FROM executions").all()).toEqual(before);
  expect(db.prepare("SELECT value FROM unexpected").get()).toEqual({ value: "retained" });
});

it("commits an exhausted recovery pause and preserves it across reopen and shutdown", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { toolLaunch: frozenToolLaunch(), agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 1 }, userId: id(6) }, 1);
  store.initializeWebExecution(claim, 2);
  store.bindNativeSession(claim, { source: "controller", sessionId: id(7) }, 3);
  store.beginRecovery(claim, 4);
  const paused = store.beginRecovery(claim, 5);
  expect(paused.recovery).toEqual({ count: 1, pauseReason: "The execution recovery budget is exhausted.", retryAuthorized: false, reasonCode: "recovery_limit" });
  close(store);
  const reopened = open(file);
  expect(reopened.getTask(claim)?.recovery).toEqual(paused.recovery);
  reopened.beginCleanup(claim, { kind: "shutdown", deadline: 100 }, 6);
  const restored = reopened.clearShutdown(claim, 9);
  expect(restored.recovery).toEqual(paused.recovery);
  expect(restored.resources.nativeSession?.sessionId).toBe(id(7));
  expect(() => reopened.beginWebGeneration(claim, { executionGeneration: restored.webExecution!.executionGeneration, controllerInstanceId: restored.webExecution!.controllerInstanceId, nativeSessionId: id(7), nativeStopped: true }, 10)).toThrow("explicit recovery retry");
  reopened.authorizeRecoveryRetry(claim, 10);
  expect(() => reopened.beginRecovery(claim, 11)).toThrow("generation transition");
  const execution = restored.webExecution!;
  const proof = { executionGeneration: execution.executionGeneration, controllerInstanceId: execution.controllerInstanceId, nativeSessionId: id(7), nativeStopped: true };
  expect(() => reopened.beginWebGeneration(claim, { ...proof, nativeSessionId: id(8) }, 11)).toThrow("native identity");
  expect(reopened.getTask(claim)?.recovery).toEqual({ count: 1, pauseReason: paused.recovery.pauseReason, retryAuthorized: true, reasonCode: "recovery_limit" });
  const pending = reopened.beginWebGeneration(claim, proof, 12);
  expect(pending.recovery).toEqual({ count: 2, pauseReason: null, retryAuthorized: true });
  expect(pending.webExecution?.executionGeneration).toBe("2");
  expect(() => reopened.beginWebGeneration(claim, { ...proof, executionGeneration: "2", controllerInstanceId: pending.webExecution!.controllerInstanceId }, 13)).toThrow("awaiting a successful observation");
  reopened.pauseRecovery(claim, "The authorized attempt failed.", 14);
  expect(reopened.beginRecovery(claim, 15).recovery.count).toBe(2);
});

it.each(["birth", "linux:v1:876b21c9-30d7-48c0-a2ab-287291e903a7:9007199254740993"])("atomically consumes an explicit retry for the same unsubmitted intent across reopen (%s)", startedAt => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { toolLaunch: frozenToolLaunch(), agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 0 }, userId: id(6) }, 1);
  let original = store.initializeWebExecution(claim, 2);
  const controllerProcess = { pid: 123, parentPid: 1, processGroupId: 123, startedAt, commandHash: "a".repeat(64) };
  original = store.updateWebExecution(original, { sessionId: id(8), controllerProcess, initialPrompt: "original assignment", launchSubmission: "acknowledged" }, 3);
  original = store.bindNativeSession(original, { source: "controller", sessionId: id(7) }, 4);
  const execution = original.webExecution!;
  const previous: import("../../../src/commands/controller/lifecycle-store.js").ControllerSnapshot = { executionId: execution.executionId, claimId: claim.claimId, sessionId: id(8), executionGeneration: execution.executionGeneration, controllerInstanceId: execution.controllerInstanceId, lifecycle: "stopped", nativeSessionId: id(7), initialInputState: "confirmed", activity: "stopped", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, controllerProcess, nativeProcesses: [], nativeStopped: true, stoppedAt: new Date(0).toISOString(), error: "Original failure" };
  store.authorizeRecoveryRetry(original, 5);
  const allocated = store.beginWebGeneration(original, previous, 6);
  store.pauseRecovery(allocated, "Preparation failed.", 7);
  const authorized = store.authorizeRecoveryRetry(allocated, 8);
  expect(() => store.retryUnsubmittedWebGeneration(authorized, { ...previous, claimId: id(9) }, 9)).toThrow("preceding stopped generation");
  expect(store.getTask(claim)?.recovery).toEqual(authorized.recovery);
  const retried = store.retryUnsubmittedWebGeneration(authorized, previous, 10);
  expect(retried.webExecution).toEqual(allocated.webExecution);
  expect(retried.recovery).toEqual({ count: 2, pauseReason: null, retryAuthorized: true });
  close(store);
  const reopened = open(file);
  expect(reopened.getTask(claim)?.webExecution).toEqual(allocated.webExecution);
  expect(reopened.getTask(claim)?.recovery).toEqual(retried.recovery);
  expect(() => reopened.retryUnsubmittedWebGeneration(claim, previous, 11)).toThrow("preceding stopped generation");
  expect(reopened.getTask(claim)?.recovery.count).toBe(2);
});

it("retains startup revision through reopen, rejects invalid persisted evidence, and resets it at a proven generation change", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { toolLaunch: frozenToolLaunch(), agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  store.initializeWebExecution(claim, 2);
  const task = store.updateWebExecution(claim, { sessionId: id(8) }, 3);
  store.bindNativeSession(claim, { source: "controller", sessionId: id(7) }, 4);
  const first = store.observeStartup(claim, { state: "unknown", reasonCode: "native_timeout" }, 20)!;
  close(store); const reopened = open(file);
  expect(reopened.observeStartup(claim, first.startup, 30)).toEqual(first);
  const next = reopened.beginWebGeneration(claim, { executionGeneration: task.webExecution!.executionGeneration, controllerInstanceId: task.webExecution!.controllerInstanceId, nativeSessionId: id(7), nativeStopped: true }, 31);
  expect(next.webExecution?.startupReport).toBeUndefined();
  expect(() => reopened.observeStartup(task, { state: "ready", reasonCode: "ready" }, 32)).toThrow("generation");
  expect(reopened.observeStartup(claim, { state: "starting", reasonCode: "initializing" }, 32)).toMatchObject({ executionGeneration: "2", revision: "1", recovery: { state: "none", reasonCode: null } });
  const db = connect(file);
  const row = db.prepare("SELECT identity,data FROM executions").get() as { identity: string; data: string };
  const data = JSON.parse(row.data); data.webExecution.startupReport.startup = { state: "failed", reasonCode: "native_timeout" };
  db.prepare("UPDATE executions SET data=? WHERE identity=?").run(JSON.stringify(data), row.identity);
  expect(() => reopened.getTask(claim)).toThrow();
});

const unsubmittedLaunchFixture = (recovery = false) => {
  const f = fixture();
  f.store.register({ ...f.claim, project: f.project, configuration: { toolLaunch: frozenToolLaunch(), agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 }, userId: id(6) }, 1);
  f.store.initializeWebExecution(f.claim, 2);
  f.store.updateWebExecution(f.claim, { sessionId: id(7), initialPrompt: "Preserve the original managed prompt.", nativeHome: path.join(f.root, "native") }, 3);
  if (recovery) {
    const initial = f.store.updateWebExecution(f.claim, { launchSubmission: "acknowledged", initialInputState: "confirmed" }, 4);
    f.store.bindNativeSession(f.claim, { source: "controller", sessionId: id(8) }, 5);
    f.store.pauseRecovery(f.claim, "Retry the original native context.", 6);
    f.store.authorizeRecoveryRetry(f.claim, 7);
    f.store.beginWebGeneration(f.claim, { executionGeneration: "1", controllerInstanceId: initial.webExecution!.controllerInstanceId, nativeSessionId: id(8), nativeStopped: true }, 8);
  }
  const execution = f.store.getTask(f.claim)!.webExecution!;
  f.store.updateWebExecution(f.claim, { ticketPath: controllerTicketPath(f.root, execution.launchId) }, 9);
  f.store.observeStartup(f.claim, { state: "starting", reasonCode: "initializing" }, 10);
  return { ...f, original: f.store.getTask(f.claim)! };
};

it.each([false, true])("atomically renews an unsubmitted Web launch without changing its execution across reopen (recovery=%s)", recovery => {
  const f = unsubmittedLaunchFixture(recovery), old = f.original.webExecution!;
  const replaced = f.store.replaceUnsubmittedWebLaunch(f.original, id(50), f.root, 11);
  expect(replaced).toEqual({ ...f.original, updatedAt: 11, webExecution: { ...old, launchId: id(50), ticketPath: controllerTicketPath(f.root, id(50)) } });
  close(f.store);
  const reopened = open(f.file), readback = reopened.getTask(f.claim)!;
  expect(readback).toEqual(replaced);
  const next = reopened.replaceUnsubmittedWebLaunch(readback, id(51), f.root, 12);
  expect(next.webExecution).toEqual({ ...old, launchId: id(51), ticketPath: controllerTicketPath(f.root, id(51)) });
  expect(next.configuration).toEqual(f.original.configuration);
  expect(next.recovery).toEqual(f.original.recovery);
  expect(next.resources).toEqual(f.original.resources);
  expect(() => reopened.replaceUnsubmittedWebLaunch(next, id(51), f.root, 13)).toThrow("new identity");
  expect(reopened.getTask(f.claim)).toEqual(next);
});

it.each([false, true])("preserves observation-only missing evidence while renewing an unsubmitted launch (recovery=%s)", recovery => {
  const f = unsubmittedLaunchFixture(recovery);
  const report = f.store.observeStartup(f.claim, { state: "unknown", reasonCode: "evidence_missing" }, 11)!;
  const original = f.store.getTask(f.claim)!;
  const replaced = f.store.replaceUnsubmittedWebLaunch(original, id(50), f.root, 12);
  expect(replaced).toEqual({ ...original, updatedAt: 12, webExecution: { ...original.webExecution!, launchId: id(50), ticketPath: controllerTicketPath(f.root, id(50)) } });
  close(f.store);
  const reopened = open(f.file);
  expect(reopened.getTask(f.claim)).toEqual(replaced);
  expect(reopened.getTask(f.claim)!.webExecution!.startupReport).toEqual(report);
  const submitted = reopened.updateWebExecution(f.claim, { launchSubmission: "unknown" }, 13);
  expect(() => reopened.replaceUnsubmittedWebLaunch(submitted, id(51), f.root, 14)).toThrow("never-submitted");
  expect(reopened.getTask(f.claim)).toEqual(submitted);
});

it("fences a stale launch replacement after another SQLite connection replaces or submits it", () => {
  const f = unsubmittedLaunchFixture(), competing = open(f.file);
  const replaced = competing.replaceUnsubmittedWebLaunch(f.original, id(50), f.root, 11);
  expect(() => f.store.replaceUnsubmittedWebLaunch(f.original, id(51), f.root, 12)).toThrow("changed during launch replacement");
  expect(f.store.getTask(f.claim)).toEqual(replaced);
  const submitted = competing.updateWebExecution(f.claim, { launchSubmission: "unknown" }, 13);
  expect(() => f.store.replaceUnsubmittedWebLaunch(replaced, id(51), f.root, 14)).toThrow("changed during launch replacement");
  expect(() => f.store.replaceUnsubmittedWebLaunch(submitted, id(51), f.root, 14)).toThrow("never-submitted");
  expect(f.store.getTask(f.claim)).toEqual(submitted);
});

it.each(["owner", "configuration", "resources", "recovery", "execution"] as const)("rejects changed %s in a caller's Web replacement snapshot", changed => {
  const f = unsubmittedLaunchFixture(), stale = structuredClone(f.original);
  if (changed === "owner") stale.workerId = id(90);
  if (changed === "configuration") stale.configuration!.model = "another-model";
  if (changed === "resources") stale.resources.nativeSession = { source: "controller", sessionId: id(90) };
  if (changed === "recovery") stale.recovery.count += 1;
  if (changed === "execution") stale.webExecution!.initialPrompt = "Different prompt";
  expect(() => f.store.replaceUnsubmittedWebLaunch(stale, id(50), f.root, 11)).toThrow("changed during launch replacement");
  expect(f.store.getTask(f.claim)).toEqual(f.original);
});

it.each(["unknown", "acknowledged", "controller", "native", "input", "startup-unknown", "startup-transport", "startup-timeout", "startup-ready", "startup-native-failure", "paused", "cleanup", "blocker"] as const)("retains %s evidence instead of renewing an unsafe Web launch", evidence => {
  const f = unsubmittedLaunchFixture();
  const proof = { pid: 123, parentPid: 1, processGroupId: 123, startedAt: "birth", commandHash: "a".repeat(64) };
  if (evidence === "unknown" || evidence === "acknowledged") f.store.updateWebExecution(f.claim, { launchSubmission: evidence }, 11);
  if (evidence === "controller") f.store.updateWebExecution(f.claim, { controllerProcess: proof }, 11);
  if (evidence === "native") f.store.updateWebExecution(f.claim, { nativeProcesses: [proof] }, 11);
  if (evidence === "input") f.store.updateWebExecution(f.claim, { initialInputState: "unknown" }, 11);
  if (evidence === "startup-unknown") f.store.observeStartup(f.claim, { state: "unknown", reasonCode: "controller_start_unknown" }, 11);
  if (evidence === "startup-transport") f.store.observeStartup(f.claim, { state: "unknown", reasonCode: "native_transport_unknown" }, 11);
  if (evidence === "startup-timeout") f.store.observeStartup(f.claim, { state: "unknown", reasonCode: "native_timeout" }, 11);
  if (evidence === "startup-ready") f.store.observeStartup(f.claim, { state: "ready", reasonCode: "ready" }, 11);
  if (evidence === "startup-native-failure") f.store.observeStartup(f.claim, { state: "failed", reasonCode: "native_rejected" }, 11);
  if (evidence === "paused") f.store.pauseRecovery(f.claim, "Uncertain prior execution", 11);
  if (evidence === "cleanup") f.store.beginCleanup(f.claim, { kind: "terminal", deadline: 100 }, 11);
  if (evidence === "blocker") f.store.blockOrchestration(f.claim, { source: "worktree", code: "branch_mismatch", message: "Original branch differs." }, 11);
  const original = f.store.getTask(f.claim)!, blocker = f.store.getOrchestrationBlocker(f.claim);
  expect(() => f.store.replaceUnsubmittedWebLaunch(original, id(50), f.root, 12)).toThrow();
  expect(f.store.getTask(f.claim)).toEqual(original);
  expect(f.store.getOrchestrationBlocker(f.claim)).toEqual(blocker);
});

it("rolls back replacement on invalid commit time and rejects a different private home", () => {
  const f = unsubmittedLaunchFixture();
  expect(() => f.store.replaceUnsubmittedWebLaunch(f.original, id(50), f.root, -1)).toThrow();
  expect(f.store.getTask(f.claim)).toEqual(f.original);
  expect(() => f.store.replaceUnsubmittedWebLaunch(f.original, id(50), path.join(f.root, "other-home"), 11)).toThrow("original private home");
  expect(f.store.getTask(f.claim)).toEqual(f.original);
});
