import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { TimerOptions } from "node:timers";
import { afterEach, expect, it, vi } from "vitest";
import { scanFromList } from "../../helpers/worker-git-scan.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { captureSynchronousDeadline } from "../../helpers/synchronous-deadline.js";
import { frozenToolLaunch } from "../../helpers/tool-launch.js";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import { createOperation, type Operation } from "../../../src/api/operation.js";
import type { Task, WorkerClaimDescriptor } from "../../../src/api/types.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as launchObservation from "../../../src/commands/controller/launch-observation.js";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { ControllerIpcOutcomeUnknownError, type requestController } from "../../../src/commands/controller/local-client.js";
import { createWorkerCoordinator as createCoordinator } from "../../../src/commands/worker/coordinator.js";
import type { CleanupTarget, StopObservation } from "../../../src/commands/worker/execution-stop.js";
import type { WorkerEvent, WorkerGitManager } from "../../../src/commands/worker/execution.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore, type WebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { LocalTask as WebTask } from "../../../src/commands/worker/backends/web-types.js";
import { createMonitoringObserver } from "../../../src/commands/worker/monitoring/observer.js";
import { createWebArchiveMaintenance } from "../../../src/commands/worker/web-archive-backfill.js";
import { createWorkerGitManager, WorktreePreconditionError } from "../../../src/commands/worker/worktrees.js";
import { migrateLegacyWorktrees } from "../../../src/commands/worker/worktrees/migration.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import { startOwnedRepositoryGit } from "../../../src/repository/git-owned.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import { createRetiredClaimNativeCleanup } from "../../../src/commands/worker/backends/retired-claim-native.js";
import { createControllerJobLeases } from "../../../src/commands/worker/backends/controller-job-leases.js";
import type { ExecutionConfiguration, ResourceOwner, WorkerProject, WorktreeBinding } from "../../../src/commands/worker/types.js";
// Replace only the selected Git command with a real process that executes Git
// and leaves its inherited output open. All other subprocesses remain native.
const gitProcess = vi.hoisted(() => ({ wrapper: undefined as string | undefined, helper: undefined as string | undefined, child: undefined as ChildProcess | undefined, stopHelper: undefined as ChildProcess | undefined, childClosed: false, stdoutClosed: false, stderrClosed: false, helperClosed: false, helperStdoutClosed: false, diagnostics: [] as Record<string, unknown>[], stdoutBytes: 0, stderrBytes: 0 }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    if (args[0] === "git" && gitProcess.wrapper !== undefined && Array.isArray(args[1]) && args[1].includes("worktree") && args[1].includes("remove")) {
      gitProcess.diagnostics.push({ stage: "wrapper-spawn-attempt", executable: "node", arguments: "redacted", argumentCount: args[1].length });
      let child: ChildProcess;
      try { child = actual.spawn(process.execPath, [gitProcess.wrapper, ...args[1]], args[2]); }
      catch { gitProcess.diagnostics.push({ stage: "wrapper-spawn-error", code: "unknown" }); throw new Error("Fixture wrapper spawn failed."); }
      gitProcess.child = child;
      child.once("spawn", () => gitProcess.diagnostics.push({ stage: "wrapper-spawn", pid: child.pid ?? "unknown" }));
      child.once("error", error => gitProcess.diagnostics.push({ stage: "wrapper-error", code: ["ENOENT", "EACCES", "EPERM", "EIO", "EMFILE", "ENFILE"].includes((error as NodeJS.ErrnoException).code ?? "") ? (error as NodeJS.ErrnoException).code : "unknown" }));
      child.once("exit", (code, signal) => gitProcess.diagnostics.push({ stage: "wrapper-exit", code, signal }));
      child.once("close", (code, signal) => gitProcess.diagnostics.push({ stage: "wrapper-close", code, signal }));
      child.stdout?.on("data", chunk => { gitProcess.stdoutBytes += Buffer.byteLength(chunk); });
      child.stderr?.on("data", chunk => { gitProcess.stderrBytes += Buffer.byteLength(chunk); });
      child.once("close", () => { gitProcess.childClosed = true; });
      child.stdout?.once("close", () => { gitProcess.stdoutClosed = true; });
      child.stderr?.once("close", () => { gitProcess.stderrClosed = true; });
      return child;
    }
    if (typeof args[0] === "string" && /[\\/]System32[\\/]taskkill\.exe$/i.test(args[0]) && gitProcess.helper !== undefined) {
      gitProcess.diagnostics.push({ stage: "helper-spawn-attempt", executable: "node", arguments: "redacted" });
      let helper: ChildProcess;
      try { helper = actual.spawn(process.execPath, [gitProcess.helper, String((args[1] as string[])[1])], args[2]); }
      catch { gitProcess.diagnostics.push({ stage: "helper-spawn-error", code: "unknown" }); throw new Error("Fixture helper spawn failed."); }
      gitProcess.stopHelper = helper;
      helper.once("spawn", () => gitProcess.diagnostics.push({ stage: "helper-spawn", pid: helper.pid ?? "unknown" }));
      helper.once("error", () => gitProcess.diagnostics.push({ stage: "helper-error", code: "unknown" }));
      helper.once("exit", (code, signal) => gitProcess.diagnostics.push({ stage: "helper-exit", code, signal }));
      helper.once("close", (code, signal) => gitProcess.diagnostics.push({ stage: "helper-close", code, signal }));
      helper.once("close", () => { gitProcess.helperClosed = true; });
      helper.stdout?.once("close", () => { gitProcess.helperStdoutClosed = true; });
      return helper;
    }
    return Reflect.apply(actual.spawn, undefined, args) as ReturnType<typeof actual.spawn>;
  }) as typeof actual.spawn;
  return { ...actual, spawn };
});
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
const origin = "https://daynight.example", workerId = uuid(1);
const configuration: ExecutionConfiguration = { agent: "codex", agentControlMode: "web", model: "current-model", args: [], recoveryLimit: 2 };
const coordinators: ReturnType<typeof createCoordinator>[] = [];
const createWorkerCoordinator = (options: Parameters<typeof createCoordinator>[0]): ReturnType<typeof createCoordinator> => {
  const coordinator = createCoordinator(options); const shutdown = coordinator.shutdown.bind(coordinator);
  let closing: ReturnType<typeof shutdown> | undefined; coordinator.shutdown = () => closing ??= shutdown(); coordinators.push(coordinator); return coordinator;
};
const webStores: WebExecutionStore[] = [];
const directories: string[] = [], stores: ReturnType<typeof openWorkerStore>[] = [];
afterEach(async () => {
  const shutdowns = await Promise.allSettled(coordinators.splice(0).map(coordinator => coordinator.shutdown()));
  polling.onSchedule = undefined; polling.requested.length = 0; gitProcess.wrapper = undefined; gitProcess.helper = undefined; gitProcess.child = undefined; gitProcess.stopHelper = undefined; gitProcess.childClosed = false; gitProcess.stdoutClosed = false; gitProcess.stderrClosed = false; gitProcess.helperClosed = false; gitProcess.helperStdoutClosed = false; gitProcess.diagnostics.length = 0; gitProcess.stdoutBytes = 0; gitProcess.stderrBytes = 0;
  vi.restoreAllMocks(); for (const store of webStores.splice(0)) store.close(); for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true })));
  const errors = shutdowns.flatMap(result => result.status === "rejected" ? [result.reason] : []); if (errors.length) throw new AggregateError(errors, "Coordinator fixture shutdown failed.");
});
const task = (projectId: string, id: string): Task => ({ type: "task", parentId: null, id, projectId, title: id, description: "task", tags: [], status: "todo", allowAgents: true, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, version: 1n, properties: { pullRequests: [] }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true });
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 3500, interval: 10 });
const worktreePaths = (cwd: string): string[] => {
  const root = path.parse(cwd).root, physical = realpathSync.native(root);
  // Git expands Windows drive aliases; translate the physical drive root while
  // preserving junctions and checking the actual registrations returned by Git.
  return execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd, encoding: "utf8", timeout: 10_000 })
    .split("\0").filter(field => field.startsWith("worktree "))
    .map(field => {
      const observed = path.normalize(field.slice("worktree ".length)), relative = path.relative(physical, observed);
      return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? observed : path.resolve(root, relative);
    });
};
const fixture = async (maxConcurrent = 1) => {
  const base = path.resolve("../../.tmp/minimal-coordinator-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "r-")); directories.push(root);
  let store = openWorkerStore(path.join(root, "state.sqlite")); stores.push(store);
  const project: WorkerProject = { projectId: uuid(10), repoUrl: "https://example.test/owner/repo.git", localPath: path.join(root, "repo") }; store.registerProject(project);
  const candidates = [task(project.projectId, uuid(100)), task(project.projectId, uuid(101))];
  const grants = new Map<string, Task>(), worktrees = new Map<string, { owner: ResourceOwner; binding: WorktreeBinding }>(), manifests = new Map<string, { owner: ResourceOwner; binding: WorktreeBinding }>();
  const events: WorkerEvent[] = []; let clock = 1000;
  const bind = (owner: ResourceOwner): WorktreeBinding => {
    const source = store.getProject(owner)!; mkdirSync(source.localPath, { recursive: true });
    return { repositoryPath: source.localPath, commonDirectory: path.join(source.localPath, ".git"), worktreePath: path.join(source.localPath, ".worktrees", "daynight", owner.worktreeId), branch: `daynight/${owner.taskId}` };
  };
  const git = {
    prepareRepository: vi.fn(), dispose: vi.fn(), removeEmptyReservation: vi.fn(async () => {}),
    resolveWorktreeBinding: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => (worktrees.get(owner.claimId) ?? manifests.get(owner.claimId))?.binding ?? null),
    isOriginalWorktreeAbsent: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => !worktrees.has(owner.claimId)),
    listWorktreeManifests: vi.fn(async (source: WorkerProject) => [...new Map([...manifests, ...worktrees]).values()].filter(({ owner }) => owner.projectId === source.projectId)),
    retireWorktreeManifest: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { manifests.delete(owner.claimId); }),
    removeUnpublishedReservation: vi.fn(async () => {}),
    scanWorktrees: scanFromList, listWorktrees: vi.fn(async (source: WorkerProject) => [...worktrees.values()].filter(({ owner }) => owner.projectId === source.projectId)),
    removeWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { worktrees.delete(owner.claimId); return { kind: "absent" as const, effectErrors: [] }; }),
  } as unknown as WorkerGitManager;
  const grant = (candidate: Task, descriptor: WorkerClaimDescriptor): Task => {
    const result: Task = { ...candidate, status: "in_progress", ready: false, version: candidate.version + 1n, properties: { ...candidate.properties, worker: { ...descriptor, agentControlMode: "web", userId: uuid(2), state: "active", phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } }; grants.set(descriptor.claimId, result); return result;
  };
  const remote = { serverOrigin: origin, currentUserId: vi.fn(async () => uuid(2)),
    ownInventory: vi.fn(async (projects: readonly { projectId: string }[]) => ({ tasks: [...grants.values()], coveredProjectIds: [...new Set(projects.map(project => project.projectId))], unavailableProjectIds: [] })),
    candidates: vi.fn(async function* (projectId: string) { for (const candidate of candidates) if (candidate.projectId === projectId && ![...grants.values()].some(value => value.id === candidate.id)) yield candidate; }),
    claim: vi.fn(async (candidate: Task, descriptor: WorkerClaimDescriptor) => grant(candidate, descriptor)),
    readTask: vi.fn(async (_projectId: string, taskId: string) => { const result = [...grants.values()].find(value => value.id === taskId); if (result === undefined) throw new Error("missing task"); return result; }),
    update: vi.fn(async (current: Task, update: object) => { const result = { ...current, properties: { ...current.properties, worker: { ...readWorkerClaim(current.properties)!, ...update } } }; grants.set(readWorkerClaim(current.properties)!.claimId, result); return result; }),
  } as unknown as WorkerRemote;
  const webStore = openWebExecutionStore(createMemoryDatabase()); webStores.push(webStore);
  const unexpectedBackendCall = async (): Promise<never> => { throw new Error("Unexpected Web backend call in coordinator fixture."); };
  const webBackend = { advance: unexpectedBackendCall, cleanup: unexpectedBackendCall, observeExecutionStop: unknownStop };
  const retiredNativeCleanup = createRetiredClaimNativeCleanup({ homeDirectory: root, identity: { serverOrigin: origin, workerId, userId: uuid(2) }, jobLeases: createControllerJobLeases() });
  const options = { store, webStore, webBackend, retiredNativeCleanup, git, remote, serverOrigin: origin, workerId, userId: uuid(2), platform: "linux" as const, machine: { id: uuid(3), name: "fixture" }, repositories: [{ project, configuration }], globalConfiguration: configuration, maxConcurrent, preferPlatformSpecificTasks: false, emit: (event: WorkerEvent) => events.push(event), now: () => clock };
  const reopenStore = () => { stores.splice(stores.indexOf(store), 1); store.close(); store = openWorkerStore(path.join(root, "state.sqlite")); stores.push(store); options.store = store; return store; };
  return { root, get store() { return store; }, reopenStore, project, candidates, grants, grant, worktrees, manifests, git, remote, events, options, clock: (value: number) => { clock = value; }, bind };
};

it("reconciles a persisted missing-Web cleanup schedule on first shutdown after the local index became done", async () => {
  const f = await fixture();
  const owner = { projectId: f.project.projectId, taskId: uuid(970), claimId: uuid(971), worktreeId: uuid(972) };
  f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
  f.store.saveCleanupSchedule(owner, { deadline: 1000, failures: 0, nextAttemptAt: 0, stage: "worktree-removal", lastError: null });
  f.store.completeTask(owner); f.bind(owner); f.reopenStore();
  vi.mocked(f.remote.readTask).mockResolvedValue({ ...task(owner.projectId, owner.taskId), status: "done" });
  const verify = vi.fn(async () => { throw new Error("Session registration cannot decide retained cleanup."); });
  const coordinator = createWorkerCoordinator({ ...f.options, verifyWebUnregistered: verify });
  await expect(coordinator.shutdown()).resolves.toBe(true);
  expect(f.store.getTask(owner)?.status).toBe("done");
  expect(f.store.getCleanupSchedule(owner)).toBeNull();
  expect(f.git.removeUnpublishedReservation).toHaveBeenCalledExactlyOnceWith(f.project, expect.objectContaining(owner), expect.anything());
  expect(verify).not.toHaveBeenCalled();
  expect(f.remote.readTask).toHaveBeenCalledOnce();
});

const stoppedWebExecution = async (f: Awaited<ReturnType<typeof fixture>>, store: WebExecutionStore, task: WebTask) => {
  const execution = task.webExecution!;
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, sessionId: execution.sessionId!, executionGeneration: execution.executionGeneration, serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, userId: task.userId!, provider: task.configuration!.agent, cwd: task.resources.worktree?.worktreePath ?? f.project.localPath, nativeHome: path.join(f.root, "native"), configuration: task.configuration!, initialOperationId: execution.initialOperationId, initialPrompt: "managed", resumeNativeSessionId: null, credentialFile: path.join(f.root, "grant.json"), ipcEndpoint: path.join(f.root, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  task = store.updateWebExecution(task, { ticketPath: await writeLaunchTicket(f.root, ticket) }, 6);
  const snapshot: lifecycle.ControllerSnapshot = { executionId: execution.executionId, claimId: task.claimId, sessionId: execution.sessionId!, executionGeneration: execution.executionGeneration, controllerInstanceId: execution.controllerInstanceId, lifecycle: "stopped", nativeSessionId: task.resources.nativeSession?.sessionId ?? null, initialInputState: "confirmed", activity: "stopped", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, controllerProcess: { pid: 123, parentPid: 1, processGroupId: 123, startedAt: "birth", commandHash: "a".repeat(64) }, nativeProcesses: [], nativeStopped: true, stoppedAt: new Date().toISOString(), error: null };
  task = store.updateWebExecution(task, { controllerProcess: snapshot.controllerProcess }, 7);
  vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("stopped");
  vi.spyOn(lifecycle, "readControllerSnapshot").mockReturnValue(snapshot);
  vi.spyOn(launchObservation, "reconcileSubmittedControllerLaunch").mockImplementation(async input => ({ kind: "controller-exited", process: input.spawnProof, snapshot }));
  vi.spyOn(lifecycle, "recordStoppedControllerGeneration").mockResolvedValue(snapshot);
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  return { task, ticket, snapshot, request: vi.fn<typeof requestController>().mockRejectedValue(new ControllerIpcOutcomeUnknownError("Original controller is stopped.")) };
};
it("fences an unfinished Web record before the first reconciliation after restart", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webFile = path.join(f.root, "web.sqlite");
    const owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(700), worktreeId: uuid(702) };
    let webStore = openWebExecutionStore(webFile);
    webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: { ...configuration, agentControlMode: "web" } }, 1);
    webStore.close();
    webStore = openWebExecutionStore(webFile);
    const restarted = createWorkerCoordinator({ ...f.options, webStore });
    try {
      await restarted.tick();
      expect(f.remote.claim).not.toHaveBeenCalled();
      expect(webStore.getTask(owner)?.status).not.toBe("done");
    } finally { await restarted.shutdown(); webStore.close(); }
  });

it("keeps ordinary Web failures separate from native recovery and retries after restart", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture();
  let webStore = openWebExecutionStore(path.join(f.root, "web.sqlite"));
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 3 };
  const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => {
    webStore.bindNativeSession(input, { source: "controller", sessionId: uuid(880) }, 2);
    throw new WorktreePreconditionError("branch_mismatch", "The task worktree no longer uses its original task branch.");
  });
  const update = vi.mocked(f.remote.update).getMockImplementation()!;
  vi.mocked(f.remote.update).mockImplementationOnce(async current => {
    f.grants.set(readWorkerClaim(current.properties)!.claimId, { ...current, version: 17n });
    throw new Error("Summary response lost.");
  }).mockImplementation(update);
  const options = () => ({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore, verifyWebServer: vi.fn(async () => {}), verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
  let coordinator = createWorkerCoordinator(options());
  const tick = async () => { await coordinator.tick(); await new Promise<void>(resolve => setImmediate(resolve)); };
  try {
    await tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(1));
    await tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(2));
    await tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(3));
    await tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(4));
    await eventually(() => expect(f.remote.update).toHaveBeenCalled());
    const row = f.store.listTasks()[0]!;
    const paused = webStore.getTask(row)!;
    expect(paused.recovery.pauseReason).toBeNull();
    expect(paused.recovery.count).toBe(0);
    expect(paused.recovery.retryAuthorized).toBe(false);
    await tick();
    await eventually(() => expect(f.remote.update).toHaveBeenCalledTimes(2));
    expect(vi.mocked(f.remote.update).mock.calls[1]![0].version).toBe(17n);
    expect(vi.mocked(f.remote.update).mock.calls[1]![1]).toEqual({ phase: "waiting", nativeSessionId: uuid(880) });
    await coordinator.shutdown();
    webStore.close(); webStore = openWebExecutionStore(path.join(f.root, "web.sqlite"));
    coordinator = createWorkerCoordinator(options());
    await tick(); await tick();
    expect(advance.mock.calls.length).toBeGreaterThan(4);
    expect(f.remote.update).toHaveBeenCalledTimes(2);
    expect(webStore.getTask(row)?.recovery).toEqual(paused.recovery);
    expect(f.store.getTask(row)).toMatchObject({ status: "active", sessionId: uuid(880) });
    expect(readWorkerClaim(f.grants.get(row.claimId)!.properties)).toMatchObject({ claimId: row.claimId, state: "active", phase: "waiting" });
    expect(f.remote.claim).toHaveBeenCalledOnce();
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("validates and freezes a Web tool before claiming, then retains that choice when current targets fail", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { resolveToolLaunch } = await import("../../../src/platform/tool-executables.js");
  const f = await fixture(); f.candidates.splice(1);
  const file = path.join(f.root, "selected.mjs"); await writeFile(file, "#!/usr/bin/env node\nconsole.log('fixture');\n", { mode: 0o755 });
  const operation = createOperation();
  let toolLaunch;
  try { toolLaunch = await resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "path", path: file }, cwd: f.root, environment: {} }, operation); }
  finally { operation.dispose(); }
  const webStore = openWebExecutionStore(path.join(f.root, "web.sqlite"));
  const configuration: ExecutionConfiguration = { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 };
  let available = false, selections = 0;
  const freezeConfiguration = async (input: ExecutionConfiguration) => {
    if (input.toolLaunch !== undefined) return input;
    if (!available) throw new Error("Selected tool is unavailable.");
    expect(f.remote.claim).not.toHaveBeenCalled(); selections++;
    return { ...input, toolLaunch, toolObservation: { version: "1.0.0", checkedAt: "2026-11-12T00:00:00Z" } };
  };
  const advance = vi.fn(async (input: WebTask) => webStore.initializeWebExecution(input, 1));
  const coordinator = createWorkerCoordinator({ ...f.options, freezeConfiguration, webStore, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration,
    verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: async task => ({ task, complete: true }) } });
  try {
    await expect(coordinator.tick()).rejects.toThrow("Selected tool is unavailable"); expect(f.remote.claim).not.toHaveBeenCalled();
    available = true; await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalled());
    const task = f.store.listTasks()[0]!;
    expect(f.store.getNativeConfiguration(task)?.toolLaunch?.selectionKey).toBe(toolLaunch.selectionKey);
    expect(webStore.getTask(task)?.configuration?.toolObservation?.version).toBe("1.0.0");
    const advances = advance.mock.calls.length; available = false;
    await coordinator.tick(); await eventually(() => expect(advance.mock.calls.length).toBeGreaterThan(advances));
    expect(selections).toBe(1); expect(f.remote.claim).toHaveBeenCalledOnce();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("settles an explicitly controlled Web claim verified as unregistered", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = openWebExecutionStore(path.join(f.root, "web.sqlite"));
  const owner = { projectId: f.project.projectId, taskId: uuid(940), claimId: uuid(941), worktreeId: uuid(942) };
  f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
  f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
  f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
  const verifyWebUnregistered = vi.fn(async () => {});
  const coordinator = createWorkerCoordinator({ ...f.options, webStore, webBackend: { advance: vi.fn(), cleanup: vi.fn(), observeExecutionStop: unknownStop }, verifyWebUnregistered });
  try {
    await coordinator.completeSource(owner);
    expect(verifyWebUnregistered).toHaveBeenCalledOnce();
    expect(f.store.getTask(owner)?.status).toBe("done");
    expect(f.store.getCleanupSchedule(owner)).toBeNull();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it.each([{ stream: "stdout", mode: "reconcile" }, { stream: "stderr", mode: "shutdown" }, { stream: "child", mode: "shutdown" }, ...(process.platform === "win32" ? [{ stream: "helper", mode: "shutdown" }] : [])])("holds the original task gate through $stream closure and $mode", async ({ stream, mode }) => {
  const f = await fixture(), monitoring = createMonitoringObserver({ now: f.options.now });
  await mkdir(f.project.localPath, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10_000 });
  git(f.project.localPath, "init", "--initial-branch=main");
  git(f.project.localPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
  git(f.project.localPath, "remote", "add", "origin", f.project.repoUrl);
  const bare = path.join(f.root, "origin.git");
  git(f.root, "clone", "--bare", f.project.localPath, bare);
  git(f.project.localPath, "config", `url.${bare}.insteadOf`, f.project.repoUrl);
  const ready = path.join(f.root, "pipe-ready"), rootReady = path.join(f.root, "root-ready"), release = path.join(f.root, "pipe-release");
  const leaf = path.join(f.root, "pipe-holder.mjs"), wrapper = path.join(f.root, "git-wrapper.mjs");
  const receipt = path.join(f.root, "pipe-receipt.jsonl");
  const fixtureModule = pathToFileURL(path.resolve("test/commands/worker/pipe-ready-fixture.mjs")).href;
  await writeFile(leaf, `import { runLeaf } from ${JSON.stringify(fixtureModule)};\nrunLeaf(${JSON.stringify({ ready, release, receipt })});\n`);
  await writeFile(wrapper, `import { runWrapper } from ${JSON.stringify(fixtureModule)};\nrunWrapper(${JSON.stringify({ stream, ready, rootReady, release, leaf, receipt })});\n`);
  if (stream === "child") {
    const helper = path.join(f.root, "stop-helper.mjs"); await writeFile(helper, "process.exit(0);\n");
    gitProcess.helper = helper;
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => pid === -(gitProcess.child?.pid ?? 0) ? true : kill(pid, signal));
  }
  if (stream === "helper") {
    const helper = path.join(f.root, "stop-helper.mjs");
    const taskkill = path.win32.join(process.env.SystemRoot!, "System32", "taskkill.exe");
    await writeFile(helper, `import { spawn, spawnSync } from 'node:child_process';\nconst stopped = spawnSync(${JSON.stringify(taskkill)}, ['/PID', process.argv[2], '/T', '/F'], { stdio: 'ignore', windowsHide: true });\nif (stopped.status !== 0) process.exit(stopped.status ?? 1);\nconst leaf = spawn(process.execPath, [${JSON.stringify(leaf)}], { detached: true, stdio: ['ignore', 'inherit', 'ignore'], windowsHide: true });\nleaf.unref();\n`);
    gitProcess.helper = helper;
  }
  let pending: import("../../../src/commands/worker/worktrees.js").WorkerGitPending | undefined;
  const joined = Promise.withResolvers<import("../../../src/repository/git-owned.js").GitSettlement>();
  const interrupt = new AbortController();
  let originalSignal: AbortSignal | undefined; let ownedSignal: AbortSignal | undefined; let shutdown: Promise<boolean> | undefined;
  const manager = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temporary"), prepareFormat,
    startOwnedGit: (cwd, args, op, options) => {
      const remove = args.includes("worktree") && args.includes("remove");
      if (!remove) return startOwnedRepositoryGit(cwd, args, op, options);
      originalSignal = op.signal;
      const ownedOperation = createOperation({ signal: AbortSignal.any([op.signal, interrupt.signal]), limits: op.limits });
      ownedSignal = ownedOperation.signal;
      const command = startOwnedRepositoryGit(cwd, args, ownedOperation, options);
      void command.joined.then(() => ownedOperation.dispose());
      return command;
    },
    reportPending: (event) => { if (event.command === "worktree-remove") pending = event; },
    reportSettled: (event, settlement) => { if (event.command === "worktree-remove") joined.resolve(settlement); },
  });
  const operation = createOperation();
  try { await manager.prepareRepository(f.project, operation); } finally { operation.dispose(); }
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const webStore = openWebExecutionStore(createMemoryDatabase());
  const owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(700), worktreeId: uuid(702) };
  f.grant(f.candidates[0]!, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", agentControlMode: "web" });
  const original = f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web", sessionId: uuid(703) }));
  const prepare = createOperation(); let binding: WorktreeBinding;
  try { binding = await manager.prepareWorktree(f.project, owner, prepare); } finally { prepare.dispose(); }
  let row = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
  row = webStore.bindWorktree(row, binding, 2); row = webStore.initializeWebExecution(row, 3);
  row = webStore.updateWebExecution(row, { sessionId: uuid(703), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
  row = webStore.bindNativeSession(row, { source: "controller", sessionId: uuid(703) }, 5);
  const stopped = await stoppedWebExecution(f, webStore, row);
  const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: manager, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: event => { f.options.emit({ kind: event.kind, message: event.message, ...(event.task === undefined ? {} : { identity: { projectId: event.task.projectId, taskId: event.task.taskId, claimId: event.task.claimId, worktreeId: event.task.worktreeId } }), ...(event.component === undefined ? {} : { component: event.component }), ...(event.phase === undefined ? {} : { phase: event.phase }), ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }), ...(event.runKey === undefined ? {} : { runKey: event.runKey }), ...(event.error === undefined ? {} : { error: event.error }) }); }, now: f.options.now, request: stopped.request, archive: async () => {}, jobLeases: { enabled: false, retainBirthCleanup: () => () => {}, cleanupBirth: async () => {}, adopt: () => { throw new Error("Unexpected native launch ownership in this fixture."); }, retain: async () => undefined, get: async () => undefined, release: async () => {}, close: async () => {} } });
  const advance = vi.fn(async (input: WebTask, signal: AbortSignal) => {
    if (input.claimId === owner.claimId) return input;
    const operation = createOperation({ signal });
    try { const worktree = await manager.prepareWorktree(f.project, input, operation); return webStore.bindNativeSession(webStore.bindWorktree(input, worktree, 20), { source: "controller", sessionId: randomUUID() }, 21); }
    finally { operation.dispose(); }
  });
  const { advanceResult: _advanceResult, ...backendWithAdvance } = backend;
  const coordinator = createWorkerCoordinator({ ...f.options, git: manager, webStore, webBackend: { ...backendWithAdvance, advance }, monitoring, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
  const reportMissingReady = async () => {
    const markerState = async (file: string): Promise<string> => {
      try { await access(file); return "present"; }
      catch (failure) { return (failure as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
    };
    let records: string = "unknown";
    try { records = await readFile(receipt, "utf8"); } catch { /* No receipt does not prove that the wrapper did not start. */ }
    console.error("pipe-ready fixture diagnostics", JSON.stringify({
      stream, mode, wrapper: gitProcess.diagnostics,
      output: { stdoutBytes: gitProcess.child?.stdout ? gitProcess.stdoutBytes : "unknown", stderrBytes: gitProcess.child?.stderr ? gitProcess.stderrBytes : "unknown" },
      closed: { child: gitProcess.childClosed, stdout: gitProcess.stdoutClosed, stderr: gitProcess.stderrClosed },
      ready: await markerState(ready), rootReady: await markerState(rootReady), receipt: records,
      events: f.events.map(event => ({ kind: event.kind, message: event.message, error: event.error instanceof Error ? { name: event.error.name, message: event.error.message, cause: event.error.cause instanceof Error ? event.error.cause.message : undefined } : undefined })),
      localTask: f.store.getTask(owner), webTask: webStore.getTask(owner), cleanup: f.store.getCleanupSchedule(owner),
    }));
  };
  try {
    await coordinator.tick();
    expect(f.store.getTask(original)?.sessionId).toBe(uuid(703));
    gitProcess.wrapper = wrapper;
    const candidates = f.candidates.splice(0);
    f.grants.clear();
    await coordinator.tick();
    const started = stream === "helper" ? rootReady : ready;
    await vi.waitFor(async () => { await coordinator.tick(); await expect(access(started)).resolves.toBeUndefined(); }, { timeout: 15_000, interval: 20 });
    if (stream === "child" && process.platform !== "win32") {
      await vi.waitFor(() => { expect(gitProcess.stdoutClosed).toBe(true); expect(gitProcess.stderrClosed).toBe(true); }, { timeout: 12_000, interval: 20 });
    } else if (stream === "stdout" || stream === "stderr") {
      await vi.waitFor(() => {
        expect(gitProcess.child?.exitCode).toBe(0);
        expect(stream === "stdout" ? gitProcess.stderrClosed : gitProcess.stdoutClosed).toBe(true);
      }, { timeout: 12_000, interval: 20 });
      expect(stream === "stdout" ? gitProcess.stdoutClosed : gitProcess.stderrClosed).toBe(false);
      expect(gitProcess.childClosed).toBe(false);
    }
    const cancellation = new Error("controlled mutation cancellation");
    if (process.platform === "win32" && (stream === "child" || stream === "helper")) {
      interrupt.abort(cancellation);
    } else {
      // The observed leader exit or POSIX stop path leaves only the Git cleanup grace timer.
      const grace = captureSynchronousDeadline(() => interrupt.abort(cancellation));
      try {
        expect(grace.count).toBe(1);
        expect(grace.requested).toBe(1_000);
        grace.markReady();
        await grace.expire();
      } finally { grace.restore(); }
    }
    await vi.waitFor(() => expect(pending).toBeDefined(), { timeout: 15_000, interval: 20 });
    expect(pending).toMatchObject({ projectId: f.project.projectId, owner, command: "worktree-remove", error: { code: "repository_git_cleanup_pending" } });
    const contains = (error: unknown, target: unknown): boolean => error === target || error instanceof Error && (contains(error.cause, target) || error instanceof AggregateError && error.errors.some((entry: unknown) => contains(entry, target)));
    expect(contains(pending?.error, ownedSignal!.reason)).toBe(true);
    await vi.waitFor(async () => { await expect(access(ready)).resolves.toBeUndefined(); }, { timeout: 12_000, interval: 20 });
    if (stream === "child") {
      expect(gitProcess.child?.exitCode).toBeNull();
      expect(gitProcess.child?.signalCode).toBeNull();
      expect(gitProcess.childClosed).toBe(false);
      if (process.platform !== "win32") { expect(gitProcess.stdoutClosed).toBe(true); expect(gitProcess.stderrClosed).toBe(true); }
    }
    if (stream === "helper") {
      await vi.waitFor(() => {
        expect(gitProcess.child).toBeDefined();
        expect(gitProcess.child!.exitCode !== null || gitProcess.child!.signalCode !== null).toBe(true);
        expect(gitProcess.childClosed).toBe(true);
        expect(gitProcess.stdoutClosed).toBe(true); expect(gitProcess.stderrClosed).toBe(true);
        expect(gitProcess.stopHelper?.exitCode).toBe(0);
      }, { timeout: 12_000, interval: 20 });
      expect(gitProcess.helperStdoutClosed).toBe(false);
      expect(gitProcess.helperClosed).toBe(false);
    }
    await expect(access(f.bind(owner).worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.store.getTask(original)?.status).toBe("active");
    await coordinator.tick();
    expect(f.events.filter(event => event.kind === "execution-stop-observation-error")).toEqual([]);
    expect(monitoring.capture().capacity).toMatchObject({ occupied: 0, available: 1 });
    f.candidates.push(...candidates);
    await coordinator.tick();
    expect(vi.mocked(f.remote.claim).mock.calls.filter(([candidate]) => candidate.id === original.taskId)).toEqual([]);
    await eventually(() => expect([...f.grants.values()].some(value => value.id === uuid(101))).toBe(true));
    expect(f.store.getTask(original)?.status).toBe("active");
    if (mode === "shutdown") {
      shutdown = coordinator.shutdown(); let stopped = false; void shutdown.then(() => { stopped = true; });
      expect(originalSignal?.aborted).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(stopped).toBe(false);
      expect(f.store.getTask(original)?.status).toBe("active");
      await writeFile(release, "release");
      const settlement = await joined.promise;
      expect(settlement.kind).toBe("local-closed");
      expect(gitProcess.childClosed).toBe(true);
      expect(gitProcess.stdoutClosed).toBe(true); expect(gitProcess.stderrClosed).toBe(true);
      if (stream === "helper") { expect(gitProcess.helperClosed).toBe(true); expect(gitProcess.helperStdoutClosed).toBe(true); }
      await shutdown;
    } else {
      await writeFile(release, "release");
      expect((await joined.promise).kind).toBe("local-closed");
      expect(gitProcess.childClosed).toBe(true);
      expect(gitProcess.stdoutClosed).toBe(true); expect(gitProcess.stderrClosed).toBe(true);
      await eventually(() => expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-effect-error", identity: expect.objectContaining(owner), error: expect.any(AggregateError) })));
      expect(contains(f.events.find(event => event.kind === "cleanup-effect-error")?.error, pending?.error)).toBe(true);
      await eventually(() => expect(f.store.getTask(original)?.status).toBe("done"));
      await eventually(() => expect(f.store.getCleanupSchedule(original)).toBeNull());
    }
  } catch (error) {
    await reportMissingReady();
    throw error;
  } finally {
    interrupt.abort(new Error("fixture cleanup"));
    await writeFile(release, "release");
    gitProcess.wrapper = undefined;
    await (shutdown ?? coordinator.shutdown());
    webStore.close(); await manager.dispose();
  }
}, 45_000);

it("reconciles a failed Web removal after manual deletion in the same coordinator", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const f = await fixture(2), monitoring = createMonitoringObserver({ now: f.options.now });
  await mkdir(f.project.localPath, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10_000 });
  git(f.project.localPath, "init", "--initial-branch=main");
  git(f.project.localPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
  git(f.project.localPath, "remote", "add", "origin", f.project.repoUrl);
  const bare = path.join(f.root, "origin.git");
  git(f.root, "clone", "--bare", f.project.localPath, bare);
  git(f.project.localPath, "config", `url.${bare}.insteadOf`, f.project.repoUrl);
  const failure = new Error("controlled Web directory removal failure"); let fail = true;
  const manager = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temporary"), prepareFormat,
    removeDirectory: async (...args) => { if (fail) { fail = false; throw failure; } return rm(...args); },
  });
  const operation = createOperation();
  const owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(700), worktreeId: uuid(702) };
  let binding: WorktreeBinding;
  try { await manager.prepareRepository(f.project, operation); binding = await manager.prepareWorktree(f.project, owner, operation); } finally { operation.dispose(); }
  await mkdir(path.join(binding.worktreePath, "content"));
  await writeFile(path.join(binding.worktreePath, "content", "file"), "data");
  const webStore = openWebExecutionStore(createMemoryDatabase());
  const webConfig = { ...configuration, args: [], agentControlMode: "web" as const };
  f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
  let row = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: webConfig }, 1);
  row = webStore.bindWorktree(row, binding, 2);
  row = webStore.initializeWebExecution(row, 3);
  row = webStore.updateWebExecution(row, { sessionId: uuid(703), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
  const stopped = await stoppedWebExecution(f, webStore, row);
  webStore.beginCleanup(stopped.task, { kind: "terminal", deadline: 100 }, 8);
  const archive = vi.fn(async (task: WebTask) => { expect(task.webExecution?.sessionId).toBe(uuid(703)); throw new Error("controlled archive receipt unavailable"); });
  // This integration owns cleanup and scheduling, with the original controller stop controlled at its backend boundary.
  const jobLeases = { enabled: false, retainBirthCleanup: () => () => {}, cleanupBirth: async () => {}, adopt: () => { throw new Error("Unexpected native launch ownership in this fixture."); }, retain: async () => undefined, get: async () => undefined, release: async () => {}, close: async () => {} };
  const backendOptions = { homeDirectory: f.root, store: webStore, git: manager, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux" as const, buildPrompt: () => "managed", emit: () => {}, now: f.options.now, request: stopped.request, archive, jobLeases };
  const backend = createWebExecutionBackend(backendOptions);
  const advance = vi.fn(async (input: WebTask, signal: AbortSignal) => {
    if (input.resources.worktree !== null) return input;
    const operation = createOperation({ signal });
    try { return webStore.bindWorktree(input, await manager.prepareWorktree(f.project, input, operation), 20); }
    finally { operation.dispose(); }
  });
  const [originalCandidate, healthyCandidate] = f.candidates.splice(0); f.grants.clear();
  const { advanceResult: _advanceResult, ...backendWithAdvance } = backend;
  const coordinator = createWorkerCoordinator({ ...f.options, git: manager, webStore, webBackend: { ...backendWithAdvance, advance }, monitoring, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
  try {
    await coordinator.tick();
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toMatchObject({ failures: 1, stage: "worktree-removal" }));
    expect(archive).toHaveBeenCalledOnce();
    expect(worktreePaths(f.project.localPath)).toContain(path.normalize(binding.worktreePath));
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error" }));
    expect(monitoring.capture().currentFailures).toEqual(expect.arrayContaining([expect.objectContaining({ scope: expect.objectContaining({ claimId: owner.claimId }) })]));
    expect(webStore.getTask(owner)?.status).toBe("active");
    expect(worktreePaths(f.project.localPath)).toContain(path.normalize(binding.worktreePath));
    f.candidates.push(healthyCandidate!); await coordinator.tick();
    await eventually(() => expect(advance).toHaveBeenCalledOnce());
    await rm(binding.worktreePath, { recursive: true, force: true });
    expect(worktreePaths(f.project.localPath)).toContain(path.normalize(binding.worktreePath));
    f.clock(1_000_000); await coordinator.tick();
    await eventually(() => expect(webStore.getTask(owner)?.status).toBe("done"));
    await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done"));
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
    expect(archive).toHaveBeenCalledTimes(2);
    expect(monitoring.capture().lastRecovery?.scope).toMatchObject({ claimId: owner.claimId });
    await coordinator.tick();
    await eventually(() => expect(createWorktreeManifestStore(path.join(f.project.localPath, ".git")).read(owner.worktreeId)).toBeNull());
    expect(worktreePaths(f.project.localPath)).not.toContain(path.normalize(binding.worktreePath));
    f.candidates.push(originalCandidate!);
    await coordinator.tick();
    await eventually(() => expect(f.store.listTasks().some(entry => entry.taskId === owner.taskId && entry.claimId !== owner.claimId)).toBe(true));
    const successor = f.store.listTasks().find(entry => entry.taskId === owner.taskId && entry.claimId !== owner.claimId)!;
    await eventually(() => expect(webStore.getTask(successor)?.resources.worktree).not.toBeNull());
    const successorOwner = webStore.getTask(successor)!;
    expect(successor.status).toBe("active");
    expect(successorOwner.worktreeId).not.toBe(owner.worktreeId);
    expect(f.bind(successorOwner).worktreePath).not.toBe(binding.worktreePath);
    await expect(access(f.bind(successorOwner).worktreePath)).resolves.toBeUndefined();
  } finally { await coordinator.shutdown(); await manager.dispose(); webStore.close(); }
}, 30_000);

it.each([
  { code: "archive_incomplete", removalFails: false },
  { code: "projection_gap", removalFails: true },
  { code: "markdown_projection_failed", removalFails: false },
] as const)("transfers a retained Web repair schedule to backfill across restart: $code, removal failure $removalFails", async ({ code, removalFails }) => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const f = await fixture();
  let monitoring = createMonitoringObserver({ now: f.options.now });
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await mkdir(f.project.localPath, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10_000 });
  git(f.project.localPath, "init", "--initial-branch=main");
  git(f.project.localPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
  git(f.project.localPath, "remote", "add", "origin", f.project.repoUrl);
  const bare = path.join(f.root, "origin.git");
  git(f.root, "clone", "--bare", f.project.localPath, bare);
  git(f.project.localPath, "config", `url.${bare}.insteadOf`, f.project.repoUrl);
  const manager = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temporary"), prepareFormat });
  const owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(710), worktreeId: uuid(711) };
  const operation = createOperation();
  let binding: WorktreeBinding;
  try { await manager.prepareRepository(f.project, operation); binding = await manager.prepareWorktree(f.project, owner, operation); } finally { operation.dispose(); }
  const webFile = path.join(f.root, "web.sqlite");
  let webStore = openWebExecutionStore(webFile);
  f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
  let row = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: { ...configuration, args: [], agentControlMode: "web" } }, 1);
  row = webStore.bindWorktree(row, binding, 2);
  row = webStore.initializeWebExecution(row, 3);
  row = webStore.updateWebExecution(row, { sessionId: uuid(712), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
  const stopped = await stoppedWebExecution(f, webStore, row);
  webStore.beginCleanup(stopped.task, { kind: "terminal", deadline: 100 }, 8);
  const execution = stopped.task.webExecution!;
  const journal = path.join(controllerExecutionDirectory(f.root, execution.executionId), "journal.sqlite");
  const pending = path.join(`${journal}.pending-content`, "entries", "original");
  const journalBytes = Buffer.from([0, 1, 2, 255]), pendingBytes = Buffer.from([9, 8, 7, 0]);
  await mkdir(path.dirname(pending), { recursive: true });
  await writeFile(journal, journalBytes); await writeFile(pending, pendingBytes);
  f.store.saveCleanupSchedule(owner, { deadline: 100, failures: 2, nextAttemptAt: 900_000, stage: "archive", lastError: "original archive failure", archiveRepairCode: code });
  f.reopenStore(); webStore.close(); webStore = openWebExecutionStore(webFile);
  const failure = new Error("controlled archive failure"); let available = false;
  const archive = vi.fn(async (task: WebTask, journalPath: string) => {
    expect(task).toMatchObject({ ...owner, webExecution: { executionId: execution.executionId, executionGeneration: execution.executionGeneration, sessionId: uuid(712) } });
    expect(journalPath).toBe(journal);
    if (!available) throw failure;
    expect(await readFile(journal)).toEqual(journalBytes);
    expect(await readFile(pending)).toEqual(pendingBytes);
  });
  const signal = new AbortController();
  const createMaintenance = () => createWebArchiveMaintenance({ homeDirectory: f.root, serverUrl: origin, workerId, userId: uuid(2), signal: signal.signal, store: f.store, webStore, archive, probeArchive: async () => ({ kind: "attempt" }), emit: f.options.emit, monitoring });
  let maintenance = createMaintenance();
  const createBackend = () => createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: manager, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: f.options.now, request: stopped.request, archive, onArchiveFailure: maintenance.recordFailure, jobLeases: { enabled: false, retainBirthCleanup: () => () => {}, cleanupBirth: async () => {}, adopt: () => { throw new Error("Unexpected native launch ownership in this fixture."); }, retain: async () => undefined, get: async () => undefined, release: async () => {}, close: async () => {} } });
  let backend = createBackend();
  const advance = vi.fn(async (input: WebTask, signal: AbortSignal) => {
    if (input.resources.worktree !== null) return input;
    const operation = createOperation({ signal });
    try { return webStore.bindWorktree(input, await manager.prepareWorktree(f.project, input, operation), 20); }
    finally { operation.dispose(); }
  });
  if (removalFails) vi.spyOn(manager, "removeWorktree").mockRejectedValueOnce(new Error("Removal denied"));
  const [candidate] = f.candidates.splice(0); f.grants.clear();
  const create = () => {
    const { advanceResult: _advanceResult, ...backendWithAdvance } = backend;
    return createWorkerCoordinator({ ...f.options, git: manager, webStore, webBackend: { ...backendWithAdvance, advance }, archiveMaintenance: maintenance, monitoring, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
  };
  let coordinator = create();
  const identity = { ...owner, serverOrigin: origin, executionId: execution.executionId, executionGeneration: execution.executionGeneration, launchId: execution.launchId };
  try {
    await coordinator.tick();
    if (removalFails) {
      await eventually(() => expect(f.store.getCleanupSchedule(owner)).toMatchObject({ stage: "worktree-removal" }));
      expect(f.store.getArchiveBackfillSchedule(identity)).toMatchObject({ archiveRepairCode: code, legacyError: "original archive failure" });
      expect(worktreePaths(f.project.localPath)).toContain(path.normalize(binding.worktreePath));
      now += 4000; f.clock(now); await coordinator.tick();
    }
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
    expect(f.store.getTask(owner)?.status).toBe("done");
    expect(webStore.getTask(owner)?.status).toBe("done");
    expect(worktreePaths(f.project.localPath)).not.toContain(path.normalize(binding.worktreePath));
    expect(await readFile(journal)).toEqual(journalBytes); expect(await readFile(pending)).toEqual(pendingBytes);
    expect(archive).toHaveBeenCalledTimes(removalFails ? 2 : 1);
    expect(monitoring.capture().currentFailures).toEqual(expect.arrayContaining([expect.objectContaining({ component: "archive", phase: "archive-backfill", scope: expect.objectContaining({ claimId: owner.claimId }) })]));
    expect(f.events.some(event => event.kind === "session-archive-ready")).toBe(false);
    expect(f.store.getArchiveBackfillSchedule(identity)).toMatchObject({ archiveRepairCode: code, legacyError: "original archive failure", nextAttemptAt: now + 900_000 });
    await coordinator.shutdown(); await maintenance.close();
    f.reopenStore(); webStore.close(); webStore = openWebExecutionStore(webFile);
    monitoring = createMonitoringObserver({ now: f.options.now });
    maintenance = createMaintenance(); backend = createBackend(); coordinator = create();
    expect(f.store.getArchiveBackfillSchedule(identity)).toMatchObject({ archiveRepairCode: code, legacyError: "original archive failure" });
    f.candidates.push(candidate!); await coordinator.tick();
    await eventually(() => expect(advance).toHaveBeenCalledOnce());
    const successor = f.store.listTasks().find(entry => entry.taskId === owner.taskId && entry.claimId !== owner.claimId)!;
    await eventually(() => expect(webStore.getTask(successor)?.resources.worktree).not.toBeNull());
    const successorPath = webStore.getTask(successor)!.resources.worktree!.worktreePath;
    await writeFile(path.join(successorPath, "successor-marker"), "untouched");
    maintenance.request(() => false);
    await new Promise(resolve => setImmediate(resolve));
    expect(archive).toHaveBeenCalledTimes(removalFails ? 2 : 1);
    available = true; now += 900_000; f.clock(now); maintenance.request(() => false);
    await eventually(() => expect(f.events.some(event => event.kind === "session-archive-ready")).toBe(true));
    expect(archive).toHaveBeenCalledTimes(removalFails ? 3 : 2);
    expect(await readFile(path.join(successorPath, "successor-marker"), "utf8")).toBe("untouched");
    expect(monitoring.capture().currentFailures.some(item => item.component === "archive" && item.scope.kind === "claim" && item.scope.claimId === owner.claimId)).toBe(false);
  } finally { signal.abort(); await maintenance.close(); await coordinator.shutdown(); await manager.dispose(); webStore.close(); }
}, 30_000);


it("preserves independent Web work when enumeration fails after another cleanup", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(3), webStore = openWebExecutionStore(createMemoryDatabase());
  const owner = { projectId: f.project.projectId, taskId: uuid(800), claimId: uuid(801), worktreeId: uuid(802) };
  const config = { ...configuration, args: [], agentControlMode: "web" as const }, worktree = f.bind(owner);
  const healthy: WorkerProject = { projectId: uuid(11), repoUrl: "https://example.test/healthy.git", localPath: path.join(f.root, "healthy") };
  f.store.registerProject(healthy); await mkdir(healthy.localPath, { recursive: true });
  f.options.repositories.push({ project: healthy, configuration: config }); f.candidates.splice(0);
  f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
  const healthyOwner = { projectId: healthy.projectId, taskId: uuid(851), claimId: uuid(852), worktreeId: uuid(853) };
  f.grant(task(healthy.projectId, healthyOwner.taskId), { claimId: healthyOwner.claimId, worktreeId: healthyOwner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", agentControlMode: "web" });
  f.store.activateTask(f.store.registerPending({ ...healthyOwner, agent: "codex", agentControlMode: "web" }));
  webStore.register({ ...healthyOwner, project: healthy, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
  record = webStore.bindWorktree(record, worktree, 2); record = webStore.initializeWebExecution(record, 3);
  record = webStore.beginCleanup(record, { kind: "terminal", deadline: 100 }, 4);
  f.worktrees.set(owner.claimId, { owner, binding: worktree }); f.manifests.set(owner.claimId, { owner, binding: worktree });
  const cleanupEntered = Promise.withResolvers<void>(), finishCleanup = Promise.withResolvers<void>();
  const scanEntered = Promise.withResolvers<void>(), finishScan = Promise.withResolvers<void>();
  const scan = f.git.scanWorktrees.bind(f.git); let holdScan = false;
  vi.spyOn(f.git, "scanWorktrees").mockImplementation(async (...args) => { const result = await scan(...args); if (holdScan) { scanEntered.resolve(); await finishScan.promise; } return result; });
  const cleanup = vi.fn(async (value: typeof record, request: import("../../../src/commands/worker/execution-stop.js").CleanupRequest) => {
    if (request.kind !== "terminal") throw new Error("unexpected shutdown");
    request.scope.onExecutionStopped({ attempt: request.scope.attempt, observation: { kind: "not-started", owner, observedAt: 1000 } });
    cleanupEntered.resolve(); await finishCleanup.promise; f.worktrees.delete(owner.claimId);
    return { task: value, complete: true };
  });
  const advance = vi.fn(async (value: typeof record) => value);
  const coordinator = createWorkerCoordinator({ ...f.options, webStore, webBackend: { observeExecutionStop: async () => ({ kind: "not-started", owner, observedAt: 1000 }), advance, cleanup }, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
  try {
    await coordinator.tick(); await cleanupEntered.promise;
    await eventually(() => expect(advance).toHaveBeenCalled());
    f.candidates.push(task(healthy.projectId, uuid(850)));
    holdScan = true; const nextRound = coordinator.tick(); await scanEntered.promise;
    finishCleanup.resolve(); await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
    vi.spyOn(webStore, "listUnfinishedTasks").mockImplementationOnce(() => { throw new Error("web enumeration unavailable"); });
    finishScan.resolve(); await nextRound;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error", identity: expect.objectContaining(owner), error: expect.objectContaining({ message: "web enumeration unavailable" }) }));
    expect(f.store.getTask(healthyOwner)?.status).toBe("active");
    await eventually(() => expect(advance.mock.calls.length).toBeGreaterThanOrEqual(2));
  } finally { finishCleanup.resolve(); finishScan.resolve(); await coordinator.shutdown(); webStore.close(); }
});

it.each(["recover", "next-generation", "automatic-generation", "same-task", "index-schedule", "journal-schedule", "cancel", "target-disappears", "first-generation", "pending"] as const)("reconciles an original Web execution through an incomplete Git scan: %s", async scenario => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const f = await fixture(), webStore = openWebExecutionStore(path.join(f.root, "web.sqlite"));
  const stop = new AbortController(), finishVerify = Promise.withResolvers<void>();
  let disposeManager: (() => Promise<unknown>) | undefined, shutdownCoordinator: (() => Promise<unknown>) | undefined;
  let failure: unknown, failed = false;
  try {
    await mkdir(f.project.localPath, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.project.localPath, stdio: "pipe", timeout: 10_000 });
    git("init", "--initial-branch=main");
    git("-c", "user.name=Fixture", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "seed");
    git("remote", "add", "origin", f.project.repoUrl);
    const bare = path.join(f.root, "origin.git");
    execFileSync("git", ["clone", "--bare", f.project.localPath, bare], { cwd: f.root, stdio: "pipe", timeout: 10_000 });
    git("config", `url.${bare}.insteadOf`, f.project.repoUrl);
    const manager = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temp"), prepareFormat });
    disposeManager = () => manager.dispose();
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(170), worktreeId: uuid(171) };
    const sibling = { projectId: f.project.projectId, taskId: uuid(172), claimId: uuid(173), worktreeId: uuid(174) };
    const operation = createOperation(); let binding: WorktreeBinding, badBinding: WorktreeBinding;
    try { await manager.prepareRepository(f.project, operation); binding = await manager.prepareWorktree(f.project, owner, operation); badBinding = await manager.prepareWorktree(f.project, sibling, operation); }
    finally { operation.dispose(); }
    if (scenario === "same-task") {
      const manifests = createWorktreeManifestStore(binding.commonDirectory), previous = manifests.read(sibling.worktreeId)!;
      manifests.remove(previous); manifests.publish({ ...previous, taskId: owner.taskId });
    }
    const damagedPointer = path.join(badBinding.worktreePath, ".git");
    await rm(damagedPointer); await writeFile(damagedPointer, "damaged pointer\n");
    f.grant(f.candidates[0]!, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, agent: "codex", agentControlMode: "web", machine: f.options.machine, platform: "linux" });
    const local = f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
    if (scenario !== "pending") f.store.activateTask(local);
    const config = { ...configuration, toolLaunch: frozenToolLaunch() };
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
    record = webStore.bindWorktree(record, binding, 2);
    record = webStore.initializeWebExecution(record, 3);
    record = webStore.updateWebExecution(record, { sessionId: uuid(175), initialPrompt: "managed", ...(scenario === "first-generation" ? {} : { launchSubmission: "acknowledged" as const }) }, 4);
    let stopped: Awaited<ReturnType<typeof stoppedWebExecution>> | undefined;
    if (scenario !== "first-generation") {
      record = webStore.bindNativeSession(record, { source: "controller", sessionId: uuid(176) }, 5);
      const recordStopped = lifecycle.recordStoppedControllerGeneration;
      stopped = await stoppedWebExecution(f, webStore, record);
      record = stopped.task;
      const journalFile = path.join(controllerExecutionDirectory(f.root, record.webExecution!.executionId), "journal.sqlite");
      await mkdir(path.dirname(journalFile), { recursive: true });
      const journal = lifecycle.openControllerLifecycleStore(journalFile, stopped.ticket, { onMigration() {} });
      const { executionId: _executionId, claimId: _claimId, sessionId: _sessionId, executionGeneration: _generation, controllerInstanceId: _instance, ...snapshotPatch } = stopped.snapshot;
      try { journal.patchSnapshot({ ...snapshotPatch, controllerProcess: { ...snapshotPatch.controllerProcess!, jobObjectName: `Local\\Daynight-${stopped.ticket.launchId}` } }); } finally { journal.close(); }
      // Exercise the real durable Windows proof even on non-Windows test hosts;
      // process-tree observation is the controlled boundary in this fixture.
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        Object.defineProperty(process, "platform", { ...platform, value: "win32" });
        const proven = await recordStopped(journalFile, stopped.ticket, { deadline: Date.now() + 5000, jobLease: {} as never });
        expect(lifecycle.readProvenWindowsStoppedControllerGeneration(journalFile, stopped.ticket)).toEqual(proven);
      } finally { Object.defineProperty(process, "platform", platform); }
      if (scenario === "next-generation") {
        record = webStore.authorizeRecoveryRetry(record, 8);
        record = webStore.beginWebGeneration(record, stopped.snapshot, 9);
        record = webStore.pauseRecovery(record, "Original generation preparation failed.", 10);
        record = webStore.authorizeRecoveryRetry(record, 11);
      } else if (scenario === "automatic-generation") {
        record = webStore.beginRecovery(record, 8);
        record = webStore.beginWebGeneration(record, stopped.snapshot, 9);
      }
    }
    if (scenario === "index-schedule" || scenario === "journal-schedule") {
      const otherProject = { ...f.project, projectId: uuid(180), localPath: path.join(f.root, "other-project") };
      f.store.registerProject(otherProject);
      vi.mocked(f.remote.ownInventory).mockImplementation(async () => ({ tasks: [...f.grants.values()], coveredProjectIds: [owner.projectId], unavailableProjectIds: [] }));
      const other = { projectId: otherProject.projectId, taskId: owner.taskId, claimId: uuid(181), worktreeId: uuid(182) };
      if (scenario === "index-schedule") {
        f.store.completeTask(f.store.registerPending({ ...other, agent: "codex", agentControlMode: "web" }));
        f.store.saveCleanupSchedule(other, { deadline: 1000, failures: 0, nextAttemptAt: 0, stage: "observation", lastError: null });
      } else {
        let completed = webStore.register({ ...other, project: otherProject, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
        completed = webStore.beginCleanup(completed, { kind: "terminal", deadline: 1000 }, 2);
        completed = webStore.completeTask(completed, 3);
        f.store.saveCleanupSchedule(other, { deadline: 1000, failures: 0, nextAttemptAt: 0, stage: "observation", lastError: null }, completed);
      }
    }
    const scheduleReads = vi.spyOn(f.store, "listCleanupSchedules");
    const manifestReads = vi.spyOn(manager, "listWorktreeManifests");
    const verifyEntered = Promise.withResolvers<void>();
    const verify = manager.verifyWorktree.bind(manager);
    if (scenario === "cancel" || scenario === "target-disappears") vi.spyOn(manager, "verifyWorktree").mockImplementation(async (...args) => {
      const found = await verify(...args); verifyEntered.resolve();
      if (scenario === "cancel") { await finishVerify.promise; args[2].check(); }
      else await rm(binding.worktreePath, { recursive: true, force: true });
      return found;
    });
    const interruption = new Error("Second generation reached after stopped proof.");
    const prepare = vi.fn(async (value: WebTask) => {
      if (scenario === "next-generation" || scenario === "automatic-generation" || value.webExecution!.executionGeneration !== "1") throw interruption;
      return stopped!.ticket;
    });
    const launcher = { prepare, launch: vi.fn(async () => {}), refreshGrant: vi.fn() };
    const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: manager, launcher, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: f.options.now,
      ...(stopped === undefined ? {} : { request: stopped.request }), jobLeases: { enabled: false, retainBirthCleanup: () => () => {}, cleanupBirth: async () => {}, adopt: () => { throw new Error("Unexpected native launch ownership in this fixture."); }, retain: async () => undefined, get: async () => undefined, release: async () => {}, close: async () => {} } });
    const advance = vi.spyOn(backend, "advanceResult");
    const coordinator = createWorkerCoordinator({ ...f.options, git: manager, webStore, webBackend: { ...backend, cleanup: vi.fn(async value => ({ task: value, complete: true })) },
      repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, signal: stop.signal, verifyWebServer: async () => {} });
    shutdownCoordinator = () => coordinator.shutdown();
    await coordinator.tick();
    if (scenario === "cancel") { await verifyEntered.promise; stop.abort(new Error("cancel original execution")); finishVerify.resolve(); await coordinator.shutdown(); }
    else if (scenario === "recover" || scenario === "next-generation" || scenario === "automatic-generation") {
      await vi.waitFor(() => expect(f.events.some(event => event.error === interruption), f.events.map(event => `${event.kind}: ${event.message} ${event.error instanceof Error ? event.error.stack : String(event.error)}`).join("\n")).toBe(true), { timeout: 10_000, interval: 20 });
      expect(advance).toHaveBeenCalledOnce();
      expect(advance.mock.calls[0]![4]).toBe(false);
      expect(webStore.getTask(owner)?.webExecution?.executionGeneration).toBe("2");
      expect(webStore.getTask(owner)?.resources.nativeSession?.sessionId).toBe(uuid(176));
      expect(prepare).toHaveBeenCalled();
      await vi.waitFor(() => expect(f.remote.update).toHaveBeenCalledOnce(), { timeout: 10_000, interval: 20 });
    } else if (scenario === "target-disappears") {
      await verifyEntered.promise;
      await vi.waitFor(() => expect(advance).toHaveBeenCalledOnce(), { timeout: 10_000, interval: 20 });
      await vi.waitFor(() => expect(f.remote.update).toHaveBeenCalledOnce(), { timeout: 10_000, interval: 20 });
      expect(prepare).not.toHaveBeenCalled();
      await expect(access(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      if (scenario === "same-task") await vi.waitFor(() => expect(manifestReads.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 10_000, interval: 20 });
      else if (scenario === "index-schedule" || scenario === "journal-schedule") await vi.waitFor(() => expect(scheduleReads.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 10_000, interval: 20 });
      else await new Promise<void>(resolve => setImmediate(resolve));
      expect(advance).not.toHaveBeenCalled();
      expect(f.remote.update).not.toHaveBeenCalled();
      if (scenario === "pending") expect(f.store.getTask(owner)?.status).toBe("pending");
    }
    expect(f.remote.claim).not.toHaveBeenCalled();
    expect(await readFile(path.join(badBinding.worktreePath, ".git"), "utf8")).toBe("damaged pointer\n");
  } catch (error) { failed = true; failure = error; }
  finally {
    finishVerify.resolve(); stop.abort();
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [shutdownCoordinator, disposeManager, () => webStore.close()]) {
      if (cleanup === undefined) continue;
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors, "Fixture cleanup failed.");
    if (failed) throw failure;
  }
}, 30_000);
