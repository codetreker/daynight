import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { ControlIntent, FrozenExecutionConfiguration, PendingClaim } from "../../../src/commands/worker/types.js";

const root = fileURLToPath(new URL("../../../../../.tmp/worker-store-tests/", import.meta.url));
const directories: string[] = [];
const stores = new Set<WorkerStore>();
const connections = new Set<Database.Database>();
const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const project = { serverOrigin: "https://daynight.example", projectId: uuid(1) };
const claim: PendingClaim = { ...project, taskId: uuid(2), claimId: uuid(3), workerId: uuid(4), worktreeId: uuid(5) };
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
    expect(sql.pragma("user_version", { simple: true })).toBe(1);
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
    sql.pragma("user_version = 2");
    expect(() => open(file)).toThrow("Unsupported worker SQLite schema version 2");
    expect(sql.pragma("user_version", { simple: true })).toBe(2);
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
    expect(f.store.listProjects()).toEqual([f.mapping]);
  });

  it.each(["pending", "active"] as const)("keeps repository bindings stable while an execution is %s", (status) => {
    const f = fixture(); f.register();
    if (status === "active") f.store.activateTask(claim, 20);
    expect(f.store.registerProject({ ...f.mapping })).toEqual(f.mapping);
    expect(() => f.store.registerProject({ ...f.mapping, repoUrl: "https://github.com/other/repo.git" })).toThrow("unfinished execution");
    expect(() => f.store.registerProject({ ...f.mapping, localPath: path.join(f.directory, "other") })).toThrow("unfinished execution");
    expect(f.store.getProject(project)).toEqual(f.mapping);
    f.cleanup(); f.store.completeTask(claim, 40);
    const changed = { ...f.mapping, repoUrl: "https://github.com/other/repo.git", localPath: path.join(f.directory, "other") };
    expect(f.store.registerProject(changed)).toEqual(changed);
    expect(f.store.getTask(claim)).toMatchObject({ repositoryPath: f.mapping.localPath, repoUrl: f.mapping.repoUrl });
  });
});

describe("claim history and frozen configuration", () => {
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
