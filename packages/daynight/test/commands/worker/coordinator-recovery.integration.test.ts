import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { scanFromList } from "../../helpers/worker-git-scan.js";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import type { WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { CleanupRequest } from "../../../src/commands/worker/execution-stop.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { LocalTask as WebTask } from "../../../src/commands/worker/backends/web-types.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import type { Task } from "../../../src/api/types.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const origin = "https://daynight.example", workerId = uuid(1), userId = uuid(2);
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

const fixture = async () => {
  const base = path.resolve("../../.tmp/minimal-coordinator-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "web-recovery-")); directories.push(root);
  const store = openWorkerStore(createMemoryDatabase());
  const webStore = openWebExecutionStore(createMemoryDatabase());
  const owner = { projectId: uuid(10), taskId: uuid(100), claimId: uuid(962), worktreeId: uuid(963) };
  const project = { projectId: owner.projectId, repoUrl: "https://example.test/owner/repo.git", localPath: path.join(root, "repo") };
  store.registerProject(project); await mkdir(project.localPath, { recursive: true });
  const configuration = { agent: "codex" as const, model: "model", args: [] as string[], agentControlMode: "web" as const, recoveryLimit: 2 };
  const binding = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: path.join(project.localPath, ".worktrees", "daynight", owner.worktreeId), branch: `daynight/${owner.taskId}` };
  store.activateTask(store.registerPending({ ...owner, agent: "codex", agentControlMode: "web", sessionId: uuid(964) }));
  let record = webStore.register({ ...owner, project, serverOrigin: origin, workerId, userId, configuration }, 1);
  record = webStore.bindWorktree(record, binding, 2);
  record = webStore.initializeWebExecution(record, 3);
  record = webStore.updateWebExecution(record, { sessionId: uuid(964), initialInputState: "confirmed", launchSubmission: "acknowledged", activity: "waiting_input" }, 4);
  record = webStore.bindNativeSession(record, { source: "controller", sessionId: uuid(964) }, 5);
  const execution = record.webExecution!;
  const worker = { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, userId, machine: { id: uuid(3), name: "fixture" }, platform: "linux", agent: "codex", agentControlMode: "web", state: "active", phase: "executing", herdr: null, nativeSessionId: uuid(964), claimedAt: "2026-10-27T00:00:00Z" };
  const remoteTask = { type: "task", parentId: null, id: owner.taskId, projectId: owner.projectId, title: "fixture", description: "task", tags: [], status: "in_progress", allowAgents: true, assignedTo: userId, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, version: 1n, properties: { worker }, createdAt: worker.claimedAt, updatedAt: worker.claimedAt, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false } as unknown as Task;
  const remote = { serverOrigin: origin, currentUserId: vi.fn(async () => userId), readTask: vi.fn(async () => remoteTask), ownInventory: vi.fn(async () => ({ tasks: [remoteTask], coveredProjectIds: [owner.projectId], unavailableProjectIds: [] })), candidates: vi.fn(async function* () {}), claim: vi.fn(), update: vi.fn(async () => remoteTask) } as unknown as WorkerRemote;
  const git = { scanWorktrees: scanFromList, listWorktrees: vi.fn(async () => [{ owner, binding }]), listWorktreeManifests: vi.fn(async () => [{ owner, binding }]), resolveWorktreeBinding: vi.fn(async () => binding), removeWorktree: vi.fn(async () => ({ kind: "absent", effectErrors: [] })), retireWorktreeManifest: vi.fn(async () => {}) } as unknown as WorkerGitManager;
  const advance = vi.fn(async (input: WebTask) => webStore.updateWebExecution(input, { activity: "working" }, 6));
  const cleanup = vi.fn(async (input: WebTask, _request: CleanupRequest) => ({ complete: true, task: input }));
  const coordinator = createWorkerCoordinator({ store, git, remote, webStore, webBackend: { advance, cleanup, observeExecutionStop: async target => ({ kind: "unknown", target, observedAt: 1000, error: new Error("Stop unconfirmed") }) }, serverOrigin: origin, workerId, userId, platform: "linux", machine: worker.machine, repositories: [{ project, configuration }], globalConfiguration: configuration, maxConcurrent: 2, preferPlatformSpecificTasks: false, emit: () => {}, now: () => 1000, verifyWebServer: async () => {} });
  return { owner, store, webStore, execution, remote, advance, cleanup, coordinator };
};

it.each(["retry", "cleanup", "complete"] as const)("routes original Web %s with its retained execution identity", async action => {
  const f = await fixture();
  f.cleanup.mockImplementation(async (input, request) => {
    if (request.kind !== "terminal") return { complete: true, task: input };
    const cleaning = f.webStore.beginCleanup(input, { kind: "terminal", deadline: request.deadline }, 1000);
    request.scope.onExecutionStopped({ attempt: request.scope.attempt, observation: { kind: "stopped", execution: { owner: f.owner, backend: "web", runKey: f.execution.executionId }, observedAt: 8 } });
    return { complete: true, task: f.webStore.completeTask(cleaning, 9) };
  });
  try {
    if (action === "retry") {
      await expect(f.coordinator.advanceRetry(f.owner)).resolves.toBeUndefined();
      expect(f.webStore.getTask(f.owner)?.webExecution).toMatchObject({ activity: "working", sessionId: f.execution.sessionId, executionGeneration: f.execution.executionGeneration });
      expect(f.advance).toHaveBeenCalledOnce();
    } else {
      if (action === "cleanup") await expect(f.coordinator.cleanupSource(f.owner, { deleteWorktree: true })).resolves.toEqual(f.owner);
      else await expect(f.coordinator.completeSource(f.owner)).resolves.toBeUndefined();
      expect(f.webStore.getTask(f.owner)?.status).toBe("done");
      expect(f.store.getTask(f.owner)?.status).toBe("done");
      expect(f.store.getCleanupSchedule(f.owner)).toBeNull();
    }
    expect(f.remote.claim).not.toHaveBeenCalled();
  } finally { await f.coordinator.shutdown(); f.webStore.close(); f.store.close(); }
});

it.each(["cleanup", "complete"] as const)("retains the original Web reservation without execution stop proof during %s", async action => {
  const f = await fixture();
  f.cleanup.mockImplementation(async (input, request) => {
    if (request.kind !== "terminal") return { complete: true, task: input };
    const cleaning = f.webStore.beginCleanup(input, { kind: "terminal", deadline: request.deadline }, 1000);
    return { complete: true, task: f.webStore.completeTask(cleaning, 1001) };
  });
  try {
    const operation = action === "cleanup" ? f.coordinator.cleanupSource(f.owner, { deleteWorktree: true }) : f.coordinator.completeSource(f.owner);
    await expect(operation).rejects.toThrow("The original execution stop remains unknown; its reservation is retained.");
    expect(f.store.getTask(f.owner)?.status).toBe("active");
    expect(f.store.getCleanupSchedule(f.owner)).not.toBeNull();
  } finally { await f.coordinator.shutdown(); f.webStore.close(); f.store.close(); }
});
