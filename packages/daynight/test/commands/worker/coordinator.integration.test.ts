import path from "node:path";
import { execFileSync } from "node:child_process";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as launchObservation from "../../../src/commands/controller/launch-observation.js";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { ControllerIpcOutcomeUnknownError, type requestController } from "../../../src/commands/controller/local-client.js";
import type { WebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { createWebArchiveMaintenance } from "../../../src/commands/worker/web-archive-backfill.js";
import { createMonitoringObserver } from "../../../src/commands/worker/monitoring/observer.js";
import { migrateLegacyWorktrees } from "../../../src/commands/worker/worktrees/migration.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import type { WorktreeBinding } from "../../../src/commands/worker/types.js";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createWorkerGitManager, WorktreePreconditionError } from "../../../src/commands/worker/worktrees.js";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import type { ExecutionConfiguration } from "../../../src/commands/worker/types.js";
import type { LocalTask as WebTask } from "../../../src/commands/worker/backends/web-types.js";
import { configuration, createWorkerCoordinator, eventually, fixture, origin, registerWebStore, unknownStop, uuid, workerId } from "./coordinator-web-fixtures.js";

it("fences an unfinished Web record before the first reconciliation after restart", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webFile = path.join(f.root, "web.sqlite");
    const owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(700), worktreeId: uuid(702) };
    let webStore = registerWebStore(openWebExecutionStore(webFile));
    webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: { ...configuration, agentControlMode: "web" } }, 1);
    webStore.close();
    webStore = registerWebStore(openWebExecutionStore(webFile));
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
  let webStore = registerWebStore(openWebExecutionStore(path.join(f.root, "web.sqlite")));
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
    webStore.close(); webStore = registerWebStore(openWebExecutionStore(path.join(f.root, "web.sqlite")));
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
  const webStore = registerWebStore(openWebExecutionStore(path.join(f.root, "web.sqlite")));
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
    await vi.waitFor(async () => { await coordinator.tick(); expect(advance.mock.calls.length).toBeGreaterThan(advances); }, { timeout: 5000, interval: 10 });
    expect(selections).toBe(1); expect(f.remote.claim).toHaveBeenCalledOnce();
  } finally { await coordinator.shutdown(); webStore.close(); }
}, 15_000);

const prepareFormat: NonNullable<Parameters<typeof createWorkerGitManager>[0]["prepareFormat"]> = async (_project, repository, operation) => {
  await migrateLegacyWorktrees({ repositoryPath: repository.root, commonDirectory: repository.commonDirectory, operation, sources: { listSchedules: () => [], listWebTasks: () => [] } });
};
const worktreePaths = (cwd: string): string[] => execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd, encoding: "utf8", timeout: 10_000 }).split("\0").filter(field => field.startsWith("worktree ")).map(field => path.normalize(field.slice("worktree ".length)));
const stoppedWebExecution = async (f: Awaited<ReturnType<typeof fixture>>, store: WebExecutionStore, task: WebTask) => {
  const execution = task.webExecution!;
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, sessionId: execution.sessionId!, executionGeneration: execution.executionGeneration, serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, userId: task.userId!, provider: task.configuration!.agent, cwd: f.project.localPath, nativeHome: path.join(f.root, "native"), configuration: task.configuration!, initialOperationId: execution.initialOperationId, initialPrompt: "managed", resumeNativeSessionId: null, credentialFile: path.join(f.root, "grant.json"), ipcEndpoint: path.join(f.root, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  task = store.updateWebExecution(task, { ticketPath: await writeLaunchTicket(f.root, ticket) }, 6);
  const snapshot: lifecycle.ControllerSnapshot = { executionId: execution.executionId, claimId: task.claimId, sessionId: execution.sessionId!, executionGeneration: execution.executionGeneration, controllerInstanceId: execution.controllerInstanceId, lifecycle: "stopped", nativeSessionId: null, initialInputState: "confirmed", activity: "stopped", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, controllerProcess: { pid: 123, parentPid: 1, processGroupId: 123, startedAt: "birth", commandHash: "a".repeat(64) }, nativeProcesses: [], nativeStopped: true, stoppedAt: new Date().toISOString(), error: null };
  task = store.updateWebExecution(task, { controllerProcess: snapshot.controllerProcess }, 7);
  vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("stopped");
  vi.spyOn(lifecycle, "readControllerSnapshot").mockReturnValue(snapshot);
  vi.spyOn(launchObservation, "reconcileSubmittedControllerLaunch").mockImplementation(async input => ({ kind: "controller-exited", process: input.spawnProof, snapshot }));
  vi.spyOn(lifecycle, "recordStoppedControllerGeneration").mockResolvedValue(snapshot);
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  return { task, request: vi.fn<typeof requestController>().mockRejectedValue(new ControllerIpcOutcomeUnknownError("Original controller is stopped.")) };
};


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
  const webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase()));
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
  const jobLeases = { enabled: false, retain: async () => undefined, get: async () => undefined, release: async () => {}, close: async () => {} };
  const backendOptions = { homeDirectory: f.root, store: webStore, git: manager, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux" as const, buildPrompt: () => "managed", emit: () => {}, now: f.options.now, request: stopped.request, archive, jobLeases };
  const backend = createWebExecutionBackend(backendOptions);
  const [originalCandidate, healthyCandidate] = f.candidates.splice(0); f.grants.clear();
  const coordinator = createWorkerCoordinator({ ...f.options, git: manager, webStore, webBackend: { observeExecutionStop: backend.observeExecutionStop, cleanup: backend.cleanup, advance: async (task, signal) => { const operation = createOperation({ signal }); try { const binding = await manager.prepareWorktree(f.project, task, operation); return f.advance(webStore.bindWorktree(task, binding, Date.now())); } finally { operation.dispose(); } } }, monitoring, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
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
    await eventually(() => expect(f.advance).toHaveBeenCalledOnce());
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
    await eventually(() => expect(f.advance).toHaveBeenCalledTimes(2));
    const successor = f.store.listTasks().find(entry => entry.taskId === owner.taskId && entry.claimId !== owner.claimId)!;
    const successorOwner = webStore.getTask(successor)!;
    expect(successor.status).toBe("active");
    expect(successorOwner.worktreeId).not.toBe(owner.worktreeId);
    expect(successorOwner.resources.worktree!.worktreePath).not.toBe(binding.worktreePath);
    await expect(access(successorOwner.resources.worktree!.worktreePath)).resolves.toBeUndefined();
  } finally { await coordinator.shutdown(); await manager.dispose(); webStore.close(); }
}, 30_000);

it.each([
  { code: "archive_incomplete", removalFails: false },
  { code: "projection_gap", removalFails: true },
  { code: "markdown_projection_failed", removalFails: false },
] as const)("transfers a retained Web repair schedule to backfill across restart: $code, removal failure $removalFails", async ({ code, removalFails }) => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const f = await fixture(1, true, true); await f.coordinator.shutdown();
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
  let webStore = registerWebStore(openWebExecutionStore(webFile));
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
  f.reopenStore(); webStore.close(); webStore = registerWebStore(openWebExecutionStore(webFile));
  const failure = new Error("controlled archive failure"); let available = false;
  const archive = vi.fn(async (task: WebTask, journalPath: string) => {
    expect(task).toMatchObject({ ...owner, webExecution: { executionId: execution.executionId, executionGeneration: execution.executionGeneration, sessionId: uuid(712) } });
    expect(journalPath).toBe(journal);
    if (!available) throw failure;
    expect(await readFile(journal)).toEqual(journalBytes);
    expect(await readFile(pending)).toEqual(pendingBytes);
  });
  const signal = new AbortController();
  const createMaintenance = () => createWebArchiveMaintenance({ homeDirectory: f.root, serverUrl: origin, signal: signal.signal, store: f.store, webStore, archive, probeArchive: async () => ({ kind: "attempt" }), emit: f.options.emit, monitoring });
  let maintenance = createMaintenance();
  const createBackend = () => createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: manager, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: f.options.now, request: stopped.request, archive, onArchiveFailure: maintenance.recordFailure, jobLeases: { enabled: false, retain: async () => undefined, get: async () => undefined, release: async () => {}, close: async () => {} } });
  let backend = createBackend();
  if (removalFails) vi.spyOn(manager, "removeWorktree").mockRejectedValueOnce(new Error("Removal denied"));
  const [candidate] = f.candidates.splice(0); f.grants.clear();
  const create = () => createWorkerCoordinator({ ...f.options, git: manager, webStore, webBackend: { observeExecutionStop: backend.observeExecutionStop, cleanup: backend.cleanup, advance: async (task, signal) => { const operation = createOperation({ signal }); try { const binding = await manager.prepareWorktree(f.project, task, operation); return f.advance(webStore.bindWorktree(task, binding, Date.now())); } finally { operation.dispose(); } } }, archiveMaintenance: maintenance, monitoring, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
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
    f.reopenStore(); webStore.close(); webStore = registerWebStore(openWebExecutionStore(webFile));
    monitoring = createMonitoringObserver({ now: f.options.now });
    maintenance = createMaintenance(); backend = createBackend(); coordinator = create();
    expect(f.store.getArchiveBackfillSchedule(identity)).toMatchObject({ archiveRepairCode: code, legacyError: "original archive failure" });
    f.candidates.push(candidate!); await coordinator.tick();
    await eventually(() => expect(f.advance).toHaveBeenCalledOnce());
    const successor = f.store.listTasks().find(entry => entry.taskId === owner.taskId && entry.claimId !== owner.claimId)!;
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
