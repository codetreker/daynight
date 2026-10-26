import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isUnstartedPending, openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { ControlIntent, FrozenExecutionConfiguration, PendingClaim } from "../../../src/commands/worker/types.js";
import type { HerdrLaunchEvidence, HerdrStopObservation, HerdrTaskBinding, HerdrWorkspaceEvidence } from "../../../src/commands/worker/herdr/agents.js";

const root = fileURLToPath(new URL("../../../../../.tmp/worker-store-tests/", import.meta.url));
const directories: string[] = [];
const stores = new Set<WorkerStore>();
const connections = new Set<Database.Database>();
const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const project = { serverOrigin: "https://daynight.example", projectId: uuid(1) };
const claim: PendingClaim = { ...project, taskId: uuid(2), claimId: uuid(3), workerId: uuid(4), worktreeId: uuid(5) };
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const configuration: FrozenExecutionConfiguration = { agent: "codex", model: null, args: ["--search"], recoveryLimit: 2 };
const release: ControlIntent = { kind: "release", sourceClaimId: claim.claimId, version: "9223372036854775806" };
const open = (file: string): WorkerStore => { const store = openWorkerStore(file); stores.add(store); return store; };
const close = (store: WorkerStore): void => { store.close(); stores.delete(store); };
const connect = (file: string): Database.Database => { const db = new Database(file); connections.add(db); return db; };
const fixture = () => {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "SQLite 用户 "));
  directories.push(directory);
  const file = path.join(directory, "state.sqlite");
  const store = open(file);
  const mapping = { ...project, repoUrl: "https://github.com/owner/repo.git", localPath: path.join(directory, "repo") };
  const register = (): void => { store.registerProject(mapping); store.registerPending(claim, { kind: "new", configuration }, 10); };
  const start = (): void => { register(); store.activateTask(claim, 20); };
  const bind = (): void => {
    store.bindWorktree(claim, { repositoryPath: mapping.localPath, commonDirectory: path.join(mapping.localPath, ".git"), worktreePath: path.join(mapping.localPath, ".worktrees", "daynight", claim.taskId), branch: `daynight/${claim.taskId}` }, 21);
    store.bindHerdr(claim, { session: "w", workspaceId: "workspace-original", paneId: "pane-original" }, 22);
    store.bindNativeSession(claim, { sessionId: "native-original", source: "herdr" }, 23);
  };
  const cleanup = (): void => {
    store.beginCleanup(claim, { kind: "terminal", deadline: 600_030 }, 30);
    store.markCleanupInputSubmitting(claim, 31);
    store.recordCleanupInputOutcome(claim, "submitted", 32);
    store.recordCleanupResult(claim, "completed", null, 33);
    store.confirmAgentStopped(claim, { agentStopped: true }, 34);
    store.confirmWorkspaceClosed(claim, { workspaceClosed: true }, 35);
    store.confirmWorktreeDeleted(claim, { worktreeDeleted: true }, 36);
  };
  return { directory, file, store, mapping, register, start, bind, cleanup };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.clear();
  for (const connection of connections) if (connection.open) connection.close();
  connections.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("worker SQLite schema and project bindings", () => {
  it("initializes an empty ownership-gate database with only projects/tasks and WAL/FULL", () => {
    const pragma = vi.spyOn(Database.prototype, "pragma");
    const { file, store } = fixture();
    const sql = connect(file);
    expect(sql.pragma("user_version", { simple: true })).toBe(2);
    expect(sql.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(pragma).toHaveBeenCalledWith("synchronous = FULL");
    const syncRead = pragma.mock.calls.findIndex(([statement]) => statement === "synchronous");
    expect(pragma.mock.results[syncRead]).toMatchObject({ type: "return", value: 2 });
    expect(sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "projects" }, { name: "tasks" }]);
    expect(sql.pragma("foreign_key_list(projects)")).toEqual([]);
    expect(sql.pragma("foreign_key_list(tasks)")).toEqual([]);
    expect(store.listProjects()).toEqual([]);
    expect(store.listTasks()).toEqual([]);
    close(store); sql.close();
    rmSync(file);
    const emptyGate = connect(file); emptyGate.close();
    expect(open(file).listTasks()).toEqual([]);
  });

  it("rejects unknown or wrong schemas without treating them as a fresh store", () => {
    const { file, store } = fixture();
    close(store);
    const sql = connect(file);
    sql.pragma("user_version = 3");
    expect(() => open(file)).toThrow("Unsupported worker SQLite schema version 3");
    expect(sql.pragma("user_version", { simple: true })).toBe(3);
    sql.exec("DROP TABLE projects; DROP TABLE tasks; CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('retained')");
    sql.pragma("user_version = 0");
    expect(() => open(file)).toThrow("must not contain existing tables");
    expect(sql.pragma("user_version", { simple: true })).toBe(0);
    sql.pragma("user_version = 1");
    expect(() => open(file)).toThrow("projects/tasks schema");
    expect(sql.prepare("SELECT value FROM unrelated").get()).toEqual({ value: "retained" });
    expect(() => openWorkerStore("relative.sqlite")).toThrow("must be absolute");
    expect(() => openWorkerStore(file, { busyTimeoutMs: 0 })).toThrow("safe integer");
  });

  it("requires a prior project mapping and preserves service scopes", () => {
    const f = fixture();
    expect(() => f.store.registerPending(claim, { kind: "new", configuration }, 10)).toThrow("persisted before claiming");
    expect(f.store.getProject(project)).toBeNull();
    f.register();
    expect(f.store.getTask({ ...claim, serverOrigin: "https://another.example" })).toBeNull();
    expect(f.store.getTask({ ...claim, claimId: uuid(99) })).toBeNull();
    expect(f.store.getTask({ ...claim, serverOrigin: "HTTPS://DAYNIGHT.EXAMPLE/", taskId: claim.taskId.toUpperCase() })?.claimId).toBe(claim.claimId);
    expect(f.store.listProjects()).toEqual([{ ...f.mapping, claimAttempt: null }]);
  });

  it("migrates schema one transactionally without inventing launch provenance", () => {
    const f = fixture(); f.start(); f.bind();
    f.store.bindUserScope(claim, userId, 24);
    f.store.beginCleanup(claim, { kind: "terminal", deadline: 600_030 }, 30);
    const original = f.store.getTask(claim)!;
    close(f.store);
    const sql = connect(f.file);
    sql.exec("ALTER TABLE tasks DROP COLUMN native_execution; ALTER TABLE tasks DROP COLUMN user_id; ALTER TABLE projects DROP COLUMN claim_attempt; UPDATE tasks SET cleanup = json_remove(cleanup, '$.baseline'); PRAGMA user_version = 1;");
    const migrated = open(f.file);
    expect(sql.pragma("user_version", { simple: true })).toBe(2);
    expect(migrated.getTask(claim)).toEqual({ ...original, userId: null, nativeExecution: null });
    expect(migrated.getProject(project)).toEqual({ ...f.mapping, claimAttempt: null });
    expect(sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "projects" }, { name: "tasks" }]);
  });

  it("rolls back both schema one migrations and their version on invalid existing structure", () => {
    const f = fixture(); f.register(); close(f.store);
    const sql = connect(f.file);
    sql.exec("ALTER TABLE tasks DROP COLUMN native_execution; ALTER TABLE tasks DROP COLUMN user_id; PRAGMA user_version = 1;");
    expect(() => open(f.file)).toThrow("duplicate column name");
    expect(sql.pragma("user_version", { simple: true })).toBe(1);
    expect(sql.prepare("SELECT name FROM pragma_table_info('tasks') WHERE name = 'native_execution'").get()).toBeUndefined();
    expect(sql.prepare("SELECT name FROM pragma_table_info('tasks') WHERE name = 'user_id'").get()).toBeUndefined();
    expect(sql.prepare("SELECT claim_id FROM tasks").get()).toEqual({ claim_id: claim.claimId });
  });

  it.each(["pending", "active"] as const)("keeps repository bindings stable while an execution is %s", (status) => {
    const f = fixture(); f.register();
    if (status === "active") f.store.activateTask(claim, 20);
    expect(f.store.registerProject({ ...f.mapping })).toEqual({ ...f.mapping, claimAttempt: null });
    expect(() => f.store.registerProject({ ...f.mapping, repoUrl: "https://github.com/other/repo.git" })).toThrow("unfinished execution");
    expect(() => f.store.registerProject({ ...f.mapping, localPath: path.join(f.directory, "other") })).toThrow("unfinished execution");
    expect(f.store.getProject(project)).toEqual({ ...f.mapping, claimAttempt: null });
    f.cleanup(); f.store.completeTask(claim, 40);
    const changed = { ...f.mapping, repoUrl: "https://github.com/other/repo.git", localPath: path.join(f.directory, "other") };
    expect(f.store.registerProject(changed)).toEqual({ ...changed, claimAttempt: null });
    expect(f.store.getTask(claim)).toMatchObject({ repositoryPath: f.mapping.localPath, repoUrl: f.mapping.repoUrl });
  });
});

describe("durable claim acquisition uncertainty", () => {
  const attempt = { taskId: claim.taskId, claimId: claim.claimId, worktreeId: claim.worktreeId, workerId: claim.workerId, userId, expectedVersion: "9223372036854775806", configuration };

  it("persists the original attempted assignment without registering a preclaim task", () => {
    const f = fixture(); f.store.registerProject(f.mapping);
    expect(f.store.beginClaimAttempt(project, attempt)).toEqual(attempt);
    expect(() => f.store.beginClaimAttempt(project, attempt)).toThrow("cannot be replayed");
    expect(f.store.listTasks()).toEqual([]);
    expect(() => f.store.beginClaimAttempt(project, { ...attempt, claimId: uuid(50) })).toThrow("unresolved claim attempt");
    expect(() => f.store.registerProject({ ...f.mapping, localPath: path.join(f.directory, "other") })).toThrow("unresolved claim attempt");
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.getClaimAttempt(project)).toEqual(attempt);
    expect(reopened.listClaimAttempts()).toEqual([{ ...project, attempt }]);
    expect(reopened.listUnfinishedTasks()).toEqual([]);
  });

  it("requires and preserves the original authenticated user of an unresolved claim attempt", () => {
    const f = fixture(); f.store.registerProject(f.mapping);
    const { userId: _userId, ...missingUser } = attempt;
    expect(() => f.store.beginClaimAttempt(project, missingUser as never)).toThrow("Claim attempt has invalid fields");
    expect(() => f.store.beginClaimAttempt(project, { ...attempt, userId: "not-a-user-id" })).toThrow("Attempt user ID must be a UUID");
    f.store.beginClaimAttempt(project, attempt);
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.getClaimAttempt(project)?.userId).toBe(userId);
    expect(() => reopened.beginClaimAttempt(project, { ...attempt, userId: uuid(91) })).toThrow("cannot be replayed or replaced");
    expect(reopened.getClaimAttempt(project)).toEqual(attempt);
  });

  it("clears only the exact confirmed grant atomically with its original frozen pending row", () => {
    const f = fixture(); f.store.registerProject(f.mapping); f.store.beginClaimAttempt(project, attempt);
    expect(() => f.store.registerPending(claim, { kind: "new", configuration: { ...configuration, model: "changed-after-crash" } }, 10)).toThrow("original claim attempt");
    expect(f.store.getClaimAttempt(project)).toEqual(attempt);
    expect(f.store.getTask(claim)).toBeNull();
    const sql = connect(f.file);
    sql.exec("CREATE TRIGGER reject_pending BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'pending refused'); END;");
    expect(() => f.store.registerPending(claim, { kind: "new", configuration }, 10)).toThrow("pending refused");
    expect(f.store.getClaimAttempt(project)).toEqual(attempt);
    sql.exec("DROP TRIGGER reject_pending");
    expect(f.store.registerPending(claim, { kind: "new", configuration }, 10)).toMatchObject({ status: "pending", configuration, nativeExecution: { launchSubmission: "never-submitted" } });
    expect(f.store.getClaimAttempt(project)).toBeNull();
    expect(f.store.listClaimAttempts()).toEqual([]);
  });

  it("requires definite rejection of the original attempt and keeps unrelated actual grants separate", () => {
    const f = fixture(); f.store.registerProject(f.mapping); f.store.beginClaimAttempt(project, attempt);
    f.store.registerPending({ ...claim, taskId: uuid(40), claimId: uuid(41), worktreeId: uuid(42) }, { kind: "new", configuration }, 10);
    expect(f.store.getClaimAttempt(project)).toEqual(attempt);
    expect(() => f.store.rejectClaimAttempt(project, uuid(90), { definiteRejection: true })).toThrow("does not match");
    expect(() => f.store.rejectClaimAttempt(project, claim.claimId, { definiteRejection: false } as never)).toThrow("definite rejection");
    expect(f.store.getClaimAttempt(project)).toEqual(attempt);
    f.store.rejectClaimAttempt(project, claim.claimId, { definiteRejection: true });
    expect(f.store.getClaimAttempt(project)).toBeNull();
    expect(() => f.store.beginClaimAttempt(project, { ...attempt, expectedVersion: "1e3" })).toThrow("positive int64");
  });

  it("clears a proven pre-dispatch failure after restart while retaining uncertain submissions", () => {
    const f = fixture(); f.store.registerProject(f.mapping); f.store.beginClaimAttempt(project, attempt);
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.getClaimAttempt(project)).toEqual(attempt);
    expect(() => reopened.rejectClaimAttempt(project, claim.claimId, { notSubmitted: false } as never)).toThrow("proven non-submission");
    expect(() => reopened.beginClaimAttempt(project, attempt)).toThrow("cannot be replayed");
    reopened.rejectClaimAttempt(project, claim.claimId, { notSubmitted: true });
    expect(reopened.getClaimAttempt(project)).toBeNull();
    const next = { ...attempt, claimId: uuid(51), worktreeId: uuid(52), expectedVersion: "9223372036854775807" };
    expect(reopened.beginClaimAttempt(project, next)).toEqual(next);
    expect(reopened.listTasks()).toEqual([]);
  });
});

describe("native launch receipts and process provenance", () => {
  const binding: HerdrTaskBinding = { session: "w", workspaceId: "workspace-original", paneId: "pane-original", terminalId: "terminal-original" };
  const ownerLabel = `daynight:${JSON.stringify({ ...project, taskId: claim.taskId, claimId: claim.claimId, worktreeId: claim.worktreeId })}`;
  const workspaceEvidence: HerdrWorkspaceEvidence = { binding, ownerLabel, environment: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" } };
  const launchEvidence: HerdrLaunchEvidence = { binding, ownerLabel, agent: "codex", argv: ["codex", "--search", "--no-daemon"], referenceBaseline: "empty", workspaceEvidence };
  const stopObservation: HerdrStopObservation = { binding, ownerLabel, agent: "codex", nativeSessionId: null, shellPid: 123, processIds: [124, 125], observedAt: 25 };
  const prepared = () => {
    const f = fixture(); f.start(); f.bind();
    f.store.bindHerdrExecution(claim, binding, workspaceEvidence, 24);
    return f;
  };
  const shutdown = (store: WorkerStore): void => {
    store.beginCleanup(claim, { kind: "shutdown", deadline: 600_030 }, 30);
    store.recordCleanupInputOutcome(claim, "unavailable", 31);
    store.recordCleanupResult(claim, "unavailable", null, 32);
    store.confirmAgentStopped(claim, { agentStopped: true }, 33);
    store.confirmWorkspaceClosed(claim, { workspaceClosed: true }, 34);
  };

  it("preserves submitted startup provenance and pauses a completed shutdown when its original native ID is missing", () => {
    const f = prepared();
    const sql = connect(f.file);
    sql.prepare("UPDATE tasks SET resources = json_set(resources, '$.nativeSession', json('null')) WHERE claim_id = ?").run(claim.claimId);
    f.store.markNativeLaunchSubmitting(claim, 25);
    f.store.recordNativeStartOutcome(claim, { launchEvidence, promptSubmission: "submitted" }, 26);
    f.store.recordStopObservation(claim, stopObservation, 27);
    f.store.markExecutionSummarySubmitting(claim, { version: "11", herdr: f.store.getTask(claim)!.resources.herdr, nativeSessionId: null, phase: "waiting" }, 28);
    const original = f.store.getTask(claim)!;
    shutdown(f.store); close(f.store);
    const reopened = open(f.file);
    const resumed = reopened.resumeAfterShutdown(claim, 40);
    expect(resumed).toMatchObject({ cleanup: null, resources: original.resources, nativeExecution: original.nativeExecution, recovery: { count: 0, pauseReason: expect.stringContaining("original native session ID is missing") } });
    expect(() => reopened.markWorkspaceSubmitting(claim, 41)).toThrow("original native session ID is missing");
    reopened.authorizeRecoveryRetry(claim, 42);
    reopened.beginRecovery(claim, 43);
    expect(() => reopened.markWorkspaceSubmitting(claim, 44)).toThrow("original native session ID is missing");
    expect(() => reopened.markNativeLaunchSubmitting(claim, 44)).toThrow("proven unlaunched");
    expect(reopened.getTask(claim)?.nativeExecution).toEqual(original.nativeExecution);
    close(reopened);
    expect(open(f.file).getTask(claim)?.nativeExecution).toEqual(original.nativeExecution);
  });

  it("keeps unknown legacy launch provenance after shutdown without inventing an original native ID", () => {
    const f = fixture(); f.store.registerProject(f.mapping);
    f.store.registerPending(claim, { kind: "recovered", configuration }, 10);
    f.store.activateTask(claim, 20);
    shutdown(f.store);
    const resumed = f.store.resumeAfterShutdown(claim, 40);
    expect(resumed).toMatchObject({ cleanup: null, nativeExecution: null, resources: { nativeSession: null }, recovery: { pauseReason: expect.stringContaining("original native session ID is missing") } });
    expect(() => f.store.markWorkspaceSubmitting(claim, 41)).toThrow("persisted provenance");
  });

  it("prepares fresh Herdr resources for a known original native ID after shutdown", () => {
    const f = prepared();
    f.store.markNativeLaunchSubmitting(claim, 25);
    f.store.recordNativeStartOutcome(claim, { launchEvidence, promptSubmission: "submitted" }, 26);
    shutdown(f.store);
    const original = f.store.getTask(claim)!;
    const resumed = f.store.resumeAfterShutdown(claim, 40);
    expect(resumed.resources).toEqual({ ...original.resources, herdr: null });
    expect(resumed.nativeExecution).toMatchObject({ launchSubmission: "never-submitted", promptSubmission: "not-submitted", terminalId: null });
    expect(resumed.recovery.pauseReason).toBeNull();
    expect(f.store.markWorkspaceSubmitting(claim, 41).nativeExecution?.workspaceSubmission).toBe("unknown");
  });

  it("preserves the genuine first-launch path for a proven never-launched shutdown without a native ID", () => {
    const f = prepared();
    const sql = connect(f.file);
    sql.prepare("UPDATE tasks SET resources = json_set(resources, '$.nativeSession', json('null')) WHERE claim_id = ?").run(claim.claimId);
    shutdown(f.store);
    const resumed = f.store.resumeAfterShutdown(claim, 40);
    expect(resumed.resources.nativeSession).toBeNull();
    expect(resumed.resources.herdr).toBeNull();
    expect(resumed.recovery.pauseReason).toBeNull();
    expect(resumed.nativeExecution?.launchSubmission).toBe("never-submitted");
    expect(f.store.markWorkspaceSubmitting(claim, 41).nativeExecution?.workspaceSubmission).toBe("unknown");
  });

  it("fences an unknown initial workspace create across restart and adopts its actual binding without inventing environment evidence", () => {
    const f = fixture(); f.start();
    f.store.bindWorktree(claim, { repositoryPath: f.mapping.localPath, commonDirectory: path.join(f.mapping.localPath, ".git"), worktreePath: path.join(f.mapping.localPath, ".worktrees", "daynight", claim.taskId), branch: `daynight/${claim.taskId}` }, 21);
    expect(f.store.markWorkspaceSubmitting(claim, 22).nativeExecution?.workspaceSubmission).toBe("unknown");
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.getTask(claim)).toMatchObject({ resources: { herdr: null }, nativeExecution: { workspaceSubmission: "unknown", launchSubmission: "never-submitted" } });
    expect(() => reopened.markWorkspaceSubmitting(claim, 23)).toThrow("cannot be replayed");
    expect(() => reopened.recordWorkspaceNotSubmitted(claim, { notSubmitted: false } as never, 23)).toThrow("proven non-submission");
    expect(reopened.bindHerdrExecution(claim, binding, null, 24).nativeExecution).toMatchObject({ workspaceSubmission: "acknowledged", workspaceEvidence: null });
    expect(() => reopened.markNativeLaunchSubmitting(claim, 25)).toThrow("verified workspace");
  });

  it.each([{ notSubmitted: true } as const, { definiteRejection: true } as const])("permits a fresh workspace decision only after proven no dispatch: %j", (proof) => {
    const f = prepared(); f.store.markWorkspaceSubmitting(claim, 25);
    close(f.store);
    const reopened = open(f.file);
    const before = reopened.getTask(claim)!;
    reopened.recordWorkspaceNotSubmitted(claim, proof, 26);
    expect(reopened.getTask(claim)?.nativeExecution).toEqual({ ...before.nativeExecution, workspaceSubmission: "not-submitted" });
    expect(reopened.markWorkspaceSubmitting(claim, 27).nativeExecution?.workspaceSubmission).toBe("unknown");
  });

  it("preserves original stop provenance while replacement creation is unknown after a crash", () => {
    const f = prepared(); f.store.markNativeLaunchSubmitting(claim, 25);
    f.store.recordNativeStartOutcome(claim, { launchEvidence, promptSubmission: "not-submitted" }, 26);
    expect(() => f.store.markWorkspaceSubmitting(claim, 27)).toThrow("durable original native stop");
    f.store.recordStopObservation(claim, stopObservation, 28);
    f.store.markWorkspaceSubmitting(claim, 29);
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.getTask(claim)?.nativeExecution).toMatchObject({ workspaceSubmission: "unknown", terminalId: binding.terminalId, stopObservation, launchEvidence });
    expect(() => reopened.markWorkspaceSubmitting(claim, 30)).toThrow("cannot be replayed");
    expect(() => reopened.markNativePromptSubmitting(claim, 30)).toThrow("original acknowledged launch");
    expect(() => reopened.bindHerdrExecution(claim, binding, workspaceEvidence, 30)).toThrow("previous binding");
    const next = { ...binding, workspaceId: "observed-workspace", paneId: "observed-pane", terminalId: "observed-terminal" };
    const adopted = reopened.rebindHerdrExecution(claim, binding, next, null, { originalAgentStopped: true, oldWorkspaceClosed: true }, 31);
    expect(adopted.nativeExecution).toMatchObject({ workspaceSubmission: "acknowledged", workspaceEvidence: null, stopObservation: null, launchSubmission: "never-submitted" });
    expect(adopted.resources.nativeSession).toEqual({ sessionId: "native-original", source: "herdr" });
  });

  it("durably fences launch and input before either can be submitted", () => {
    const f = prepared();
    expect(f.store.getTask(claim)?.nativeExecution).toMatchObject({ terminalId: binding.terminalId, launchSubmission: "never-submitted", promptSubmission: "not-submitted", workspaceEvidence });
    f.store.markNativeLaunchSubmitting(claim, 25);
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.getTask(claim)?.nativeExecution).toMatchObject({ launchSubmission: "unknown", promptSubmission: "unknown", launchEvidence: null });
    expect(() => reopened.markNativeLaunchSubmitting(claim, 26)).toThrow("proven unlaunched");
    expect(() => reopened.markNativePromptSubmitting(claim, 26)).toThrow("proven unsubmitted");
    reopened.recordNativeStartOutcome(claim, { launchEvidence, promptSubmission: "not-submitted" }, 27);
    expect(reopened.markNativePromptSubmitting(claim, 28).nativeExecution).toMatchObject({ launchSubmission: "acknowledged", promptSubmission: "unknown" });
    reopened.recordNativeStartOutcome(claim, { promptSubmission: "submitted" }, 29);
    expect(() => reopened.recordNativeStartOutcome(claim, { promptSubmission: "not-submitted" }, 30)).toThrow("cannot become unsubmitted");
    expect(reopened.getTask(claim)?.resources.herdr).toEqual({ session: "w", workspaceId: binding.workspaceId, paneId: binding.paneId });
  });

  it.each([{ notSubmitted: true } as const, { definiteRejection: true } as const])("restores a proven pre-dispatch launch failure for retry after restart: %j", (proof) => {
    const f = prepared();
    const sql = connect(f.file);
    sql.prepare("UPDATE tasks SET resources = json_set(resources, '$.nativeSession.sessionId', ?) WHERE claim_id = ?").run(uuid(88), claim.claimId);
    f.store.markExecutionSummarySubmitting(claim, { version: "11", herdr: f.store.getTask(claim)!.resources.herdr, nativeSessionId: uuid(88), phase: "preparing" }, 24);
    f.store.markNativeLaunchSubmitting(claim, 25);
    close(f.store);
    const reopened = open(f.file);
    const before = reopened.getTask(claim)!;
    expect(() => reopened.recordNativeLaunchNotSubmitted(claim, { notSubmitted: false } as never, 26)).toThrow("proven non-submission");
    const restored = reopened.recordNativeLaunchNotSubmitted(claim, proof, 27);
    expect(restored.nativeExecution).toEqual({ ...before.nativeExecution, launchSubmission: "never-submitted", promptSubmission: "not-submitted" });
    expect(restored.resources).toEqual(before.resources);
    expect(restored.configuration).toEqual(before.configuration);
    expect(reopened.markNativeLaunchSubmitting(claim, 28).nativeExecution).toMatchObject({ launchSubmission: "unknown", promptSubmission: "unknown" });
  });

  it("never resets acknowledged native launch for rejected deferred input or observed native processes", () => {
    const f = prepared(); f.store.markNativeLaunchSubmitting(claim, 25);
    f.store.recordNativeStartOutcome(claim, { launchEvidence, promptSubmission: "not-submitted" }, 26);
    f.store.markNativePromptSubmitting(claim, 27);
    f.store.recordNativeStartOutcome(claim, { promptSubmission: "not-submitted" }, 28);
    expect(() => f.store.recordNativeLaunchNotSubmitted(claim, { definiteRejection: true }, 29)).toThrow("only before acknowledged launch");
    expect(f.store.getTask(claim)?.nativeExecution).toMatchObject({ launchSubmission: "acknowledged", promptSubmission: "not-submitted", launchEvidence });
    const g = prepared(); g.store.markNativeLaunchSubmitting(claim, 25);
    g.store.recordStopObservation(claim, stopObservation, 26);
    expect(() => g.store.recordNativeLaunchNotSubmitted(claim, { notSubmitted: true }, 27)).toThrow("native process evidence");
  });

  it("retains proven never-launched cleanup provenance after a rejected native start", () => {
    const f = prepared(); f.store.markNativeLaunchSubmitting(claim, 25);
    f.store.recordNativeLaunchNotSubmitted(claim, { notSubmitted: true }, 26);
    f.store.beginCleanup(claim, { kind: "terminal", deadline: 600_030 }, 30);
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.getTask(claim)).toMatchObject({ nativeExecution: { launchSubmission: "never-submitted", workspaceEvidence }, cleanup: { kind: "terminal", deadline: 600_030 } });
    expect(() => reopened.markNativeLaunchSubmitting(claim, 31)).toThrow("control or cleanup");
    reopened.recordCleanupInputOutcome(claim, "unavailable", 32);
    reopened.recordCleanupResult(claim, "unavailable", null, 33);
    reopened.confirmAgentStopped(claim, { agentStopped: true }, 34);
    reopened.confirmWorkspaceClosed(claim, { workspaceClosed: true }, 35);
    reopened.confirmWorktreeDeleted(claim, { worktreeDeleted: true }, 36);
    expect(reopened.completeTask(claim, 37).status).toBe("done");
  });

  it("adopts unknown existing resources without inventing workspace or never-launched proof", () => {
    const f = fixture(); f.store.registerProject(f.mapping);
    f.store.registerPending(claim, { kind: "recovered", configuration: null }, 10);
    expect(f.store.getTask(claim)?.nativeExecution).toBeNull();
    f.store.beginCleanup(claim, { kind: "terminal", deadline: 600_020 }, 20); f.bind();
    const adopted = f.store.bindHerdrExecution(claim, binding, null, 24);
    expect(adopted.nativeExecution).toMatchObject({ launchSubmission: "unknown", promptSubmission: "unknown", workspaceEvidence: null });
    expect(() => f.store.markNativeLaunchSubmitting(claim, 25)).toThrow("control or cleanup");
    expect(f.store.recordStopObservation(claim, stopObservation, 25).nativeExecution?.stopObservation).toEqual(stopObservation);
  });

  it("rejects wrong claim, terminal, provider and conflicting evidence without changing stored facts", () => {
    const f = prepared();
    expect(() => f.store.bindHerdrExecution(claim, { ...binding, terminalId: "replacement" }, null, 25)).toThrow("original terminal");
    expect(() => f.store.bindHerdrExecution(claim, binding, { ...workspaceEvidence, ownerLabel: ownerLabel.replace(claim.claimId, uuid(90)) }, 25)).toThrow("cannot be replaced");
    f.store.markNativeLaunchSubmitting(claim, 25);
    expect(() => f.store.recordNativeStartOutcome(claim, { launchEvidence: { ...launchEvidence, binding: { ...binding, terminalId: "wrong" } }, promptSubmission: "submitted" }, 26)).toThrow("original Herdr binding");
    expect(() => f.store.recordNativeStartOutcome(claim, { launchEvidence: { ...launchEvidence, ownerLabel: ownerLabel.replace(claim.claimId, uuid(90)) }, promptSubmission: "submitted" }, 26)).toThrow("another claim or worktree");
    expect(() => f.store.recordNativeStartOutcome(claim, { launchEvidence: { ...launchEvidence, agent: "copilot" }, promptSubmission: "submitted" }, 26)).toThrow("frozen configuration");
    expect(f.store.getTask(claim)?.nativeExecution).toMatchObject({ launchSubmission: "unknown", promptSubmission: "unknown", launchEvidence: null });
    f.store.recordNativeStartOutcome(claim, { launchEvidence, promptSubmission: "submitted" }, 27);
    f.store.recordStopObservation(claim, stopObservation, 28);
    expect(f.store.recordStopObservation(claim, stopObservation, 29).nativeExecution?.stopObservation).toEqual(stopObservation);
    expect(() => f.store.recordStopObservation(claim, { ...stopObservation, processIds: [126] }, 30)).toThrow("cannot be replaced");
    close(f.store);
    expect(open(f.file).getTask(claim)?.nativeExecution?.stopObservation).toEqual(stopObservation);
  });

  it("resets launch facts only with exact previous binding and durable original stop provenance", () => {
    const f = prepared(); f.store.markNativeLaunchSubmitting(claim, 25);
    f.store.recordNativeStartOutcome(claim, { launchEvidence, promptSubmission: "submitted" }, 26);
    const next = { ...binding, workspaceId: "workspace-new", paneId: "pane-new", terminalId: "terminal-new" };
    const nextEvidence = { ...workspaceEvidence, binding: next };
    const proof = { originalAgentStopped: true, oldWorkspaceClosed: true } as const;
    expect(() => f.store.rebindHerdrExecution(claim, binding, next, nextEvidence, proof, 27)).toThrow("durable original stop");
    f.store.recordStopObservation(claim, stopObservation, 28);
    f.store.markWorkspaceSubmitting(claim, 29);
    expect(() => f.store.rebindHerdrExecution(claim, { ...binding, terminalId: "wrong" }, next, nextEvidence, proof, 29)).toThrow("previous full Herdr binding");
    const rebound = f.store.rebindHerdrExecution(claim, binding, next, nextEvidence, proof, 30);
    expect(rebound.nativeExecution).toEqual({ terminalId: next.terminalId, workspaceSubmission: "acknowledged", workspaceEvidence: nextEvidence, launchEvidence: null, launchSubmission: "never-submitted", promptSubmission: "not-submitted", stopObservation: null, summary: null });
    expect(rebound.resources.nativeSession).toEqual({ sessionId: "native-original", source: "herdr" });
    expect(rebound.configuration).toEqual(configuration);
  });

  it("rejects malformed stored provenance rather than silently treating it as a fresh execution", () => {
    const f = prepared();
    const sql = connect(f.file);
    const original = f.store.getTask(claim)!.nativeExecution!;
    sql.prepare("UPDATE tasks SET native_execution = ? WHERE claim_id = ?").run(JSON.stringify({ ...original, launchSubmission: "acknowledged" }), claim.claimId);
    expect(() => f.store.listUnfinishedTasks()).toThrow("requires its original launch evidence");
  });

  it("retains unknown summary writes through restart and resolves only an advanced inventory version", () => {
    const f = prepared();
    const summary = { version: "9223372036854775805", herdr: f.store.getTask(claim)!.resources.herdr, nativeSessionId: "native-original", phase: "executing" as const };
    const sql = connect(f.file);
    sql.prepare("UPDATE tasks SET resources = json_set(resources, '$.nativeSession.sessionId', ?) WHERE claim_id = ?").run(uuid(80), claim.claimId);
    const target = { ...summary, nativeSessionId: uuid(80) };
    f.store.markExecutionSummarySubmitting(claim, target, 26);
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.getTask(claim)?.nativeExecution?.summary).toEqual({ ...target, submission: "unknown" });
    expect(() => reopened.markExecutionSummarySubmitting(claim, target, 27)).toThrow("unresolved");
    expect(reopened.reconcileExecutionSummary(claim, target, 27).nativeExecution?.summary?.submission).toBe("unknown");
    expect(reopened.reconcileExecutionSummary(claim, { ...target, version: "9223372036854775806" }, 28).nativeExecution?.summary?.submission).toBe("confirmed");
    const next = { ...target, version: "9223372036854775806", phase: "waiting" as const };
    reopened.markExecutionSummarySubmitting(claim, next, 29);
    expect(reopened.reconcileExecutionSummary(claim, { ...target, version: "9223372036854775807" }, 30).nativeExecution?.summary).toBeNull();
    expect(reopened.markExecutionSummarySubmitting(claim, { ...target, version: "9223372036854775807" }, 31).nativeExecution?.summary?.submission).toBe("unknown");
    expect(() => reopened.recordExecutionSummaryOutcome(claim, target.version, "rejected", 32)).toThrow("does not match");
    expect(reopened.recordExecutionSummaryOutcome(claim, "9223372036854775807", "rejected", 33).nativeExecution?.summary?.submission).toBe("rejected");
  });

  it("carries an unresolved summary across verified shutdown resource replacement", () => {
    const f = prepared();
    const target = { version: "11", herdr: f.store.getTask(claim)!.resources.herdr, nativeSessionId: uuid(81), phase: "executing" as const };
    const sql = connect(f.file);
    sql.prepare("UPDATE tasks SET resources = json_set(resources, '$.nativeSession.sessionId', ?) WHERE claim_id = ?").run(uuid(81), claim.claimId);
    f.store.markExecutionSummarySubmitting(claim, target, 25);
    f.store.beginCleanup(claim, { kind: "shutdown", deadline: 630 }, 30);
    f.store.recordCleanupInputOutcome(claim, "unavailable", 31);
    f.store.recordCleanupResult(claim, "unavailable", null, 32);
    f.store.confirmAgentStopped(claim, { agentStopped: true }, 33);
    f.store.confirmWorkspaceClosed(claim, { workspaceClosed: true }, 34);
    const resumed = f.store.resumeAfterShutdown(claim, 35);
    expect(resumed.nativeExecution).toMatchObject({ launchSubmission: "never-submitted", terminalId: null, summary: { ...target, submission: "unknown" } });
    expect(() => f.store.markExecutionSummarySubmitting(claim, { ...target, herdr: null }, 36)).toThrow("unresolved");
  });

  it("clears only proven undispatched summary mutations and permits a fresh versioned decision", () => {
    const f = fixture(); f.start();
    const target = { version: "11", herdr: null, nativeSessionId: null, phase: "preparing" as const };
    f.store.markExecutionSummarySubmitting(claim, target, 25);
    close(f.store);
    const reopened = open(f.file);
    expect(() => reopened.recordExecutionSummaryNotSubmitted(claim, "12", { notSubmitted: true }, 26)).toThrow("does not match");
    expect(() => reopened.recordExecutionSummaryNotSubmitted(claim, "11", { notSubmitted: false } as never, 26)).toThrow("proven non-submission");
    expect(reopened.getTask(claim)?.nativeExecution?.summary?.submission).toBe("unknown");
    reopened.recordExecutionSummaryNotSubmitted(claim, "11", { notSubmitted: true }, 27);
    expect(reopened.getTask(claim)?.nativeExecution?.summary).toBeNull();
    reopened.markExecutionSummarySubmitting(claim, target, 28);
    reopened.recordExecutionSummaryOutcome(claim, "11", "rejected", 29);
    expect(() => reopened.recordExecutionSummaryNotSubmitted(claim, "11", { notSubmitted: true }, 30)).toThrow("unresolved execution summary");
    expect(reopened.getTask(claim)?.nativeExecution?.summary?.submission).toBe("rejected");
  });
});

describe("immutable authenticated claim scope", () => {
  it("keeps newly registered scope unknown until an actual matching claim establishes its immutable owner", () => {
    const f = fixture(); f.register();
    expect(f.store.getTask(claim)?.userId).toBeNull();
    expect(isUnstartedPending(f.store.getTask(claim)!)).toBe(true);
    const owned = f.store.bindUserScope(claim, userId.toUpperCase(), 11);
    expect(owned.userId).toBe(userId);
    expect(f.store.bindUserScope(claim, userId, 12).userId).toBe(userId);
    const before = f.store.getTask(claim)!;
    expect(() => f.store.bindUserScope(claim, uuid(91), 13)).toThrow("original authenticated claim owner cannot be replaced");
    expect(f.store.getTask(claim)).toEqual(before);
    close(f.store);
    expect(open(f.file).getTask(claim)?.userId).toBe(userId);
  });

  it("learns unknown scope for ordinary/shutdown claims while fencing terminal and source-control decisions", () => {
    const ordinary = fixture(); ordinary.start();
    expect(ordinary.store.bindUserScope(claim, userId, 25).userId).toBe(userId);
    const shutdown = fixture(); shutdown.start();
    shutdown.store.beginCleanup(claim, { kind: "shutdown", deadline: 600_030 }, 30);
    expect(shutdown.store.bindUserScope(claim, userId, 31).userId).toBe(userId);
    const terminal = fixture(); terminal.start();
    terminal.store.beginCleanup(claim, { kind: "terminal", deadline: 600_030 }, 30);
    const originalTerminal = terminal.store.getTask(claim)!;
    expect(() => terminal.store.bindUserScope(claim, userId, 31)).toThrow("unknown authenticated scope");
    expect(terminal.store.getTask(claim)).toEqual(originalTerminal);
    const controlled = fixture(); controlled.start();
    controlled.store.recordControlIntent(claim, release, 30);
    const originalControl = controlled.store.getTask(claim)!;
    expect(() => controlled.store.bindUserScope(claim, userId, 31)).toThrow("unknown authenticated scope");
    expect(controlled.store.getTask(claim)).toEqual(originalControl);
  });

  it("permits already bound terminal/control owners without changing their original authorization", () => {
    const f = fixture(); f.start(); f.store.bindUserScope(claim, userId, 25);
    f.store.recordControlIntent(claim, release, 30);
    f.store.beginCleanup(claim, { kind: "terminal", deadline: 600_031 }, 31);
    expect(f.store.bindUserScope(claim, userId, 32).userId).toBe(userId);
    expect(() => f.store.bindUserScope(claim, uuid(91), 33)).toThrow("cannot be replaced");
  });

  it("requires original authenticated scope for direct pending completion while shutdown classification remains owner agnostic", () => {
    const f = fixture(); f.register();
    const proof = { completeOwnClaimInventory: true, claimAbsent: true, authenticatedUserId: userId } as const;
    const pending = f.store.getTask(claim)!;
    expect(isUnstartedPending(pending)).toBe(true);
    expect(() => f.store.completeUnstartedPending(claim, proof, 11)).toThrow("original authenticated claim owner");
    expect(f.store.getTask(claim)).toEqual(pending);
    f.store.bindUserScope(claim, userId, 12);
    const owned = f.store.getTask(claim)!;
    expect(() => f.store.completeUnstartedPending(claim, { ...proof, authenticatedUserId: uuid(91) }, 13)).toThrow("original authenticated claim owner");
    expect(f.store.getTask(claim)).toEqual(owned);
    expect(f.store.completeUnstartedPending(claim, proof, 14)).toMatchObject({ status: "done", userId });
  });
});

describe("claim history and frozen configuration", () => {
  it("completes a proven unstarted successor directly without disturbing the old active execution", () => {
    const f = fixture(); f.start();
    const original = f.store.getTask(claim)!;
    const successor = { ...claim, claimId: uuid(30), worktreeId: uuid(31) };
    f.store.registerPending(successor, { kind: "new", configuration }, 25);
    const pending = f.store.bindUserScope(successor, userId, 25);
    expect(isUnstartedPending(pending)).toBe(true);
    expect(() => f.store.completeUnstartedPending(successor, { completeOwnClaimInventory: false, claimAbsent: true } as never, 26)).toThrow("successful complete own-claim inventory");
    expect(() => f.store.completeUnstartedPending(successor, { completeOwnClaimInventory: true, claimAbsent: false } as never, 26)).toThrow("successful complete own-claim inventory");
    expect(f.store.getTask(successor)).toEqual(pending);
    const completed = f.store.completeUnstartedPending(successor, { completeOwnClaimInventory: true, claimAbsent: true, authenticatedUserId: userId }, 27);
    expect(completed).toMatchObject({ status: "done", resources: { worktree: null, herdr: null, nativeSession: null }, cleanup: { kind: "terminal", startedAt: 27, deadline: 27, input: "unavailable", result: "completed", agentStopped: true, workspaceClosed: true, worktreeDeleted: true } });
    expect(f.store.getTask(claim)).toEqual(original);
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.getTask(successor)).toEqual(completed);
    expect(reopened.listUnfinishedTasks()).toEqual([original]);
  });

  it("requires every unstarted pending fact before treating a record as resource-free", () => {
    const f = fixture(); f.register();
    const pending = f.store.getTask(claim)!;
    expect(isUnstartedPending(pending)).toBe(true);
    expect(isUnstartedPending({ ...pending, status: "active" })).toBe(false);
    expect(isUnstartedPending({ ...pending, status: "done" })).toBe(false);
    expect(isUnstartedPending({ ...pending, control: { intent: release, requestedAt: 11, submission: "not-submitted", submittedAt: null, outcome: null, resultVersion: null, error: null } })).toBe(false);
    expect(isUnstartedPending({ ...pending, cleanup: { kind: "shutdown", startedAt: 11, deadline: 12, input: "unavailable", baseline: null, result: "completed", error: null, agentStopped: true, workspaceClosed: true, worktreeDeleted: false } })).toBe(false);
    expect(isUnstartedPending({ ...pending, resources: { ...pending.resources, worktree: { repositoryPath: f.mapping.localPath, commonDirectory: path.join(f.mapping.localPath, ".git"), worktreePath: path.join(f.mapping.localPath, ".worktrees", "daynight", claim.taskId), branch: `daynight/${claim.taskId}` } } })).toBe(false);
    expect(isUnstartedPending({ ...pending, resources: { ...pending.resources, herdr: { session: "w", workspaceId: "ws", paneId: "pane" } } })).toBe(false);
    expect(isUnstartedPending({ ...pending, resources: { ...pending.resources, nativeSession: { sessionId: uuid(80), source: "herdr" } } })).toBe(false);
    expect(isUnstartedPending({ ...pending, nativeExecution: null })).toBe(false);
    const binding = { session: "w", workspaceId: "ws", paneId: "pane", terminalId: "terminal" };
    const ownerLabel = `daynight:${JSON.stringify({ ...project, taskId: claim.taskId, claimId: claim.claimId, worktreeId: claim.worktreeId })}`;
    const workspaceEvidence = { binding, ownerLabel, environment: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" } };
    const native = pending.nativeExecution!;
    const mutations = [
      { terminalId: binding.terminalId }, { workspaceSubmission: "unknown" as const }, { workspaceSubmission: "acknowledged" as const }, { workspaceEvidence },
      { launchSubmission: "unknown" as const }, { launchSubmission: "acknowledged" as const },
      { launchEvidence: { binding, ownerLabel, agent: "codex" as const, argv: ["codex"], referenceBaseline: "empty" as const, workspaceEvidence } },
      { promptSubmission: "unknown" as const }, { promptSubmission: "submitted" as const },
      { stopObservation: { binding, ownerLabel, agent: "codex" as const, nativeSessionId: null, shellPid: 100, processIds: [101], observedAt: 10 } },
      { summary: { version: "11", herdr: null, nativeSessionId: null, phase: "preparing" as const, submission: "unknown" as const } },
    ];
    for (const mutation of mutations) expect(isUnstartedPending({ ...pending, nativeExecution: { ...native, ...mutation } })).toBe(false);
  });

  it("rejects direct completion for recovered, active or management-owned executions", () => {
    const f = fixture(); f.store.registerProject(f.mapping);
    f.store.registerPending(claim, { kind: "recovered", configuration }, 10);
    const proof = { completeOwnClaimInventory: true, claimAbsent: true, authenticatedUserId: userId } as const;
    expect(() => f.store.completeUnstartedPending(claim, proof, 11)).toThrow("proven unstarted pending");
    f.store.activateTask(claim, 12);
    expect(() => f.store.completeUnstartedPending(claim, proof, 13)).toThrow("proven unstarted pending");
    const successor = { ...claim, claimId: uuid(30), worktreeId: uuid(31) };
    f.store.registerPending(successor, { kind: "new", configuration }, 14);
    f.store.recordControlIntent(successor, { kind: "release", sourceClaimId: successor.claimId, version: "11" }, 15);
    expect(() => f.store.completeUnstartedPending(successor, proof, 16)).toThrow("proven unstarted pending");
    expect(f.store.listTasks().map(({ status }) => status)).toEqual(["active", "pending"]);
  });

  it("counts recovered configless responsibility as active without authorizing execution or spending recovery budget", () => {
    const f = fixture(); f.store.registerProject(f.mapping);
    f.store.registerPending(claim, { kind: "recovered", configuration: null }, 10);
    const paused = f.store.activatePausedRecovery(claim, "Original configuration needs review", 11);
    expect(paused).toMatchObject({ status: "active", configuration: null, nativeExecution: null, recovery: { count: 0, pauseReason: "Original configuration needs review" } });
    expect(() => f.store.activateTask(claim, 12)).toThrow("original frozen");
    expect(() => f.store.markNativeLaunchSubmitting(claim, 12)).toThrow("original frozen");
    const successor = { ...claim, claimId: uuid(30), worktreeId: uuid(31) };
    f.store.registerPending(successor, { kind: "recovered", configuration: null }, 13);
    expect(() => f.store.activatePausedRecovery(successor, "Existing execution is unresolved", 14)).toThrow("UNIQUE constraint failed");
    expect(f.store.getTask(successor)?.status).toBe("pending");
    const fresh = { ...claim, taskId: uuid(40), claimId: uuid(41), worktreeId: uuid(42) };
    f.store.registerPending(fresh, { kind: "new", configuration }, 15);
    expect(() => f.store.activatePausedRecovery(fresh, "No prior execution", 16)).toThrow("unknown original provenance or existing");
  });

  it("freezes the first pending snapshot and each claim's original identities", () => {
    const f = fixture(); f.register();
    const changed: FrozenExecutionConfiguration = { agent: "copilot", model: "new-model", args: [], recoveryLimit: 7 };
    expect(f.store.registerPending(claim, { kind: "new", configuration: changed }, 11)).toMatchObject({ configuration, createdAt: 10, updatedAt: 10 });
    expect(() => f.store.restoreOriginalConfiguration(claim, changed, 12)).toThrow("cannot be replaced");
    expect(() => f.store.registerPending({ ...claim, workerId: uuid(90) }, { kind: "new", configuration }, 12)).toThrow("different worker or worktree");
    expect(() => f.store.registerPending({ ...claim, worktreeId: uuid(91) }, { kind: "new", configuration }, 12)).toThrow("different worker or worktree");
    expect(() => f.store.bindWorktree(claim, { repositoryPath: f.mapping.localPath, commonDirectory: path.join(f.mapping.localPath, ".git"), worktreePath: path.join(f.mapping.localPath, "worktree"), branch: "branch" }, 13)).toThrow("active execution");
    f.store.activateTask(claim, 20); f.bind();
    close(f.store);
    expect(open(f.file).getTask(claim)).toMatchObject({ status: "active", configuration, resources: { nativeSession: { sessionId: "native-original", source: "herdr" } } });
  });

  it("pauses a recovered execution with missing original config and requires explicit restoration", () => {
    const f = fixture(); f.store.registerProject(f.mapping);
    expect(f.store.registerPending(claim, { kind: "recovered", configuration: null }, 10)).toMatchObject({ configuration: null, recovery: { pauseReason: expect.stringContaining("missing") } });
    expect(() => f.store.activateTask(claim, 20)).toThrow("original frozen");
    expect(() => f.store.clearPause(claim, 20)).toThrow("original frozen");
    expect(f.store.registerPending(claim, { kind: "new", configuration }, 20).configuration).toBeNull();
    f.store.restoreOriginalConfiguration(claim, configuration, 21);
    expect(() => f.store.activateTask(claim, 22)).toThrow("paused");
    f.store.clearPause(claim, 23);
    expect(f.store.activateTask(claim, 24).status).toBe("active");
  });

  it("enforces one SQL-level active claim while retaining pending successors and history", () => {
    const f = fixture(); f.start();
    const successor = { ...claim, claimId: uuid(30), worktreeId: uuid(31) };
    const nextConfig = { ...configuration, model: "next-model" };
    f.store.registerPending(successor, { kind: "new", configuration: nextConfig }, 25);
    expect(() => f.store.activateTask(successor, 26)).toThrow("UNIQUE constraint failed");
    const sql = connect(f.file);
    expect(() => sql.prepare("UPDATE tasks SET status = 'active' WHERE claim_id = ?").run(successor.claimId)).toThrow("UNIQUE constraint failed");
    expect(f.store.getTask(successor)).toMatchObject({ status: "pending", configuration: nextConfig, updatedAt: 25 });
    f.cleanup(); f.store.completeTask(claim, 40);
    expect(f.store.activateTask(successor, 41).status).toBe("active");
    expect(f.store.listTasks().map(({ status }) => status)).toEqual(["done", "active"]);
    expect(f.store.listUnfinishedTasks().map(({ claimId }) => claimId)).toEqual([successor.claimId]);
    expect(() => f.store.activateTask(claim, 42)).toThrow("already done");
  });

  it("rejects rebinding original resources and malformed stored metadata", () => {
    const f = fixture(); f.start(); f.bind();
    const original = f.store.getTask(claim)!;
    expect(() => f.store.bindWorktree(claim, { ...original.resources.worktree!, repositoryPath: path.join(f.directory, "wrong") }, 24)).toThrow("original project binding");
    expect(() => f.store.bindWorktree(claim, { ...original.resources.worktree!, worktreePath: path.join(f.directory, "other") }, 24)).toThrow("different worktree");
    expect(() => f.store.bindHerdr(claim, { ...original.resources.herdr!, paneId: "other-pane" }, 24)).toThrow("different Herdr");
    expect(() => f.store.bindNativeSession(claim, { sessionId: "wrong-native", source: "native-history" }, 24)).toThrow("cannot be replaced");
    const sql = connect(f.file);
    sql.prepare("UPDATE tasks SET recovery = ? WHERE claim_id = ?").run('{"count":"invalid","pauseReason":null,"retryAuthorized":false}', claim.claimId);
    expect(() => f.store.getTask(claim)).toThrow("Recovery count must be a safe integer");
    expect(() => f.store.listUnfinishedTasks()).toThrow("Recovery count must be a safe integer");
  });

  it("rebinds a missing Herdr workspace only after exact old-binding and stop/closure confirmation", () => {
    const f = fixture(); f.start(); f.bind();
    const original = f.store.getTask(claim)!;
    const previous = original.resources.herdr!;
    const next = { session: "w", workspaceId: "new-workspace", paneId: "new-pane" };
    const proof = { originalAgentStopped: true, oldWorkspaceClosed: true } as const;
    expect(() => f.store.rebindHerdr(claim, { ...previous, paneId: "wrong-pane" }, next, proof, 24)).toThrow("previous Herdr binding");
    expect(() => f.store.rebindHerdr(claim, previous, next, { ...proof, originalAgentStopped: false } as never, 24)).toThrow("confirmed original agent stop");
    expect(() => f.store.rebindHerdr(claim, previous, next, { ...proof, oldWorkspaceClosed: false } as never, 24)).toThrow("old workspace closure");
    const rebound = f.store.rebindHerdr(claim, previous, next, proof, 25);
    expect(rebound.resources).toEqual({ ...original.resources, herdr: next });
    expect(rebound.configuration).toEqual(original.configuration);
    expect(rebound.worktreeId).toBe(original.worktreeId);
    expect(() => f.store.rebindHerdr(claim, previous, next, proof, 26)).toThrow("previous Herdr binding");
    f.store.recordControlIntent(claim, release, 27);
    expect(() => f.store.rebindHerdr(claim, next, previous, proof, 28)).toThrow("control or cleanup intent");
  });
});

describe("persistent bounded recovery", () => {
  it("retains the budget and pause through reopen and consumes one explicit extra retry", () => {
    const f = fixture(); f.start(); f.bind();
    expect(f.store.beginRecovery(claim, 30).recovery.count).toBe(1);
    expect(f.store.beginRecovery(claim, 31).recovery.count).toBe(2);
    expect(() => f.store.beginRecovery(claim, 32)).toThrow("budget is exhausted");
    f.store.pauseTask(claim, "Original session requires attention", 33);
    f.store.authorizeRecoveryRetry(claim, 34);
    f.store.authorizeRecoveryRetry(claim, 35);
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.getTask(claim)?.recovery).toEqual({ count: 2, pauseReason: "Original session requires attention", retryAuthorized: true });
    expect(reopened.beginRecovery(claim, 36).recovery).toEqual({ count: 3, pauseReason: null, retryAuthorized: false });
    expect(() => reopened.beginRecovery(claim, 37)).toThrow("budget is exhausted");
  });

  it("resumes finished shutdown without consuming recovery and clears stale workspace proofs", () => {
    const f = fixture(); f.start(); f.bind();
    const resources = f.store.getTask(claim)!.resources;
    f.store.beginCleanup(claim, { kind: "shutdown", deadline: 630 }, 30);
    expect(() => f.store.beginRecovery(claim, 31)).toThrow("cleanup intent");
    f.store.recordCleanupInputOutcome(claim, "unavailable", 32);
    f.store.recordCleanupResult(claim, "unavailable", "Agent input is unavailable", 33);
    f.store.confirmAgentStopped(claim, { agentStopped: true }, 34);
    expect(() => f.store.resumeAfterShutdown(claim, 35)).toThrow("workspace closed");
    f.store.confirmWorkspaceClosed(claim, { workspaceClosed: true }, 35);
    expect(() => f.store.confirmWorktreeDeleted(claim, { worktreeDeleted: true }, 36)).toThrow("terminal cleanup");
    expect(() => f.store.completeTask(claim, 36)).toThrow("Terminal cleanup");
    expect(f.store.resumeAfterShutdown(claim, 40)).toMatchObject({ status: "active", cleanup: null, resources: { ...resources, herdr: null }, recovery: { count: 0 } });
    f.store.bindHerdr(claim, { session: "w", workspaceId: "resumed-workspace", paneId: "resumed-pane" }, 41);
    const next = f.store.beginCleanup(claim, { kind: "terminal", deadline: 650 }, 50);
    expect(next.cleanup).toMatchObject({ agentStopped: false, workspaceClosed: false, worktreeDeleted: false, startedAt: 50 });
    expect(() => f.store.confirmWorkspaceClosed(claim, { workspaceClosed: true }, 51)).toThrow("confirmed original agent stop");
    expect(() => f.store.resumeAfterShutdown(claim, 52)).toThrow("Shutdown resume requires");
  });

  it("normally resumes with zero recovery budget while preserving a prior pause and retry authorization", () => {
    const f = fixture();
    f.store.registerProject(f.mapping);
    f.store.registerPending(claim, { kind: "new", configuration: { ...configuration, recoveryLimit: 0 } }, 10);
    f.store.activateTask(claim, 20); f.bind();
    const resources = f.store.getTask(claim)!.resources;
    f.store.pauseTask(claim, "Still waiting for manual attention", 24);
    f.store.authorizeRecoveryRetry(claim, 25);
    f.store.beginCleanup(claim, { kind: "shutdown", deadline: 630 }, 30);
    f.store.recordCleanupInputOutcome(claim, "unavailable", 31);
    f.store.recordCleanupResult(claim, "unavailable", null, 32);
    f.store.confirmAgentStopped(claim, { agentStopped: true }, 33);
    f.store.confirmWorkspaceClosed(claim, { workspaceClosed: true }, 34);
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.resumeAfterShutdown(claim, 40)).toMatchObject({
      configuration: { recoveryLimit: 0 }, cleanup: null, resources: { ...resources, herdr: null },
      recovery: { count: 0, pauseReason: "Still waiting for manual attention", retryAuthorized: true },
    });
    expect(() => reopened.activateTask(claim, 41)).toThrow("paused");
    expect(reopened.beginRecovery(claim, 42).recovery).toEqual({ count: 1, pauseReason: null, retryAuthorized: false });
    expect(() => reopened.beginRecovery(claim, 43)).toThrow("budget is exhausted");
  });

  it.each([0, 2])("resumes an unpaused normal shutdown with an exhausted fault recovery budget of %s", (budget) => {
    const f = fixture(); f.store.registerProject(f.mapping);
    f.store.registerPending(claim, { kind: "new", configuration: { ...configuration, recoveryLimit: budget } }, 10);
    f.store.activateTask(claim, 20); f.bind();
    for (let count = 0; count < budget; count += 1) f.store.beginRecovery(claim, 24 + count);
    f.store.beginCleanup(claim, { kind: "shutdown", deadline: 630 }, 30);
    f.store.recordCleanupInputOutcome(claim, "unavailable", 31);
    f.store.recordCleanupResult(claim, "unavailable", null, 32);
    f.store.confirmAgentStopped(claim, { agentStopped: true }, 33);
    f.store.confirmWorkspaceClosed(claim, { workspaceClosed: true }, 34);
    expect(f.store.resumeAfterShutdown(claim, 40).recovery).toEqual({ count: budget, pauseReason: null, retryAuthorized: false });
    expect(f.store.activateTask(claim, 41).status).toBe("active");
    expect(() => f.store.beginRecovery(claim, 42)).toThrow("budget is exhausted");
  });
});

describe("irreversible terminal cleanup and source control", () => {
  it("persists an immutable cleanup turn baseline only after its original input was confirmed", () => {
    const f = fixture(); f.start(); f.bind();
    f.store.beginCleanup(claim, { kind: "terminal", deadline: 630 }, 30);
    const baseline = { stateChangeSeq: 10, completionSeq: 5 };
    expect(() => f.store.recordCleanupInputEvidence(claim, baseline, 31)).toThrow("confirmed input submission");
    f.store.markCleanupInputSubmitting(claim, 32);
    expect(() => f.store.recordCleanupInputEvidence(claim, baseline, 33)).toThrow("confirmed input submission");
    f.store.recordCleanupInputOutcome(claim, "submitted", 34);
    f.store.recordCleanupInputEvidence(claim, baseline, 35);
    expect(() => f.store.recordCleanupInputEvidence(claim, { ...baseline, completionSeq: 6 }, 36)).toThrow("cannot be replaced");
    close(f.store);
    expect(open(f.file).getTask(claim)?.cleanup).toMatchObject({ input: "submitted", deadline: 630, baseline });
  });

  it("retains the original deadline and unknown input and never resubmits after reopen", () => {
    const f = fixture(); f.start(); f.bind();
    f.store.beginCleanup(claim, { kind: "terminal", deadline: 630 }, 30);
    f.store.markCleanupInputSubmitting(claim, 31);
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.beginCleanup(claim, { kind: "shutdown", deadline: 999_999 }, 40).cleanup).toMatchObject({ kind: "terminal", startedAt: 30, deadline: 630, input: "unknown" });
    expect(() => reopened.markCleanupInputSubmitting(claim, 41)).toThrow("cannot be submitted again");
    expect(() => reopened.recordCleanupInputOutcome(claim, "unavailable", 42)).not.toThrow();
    expect(() => reopened.activateTask(claim, 43)).toThrow("cleanup intent");
    expect(() => reopened.beginRecovery(claim, 43)).toThrow("cleanup intent");
    expect(() => reopened.recordCleanupResult(claim, "timed-out", null, 629)).toThrow("has not elapsed");
    expect(reopened.recordCleanupResult(claim, "timed-out", "Known process remains", 630).cleanup).toMatchObject({ result: "timed-out", deadline: 630 });
    expect(() => reopened.recordCleanupResult(claim, "completed", null, 631)).toThrow("cannot be replaced");
  });

  it("requires every physical cleanup fact in order and keeps failed removal active", () => {
    const f = fixture(); f.start();
    expect(() => f.store.beginCleanup(claim, { kind: "terminal", deadline: 600_031 }, 30)).toThrow("within ten minutes");
    expect(f.store.getTask(claim)?.cleanup).toBeNull();
    f.store.beginCleanup(claim, { kind: "terminal", deadline: 630 }, 30);
    expect(() => f.store.confirmWorkspaceClosed(claim, { workspaceClosed: true }, 31)).toThrow("agent stop");
    expect(() => f.store.confirmWorktreeDeleted(claim, { worktreeDeleted: true }, 31)).toThrow("workspace closure");
    expect(() => f.store.completeTask(claim, 31)).toThrow("Terminal cleanup");
    f.store.recordCleanupInputOutcome(claim, "unavailable", 32);
    f.store.recordCleanupResult(claim, "unavailable", null, 33);
    expect(() => f.store.confirmAgentStopped(claim, { agentStopped: false } as never, 34)).toThrow("must confirm");
    f.store.confirmAgentStopped(claim, { agentStopped: true }, 34);
    f.store.confirmWorkspaceClosed(claim, { workspaceClosed: true }, 35);
    f.store.recordCleanupError(claim, "git worktree remove failed", 36);
    expect(() => f.store.completeTask(claim, 37)).toThrow("worktree deleted");
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.getTask(claim)).toMatchObject({ status: "active", cleanup: { error: "git worktree remove failed", worktreeDeleted: false } });
    reopened.confirmWorktreeDeleted(claim, { worktreeDeleted: true }, 38);
    expect(reopened.completeTask(claim, 39).status).toBe("done");
    expect(reopened.listTasks()).toHaveLength(1);
  });

  it("fences recovery immediately on control intent and requires full local cleanup before remote submission", () => {
    const f = fixture(); f.start(); f.bind();
    expect(f.store.recordControlIntent(claim, release, 24).control?.intent).toEqual(release);
    expect(() => f.store.activateTask(claim, 25)).toThrow("control or cleanup intent");
    expect(() => f.store.beginRecovery(claim, 25)).toThrow("control or cleanup intent");
    expect(() => f.store.markControlSubmitting(claim, BigInt(release.version), 25)).toThrow("Cleanup has not started");
    expect(() => f.store.recordControlIntent(claim, { ...release, version: "6" }, 26)).toThrow("different source control intent");
    expect(f.store.recordControlIntent(claim, release, 27).control?.requestedAt).toBe(24);
    f.cleanup();
    expect(() => f.store.completeTask(claim, 40)).toThrow("control outcome");
    expect(() => f.store.markControlSubmitting(claim, 7n, 41)).toThrow("original control decision");
    expect(f.store.markControlSubmitting(claim, BigInt(release.version), 42).control).toMatchObject({ submission: "unknown", intent: release });
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.getTask(claim)).toMatchObject({ status: "active", cleanup: { worktreeDeleted: true }, control: { submission: "unknown", intent: { version: release.version } } });
    expect(() => reopened.markControlSubmitting(claim, BigInt(release.version), 43)).toThrow("cannot be replayed");
    expect(() => reopened.beginRecovery(claim, 44)).toThrow("control or cleanup intent");
    expect(() => reopened.completeTask(claim, 45)).toThrow("control outcome");
    reopened.confirmControlApplied(claim, 9_223_372_036_854_775_807n, 46);
    expect(reopened.completeTask(claim, 47)).toMatchObject({ status: "done", control: { resultVersion: "9223372036854775807", submission: "confirmed" } });
  });

  it("persists only a source transfer intent and rejects reuse of old execution identities", () => {
    const f = fixture(); f.start();
    const transfer: ControlIntent = { kind: "transfer", sourceClaimId: claim.claimId, version: "8", targetClaimId: uuid(50), target: { userId: uuid(51), workerId: uuid(52), machine: { id: uuid(53), name: "target" }, platform: "linux", agent: "copilot", worktreeId: uuid(54) } };
    expect(() => f.store.recordControlIntent(claim, { ...transfer, targetClaimId: claim.claimId }, 21)).toThrow("new claim and worktree");
    expect(() => f.store.recordControlIntent(claim, { ...transfer, target: { ...transfer.target, worktreeId: claim.worktreeId } }, 21)).toThrow("new claim and worktree");
    f.store.recordControlIntent(claim, transfer, 22);
    expect(f.store.listTasks()).toHaveLength(1);
    expect(f.store.getTask({ ...claim, claimId: transfer.targetClaimId })).toBeNull();
    f.cleanup();
    f.store.confirmControlOwnershipEnded(claim, { completeOwnClaimInventory: true, claimAbsent: true }, 40);
    expect(f.store.completeTask(claim, 41).control).toMatchObject({ intent: transfer, submission: "confirmed", submittedAt: null, outcome: "ownership-ended", resultVersion: null });
  });

  it("resolves an unknown control write by complete own-inventory absence without inventing a remote version", () => {
    const f = fixture(); f.start(); f.store.recordControlIntent(claim, release, 24); f.cleanup();
    f.store.markControlSubmitting(claim, BigInt(release.version), 40);
    close(f.store);
    const reopened = open(f.file);
    expect(() => reopened.confirmControlOwnershipEnded(claim, { completeOwnClaimInventory: false, claimAbsent: true } as never, 41)).toThrow("successful complete own-claim inventory");
    expect(() => reopened.confirmControlOwnershipEnded(claim, { completeOwnClaimInventory: true, claimAbsent: false } as never, 41)).toThrow("successful complete own-claim inventory");
    expect(reopened.getTask(claim)?.control?.submission).toBe("unknown");
    expect(reopened.confirmControlOwnershipEnded(claim, { completeOwnClaimInventory: true, claimAbsent: true }, 42).control).toMatchObject({ outcome: "ownership-ended", resultVersion: null, submittedAt: 40 });
    expect(() => reopened.confirmControlApplied(claim, 10n, 43)).toThrow("confirmed control result cannot be replaced");
    expect(reopened.completeTask(claim, 44).status).toBe("done");
  });

  it("never submits cleanup input after the original deadline or a recorded result", () => {
    const f = fixture(); f.start();
    f.store.beginCleanup(claim, { kind: "terminal", deadline: 50 }, 30);
    expect(() => f.store.markCleanupInputSubmitting(claim, 50)).toThrow("deadline has elapsed");
    expect(f.store.getTask(claim)?.cleanup?.input).toBe("not-submitted");
    f.store.recordCleanupResult(claim, "unavailable", "No original agent is available", 51);
    expect(() => f.store.markCleanupInputSubmitting(claim, 52)).toThrow("after cleanup completion");
  });

  it("preserves definite remote rejection and rejects lossy versions", () => {
    const f = fixture(); f.start();
    expect(() => f.store.recordControlIntent(claim, { ...release, version: "9223372036854775808" }, 21)).toThrow("int64 decimal string");
    f.store.recordControlIntent(claim, release, 22); f.cleanup();
    expect(() => f.store.markControlSubmitting(claim, Number(release.version) as unknown as bigint, 39)).toThrow("provided as bigint");
    f.store.markControlSubmitting(claim, BigInt(release.version), 40);
    f.store.rejectControlSubmission(claim, "Exact version conflict", 41);
    close(f.store);
    const reopened = open(f.file);
    expect(reopened.getTask(claim)?.control).toMatchObject({ submission: "rejected", error: "Exact version conflict" });
    expect(() => reopened.markControlSubmitting(claim, BigInt(release.version), 42)).toThrow("cannot be replayed");
    expect(() => reopened.completeTask(claim, 43)).toThrow("control outcome");
  });
});

describe("worker transaction durability", () => {
  it("rolls back a rejected activation with all metadata and freezes the committed pending snapshot", () => {
    const f = fixture(); f.register();
    const sql = connect(f.file);
    sql.exec("CREATE TRIGGER reject_activation BEFORE UPDATE ON tasks WHEN NEW.status = 'active' BEGIN SELECT RAISE(ABORT, 'activation rejected'); END");
    expect(() => f.store.activateTask(claim, 20)).toThrow("activation rejected");
    expect(f.store.getTask(claim)).toMatchObject({ status: "pending", configuration, updatedAt: 10, cleanup: null });
    expect(() => f.store.beginCleanup(claim, { kind: "terminal", deadline: 630 }, 30)).toThrow("activation rejected");
    expect(f.store.getTask(claim)).toMatchObject({ status: "pending", configuration, updatedAt: 10, cleanup: null });
    sql.exec("DROP TRIGGER reject_activation");
    f.store.activateTask(claim, 21); f.cleanup();
    sql.exec("CREATE TRIGGER reject_completion BEFORE UPDATE ON tasks WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'completion rejected'); END");
    expect(() => f.store.completeTask(claim, 40)).toThrow("completion rejected");
    expect(f.store.getTask(claim)).toMatchObject({ status: "active", updatedAt: 36, cleanup: { worktreeDeleted: true } });
  });

  it("retains committed responsibility and rolls back an interrupted real child transaction", async () => {
    const f = fixture(); close(f.store);
    const moduleUrl = new URL("../../../dist/commands/worker/store.js", import.meta.url).href;
    const databaseUrl = new URL("../../../node_modules/better-sqlite3/lib/index.js", import.meta.url).href;
    const source = `import { openWorkerStore } from ${JSON.stringify(moduleUrl)};
import Database from ${JSON.stringify(databaseUrl)};
const store = openWorkerStore(process.argv[1]);
const claim = ${JSON.stringify(claim)};
store.registerProject(${JSON.stringify(f.mapping)});
store.registerPending(claim, {kind:'new',configuration:${JSON.stringify(configuration)}}, 10);
store.activateTask(claim, 20);
store.close();
const db = new Database(process.argv[1]);
db.exec('BEGIN IMMEDIATE');
db.prepare('UPDATE tasks SET recovery = ? WHERE claim_id = ?').run(JSON.stringify({count:99,pauseReason:'uncommitted',retryAuthorized:true}), claim.claimId);
process.send('transaction-open');
setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source, f.file], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "";
    child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => { if (signal !== null || code === 0) resolve(); else reject(new Error(stderr)); }); });
    const message = waitForMessage(child);
    try {
      expect(await message).toBe("transaction-open");
      child.kill("SIGKILL");
      await exited;
      const reopened = open(f.file);
      expect(reopened.getTask(claim)).toMatchObject({ status: "active", configuration, updatedAt: 20, recovery: { count: 0, pauseReason: null, retryAuthorized: false } });
      expect(reopened.listUnfinishedTasks()).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });
});

const waitForMessage = (child: ChildProcess): Promise<unknown> => new Promise((resolve, reject) => {
  const clear = (): void => { clearTimeout(timeout); child.off("message", received); child.off("exit", exited); child.off("error", failed); };
  const received = (message: unknown): void => { clear(); resolve(message); };
  const exited = (code: number | null): void => { clear(); reject(new Error(`Store child exited before its checkpoint: ${code}.`)); };
  const failed = (error: Error): void => { clear(); reject(error); };
  const timeout = setTimeout(() => { clear(); reject(new Error("Store child did not reach its checkpoint within ten seconds.")); }, 10_000);
  child.once("message", received); child.once("exit", exited); child.once("error", failed);
});
