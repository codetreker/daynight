import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { createWebExecutionBackend } from "../../../src/commands/worker/backends/web.js";
import type { LocalTask } from "../../../src/commands/worker/backends/web-types.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as launchTickets from "../../../src/commands/controller/launch-ticket.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { controllerExecutionDirectory } from "../../../src/commands/controller/launch-ticket.js";
import { ControllerIpcOutcomeUnknownError, type requestController } from "../../../src/commands/controller/local-client.js";
import { createWebBackendFixtures } from "./web-backend.fixtures.js";
import { readTerminationPending, withTerminationDomain, withTerminationDomainCut } from "../../../src/commands/session-termination/domain.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { recoverPendingWebClosure } from "../../../src/commands/worker/backends/web-termination-recovery.js";

const { children, stores, fixture, cleanupSource, recoveryFixture } = createWebBackendFixtures("file");

const proofPlatforms = process.platform === "win32" ? ["host"] : ["host", "win32"];
it.each(proofPlatforms.flatMap(platform => [false, true].map(committed => ({ platform, committed }))))("reconciles an original pending Web closure after restart ($platform, closure committed=$committed)", async ({ platform, committed }) => {
  const f = await fixture();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  if (platform === "win32") Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
  try {
  let task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree(f.identity, f.identity, {} as never), 2);
  const source = await cleanupSource(f, task);
  source.saved.mockRestore(); vi.mocked(lifecycle.recordStoppedControllerGeneration).mockRestore();
  const journalFile = path.join(controllerExecutionDirectory(f.home, source.ticket.executionId), "journal.sqlite");
  const journal = lifecycle.openControllerLifecycleStore(journalFile, source.ticket, { onMigration: () => {} });
  const controller = process.platform === "win32" ? { ...source.snapshot.controllerProcess!, processGroupId: null, jobObjectName: `Local\\Daynight-${source.ticket.launchId}` } : source.snapshot.controllerProcess!;
  const lease = {} as ControllerJobLease;
  journal.patchSnapshot({ controllerProcess: controller, nativeSessionId: randomUUID() });
  journal.close();
  const stopped = await lifecycle.recordStoppedControllerGeneration(journalFile, source.ticket, { jobLease: lease });
  expect(source.stopped).toHaveBeenCalledWith(controller, [], undefined, lease);
  if (process.platform === "win32") lifecycle.validateWindowsControllerStopProof(stopped, source.ticket, launchTickets.controllerPayloadHash(source.ticket));
  task = f.store.beginCleanup(source.task, { kind: "terminal", deadline: 100 }, 8);
  const directory = path.join(resolveWorkerPaths(f.home).workerDirectory, "termination-domain");
  const closureKey = `web/${task.projectId}/${task.taskId}/${task.claimId}/${source.ticket.sessionId}`;
  let originalSequence = "";
  await withTerminationDomain(directory, async domain => {
    f.store.bindTerminationDomain(task, domain.domainId);
    f.store.recordTerminationStop(source.ticket, stopped);
    originalSequence = domain.beginClosure(closureKey);
    if (committed) f.store.freezeTerminationClosure(task, domain.domainId, originalSequence);
  }, { pendingKey: closureKey });
  expect(readTerminationPending(directory)).toEqual({ key: closureKey, sequence: originalSequence });
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = openWebExecutionStore(path.join(f.home, "worker.sqlite")); stores.push(reopened);
  await expect(recoverPendingWebClosure(f.home, reopened, { serverOrigin: task.serverOrigin, workerId: randomUUID() }, new AbortController().signal)).rejects.toThrow(/conflicts/);
  expect(readTerminationPending(directory)).toEqual({ key: closureKey, sequence: originalSequence });
  expect(await recoverPendingWebClosure(f.home, reopened, { serverOrigin: task.serverOrigin, workerId: task.workerId }, new AbortController().signal)).toBe(true);
  const closure = reopened.readTerminationClosure(task)!;
  expect(closure).toMatchObject({ sequence: originalSequence, highestExecutionGeneration: "1", launchesSettled: true, runs: [{ launchId: source.ticket.launchId, snapshot: { nativeStopped: true } }] });
  expect(readTerminationPending(directory)).toBeNull();
  expect(reopened.listTerminationInventory().find(item => item.claimId === task.claimId)).toMatchObject({ closure, launches: [{ launchId: source.ticket.launchId, stopProof: { stoppedSnapshotHash: expect.any(String) } }] });
  expect(() => reopened.initializeWebExecution(task, 9)).toThrow(/closed/);
  } finally { Object.defineProperty(process, "platform", originalPlatform); }
});

it.each(proofPlatforms)("joins two original Web generations after restart and orders closure after a prepared cut (%s)", async platform => {
  const f = await fixture();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  if (platform === "win32") Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
  try {
  let task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree(f.identity, f.identity, {} as never), 2);
  const nativeId = randomUUID(), sessionId = randomUUID();
  task = f.store.bindNativeSession(task, { source: "controller", sessionId: nativeId }, 3);
  task = f.store.initializeWebExecution(task, 4);
  task = f.store.updateWebExecution(task, { sessionId, initialPrompt: "original", launchSubmission: "unknown" }, 5);
  const directory = path.join(resolveWorkerPaths(f.home).workerDirectory, "termination-domain");
  const domainId = await withTerminationDomain(directory, async domain => { f.store.bindTerminationDomain(task, domain.domainId); return domain.domainId; });
  const ticketFor = (record: LocalTask): ControllerLaunchTicket => {
    const execution = record.webExecution!;
    return { schemaVersion: 1, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, sessionId, executionGeneration: execution.executionGeneration, serverOrigin: record.serverOrigin, projectId: record.projectId, taskId: record.taskId, claimId: record.claimId, workerId: record.workerId, worktreeId: record.worktreeId, userId: record.userId!, terminationDomain: { directory, domainId }, provider: "codex", cwd: f.home, nativeHome: path.join(f.home, ".native"), configuration: record.configuration!, initialOperationId: execution.initialOperationId, initialPrompt: "original", resumeNativeSessionId: nativeId, credentialFile: path.join(f.home, "grant.json"), ipcEndpoint: path.join(f.home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date(0).toISOString() };
  };
  const first = ticketFor(task), file = path.join(controllerExecutionDirectory(f.home, first.executionId), "journal.sqlite");
  await mkdir(path.dirname(file), { recursive: true });
  await launchTickets.writeLaunchTicket(f.home, first);
  const processFor = (ticket: ControllerLaunchTicket) => ({ pid: 987, parentPid: 1, processGroupId: process.platform === "win32" ? null : 987, startedAt: "original", commandHash: "a".repeat(64), ...(process.platform === "win32" ? { jobObjectName: `Local\\Daynight-${ticket.launchId}` } : {}) });
  const firstProcess = processFor(first), lease = {} as ControllerJobLease;
  const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  let journal = lifecycle.openControllerLifecycleStore(file, first, { onMigration: () => {} });
  journal.patchSnapshot({ controllerProcess: firstProcess, nativeSessionId: nativeId }); journal.close();
  const firstStopped = await lifecycle.recordStoppedControllerGeneration(file, first, { jobLease: lease });
  expect(confirm).toHaveBeenCalledWith(firstProcess, [], undefined, lease);
  if (process.platform === "win32") lifecycle.validateWindowsControllerStopProof(firstStopped, first, launchTickets.controllerPayloadHash(first));
  f.store.recordTerminationStop(first, firstStopped);
  task = await withTerminationDomain(directory, async () => f.store.beginWebGeneration(task, firstStopped, 6), { expectedDomainId: domainId });
  const second = ticketFor(task);
  await launchTickets.writeLaunchTicket(f.home, second);
  const secondProcess = processFor(second);
  task = f.store.updateWebExecution(task, { launchSubmission: "unknown", controllerProcess: secondProcess }, 7);
  journal = lifecycle.openControllerLifecycleStore(file, second, { onMigration: () => {} });
  expect(journal.getSnapshot().controlsRevisionFloor).toBe("0");
  journal.patchSnapshot({ controllerProcess: secondProcess, nativeSessionId: nativeId }); journal.close();
  task = f.store.beginCleanup(task, { kind: "terminal", deadline: 100 }, 8);
  const earlyLauncher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn(), joinExecution: vi.fn(async () => {}) };
  const earlyBackend = createWebExecutionBackend({ homeDirectory: f.home, workerId: task.workerId, serverOrigin: task.serverOrigin, store: f.store, git: f.git, launcher: earlyLauncher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 50 });
  await earlyBackend.reconcileTermination(task, new AbortController().signal);
  expect(f.store.readTerminationClosure(task)).toBeNull();
  const activationId = randomUUID();
  await withTerminationDomainCut(directory, async domain => { domain.prepare(activationId); }, { expectedDomainId: domainId });
  const secondStopped = await lifecycle.recordStoppedControllerGeneration(file, second, { jobLease: lease });
  expect(confirm).toHaveBeenCalledWith(secondProcess, [], undefined, lease);
  if (process.platform === "win32") lifecycle.validateWindowsControllerStopProof(secondStopped, second, launchTickets.controllerPayloadHash(second));
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = openWebExecutionStore(path.join(f.home, "worker.sqlite")); stores.push(reopened);
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn(), joinExecution: vi.fn(async () => {}) };
  const backend = createWebExecutionBackend({ homeDirectory: f.home, workerId: task.workerId, serverOrigin: task.serverOrigin, store: reopened, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 50 });
  const wrongWorker = createWebExecutionBackend({ homeDirectory: f.home, workerId: randomUUID(), serverOrigin: task.serverOrigin, store: reopened, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 50 });
  await expect(wrongWorker.reconcileTermination(task, new AbortController().signal)).rejects.toThrow(/conflicts/);
  expect(launcher.joinExecution).not.toHaveBeenCalled();
  await expect(backend.reconcileTermination(task, new AbortController().signal)).rejects.toThrow(/prepared policy activation/);
  expect(reopened.readTerminationClosure(task)).toBeNull();
  await withTerminationDomainCut(directory, async domain => { domain.settle(activationId); }, { expectedDomainId: domainId });
  await rm(launchTickets.controllerTicketPath(f.home, second.launchId));
  const db = new Database(path.join(f.home, "worker.sqlite"));
  db.prepare("UPDATE executions SET data=json_set(data,'$.webExecution.initialPrompt',42)").run(); db.close();
  await backend.reconcileTermination(task, new AbortController().signal);
  const closure = reopened.readTerminationClosure(task)!;
  expect(closure).toMatchObject({ highestExecutionGeneration: "2", sequence: "2", runs: [{ launchId: first.launchId }, { launchId: second.launchId, snapshot: { controlsRevisionFloor: "0" } }] });
  expect(closure.launches).toHaveLength(2);
  const rawDb = new Database(path.join(f.home, "worker.sqlite"));
  const original = (rawDb.prepare("SELECT value FROM termination_closures").get() as { value: string }).value;
  for (const corrupt of [original.replace('"domainId":', '"\\u0064omainId":"' + closure.domainId + '","domainId":'), original.replace('{', '{"extra":"\\ud800",')]) {
    rawDb.prepare("UPDATE termination_closures SET value=?").run(corrupt);
    expect(() => reopened.readTerminationClosure(task)).toThrow();
  }
  rawDb.prepare("UPDATE termination_closures SET value=?").run(original);
  const row = rawDb.prepare("SELECT generation,stop_proof FROM termination_launches WHERE generation='1'").get() as { generation: string; stop_proof: string };
  const duplicate = row.stop_proof.replace('"ticketHash":', '"\\u0074icketHash":"' + closure.runs[0]!.ticketHash + '","ticketHash":');
  rawDb.prepare("UPDATE termination_launches SET stop_proof=? WHERE generation=?").run(duplicate, row.generation);
  expect(() => reopened.readTerminationClosure(task)).toThrow();
  expect(reopened.listTerminationInventory().find(item => item.claimId === task.claimId)?.error).toBeInstanceOf(Error);
  rawDb.close();
  } finally { Object.defineProperty(process, "platform", originalPlatform); }
});

it.each(["valid", "missing", "generation", "process"] as const)("Web orderly recovery after Worker restart requires committed Windows Job proof (%s)", async kind => {
  const f = await fixture("codex", 0);
  let task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree(f.identity, f.identity, {} as never), 2);
  task = f.store.bindNativeSession(task, { source: "controller", sessionId: randomUUID() }, 3);
  const source = await cleanupSource(f, task);
  const spawnProof = { pid: 987, parentPid: 12, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64) };
  const controller = { ...spawnProof, jobObjectName: `Local\\Daynight-${source.ticket.launchId}` };
  task = f.store.updateWebExecution(source.task, { controllerProcess: spawnProof }, 6);
  f.store.beginCleanup(task, { kind: "shutdown", deadline: 10 }, 7); task = f.store.clearShutdown(task, 8);
  source.saved.mockRestore(); vi.mocked(lifecycle.recordStoppedControllerGeneration).mockRestore();
  const file = path.join(controllerExecutionDirectory(f.home, source.ticket.executionId), "journal.sqlite");
  await mkdir(path.dirname(file), { recursive: true });
  const journal = lifecycle.openControllerLifecycleStore(file, source.ticket, { onMigration: () => {} });
  journal.patchSnapshot({ controllerProcess: controller, nativeSessionId: task.resources.nativeSession!.sessionId, lifecycle: "ready", error: null }); journal.close();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await lifecycle.recordStoppedControllerGeneration(file, source.ticket, { deadline: Date.now() + 5000, jobLease: {} as never });
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const reopened = openWebExecutionStore(path.join(f.home, "worker.sqlite")); stores.push(reopened);
    if (kind !== "valid") {
      const db = new Database(file), row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }, value = JSON.parse(row.snapshot);
      if (kind === "missing") delete value.windowsJobStopProof;
      if (kind === "generation") value.executionGeneration = "2";
      if (kind === "process") value.controllerProcess.commandHash = "b".repeat(64);
      db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(value)); db.close();
    }
    const leases = { enabled: true, retain: vi.fn(async () => undefined), get: vi.fn(async () => undefined), release: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const launcher = { prepare: vi.fn(async (record: LocalTask) => ({ ...source.ticket, launchId: record.webExecution!.launchId, executionGeneration: record.webExecution!.executionGeneration, controllerInstanceId: record.webExecution!.controllerInstanceId })), launch: vi.fn(async (_record: LocalTask, _ticket: ControllerLaunchTicket, _signal: AbortSignal) => {}), refreshGrant: vi.fn(async () => {}) };
    source.request.mockImplementation(async ticket => { if (ticket.executionGeneration === "1") throw new ControllerIpcOutcomeUnknownError("Original controller exited"); return { requestId: randomUUID(), ok: true, snapshot: { ...source.snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "ready", nativeStopped: false, stoppedAt: null, error: null } }; });
    source.stopped.mockClear();
    const backend = createWebExecutionBackend({ homeDirectory: f.home, store: reopened, git: f.git, jobLeases: leases, launcher, platform: "windows", buildPrompt: () => "managed", emit: () => {}, now: () => 20, request: source.request });
    const result = await backend.advance(reopened.getTask(task)!, new AbortController().signal).catch(error => error);
    if (kind === "valid") { expect(result.webExecution.executionGeneration).toBe("2"); expect(launcher.launch).toHaveBeenCalledTimes(2); expect(launcher.launch.mock.calls[1]![0].webExecution!.executionGeneration).toBe("2"); }
    else { expect(reopened.getTask(task)!.webExecution!.executionGeneration).toBe("1"); expect(launcher.launch).not.toHaveBeenCalled(); }
    expect(source.stopped).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, "platform", platform); }
});

it("retains a single retry across starting, store reopen, and later native failure below the ordinary budget", async () => {
  const f = await recoveryFixture(5);
  f.store.pauseRecovery(f.task, "Execution failure threshold reached.", 8);
  const authorized = f.store.authorizeRecoveryRetry(f.task, 9);
  f.request.mockImplementationOnce(async ticket => ({ requestId: randomUUID(), ok: true, snapshot: { ...f.snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "starting", activity: "initializing", nativeStopped: false, stoppedAt: null, error: null } }));
  const starting = await f.backend.advance(authorized, new AbortController().signal);
  expect(starting.recovery).toEqual({ count: 3, pauseReason: null, retryAuthorized: true });
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = openWebExecutionStore(path.join(f.home, "worker.sqlite")); stores.push(reopened);
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: reopened, git: f.git, launcher: f.launcher, platform: "macos", buildPrompt: vi.fn(), emit: () => {}, now: () => 30, request: f.request });
  f.request.mockRejectedValue(new Error("The retried generation stopped before becoming ready."));
  await expect(backend.advance(reopened.getTask(f.task)!, new AbortController().signal)).rejects.toThrow("stopped before becoming ready");
  expect(reopened.getTask(f.task)?.recovery).toEqual({ count: 3, pauseReason: "The retried generation stopped before becoming ready.", retryAuthorized: false });
  expect(reopened.getTask(f.task)?.webExecution?.executionGeneration).toBe("2");
});

it("retries the same unsubmitted generation after launch preparation fails and the Worker store reopens", async () => {
  const f = await recoveryFixture();
  f.store.beginRecovery(f.task, 8);
  const authorized = f.store.authorizeRecoveryRetry(f.task, 9);
  f.launcher.prepare.mockRejectedValueOnce(new Error("Preparation temporarily unavailable."));
  await expect(f.backend.advance(authorized, new AbortController().signal)).rejects.toThrow("Preparation temporarily unavailable");
  const allocated = f.store.getTask(f.task)!;
  expect(allocated.webExecution).toMatchObject({ executionGeneration: "2", launchSubmission: "not-submitted", controllerProcess: null, nativeProcesses: [] });
  expect(allocated.recovery).toEqual({ count: 3, pauseReason: "Preparation temporarily unavailable.", retryAuthorized: false });
  expect(f.launcher.launch).not.toHaveBeenCalled();
  const shutdown = await f.backend.cleanup(allocated, { kind: "shutdown", deadline: 20, immediateStop: true });
  f.store.clearShutdown(shutdown.task, 21);
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = openWebExecutionStore(path.join(f.home, "worker.sqlite")); stores.push(reopened);
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: reopened, git: f.git, launcher: f.launcher, platform: "macos", buildPrompt: vi.fn(), emit: () => {}, now: () => 30, request: f.request });
  const resumed = await backend.advance(reopened.authorizeRecoveryRetry(f.task, 22), new AbortController().signal);
  expect(resumed.recovery).toEqual({ count: 4, pauseReason: null, retryAuthorized: false });
  expect(resumed.webExecution).toMatchObject({ executionGeneration: "2", launchId: allocated.webExecution!.launchId, controllerInstanceId: allocated.webExecution!.controllerInstanceId, initialOperationId: allocated.webExecution!.initialOperationId, restartAfterShutdown: false });
  expect(resumed.resources.nativeSession).toEqual(allocated.resources.nativeSession);
  expect(f.launcher.launch).toHaveBeenCalledOnce();
  expect(f.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe"]);
});

it("keeps an allocated native retry through a transient worktree failure and store reopen without consuming another attempt", async () => {
  const f = await recoveryFixture();
  f.store.beginRecovery(f.task, 8);
  vi.mocked(f.git.prepareWorktree).mockRejectedValueOnce(new Error("Worktree temporarily unavailable."));
  await expect(f.backend.advance(f.store.authorizeRecoveryRetry(f.task, 9), new AbortController().signal)).rejects.toThrow("Worktree temporarily");
  const allocated = f.store.getTask(f.task)!;
  expect(allocated.recovery).toEqual({ count: 3, pauseReason: null, retryAuthorized: true });
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = openWebExecutionStore(path.join(f.home, "worker.sqlite")); stores.push(reopened);
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: reopened, git: f.git, launcher: f.launcher, platform: "macos", buildPrompt: vi.fn(), emit: () => {}, now: () => 30, request: f.request });
  const result = await backend.advance(allocated, new AbortController().signal);
  expect(result.recovery).toEqual({ count: 3, pauseReason: null, retryAuthorized: false });
  expect(result.webExecution?.executionGeneration).toBe("2");
  expect(reopened.getOrchestrationBlocker(allocated)).toBeNull();
  expect(f.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe"]);
});

it("continues a consumed unsubmitted retry after a Worker reopen without consuming another allowance", async () => {
  const f = await recoveryFixture();
  f.store.beginRecovery(f.task, 8);
  f.launcher.prepare.mockRejectedValueOnce(new Error("Preparation temporarily unavailable."));
  await expect(f.backend.advance(f.store.authorizeRecoveryRetry(f.task, 9), new AbortController().signal)).rejects.toThrow("Preparation temporarily unavailable");
  const allocated = f.store.getTask(f.task)!;
  f.store.authorizeRecoveryRetry(allocated, 21);
  const pending = f.store.retryUnsubmittedWebGeneration(allocated, f.snapshot, 22);
  expect(pending.recovery).toEqual({ count: 4, pauseReason: null, retryAuthorized: true });
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = openWebExecutionStore(path.join(f.home, "worker.sqlite")); stores.push(reopened);
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: reopened, git: f.git, launcher: f.launcher, platform: "macos", buildPrompt: vi.fn(), emit: () => {}, now: () => 30, request: f.request });
  const resumed = await backend.advance(reopened.getTask(f.task)!, new AbortController().signal);
  expect(resumed.recovery).toEqual({ count: 4, pauseReason: null, retryAuthorized: false });
  expect(resumed.webExecution?.launchId).toBe(allocated.webExecution!.launchId);
  expect(resumed.webExecution?.executionGeneration).toBe("2");
  expect(f.launcher.launch).toHaveBeenCalledOnce();
  expect(f.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe"]);
});

it("reconciles an unknown cleanup IPC outcome from the controller operation journal across Worker reopen", async () => {
  const f = await fixture(), source = await cleanupSource(f, f.store.getTask(f.identity)!);
  const journalPath = path.join(launchTickets.controllerExecutionDirectory(f.home, source.ticket.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalPath), { recursive: true });
  const journal = lifecycle.openControllerLifecycleStore(journalPath, source.ticket);
  let stopped = false;
  source.stopped.mockImplementation(async () => stopped);
  const snapshot = { ...source.snapshot, lifecycle: "working" as const, activity: "working" as const, nativeStopped: false, stoppedAt: null };
  source.saved.mockReturnValue(snapshot);
  const request = vi.fn<typeof requestController>(async (_ticket, action) => {
    if (action.kind === "cleanup") {
      journal.prepareOperation({ operationId: action.operationId, kind: "cleanup", payload: { prompt: action.prompt, deadline: action.deadline } });
      journal.markDispatching(action.operationId);
      journal.recordOperation(action.operationId, "provider_accepted");
      throw new Error("Cleanup acknowledgement was lost.");
    }
    return { requestId: randomUUID(), ok: true, snapshot };
  });
  vi.spyOn(processProof, "stopControllerProcesses").mockImplementation(async () => { stopped = true; });
  const options = { homeDirectory: f.home, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos" as const, buildPrompt: () => "managed", emit: () => {}, now: () => 20, archive: vi.fn().mockResolvedValue(undefined), request };
  try {
    const backend = createWebExecutionBackend({ ...options, store: f.store });
    const first = await backend.cleanup(source.task, { kind: "terminal", deadline: 100, immediateStop: false, scope: { attempt: { attemptId: randomUUID(), owner: source.task }, onExecutionStopped: () => {} } });
    expect(first.complete).toBe(false);
    const operationId = first.task.webExecution!.cleanupOperationId!;
    expect(journal.getOperation(operationId)?.state).toBe("provider_accepted");
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const reopened = openWebExecutionStore(path.join(f.home, "worker.sqlite")); stores.push(reopened);
    const restored = createWebExecutionBackend({ ...options, store: reopened });
    expect((await restored.cleanup(reopened.getTask(first.task)!, { kind: "terminal", deadline: 100, immediateStop: false, scope: { attempt: { attemptId: randomUUID(), owner: reopened.getTask(first.task)! }, onExecutionStopped: () => {} } })).complete).toBe(false);
    expect(request.mock.calls.filter(([, action]) => action.kind === "cleanup")).toHaveLength(1);
    journal.recordOperation(operationId, "confirmed");
    expect((await restored.cleanup(reopened.getTask(first.task)!, { kind: "terminal", deadline: 100, immediateStop: false, scope: { attempt: { attemptId: randomUUID(), owner: reopened.getTask(first.task)! }, onExecutionStopped: () => {} } })).complete).toBe(true);
    expect(request.mock.calls.filter(([, action]) => action.kind === "cleanup")).toHaveLength(1);
    expect(reopened.getTask(first.task)?.cleanup).toEqual({ kind: "terminal", startedAt: 20, deadline: 100 });
  } finally { journal.close(); }
});

it.each((["live", "stopped"] as const).flatMap(state => (["none", "pid", "birth", "command", "group", "native-parent"] as const).map(conflict => [state, conflict] as const)))("cleans up a POSIX Controller reparented after persisted launch proof and Worker interruption (%s, %s)", async (state, conflict) => {
  const f = await fixture("codex", 3);
  const task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree(f.identity, f.identity, {} as never), 2);
  const source = await cleanupSource(f, task, "unknown");
  const launcherProof = { ...source.snapshot.controllerProcess!, parentPid: 777 };
  const native = { ...launcherProof, pid: 988, parentPid: launcherProof.pid, startedAt: "native-original", commandHash: "b".repeat(64) };
  f.store.updateWebExecution(source.task, { launchSubmission: "unknown", controllerProcess: launcherProof, nativeProcesses: [native] }, 6);
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = openWebExecutionStore(path.join(f.home, "worker.sqlite")); stores.push(reopened);
  const controller = { ...launcherProof, parentPid: 1 };
  if (conflict === "pid") controller.pid += 1;
  if (conflict === "birth") controller.startedAt = "different-birth";
  if (conflict === "command") controller.commandHash = "c".repeat(64);
  if (conflict === "group") controller.processGroupId = 999;
  const nativeProcesses = conflict === "native-parent" ? [{ ...native, parentPid: 1 }] : [native];
  const nativeSessionId = randomUUID();
  let stopped = state === "stopped";
  const snapshot: ControllerSnapshot = { ...source.snapshot, controllerProcess: controller, nativeProcesses, nativeSessionId,
    lifecycle: stopped ? "stopped" : "starting", nativeStopped: stopped, stoppedAt: stopped ? new Date(50).toISOString() : null,
    startup: { state: "starting", reasonCode: "initializing" }, initialInputState: "not_submitted",
  };
  source.saved.mockReturnValue(snapshot); source.request.mockResolvedValue({ requestId: randomUUID(), ok: true, snapshot });
  source.stopped.mockImplementation(async () => stopped);
  vi.mocked(lifecycle.recordStoppedControllerGeneration).mockResolvedValue(snapshot);
  const stop = vi.spyOn(processProof, "stopControllerProcesses").mockImplementation(async () => {
    stopped = true; snapshot.lifecycle = "stopped"; snapshot.nativeStopped = true; snapshot.stoppedAt = new Date(50).toISOString();
  });
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: reopened, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 50, request: source.request });
  const result = backend.cleanup(reopened.getTask(task)!, { kind: "shutdown", deadline: 50, immediateStop: true });
  if (conflict !== "none") {
    await expect(result).rejects.toThrow();
    expect(reopened.getTask(task)?.resources.nativeSession).toBeNull();
    expect(stop).not.toHaveBeenCalled();
    expect(source.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe"]);
    return;
  }
  expect((await result).complete).toBe(true);
  expect(reopened.getTask(task)?.resources.nativeSession?.sessionId).toBe(nativeSessionId);
  expect(reopened.getTask(task)?.webExecution?.executionGeneration).toBe("1");
  expect(reopened.getTask(task)?.recovery).toEqual({ count: 0, pauseReason: null, retryAuthorized: false });
  expect(source.stopped).toHaveBeenCalledWith(controller, [native], expect.any(Number));
  if (state === "live") expect(source.stopped.mock.calls[0]![2]).toBe(source.stopped.mock.calls[1]![2]);
  if (state === "live") expect(stop).toHaveBeenCalledWith(controller, [native], expect.any(Number));
  else expect(stop).not.toHaveBeenCalled();
  expect(source.request.mock.calls.map(([, action]) => action.kind)).toEqual(state === "live" ? ["observe", "stop"] : ["observe"]);
  expect(launcher.launch).not.toHaveBeenCalled();
});

it.each((["none", "controller", "journal-native", "journal-process"] as const).flatMap(conflict => [false, true].map(retry => [conflict, retry] as const)))("binds the original native identity through normal shutdown after a lost submit response (conflict=%s, retry=%s)", async (conflict, retry) => {
  const f = await fixture("codex", 3);
  const task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree(f.identity, f.identity, {} as never), 2);
  const source = await cleanupSource(f, task);
  const native = { pid: 988, parentPid: 987, processGroupId: 987, startedAt: "native-original", commandHash: "b".repeat(64) };
  const nativeSessionId = randomUUID();
  let snapshot: ControllerSnapshot = { ...source.snapshot, lifecycle: "ready", activity: "idle", nativeStopped: false, stoppedAt: null, initialInputState: "not_submitted", startup: { state: "ready", reasonCode: "ready" }, nativeSessionId: null, nativeProcesses: [native] };
  let phase: "active" | "cleanup" | "resuming" = "active";
  source.saved.mockImplementation(() => snapshot);
  source.stopped.mockImplementation(async () => snapshot.nativeStopped);
  vi.mocked(lifecycle.recordStoppedControllerGeneration).mockImplementation(async () => ({ ...snapshot, activity: "stopped", capabilities: { send: false, steer: false, cancel: false, respond: false } }));
  vi.spyOn(processProof, "stopControllerProcesses").mockResolvedValue(undefined);
  source.request.mockImplementation(async (ticket, action) => {
    if (phase === "resuming") {
      if (ticket.executionGeneration === "1") throw new ControllerIpcOutcomeUnknownError("Original controller is stopped.");
      return { requestId: randomUUID(), ok: true, snapshot: { ...snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "ready", nativeStopped: false, stoppedAt: null } };
    }
    if (action.kind === "submit_initial") {
      snapshot = { ...snapshot, nativeSessionId, initialInputState: "confirmed" };
      throw new Error("Initial response was lost.");
    }
    if (action.kind === "stop") snapshot = { ...snapshot, lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date(50).toISOString() };
    const observed = { ...snapshot };
    if (phase === "cleanup") {
      if (conflict === "controller") observed.controllerProcess = { ...snapshot.controllerProcess!, startedAt: "different-controller-birth" };
      if (conflict === "journal-native") observed.nativeSessionId = randomUUID();
      if (conflict === "journal-process") observed.nativeProcesses = [];
    }
    return { requestId: randomUUID(), ok: true, snapshot: observed };
  });
  const launcher = {
    prepare: vi.fn(async (record: LocalTask): Promise<ControllerLaunchTicket> => record.webExecution!.executionGeneration === source.ticket.executionGeneration ? source.ticket : ({ ...source.ticket, launchId: record.webExecution!.launchId, executionGeneration: record.webExecution!.executionGeneration, controllerInstanceId: record.webExecution!.controllerInstanceId, resumeNativeSessionId: record.resources.nativeSession?.sessionId ?? null })),
    launch: vi.fn(async () => {}), refreshGrant: vi.fn(async () => {}),
  };
  const options = { homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos" as const, buildPrompt: () => "managed", emit: () => {}, now: () => 50, request: source.request };
  const backend = createWebExecutionBackend(options);
  await expect(backend.advance(source.task, new AbortController().signal)).rejects.toThrow("Initial response was lost");
  expect(f.store.getTask(task)?.resources.nativeSession).toBeNull();
  vi.mocked(f.git.prepareWorktree).mockRejectedValueOnce(new Error("Temporary worktree deviation."));
  await expect(backend.advance(source.task, new AbortController().signal)).rejects.toThrow("Temporary worktree");
  const before = f.store.getOrchestrationBlocker(task)!;
  expect(before.identity.nativeSessionId).toBeNull();
  phase = "cleanup";
  if (conflict !== "none") {
    await expect(backend.cleanup(source.task, { kind: "shutdown", deadline: 50, immediateStop: true })).rejects.toThrow();
    expect(f.store.getTask(task)?.resources.nativeSession).toBeNull();
    expect(f.store.getOrchestrationBlocker(task)).toEqual(before);
    expect(source.request.mock.calls.some(([, action]) => action.kind === "stop")).toBe(false);
    return;
  }
  const shutdown = await backend.cleanup(source.task, { kind: "shutdown", deadline: 50, immediateStop: true });
  expect(shutdown.complete).toBe(true);
  expect(shutdown.task.resources.nativeSession?.sessionId).toBe(nativeSessionId);
  expect(f.store.getOrchestrationBlocker(task)).toEqual({ ...before, identity: { ...before.identity, nativeSessionId } });
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = openWebExecutionStore(path.join(f.home, "worker.sqlite")); stores.push(reopened);
  const restored = reopened.clearShutdown(task, 51);
  phase = "resuming";
  const resumedBackend = createWebExecutionBackend({ ...options, store: reopened });
  const resumed = await resumedBackend.advance(retry ? reopened.authorizeRecoveryRetry(restored, 52) : restored, new AbortController().signal);
  expect(resumed.resources.nativeSession?.sessionId).toBe(nativeSessionId);
  expect(resumed.webExecution?.executionGeneration).toBe("2");
  expect(resumed.recovery).toEqual({ count: retry ? 1 : 0, pauseReason: null, retryAuthorized: false });
  expect(reopened.getOrchestrationBlocker(task)).toBeNull();
  expect(source.request.mock.calls.filter(([, action]) => action.kind === "submit_initial")).toHaveLength(1);
});

it.skipIf(process.platform === "win32").each(["cut-first", "stop-first", "inventory-failure"] as const)("orders a real Controller process stop with a policy cut (%s)", async order => {
  const f = await fixture();
  const bound = f.store.bindWorktree(f.identity, await f.git.prepareWorktree(f.identity, f.identity, {} as never), 2);
  const source = await cleanupSource(f, bound);
  vi.restoreAllMocks();
  const directory = path.join(resolveWorkerPaths(f.home).workerDirectory, "termination-domain");
  const domainId = await withTerminationDomain(directory, async domain => { f.store.bindTerminationDomain(source.task, domain.domainId); return domain.domainId; });
  const ticket: ControllerLaunchTicket = { ...source.ticket, terminationDomain: { directory, domainId } };
  await rm(launchTickets.controllerTicketPath(f.home, ticket.launchId));
  await launchTickets.writeLaunchTicket(f.home, ticket);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const proof = await processProof.captureProcessProof(child.pid!);
  const task = f.store.updateWebExecution(source.task, { controllerProcess: proof }, 6);
  const journalPath = path.join(launchTickets.controllerExecutionDirectory(f.home, source.ticket.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalPath), { recursive: true });
  const journal = lifecycle.openControllerLifecycleStore(journalPath, ticket);
  journal.patchSnapshot({ controllerProcess: proof, lifecycle: "working", activity: "working", nativeStopped: false, stoppedAt: null });
  journal.close();
  expect(await processProof.confirmControllerProcessesStopped(proof, [])).toBe(false);
  const request = vi.fn<typeof requestController>().mockRejectedValue(new ControllerIpcOutcomeUnknownError("Original IPC endpoint is unavailable."));
  const emit = vi.fn();
  if (order === "inventory-failure") vi.spyOn(f.store, "recordTerminationStop").mockImplementationOnce(() => { throw new Error("controlled inventory failure"); });
  const backend = createWebExecutionBackend({ homeDirectory: f.home, workerId: task.workerId, serverOrigin: task.serverOrigin, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn(), joinExecution: vi.fn(async () => {}) }, platform: "linux", buildPrompt: () => "managed", emit, now: () => 20, request });
  let releaseGit!: () => void, enteredGit!: () => void;
  const gitHeld = new Promise<void>(resolve => { releaseGit = resolve; });
  const gitEntered = new Promise<void>(resolve => { enteredGit = resolve; });
  vi.mocked(f.git.removeWorktree).mockImplementation(async () => { enteredGit(); await gitHeld; return { kind: "absent", effectErrors: [] }; });
  const activationId = randomUUID();
  let releaseCut!: () => void, enteredCut!: () => void;
  const held = new Promise<void>(resolve => { releaseCut = resolve; });
  const entered = new Promise<void>(resolve => { enteredCut = resolve; });
  let cut: Promise<void> | undefined;
  if (order === "cut-first") {
    cut = withTerminationDomainCut(directory, async domain => { domain.prepare(activationId); enteredCut(); await held; domain.settle(activationId); }, { expectedDomainId: domainId });
    await entered;
  } else {
    const execute = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql === "BEGIN IMMEDIATE" && this.name === journalPath && cut === undefined) {
        cut = withTerminationDomainCut(directory, async domain => {
          expect(lifecycle.readControllerSnapshot(journalPath)).toMatchObject({ lifecycle: "stopped", nativeStopped: true });
          domain.prepare(activationId); domain.settle(activationId);
        }, { expectedDomainId: domainId });
      }
      return execute.call(this, sql);
    });
  }
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const cleanup = backend.cleanup(task, { kind: "terminal", deadline: 20, immediateStop: true, scope: { attempt: { owner: task, attemptId: randomUUID() }, onExecutionStopped: () => {} } });
  const cleanupFailure = cleanup.then(() => { throw new Error("Cleanup ended before the worktree barrier."); }, error => { throw error; });
  void cleanupFailure.catch(() => {});
  if (order === "cut-first") {
    await Promise.race([exited, cleanupFailure]);
    expect(lifecycle.readControllerSnapshot(journalPath)).toMatchObject({ nativeStopped: false });
    releaseCut();
  }
  await Promise.race([gitEntered, cleanupFailure]);
  if (order === "inventory-failure") expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "session-termination-retry", error: expect.objectContaining({ message: "controlled inventory failure" }) }));
  await backend.reconcileTermination(task, new AbortController().signal);
  const closure = f.store.readTerminationClosure(task);
  expect(closure).toMatchObject({ launchesSettled: true, runs: [{ launchId: ticket.launchId, snapshot: { nativeStopped: true, controllerProcess: proof } }] });
  releaseGit();
  const outcome = await cleanup;
  expect(cut).toBeDefined(); await cut;
  expect(outcome.complete).toBe(true);
  expect(await processProof.confirmControllerProcessesStopped(proof, [])).toBe(true);
  expect(lifecycle.readControllerSnapshot(journalPath)).toMatchObject({ lifecycle: "stopped", nativeStopped: true, controllerProcess: proof });
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = openWebExecutionStore(path.join(f.home, "worker.sqlite")); stores.push(reopened);
  expect(reopened.readTerminationClosure(task)).toEqual(closure);
}, 15_000);

it.skipIf(process.platform === "win32")("stops the original bootstrap when its IPC accepts connections without replying", async () => {
  const f = await fixture(), source = await cleanupSource(f, f.store.getTask(f.identity)!, "unknown");
  vi.restoreAllMocks();
  // A relative socket keeps the address below the macOS Unix socket limit.
  const endpoint = `../../.tmp/stall-${randomUUID()}.sock`;
  vi.spyOn(launchTickets, "readLaunchTicket").mockResolvedValue({ ...source.ticket, ipcEndpoint: endpoint });
  const script = "const net=require('node:net'); net.createServer(() => {}).listen(process.argv[1], () => process.stdout.write('ready\\n'));";
  const child = spawn(process.execPath, ["-e", script, endpoint], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error("bootstrap exited before listening"))); });
  const proof = await processProof.captureProcessProof(child.pid!);
  const task = f.store.updateWebExecution(source.task, { controllerProcess: proof }, 6);
  const cancelled = new AbortController(); cancelled.abort(new Error("caller cancelled"));
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 20 });
  try {
    await expect(backend.cleanup(task, { kind: "shutdown", deadline: 20, immediateStop: true, signal: cancelled.signal })).rejects.toThrow("before committing");
    expect(await processProof.inspectProcessProof(proof)).toBe("stopped");
    expect(f.store.getTask(task)?.webExecution).toMatchObject({ launchId: source.ticket.launchId, launchSubmission: "unknown", controllerProcess: proof });
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  } finally { await rm(endpoint, { force: true }); }
}, 15_000);
