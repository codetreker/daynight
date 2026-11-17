import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import type { WebExecutionBackend } from "../../../src/commands/worker/backends/web.js";
import type { WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import type { ResourceOwner } from "../../../src/commands/worker/types.js";
import type { Task } from "../../../src/api/types.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = "https://daynight.example", userId = id(2), workerId = id(3);
const configuration = { agent: "codex" as const, model: null, args: [], recoveryLimit: 2 };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const fixture = async () => {
  const base = path.resolve("../../.tmp/coordinator-web-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); roots.push(root);
  const project = { projectId: id(10), repoUrl: "https://example.test/owner/repo.git", localPath: root };
  const owner: ResourceOwner = { projectId: project.projectId, taskId: id(11), claimId: id(12), worktreeId: id(13) };
  const webStore = openWebExecutionStore(createMemoryDatabase());
  const db = createMemoryDatabase();
  const store = openWorkerStore(db, { isWebCleanupOwner: candidate => {
    const record = webStore.getTask(candidate);
    return record !== null && record.worktreeId === candidate.worktreeId && record.userId === userId && record.workerId === workerId && record.serverOrigin === origin;
  } });
  store.registerProject(project);
  const git = { resolveWorktreeBinding: vi.fn(async () => null), findWorktree: vi.fn(async () => null), retireWorktreeManifest: vi.fn(), scanWorktrees: vi.fn(() => { throw new Error("Unrelated registrations must not be scanned"); }) } as unknown as WorkerGitManager;
  const inventories: Task[] = [];
  const remote = { serverOrigin: origin, currentUserId: vi.fn(async () => userId), ownInventory: vi.fn(async () => ({ tasks: inventories, coveredProjectIds: [project.projectId], unavailableProjectIds: [] })), candidates: vi.fn(async function* () {}), readTask: vi.fn(async (projectId, taskId) => inventories.find(task => task.projectId === projectId && task.id === taskId)!), update: vi.fn(async task => task) } as unknown as WorkerRemote;
  const webBackend = { advance: vi.fn(async record => record), observeExecutionStop: vi.fn(async target => ({ kind: "unknown" as const, target, observedAt: 1, error: new Error("unknown") })), cleanup: vi.fn<WebExecutionBackend["cleanup"]>(async record => ({ complete: true, task: record })) };
  const onInventory = vi.fn(), verifyWebUnregistered = vi.fn(async () => {});
  const coordinator = createWorkerCoordinator({ store, webStore, webBackend, git, remote, serverOrigin: origin, userId, workerId, platform: "linux", machine: { id: id(4), name: "host" }, repositories: [], globalConfiguration: configuration, maxConcurrent: 1, preferPlatformSpecificTasks: false, buildPrompt: () => "", verifyWebUnregistered, onInventory, emit: () => {} });
  const close = async () => { await coordinator.shutdown(); store.close(); webStore.close(); };
  return { owner, project, db, store, webStore, webBackend, git, inventories, onInventory, verifyWebUnregistered, coordinator, close };
};

const remoteTask = (owner: ResourceOwner, mode: "web" | "herdr"): Task => ({ type: "task", parentId: null, id: owner.taskId, projectId: owner.projectId, title: "task", description: "", tags: [], status: "in_progress", allowAgents: true, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, version: 1n, properties: { worker: { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, userId, state: "active", agent: "codex", agentControlMode: mode, machine: { id: id(4), name: "host" }, platform: "linux", phase: "executing", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false });

it("excludes a retained cleanup row when the Web journal has another worktree identity", async () => {
  const f = await fixture();
  try {
    f.webStore.register({ ...f.owner, project: f.project, serverOrigin: origin, workerId, userId, configuration }, 1);
    f.inventories.push(remoteTask(f.owner, "web"));
    f.db.prepare("INSERT INTO cleanup_schedules(project_id, task_id, claim_id, worktree_id, deadline, failures, next_attempt_at, stage, last_error) VALUES (?, ?, ?, ?, 1, 0, 0, 'observation', NULL)").run(f.owner.projectId, f.owner.taskId, f.owner.claimId, id(99));
    await f.coordinator.tick();
    expect(f.store.listCleanupSchedules()).toEqual([]);
    expect(f.webBackend.cleanup).not.toHaveBeenCalled();
    expect(f.git.scanWorktrees).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT worktree_id FROM cleanup_schedules").get()).toEqual({ worktree_id: id(99) });
  } finally { await f.close(); }
});

it("publishes and registers only supported Web claims from the remote inventory", async () => {
  const f = await fixture();
  try {
    const old = { ...f.owner, taskId: id(20), claimId: id(21), worktreeId: id(22) };
    f.inventories.push(remoteTask(f.owner, "web"), remoteTask(old, "herdr"));
    await f.coordinator.tick();
    expect(f.onInventory).toHaveBeenLastCalledWith(expect.objectContaining({ claims: [{ projectId: f.owner.projectId, taskId: f.owner.taskId, claimId: f.owner.claimId }] }));
    expect(f.store.getTask(f.owner)?.agentControlMode).toBe("web");
    expect(f.store.getTask(old)).toBeNull();
  } finally { await f.close(); }
});

it("uses the matching Web journal to finish a retained cleanup", async () => {
  const f = await fixture();
  try {
    const record = f.webStore.register({ ...f.owner, project: f.project, serverOrigin: origin, workerId, userId, configuration }, 1);
    f.store.registerPending({ ...f.owner, agent: "codex", agentControlMode: "web" });
    f.store.saveCleanupSchedule(f.owner, { deadline: 100, failures: 0, nextAttemptAt: 0, stage: "observation", lastError: null });
    f.webBackend.cleanup.mockImplementation(async (task, request) => {
      if (request.kind === "shutdown") return { complete: true, task };
      request.scope.onExecutionStopped({ attempt: request.scope.attempt, observation: { kind: "not-started", owner: f.owner, observedAt: 2 } });
      const begun = f.webStore.beginCleanup(task, { kind: "terminal", deadline: request.deadline }, 2);
      return { complete: true, task: f.webStore.completeTask(begun, 3) };
    });
    await f.coordinator.tick();
    await vi.waitFor(() => expect(f.webStore.getTask(record)?.status).toBe("done"));
    expect(f.store.getTask(f.owner)?.status).toBe("done");
    expect(f.webBackend.cleanup).toHaveBeenCalledWith(expect.objectContaining(f.owner), expect.objectContaining({ kind: "terminal" }));
  } finally { await f.close(); }
});

it("establishes the original unregistered Web claim before explicit control cleanup", async () => {
  const f = await fixture();
  try {
    f.inventories.push(remoteTask(f.owner, "web"));
    f.store.registerPending({ ...f.owner, agent: "codex", agentControlMode: "web" });
    expect(await f.coordinator.cleanupSource(f.owner)).toEqual(f.owner);
    expect(f.verifyWebUnregistered).toHaveBeenCalledOnce();
    expect(f.webStore.getTask(f.owner)).toMatchObject({ ...f.owner, userId, workerId, serverOrigin: origin });
    expect(f.webBackend.cleanup).toHaveBeenCalledWith(expect.objectContaining(f.owner), expect.objectContaining({ kind: "shutdown" }));
  } finally { await f.close(); }
});

it("retains an unregistered claim if its worktree changes during verification", async () => {
  const f = await fixture();
  try {
    f.inventories.push(remoteTask(f.owner, "web"));
    f.store.registerPending({ ...f.owner, agent: "codex", agentControlMode: "web" });
    f.verifyWebUnregistered.mockImplementationOnce(async () => { f.inventories[0] = remoteTask({ ...f.owner, worktreeId: id(90) }, "web"); });
    await expect(f.coordinator.cleanupSource(f.owner)).rejects.toThrow("changed while verifying");
    expect(f.webStore.getTask(f.owner)).toBeNull();
    expect(f.webBackend.cleanup).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
