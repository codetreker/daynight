import { frozenToolLaunch } from "../../helpers/tool-launch.js";
import { scanFromList } from "../../helpers/worker-git-scan.js";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Task } from "../../../src/api/types.js";
import { readSessionStartupReport, readWorkerClaim } from "../../../src/api/task-properties.js";
import { openControllerLifecycleStore, readControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { controllerExecutionDirectory } from "../../../src/commands/controller/launch-ticket.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { createWebControllerLauncher } from "../../../src/commands/worker/backends/web-process.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { createWebExecutionBackend } from "../../../src/commands/worker/backends/web.js";
import type { WorkerSessionApi } from "../../../src/commands/worker/backends/session-api.js";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import type { WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { StartupObservation } from "../../../src/session/startup.js";
import { stopStartupChildren } from "../../helpers/startup-deadline.js";
import * as storageLock from "../../../src/commands/controller/storage-lock.js";
import * as storagePreparation from "../../../src/commands/controller/storage-preparation.js";

const native = vi.hoisted(() => ({ children: [] as ChildProcess[] }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args); native.children.push(child); return child;
  } };
});
// OS process ownership is a separate boundary; the child exit and failed IPC are real.
vi.mock("../../../src/commands/controller/process-proof.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/commands/controller/process-proof.js")>();
  return { ...actual,
    captureProcessProof: async (pid: number) => ({ pid, parentPid: process.pid, processGroupId: null, startedAt: "fixture", commandHash: "a".repeat(64) }),
    confirmControllerProcessesStopped: async (controller: Parameters<typeof actual.confirmControllerProcessesStopped>[0], descendants: Parameters<typeof actual.confirmControllerProcessesStopped>[1]) => {
      expect(controller.pid).toBe(native.children.at(-1)?.pid);
      expect(native.children.at(-1)?.exitCode).toBe(1);
      expect(descendants).toEqual([]);
      return true;
    },
  };
});
vi.mock("../../../src/commands/controller/launch-observation.js", () => ({
  reconcileSubmittedControllerLaunch: async ({ spawnProof }: { spawnProof: unknown }) => {
    const child = native.children.at(-1)!;
    if (child.exitCode === null) await new Promise<void>(resolve => child.once("exit", () => resolve()));
    return { kind: "pre-writer-exited", process: spawnProof, journal: "missing" };
  },
}));

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  await stopStartupChildren(native.children.splice(0));
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

const fixture = async (journalIdentity: Partial<Pick<ControllerLaunchTicket, "executionId" | "claimId" | "sessionId" | "executionGeneration" | "controllerInstanceId">> = {}) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/startup-launch-report");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-"));
  disposals.push(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "web-worker.sqlite");
  const store = openWebExecutionStore(file, { onMigration() {} });
  const workerStore = openWorkerStore(path.join(home, "worker.sqlite"), { onMigration() {} });
  disposals.push(async () => { store.close(); workerStore.close(); });
  const project = { serverOrigin: "https://daynight.example", projectId: randomUUID(), repoUrl: "https://example.test/repo.git", localPath: home };
  const configuration = { toolLaunch: frozenToolLaunch(), agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 3 };
  const identity = { projectId: project.projectId, taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID() };
  let task = store.register({ ...identity, project, serverOrigin: project.serverOrigin, configuration }, 1);
  task = store.bindWorktree(task, { repositoryPath: home, commonDirectory: home, worktreePath: home, branch: "task" }, 2);
  task = store.initializeWebExecution(task, 3);
  task = store.updateWebExecution(task, { sessionId: randomUUID(), initialPrompt: "fixture" }, 4);
  workerStore.registerProject(project);
  workerStore.registerPending({ ...identity, agent: "codex", agentControlMode: "web" });
  workerStore.activateTask(identity);
  const e = task.webExecution!, directory = controllerExecutionDirectory(home, e.executionId);
  await mkdir(directory, { recursive: true });
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, ...identity, launchId: e.launchId, executionId: e.executionId, controllerId: e.controllerId,
    controllerInstanceId: e.controllerInstanceId, sessionId: e.sessionId!, executionGeneration: e.executionGeneration, serverOrigin: project.serverOrigin,
    provider: "codex", cwd: home, nativeHome: path.join(home, "native"), configuration, initialOperationId: e.initialOperationId,
    initialPrompt: "fixture", resumeNativeSessionId: null, credentialFile: path.join(directory, "credential.json"),
    ipcEndpoint: path.join(home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date(0).toISOString() };
  const journalFile = path.join(directory, "journal.sqlite");
  const journal = openControllerLifecycleStore(journalFile, { ...ticket, ...journalIdentity }, { onMigration() {} });
  disposals.push(async () => { journal.close(); });
  journal.patchSnapshot({ lifecycle: "working", activity: "initializing" });
  // Simulate an abrupt pre-hello exit that leaves the last durable journal unfinished.
  await mkdir(path.join(home, "dist"));
  await writeFile(path.join(home, "dist/main.js"), "process.exit(1);\n");
  const sessionApi = { grant: vi.fn(async () => ({ token: "fixture-token", expiresAt: new Date(900_000).toISOString(), sessionId: e.sessionId!,
    claimId: task.claimId, executionGeneration: e.executionGeneration, controllerId: e.controllerId, controllerInstanceId: e.controllerInstanceId })) } as unknown as WorkerSessionApi;
  let clock = 10;
  const launcher = createWebControllerLauncher({ homeDirectory: home, packageDirectory: home, store, sessionApi, now: () => clock });
  const git = { scanWorktrees: scanFromList, listWorktrees: vi.fn(async () => []), prepareWorktree: vi.fn<WorkerGitManager["prepareWorktree"]>(async (candidate, owner, operation, cwd, requireBranch, binding, allowRestore) => {
    operation.check();
    expect(candidate).toMatchObject({ projectId: project.projectId, localPath: home });
    expect(owner).toMatchObject({ projectId: identity.projectId, taskId: identity.taskId, claimId: identity.claimId, worktreeId: identity.worktreeId });
    expect(cwd).toBe(home); expect(requireBranch).toBe(true); expect(binding).toEqual(task.resources.worktree); expect(allowRestore).toBe(false);
    return task.resources.worktree!;
  }) } as unknown as WorkerGitManager;
  const backend = createWebExecutionBackend({ homeDirectory: home, store, git, launcher, platform: "linux", buildPrompt: () => "fixture", emit() {}, now: () => clock });
  let remoteTask: Task = { type: "task", parentId: null, id: task.taskId, projectId: project.projectId, title: "fixture", description: "fixture", tags: [], status: "in_progress", allowAgents: true,
    assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, version: 1n, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false, properties: { pullRequests: [], worker: { claimId: identity.claimId, workerId: identity.workerId, worktreeId: identity.worktreeId,
      userId: identity.userId, agent: "codex", agentControlMode: "web", platform: "linux",
      machine: { id: randomUUID(), name: "fixture" }, state: "active", phase: "preparing", nativeSessionId: null, herdr: null, claimedAt: new Date(0).toISOString() } } };
  const update = vi.fn<WorkerRemote["update"]>(async (current, input) => {
    const { startupReport, ...summary } = input;
    remoteTask = { ...current, version: current.version + 1n, properties: { ...current.properties,
      ...(startupReport === undefined ? {} : { sessionStartup: startupReport }), worker: { ...readWorkerClaim(current.properties)!, ...summary } } };
    return remoteTask;
  });
  const remote = { serverOrigin: project.serverOrigin, currentUserId: async () => task.userId!, readTask: async () => remoteTask,
    ownInventory: async () => ({ tasks: [remoteTask], coveredProjectIds: [project.projectId], unavailableProjectIds: [] }),
    candidates: async function* () {}, update } as unknown as WorkerRemote;
  const advance = vi.spyOn(backend, "advanceResult");
  const coordinator = createWorkerCoordinator({ store: workerStore, webStore: store, webBackend: { ...backend, cleanup: async input => ({ task: input, complete: true }) },
    git, herdr: {} as WorkerHerdrAdapter, remote, serverOrigin: project.serverOrigin, workerId: task.workerId, platform: "linux",
    machine: { id: randomUUID(), name: "fixture" }, repositories: [{ project, configuration }], globalConfiguration: configuration,
    maxConcurrent: 1, preferPlatformSpecificTasks: false, buildPrompt: () => "fixture", emit() {}, now: () => clock, verifyWebStartupReporting: async () => true });
  disposals.push(async () => { await coordinator.shutdown(); });
  const reconcile = async () => { await coordinator.tick(); await new Promise<void>(resolve => setImmediate(resolve)); };
  const launch = async () => {
    // The unfinished writer is retained as report evidence; startup admission is controlled independently.
    const acquisition = vi.spyOn(storageLock, "acquireControllerStoragePermit").mockImplementation(journalFile => ({ journalFile, owner: randomUUID(), release() {} }));
    const preparation = vi.spyOn(storagePreparation, "prepareControllerStorage").mockReturnValue({ kind: "prepared", snapshot: null, legacyTimelineCleanupPending: false });
    try { await expect(launcher.launch(task, ticket, new AbortController().signal)).rejects.toThrow("before authenticated initialization"); }
    finally { preparation.mockRestore(); acquisition.mockRestore(); }
    expect(native.children.at(-1)?.exitCode).toBe(1);
    expect(readControllerSnapshot(journalFile)?.startup).toEqual({ state: "starting", reasonCode: "initializing" });
    return store.getTask(task)!.webExecution!.startupReport!;
  };
  return { file, store, task, journal, backend, launch, reconcile, update, advance, remote: () => remoteTask, clock: (now: number) => { clock = now; } };
};

test("pre-hello child exit uncertainty survives the unfinished journal, persistence and remote summary reconciliation", async () => {
  const f = await fixture(), original = await f.launch();
  expect(original).toMatchObject({ revision: "1", observedAt: new Date(10).toISOString(), startup: { state: "unknown", reasonCode: "controller_start_unknown" } });
  f.store.pauseRecovery(f.task, "Original launch is unconfirmed.", 21, "recovery_limit");
  f.clock(30);
  await f.reconcile();
  await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
  const report = readSessionStartupReport(f.remote().properties)!;
  expect(report).toMatchObject({ revision: "2", observedAt: new Date(30).toISOString(), startup: original.startup, recovery: { state: "blocked", reasonCode: "recovery_limit" } });
  expect(readWorkerClaim(f.remote().properties)?.phase).toBe("waiting");
  const persisted = openWebExecutionStore(f.file, { onMigration() {} });
  try { expect(persisted.getTask(f.task)?.webExecution?.startupReport).toEqual(report); } finally { persisted.close(); }
  f.clock(40);
  await f.reconcile();
  expect(f.store.getTask(f.task)?.webExecution?.startupReport).toEqual(report);
  expect(f.update).toHaveBeenCalledOnce();
  expect(f.advance).not.toHaveBeenCalled();
  expect(f.store.getTask(f.task)?.recovery).toMatchObject({ count: 0, retryAuthorized: false, reasonCode: "recovery_limit" });
  expect(native.children).toHaveLength(1);
});

test("ordinary unpaused Coordinator advancement preserves pre-hello uncertainty and reports its independent recovery block", async () => {
  const f = await fixture(), original = await f.launch();
  expect(f.store.getTask(f.task)?.recovery).toMatchObject({ count: 0, pauseReason: null, retryAuthorized: false });
  f.clock(30);
  await f.reconcile();
  await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
  expect(f.advance).toHaveBeenCalledOnce();
  expect(f.advance.mock.calls[0]![0].recovery.pauseReason).toBeNull();
  await expect(f.advance.mock.results[0]!.value).resolves.toMatchObject({ task: { recovery: { reasonCode: "native_identity_missing" }, webExecution: { launchSubmission: "unknown" } } });
  const report = readSessionStartupReport(f.remote().properties)!;
  expect(report).toMatchObject({ revision: "2", observedAt: new Date(30).toISOString(), startup: original.startup,
    executionGeneration: original.executionGeneration, controllerInstanceId: original.controllerInstanceId,
    recovery: { state: "blocked", reasonCode: "native_identity_missing" } });
  expect(readWorkerClaim(f.remote().properties)?.phase).toBe("waiting");
  expect(f.store.getTask(f.task)?.recovery).toMatchObject({ count: 0, retryAuthorized: false, reasonCode: "native_identity_missing" });
  const persisted = openWebExecutionStore(f.file, { onMigration() {} });
  try { expect(persisted.getTask(f.task)?.webExecution?.startupReport).toEqual(report); } finally { persisted.close(); }
  f.clock(40);
  await f.reconcile();
  expect(f.backend.observeStartupReport(f.task)).toEqual(report);
  expect(f.update).toHaveBeenCalledOnce();
  expect(f.advance).toHaveBeenCalledOnce();
  expect(f.store.getTask(f.task)?.resources.nativeSession).toBeNull();
  expect(native.children).toHaveLength(1);
});

test.each<StartupObservation>([
  { state: "ready", reasonCode: "ready" }, { state: "failed", reasonCode: "native_rejected" },
  { state: "unknown", reasonCode: "native_timeout" }, { state: "unknown", reasonCode: "native_transport_unknown" },
])("ordinary unpaused advancement accepts same-generation $reasonCode progress", async startup => {
  const f = await fixture(); await f.launch();
  f.journal.patchSnapshot({ startup }); f.clock(30);
  await f.reconcile();
  await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
  expect(f.advance).toHaveBeenCalledOnce();
  await expect(f.advance.mock.results[0]!.value).resolves.toMatchObject({ task: { recovery: { reasonCode: "native_identity_missing" }, webExecution: { launchSubmission: "unknown" } } });
  expect(readSessionStartupReport(f.remote().properties)).toMatchObject({ startup,
    recovery: { state: "blocked", reasonCode: "native_identity_missing" } });
  expect(f.store.getTask(f.task)?.recovery).toMatchObject({ count: 0, retryAuthorized: false });
  expect(native.children).toHaveLength(1);
});

test("reading the unfinished journal retains the launch result's original revision and observation time", async () => {
  const f = await fixture(), original = await f.launch();
  f.clock(20);
  expect(f.backend.observeStartupReport(f.task)).toEqual(original);
  expect(f.store.getTask(f.task)?.webExecution?.startupReport).toEqual(original);
});

test.each<StartupObservation>([
  { state: "ready", reasonCode: "ready" }, { state: "failed", reasonCode: "native_rejected" },
  { state: "unknown", reasonCode: "native_timeout" }, { state: "unknown", reasonCode: "native_transport_unknown" },
])("same-generation journal result $reasonCode supersedes the launch uncertainty without advancing recovery", async startup => {
  const f = await fixture(); await f.launch();
  f.store.pauseRecovery(f.task, "Original launch is unconfirmed.", 21, "native_identity_missing");
  f.journal.patchSnapshot({ startup }); f.clock(30);
  await f.reconcile();
  await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
  expect(readSessionStartupReport(f.remote().properties)).toMatchObject({ revision: "2", startup, recovery: { state: "blocked", reasonCode: "native_identity_missing" } });
  expect(f.advance).not.toHaveBeenCalled();
});

test.each(["executionId", "claimId", "sessionId", "executionGeneration", "controllerInstanceId"] as const)("ignores progressed journal evidence with a mismatched %s", async field => {
  const value = field === "executionGeneration" ? "2" : randomUUID();
  const f = await fixture({ [field]: value }); await f.launch();
  f.journal.patchSnapshot({ startup: { state: "ready", reasonCode: "ready" } } satisfies Partial<ControllerSnapshot>);
  f.store.pauseRecovery(f.task, "Original launch is unconfirmed.", 21, "native_identity_missing");
  f.clock(30); await f.reconcile();
  await vi.waitFor(() => expect(f.update).toHaveBeenCalledOnce());
  expect(readSessionStartupReport(f.remote().properties)).toMatchObject({ startup: { state: "unknown", reasonCode: "controller_start_unknown" }, recovery: { state: "blocked", reasonCode: "native_identity_missing" } });
  expect(f.advance).not.toHaveBeenCalled();
  expect(f.store.getTask(f.task)?.resources.nativeSession).toBeNull();
});
