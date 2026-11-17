import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { openWebExecutionStore, type WebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { createWorkerCoordinator as createCoordinator, type WorkerCoordinatorOptions } from "../../../src/commands/worker/coordinator.js";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import type { WorkerGitManager, WorkerEvent } from "../../../src/commands/worker/execution.js";
import type { StopObservation, CleanupTarget } from "../../../src/commands/worker/execution-stop.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import type { Task, WorkerClaimDescriptor } from "../../../src/api/types.js";
import type { ExecutionConfiguration, ResourceOwner, WorktreeBinding } from "../../../src/commands/worker/types.js";

export const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
export const origin = "https://daynight.example", workerId = uuid(1), userId = uuid(2);
export const configuration: ExecutionConfiguration = { agent: "codex", model: "current-model", args: ["--search"], recoveryLimit: 2 };
export const unknownStop = async (target: CleanupTarget): Promise<StopObservation> => ({ kind: "unknown", target, error: new Error("Unobserved test backend"), observedAt: Date.now() });
export const eventually = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 10 });
const webStores: WebExecutionStore[] = [], fixtureWebStores: WebExecutionStore[] = [], coordinators: ReturnType<typeof createCoordinator>[] = [], stores: ReturnType<typeof openWorkerStore>[] = [], roots: string[] = [];
export const registerWebStore = (store: WebExecutionStore): WebExecutionStore => { webStores.push(store); return store; };
export const createWorkerCoordinator = (options: WorkerCoordinatorOptions): ReturnType<typeof createCoordinator> => {
  const coordinator = createCoordinator(options); const shutdown = coordinator.shutdown.bind(coordinator); let closing: ReturnType<typeof shutdown> | undefined;
  coordinator.shutdown = () => closing ??= shutdown(); coordinators.push(coordinator); return coordinator;
};
afterEach(async () => {
  await Promise.allSettled(coordinators.splice(0).map(coordinator => coordinator.shutdown()));
  for (const store of stores.splice(0)) store.close();
  for (const store of fixtureWebStores.splice(0)) store.close();
  webStores.splice(0); vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
export const task = (projectId: string, id: string): Task => ({ type: "task", parentId: null, id, projectId, title: id, description: "task", tags: [], status: "todo", allowAgents: true, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, version: 1n, properties: { pullRequests: [] }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true });
export const fixture = async (maxConcurrent = 1, registerProject = true, persistentStore = false) => {
  const base = path.resolve("../../.tmp/coordinator-web-fixtures"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "r-")); roots.push(root);
  const database = persistentStore ? path.join(root, "worker.sqlite") : createMemoryDatabase();
  const openStore = () => openWorkerStore(database, { isWebCleanupOwner: owner => webStores.some(web => {
    try { const record = web.getTask(owner); return record !== null && record.worktreeId === owner.worktreeId && record.userId === userId && record.workerId === workerId && record.serverOrigin === origin; } catch { return false; }
  }) }); let store = openStore(); stores.push(store);
  const project = { projectId: uuid(10), repoUrl: "https://example.test/owner/repo.git", localPath: path.join(root, "repo") };
  mkdirSync(project.localPath, { recursive: true }); if (registerProject) store.registerProject(project);
  const candidates = [task(project.projectId, uuid(100)), task(project.projectId, uuid(101))], grants = new Map<string, Task>();
  const worktrees = new Map<string, { owner: ResourceOwner; binding: WorktreeBinding }>(), manifests = new Map<string, { owner: ResourceOwner; binding: WorktreeBinding }>();
  const events: WorkerEvent[] = [], order: string[] = []; let clock = 1000;
  const bind = (owner: ResourceOwner): WorktreeBinding => ({ repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: path.join(project.localPath, ".worktrees", "daynight", owner.worktreeId), branch: `daynight/${owner.taskId}` });
  const git = {
    prepareRepository: vi.fn(), dispose: vi.fn(), removeEmptyReservation: vi.fn(async () => {}), removeUnpublishedReservation: vi.fn(async () => {}),
    prepareWorktree: vi.fn(async (_project: typeof project, owner: ResourceOwner) => { const binding = bind(owner); await mkdir(binding.worktreePath, { recursive: true }); worktrees.set(owner.claimId, { owner, binding }); manifests.set(owner.claimId, { owner, binding }); return binding; }),
    verifyWorktree: vi.fn(async (_project: typeof project, owner: ResourceOwner) => { const item = worktrees.get(owner.claimId); if (!item) throw new Error("Original worktree missing"); return item.binding; }),
    resolveWorktreeBinding: vi.fn(async (_project: typeof project, owner: ResourceOwner) => (worktrees.get(owner.claimId) ?? manifests.get(owner.claimId))?.binding ?? null),
    isOriginalWorktreeAbsent: vi.fn(async (_project: typeof project, owner: ResourceOwner) => !worktrees.has(owner.claimId)),
    listWorktreeManifests: vi.fn(async () => [...manifests.values()]), retireWorktreeManifest: vi.fn(async (_project: typeof project, owner: ResourceOwner) => { manifests.delete(owner.claimId); }),
    findWorktree: vi.fn(async (_project: typeof project, owner: ResourceOwner) => worktrees.get(owner.claimId)?.binding ?? null),
    removeWorktree: vi.fn(async (_project: typeof project, owner: ResourceOwner) => { order.push("remove-worktree"); worktrees.delete(owner.claimId); return { kind: "absent" as const, effectErrors: [] }; }),
  } as unknown as WorkerGitManager;
  const grant = (candidate: Task, descriptor: WorkerClaimDescriptor): Task => {
    const result: Task = { ...candidate, status: "in_progress", ready: false, version: candidate.version + 1n, properties: { ...candidate.properties, worker: { ...descriptor, agentControlMode: "web", userId, state: "active", phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } };
    grants.set(descriptor.claimId, result); return result;
  };
  const remote = { serverOrigin: origin, currentUserId: vi.fn(async () => userId),
    ownInventory: vi.fn(async (projects: readonly { projectId: string }[]) => ({ tasks: [...grants.values()], coveredProjectIds: [...new Set(projects.map(item => item.projectId))], unavailableProjectIds: [] })),
    candidates: vi.fn(async function* (projectId: string) { for (const candidate of candidates) if (candidate.projectId === projectId && ![...grants.values()].some(value => value.id === candidate.id)) yield candidate; }),
    claim: vi.fn(async (candidate: Task, descriptor: WorkerClaimDescriptor) => grant(candidate, descriptor)),
    readTask: vi.fn(async (_projectId: string, taskId: string) => { const result = [...grants.values()].find(value => value.id === taskId); if (!result) throw new Error("missing task"); return result; }),
    update: vi.fn(async (current: Task, update: object) => { const result = { ...current, properties: { ...current.properties, worker: { ...readWorkerClaim(current.properties)!, ...update } } }; grants.set(readWorkerClaim(current.properties)!.claimId, result); return result; }),
  } as unknown as WorkerRemote;
  const webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase())); fixtureWebStores.push(webStore);
  const advance = vi.fn(async (record: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => record);
  const webBackend: WorkerCoordinatorOptions["webBackend"] = { observeExecutionStop: unknownStop, advance, cleanup: async record => ({ task: record, complete: true }) };
  const options = { store, git, remote, webStore, webBackend, serverOrigin: origin, userId, workerId, platform: "linux", machine: { id: uuid(3), name: "fixture" }, repositories: [{ project, configuration }], globalConfiguration: configuration, maxConcurrent, preferPlatformSpecificTasks: false, buildPrompt: () => "managed", verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, emit: event => events.push(event), now: () => clock } satisfies WorkerCoordinatorOptions;
  const reopenStore = () => {
    if (!persistentStore) throw new Error("Persistent worker store required");
    store.close(); stores.splice(stores.indexOf(store), 1); store = openStore(); stores.push(store); options.store = store;
  };
  return { root, get store() { return store; }, reopenStore, project, candidates, grants, grant, worktrees, manifests, git, remote, order, events, options, coordinator: createWorkerCoordinator(options), advance, clock: (value: number) => { clock = value; }, bind, webStore };
};
