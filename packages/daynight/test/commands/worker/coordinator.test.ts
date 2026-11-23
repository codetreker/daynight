import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { ensureCleanupSchedule } from "../../../src/commands/worker/cleanup-schedule.js";
import type { CleanupTarget, StopObservation } from "../../../src/commands/worker/execution-stop.js";
import { ArchiveRepairRequiredError } from "../../../src/commands/controller/archive-error.js";
import { scanFromList } from "../../helpers/worker-git-scan.js";
import { execFileSync } from "node:child_process";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { frozenToolLaunch } from "../../helpers/tool-launch.js";
import { toolSelectionKey } from "../../../src/platform/tool-executables.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as launchObservation from "../../../src/commands/controller/launch-observation.js";
import { createControllerJobLeases } from "../../../src/commands/worker/backends/controller-job-leases.js";
import { createRetiredClaimNativeCleanup } from "../../../src/commands/worker/backends/retired-claim-native.js";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { LocalTask as WebTask } from "../../../src/commands/worker/backends/web-types.js";
import { openWebExecutionStore, type WebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { ControllerIpcOutcomeUnknownError, type requestController } from "../../../src/commands/controller/local-client.js";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import { access, link, lstat, mkdir, mkdtemp, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TimerOptions } from "node:timers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationError } from "../../../src/api/operation.js";
import { ApiError, createApiClient } from "../../../src/api/client.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { isWorkerCancellation } from "../../../src/commands/worker/execution.js";
import { createWorkerCoordinator as createCoordinator } from "../../../src/commands/worker/coordinator.js";
import { createMonitoringObserver } from "../../../src/commands/worker/monitoring/observer.js";
import { createWorkerGitManager, WorktreePreconditionError } from "../../../src/commands/worker/worktrees.js";
import { migrateLegacyWorktrees } from "../../../src/commands/worker/worktrees/migration.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import { submitWorkerControl } from "../../../src/commands/worker/control.js";
import { createWorkerReporter } from "../../../src/commands/worker/reporter.js";
import type { WorkerTelemetrySample } from "../../../src/commands/worker/telemetry.js";
import type { Operation } from "../../../src/api/operation.js";
import { workerTelemetry } from "../../fixtures/worker-telemetry.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerEvent, WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import type { Task, WorkerClaimDescriptor } from "../../../src/api/types.js";
import type { ExecutionConfiguration, ResourceOwner, WorkerProject, WorktreeBinding } from "../../../src/commands/worker/types.js";
import { createOperation } from "../../../src/api/operation.js";

const polling = vi.hoisted(() => ({ requested: [] as number[], onSchedule: undefined as ((milliseconds: number) => void) | undefined }));
vi.mock("node:timers/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: <T>(milliseconds: number, value?: T, options?: TimerOptions) => {
    polling.requested.push(milliseconds);
    polling.onSchedule?.(milliseconds);
    return actual.setTimeout(milliseconds === 1_000 ? 1 : milliseconds, value, options);
  } };
});
const emptyFormatSources = { listSchedules: () => [], listWebTasks: () => [] };
const prepareFormat: NonNullable<Parameters<typeof createWorkerGitManager>[0]["prepareFormat"]> = async (_project, repository, operation) => {
  await migrateLegacyWorktrees({ repositoryPath: repository.root, commonDirectory: repository.commonDirectory, operation, sources: emptyFormatSources });
};
const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const unknownStop = async (target: CleanupTarget): Promise<StopObservation> => ({ kind: "unknown", target, error: new Error("Unobserved test backend"), observedAt: Date.now() });
const origin = "https://daynight.example";
const workerId = uuid(1);
const configuration: ExecutionConfiguration = { agent: "codex", agentControlMode: "web", model: "current-model", args: [], recoveryLimit: 2 };
const coordinators: ReturnType<typeof createCoordinator>[] = [];
const createWorkerCoordinator = (options: Parameters<typeof createCoordinator>[0]): ReturnType<typeof createCoordinator> => {
  const coordinator = createCoordinator(options);
  const shutdown = coordinator.shutdown.bind(coordinator);
  let closing: ReturnType<typeof shutdown> | undefined;
  coordinator.shutdown = () => closing ??= shutdown();
  coordinators.push(coordinator);
  return coordinator;
};
const webStores: WebExecutionStore[] = [];
const directories: string[] = [];
const stores: ReturnType<typeof openWorkerStore>[] = [];
afterEach(async () => {
  const shutdowns = await Promise.allSettled(coordinators.splice(0).map(coordinator => coordinator.shutdown()));
  const shutdownErrors = shutdowns.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  polling.onSchedule = undefined; polling.requested.length = 0;
  vi.restoreAllMocks();
  for (const store of webStores.splice(0)) store.close();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (shutdownErrors.length > 0) throw new AggregateError(shutdownErrors, "Coordinator fixture shutdown failed.");
});
const task = (projectId: string, id: string): Task => ({ type: "task", parentId: null, id, projectId, title: id, description: "task", tags: [], status: "todo", allowAgents: true, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, version: 1n, properties: { pullRequests: [] }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true });
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 3500, interval: 10 });
it("preserves native polling values, asynchronous settlement and cancellation", async () => {
  const value = { polling: "value" };
  let settled = false;
  const result = delay(1_000, value).then(returned => { settled = true; return returned; });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(await result).toBe(value);
  for (const cancelBeforeScheduling of [true, false]) {
    const cancellation = new AbortController(); const reason = new Error("Polling cancelled.");
    if (cancelBeforeScheduling) cancellation.abort(reason);
    const failure = delay(1_000, undefined, { signal: cancellation.signal }).catch(error => error as Error & { code: string });
    await Promise.resolve();
    if (!cancelBeforeScheduling) cancellation.abort(reason);
    expect(await failure).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect((await failure as Error).cause).toBe(reason);
  }
  expect(polling.requested).toEqual([1_000, 1_000, 1_000]);
});

const fixture = async (maxConcurrent = 1, registerProject = true) => {
  const base = path.resolve("../../.tmp/minimal-coordinator-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "r-")); directories.push(root);
  const store = openWorkerStore(createMemoryDatabase()); stores.push(store);
  const project: WorkerProject = { projectId: uuid(10), repoUrl: "https://example.test/owner/repo.git", localPath: path.join(root, "repo") }; if (registerProject) store.registerProject(project);
  const candidates = [task(project.projectId, uuid(100)), task(project.projectId, uuid(101))];
  const grants = new Map<string, Task>();
  const worktrees = new Map<string, { owner: ResourceOwner; binding: WorktreeBinding }>();
  const manifests = new Map<string, { owner: ResourceOwner; binding: WorktreeBinding }>();
  const events: WorkerEvent[] = []; const order: string[] = []; let clock = 1000;
  const bind = (owner: ResourceOwner): WorktreeBinding => {
    const source = store.getProject(owner)!;
    mkdirSync(source.localPath, { recursive: true });
    return { repositoryPath: source.localPath, commonDirectory: path.join(source.localPath, ".git"), worktreePath: path.join(source.localPath, ".worktrees", "daynight", owner.worktreeId), branch: `daynight/${owner.taskId}` };
  };
  const git = {
    prepareRepository: vi.fn(), dispose: vi.fn(), removeEmptyReservation: vi.fn(async () => {}),
    prepareWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { expect(store.getTask(owner)?.status).toBe("active"); order.push("prepare-worktree"); const binding = bind(owner); await mkdir(binding.worktreePath, { recursive: true }); worktrees.set(owner.claimId, { owner, binding }); manifests.set(owner.claimId, { owner, binding }); return binding; }),
    verifyWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { const found = worktrees.get(owner.claimId); if (found === undefined) throw new Error("Original worktree missing"); return found.binding; }),
    resolveWorktreeBinding: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => (worktrees.get(owner.claimId) ?? manifests.get(owner.claimId))?.binding ?? null),
    isOriginalWorktreeAbsent: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => !worktrees.has(owner.claimId)),
    listWorktreeManifests: vi.fn(async (source: WorkerProject, _operation: Operation, includeOtherProjects = false) => [...new Map([...manifests, ...worktrees]).values()].filter(({ owner }) => owner.projectId === source.projectId || includeOtherProjects && store.getProject(owner)?.localPath === source.localPath)),
    retireWorktreeManifest: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { manifests.delete(owner.claimId); }),
    removeUnpublishedReservation: vi.fn(async () => {}),
    findWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => worktrees.get(owner.claimId)?.binding ?? null),
    scanWorktrees: scanFromList, listWorktrees: vi.fn(async (source: WorkerProject, _operation: Operation, _allowMissing = false, includeOtherProjects = false) => [...worktrees.values()].filter(({ owner, binding }) => binding.repositoryPath === source.localPath && (includeOtherProjects || owner.projectId === source.projectId))),
    removeWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { order.push("remove-worktree"); worktrees.delete(owner.claimId); return { kind: "absent" as const, effectErrors: [] }; }),
  } as unknown as WorkerGitManager;
  const grant = (candidate: Task, descriptor: WorkerClaimDescriptor): Task => {
    const result: Task = { ...candidate, status: "in_progress", ready: false, version: candidate.version + 1n, properties: { ...candidate.properties, worker: { ...descriptor, agentControlMode: descriptor.agentControlMode ?? "web", userId: uuid(2), state: "active", phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } };
    grants.set(descriptor.claimId, result); return result;
  };
  const remote = {
    serverOrigin: origin, currentUserId: vi.fn(async () => uuid(2)),
    ownInventory: vi.fn(async (projects: readonly { projectId: string }[]) => ({ tasks: [...grants.values()], coveredProjectIds: [...new Set(projects.map(project => project.projectId))], unavailableProjectIds: [] })),
    candidates: vi.fn(async function* (projectId: string, platform, _signal, platformSpecific) { for (const candidate of candidates) if (candidate.projectId === projectId && (candidate.requiredPlatform === null || candidate.requiredPlatform === platform) && (platformSpecific === undefined || (candidate.requiredPlatform !== null) === platformSpecific) && ![...grants.values()].some((value) => value.id === candidate.id)) yield candidate; }),
    claim: vi.fn(async (candidate: Task, descriptor: WorkerClaimDescriptor) => grant(candidate, descriptor)),
    readTask: vi.fn(async (_projectId: string, taskId: string) => { const result = [...grants.values()].find((value) => value.id === taskId); if (result === undefined) throw new Error("missing task"); return result; }),
    update: vi.fn(async (current: Task, update: object) => { const result = { ...current, properties: { ...current.properties, worker: { ...readWorkerClaim(current.properties)!, ...update } } }; grants.set(readWorkerClaim(current.properties)!.claimId, result); return result; }),
  } as unknown as WorkerRemote;
  const webStore = openWebExecutionStore(createMemoryDatabase()); webStores.push(webStore);
  const unexpectedBackendCall = async (): Promise<never> => { throw new Error("Unexpected Web backend call in coordinator fixture."); };
  const webBackend = { advance: unexpectedBackendCall, cleanup: unexpectedBackendCall, observeExecutionStop: unknownStop };
  const retiredNativeCleanup = createRetiredClaimNativeCleanup({ homeDirectory: root, identity: { serverOrigin: origin, workerId, userId: uuid(2) }, jobLeases: createControllerJobLeases() });
  const options = { store, webStore, webBackend, retiredNativeCleanup, git, remote, serverOrigin: origin, workerId, userId: uuid(2), platform: "linux" as const, machine: { id: uuid(3), name: "fixture" }, repositories: [{ project, configuration }], globalConfiguration: configuration, maxConcurrent, preferPlatformSpecificTasks: false, emit: (event: WorkerEvent) => events.push(event), now: () => clock };
  return { root, store, project, candidates, grants, grant, worktrees, manifests, git, remote, order, events, options, coordinator: createWorkerCoordinator(options), clock: (value: number) => { clock = value; }, bind };
};

describe("retired Web claim cleanup", () => {
  it.each(["patrol", "shutdown"] as const)("settles a retired pending-only claim with an absent repository through %s without Session reads", async entry => {
    const f = await fixture(); f.candidates.splice(0);
    const owner = { projectId: f.project.projectId, taskId: uuid(850), claimId: uuid(851) };
    f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
    const successor = f.grant(task(owner.projectId, owner.taskId), { claimId: uuid(853), worktreeId: uuid(854), workerId, agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
    const verify = vi.fn(async () => { throw new Error("Session registration cannot decide retired ownership."); });
    const runner = createCoordinator({ ...f.options, repositories: [], globalConfiguration: null, verifyWebUnregistered: verify });
    coordinators.push(runner);
    if (entry === "shutdown") await expect(runner.shutdown()).resolves.toBe(true);
    else { await runner.tick(); await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done")); }
    expect(f.store.getTask(owner)?.status).toBe("done");
    expect(f.store.getCleanupSchedule(owner)).toBeNull();
    expect(f.options.webStore.getTask(owner)).toBeNull();
    expect(verify).not.toHaveBeenCalled();
    expect(f.git.prepareRepository).not.toHaveBeenCalled();
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(readWorkerClaim(successor.properties)?.claimId).toBe(uuid(853));
  });

  it.each(["patrol", "shutdown"] as const)("uses immediate terminal cleanup through %s without consulting Session registration", async entry => {
    const f = await fixture(); f.candidates.splice(0);
    const owner = { projectId: f.project.projectId, taskId: uuid(850), claimId: uuid(851), worktreeId: uuid(852) };
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    const record = f.options.webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
    f.options.webStore.initializeWebExecution(owner, 2);
    f.options.webStore.bindWorktree(record, f.bind(owner), 2);
    const successor = f.grant(task(owner.projectId, owner.taskId), { claimId: uuid(853), workerId, worktreeId: uuid(854), agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
    const unregistered = vi.fn(async () => { throw new Error("Session registration cannot decide retired ownership."); });
    const cleanup = vi.fn<import("../../../src/commands/worker/backends/web.js").WebExecutionBackend["cleanup"]>(async (input, request) => {
      expect(request).toMatchObject({ kind: "terminal", immediateStop: true });
      if (request.kind !== "terminal") throw new Error("Expected terminal cleanup.");
      request.scope.onExecutionStopped({ attempt: request.scope.attempt, observation: { kind: "stopped", execution: { owner: input, backend: "web", runKey: input.claimId }, observedAt: 1000 } });
      return { task: f.options.webStore.beginCleanup(input, { kind: "terminal", deadline: 1000 }, 1000), complete: true };
    });
    const runner = createWorkerCoordinator({ ...f.options, repositories: [], globalConfiguration: null, verifyWebUnregistered: unregistered,
      webBackend: { cleanup, observeExecutionStop: unknownStop, advance: async input => input } });
    if (entry === "patrol") { await runner.tick(); await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done")); }
    else await expect(runner.shutdown()).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(unregistered).not.toHaveBeenCalled();
    expect(f.store.getTask(owner)?.status).toBe("done");
    expect(f.store.getCleanupSchedule(owner)).toBeNull();
    expect(readWorkerClaim(successor.properties)?.claimId).toBe(uuid(853));
  });

  it.each(["owned", "read-failed"] as const)("preserves the worktree during first-patrol shutdown when ownership is %s", async state => {
    const f = await fixture(); f.candidates.splice(0);
    const owner = { projectId: f.project.projectId, taskId: uuid(850), claimId: uuid(851), worktreeId: uuid(852) };
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    f.options.webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
    f.options.webStore.initializeWebExecution(owner, 2);
    if (state === "owned") f.grant(task(owner.projectId, owner.taskId), { ...owner, workerId, agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
    else vi.mocked(f.remote.readTask).mockRejectedValue(new Error("Ownership unavailable."));
    const cleanup = vi.fn<import("../../../src/commands/worker/backends/web.js").WebExecutionBackend["cleanup"]>(async (input, request) => {
      expect(request.kind).toBe("shutdown"); return { task: input, complete: true };
    });
    const runner = createWorkerCoordinator({ ...f.options, webBackend: { cleanup, observeExecutionStop: unknownStop, advance: async input => input } });
    await expect(runner.shutdown()).resolves.toBe(true);
    expect(f.remote.currentUserId).toHaveBeenCalledOnce();
    expect(f.remote.readTask).toHaveBeenCalledOnce();
    expect(f.store.getTask(owner)?.status).toBe("active");
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  });

  it.each(["shutdown", "patrol"] as const)("joins the original %s terminal writer before retrying a shutdown wait", async entry => {
    const f = await fixture(); f.candidates.splice(0);
    const owner = { projectId: f.project.projectId, taskId: uuid(850), claimId: uuid(851), worktreeId: uuid(852) };
    f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
    f.options.webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
    f.options.webStore.initializeWebExecution(owner, 2);
    vi.mocked(f.remote.readTask).mockResolvedValue({ ...task(owner.projectId, owner.taskId), status: "done" });
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    const independentStop = vi.fn(async () => {});
    const cleanup = vi.fn<import("../../../src/commands/worker/backends/web.js").WebExecutionBackend["cleanup"]>(async (input, request) => {
      entered.resolve(); await released.promise;
      if (request.kind !== "terminal") throw new Error("Expected terminal cleanup.");
      request.scope.onExecutionStopped({ attempt: request.scope.attempt, observation: { kind: "not-started", owner: input, observedAt: 1000 } });
      return { task: f.options.webStore.beginCleanup(input, { kind: "terminal", deadline: 1000 }, 1000), complete: true };
    });
    const runner = createCoordinator({ ...f.options, webBackend: { cleanup, requestExecutionStop: independentStop, observeExecutionStop: unknownStop, advance: async input => input } });
    coordinators.push(runner);
    try {
      if (entry === "patrol") { await runner.tick(); await entered.promise; }
      const first = runner.shutdown({ deadline: Date.now() + 100 });
      await entered.promise;
      expect(await first).toBe(false);
      const second = runner.shutdown({ deadline: Date.now() + 3000 });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(independentStop).not.toHaveBeenCalled();
      released.resolve();
      await second;
      expect(cleanup.mock.calls.filter(([, request]) => request.kind === "terminal")).toHaveLength(entry === "patrol" ? 2 : 1);
      expect(independentStop).not.toHaveBeenCalled();
    } finally { released.resolve(); await runner.shutdown(); }
  });

  it("retains terminal responsibility when an original shutdown writer fails after its observer deadline", async () => {
    const f = await fixture(); f.candidates.splice(0);
    const owner = { projectId: f.project.projectId, taskId: uuid(850), claimId: uuid(851), worktreeId: uuid(852) };
    f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
    f.options.webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
    f.options.webStore.initializeWebExecution(owner, 2);
    vi.mocked(f.remote.readTask).mockResolvedValue({ ...task(owner.projectId, owner.taskId), status: "done" });
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    const independentStop = vi.fn(async () => {});
    const failure = new Error("Original native boundary did not stop.");
    const cleanup = vi.fn(async () => { entered.resolve(); await released.promise; throw failure; });
    const runner = createCoordinator({ ...f.options, webBackend: { cleanup, requestExecutionStop: independentStop, observeExecutionStop: unknownStop, advance: async input => input } });
    coordinators.push(runner);
    try {
      const first = runner.shutdown({ deadline: Date.now() + 100 });
      await entered.promise;
      expect(await first).toBe(false);
      const second = runner.shutdown({ deadline: Date.now() + 3000 });
      expect(cleanup).toHaveBeenCalledOnce();
      released.resolve();
      expect(await second).toBe(false);
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(independentStop).not.toHaveBeenCalled();
      expect(f.store.getTask(owner)?.status).toBe("pending");
      expect(f.store.getCleanupSchedule(owner)?.nextAttemptAt).toBeGreaterThan(1000);
      expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error", error: failure }));
    } finally { released.resolve(); await runner.shutdown(); }
  });

  it("cleans an independent retired Task while another Task claim observation remains unresolved", async () => {
    const f = await fixture(); f.candidates.splice(0);
    const owners = [850, 860].map(id => ({ projectId: f.project.projectId, taskId: uuid(id), claimId: uuid(id + 1), worktreeId: uuid(id + 2) }));
    for (const owner of owners) {
      f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
      f.options.webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
      f.options.webStore.initializeWebExecution(owner, 2);
    }
    const blocked = Promise.withResolvers<import("../../../src/api/types.js").Task>();
    const currentTasks = new Map(owners.map((owner, index) => [`${owner.projectId}/${owner.taskId}`, index === 0 ? blocked.promise : Promise.resolve({ ...task(owner.projectId, owner.taskId), status: "done" as const })]));
    const cleanup = vi.fn<import("../../../src/commands/worker/backends/web.js").WebExecutionBackend["cleanup"]>(async (input, request) => {
      if (request.kind !== "terminal") throw new Error("Expected independent retired cleanup.");
      request.scope.onExecutionStopped({ attempt: request.scope.attempt, observation: { kind: "not-started", owner: input, observedAt: 1000 } });
      return { task: f.options.webStore.beginCleanup(input, { kind: "terminal", deadline: 1000 }, 1000), complete: true };
    });
    const runner = createCoordinator({ ...f.options, webBackend: { cleanup, observeExecutionStop: unknownStop, advance: async input => input } });
    coordinators.push(runner);
    try {
      const shutdown = runner.shutdown({ deadline: Date.now() + 3000, currentTasks });
      await eventually(() => expect(f.store.getTask(owners[1]!)?.status).toBe("done"));
      expect(f.store.getTask(owners[0]!)?.status).toBe("pending");
      expect(cleanup).toHaveBeenCalledOnce();
      blocked.reject(new Error("Original claim response unavailable."));
      expect(await shutdown).toBe(false);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally { blocked.resolve(task(owners[0]!.projectId, owners[0]!.taskId)); await runner.shutdown(); }
  });

  it("initializes the actual WorkerRemote account before reading ownership with no in-flight claim request", async () => {
    const { createWorkerRemote } = await import("../../../src/commands/worker/remote.js");
    const f = await fixture(); f.candidates.splice(0);
    const owner = { projectId: f.project.projectId, taskId: uuid(850), claimId: uuid(851), worktreeId: uuid(852) };
    f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
    f.options.webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
    f.options.webStore.initializeWebExecution(owner, 2);
    const paths: string[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(String(input)); paths.push(url.pathname);
      const body = url.pathname === "/api/v1/me" ? { id: uuid(2), email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: uuid(7), kind: "personal", name: null } }
        : { ...task(owner.projectId, owner.taskId), status: "done", ready: false, version: 2 };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "Daynight-User-ID": uuid(2) } });
    });
    const remote = createWorkerRemote({ serverUrl: origin, serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890" });
    const cleanup = vi.fn<import("../../../src/commands/worker/backends/web.js").WebExecutionBackend["cleanup"]>(async (input, request) => {
      if (request.kind !== "terminal") throw new Error("Expected terminal cleanup after ownership observation.");
      request.scope.onExecutionStopped({ attempt: request.scope.attempt, observation: { kind: "not-started", owner: input, observedAt: 1000 } });
      return { task: f.options.webStore.beginCleanup(input, { kind: "terminal", deadline: 1000 }, 1000), complete: true };
    });
    const runner = createWorkerCoordinator({ ...f.options, remote, repositories: [], globalConfiguration: null,
      webBackend: { cleanup, observeExecutionStop: unknownStop, advance: async input => input } });
    try {
      const stopped = await runner.shutdown();
      expect(stopped, f.events.map(event => `${event.message}: ${String(event.error)}`).join("\n")).toBe(true);
      expect(paths).toEqual(["/api/v1/me", `/api/v1/projects/${owner.projectId}/tasks/${owner.taskId}`]);
      expect(f.store.getTask(owner)?.status).toBe("done");
    } finally { fetch.mockRestore(); }
  });
});

const stoppedWebExecution = async (f: Awaited<ReturnType<typeof fixture>>, store: WebExecutionStore, task: WebTask) => {
  const execution = task.webExecution!;
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, sessionId: execution.sessionId!, executionGeneration: execution.executionGeneration, serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, userId: task.userId!, provider: task.configuration!.agent, cwd: f.project.localPath, nativeHome: path.join(f.root, "native"), configuration: task.configuration!, initialOperationId: execution.initialOperationId, initialPrompt: "managed", resumeNativeSessionId: null, credentialFile: path.join(f.root, "grant.json"), ipcEndpoint: path.join(f.root, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  task = store.updateWebExecution(task, { ticketPath: await writeLaunchTicket(f.root, ticket) }, 6);
  const snapshot: lifecycle.ControllerSnapshot = { executionId: execution.executionId, claimId: task.claimId, sessionId: execution.sessionId!, executionGeneration: execution.executionGeneration, controllerInstanceId: execution.controllerInstanceId, lifecycle: "stopped", nativeSessionId: null, initialInputState: "confirmed", activity: "stopped", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, controllerProcess: { pid: 123, parentPid: 1, processGroupId: 123, startedAt: "birth", commandHash: "a".repeat(64) }, nativeProcesses: [], nativeStopped: true, stoppedAt: new Date().toISOString(), error: null };
  task = store.updateWebExecution(task, { controllerProcess: snapshot.controllerProcess }, 7);
  vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("stopped");
  vi.spyOn(lifecycle, "readControllerSnapshot").mockReturnValue(snapshot);
  vi.spyOn(lifecycle, "readCompatibleControllerSnapshot").mockImplementation((file, original) => {
    expect(file).toBe(path.join(controllerExecutionDirectory(f.root, ticket.executionId), "journal.sqlite"));
    expect(original).toEqual(ticket);
    return snapshot;
  });
  // These cases exercise archive scheduling after stop has been proven; the
  // Windows proof boundary itself is covered by the lifecycle integration tests.
  vi.spyOn(lifecycle, "readProvenWindowsStoppedControllerGeneration").mockReturnValue(snapshot);
  vi.spyOn(launchObservation, "reconcileSubmittedControllerLaunch").mockImplementation(async input => ({ kind: "controller-exited", process: input.spawnProof, snapshot }));
  vi.spyOn(lifecycle, "recordStoppedControllerGeneration").mockResolvedValue(snapshot);
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  return { task, ticket, snapshot, jobLeases: createControllerJobLeases("win32"), request: vi.fn<typeof requestController>().mockRejectedValue(new ControllerIpcOutcomeUnknownError("Original controller is stopped.")) };
};

describe("worker report publication boundaries", () => {

  it("retries metadata retirement without reviving a slot or the same-task barrier", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(951), worktreeId: uuid(952) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    const config = { ...configuration, agentControlMode: "web" as const };
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
    record = webStore.bindWorktree(record, f.bind(owner), 2);
    record = webStore.beginCleanup(record, { kind: "terminal", deadline: 100 }, 2);
    webStore.completeTask(record, 3);
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    vi.mocked(f.git.retireWorktreeManifest).mockRejectedValueOnce(new Error("manifest unlink failed")).mockRejectedValueOnce(new Error("manifest unlink failed"));
    const coordinator = createWorkerCoordinator({ ...f.options, webStore });
    try {
      expect(() => coordinator.assertCanAcquire(owner)).not.toThrow();
      const candidates = f.candidates.splice(0);
      await coordinator.tick();
      expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error", message: "Worktree metadata retirement remains pending." }));
      expect(f.manifests.has(owner.claimId)).toBe(true);
      expect(f.store.getCleanupSchedule(owner)).toBeNull();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
      expect(() => coordinator.assertCanAcquire(owner)).not.toThrow();
      f.candidates.push(...candidates);
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(true);
      expect(f.remote.claim).toHaveBeenCalledOnce();
      expect(vi.mocked(f.remote.claim).mock.calls[0]![0].id).toBe(owner.taskId);
      await eventually(async () => { await coordinator.tick(); expect(f.manifests.has(owner.claimId)).toBe(false); });
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("retires settled Web metadata", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(951), worktreeId: uuid(952) };
    const config = { ...configuration, args: [], agentControlMode: "web" as const };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
    record = webStore.bindWorktree(record, f.bind(owner), 2);
    record = webStore.beginCleanup(record, { kind: "terminal", deadline: 100 }, 2); webStore.completeTask(record, 3);
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async task => task), cleanup: vi.fn() } });
    try {
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(false);
      expect(f.remote.claim).toHaveBeenCalledOnce();
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("preserves a Web manifest without its backend record while admitting another Web task", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(951), worktreeId: uuid(952) };
    const config = { ...configuration, args: [], agentControlMode: "web" as const };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    f.candidates.splice(0, 1);
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async task => task), cleanup: vi.fn() } });
    try {
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(true);
      expect(f.git.retireWorktreeManifest).not.toHaveBeenCalled();
      expect(vi.mocked(f.remote.claim).mock.calls.map(([candidate]) => candidate.id)).toEqual([uuid(101)]);
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("does not retire a manifest from LocalTask.done without backend settlement evidence", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: uuid(970), claimId: uuid(971), worktreeId: uuid(972) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: { ...configuration, agentControlMode: "web" } }, 1);
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    vi.mocked(f.git.findWorktree).mockResolvedValue(f.bind(owner));
    const coordinator = createWorkerCoordinator({ ...f.options, webStore });
    try {
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(true);
      expect(f.git.retireWorktreeManifest).not.toHaveBeenCalled();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("retains and reports metadata when completed Web execution has no original binding", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: uuid(970), claimId: uuid(971), worktreeId: uuid(972) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: { ...configuration, agentControlMode: "web" } }, 1);
    record = webStore.beginCleanup(record, { kind: "terminal", deadline: 100 }, 2); webStore.completeTask(record, 3);
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    f.candidates.splice(0);
    const coordinator = createWorkerCoordinator({ ...f.options, webStore });
    try {
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(true);
      expect(f.git.retireWorktreeManifest).not.toHaveBeenCalled();
      expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error", message: "Worktree metadata retirement remains pending." }));
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

});

describe("minimal worker resource reconciliation", () => {

  it("completes Web control with the original execution", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: uuid(951), claimId: uuid(952), worktreeId: uuid(953) };
    const config = { ...configuration, args: [], agentControlMode: "web" as const };
    f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
    f.store.activateTask(owner);
    let task = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
    task = webStore.beginCleanup(task, { kind: "terminal", deadline: 100 }, 2);
    const cleanup = vi.fn(async (_input: WebTask, request: import("../../../src/commands/worker/execution-stop.js").CleanupRequest) => {
      if (request.kind !== "terminal") throw new Error("Expected terminal cleanup");
      request.scope.onExecutionStopped({ attempt: request.scope.attempt, observation: { kind: "not-started", owner, observedAt: 1000 } });
      return { task, complete: true };
    });
    const coordinator = createWorkerCoordinator({ ...f.options, globalConfiguration: config, repositories: [], webStore,
      webBackend: { cleanup, advance: vi.fn(async value => value), observeExecutionStop: unknownStop } });
    try {
      await coordinator.completeSource(owner);
      expect(f.store.getTask(owner)?.status).toBe("done");
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

});

describe("worker cancellation classification", () => {
  it("recognizes an aggregate made entirely of the current shutdown cancellations", () => {
    const controller = new AbortController(); const reason = new Error("Worker operation interrupted."); controller.abort(reason);
    const first = new OperationError("cancelled", { cause: reason });
    const second = new Error("Endpoint request stopped", { cause: new OperationError("cancelled", { cause: reason }) });
    expect(isWorkerCancellation(new AggregateError([first, second], "Both endpoints could not be inspected"), controller.signal)).toBe(true);
    expect(isWorkerCancellation(new AggregateError([new AggregateError([first, second], "Concurrent cancellation")], "Shutdown"), controller.signal)).toBe(true);
    expect(isWorkerCancellation(new AggregateError([first, second], "Shutdown", { cause: reason }), controller.signal)).toBe(true);
  });

  it("preserves a real endpoint failure mixed with cancellation", () => {
    const controller = new AbortController(); const reason = new Error("Worker operation interrupted."); controller.abort(reason);
    const cancellation = new OperationError("cancelled", { cause: reason });
    expect(isWorkerCancellation(new AggregateError([cancellation, new Error("Endpoint configuration invalid")], "Endpoints failed", { cause: reason }), controller.signal)).toBe(false);
    expect(isWorkerCancellation(new AggregateError([], "No endpoint observations", { cause: reason }), controller.signal)).toBe(false);
    expect(isWorkerCancellation(new AggregateError([cancellation], "Cleanup and cancellation", { cause: new Error("Cleanup failed") }), controller.signal)).toBe(false);
  });

  it("does not suppress another operation's cancellation or errors before shutdown", () => {
    const controller = new AbortController(); const reason = new Error("Worker operation interrupted.");
    const cancellation = new OperationError("cancelled", { cause: reason });
    expect(isWorkerCancellation(new AggregateError([cancellation], "Not shutting down"), controller.signal)).toBe(false);
    controller.abort(reason);
    expect(isWorkerCancellation(new AggregateError([new OperationError("cancelled", { cause: new Error("Another operation") })], "Foreign cancellation"), controller.signal)).toBe(false);
  });
});

it("waits before registering a new Web execution after awaited configuration preparation", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(); const webStore = openWebExecutionStore(createMemoryDatabase());
  const config = { ...configuration, agentControlMode: "web" as const, args: [] };
  let complete = true, preparations = 0;
  const register = vi.spyOn(webStore, "register"), advance = vi.fn(async record => record);
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config,
    configurationComplete: () => complete, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {},
    freezeConfiguration: async value => { await Promise.resolve(); if (++preparations === 2) complete = false; return value; },
    webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
  try {
    await coordinator.tick();
    await eventually(() => expect(complete).toBe(false));
    expect(register).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("routes Web claims, freezes launch settings, and keeps interaction state out of task summary", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(); const webStore = openWebExecutionStore(createMemoryDatabase());
  const webConfiguration = { agent: "codex" as const, agentControlMode: "web" as const, model: "frozen-model", args: [], recoveryLimit: 2 };
  const monitor = createMonitoringObserver();
  let controllerActivity: "waiting_input" | "working" = "waiting_input";
  const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => {
    let record = webStore.initializeWebExecution(input, 2);
    record = webStore.updateWebExecution(record, { activity: controllerActivity, initialInputState: "confirmed" }, 3);
    return webStore.bindNativeSession(record, { source: "controller", sessionId: uuid(880) }, 4);
  });
  const verifyWebUnregistered = vi.fn(async () => {});
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: webConfiguration }], globalConfiguration: webConfiguration, webStore, monitoring: monitor, verifyWebServer: vi.fn(async () => {}), verifyWebUnregistered, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
  try {
    await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledOnce());
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    expect(row).toMatchObject({ agentControlMode: "web", sessionId: uuid(880) });
    expect(vi.mocked(f.remote.update).mock.calls[0]![1]).toEqual({ phase: "executing", nativeSessionId: uuid(880) });
    expect(monitor.capture().activities).toEqual([expect.objectContaining({ kind: "execution", phase: "waiting", status: "waiting", waitReason: "native-input" })]);
    controllerActivity = "working";
    webConfiguration.model = "changed-model";
    Object.assign(webConfiguration, { args: ["--search"] });
    await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(2));
    await eventually(() => expect(monitor.capture().activities).toEqual([expect.objectContaining({ kind: "execution", phase: "executing", status: "running", waitReason: null })]));
    expect(webStore.getTask(row)?.configuration?.model).toBe("frozen-model");
    expect(verifyWebUnregistered).toHaveBeenCalledOnce();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("keeps active missing-Web recovery guarded and clears retired local inventory independently of Session registration", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(); const webStore = openWebExecutionStore(createMemoryDatabase());
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: { id: uuid(3), name: "fixture" } });
  const row = f.store.registerPending({ projectId: remote.projectId, taskId: remote.id, claimId: uuid(810), agent: "codex", agentControlMode: "web" }); f.store.activateTask(row);
  const advance = vi.fn(), cleanup = vi.fn(); const refusal = new Error("Existing Session requires original execution evidence.");
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore, webBackend: { observeExecutionStop: unknownStop, advance, cleanup }, verifyWebServer: vi.fn(async () => {}), verifyWebUnregistered: vi.fn(async () => { throw refusal; }) });
  try {
    await coordinator.tick(); await eventually(() => expect(f.events.some(event => event.kind === "execution-error")).toBe(true));
    expect(advance).not.toHaveBeenCalled(); expect(webStore.getTask(row)).toBeNull();
    await expect(coordinator.cleanupSource(row, { deleteWorktree: true })).rejects.toBe(refusal);
    expect(cleanup).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(f.store.getTask(row)?.status).toBe("active");
    f.grants.clear();
    await coordinator.tick();
    await eventually(() => expect(f.store.getTask(row)?.status).toBe("done"));
    expect(await coordinator.shutdown()).toBe(true);
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it.each(["archive", "worktree removal"])("releases a deleted Web task's slot while %s remains pending", async stage => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const f = await fixture(1), webStore = openWebExecutionStore(createMemoryDatabase());
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
  const owner = { projectId: remote.projectId, taskId: remote.id, claimId: uuid(810), worktreeId: uuid(811) };
  f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
  f.store.activateTask(owner);
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
  record = webStore.bindWorktree(record, await f.git.prepareWorktree(f.project, owner, {} as Operation), 2);
  record = webStore.initializeWebExecution(record, 3);
  record = webStore.updateWebExecution(record, { sessionId: uuid(812), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
  const stopped = await stoppedWebExecution(f, webStore, record);
  record = webStore.beginCleanup(stopped.task, { kind: "terminal", deadline: 100 }, 7);

  // Deleted tasks disappear from the remote inventory, while local cleanup remains durable.
  f.grants.clear(); f.candidates.shift();
  let cleanupAvailable = false;
  const allowRemoval = Promise.withResolvers<void>();
  const archive = async () => { if (stage === "archive" && !cleanupAvailable) throw new Error("archive unavailable"); f.order.push("archive-ready"); };
  const removeWorktree = vi.mocked(f.git.removeWorktree).getMockImplementation()!;
  vi.mocked(f.git.removeWorktree).mockImplementation(async (...args) => {
    if (stage === "worktree removal" && !cleanupAvailable) throw new Error("worktree deletion denied");
    await allowRemoval.promise;
    return removeWorktree(...args);
  });
  const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 1000, archive, jobLeases: stopped.jobLeases, request: stopped.request });
  const advance = async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => webStore.initializeWebExecution(input, 1000);
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore, webBackend: { ...backend, advance }, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
  try {
    await coordinator.tick();
    if (stage === "archive") await eventually(() => expect(f.git.removeWorktree).toHaveBeenCalledOnce());
    else await eventually(() => expect(f.events.some(event => event.kind === "cleanup-error")).toBe(true));
    expect(f.store.getTask(owner)?.status).toBe("active");
    expect(f.worktrees.has(owner.claimId)).toBe(true);
    await coordinator.tick();
    await eventually(() => expect(f.remote.claim).toHaveBeenCalledOnce());
    cleanupAvailable = true;
    f.clock(2000);
    allowRemoval.resolve();
    await coordinator.tick();
    await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done"));
    expect(webStore.getTask(owner)?.status).toBe("done");
    expect(f.order).toContain("remove-worktree");
    // The done row is visible before the cleanup job's final responsibility is released.
    await vi.waitFor(async () => {
      await coordinator.tick();
      expect(f.store.listUnfinishedTasks().some(task => task.taskId === f.candidates[0]!.id && task.status === "active")).toBe(true);
    }, { timeout: 3500, interval: 10 });
    expect(f.remote.claim).toHaveBeenCalledOnce();
    expect(f.events.filter(event => event.kind === "cleanup-error")).toHaveLength(stage === "archive" ? 0 : 1);
    // A completed record still reconciles the original claim against physical resources.
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    await coordinator.completeSource(owner);
    expect(f.worktrees.has(owner.claimId)).toBe(true);
    await coordinator.completeSource(owner);
    await coordinator.shutdown();
  } finally { allowRemoval.resolve(); await coordinator.shutdown(); webStore.close(); }
});

it.each(["supported", "legacy", "unavailable"])("reconciles paused summaries with %s startup reporting without advancing recovery", async support => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 0 };
  const advance = vi.fn(async (input: WebTask) => {
    webStore.pauseRecovery(input, "No original identity.", 2);
    return webStore.getTask(input)!;
  });
  const observeStartupReport = vi.fn((input: WebTask) => ({ schemaVersion: 1 as const, source: "worker" as const,
    sessionId: uuid(888), claimId: input.claimId, executionGeneration: "1", controllerInstanceId: uuid(889), revision: "1",
    observedAt: "2026-11-05T00:00:00.000Z", startup: { state: "unknown" as const, reasonCode: "native_timeout" as const },
    recovery: { state: "blocked" as const, reasonCode: "native_identity_missing" as const } }));
  let calls = 0;
  vi.mocked(f.remote.update).mockImplementation(async (current, input) => {
    calls++;
    if (calls === 1) {
      f.grants.set(readWorkerClaim(current.properties)!.claimId, { ...current, version: 17n });
      throw new Error("Unconfirmed report response.");
    }
    const { startupReport, ...summary } = input;
    const updated = { ...current, properties: { ...current.properties, ...(startupReport ? { sessionStartup: startupReport } : {}), worker: { ...readWorkerClaim(current.properties)!, ...summary } } };
    f.grants.set(readWorkerClaim(current.properties)!.claimId, updated); return updated;
  });
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration,
    webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, verifyWebStartupReporting: async () => {
      if (support === "unavailable") throw new Error("Capabilities response unavailable.");
      return support === "supported";
    },
    webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(), observeStartupReport } });
  const tick = async () => { await coordinator.tick(); await new Promise<void>(resolve => setImmediate(resolve)); };
  try {
    await tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    await tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledTimes(2));
    expect(vi.mocked(f.remote.update).mock.calls[1]![0].version).toBe(17n);
    if (support === "supported") expect(vi.mocked(f.remote.update).mock.calls[1]![1]).toHaveProperty("startupReport.startup.reasonCode", "native_timeout");
    else expect(vi.mocked(f.remote.update).mock.calls[1]![1]).not.toHaveProperty("startupReport");
    await tick(); await tick();
    expect(advance).toHaveBeenCalledOnce();
    expect(f.remote.update).toHaveBeenCalledTimes(2);
    expect(webStore.getTask(f.store.listTasks()[0]!)?.recovery.count).toBe(0);
  } finally { await coordinator.shutdown(); webStore.close(); }
});

const seedSummaryClaim = (f: Awaited<ReturnType<typeof fixture>>): Task => {
  const claimed = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
  const owner = { projectId: claimed.projectId, taskId: claimed.id, claimId: uuid(810), worktreeId: uuid(811) };
  f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
  return claimed;
};

it.each(["already-current", "still-different", "claim-changed", "claim-completed", "status-changed", "project-changed", "task-changed", "worker-changed", "user-changed", "worktree-changed", "agent-changed", "mode-changed", "session-changed", "session-newly-bound"] as const)("rechecks the summary after inventory when the remote task is %s", async scenario => {
  const f = await fixture();
  const inventoryTask = seedSummaryClaim(f);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const advance = vi.fn(async (input: WebTask) => {
    let record = f.options.webStore.pauseRecovery(input, "No original identity.", 2);
    if (scenario === "session-changed") record = f.options.webStore.bindNativeSession(record, { source: "controller", sessionId: uuid(880) }, 3);
    entered.resolve();
    await release.promise;
    return f.options.webStore.getTask(input)!;
  });
  const coordinator = createWorkerCoordinator({ ...f.options, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {},
    webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
  try {
    await coordinator.tick();
    await entered.promise;
    expect(f.remote.ownInventory).toHaveBeenCalled();
    const original = [...f.grants.values()][0]!;
    expect(original).toBe(inventoryTask);
    expect(original.version).toBe(2n);
    const claim = readWorkerClaim(original.properties)!;
    const fresh: Task = { ...original, version: 3n, status: scenario === "status-changed" ? "done" : original.status,
      projectId: scenario === "project-changed" ? uuid(990) : original.projectId, id: scenario === "task-changed" ? uuid(991) : original.id,
      properties: { ...original.properties, worker: { ...claim,
        ...(scenario === "already-current" ? { phase: "waiting" as const } : {}),
        ...(scenario === "claim-changed" ? { claimId: uuid(999) } : {}),
        ...(scenario === "claim-completed" ? { state: "completed" as const } : {}),
        ...(scenario === "worker-changed" ? { workerId: uuid(998) } : {}),
        ...(scenario === "user-changed" ? { userId: uuid(997) } : {}),
        ...(scenario === "worktree-changed" ? { worktreeId: uuid(996) } : {}),
        ...(scenario === "agent-changed" ? { agent: "copilot" as const } : {}),
        ...(scenario === "mode-changed" ? { agentControlMode: "herdr" as const, herdr: { session: "session", workspaceId: "workspace", paneId: "pane" } } : {}),
        ...(scenario === "session-changed" || scenario === "session-newly-bound" ? { nativeSessionId: uuid(995) } : {}) } } };
    f.grants.set(claim.claimId, fresh);
    vi.mocked(f.remote.readTask).mockResolvedValueOnce(fresh);
    release.resolve();
    await eventually(() => expect(f.remote.readTask).toHaveBeenCalledWith(original.projectId, original.id, expect.any(AbortSignal)));
    if (scenario === "still-different") {
      await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
      expect(vi.mocked(f.remote.update).mock.calls[0]![0]).toBe(fresh);
      expect(vi.mocked(f.remote.update).mock.calls[0]![1]).toEqual({ phase: "waiting", nativeSessionId: null });
    } else {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.remote.update).not.toHaveBeenCalled();
    }
    expect(advance).toHaveBeenCalledOnce();
    if (scenario === "already-current") {
      vi.mocked(f.remote.readTask).mockClear();
      await coordinator.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.remote.readTask).not.toHaveBeenCalled();
      expect(f.remote.update).not.toHaveBeenCalled();
    }
  } finally { release.resolve(); await coordinator.shutdown(); }
});

it.each(["fresh-current", "fresh-different", "inventory-different"] as const)("recompares the observed startup report against the fresh task: %s", async scenario => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const report = (claimId: string) => ({ schemaVersion: 1 as const, source: "worker" as const, sessionId: uuid(888), claimId,
    executionGeneration: "1", controllerInstanceId: uuid(889), revision: "2", observedAt: "2026-11-05T00:00:00.000Z",
    startup: { state: "unknown" as const, reasonCode: "native_timeout" as const }, recovery: { state: "blocked" as const, reasonCode: "native_identity_missing" as const } });
  const claimed = seedSummaryClaim(f), claimedId = readWorkerClaim(claimed.properties)!.claimId;
  f.grants.set(claimedId, { ...claimed, properties: { ...claimed.properties, sessionStartup: scenario === "inventory-different" ? { ...report(claimedId), revision: "1" } : report(claimedId) } });
  const advance = vi.fn(async (input: WebTask) => {
    f.options.webStore.pauseRecovery(input, "No original identity.", 2);
    entered.resolve(); await release.promise;
    return f.options.webStore.getTask(input)!;
  });
  const verify = vi.fn(async () => true);
  const coordinator = createWorkerCoordinator({ ...f.options, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, verifyWebStartupReporting: verify,
    webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(), observeStartupReport: input => report(input.claimId) } });
  try {
    await coordinator.tick(); await entered.promise;
    const original = [...f.grants.values()][0]!, claim = readWorkerClaim(original.properties)!;
    const fresh: Task = { ...original, version: 3n, properties: { ...original.properties, worker: { ...claim, phase: "waiting" },
      sessionStartup: scenario === "fresh-different" ? { ...report(claim.claimId), revision: "1" } : report(claim.claimId) } };
    f.grants.set(claim.claimId, fresh); release.resolve();
    await eventually(() => expect(f.remote.readTask).toHaveBeenCalledWith(original.projectId, original.id, expect.any(AbortSignal)));
    expect(verify).toHaveBeenCalledOnce();
    if (scenario === "fresh-different") {
      await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
      expect(vi.mocked(f.remote.update).mock.calls[0]![0]).toBe(fresh);
      expect(vi.mocked(f.remote.update).mock.calls[0]![1]).toEqual({ phase: "waiting", nativeSessionId: null, startupReport: report(claim.claimId) });
    } else {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.remote.update).not.toHaveBeenCalled();
    }
  } finally { release.resolve(); await coordinator.shutdown(); }
});

it.each(["read-failed", "version-conflict", "other-refusal", "unconfirmed-conflict", "unknown"] as const)("defers a %s summary result to the next reconciliation without retrying native recovery", async scenario => {
  const f = await fixture();
  seedSummaryClaim(f);
  const advance = vi.fn(async (input: WebTask) => {
    f.options.webStore.pauseRecovery(input, "No original identity.", 2);
    return f.options.webStore.getTask(input)!;
  });
  const cause = new Error(`controlled ${scenario}`);
  const failure = ["version-conflict", "other-refusal", "unconfirmed-conflict"].includes(scenario) ? new ApiError({ operation: "worker.update" }, "response", {
    cause, status: 409, serverError: { code: scenario === "other-refusal" ? "claim_conflict" : "version_conflict", message: "stale version", requestId: "summary-request" }, confirmedRefusal: scenario !== "unconfirmed-conflict", outcomeUnconfirmed: scenario === "unconfirmed-conflict",
  }) : cause;
  const normalUpdate = vi.mocked(f.remote.update).getMockImplementation()!;
  if (scenario === "read-failed") vi.mocked(f.remote.readTask).mockRejectedValueOnce(failure);
  else vi.mocked(f.remote.update).mockImplementationOnce(async (current, input, signal) => {
    const claimId = readWorkerClaim(current.properties)!.claimId;
    f.grants.set(claimId, { ...current, version: current.version + 1n });
    if (scenario === "version-conflict") {
      if (f.grants.get(claimId)!.version !== current.version) throw failure;
      return normalUpdate(current, input, signal);
    }
    throw failure;
  });
  const coordinator = createWorkerCoordinator({ ...f.options, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {},
    webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
  const tick = async () => { await coordinator.tick(); await new Promise<void>(resolve => setImmediate(resolve)); };
  try {
    await tick();
    await eventually(() => expect(f.events.some(event => event.kind === "summary-error" && event.error === failure)).toBe(true));
    const diagnostic = f.events.find(event => event.kind === "summary-error" && event.error === failure)!;
    if (scenario === "version-conflict") {
      expect(diagnostic.message).toMatch(/rejected.*version/i);
      expect(failure).toMatchObject({ code: "version_conflict", requestId: "summary-request", cause });
    } else if (scenario === "other-refusal") expect(diagnostic.message).toMatch(/rejected/i);
    else if (scenario !== "read-failed") expect(diagnostic.message).toMatch(/not confirmed/i);
    expect(f.remote.update).toHaveBeenCalledTimes(scenario === "read-failed" ? 0 : 1);
    if (scenario !== "read-failed") expect(vi.mocked(f.remote.update).mock.calls[0]![0].version).toBe(2n);
    await tick();
    await eventually(() => expect(f.remote.update).toHaveBeenCalledTimes(scenario === "read-failed" ? 1 : 2));
    if (scenario !== "read-failed") expect(vi.mocked(f.remote.update).mock.calls[1]![0].version).toBe(3n);
    expect(advance).toHaveBeenCalledOnce();
    expect(f.options.webStore.getTask(f.store.listTasks()[0]!)?.recovery.count).toBe(0);
  } finally { await coordinator.shutdown(); }
});

it.each(["worker", "sessionStartup"] as const)("reports malformed fresh %s as a summary error without starting native recovery", async field => {
  const f = await fixture(); seedSummaryClaim(f);
  const advance = vi.fn(async (input: WebTask) => {
    f.options.webStore.pauseRecovery(input, "No original identity.", 2);
    return f.options.webStore.getTask(input)!;
  });
  const report = (input: WebTask) => ({ schemaVersion: 1 as const, source: "worker" as const, sessionId: uuid(888), claimId: input.claimId,
    executionGeneration: "1", controllerInstanceId: uuid(889), revision: "1", observedAt: "2026-11-05T00:00:00.000Z",
    startup: { state: "unknown" as const, reasonCode: "native_timeout" as const }, recovery: { state: "blocked" as const, reasonCode: "native_identity_missing" as const } });
  const original = [...f.grants.values()][0]!;
  vi.mocked(f.remote.readTask).mockResolvedValueOnce({ ...original, version: 3n, properties: { ...original.properties, [field]: {} } });
  const coordinator = createWorkerCoordinator({ ...f.options, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, verifyWebStartupReporting: async () => true,
    webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(), observeStartupReport: report } });
  try {
    await coordinator.tick();
    await eventually(() => expect(f.events.some(event => event.kind === "summary-error")).toBe(true));
    expect(f.events.some(event => event.kind === "execution-error")).toBe(false);
    expect(f.remote.update).not.toHaveBeenCalled();
    expect(advance).toHaveBeenCalledOnce();
    expect(f.options.webStore.getTask(f.store.listTasks()[0]!)?.recovery.count).toBe(0);
  } finally { await coordinator.shutdown(); }
});

it.each(["claim", "worktree"])("rejects Web retry after original %s loss without authorizing or advancing it", async field => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => input);
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
  try {
    await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledOnce());
    await new Promise<void>(resolve => setImmediate(resolve));
    const row = f.store.listTasks()[0]!;
    const original = f.grants.get(row.claimId)!;
    f.grants.set(row.claimId, { ...original, properties: { ...original.properties, worker: { ...readWorkerClaim(original.properties)!, ...(field === "claim" ? { claimId: uuid(999) } : { worktreeId: uuid(999) }) } } });
    await expect(coordinator.advanceRetry(row)).rejects.toThrow(/no longer/);
    expect(webStore.getTask(row)?.recovery.retryAuthorized).toBe(false);
    expect(advance).toHaveBeenCalledOnce();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("keeps an authorized Web retry waiting until a healthy observation after confirmed shutdown", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver();
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 0, toolLaunch: frozenToolLaunch() };
  let starting = true;
  const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => {
    let record = webStore.initializeWebExecution(input, 2);
    if (record.recovery.retryAuthorized && record.recovery.pauseReason !== null) {
      const e = record.webExecution!;
      record = webStore.beginWebGeneration(record, { executionGeneration: e.executionGeneration, controllerInstanceId: e.controllerInstanceId, nativeSessionId: uuid(880), nativeStopped: true }, 3);
    }
    record = webStore.updateWebExecution(record, { activity: starting ? "initializing" : "working" }, 4);
    record = webStore.bindNativeSession(record, { source: "controller", sessionId: uuid(880) }, 5);
    if (!starting && record.recovery.retryAuthorized) {
      const e = record.webExecution!;
      record = webStore.completeRecoveryRetry(record, { executionId: e.executionId, claimId: record.claimId, sessionId: e.sessionId!, executionGeneration: e.executionGeneration, controllerInstanceId: e.controllerInstanceId, lifecycle: "ready", nativeSessionId: uuid(880), initialInputState: "confirmed", activity: "working", currentTurnId: null, capabilities: { send: true, steer: true, cancel: true, respond: true }, controllerProcess: null, nativeProcesses: [], nativeStopped: false, stoppedAt: null, error: null }, 6);
    }
    return record;
  });
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(async input => ({ task: input, complete: true })) } });
  try {
    await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    webStore.pauseRecovery(row, "Recovery exhausted.", 6);
    await coordinator.tick();
    await eventually(() => expect(monitor.capture().currentFailures).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ code: "recovery-blocked" }) })));
    const recovery = monitor.capture().currentFailures.find(item => item.error.code === "recovery-blocked")!;
    webStore.beginCleanup(row, { kind: "shutdown", deadline: 9 }, 7);

    await coordinator.advanceRetry(row);
    expect(webStore.getTask(row)?.cleanup).toBeNull();
    expect(webStore.getTask(row)?.recovery).toMatchObject({ count: 1, retryAuthorized: true });
    expect(readWorkerClaim(f.grants.get(row.claimId)!.properties)?.phase).toBe("waiting");
    await coordinator.tick();
    await eventually(() => expect(advance.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(monitor.capture().currentFailures).toContainEqual(expect.objectContaining({ operationId: recovery.operationId }));
    starting = false;
    await coordinator.tick();
    await eventually(() => expect(readWorkerClaim(f.grants.get(row.claimId)!.properties)?.phase).toBe("executing"));
    await eventually(() => expect(monitor.capture().lastRecovery).toMatchObject({ operationId: recovery.operationId }));
    expect(webStore.getTask(row)?.recovery.count).toBe(1);
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("returns a Web retry's input wait without claiming a completed submission", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 0 };
  const advance = vi.fn(async (input: WebTask) => input);
  const advanceResult = vi.fn(async (input: WebTask) => ({ kind: "waiting_input" as const, reason: "prompt_too_large" as const, task: input }));
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore,
    verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, advanceResult, cleanup: vi.fn() } });
  try {
    await coordinator.tick(); await eventually(() => expect(advanceResult).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    expect(await coordinator.advanceRetry(row)).toEqual({ kind: "waiting_input", reason: "prompt_too_large" });
    expect(readWorkerClaim(f.grants.get(row.claimId)!.properties)?.phase).toBe("waiting");
    expect(f.store.getTask(row)).toMatchObject({ status: "active", claimId: row.claimId });
    expect(advance).not.toHaveBeenCalled();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it.each([false, true])("retains an interrupted orderly stop and refuses a second legacy adoption (new coordinator=%s)", async restart => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
  const config = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
  const owner = { projectId: f.project.projectId, taskId: remote.id, claimId: uuid(810), worktreeId: uuid(811) };
  f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
  record = webStore.initializeWebExecution(record, 2);
  const advance = vi.fn(async (value: WebTask) => value);
  const advanceResult = vi.fn(async (value: WebTask) => ({ kind: "upgrade" as const, task: value }));
  const confirmUpgrade = vi.fn(async (value: WebTask) => ({ kind: "upgrade" as const, task: value }));
  let stopCalls = 0;
  const cleanup = vi.fn(async (value: WebTask) => {
    stopCalls++;
    const stopped = value.cleanup === null ? webStore.beginCleanup(value, { kind: "shutdown", deadline: 1000 }, 3) : value;
    return { task: stopped, complete: restart || stopCalls > 1 };
  });
  if (restart) webStore.beginCleanup(record, { kind: "shutdown", deadline: 1000 }, 3);
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore,
    verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, advanceResult, confirmUpgrade, cleanup } });
  try {
    await coordinator.tick();
    await eventually(() => expect(cleanup).toHaveBeenCalledTimes(1));
    if (!restart) {
      expect(webStore.getTask(owner)?.cleanup?.kind).toBe("shutdown");
      await coordinator.tick();
      await eventually(() => expect(cleanup).toHaveBeenCalledTimes(2));
    }
    await eventually(() => expect(f.events).toContainEqual(expect.objectContaining({ kind: "execution-error", error: expect.objectContaining({ message: expect.stringContaining("does not support Worker input protocol") }) })));
    expect(confirmUpgrade).toHaveBeenCalledTimes(restart ? 0 : 1);
    expect(webStore.getTask(owner)?.cleanup).toBeNull();
    expect(webStore.getTask(owner)?.webExecution?.restartAfterShutdown).toBe(true);
    expect(webStore.getTask(owner)?.claimId).toBe(owner.claimId);
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it.each(["paused", "revoked", "changed_claim"] as const)("rechecks %s before resuming an existing Web stop", async state => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
  const config = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
  const owner = { projectId: f.project.projectId, taskId: remote.id, claimId: uuid(810), worktreeId: uuid(811) };
  f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
  record = webStore.initializeWebExecution(record, 2);
  webStore.beginCleanup(record, { kind: "shutdown", deadline: 1000 }, 3);
  const fresh = state === "paused" ? { ...remote, properties: { ...remote.properties, blocked: true } }
    : state === "revoked" ? { ...remote, allowAgents: false, properties: { ...remote.properties, blocked: true } }
    : { ...remote, properties: { ...remote.properties, worker: { ...readWorkerClaim(remote.properties)!, claimId: uuid(999) } } };
  vi.mocked(f.remote.readTask).mockResolvedValue(fresh);
  const advance = vi.fn(async (value: WebTask) => value);
  const cleanup = vi.fn(async (value: WebTask) => ({ task: value, complete: true }));
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore,
    verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup } });
  try {
    await coordinator.tick();
    await eventually(() => expect(f.remote.readTask).toHaveBeenCalled());
    if (state === "paused") {
      await eventually(() => expect(webStore.getTask(owner)?.cleanup).toBeNull());
      expect(cleanup).toHaveBeenCalledOnce();
      expect(webStore.getTask(owner)?.webExecution?.restartAfterShutdown).toBe(true);
    } else {
      if (state === "changed_claim") {
        await eventually(() => expect(f.remote.readTask).toHaveBeenCalledTimes(2));
        expect(f.remote.update).not.toHaveBeenCalled();
      } else await eventually(() => expect(readWorkerClaim(f.grants.get(owner.claimId)!.properties)?.phase).toBe("waiting"));
      expect(cleanup).not.toHaveBeenCalled();
      expect(webStore.getTask(owner)?.cleanup?.kind).toBe("shutdown");
    }
    expect(advance).not.toHaveBeenCalled();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it.each(["eligible", "paused", "revoked"] as const)("rechecks a frozen Web retry without selecting its project (%s)", async state => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
  const config = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
  const owner = { projectId: f.project.projectId, taskId: remote.id, claimId: uuid(810), worktreeId: uuid(811) };
  f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
  record = webStore.initializeWebExecution(record, 2);
  webStore.beginCleanup(record, { kind: "shutdown", deadline: 1000 }, 3);
  const fresh = state === "paused" ? { ...remote, properties: { ...remote.properties, blocked: true } } : state === "revoked" ? { ...remote, allowAgents: false } : remote;
  vi.mocked(f.remote.readTask).mockResolvedValueOnce(remote).mockResolvedValue(fresh);
  const advance = vi.fn(async (value: WebTask) => value);
  const advanceResult = vi.fn<import("../../../src/commands/worker/backends/web.js").WebExecutionBackend["advanceResult"]>(async (value, signal, _admit, authority) => {
    expect(await authority!(value, {} as never, signal)).toBeNull();
    return { kind: "observed" as const, task: value };
  });
  const cleanup = vi.fn(async (value: WebTask) => ({ task: value, complete: true }));
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [], globalConfiguration: null, webStore,
    verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, advanceResult, cleanup } });
  try {
    const result = await coordinator.advanceRetry(owner);
    if (state === "eligible") {
      expect(result).toBeUndefined();
      expect(advanceResult).toHaveBeenCalledOnce();
      expect(webStore.getTask(owner)?.recovery.retryAuthorized).toBe(true);
    } else {
      expect(result).toEqual({ kind: "waiting_input", reason: state === "paused" ? "task_paused" : "claim_invalid" });
      expect(advanceResult).not.toHaveBeenCalled();
      expect(webStore.getTask(owner)?.recovery.retryAuthorized).toBe(false);
    }
    expect(cleanup).toHaveBeenCalledTimes(state === "revoked" ? 0 : 1);
    expect(webStore.getTask(owner)?.claimId).toBe(owner.claimId);
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("refuses an explicit Web retry without original execution evidence instead of starting an assignment", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
  const row = f.store.registerPending({ projectId: remote.projectId, taskId: remote.id, claimId: uuid(810), agent: "codex", agentControlMode: "web" });
  f.store.activateTask(row);
  const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => input);
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [], globalConfiguration: configuration, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
  try {
    await expect(coordinator.advanceRetry(row)).rejects.toThrow("original Web execution evidence");
    expect(advance).not.toHaveBeenCalled();
    expect(webStore.getTask(row)).toBeNull();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("observes completed Web resources when shutdown follows an interrupted schedule removal", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const f = await fixture(); const webStore = openWebExecutionStore(createMemoryDatabase());
  const owner = { projectId: f.project.projectId, taskId: uuid(810), claimId: uuid(811), worktreeId: uuid(812) };
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 0 };
  f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
  record = webStore.beginCleanup(record, { kind: "terminal", deadline: 100 }, 2);

  webStore.completeTask(record, 6); f.store.completeTask(owner);
  f.store.saveCleanupSchedule(owner, { deadline: 100, failures: 0, nextAttemptAt: 1, stage: "observation", lastError: null });
  const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 1000 });
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [], globalConfiguration: configuration, webStore, webBackend: backend });
  try {
    await expect(coordinator.shutdown()).resolves.toBe(true);
    expect(f.events.some(e => e.kind === "shutdown-error")).toBe(false);
    expect(f.store.getCleanupSchedule(owner)).not.toBeNull();
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

describe("cloud project removal", () => {

  it("joins proven Web stops and fences retries while stopping", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const candidate = task(f.project.projectId, uuid(920));
    const owner = { projectId: f.project.projectId, taskId: candidate.id, claimId: uuid(921), worktreeId: uuid(922) };
    f.grant(candidate, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", agentControlMode: "web" });
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    const record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: { ...configuration, args: [], agentControlMode: "web" } }, 1);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const cleanup = vi.fn(async (value: WebTask) => { await held; return { task: value, complete: true }; });
    const advance = vi.fn(async (value: WebTask) => value);
    const runner = createWorkerCoordinator({ ...f.options, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup } });
    const stopping = runner.stopProject(f.project.projectId);
    try {
      await eventually(() => expect(cleanup).toHaveBeenCalledOnce());
      const retry = runner.advanceRetry(owner);
      void retry.catch(() => {});
      await eventually(() => expect(f.remote.readTask).toHaveBeenCalled());
      expect(advance).not.toHaveBeenCalled();
      expect(cleanup.mock.calls[0]![0]).toEqual(record);
      release(); await stopping;
      await Promise.allSettled([retry]);
      expect(f.store.getTask(owner)?.status).toBe("active");
    } finally { release(); await stopping; await runner.shutdown(); webStore.close(); }
  });

  it("stops the matching original Web execution after its claim has completed", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const candidate = task(f.project.projectId, uuid(950));
    const owner = { projectId: f.project.projectId, taskId: candidate.id, claimId: uuid(951), worktreeId: uuid(952) };
    const granted = f.grant(candidate, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", agentControlMode: "web" });
    const claim = readWorkerClaim(granted.properties)!;
    f.grants.set(owner.claimId, { ...granted, status: "done", properties: { ...granted.properties, worker: { ...claim, state: "completed" } } });
    const row = f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    const record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: { ...configuration, args: [], agentControlMode: "web" } }, 1);
    const cleanup = vi.fn(async (value: WebTask) => ({ task: value, complete: true }));
    const runner = createWorkerCoordinator({ ...f.options, webStore, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async value => value), cleanup } });
    try {
      await runner.stopProject(f.project.projectId);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(cleanup.mock.calls[0]![0]).toEqual(record);
      expect(f.store.getTask(row)).toEqual(row);
    } finally { await runner.shutdown(); webStore.close(); }
  });

  it("interrupts and stops the frozen Web execution while the authority read is stalled", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const candidate = f.candidates[0]!;
    const owner = { projectId: f.project.projectId, taskId: candidate.id, claimId: uuid(970), worktreeId: uuid(971) };
    f.grant(candidate, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", agentControlMode: "web" });
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    const config = { ...configuration, args: [], agentControlMode: "web" as const };
    const record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
    webStore.bindWorktree(record, f.bind(owner), 2);
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    let entered!: () => void, interrupted!: () => void;
    const jobEntered = new Promise<void>(resolve => { entered = resolve; }), jobInterrupted = new Promise<void>(resolve => { interrupted = resolve; });
    const advanceResult = vi.fn<import("../../../src/commands/worker/backends/web.js").WebExecutionBackend["advanceResult"]>(async (_value, signal) => {
      entered(); await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }));
      interrupted(); throw signal.reason;
    });
    const cleanup = vi.fn(async (value: WebTask) => ({ task: value, complete: true }));
    const runner = createWorkerCoordinator({ ...f.options, userId: uuid(2), repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore,
      verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async value => value), advanceResult, cleanup } });
    try {
      await runner.tick(); await jobEntered;
      vi.mocked(f.remote.readTask).mockReset().mockImplementation(async () => new Promise<Task>(() => {}));
      const stopping = runner.stopProject(f.project.projectId);
      await jobInterrupted;
      await stopping;
      expect(f.remote.readTask).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce(); expect(cleanup.mock.calls[0]![0]).toMatchObject(owner);
    } finally { vi.mocked(f.remote.readTask).mockResolvedValue(f.grants.get(owner.claimId)!); await runner.shutdown(); webStore.close(); }
  });

  it("fences an unregistered Web job while server verification is in flight", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const candidate = f.candidates[0]!;
    const owner = { projectId: f.project.projectId, taskId: candidate.id, claimId: uuid(980), worktreeId: uuid(981) };
    f.grant(candidate, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", agentControlMode: "web" });
    f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
    const config = { ...configuration, args: [], agentControlMode: "web" as const };
    let entered!: () => void, release!: () => void, currentSignal: AbortSignal | undefined;
    const barrierEntered = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const verifyWebServer = vi.fn(async (_agent: unknown, signal: AbortSignal) => { currentSignal = signal; entered(); await barrier; });
    const verifyWebUnregistered = vi.fn(async () => {}), advance = vi.fn(async (value: WebTask) => value), cleanup = vi.fn(async (value: WebTask) => ({ task: value, complete: true }));
    const runner = createWorkerCoordinator({ ...f.options, userId: uuid(2), repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore,
      verifyWebServer, verifyWebUnregistered, webBackend: { observeExecutionStop: unknownStop, advance, cleanup } });
    try {
      await runner.tick(); await barrierEntered;
      runner.updateConfiguration({ repositories: [], targetProjectIds: [], readyProjectIds: [], globalConfiguration: null, maxConcurrent: 1, preferPlatformSpecificTasks: false });
      const stopping = runner.stopProject(f.project.projectId);
      void stopping.catch(() => {});
      expect(currentSignal?.aborted).toBe(true);
      release(); await stopping;
      expect(webStore.getTask(owner)).toBeNull();
      expect(verifyWebUnregistered).toHaveBeenCalledOnce();
      expect(advance).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
    } finally { release(); await runner.shutdown(); webStore.close(); }
  });

  it("keeps Daynight Session and native Session identities distinct when stopping Web", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const candidate = task(f.project.projectId, uuid(975));
    const owner = { projectId: f.project.projectId, taskId: candidate.id, claimId: uuid(976), worktreeId: uuid(977) };
    f.grant(candidate, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", agentControlMode: "web" });
    const row = f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web", sessionId: uuid(978) }));
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: { ...configuration, args: [], agentControlMode: "web" } }, 1);
    record = webStore.initializeWebExecution(record, 2);
    record = webStore.updateWebExecution(record, { sessionId: uuid(979), launchSubmission: "acknowledged", initialInputState: "confirmed" }, 3);
    record = webStore.bindNativeSession(record, { source: "controller", sessionId: uuid(978) }, 4);
    const cleanup = vi.fn(async (value: WebTask) => ({ task: value, complete: true }));
    const runner = createWorkerCoordinator({ ...f.options, userId: uuid(2), webStore, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async value => value), cleanup } });
    try {
      await runner.stopProject(f.project.projectId);
      expect(cleanup).toHaveBeenCalledOnce(); expect(cleanup.mock.calls[0]![0]).toEqual(record);
      expect(f.store.getTask(row)).toEqual(row);
    } finally { await runner.shutdown(); webStore.close(); }
  });

  it.each(["released", "successor", "unavailable"] as const)("stops only locally proven Web execution when authority is %s", async state => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const candidate = task(f.project.projectId, uuid(960));
    const owner = { projectId: f.project.projectId, taskId: candidate.id, claimId: uuid(961), worktreeId: uuid(962) };
    const granted = f.grant(candidate, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", agentControlMode: "web" });
    const row = f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    const record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: { ...configuration, args: [], agentControlMode: "web" } }, 1);
    if (state === "released") vi.mocked(f.remote.readTask).mockResolvedValue({ ...granted, status: "todo", properties: {} });
    if (state === "successor") vi.mocked(f.remote.readTask).mockResolvedValue({ ...granted, properties: { ...granted.properties, worker: { ...readWorkerClaim(granted.properties)!, claimId: uuid(963), worktreeId: uuid(964) } } });
    if (state === "unavailable") vi.mocked(f.remote.readTask).mockRejectedValue(new Error("network unavailable"));
    const cleanup = vi.fn(async (value: WebTask) => ({ task: value, complete: true }));
    const runner = createWorkerCoordinator({ ...f.options, userId: uuid(2), webStore, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async value => value), cleanup } });
    try {
      await runner.stopProject(f.project.projectId);
      expect(cleanup).toHaveBeenCalledOnce(); expect(cleanup.mock.calls[0]![0]).toEqual(record);
      expect(f.store.getTask(row)).toEqual(row); expect(f.remote.readTask).not.toHaveBeenCalled(); expect(f.remote.update).not.toHaveBeenCalled();
    } finally { await runner.shutdown(); webStore.close(); }
  });

  it.each(["worker", "user", "service", "worktree", "session"] as const)("retains a conflicting original identity (%s)", async conflict => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const candidate = task(f.project.projectId, uuid(940));
    const owner = { projectId: f.project.projectId, taskId: candidate.id, claimId: uuid(941), worktreeId: uuid(942) };
    f.grant(candidate, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", agentControlMode: "web" });
    const row = f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" as const }));
    const record = webStore.register({ ...owner, worktreeId: conflict === "worktree" ? uuid(943) : owner.worktreeId, project: f.project,
      serverOrigin: conflict === "service" ? "https://other.example" : origin, workerId: conflict === "worker" ? uuid(944) : workerId,
      userId: conflict === "user" ? uuid(945) : uuid(2), configuration: { ...configuration, args: [], agentControlMode: "web" } }, 1);
    if (conflict === "worktree") ensureCleanupSchedule(f.store, owner, 1);
    if (conflict === "session") {
      webStore.bindNativeSession(record, { source: "controller", sessionId: uuid(946) }, 2);
      f.store.setSessionId(row, uuid(947));
    }
    const expectedLocal = f.store.getTask(row);
    const cleanup = vi.fn(async (value: WebTask) => ({ task: value, complete: true }));
    const runner = createWorkerCoordinator({ ...f.options, webStore, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async value => value), cleanup } });
    try {
      runner.updateConfiguration({ repositories: [], targetProjectIds: [], readyProjectIds: [], globalConfiguration: null, maxConcurrent: 1, preferPlatformSpecificTasks: false });
      await expect(runner.stopProject(f.project.projectId)).rejects.toThrow("Project execution stop was not confirmed");
      expect(cleanup).not.toHaveBeenCalled();
      expect(f.store.getTask(row)).toEqual(expectedLocal);
    } finally { await runner.shutdown(); webStore.close(); }
  });

  it("refuses project removal when active Web ownership evidence is missing", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const row = f.store.activateTask(f.store.registerPending({ projectId: f.project.projectId, taskId: uuid(930), claimId: uuid(931), agent: "codex", agentControlMode: "web", sessionId: uuid(932) }));
    const verify = vi.fn(async () => {});
    const runner = createWorkerCoordinator({ ...f.options, webStore, verifyWebUnregistered: verify });
    try {
      await expect(runner.stopProject(f.project.projectId)).rejects.toThrow("Project execution stop was not confirmed");
      expect(verify).not.toHaveBeenCalled();
      expect(f.store.getTask(row)).toEqual(row);
    } finally { await runner.shutdown(); webStore.close(); }
  });

});

describe("Web acquisition configuration changes", () => {
  it("does not reinterpret an unfrozen Web claim with current Herdr parameters", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const granted = f.grant(f.candidates[0]!, { claimId: uuid(991), worktreeId: uuid(992), workerId, machine: f.options.machine, platform: "linux", agent: "codex", agentControlMode: "web" });
    f.candidates.splice(0);
    const row = f.store.activateTask(f.store.registerPending({ projectId: granted.projectId, taskId: granted.id, claimId: uuid(991), agent: "codex", agentControlMode: "web" }));
    const current: ExecutionConfiguration = { ...configuration, agentControlMode: "herdr", args: [] };
    const advance = vi.fn(async (record: WebTask) => record);
    const runner = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: current }], globalConfiguration: current, webStore,
      verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: async record => ({ task: record, complete: true }) } });
    try {
      await runner.tick();
      expect(f.store.getNativeConfiguration(row)).toBeNull(); expect(webStore.getTask(row)).toBeNull();
      expect(f.store.getTask(row)).toEqual(row); expect(advance).not.toHaveBeenCalled();
    } finally { await runner.shutdown(); webStore.close(); }
  });

  it.each(["mode", "native", "project removed", "project unavailable"] as const)("preserves a granted Web claim's frozen settings after an in-flight %s change", async change => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(); f.candidates.splice(1);
    const webStore = openWebExecutionStore(createMemoryDatabase());
    const native: ExecutionConfiguration = { agent: "codex", agentControlMode: "web", model: "claim-model", args: ["--effort", "low"], recoveryLimit: 2 };
    const current = { repositories: [{ project: f.project, configuration: native }], readyProjectIds: [f.project.projectId], targetProjectIds: [f.project.projectId], globalConfiguration: native, maxConcurrent: 1, preferPlatformSpecificTasks: false };
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.remote.claim).mockImplementationOnce(async (candidate, descriptor) => { await waiting; return f.grant(candidate, descriptor); });
    const advance = vi.fn(async (record: WebTask) => record);
    const runner = createWorkerCoordinator({ ...f.options, ...current, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {},
      webBackend: { observeExecutionStop: unknownStop, advance, cleanup: async record => ({ task: record, complete: true }) } });
    const ticking = runner.tick(); void ticking.catch(() => {});
    try {
      await eventually(() => expect(f.remote.claim).toHaveBeenCalledOnce());
      expect(f.store.listTasks()).toEqual([]); expect(webStore.listUnfinishedTasks()).toEqual([]);
      const changed: ExecutionConfiguration = { ...native, agentControlMode: change === "mode" ? "herdr" : "web", model: "later-model", args: ["--effort", "high"], recoveryLimit: 7 };
      const next = { ...current, repositories: [{ project: f.project, configuration: changed }], globalConfiguration: changed };
      const gated = change === "project removed" || change === "project unavailable";
      runner.updateConfiguration({ ...next, ...(change === "project removed" ? { repositories: [], targetProjectIds: [] } : change === "project unavailable" ? { repositories: [], readyProjectIds: [] } : {}) });
      release(); await ticking;
      const row = f.store.listTasks()[0]!;
      expect(row).toMatchObject({ agent: "codex", agentControlMode: "web", sessionId: null, status: "pending" });
      expect(webStore.getTask(row)).toBeNull();
      expect(f.store.getNativeConfiguration(row)).toEqual({ agent: "codex", model: "claim-model", args: ["--effort", "low"] });
      if (gated) {
        expect(row.status).toBe("pending"); expect(webStore.getTask(row)).toBeNull(); expect(advance).not.toHaveBeenCalled();
        await runner.tick();
        expect(webStore.getTask(row)).toBeNull(); expect(advance).not.toHaveBeenCalled();
        runner.updateConfiguration(next); await runner.tick();
      } else await runner.tick();
      await eventually(() => expect(advance).toHaveBeenCalledOnce());
      expect(webStore.getTask(row)?.configuration).toEqual({ agent: "codex", agentControlMode: "web", model: "claim-model", args: ["--effort", "low"], recoveryLimit: 7 });
      expect(f.store.getTask(row)).toMatchObject({ claimId: row.claimId, agentControlMode: "web", status: "active" });
      expect(f.remote.claim).toHaveBeenCalledOnce();
    } finally { release(); await ticking; await runner.shutdown(); webStore.close(); }
  });

  it.each(["equivalent", "changed", "changed and restored"] as const)("handles %s updates during capability validation", async mode => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(); f.candidates.splice(1);
    const webStore = openWebExecutionStore(createMemoryDatabase());
    const native: ExecutionConfiguration = { ...configuration, agentControlMode: "web", args: [] };
    const current = { repositories: [{ project: f.project, configuration: native }], readyProjectIds: [f.project.projectId], targetProjectIds: [f.project.projectId], globalConfiguration: native, maxConcurrent: 1, preferPlatformSpecificTasks: false };
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const verify = vi.fn(async () => { if (verify.mock.calls.length === 1) await waiting; });
    const runner = createWorkerCoordinator({ ...f.options, ...current, webStore, verifyWebServer: verify, verifyWebUnregistered: async () => {},
      webBackend: { observeExecutionStop: unknownStop, advance: async record => record, cleanup: async record => ({ task: record, complete: true }) } });
    const ticking = runner.tick(); void ticking.catch(() => {});
    try {
      await eventually(() => expect(verify).toHaveBeenCalledOnce());
      const changed = { ...native, agent: "copilot" as const, model: null, args: [] };
      if (mode === "equivalent") runner.updateConfiguration({ ...current, repositories: [{ project: { ...f.project }, configuration: { ...native, args: [...native.args] } }], globalConfiguration: { ...native, args: [...native.args] }, readyProjectIds: [...current.readyProjectIds], targetProjectIds: [...current.targetProjectIds] });
      else {
        runner.updateConfiguration({ ...current, repositories: [{ project: f.project, configuration: changed }], globalConfiguration: changed });
        if (mode === "changed and restored") runner.updateConfiguration(current);
      }
      expect(f.remote.claim).not.toHaveBeenCalled();
      release(); await ticking;
      if (mode === "equivalent") expect(f.remote.claim).toHaveBeenCalledOnce();
      else {
        expect(f.remote.claim).not.toHaveBeenCalled();
        await runner.tick(); expect(f.remote.claim).toHaveBeenCalledOnce();
      }
      expect(vi.mocked(f.remote.claim).mock.calls[0]![0].id).toBe(f.candidates[0]!.id);
      expect(vi.mocked(f.remote.claim).mock.calls[0]![1].agent).toBe(mode === "changed" ? "copilot" : "codex");
    } finally { release(); await ticking; await runner.shutdown(); webStore.close(); }
  });
});

describe("worker monitoring of coordinator jobs", () => {

  it("retains separate unattributed Web renewal failures until the original claim is verified", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver({ now: () => 1000 });
    const web = { agent: "codex" as const, agentControlMode: "web" as const, model: "model", args: [], recoveryLimit: 2 };
    const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
    const owner = { projectId: remote.projectId, taskId: remote.id, claimId: uuid(810), worktreeId: uuid(811) };
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    const record = webStore.initializeWebExecution(webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: web }, 1), 2);
    type GrantObserver = NonNullable<Parameters<ReturnType<typeof import("../../../src/commands/worker/backends/web-process.js").createWebControllerLauncher>["setGrantObserver"]>[0]>;
    let grantObserver: GrantObserver | undefined;
    const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn(), setGrantObserver: (value: GrantObserver | undefined) => { grantObserver = value; } };
    const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 1000, onUnattributed: (identity, operation, value) => monitor.setUnattributed(`web-renewal/${identity.projectId}/${identity.taskId}/${identity.claimId}/${operation}`, value) });
    const failure = new Error("private ticket path");
    grantObserver!.ticketFailed(record, failure);
    expect(monitor.capture()).toMatchObject({ detailCoverage: "partial", currentFailures: [], lastRecovery: null });
    grantObserver!.ticketVerified(record);
    expect(monitor.capture()).toMatchObject({ detailCoverage: "complete", currentFailures: [], lastRecovery: null });
    grantObserver!.ticketFailed(record, failure); grantObserver!.failed(record, failure, true);
    grantObserver!.ticketVerified(record);
    expect(monitor.capture().detailCoverage).toBe("partial");
    grantObserver!.ticketFailed(record, failure); grantObserver!.ticketFailed(record, failure);
    grantObserver!.started(record);
    let coordinatorHooks: Parameters<typeof backend.setMonitoringObserver>[0] | undefined;
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: web }], globalConfiguration: web, webStore, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async task => task), cleanup: vi.fn(), setMonitoringObserver: value => { coordinatorHooks = value; backend.setMonitoringObserver(value); } } });
    try {
      expect(monitor.capture()).toMatchObject({ detailCoverage: "partial", currentFailures: [] });
      await coordinator.tick();
      const verified = monitor.capture();
      expect(verified.detailCoverage).toBe("complete"); expect(verified.currentFailures).toHaveLength(2);
      expect(verified.currentFailures.map(value => value.occurrencesInRun).sort()).toEqual([1, 2]);
      const retrying = verified.currentFailures.find(value => value.occurrencesInRun === 1)!;
      expect(retrying.retryState).toBe("running");
      grantObserver!.settled(record);
      expect(monitor.capture().currentFailures.find(value => value.operationId === retrying.operationId)?.retryState).toBe("none");
      expect(verified.currentFailures.every(value => value.scope.kind === "claim" && value.scope.claimId === owner.claimId)).toBe(true);
      const ticket = verified.currentFailures.find(value => value.occurrencesInRun === 2)!;
      grantObserver!.ticketVerified(record);
      expect(monitor.capture().lastRecovery).toMatchObject({ operationId: ticket.operationId });
      expect(monitor.capture().currentFailures).toHaveLength(1);
      expect(JSON.stringify(monitor.capture())).not.toContain("private ticket path");
      backend.setMonitoringObserver({});
      grantObserver!.ticketFailed(record, failure);
      expect(monitor.capture().detailCoverage).toBe("partial");
      backend.setMonitoringObserver(coordinatorHooks!);
      expect(monitor.capture().detailCoverage).toBe("complete");
      expect(monitor.capture().currentFailures).toHaveLength(2);
      const lastRecovery = monitor.capture().lastRecovery;
      const successor = { ...record, webExecution: { ...record.webExecution!, executionGeneration: "2", launchId: uuid(999) } };
      grantObserver!.ticketVerified(successor);
      expect(monitor.capture().currentFailures).toEqual([]);
      expect(monitor.capture().lastRecovery).toEqual(lastRecovery);
      grantObserver!.failed(record, failure, true);
      expect(monitor.capture().currentFailures).toEqual([]);
      grantObserver!.failed(successor, failure, true);
      const newFailure = monitor.capture().currentFailures[0]!;
      grantObserver!.refreshed(record);
      expect(monitor.capture().currentFailures).toContainEqual(expect.objectContaining({ operationId: newFailure.operationId }));
      grantObserver!.refreshed(successor);
      expect(monitor.capture().lastRecovery).toMatchObject({ operationId: newFailure.operationId });
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("preserves a real in-flight renewal across claim confirmation and cancellation", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
    const { createWebControllerLauncher } = await import("../../../src/commands/worker/backends/web-process.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver({ now: () => 1000 });
    const web = { agent: "codex" as const, agentControlMode: "web" as const, model: "model", args: [], recoveryLimit: 2, toolLaunch: frozenToolLaunch() };
    const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
    const owner = { projectId: remote.projectId, taskId: remote.id, claimId: uuid(810), worktreeId: uuid(811) };
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: web }, 1);
    record = webStore.bindWorktree(record, await f.git.prepareWorktree(f.project, owner, {} as Operation), 2);
    record = webStore.initializeWebExecution(record, 3);
    const grant = vi.fn().mockResolvedValueOnce({ token: "initial", expiresAt: new Date(91_000).toISOString() });
    const sessionApi = { register: vi.fn(async () => ({ sessionId: uuid(812) })), grant, verifySupport: vi.fn(), verifyUnregistered: vi.fn() } as unknown as import("../../../src/commands/worker/backends/session-api.js").WorkerSessionApi;
    const launcher = createWebControllerLauncher({ homeDirectory: f.root, packageDirectory: f.root, store: webStore, sessionApi, now: () => 1000 });
    const ticket = await launcher.prepare(record, "managed", new AbortController().signal);
    record = webStore.updateWebExecution(record, { launchSubmission: "acknowledged" }, 4);
    const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 1000, onUnattributed: (identity, operation, value) => monitor.setUnattributed(`web-renewal/${identity.projectId}/${identity.taskId}/${identity.claimId}/${operation}`, value) });
    const failure = new Error("grant unavailable"); grant.mockRejectedValueOnce(failure);
    await expect(launcher.refreshGrant(record, ticket, new AbortController().signal)).rejects.toBe(failure);
    expect(monitor.capture()).toMatchObject({ detailCoverage: "partial", currentFailures: [] });
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), cancellation = new AbortController();
    grant.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return { token: "late", expiresAt: new Date(901_000).toISOString() }; });
    const retry = launcher.refreshGrant(record, ticket, cancellation.signal); void retry.catch(() => {});
    await entered.promise;
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: web }], globalConfiguration: web, webStore, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async task => task), cleanup: vi.fn(async task => ({ task, complete: true })), setMonitoringObserver: backend.setMonitoringObserver } });
    try {
      await coordinator.tick();
      const observed = monitor.capture().currentFailures[0]!;
      expect(observed).toMatchObject({ phase: "preparing", retryState: "running", occurrencesInRun: 1 });
      cancellation.abort(new Error("cancelled")); gate.resolve(); await expect(retry).rejects.toThrow("cancelled");
      expect(monitor.capture().currentFailures[0]).toMatchObject({ operationId: observed.operationId, retryState: "none" });
      expect(monitor.capture().lastRecovery).toBeNull();
      grant.mockResolvedValueOnce({ token: "renewed", expiresAt: new Date(901_000).toISOString() });
      await launcher.refreshGrant(record, ticket, new AbortController().signal);
      expect(monitor.capture().lastRecovery).toMatchObject({ operationId: observed.operationId });
    } finally { gate.resolve(); cancellation.abort(); await Promise.allSettled([retry]); await coordinator.shutdown(); webStore.close(); }
  });

  it.each(["inventory", "project"] as const)("clears pre-coordinator unknown Web identity on %s loss", async loss => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver(); f.candidates.splice(0);
    const web = { agent: "codex" as const, agentControlMode: "web" as const, model: "model", args: [], recoveryLimit: 2 };
    const owner = { projectId: f.project.projectId, taskId: uuid(30), claimId: uuid(31), worktreeId: uuid(32) };
    const record = webStore.initializeWebExecution(webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: web }, 1), 2);
    type GrantObserver = NonNullable<Parameters<ReturnType<typeof import("../../../src/commands/worker/backends/web-process.js").createWebControllerLauncher>["setGrantObserver"]>[0]>;
    let grantObserver: GrantObserver | undefined;
    const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn(), setGrantObserver: (value: GrantObserver | undefined) => { grantObserver = value; } };
    const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 1000, onUnattributed: (identity, operation, value) => monitor.setUnattributed(`web-renewal/${identity.projectId}/${identity.taskId}/${identity.claimId}/${operation}`, value) });
    grantObserver!.identityUnknown(record);
    expect(monitor.capture()).toMatchObject({ detailCoverage: "partial", currentFailures: [], lastRecovery: null });
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async task => task), cleanup: vi.fn(), setMonitoringObserver: backend.setMonitoringObserver } });
    try {
      expect(monitor.capture().detailCoverage).toBe("partial");
      if (loss === "inventory") await coordinator.tick(); else coordinator.invalidateProject(f.project.projectId);
      expect(monitor.capture()).toMatchObject({ detailCoverage: "complete", currentFailures: [], lastRecovery: null });
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("clears unattributed renewal state when a complete inventory excludes its claim", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver(); f.candidates.splice(0);
    const web = { agent: "codex" as const, agentControlMode: "web" as const, model: "model", args: [], recoveryLimit: 2 };
    type Monitoring = Parameters<import("../../../src/commands/worker/backends/web.js").WebExecutionBackend["setMonitoringObserver"]>[0];
    let hooks: Monitoring | undefined;
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: web }], globalConfiguration: web, webStore, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async task => task), cleanup: vi.fn(), setMonitoringObserver: value => { hooks = value; } } });
    try {
      hooks!.observeFailure?.({ projectId: f.project.projectId, taskId: uuid(30), claimId: uuid(31) }, { kind: "execution", phase: "preparing" }, new Error("private"), "grant-ticket");
      expect(monitor.capture()).toMatchObject({ detailCoverage: "partial", currentFailures: [], lastRecovery: null });
      await coordinator.tick();
      expect(monitor.capture()).toMatchObject({ detailCoverage: "complete", currentFailures: [], lastRecovery: null });
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("keeps Web grant failures through healthy IPC and no-op checks until actual renewal", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver();
    const web = { agent: "codex" as const, agentControlMode: "web" as const, model: "model", args: [], recoveryLimit: 2 };
    type Monitoring = Parameters<import("../../../src/commands/worker/backends/web.js").WebExecutionBackend["setMonitoringObserver"]>[0];
    let hooks: Monitoring | undefined, attempt = 0;
    const failure = new Error("private grant failure"), operationKey = `grant-refresh/1/${uuid(900)}`;
    const advance = vi.fn(async (record: WebTask) => {
      hooks!.observePhase?.(record, { kind: "execution", phase: "agent-observation" }, false);
      hooks!.observeSuccess?.(record, { kind: "execution", phase: "agent-observation" });
      hooks!.observePhase?.(record, { kind: "execution", phase: "preparing" }, false, undefined, operationKey);
      attempt++;
      if (attempt <= 2) throw failure;
      if (attempt === 4) hooks!.observeSuccess?.(record, { kind: "execution", phase: "preparing" }, operationKey);
      return record;
    });
    const webBackend = { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(), setMonitoringObserver: (value: Monitoring) => { hooks = value; } };
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: web }], globalConfiguration: web, webStore, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend });
    try {
      await coordinator.tick(); await eventually(() => expect(monitor.capture().currentFailures).toHaveLength(1));
      const first = monitor.capture().currentFailures[0]!; expect(first).toMatchObject({ component: "execution", phase: "preparing", occurrencesInRun: 1 });
      await coordinator.tick(); await eventually(() => expect(monitor.capture().currentFailures[0]).toMatchObject({ operationId: first.operationId, occurrencesInRun: 2 }));
      await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(3));
      expect(monitor.capture().currentFailures).toContainEqual(expect.objectContaining({ operationId: first.operationId, occurrencesInRun: 2, retryState: "none" }));
      expect(monitor.capture().lastRecovery).toBeNull();
      const identity = f.store.listTasks()[0]!;
      hooks!.observeRetry?.(identity, operationKey, true);
      expect(monitor.capture().currentFailures[0]!.retryState).toBe("running");
      hooks!.observeRetry?.(identity, operationKey, false);
      expect(monitor.capture().currentFailures[0]!.retryState).toBe("none");
      await coordinator.tick(); await eventually(() => expect(monitor.capture().lastRecovery).toMatchObject({ operationId: first.operationId }));
      expect(monitor.capture().currentFailures).toEqual([]);
      const row = f.store.listTasks()[0]!;
      hooks!.observeFailure?.(row, { kind: "execution", phase: "preparing" }, failure, operationKey);
      const background = monitor.capture().currentFailures[0]!; expect(background.phase).toBe("preparing");
      hooks!.observeSuccess?.(row, { kind: "execution", phase: "agent-observation" });
      expect(monitor.capture().currentFailures).toContainEqual(expect.objectContaining({ operationId: background.operationId }));
      hooks!.observeSuccess?.(row, { kind: "execution", phase: "preparing" }, operationKey);
      expect(monitor.capture().lastRecovery).toMatchObject({ operationId: background.operationId });
      expect(JSON.stringify(monitor.capture())).not.toContain("private grant failure");
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("reports a paused Web recovery without retrying its native execution", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver();
    const web = { agent: "codex" as const, agentControlMode: "web" as const, model: "model", args: [], recoveryLimit: 2 };
    const advance = vi.fn(async (record: WebTask) => webStore.pauseRecovery(record, "Original identity missing", 2, "native_identity_missing"));
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: web }], globalConfiguration: web, webStore, monitoring: monitor, verifyWebServer: vi.fn(async () => {}), verifyWebUnregistered: vi.fn(async () => {}), webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
    try {
      await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledOnce());
      await eventually(() => expect(monitor.capture().activities).toContainEqual(expect.objectContaining({ kind: "execution", phase: "paused", status: "paused", waitReason: "recovery-blocked" })));
      await coordinator.tick();
      expect(advance).toHaveBeenCalledOnce();
      expect(monitor.capture().activities).toContainEqual(expect.objectContaining({ kind: "execution", phase: "paused", status: "paused", waitReason: "recovery-blocked" }));
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

});

it.each(["archive_incomplete", "projection_gap", "markdown_projection_failed", null] as const)("cleans a persisted Web archive retry immediately after restart: %s", async code => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const f = await fixture(1), webStore = openWebExecutionStore(createMemoryDatabase());
  const config = { ...configuration, args: [], agentControlMode: "web" as const };
  const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(910), worktreeId: uuid(911) };
  f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }); f.store.activateTask(owner);
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
  record = webStore.bindWorktree(record, await f.git.prepareWorktree(f.project, owner, {} as Operation), 2);
  record = webStore.initializeWebExecution(record, 3);
  record = webStore.updateWebExecution(record, { sessionId: uuid(912), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
  const stopped = await stoppedWebExecution(f, webStore, record);
  webStore.beginCleanup(stopped.task, { kind: "terminal", deadline: 100 }, 7);
  f.candidates.splice(0);
  f.store.saveCleanupSchedule(owner, { deadline: 100, failures: 4, nextAttemptAt: 901000, stage: "archive", lastError: "retained", archiveRepairCode: code });
  const archive = vi.fn(async () => { throw code === null ? new Error("Archive unavailable") : new ArchiveRepairRequiredError(code); });
  const probeArchive = vi.fn(async () => ({ kind: "blocked" as const, code: "archive_incomplete" as const }));
  const recordLegacyFailure = vi.fn(() => { throw new Error("Maintenance unavailable"); });
  const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: f.options.now, archive, probeArchive, jobLeases: stopped.jobLeases, request: stopped.request });
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore, webBackend: backend, archiveMaintenance: { recordLegacyFailure }, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
  try {
    await coordinator.tick();
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
    expect(archive).toHaveBeenCalledOnce(); expect(probeArchive).not.toHaveBeenCalled();
    expect(recordLegacyFailure).toHaveBeenCalledOnce();
    const registration = f.events.find(event => event.kind === "session-archive-retry");
    expect(registration?.error).toBeInstanceOf(AggregateError);
    expect((registration?.error as AggregateError).errors[0]).toMatchObject({ message: "retained" });
    expect(f.store.getTask(owner)?.status).toBe("done");
    expect(webStore.getTask(owner)?.status).toBe("done");
    expect(f.worktrees.has(owner.claimId)).toBe(false);
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it.each([
  { failure: "denied", persistenceFails: false },
  { failure: "busy", persistenceFails: false },
  { failure: "denied", persistenceFails: true },
] as const)("retains worktree-removal retry backoff after an old Web archive schedule: $failure, persistence failure $persistenceFails", async ({ failure, persistenceFails }) => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const f = await fixture(1), webStore = openWebExecutionStore(createMemoryDatabase());
  const config = { ...configuration, args: [], agentControlMode: "web" as const };
  const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(910), worktreeId: uuid(911) };
  f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }); f.store.activateTask(owner);
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
  record = webStore.bindWorktree(record, await f.git.prepareWorktree(f.project, owner, {} as Operation), 2);
  record = webStore.initializeWebExecution(record, 3);
  record = webStore.updateWebExecution(record, { sessionId: uuid(912), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
  const stopped = await stoppedWebExecution(f, webStore, record);
  webStore.beginCleanup(stopped.task, { kind: "terminal", deadline: 100 }, 7);
  f.candidates.splice(0);
  f.store.saveCleanupSchedule(owner, { deadline: 100, failures: 1, nextAttemptAt: 901000, stage: "archive", lastError: "retained", archiveRepairCode: "archive_incomplete" });
  if (persistenceFails) vi.spyOn(f.store, "saveCleanupSchedule").mockImplementationOnce(() => { throw new Error("Schedule unavailable"); });
  const archive = vi.fn(async () => { throw new ArchiveRepairRequiredError("archive_incomplete"); });
  const removalError = failure === "busy" ? Object.assign(new Error("Removal busy"), { status: 429, code: "resource_busy" }) : new Error("Removal denied");
  vi.mocked(f.git.removeWorktree).mockRejectedValue(removalError);
  const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: f.options.now, archive, jobLeases: stopped.jobLeases, request: stopped.request });
  const create = () => createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore, webBackend: backend, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
  let coordinator = create();
  try {
    await coordinator.tick();
    await eventually(() => expect(f.events.filter(event => event.kind === "cleanup-error")).toHaveLength(1));
    expect(f.store.getCleanupSchedule(owner)).toMatchObject(persistenceFails ? { stage: "archive", nextAttemptAt: 901000 } : { stage: "worktree-removal", nextAttemptAt: 3000 });
    if (persistenceFails) expect(f.events.find(event => event.kind === "cleanup-error")?.error).toBeInstanceOf(AggregateError);
    expect(f.worktrees.has(owner.claimId)).toBe(true);
    expect(f.store.getTask(owner)?.status).toBe("active");
    if (!persistenceFails) {
      await coordinator.shutdown(); coordinator = create();
      expect(f.store.getCleanupSchedule(owner)).toMatchObject({ stage: "worktree-removal", nextAttemptAt: 5000 });
    }
    const retryAt = persistenceFails ? 3000 : 5000;
    f.clock(retryAt - 1); await coordinator.tick(); expect(f.git.removeWorktree).toHaveBeenCalledTimes(persistenceFails ? 1 : 2);
    vi.mocked(f.git.removeWorktree).mockImplementation(async (_project, actual) => { f.worktrees.delete(actual.claimId); return { kind: "absent", effectErrors: [] }; });
    f.clock(retryAt); await coordinator.tick();
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
    expect(f.store.getTask(owner)?.status).toBe("done"); expect(f.worktrees.has(owner.claimId)).toBe(false);
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it.each(["current", "legacy", "mismatch"] as const)("reconciles an original receipt while a persisted archive blocker remains: %s", async variant => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const { probeStoppedControllerArchive, uploadStoppedControllerArchive } = await import("../../../src/commands/controller/archive-upload.js");
  const { controllerExecutionDirectory } = await import("../../../src/commands/controller/launch-ticket.js");
  const { default: Database } = await import("better-sqlite3");
  const f = await fixture(1), webStore = openWebExecutionStore(createMemoryDatabase());
  const config = { ...configuration, args: [], agentControlMode: "web" as const };
  const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(920), worktreeId: uuid(921) };
  f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }); f.store.activateTask(owner);
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
  record = webStore.bindWorktree(record, await f.git.prepareWorktree(f.project, owner, {} as Operation), 2);
  record = webStore.initializeWebExecution(record, 3);
  record = webStore.updateWebExecution(record, { sessionId: uuid(922), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
  const stopped = await stoppedWebExecution(f, webStore, record);
  webStore.beginCleanup(stopped.task, { kind: "terminal", deadline: 100 }, 7); f.candidates.splice(0);
  const journalPath = path.join(controllerExecutionDirectory(f.root, stopped.ticket.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalPath), { recursive: true });
  const journal = lifecycle.openControllerLifecycleStore(journalPath, stopped.ticket);
  journal.markProjectionGap("Native history could not be preserved."); journal.drainProjectionGap();
  const { executionId: _executionId, claimId: _claimId, sessionId: _sessionId, executionGeneration: _generation, controllerInstanceId: _instance, ...snapshot } = stopped.snapshot;
  journal.patchSnapshot(snapshot); journal.close();
  const receipt = { state: "ready", sha256: "1".repeat(64), byteLength: "72", errorCode: null, ...(variant === "legacy" ? {} : { schemaVersion: 3, completeness: "complete" }) };
  const remote = variant === "legacy" ? { ...receipt, schemaVersion: 3, completeness: "complete", sha256: "2".repeat(64), byteLength: "96", migration: { migrationId: uuid(923), sourceSha256: receipt.sha256, sourceByteLength: receipt.byteLength } } : { ...receipt, sha256: variant === "mismatch" ? "3".repeat(64) : receipt.sha256 };
  await writeFile(`${journalPath}.archive-receipt-1.json`, JSON.stringify(receipt));
  await rm(`${journalPath}.pending-content`, { recursive: true });
  f.store.saveCleanupSchedule(owner, { deadline: 100, failures: 4, nextAttemptAt: 1000, stage: "archive", lastError: "retained", archiveRepairCode: "archive_incomplete" });
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ archive: remote }));
  const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: f.options.now,
    probeArchive: (_task, actual, signal) => probeStoppedControllerArchive({ journalPath: actual, ticket: stopped.ticket, signal }),
    archive: async (_task, actual, signal) => { await uploadStoppedControllerArchive({ journalPath: actual, ticket: stopped.ticket, signal, serverToken: "fixture", request }); }, jobLeases: stopped.jobLeases, request: stopped.request });
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore, webBackend: backend, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
  try {
    await coordinator.tick();
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
    expect(f.worktrees.has(owner.claimId)).toBe(false); expect(f.store.getTask(owner)?.status).toBe("done");
    expect(request.mock.calls.map(([,init]) => init?.method)).toEqual(["GET"]);
    const inspect = new Database(journalPath, { readonly: true });
    try { expect(inspect.prepare("SELECT archive_incomplete FROM execution").get()).toEqual({ archive_incomplete: 1 }); } finally { inspect.close(); }
  } finally { await coordinator.shutdown(); webStore.close(); }
});

describe("Web ownership boundaries", () => {
  it("keeps an unproven worktree outside capacity while admitting a different task", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver();
    const unknown = { projectId: f.project.projectId, taskId: uuid(910), claimId: uuid(911), worktreeId: uuid(912) };
    f.worktrees.set(unknown.claimId, { owner: unknown, binding: f.bind(unknown) });
    const advance = vi.fn(async (value: WebTask) => value);
    const coordinator = createWorkerCoordinator({ ...f.options, webStore, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
    try {
      await coordinator.tick();
      expect(f.remote.claim).toHaveBeenCalledOnce();
      expect(f.worktrees.has(unknown.claimId)).toBe(true);
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("does not advance an active claim when an unproven worktree conflicts with its task", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const candidate = f.candidates[0]!, owner = { projectId: f.project.projectId, taskId: candidate.id, claimId: uuid(920), worktreeId: uuid(921) };
    f.grant(candidate, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, agent: "codex", agentControlMode: "web", machine: f.options.machine, platform: "linux" });
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    const unknown = { ...owner, claimId: uuid(922), worktreeId: uuid(923) };
    f.worktrees.set(unknown.claimId, { owner: unknown, binding: f.bind(unknown) });
    const advance = vi.fn(async (value: WebTask) => value);
    const coordinator = createWorkerCoordinator({ ...f.options, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
    try {
      await coordinator.tick();
      expect(advance).not.toHaveBeenCalled();
      expect(webStore.getTask(owner)).toBeNull();
      expect(f.worktrees.has(unknown.claimId)).toBe(true);
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("finishes an original Web journal after its primary index is lost", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: uuid(930), claimId: uuid(931), worktreeId: uuid(932) };
    const record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
    webStore.initializeWebExecution(record, 2);
    f.candidates.splice(0);
    const cleanup = vi.fn(async (value: WebTask, request: import("../../../src/commands/worker/execution-stop.js").CleanupRequest) => {
      if (request.kind === "terminal") {
        request.scope.onExecutionStopped({ attempt: request.scope.attempt, observation: { kind: "not-started", owner, observedAt: 1000 } });
        if (value.status !== "done") value = webStore.beginCleanup(value, { kind: "terminal", deadline: request.deadline }, 1000);
      }
      return { task: value, complete: true };
    });
    const coordinator = createWorkerCoordinator({ ...f.options, userId: uuid(2), webStore, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async value => value), cleanup } });
    try {
      expect(f.store.getTask(owner)).toBeNull();
      await coordinator.tick();
      await eventually(() => expect(webStore.getTask(owner)?.status, f.events.map(event => `${event.kind}: ${event.message} ${String(event.error)}`).join("\n")).toBe("done"));
      expect(cleanup).toHaveBeenCalled();
      expect(f.store.getTask(owner)).toBeNull();
      await eventually(() => expect(f.store.getCleanupSchedule(owner, record), f.events.map(event => `${event.kind}: ${event.message} ${String(event.error)}`).join("\n")).toBeNull());
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("releases a different owner's original Web execution after administrator authorization", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const { submitWorkerControl } = await import("../../../src/commands/worker/control.js");
    const { createWebArchiveMaintenance } = await import("../../../src/commands/worker/web-archive-backfill.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const candidate = f.candidates[0]!, owner = { projectId: f.project.projectId, taskId: candidate.id, claimId: uuid(980), worktreeId: uuid(981) };
    const granted = f.grant(candidate, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, agent: "codex", agentControlMode: "web", machine: f.options.machine, platform: "linux" });
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    const record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
    webStore.initializeWebExecution(record, 2);
    const removeRecording = vi.fn(async () => {});
    const archiveMaintenance = createWebArchiveMaintenance({ homeDirectory: f.root, serverUrl: origin, workerId, userId: uuid(990), signal: new AbortController().signal,
      store: f.store, webStore, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }), removeRecording, emit: f.options.emit });
    f.remote.currentUserId = vi.fn(async () => uuid(990));
    f.remote.authorizeControl = vi.fn(async () => {});
    f.remote.release = vi.fn(async () => { f.grants.clear(); return { ...granted, status: "todo" as const, properties: { pullRequests: [] } }; });
    const cleanup = vi.fn(async (value: WebTask, request: import("../../../src/commands/worker/execution-stop.js").CleanupRequest) => {
      if (request.kind === "terminal") {
        request.scope.onExecutionStopped({ attempt: request.scope.attempt, observation: { kind: "not-started", owner, observedAt: 1000 } });
        value = webStore.beginCleanup(value, { kind: "terminal", deadline: request.deadline }, 1000);
        value = webStore.discardRecording(value, 1000);
      }
      return { task: value, complete: true };
    });
    const coordinator = createWorkerCoordinator({ ...f.options, userId: uuid(990), webStore, archiveMaintenance, archiveSessions: () => false, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async value => value), cleanup } });
    try {
      const result = await submitWorkerControl({ store: f.store, remote: f.remote, serverOrigin: origin, workerId, signal: new AbortController().signal, coordinator,
        request: { kind: "release", projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId, version: granted.version } });
      expect(f.remote.authorizeControl).toHaveBeenCalledWith(owner.projectId, uuid(2), expect.any(AbortSignal));
      expect(result.task?.status).toBe("done");
      expect(webStore.getTask(owner)?.status).toBe("done");
      expect(removeRecording).toHaveBeenCalledOnce();
    } finally { await coordinator.shutdown(); await archiveMaintenance.close(); webStore.close(); }
  });

  it("retains archive repair for the original owner when an administrator releases the execution", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
    const { createWebArchiveMaintenance } = await import("../../../src/commands/worker/web-archive-backfill.js");
    const { submitWorkerControl } = await import("../../../src/commands/worker/control.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const candidate = f.candidates[0]!, owner = { projectId: f.project.projectId, taskId: candidate.id, claimId: uuid(983), worktreeId: uuid(984) };
    const granted = f.grant(candidate, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, agent: "codex", agentControlMode: "web", machine: f.options.machine, platform: "linux" });
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
    record = webStore.bindWorktree(record, await f.git.prepareWorktree(f.project, owner, {} as Operation), 2);
    record = webStore.initializeWebExecution(record, 3);
    record = webStore.updateWebExecution(record, { sessionId: uuid(985), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
    const stopped = await stoppedWebExecution(f, webStore, record), execution = stopped.task.webExecution!;
    const archive = vi.fn(async () => { throw new ArchiveRepairRequiredError("archive_incomplete"); });
    const maintenance = createWebArchiveMaintenance({ homeDirectory: f.root, serverUrl: origin, workerId, userId: uuid(990), signal: new AbortController().signal,
      store: f.store, webStore, archive, probeArchive: async () => ({ kind: "attempt" }), emit: f.options.emit });
    const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() },
      platform: "linux", buildPrompt: () => "managed", emit: event => { f.events.push({ kind: event.kind, message: event.message, ...(event.error === undefined ? {} : { error: event.error }) }); }, now: f.options.now, archive, onArchiveFailure: maintenance.recordFailure, request: stopped.request, jobLeases: stopped.jobLeases });
    f.remote.currentUserId = vi.fn(async () => uuid(990));
    f.remote.authorizeControl = vi.fn(async () => {});
    f.remote.release = vi.fn(async () => { f.grants.clear(); return { ...granted, status: "todo" as const, properties: { pullRequests: [] } }; });
    const coordinator = createWorkerCoordinator({ ...f.options, userId: uuid(990), webStore, webBackend: backend, archiveMaintenance: maintenance });
    try {
      const result = await submitWorkerControl({ store: f.store, remote: f.remote, serverOrigin: origin, workerId, signal: new AbortController().signal, coordinator,
        request: { kind: "release", projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId, version: granted.version } });
      expect(result.task?.status).toBe("done");
      expect(archive).toHaveBeenCalledOnce();
      const identity = { ...owner, serverOrigin: origin, executionId: execution.executionId, executionGeneration: execution.executionGeneration, launchId: execution.launchId };
      expect(f.store.getArchiveBackfillSchedule(identity)).toMatchObject({ archiveRepairCode: "archive_incomplete" });
      expect(f.events).not.toContainEqual(expect.objectContaining({ message: "Session archive failure registration failed; its source is retained for retry." }));
    } finally { await coordinator.shutdown(); await maintenance.close(); webStore.close(); }
  });

  it.each(["active", "done"] as const)("settles a journal-free Web cleanup schedule after %s index recovery", async status => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: uuid(970), claimId: uuid(971), worktreeId: uuid(972) };
    f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
    if (status === "active") f.store.activateTask(owner); else f.store.completeTask(owner);
    f.store.saveCleanupSchedule(owner, { deadline: 1000, failures: 0, nextAttemptAt: 0, stage: "observation", lastError: null });
    f.bind(owner);
    f.candidates.splice(0);
    const verify = vi.fn(async () => {});
    const coordinator = createWorkerCoordinator({ ...f.options, webStore, verifyWebUnregistered: verify });
    try {
      await coordinator.tick();
      await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
      expect(verify).not.toHaveBeenCalled();
      expect(f.store.getTask(owner)?.status).toBe("done");
      expect(f.git.removeUnpublishedReservation).toHaveBeenCalled();
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("settles a retired journal-free schedule from complete local inventory when Session registration is unavailable", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: uuid(975), claimId: uuid(976), worktreeId: uuid(977) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    f.store.saveCleanupSchedule(owner, { deadline: 1000, failures: 0, nextAttemptAt: 0, stage: "observation", lastError: null });
    f.bind(owner);
    f.candidates.splice(0);
    const coordinator = createWorkerCoordinator({ ...f.options, webStore, verifyWebUnregistered: async () => { throw new Error("Unverified provenance"); } });
    try {
      await coordinator.tick();
      await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
      expect(f.git.removeUnpublishedReservation).toHaveBeenCalled();
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it.each(["missing", "shutdown"] as const)("preserves a completed journal manifest with %s cleanup evidence", async cleanup => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), db = createMemoryDatabase(), webStore = openWebExecutionStore(db);
    const owner = { projectId: f.project.projectId, taskId: uuid(960), claimId: uuid(961), worktreeId: uuid(962) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
    record = webStore.bindWorktree(record, f.bind(owner), 2);
    if (cleanup === "shutdown") record = webStore.beginCleanup(record, { kind: "shutdown", deadline: 100 }, 2);
    db.prepare("UPDATE executions SET data = ?").run(JSON.stringify({ ...record, status: "done" }));
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    f.candidates.splice(0);
    const coordinator = createWorkerCoordinator({ ...f.options, webStore });
    try {
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(true);
      expect(f.git.retireWorktreeManifest).not.toHaveBeenCalled();
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it.each(["user", "worker", "service"] as const)("never cleans a journal owned by another %s", async mismatch => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: uuid(950), claimId: uuid(951), worktreeId: uuid(952) };
    f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
    webStore.register({ ...owner, project: f.project, serverOrigin: mismatch === "service" ? "https://other.example" : origin,
      workerId: mismatch === "worker" ? uuid(953) : workerId, userId: mismatch === "user" ? uuid(954) : uuid(2), configuration }, 1);
    const cleanup = vi.fn();
    const coordinator = createWorkerCoordinator({ ...f.options, webStore, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async value => value), cleanup } });
    try {
      await expect(coordinator.completeSource(owner)).rejects.toThrow("conflicting execution identities");
      expect(cleanup).not.toHaveBeenCalled();
      expect(f.store.getCleanupSchedule(owner)).toBeNull();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("retains a cleanup schedule whose worktree differs from the original journal", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: uuid(940), claimId: uuid(941), worktreeId: uuid(942) };
    f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
    webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
    const wrong = { ...owner, worktreeId: uuid(943) };
    const saved = f.store.saveCleanupSchedule(wrong, { deadline: 1000, failures: 0, nextAttemptAt: 0, stage: "observation", lastError: null });
    const cleanup = vi.fn(); f.candidates.splice(0);
    const coordinator = createWorkerCoordinator({ ...f.options, userId: uuid(2), webStore, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async value => value), cleanup } });
    try {
      await coordinator.tick();
      await eventually(() => expect(f.events.some(event => event.kind === "cleanup-error")).toBe(true));
      expect(cleanup).not.toHaveBeenCalled();
      expect(f.store.getCleanupSchedule(wrong)).toEqual(saved);
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
    } finally { await coordinator.shutdown(); webStore.close(); }
  });
});

it("does not create a Web execution from an active index when Git inventory is incomplete", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
  const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(985), worktreeId: uuid(986) };
  f.grant(f.candidates[0]!, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, agent: "codex", agentControlMode: "web", machine: f.options.machine, platform: "linux" });
  f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
  f.git.scanWorktrees = vi.fn(async () => ({ enumerationComplete: false, validated: [], quarantined: [], unknown: [{ error: new Error("Unrelated Git metadata unreadable.") }] }));
  const verify = vi.fn(async () => f.bind(owner)); f.git.verifyWorktree = verify;
  const unregistered = vi.fn(async () => {}), advance = vi.fn(async (value: WebTask) => value);
  const coordinator = createWorkerCoordinator({ ...f.options, webStore, verifyWebUnregistered: unregistered, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
  try {
    await coordinator.tick();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(webStore.getTask(owner)).toBeNull();
    expect(verify).not.toHaveBeenCalled();
    expect(unregistered).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
    expect(f.remote.claim).not.toHaveBeenCalled();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

describe("worker task tag filter admission", () => {
  const key = "a".repeat(64);
  const apiError = (status: number, code: string, message: string, confirmedRefusal = true) => new ApiError(
    { operation: "test" }, "response", { cause: new Error(message), status, serverError: { code, message, requestId: "request" }, confirmedRefusal, outcomeUnconfirmed: !confirmedRefusal },
  );

  it("keeps inventory active while proof is unavailable and sends proof after application", async () => {
    const f = await fixture();
    const runner = createWorkerCoordinator({ ...f.options, taskTagFilterKey: null });
    await runner.tick();
    expect(f.remote.ownInventory).toHaveBeenCalled();
    expect(f.remote.candidates).not.toHaveBeenCalled();
    expect(f.remote.claim).not.toHaveBeenCalled();
    runner.updateConfiguration({ ...f.options, taskTagFilterKey: key });
    await runner.tick();
    expect(f.remote.candidates).toHaveBeenCalledWith(f.project.projectId, "linux", expect.any(AbortSignal), undefined, workerId);
    expect(f.remote.claim).toHaveBeenCalledWith(f.candidates[0], expect.any(Object), expect.any(AbortSignal), key);
  });

  it.each(["equivalent", "changed", "restored", "unavailable"] as const)("fences unsent claims across %s proof updates", async mode => {
    const f = await fixture(); f.candidates.splice(1);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const verify = vi.fn(async () => { if (verify.mock.calls.length === 1) await waiting; });
    const current = { ...f.options, taskTagFilterKey: key };
    const runner = createWorkerCoordinator({ ...current, verifyWebServer: verify });
    const ticking = runner.tick();
    try {
      await eventually(() => expect(verify).toHaveBeenCalledOnce());
      runner.updateConfiguration({ ...current, taskTagFilterKey: mode === "equivalent" ? key : mode === "unavailable" ? null : "b".repeat(64) });
      if (mode === "restored") runner.updateConfiguration(current);
      release(); await ticking;
      expect(f.remote.claim).toHaveBeenCalledTimes(mode === "equivalent" ? 1 : 0);
      if (mode !== "equivalent" && mode !== "unavailable") {
        await runner.tick();
        expect(f.remote.claim).toHaveBeenCalledWith(f.candidates[0], expect.any(Object), expect.any(AbortSignal), mode === "changed" ? "b".repeat(64) : key);
      }
    } finally { release(); await ticking; }
  });

  it("retains a granted in-flight claim with the captured proof after configuration changes", async () => {
    const f = await fixture(); f.candidates.splice(1);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.remote.claim).mockImplementationOnce(async (candidate, descriptor) => { await waiting; return f.grant(candidate, descriptor); });
    const current = { ...f.options, taskTagFilterKey: key };
    const runner = createWorkerCoordinator(current);
    const ticking = runner.tick();
    try {
      await eventually(() => expect(f.remote.claim).toHaveBeenCalledOnce());
      runner.updateConfiguration({ ...current, taskTagFilterKey: null });
      release(); await ticking;
      expect(f.remote.claim).toHaveBeenCalledWith(f.candidates[0], expect.any(Object), expect.any(AbortSignal), key);
      expect(f.store.listTasks()).toHaveLength(1);
      await runner.tick();
      expect(f.remote.claim).toHaveBeenCalledOnce();
    } finally { release(); await ticking; }
  });

  it("reconciles an unknown claim result through inventory even when proof becomes unavailable", async () => {
    const f = await fixture(); f.candidates.splice(1);
    const stale = vi.fn();
    let claimedId = "";
    vi.mocked(f.remote.claim).mockImplementationOnce(async (candidate, descriptor) => {
      claimedId = descriptor.claimId;
      f.grant(candidate, descriptor);
      throw new Error("response lost");
    });
    const current = { ...f.options, taskTagFilterKey: key, onConfigurationStale: stale };
    const runner = createWorkerCoordinator(current);
    await runner.tick();
    expect(f.store.listTasks()).toEqual([]);
    expect(stale).not.toHaveBeenCalled();
    runner.updateConfiguration({ ...current, taskTagFilterKey: null });
    await runner.tick();
    expect(f.remote.ownInventory).toHaveBeenCalledTimes(2);
    expect(f.store.listTasks()).toEqual([expect.objectContaining({ claimId: claimedId, taskId: f.candidates[0]!.id })]);
    expect(f.remote.claim).toHaveBeenCalledOnce();
  });

  it("continues an existing claim while new claims are suspended", async () => {
    const f = await fixture(); f.candidates.splice(1);
    const descriptor = { claimId: uuid(9911), worktreeId: uuid(9912), workerId, machine: f.options.machine, platform: "linux" as const, agent: "codex" as const, agentControlMode: "web" as const };
    const granted = f.grant(f.candidates[0]!, descriptor);
    const row = f.store.registerPending({ projectId: granted.projectId, taskId: granted.id, claimId: descriptor.claimId, agent: "codex", agentControlMode: "web", nativeConfiguration: configuration });
    const advance = vi.fn(async (record: WebTask) => record);
    const runner = createWorkerCoordinator({ ...f.options, taskTagFilterKey: null, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: async record => ({ task: record, complete: true }) } });
    await runner.tick();
    await eventually(() => expect(advance).toHaveBeenCalledOnce());
    expect(f.store.getTask(row)?.status).toBe("active");
    expect(f.remote.claim).not.toHaveBeenCalled();
  });

  it.each(["claim_conflict", "version_conflict", "worker_task_tag_filter_unsupported"])("signals a filtered deterministic %s refusal", async code => {
    const f = await fixture(); const stale = vi.fn();
    vi.mocked(f.remote.claim).mockRejectedValueOnce(apiError(409, code, "refused"));
    const runner = createWorkerCoordinator({ ...f.options, taskTagFilterKey: key, onConfigurationStale: stale });
    await runner.tick();
    expect(stale).toHaveBeenCalledOnce();
    expect(f.remote.claim).toHaveBeenCalledOnce();
  });

  it.each(["legacy", "unknown"] as const)("does not signal or replay a %s claim failure", async mode => {
    const f = await fixture(); const stale = vi.fn();
    vi.mocked(f.remote.claim).mockRejectedValueOnce(mode === "legacy" ? apiError(409, "claim_conflict", "refused") : new Error("connection lost"));
    const runner = createWorkerCoordinator({ ...f.options, ...(mode === "legacy" ? {} : { taskTagFilterKey: key }), onConfigurationStale: stale });
    await runner.tick();
    expect(stale).not.toHaveBeenCalled();
    expect(f.remote.claim).toHaveBeenCalledOnce();
    expect(f.remote.ownInventory).toHaveBeenCalledOnce();
  });

  it("signals a filtered cursor-scope refusal and ends the scan", async () => {
    const f = await fixture(); const stale = vi.fn();
    vi.mocked(f.remote.candidates).mockImplementationOnce(async function* () { throw apiError(400, "invalid_input", "Cursor is invalid for this list."); });
    const runner = createWorkerCoordinator({ ...f.options, taskTagFilterKey: key, onConfigurationStale: stale });
    await expect(runner.tick()).rejects.toMatchObject({ code: "invalid_input" });
    expect(stale).toHaveBeenCalledOnce();
    expect(f.remote.claim).not.toHaveBeenCalled();
  });
});
