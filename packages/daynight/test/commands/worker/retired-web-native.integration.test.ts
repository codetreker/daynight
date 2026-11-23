import { restoreControllerJournalVersion } from "../../helpers/controller-journal-version.js";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import type { Task } from "../../../src/api/types.js";
import { ControllerIpcOutcomeUnknownError } from "../../../src/commands/controller/local-client.js";
import { controllerExecutionDirectory, controllerPayloadHash, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore, readControllerSnapshot, readHistoricalWindowsStoppedControllerGeneration, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import { stopControllerBootstrap } from "../../../src/commands/controller/launch-observation.js";
import { captureProcessProof, inspectProcessProof, stopControllerProcesses, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import { resolveControllerIpcEndpoint, resolveControllerStateDirectory } from "../../../src/commands/controller/paths.js";
import { inspectControllerJob } from "../../../src/commands/controller/windows-job.js";
import { createControllerJobLeases } from "../../../src/commands/worker/backends/controller-job-leases.js";
import { createRetiredClaimNativeCleanup } from "../../../src/commands/worker/backends/retired-claim-native.js";
import { createWebExecutionBackend } from "../../../src/commands/worker/backends/web.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import { workerOperation, type WorkerEvent } from "../../../src/commands/worker/execution.js";
import { openLifecycleStore, type LifecycleBinding } from "../../../src/commands/worker/lifecycle-store.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { createWorkerGitManager } from "../../../src/commands/worker/worktrees.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import { migrateLegacyWorktrees } from "../../../src/commands/worker/worktrees/migration.js";

const origin = "https://daynight.example";
const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const gitCommand = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });

const nativeBoundary = async (launchId: string, cwd: string) => {
  const script = `
const { spawn } = require('node:child_process');
process.on('message', () => {
  const child = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'], {
    stdio: ['ignore','ignore','ignore','ipc'], windowsHide: true, detached: process.platform === 'win32'
  });
  child.once('error', error => { throw error; });
  child.once('message', () => process.send({ pid: child.pid }));
});
process.send('ready');setInterval(()=>{},1000);
`;
  const child = spawn(process.execPath, ["-e", script], { cwd, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  const closed = once(child, "close", { signal: AbortSignal.timeout(120_000) });
  void closed.catch(() => {});
  let stderr = "";
  child.stderr!.setEncoding("utf8"); child.stderr!.on("data", chunk => { stderr += chunk; });
  let leader: ProcessProof | undefined, provider: ProcessProof | undefined;
  let closeJob: (() => void) | undefined, terminateJob: (() => void) | undefined;
  let jobReleased = false;
  const cleanup = async () => {
    const failures: unknown[] = [];
    try {
      if (!jobReleased) {
        if (terminateJob !== undefined) terminateJob();
        else if (leader !== undefined) await stopControllerProcesses(leader, provider === undefined ? [] : [provider], Date.now() + 10_000);
        else if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    } catch (error) { failures.push(error); }
    if (provider !== undefined) try {
      await stopControllerBootstrap(provider, Date.now() + 10_000);
      await expect.poll(() => inspectProcessProof(provider!), { timeout: 10_000 }).toBe("stopped");
    } catch (error) { failures.push(error); }
    try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; }
    catch (error) { failures.push(error); }
    try { closeJob?.(); } catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, `Retired claim native fixture cleanup failed: ${failures.map(String).join("; ")}`);
  };
  try {
    await once(child, "message", { signal: AbortSignal.timeout(15_000) });
    leader = await captureProcessProof(child.pid!);
    if (process.platform === "win32") {
      const koffi = await import("koffi"), kernel = koffi.load("kernel32.dll");
      const create = kernel.func("void * __stdcall CreateJobObjectW(void *attributes, str16 name)");
      const openProcess = kernel.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
      const assign = kernel.func("int __stdcall AssignProcessToJobObject(void *job, void *process)");
      const terminate = kernel.func("int __stdcall TerminateJobObject(void *job, uint32_t code)");
      const close = kernel.func("int __stdcall CloseHandle(void *handle)");
      const lastError = kernel.func("uint32_t __stdcall GetLastError()");
      const jobName = `Local\\Daynight-${launchId}`, job: unknown = create(null, jobName);
      if (job === null) throw new Error(`Fixture Job creation failed (Win32 ${lastError()}).`);
      closeJob = () => { if (close(job) === 0) throw new Error(`Fixture Job handle release failed (Win32 ${lastError()}).`); };
      terminateJob = () => { if (terminate(job, 1) === 0) throw new Error(`Fixture Job termination failed (Win32 ${lastError()}).`); };
      const handle: unknown = openProcess(0x101, 0, child.pid!);
      if (handle === null) throw new Error(`Fixture process opening failed (Win32 ${lastError()}).`);
      try { if (assign(job, handle) === 0) throw new Error(`Fixture Job assignment failed (Win32 ${lastError()}).`); }
      finally { if (close(handle) === 0) throw new Error(`Fixture process handle release failed (Win32 ${lastError()}).`); }
      leader = { ...leader, jobObjectName: jobName };
    }
    const spawned = once(child, "message", { signal: AbortSignal.timeout(15_000) }); child.send("spawn");
    const [receipt] = await spawned as [{ pid: number }]; provider = await captureProcessProof(receipt.pid);
    expect(provider.parentPid).toBe(leader.pid);
    expect(await inspectProcessProof(leader)).toBe("running"); expect(await inspectProcessProof(provider)).toBe("running");
    if (leader.jobObjectName !== undefined) {
      const members = await inspectControllerJob(leader.jobObjectName);
      expect(members).toContain(leader.pid); expect(members).toContain(provider.pid);
    } else expect(provider.processGroupId).toBe(leader.processGroupId);
    return { leader, provider, closed, stderr: () => stderr, cleanup, closeStoppedJob: () => {
      closeJob?.(); closeJob = undefined; terminateJob = undefined; jobReleased = process.platform === "win32";
    } };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Native fixture startup and cleanup failed.", { cause: error }); }
    throw error;
  }
};

const cases = [
  ...(["complete", "missing", "incomplete"] as const).flatMap(state => (["patrol", "shutdown"] as const).map(mode => ({ state, mode, recovered: false }))),
  { state: "missing" as const, mode: "patrol" as const, recovered: true },
];

it.each(cases)("cleans the real retired $state Web boundary and Git worktree during $mode (recovered: $recovered) without touching its successor", async ({ state, mode, recovered }) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/retired-web-native"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")), home = path.join(root, "home"), repository = path.join(root, "repo");
  await mkdir(home); await mkdir(repository);
  gitCommand(repository, "init", "--initial-branch=main");
  gitCommand(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
  const owner = { projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() };
  const successor = { ...owner, claimId: randomUUID(), worktreeId: randomUUID() };
  const project = { projectId: owner.projectId, repoUrl: "https://example.test/fixture.git", localPath: repository };
  gitCommand(repository, "remote", "add", "origin", project.repoUrl);
  const git = createWorkerGitManager({ temporaryDirectory: path.join(root, "git-tmp"), prepareFormat: async (_project, repo, operation) => {
    await migrateLegacyWorktrees({ repositoryPath: repo.root, commonDirectory: repo.commonDirectory, operation, sources: { listSchedules: () => [], listWebTasks: () => [] } });
  } });
  const store = openWorkerStore(path.join(root, "worker.sqlite")), webStore = openWebExecutionStore(path.join(root, "web.sqlite"));
  const leases = createControllerJobLeases();
  let original: Awaited<ReturnType<typeof nativeBoundary>> | undefined, next: Awaited<ReturnType<typeof nativeBoundary>> | undefined;
  let previous: Awaited<ReturnType<typeof nativeBoundary>> | undefined;
  let previousTicket: ControllerLaunchTicket | undefined;
  let coordinator: ReturnType<typeof createWorkerCoordinator> | undefined;
  let lifecycle: ReturnType<typeof openLifecycleStore> | undefined;
  let failure: unknown, failed = false;
  try {
    store.registerProject(project);
    await workerOperation(operation => git.prepareRepository(project, operation));
    const branch = `daynight/${owner.taskId}`, worktreePath = path.join(repository, ".worktrees", "daynight", owner.worktreeId);
    const successorPath = path.join(repository, ".worktrees", "daynight", successor.worktreeId);
    gitCommand(repository, "worktree", "add", "-b", branch, worktreePath);
    gitCommand(repository, "worktree", "add", "--force", successorPath, branch);
    const manifests = createWorktreeManifestStore(path.join(repository, ".git"));
    manifests.publish({ schemaVersion: 1, ...owner, directoryName: owner.worktreeId });
    manifests.publish({ schemaVersion: 1, ...successor, directoryName: successor.worktreeId });
    const sentinel = path.join(successorPath, "successor.txt"); await writeFile(sentinel, "successor survives\n");
    await writeFile(path.join(worktreePath, "original.txt"), "old uncommitted work\n");
    const workerId = randomUUID(), userId = randomUUID(), nativeSessionId = randomUUID();
    let lifecycleBinding: LifecycleBinding | undefined;
    if (state === "incomplete" || recovered) {
      lifecycle = openLifecycleStore({ file: path.join(root, "lifecycle.sqlite"), identity: { serverOrigin: origin, workerId, userId }, allowCreate: true });
      const instanceId = randomUUID(), bound = lifecycle.bindInstance({ instanceId, instanceEpoch: "1", intentVersion: "1", desired: "disabled" });
      lifecycleBinding = { serverOrigin: origin, workerId, userId, instanceId, instanceEpoch: "1", intentVersion: "1", localEpoch: bound.localEpoch, scopeGeneration: bound.scopeGeneration };
    }
    const retainBoundary = (ticket: ControllerLaunchTicket, boundary: Awaited<ReturnType<typeof nativeBoundary>>) => {
      if (lifecycle === undefined || lifecycleBinding === undefined) return;
      const identity = { ...owner, launchId: ticket.launchId, executionId: ticket.executionId, sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration,
        controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, journalFile: path.join(controllerExecutionDirectory(home, ticket.executionId), "journal.sqlite"),
        storageStateDirectory: resolveControllerStateDirectory(home), ticketHash: controllerPayloadHash(ticket) };
      lifecycle.importResource({ binding: lifecycleBinding, resourceId: ticket.launchId, ownerKind: "controller", identity: { ...identity, kind: "launch" },
        operationId: ticket.launchId, stage: "running", processProof: JSON.parse(JSON.stringify(boundary.leader)) });
      lifecycle.importResource({ binding: lifecycleBinding, resourceId: ticket.controllerInstanceId, ownerKind: "controller", identity: { ...identity, kind: "provider" },
        operationId: ticket.launchId, stage: "running", processProof: JSON.parse(JSON.stringify(boundary.provider)) });
    };
    store.activateTask(store.registerPending({ ...owner, agent: "codex", agentControlMode: "web", sessionId: nativeSessionId }));
    let task = state === "missing" ? null : webStore.register({ ...owner, project, serverOrigin: origin, workerId, userId, configuration }, 1);
    if (task !== null) task = webStore.bindWorktree(task, { repositoryPath: repository, commonDirectory: path.join(repository, ".git"), worktreePath, branch }, 2);
    if (state === "complete") {
      task = webStore.bindNativeSession(task!, { source: "controller", sessionId: nativeSessionId }, 3);
      task = webStore.initializeWebExecution(task, 4);
    }
    if (state === "missing") expect(webStore.getTask(owner)).toBeNull();
    if (state === "incomplete") expect(webStore.getTask(owner)).toMatchObject({ configuration, webExecution: null });
    const execution = task?.webExecution ?? { launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: recovered ? "2" : "1", initialOperationId: randomUUID() };
    original = await nativeBoundary(execution.launchId, worktreePath); next = await nativeBoundary(randomUUID(), successorPath);
    const sessionId = randomUUID();
    if (state === "complete") task = webStore.updateWebExecution(task!, { sessionId, initialPrompt: "managed", launchSubmission: "acknowledged", controllerProcess: original.leader, nativeProcesses: [original.provider] }, 5);
    const ticket: ControllerLaunchTicket = { schemaVersion: lifecycleBinding === undefined ? 1 : 2, ...(lifecycleBinding === undefined ? {} : { lifecycleBinding }), launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId,
      sessionId, executionGeneration: execution.executionGeneration, serverOrigin: origin, ...owner, workerId, userId, provider: "codex", cwd: worktreePath, nativeHome: path.join(home, "native"), configuration,
      initialOperationId: execution.initialOperationId, initialPrompt: "managed", resumeNativeSessionId: nativeSessionId, credentialFile: path.join(home, "grant.json"),
      ipcEndpoint: resolveControllerIpcEndpoint(home, execution.launchId), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
    const ticketPath = await writeLaunchTicket(home, ticket);
    if (state === "complete") task = webStore.updateWebExecution(task!, { ticketPath }, 6);
    const journalPath = path.join(controllerExecutionDirectory(home, execution.executionId), "journal.sqlite"); await mkdir(path.dirname(journalPath), { recursive: true });
    if (recovered) {
      const launchId = randomUUID();
      previousTicket = { ...ticket, launchId, executionGeneration: "1", controllerInstanceId: randomUUID(), initialOperationId: randomUUID(), resumeNativeSessionId: null,
        ipcEndpoint: resolveControllerIpcEndpoint(home, launchId) };
      previous = await nativeBoundary(launchId, worktreePath); await writeLaunchTicket(home, previousTicket);
      const oldJournal = openControllerLifecycleStore(journalPath, previousTicket);
      oldJournal.patchSnapshot({ controllerProcess: previous.leader, nativeProcesses: [previous.provider], nativeSessionId, lifecycle: "working", activity: "working", nativeStopped: false, stoppedAt: null }); oldJournal.close();
      retainBoundary(previousTicket, previous);
      const deadline = Date.now() + 30_000, lease = await leases.retain(launchId, previous.leader, deadline);
      await stopControllerProcesses(previous.leader, [previous.provider], deadline, lease);
      await recordStoppedControllerGeneration(journalPath, previousTicket, { deadline, ...(lease === undefined ? {} : { jobLease: lease }) });
      await leases.release(launchId); await previous.closed;
      expect(await inspectProcessProof(previous.provider)).toBe("stopped");
      if (previous.leader.jobObjectName !== undefined) expect(await inspectControllerJob(previous.leader.jobObjectName)).toEqual([]);
      previous.closeStoppedJob();
    }
    const journal = openControllerLifecycleStore(journalPath, ticket), nativeProcesses = state === "missing" && mode === "patrol" && !recovered ? [] : [original.provider];
    journal.patchSnapshot({ controllerProcess: original.leader, nativeProcesses, nativeSessionId, lifecycle: "working", activity: "working", nativeStopped: false, stoppedAt: null }); journal.close();
    if (state === "missing" && mode === "patrol" && !recovered) {
      const retained = new Database(journalPath);
      try {
        restoreControllerJournalVersion(retained, 16);
        retained.prepare("UPDATE execution SET owner_pid=? WHERE id=1").run(original.leader.pid);
        expect(retained.pragma("user_version", { simple: true })).toBe(16);
      } finally { retained.close(); }
      expect(await inspectProcessProof(original.leader)).toBe("running");
    }
    retainBoundary(ticket, original);
    if (process.platform === "win32" && previousTicket !== undefined) expect(readHistoricalWindowsStoppedControllerGeneration(journalPath, previousTicket, Date.now() + 5000)).toMatchObject({
      executionGeneration: "1", lifecycle: "stopped", nativeStopped: true, controllerProcess: previous!.leader, nativeProcesses: [previous!.provider] });
    const current: Task = { type: "task", parentId: null, id: owner.taskId, projectId: owner.projectId, title: "successor", description: "", tags: [], status: "in_progress", allowAgents: true, assignedTo: userId, requiredPlatform: null,
      startedAt: new Date().toISOString(), completedAt: null, cancelledAt: null, version: 2n, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false,
      properties: { worker: { claimId: successor.claimId, workerId: randomUUID(), userId, state: "active", machine: { id: randomUUID(), name: "successor" }, platform, agent: "codex", agentControlMode: "web", worktreeId: successor.worktreeId, phase: "executing", nativeSessionId: randomUUID(), claimedAt: new Date().toISOString() } } };
    const remote = { serverOrigin: origin, currentUserId: vi.fn(async () => userId), readTask: vi.fn(async () => current),
      ownInventory: vi.fn(async () => ({ tasks: [], coveredProjectIds: [owner.projectId], unavailableProjectIds: [] })), candidates: vi.fn(async function* () {}) } as unknown as WorkerRemote;
    const requests = vi.fn().mockRejectedValue(new ControllerIpcOutcomeUnknownError("Original IPC is unavailable."));
    const webBackend = createWebExecutionBackend({ homeDirectory: home, store: webStore, git, jobLeases: leases, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform, buildPrompt: () => "managed", emit: () => {}, now: Date.now, request: requests });
    const retiredNativeCleanup = createRetiredClaimNativeCleanup({ homeDirectory: home, identity: { serverOrigin: origin, workerId, userId }, jobLeases: leases, ...(lifecycle === undefined ? {} : { lifecycle }) });
    const events: WorkerEvent[] = [], verifyWebUnregistered = vi.fn(async () => { throw new Error("Session registration must not gate retired cleanup."); });
    coordinator = createWorkerCoordinator({ store, webStore, webBackend, retiredNativeCleanup, git, remote, serverOrigin: origin, workerId, userId, platform, machine: { id: randomUUID(), name: "fixture" }, repositories: [{ project, configuration }],
      globalConfiguration: configuration, maxConcurrent: 2, preferPlatformSpecificTasks: false, verifyWebUnregistered, emit: event => events.push(event) });
    if (mode === "shutdown") expect(await coordinator.shutdown({ deadline: Date.now() + 30_000 })).toBe(true);
    else { await coordinator.tick(); await expect.poll(() => store.getTask(owner)?.status, { timeout: 30_000 }).toBe("done"); }
    expect(await inspectProcessProof(original.leader)).toBe("stopped"); expect(await inspectProcessProof(original.provider)).toBe("stopped"); await original.closed;
    if (original.leader.jobObjectName !== undefined) expect(await inspectControllerJob(original.leader.jobObjectName)).toEqual([]);
    expect(readControllerSnapshot(journalPath)).toMatchObject({ lifecycle: "stopped", nativeStopped: true, controllerProcess: original.leader, nativeProcesses });
    if (process.platform === "win32") expect(readControllerSnapshot(journalPath)?.windowsJobStopProof).toBeDefined();
    if (state === "missing" && mode === "patrol" && !recovered) {
      const upgraded = new Database(journalPath, { readonly: true });
      try { expect(upgraded.pragma("user_version", { simple: true })).toBe(18); }
      finally { upgraded.close(); }
    }
    await expect(access(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    const registered = gitCommand(repository, "worktree", "list", "--porcelain"); expect(registered).not.toContain(owner.worktreeId); expect(registered).toContain(successor.worktreeId);
    expect(await readFile(sentinel, "utf8")).toBe("successor survives\n");
    expect(await inspectProcessProof(next.leader)).toBe("running"); expect(await inspectProcessProof(next.provider)).toBe("running");
    expect(store.getTask(owner)?.status).toBe("done"); expect(store.getCleanupSchedule(owner)).toBeNull();
    if (lifecycle !== undefined) {
      expect(lifecycle.listResources()).toHaveLength(recovered ? 4 : 2);
      for (const resource of lifecycle.listResources()) expect(resource).toMatchObject({ stage: "stopped", saveState: "durable", error: null, stopProof: { boundaryEmpty: true } });
    }
    expect(verifyWebUnregistered).not.toHaveBeenCalled(); expect(events.filter(event => event.kind === "cleanup-error")).toEqual([]);
    expect(original.stderr()).toBe(""); expect(next.stderr()).toBe("");
  } catch (error) { failed = true; failure = error; }
  finally {
    const errors: unknown[] = [];
    for (const cleanup of [async () => { await coordinator?.shutdown({ deadline: Date.now() + 15_000 }); }, async () => { await previous?.cleanup(); }, async () => { await original?.cleanup(); }, async () => { await next?.cleanup(); }, () => leases.close(), () => git.dispose(), async () => { lifecycle?.close(); webStore.close(); store.close(); }, () => rm(root, { recursive: true, force: true })])
      try { await cleanup(); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(failed ? [failure, ...errors] : errors, "Retired Web native acceptance cleanup failed.", failed ? { cause: failure } : undefined);
  }
  if (failed) throw failure;
}, 90_000);

it("stops every retained real generation without a journal and retries from durable lifecycle evidence after releasing Jobs", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/retired-web-native"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "generations-")), home = path.join(root, "home"); await mkdir(home);
  const owner = { projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() };
  const identity = { serverOrigin: origin, workerId: randomUUID(), userId: randomUUID() };
  const lifecycle = openLifecycleStore({ file: path.join(root, "lifecycle.sqlite"), identity, allowCreate: true }), leases = createControllerJobLeases();
  const instanceId = randomUUID(), bound = lifecycle.bindInstance({ instanceId, instanceEpoch: "1", intentVersion: "1", desired: "disabled" });
  const binding: LifecycleBinding = { ...identity, instanceId, instanceEpoch: "1", intentVersion: "1", localEpoch: bound.localEpoch, scopeGeneration: bound.scopeGeneration };
  const executionId = randomUUID(), sessionId = randomUUID(), journalFile = path.join(controllerExecutionDirectory(home, executionId), "journal.sqlite");
  const boundaries: Awaited<ReturnType<typeof nativeBoundary>>[] = [], tickets: { file: string; contents: string }[] = [];
  let failure: unknown, failed = false;
  try {
    for (const executionGeneration of ["1", "2"]) {
      const launchId = randomUUID(), boundary = await nativeBoundary(launchId, root); boundaries.push(boundary);
      const ticket: ControllerLaunchTicket = { schemaVersion: 2, lifecycleBinding: binding, ...identity, ...owner, launchId, executionId, sessionId, executionGeneration,
        controllerId: randomUUID(), controllerInstanceId: randomUUID(), provider: "codex", cwd: root, nativeHome: path.join(home, "native"), configuration,
        initialOperationId: randomUUID(), initialPrompt: "managed", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"),
        ipcEndpoint: resolveControllerIpcEndpoint(home, launchId), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
      const file = await writeLaunchTicket(home, ticket); tickets.push({ file, contents: await readFile(file, "utf8") });
      const resourceIdentity = { ...owner, launchId, executionId, sessionId, executionGeneration, controllerId: ticket.controllerId,
        controllerInstanceId: ticket.controllerInstanceId, journalFile, storageStateDirectory: resolveControllerStateDirectory(home), ticketHash: controllerPayloadHash(ticket) };
      lifecycle.importResource({ binding, resourceId: launchId, ownerKind: "controller", identity: { ...resourceIdentity, kind: "launch" },
        operationId: launchId, stage: "running", processProof: JSON.parse(JSON.stringify(boundary.leader)) });
      lifecycle.importResource({ binding, resourceId: ticket.controllerInstanceId, ownerKind: "controller", identity: { ...resourceIdentity, kind: "provider" },
        operationId: launchId, stage: "running", processProof: JSON.parse(JSON.stringify(boundary.provider)) });
    }
    const adapter = createRetiredClaimNativeCleanup({ homeDirectory: home, identity, jobLeases: leases, lifecycle });
    const inventory = await workerOperation(operation => adapter.locate([owner], operation)), entry = [...inventory.values()][0]!;
    if ("error" in entry) throw entry.error;
    expect(entry.located.controllers).toHaveLength(2);
    await expect(access(journalFile)).rejects.toMatchObject({ code: "ENOENT" });
    const request = () => ({ deadline: Date.now() + 30_000, signal: AbortSignal.timeout(30_000) });
    const clearance = await adapter.stop(entry.located, request());
    expect(clearance).toMatchObject({ target: owner, owners: [owner], inventoryComplete: true, resourcesCleared: true });
    expect(clearance.stoppedExecutions.map(item => item.executionGeneration).sort()).toEqual(["1", "2"]);
    for (const boundary of boundaries) {
      expect(await inspectProcessProof(boundary.leader)).toBe("stopped"); expect(await inspectProcessProof(boundary.provider)).toBe("stopped"); await boundary.closed;
      if (boundary.leader.jobObjectName !== undefined) expect(await inspectControllerJob(boundary.leader.jobObjectName)).toEqual([]);
      boundary.closeStoppedJob();
    }
    const stopped = lifecycle.listResources(); expect(stopped).toHaveLength(4);
    for (const resource of stopped) expect(resource).toMatchObject({ stage: "stopped", saveState: "durable", error: null, stopProof: { boundaryEmpty: true } });
    expect((await adapter.stop(entry.located, request())).stoppedExecutions).toEqual(clearance.stoppedExecutions);
    expect(lifecycle.listResources()).toEqual(stopped);
    for (const ticket of tickets) expect(await readFile(ticket.file, "utf8")).toBe(ticket.contents);
    await expect(access(journalFile)).rejects.toMatchObject({ code: "ENOENT" });
  } catch (error) { failed = true; failure = error; }
  finally {
    const errors: unknown[] = [];
    for (const cleanup of [...boundaries.map(boundary => () => boundary.cleanup()), () => leases.close(), () => lifecycle.close(), () => rm(root, { recursive: true, force: true })])
      try { await cleanup(); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(failed ? [failure, ...errors] : errors, "Retained generation native acceptance cleanup failed.", failed ? { cause: failure } : undefined);
  }
  if (failed) throw failure;
}, 90_000);
