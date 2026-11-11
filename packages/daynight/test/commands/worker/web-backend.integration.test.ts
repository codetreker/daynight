import { createOperation } from "../../../src/api/operation.js";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import type { CleanupRequest } from "../../../src/commands/worker/execution-stop.js";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { createWebExecutionBackend } from "../../../src/commands/worker/backends/web.js";
import type { LocalTask } from "../../../src/commands/worker/backends/web-types.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as launchTickets from "../../../src/commands/controller/launch-ticket.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as controllerStop from "../../../src/commands/controller/controller-stop.js";
import { previousWebTicket, webExecutionRef } from "../../../src/commands/worker/backends/web-stop.js";
import * as webStop from "../../../src/commands/worker/backends/web-stop.js";
import { createExecutionCapacity } from "../../../src/commands/worker/execution-capacity.js";
import { ExecutionSourceConflictError } from "../../../src/commands/worker/execution-stop.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { requestController } from "../../../src/commands/controller/local-client.js";
import { createWebBackendFixtures } from "./web-backend.fixtures.js";

const cleanupRequest = (owner: { projectId: string; taskId: string; claimId: string; worktreeId: string }, kind: "terminal" | "shutdown", deadline: number): CleanupRequest => kind === "shutdown"
  ? { kind, deadline, immediateStop: true }
  : { kind, deadline, immediateStop: false, scope: { attempt: { attemptId: "test", owner }, onExecutionStopped: () => {} } };

const { children, stores, fixture, cleanupSource, recoveryFixture } = createWebBackendFixtures("file");

const mockPosixControllerStop = () => vi.spyOn(controllerStop, "openControllerStop").mockImplementation(async ({ journalPath, ticket, controller, native }) => ({
  confirm: () => processProof.confirmControllerProcessesStopped(controller, native),
  stop: deadline => processProof.stopControllerProcesses(controller, native, deadline),
  commit: async hooks => { hooks?.onVerified(); return lifecycle.recordStoppedControllerGeneration(journalPath, ticket); },
  close: async () => {},
}));

const mockRecoveryStop = () => {
  mockPosixControllerStop();
  vi.spyOn(webStop, "previousWebTicket").mockImplementation(home => launchTickets.readLaunchTicket(home, randomUUID()));
};

it("recovers the exact previous Windows ticket from its persisted controller proof", async () => {
  const f = await fixture(), source = await cleanupSource(f, f.store.getTask(f.identity)!);
  const snapshot = { ...source.snapshot, controllerProcess: { ...source.snapshot.controllerProcess!, jobObjectName: `Local\\Daynight-${source.ticket.launchId}` } };
  expect(await previousWebTicket(f.home, snapshot)).toEqual(source.ticket);
  await expect(previousWebTicket(f.home, { ...snapshot, controllerProcess: { ...snapshot.controllerProcess, jobObjectName: "Local\\Daynight-invalid" } })).rejects.toThrow("no recoverable launch ticket");
});

it.each(["identity conflict", "ordinary read failure"] as const)("handles a Windows Job %s after a stopped observation", async kind => {
  const f = await fixture(), source = await cleanupSource(f, f.store.getTask(f.identity)!);
  const proof = { ...source.snapshot.controllerProcess!, processGroupId: null, jobObjectName: `Local\\Daynight-${source.ticket.launchId}` };
  const task = f.store.updateWebExecution(source.task, { controllerProcess: proof }, 6);
  source.saved.mockReturnValue({ ...source.snapshot, controllerProcess: proof });
  const fault = kind === "identity conflict" ? new controllerStop.ControllerStopIdentityError("Job source changed") : new Error("Temporary journal I/O failure");
  vi.spyOn(controllerStop, "openControllerStop").mockRejectedValue(fault);
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "windows", buildPrompt: () => "managed", emit: () => {}, now: () => 10, request: source.request });
  const execution = webExecutionRef(task), attempt = { owner: execution.owner, attemptId: "attempt" };
  const capacity = createExecutionCapacity(() => {});
  capacity.beginAttempt(attempt);
  expect(capacity.notify({ attempt, observation: { kind: "stopped", execution, observedAt: 1 } })).toBe(true);
  const observationTicket = capacity.beginObservation(execution.owner)!;
  const operation = createOperation({ limits: { totalMs: 30_000 } });
  try {
    const observed = await backend.observeExecutionStop(task, operation);
    expect(observed.kind).toBe("unknown");
    if (observed.kind !== "unknown") throw new Error("Expected an unknown observation.");
    expect(observed.error instanceof ExecutionSourceConflictError).toBe(kind === "identity conflict");
    expect(capacity.commitObservation(observationTicket, observed)).toBe(true);
    expect(capacity.isStopped(execution.owner)).toBe(kind === "ordinary read failure");
  } finally { operation.dispose(); }
});

it.skipIf(process.platform === "win32").each(["observe", "cleanup"] as const)("does not publish a POSIX stop when native evidence changes during %s", async mode => {
  const f = await fixture(), source = await cleanupSource(f, f.store.getTask(f.identity)!);
  vi.restoreAllMocks();
  const controller = { pid: 1234, parentPid: 1, processGroupId: 1234, startedAt: "original-controller", commandHash: "a".repeat(64) };
  const native = { ...controller, pid: 1235, parentPid: controller.pid, startedAt: "original-native", commandHash: "b".repeat(64) };
  const later = { ...native, pid: 1236, startedAt: "later-native", commandHash: "c".repeat(64) };
  const task = f.store.updateWebExecution(source.task, { controllerProcess: controller, nativeProcesses: [native] }, 6);
  const journalPath = path.join(launchTickets.controllerExecutionDirectory(f.home, source.ticket.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalPath), { recursive: true });
  const journal = lifecycle.openControllerLifecycleStore(journalPath, source.ticket);
  journal.patchSnapshot({ controllerProcess: controller, nativeProcesses: [native], lifecycle: "working", nativeStopped: false, stoppedAt: null }); journal.close();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockImplementation(async (proof, descendants) => {
    expect(proof).toEqual(controller); expect(descendants).toEqual([native]); enter(); await barrier; return true;
  });
  const archive = vi.fn(), notice = vi.fn();
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: process.platform === "darwin" ? "macos" : "linux", buildPrompt: () => "managed", emit: () => {}, now: Date.now, request: vi.fn().mockRejectedValue(new Error("Original IPC unavailable.")), archive });
  const operation = createOperation({ limits: { totalMs: 30_000 } });
  const result = mode === "observe" ? backend.observeExecutionStop(task, operation) : backend.cleanup(task, { kind: "terminal", deadline: Date.now(), immediateStop: true, scope: { attempt: { owner: task, attemptId: "attempt" }, onExecutionStopped: notice } });
  void result.catch(() => {});
  try {
    await entered;
    const snapshot = lifecycle.readControllerSnapshot(journalPath)!;
    const db = new Database(journalPath);
    try { db.prepare("UPDATE execution SET snapshot=?").run(JSON.stringify({ ...snapshot, nativeProcesses: [native, later] })); } finally { db.close(); }
    release();
    if (mode === "observe") {
      const observation = await result;
      expect(observation).toMatchObject({ kind: "unknown", error: expect.any(ExecutionSourceConflictError) });
    } else await expect(result).rejects.toThrow();
    expect(confirm).toHaveBeenCalledOnce(); expect(notice).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled();
    expect(lifecycle.readControllerSnapshot(journalPath)).toMatchObject({ nativeStopped: false, nativeProcesses: [native, later] });
  } finally { release(); operation.dispose(); }
});

it.skipIf(process.platform === "win32")("retains an acknowledged POSIX launch when its journal is missing", async () => {
  const f = await fixture(), source = await cleanupSource(f, f.store.getTask(f.identity)!);
  vi.restoreAllMocks();
  const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  const notice = vi.fn(), archive = vi.fn();
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: process.platform === "darwin" ? "macos" : "linux", buildPrompt: () => "managed", emit: () => {}, now: Date.now, request: vi.fn().mockRejectedValue(new Error("Original IPC unavailable.")), archive });
  const operation = createOperation({ limits: { totalMs: 30_000 } });
  try {
    expect(await backend.observeExecutionStop(source.task, operation)).toMatchObject({ kind: "unknown" });
    await expect(backend.cleanup(source.task, { kind: "terminal", deadline: Date.now(), immediateStop: true, scope: { attempt: { owner: source.task, attemptId: "attempt" }, onExecutionStopped: notice } })).rejects.toThrow(/journal.*unavailable/);
    expect(confirm).not.toHaveBeenCalled(); expect(notice).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled();
  } finally { operation.dispose(); }
});

it("retains a single retry across starting, store reopen, and later native failure below the ordinary budget", async () => {
  const f = await recoveryFixture(5);
  mockRecoveryStop();
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
  mockRecoveryStop();
  f.store.beginRecovery(f.task, 8);
  const authorized = f.store.authorizeRecoveryRetry(f.task, 9);
  f.launcher.prepare.mockRejectedValueOnce(new Error("Preparation temporarily unavailable."));
  await expect(f.backend.advance(authorized, new AbortController().signal)).rejects.toThrow("Preparation temporarily unavailable");
  const allocated = f.store.getTask(f.task)!;
  expect(allocated.webExecution).toMatchObject({ executionGeneration: "2", launchSubmission: "not-submitted", controllerProcess: null, nativeProcesses: [] });
  expect(allocated.recovery).toEqual({ count: 3, pauseReason: "Preparation temporarily unavailable.", retryAuthorized: false });
  expect(f.launcher.launch).not.toHaveBeenCalled();
  const shutdown = await f.backend.cleanup(allocated, cleanupRequest(allocated, "shutdown", 20));
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
  mockRecoveryStop();
  f.store.beginRecovery(f.task, 8);
  vi.mocked(f.git.verifyWorktree).mockRejectedValueOnce(new Error("Worktree temporarily unavailable."));
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
  mockRecoveryStop();
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
  mockPosixControllerStop();
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
    const first = await backend.cleanup(source.task, cleanupRequest(source.task, "terminal", 100));
    expect(first.complete).toBe(false);
    const operationId = first.task.webExecution!.cleanupOperationId!;
    expect(journal.getOperation(operationId)?.state).toBe("provider_accepted");
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const reopened = openWebExecutionStore(path.join(f.home, "worker.sqlite")); stores.push(reopened);
    const restored = createWebExecutionBackend({ ...options, store: reopened });
    expect((await restored.cleanup(reopened.getTask(first.task)!, cleanupRequest(reopened.getTask(first.task)!, "terminal", 100))).complete).toBe(false);
    expect(request.mock.calls.filter(([, action]) => action.kind === "cleanup")).toHaveLength(1);
    journal.recordOperation(operationId, "confirmed");
    expect((await restored.cleanup(reopened.getTask(first.task)!, cleanupRequest(reopened.getTask(first.task)!, "terminal", 100))).complete).toBe(true);
    expect(request.mock.calls.filter(([, action]) => action.kind === "cleanup")).toHaveLength(1);
    expect(reopened.getTask(first.task)?.cleanup).toEqual({ kind: "terminal", startedAt: 20, deadline: 100 });
  } finally { journal.close(); }
});

it.each((["live", "stopped"] as const).flatMap(state => (["none", "pid", "birth", "command", "group", "native-parent"] as const).map(conflict => [state, conflict] as const)))("cleans up a POSIX Controller reparented after persisted launch proof and Worker interruption (%s, %s)", async (state, conflict) => {
  const f = await fixture("codex", 3);
  const task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree(f.identity, f.identity, {} as never), 2);
  const source = await cleanupSource(f, task);
  mockPosixControllerStop();
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
  const result = backend.cleanup(reopened.getTask(task)!, cleanupRequest(reopened.getTask(task)!, "shutdown", 50));
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
  expect(source.stopped).toHaveBeenCalledWith(controller, [native]);
  if (state === "live") expect(stop).toHaveBeenCalledWith(controller, [native], expect.any(Number));
  else expect(stop).not.toHaveBeenCalled();
  expect(source.request.mock.calls.map(([, action]) => action.kind)).toEqual(state === "live" ? ["observe", "stop"] : ["observe"]);
  expect(launcher.launch).not.toHaveBeenCalled();
});

it.each((["none", "controller", "journal-native", "journal-process"] as const).flatMap(conflict => [false, true].map(retry => [conflict, retry] as const)))("binds the original native identity through normal shutdown after a lost submit response (conflict=%s, retry=%s)", async (conflict, retry) => {
  const f = await fixture("codex", 3);
  const task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree(f.identity, f.identity, {} as never), 2);
  const source = await cleanupSource(f, task);
  mockPosixControllerStop();
  const native = { pid: 988, parentPid: 987, processGroupId: 987, startedAt: "native-original", commandHash: "b".repeat(64) };
  const nativeSessionId = randomUUID();
  let snapshot: ControllerSnapshot = { ...source.snapshot, lifecycle: "ready", activity: "idle", nativeStopped: false, stoppedAt: null, initialInputState: "not_submitted", startup: { state: "ready", reasonCode: "ready" }, nativeSessionId: null, nativeProcesses: [native] };
  let phase: "active" | "cleanup" | "resuming" = "active";
  source.saved.mockImplementation(() => snapshot);
  source.stopped.mockImplementation(async () => snapshot.nativeStopped);
  vi.mocked(lifecycle.recordStoppedControllerGeneration).mockImplementation(async () => snapshot);
  vi.spyOn(processProof, "stopControllerProcesses").mockResolvedValue(undefined);
  source.request.mockImplementation(async (ticket, action) => {
    if (phase === "resuming") {
      if (ticket.executionGeneration === "1") throw new Error("Original controller is stopped.");
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
    prepare: vi.fn(async (record: LocalTask): Promise<ControllerLaunchTicket> => ({ ...source.ticket, launchId: record.webExecution!.launchId, executionGeneration: record.webExecution!.executionGeneration, controllerInstanceId: record.webExecution!.controllerInstanceId, resumeNativeSessionId: record.resources.nativeSession?.sessionId ?? null })),
    launch: vi.fn(async () => {}), refreshGrant: vi.fn(async () => {}),
  };
  const options = { homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos" as const, buildPrompt: () => "managed", emit: () => {}, now: () => 50, request: source.request };
  const backend = createWebExecutionBackend(options);
  await expect(backend.advance(source.task, new AbortController().signal)).rejects.toThrow("Initial response was lost");
  expect(f.store.getTask(task)?.resources.nativeSession).toBeNull();
  vi.mocked(f.git.verifyWorktree).mockRejectedValueOnce(new Error("Temporary worktree deviation."));
  await expect(backend.advance(source.task, new AbortController().signal)).rejects.toThrow("Temporary worktree");
  const before = f.store.getOrchestrationBlocker(task)!;
  expect(before.identity.nativeSessionId).toBeNull();
  phase = "cleanup";
  if (conflict !== "none") {
    await expect(backend.cleanup(source.task, cleanupRequest(source.task, "shutdown", 50))).rejects.toThrow();
    expect(f.store.getTask(task)?.resources.nativeSession).toBeNull();
    expect(f.store.getOrchestrationBlocker(task)).toEqual(before);
    expect(source.request.mock.calls.some(([, action]) => action.kind === "stop")).toBe(false);
    return;
  }
  const shutdown = await backend.cleanup(source.task, cleanupRequest(source.task, "shutdown", 50));
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

const osWriterScript = (moduleUrl: string, launchId: string, failCapture = false, context?: { ticket: ControllerLaunchTicket; journalPath: string }): string => {
  const descendant = `
    const { captureProcessProof } = await import(${JSON.stringify(moduleUrl)});
    try {
      ${failCapture ? 'throw new Error("Injected process proof failure");' : ''}
      const proof = await captureProcessProof(process.pid);
      const orphan = () => process.exit(2);
      const activate = value => {
        if (value !== "activate") return;
        process.removeListener("disconnect", orphan); process.removeListener("message", activate);
        process.send({ kind: "activated" });
      };
      process.on("disconnect", orphan); process.on("message", activate);
      if (!process.connected) process.exit(2);
      process.send({ kind: "ready", proof });
      setInterval(() => {}, 1000);
    } catch (error) { process.exitCode = 1; process.send({ kind: "failure", message: String(error) }, () => process.disconnect()); }
  `;
  return `
    import { spawn } from "node:child_process";
    const { captureControllerProcessProof } = await import(${JSON.stringify(moduleUrl)});
    const proof = await captureControllerProcessProof(${JSON.stringify(launchId)}, ${JSON.stringify(context)});
    const descendant = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    let failure = null;
    descendant.on("error", error => { throw error; });
    descendant.on("message", message => {
      if (message.kind === "failure") failure = message.message;
      if (message.kind === "ready") process.send({ kind: "ready", proof, native: message.proof, descendantPid: descendant.pid });
      if (message.kind === "activated") { process.removeListener("message", parentMessage); process.removeListener("disconnect", abort); process.send({ kind: "activated" }); }
    });
    descendant.once("exit", (code, signal) => { if (failure !== null) process.send({ kind: "capture-failed", message: failure, descendantPid: descendant.pid, code, signal }); });
    const abort = () => {
      const finish = () => { if (!process.connected) process.exit(0); else process.send({ kind: "aborted", descendantPid: descendant.pid }, () => process.exit(0)); };
      if (descendant.exitCode !== null || descendant.signalCode !== null) finish();
      else { descendant.once("exit", finish); descendant.kill("SIGKILL"); }
    };
    const parentMessage = value => {
      if (value === "abort") abort();
      if (value === "activate") descendant.send("activate");
    };
    process.on("message", parentMessage); process.on("disconnect", abort);
    setInterval(() => {}, 1000);
  `;
};

const windowsWriterContext = async () => {
  if (process.platform !== "win32") return undefined;
  const f = await fixture(), source = await cleanupSource(f, f.store.getTask(f.identity)!);
  vi.restoreAllMocks();
  const journalPath = path.join(launchTickets.controllerExecutionDirectory(f.home, source.ticket.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalPath), { recursive: true });
  lifecycle.openControllerLifecycleStore(journalPath, source.ticket).close();
  return { ticket: source.ticket, journalPath };
};

const releaseFixtureGuardian = async (context: { ticket: ControllerLaunchTicket; journalPath: string } | undefined): Promise<void> => {
  if (context === undefined) return;
  const source = lifecycle.readWindowsJobSource(context.journalPath, context.ticket);
  if (source === null) return;
  const state = await processProof.inspectProcessProof(source.guardian);
  if (state === "running") process.kill(source.guardian.pid, "SIGKILL");
  await vi.waitFor(async () => expect(await processProof.inspectProcessProof(source.guardian)).not.toBe("running"), { timeout: 15_000, interval: 25 });
};

const guardianDiagnostic = async (context: { ticket: ControllerLaunchTicket; journalPath: string } | undefined): Promise<string> => {
  if (!context) return "Guardian was not started on this platform.";
  try { return (await readFile(path.join(path.dirname(context.journalPath), `guardian-${context.ticket.launchId}.log`), "utf8")).slice(-8192); }
  catch (error) { return `Guardian log could not be read: ${String(error)}`; }
};

const forceOsWriterFixture = async (child: ChildProcess, native: processProof.ProcessProof | undefined): Promise<void> => {
  if (process.platform !== "win32" && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  } else {
    if (native !== undefined && await processProof.inspectProcessProof(native) === "running") process.kill(native.pid, "SIGKILL");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
};

it("joins the original descendant when process proof acquisition fails", async () => {
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/commands/controller/process-proof.js")).href;
  const context = await windowsWriterContext();
  const child = spawn(process.execPath, ["--input-type=module", "-e", osWriterScript(moduleUrl, context?.ticket.launchId ?? randomUUID(), true, context)], { detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  children.push(child);
  const exited = once(child, "exit"); void exited.catch(() => {});
  let stderr = ""; child.stderr!.setEncoding("utf8"); child.stderr!.on("data", chunk => { stderr += chunk; });
  try {
    const [result] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(45_000) }),
      exited.then(([code, signal]) => { throw new Error(`Fixture exited before descendant join (code=${code}, signal=${signal}): ${stderr}`); }),
    ]) as [{ kind: string; message: string; descendantPid: number; code: number }];
    expect(result).toMatchObject({ kind: "capture-failed", code: 1, message: expect.stringContaining("Injected process proof failure") });
    expect(result.descendantPid).toBeGreaterThan(0);
  } catch (error) { console.error("Guardian fixture diagnostic:", await guardianDiagnostic(context)); throw error; }
  finally {
    try {
    if (child.exitCode === null && child.signalCode === null) {
      const joined = once(child, "message", { signal: AbortSignal.timeout(15_000) });
      child.send("abort");
      expect((await joined)[0]).toMatchObject({ kind: "aborted" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exited, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Fixture leader did not exit after descendant join.")), 15_000); })]); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }
    } finally { await releaseFixtureGuardian(context); }
  }
}, 90_000);

it.each(["lost activation receipt", "leader crash before activation"] as const)("reaps the descendant after %s", async scenario => {
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/commands/controller/process-proof.js")).href;
  const context = await windowsWriterContext();
  const child = spawn(process.execPath, ["--input-type=module", "-e", osWriterScript(moduleUrl, context?.ticket.launchId ?? randomUUID(), false, context)], { detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  children.push(child);
  const exited = once(child, "exit"); void exited.catch(() => {});
  const joinLeader = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Fixture leader did not exit.")), 15_000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  let native: processProof.ProcessProof | undefined;
  let activationSubmitted = false;
  try {
    const [receipt] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(45_000) }),
      exited.then(() => { throw new Error("Fixture exited before its proof."); }),
    ]) as [{ kind: string; native: processProof.ProcessProof }];
    expect(receipt.kind).toBe("ready"); native = receipt.native;
    if (scenario === "lost activation receipt") {
      const acknowledgement = once(child, "message", { signal: AbortSignal.timeout(15_000) });
      activationSubmitted = true;
      child.send("activate");
      // The fixture observes that activation happened, while exercising cleanup as if the caller lost the receipt.
      expect((await acknowledgement)[0]).toEqual({ kind: "activated" });
      await forceOsWriterFixture(child, native);
    } else {
      child.kill("SIGKILL");
    }
    await joinLeader();
    await vi.waitFor(async () => expect(await processProof.inspectProcessProof(native!)).toBe("stopped"), { timeout: 15_000, interval: 25 });
  } catch (error) { console.error("Guardian fixture diagnostic:", await guardianDiagnostic(context)); throw error; }
  finally {
    try {
    if (child.exitCode === null && child.signalCode === null) {
      if (!activationSubmitted) {
        const joined = once(child, "message", { signal: AbortSignal.timeout(15_000) });
        child.send("abort"); await joined;
      } else await forceOsWriterFixture(child, native);
      await joinLeader();
    }
    if (native !== undefined) {
      if (await processProof.inspectProcessProof(native) === "running") process.kill(native.pid, "SIGKILL");
      await vi.waitFor(async () => expect(await processProof.inspectProcessProof(native!)).toBe("stopped"), { timeout: 15_000, interval: 25 });
    }
    } finally { await releaseFixtureGuardian(context); }
  }
}, 90_000);

it("observes the original OS writer stop before terminal archive joins", async () => {
  const f = await fixture(), source = await cleanupSource(f, f.store.getTask(f.identity)!);
  vi.restoreAllMocks();
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/commands/controller/process-proof.js")).href;
  const journalPath = path.join(launchTickets.controllerExecutionDirectory(f.home, source.ticket.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalPath), { recursive: true });
  lifecycle.openControllerLifecycleStore(journalPath, source.ticket).close();
  const context = process.platform === "win32" ? { ticket: source.ticket, journalPath } : undefined;
  const script = osWriterScript(moduleUrl, source.ticket.launchId, false, context);
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  children.push(child);
  const childExit = once(child, "exit"); void childExit.catch(() => {});
  let stderr = ""; child.stderr!.setEncoding("utf8"); child.stderr!.on("data", chunk => { stderr += chunk; });
  const bounded = async <T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not finish in ${milliseconds} ms.`)), milliseconds); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  let proof: processProof.ProcessProof | undefined, native: processProof.ProcessProof | undefined;
  let descendantPid: number | undefined, cleanup: Promise<unknown> | undefined, stage = "capture-proof", activationSubmitted = false;
  let release = () => {};
  const operation = createOperation({ limits: { totalMs: 90_000 } });
  try {
    const [receipt] = await bounded(Promise.race([
      once(child, "message"),
      childExit.then(([code, signal]) => { throw new Error(`Controller fixture exited before proof (code=${code}, signal=${signal}): ${stderr}`); }),
    ]), 45_000, "Controller fixture proof") as [{ kind: "ready"; proof: processProof.ProcessProof; native: processProof.ProcessProof; descendantPid: number }];
    expect(receipt.kind).toBe("ready");
    proof = receipt.proof; descendantPid = receipt.descendantPid; native = receipt.native;
    expect(native.parentPid).toBe(proof.pid);
    const task = f.store.updateWebExecution(source.task, { controllerProcess: proof, nativeProcesses: [native] }, 6);
    const journal = lifecycle.openControllerLifecycleStore(journalPath, source.ticket);
    journal.patchSnapshot({ controllerProcess: proof, nativeProcesses: [native], lifecycle: "working", activity: "working", nativeStopped: false, stoppedAt: null }); journal.close();
    let entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const archiveEntered = new Promise<void>(resolve => { entered = resolve; });
    const notice = vi.fn();
    const request = vi.fn<typeof requestController>().mockRejectedValue(new Error("Original IPC endpoint is unavailable."));
    // Preserve the real OS stop and Job operations while bounding this fixture's wait.
    const stop = processProof.stopControllerProcesses;
    vi.spyOn(processProof, "stopControllerProcesses").mockImplementation((owner, descendants, deadline) => stop(owner, descendants, Math.min(deadline, Date.now() + 30_000)));
    const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux", buildPrompt: () => "managed", emit: () => {}, now: Date.now, request, archive: async () => { entered(); await barrier; } });
    stage = "observe-running";
    expect(await backend.observeExecutionStop(task, operation)).toMatchObject({ kind: "running" });
    expect(await processProof.inspectProcessProof(native)).toBe("running");
    if (process.platform === "win32") {
      const { openWindowsGuardianJob } = await import("../../../src/commands/controller/windows-job-guardian.js");
      const original = lifecycle.readWindowsJobSource(journalPath, source.ticket);
      expect(original?.phase).toBe("assigned");
      if (original?.phase !== "assigned") throw new Error("Original guardian source was not assigned.");
      const lease = await openWindowsGuardianJob(original);
      try { expect(lease.inspect().members).toEqual(expect.arrayContaining([proof.pid, native.pid])); }
      finally { lease.close(); }
    }
    const activation = once(child, "message");
    activationSubmitted = true;
    child.send("activate");
    expect((await bounded(activation, 15_000, "Fixture activation"))[0]).toEqual({ kind: "activated" });
    stage = "terminal-stop";
    cleanup = backend.cleanup(task, { kind: "terminal", deadline: Date.now(), immediateStop: true, scope: { attempt: { owner: task, attemptId: "attempt" }, onExecutionStopped: notice } });
    await bounded(Promise.race([archiveEntered, cleanup.then(() => { throw new Error("Cleanup completed before the archive barrier."); })]), 75_000, "Original stop and archive entry");
    stage = "archive-pending";
    expect(notice).toHaveBeenCalledOnce();
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({ observation: expect.objectContaining({ kind: "stopped", execution: expect.objectContaining({ backend: "web" }) }) }));
    expect(await backend.observeExecutionStop(task, operation)).toMatchObject({ kind: "stopped", execution: { backend: "web" } });
    expect(await processProof.inspectProcessProof(native)).toBe("stopped");
    if (process.platform !== "win32") expect(await processProof.confirmControllerProcessesStopped(proof, [native])).toBe(true);
    else expect(lifecycle.readWindowsJobReceipt(journalPath, source.ticket)).toMatchObject({ sealed: true, empty: true, controllerStopped: true, nativeProcessesStopped: true });
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  } catch (error) {
    console.error(JSON.stringify({ fixture: "web-stop-os-writer", stage, platform: process.platform, pid: proof?.pid ?? child.pid, descendantPid, jobObjectName: proof?.jobObjectName ?? null, exitCode: child.exitCode, signalCode: child.signalCode, stderr: stderr.slice(0, 2048), guardian: await guardianDiagnostic(context) }));
    throw error;
  } finally {
    release(); operation.dispose();
    try { if (cleanup !== undefined) await bounded(cleanup, 60_000, "Cleanup join"); }
    finally { try {
      if (!activationSubmitted && child.exitCode === null && child.signalCode === null) {
        const aborted = once(child, "message");
        child.send("abort");
        expect((await bounded(aborted, 15_000, "Fixture abort and descendant join"))[0]).toMatchObject({ kind: "aborted" });
      } else await forceOsWriterFixture(child, native);
      await bounded(childExit, 15_000, "Controller fixture exit");
      if (native !== undefined) {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const state = await processProof.inspectProcessProof(native);
          if (state === "stopped") break;
          if (state === "replaced") throw new Error("The descendant identity was replaced before fixture cleanup.");
          if (Date.now() >= deadline) throw new Error("Descendant fixture exit did not finish in 15000 ms.");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
    } finally { await releaseFixtureGuardian(context); } }
  }
}, 240_000);

it.skipIf(process.platform !== "win32")("retains the original Job across Worker restart and reports unknown when its guardian disappears without a receipt", async () => {
  const f = await fixture(), source = await cleanupSource(f, f.store.getTask(f.identity)!);
  vi.restoreAllMocks();
  const journalPath = path.join(launchTickets.controllerExecutionDirectory(f.home, source.ticket.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalPath), { recursive: true });
  lifecycle.openControllerLifecycleStore(journalPath, source.ticket).close();
  const context = { ticket: source.ticket, journalPath };
  const proofUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/commands/controller/process-proof.js")).href;
  const guardianUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/commands/controller/windows-job-guardian.js")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", osWriterScript(proofUrl, source.ticket.launchId, false, context)], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  children.push(child);
  const exited = once(child, "exit"); void exited.catch(() => {});
  let native: processProof.ProcessProof | undefined;
  try {
    const [ready] = await Promise.race([once(child, "message", { signal: AbortSignal.timeout(45_000) }), exited.then(() => { throw new Error("Controller exited before its original guardian was ready."); })]) as [{ kind: string; proof: processProof.ProcessProof; native: processProof.ProcessProof }];
    expect(ready.kind).toBe("ready"); native = ready.native;
    const task = f.store.updateWebExecution(source.task, { controllerProcess: ready.proof, nativeProcesses: [native] }, 6);
    const journal = lifecycle.openControllerLifecycleStore(journalPath, source.ticket);
    journal.patchSnapshot({ controllerProcess: ready.proof, nativeProcesses: [native], lifecycle: "working", activity: "working", nativeStopped: false, stoppedAt: null }); journal.close();
    const original = lifecycle.readWindowsJobSource(journalPath, source.ticket);
    expect(original?.phase).toBe("assigned");
    if (original?.phase !== "assigned") throw new Error("Original guardian source was not assigned.");
    // Each observer exits after releasing its duplicate; the test process never owns a Job handle.
    const observer = `const { openWindowsGuardianJob } = await import(${JSON.stringify(guardianUrl)}); const lease = await openWindowsGuardianJob(${JSON.stringify(original)}); try { process.send(lease.inspect()); } finally { lease.close(); process.disconnect(); }`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const worker = spawn(process.execPath, ["--input-type=module", "-e", observer], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
      children.push(worker);
      const workerExit = once(worker, "exit"); void workerExit.catch(() => {});
      const [inspection] = await Promise.race([once(worker, "message", { signal: AbortSignal.timeout(30_000) }), workerExit.then(() => { throw new Error("Worker could not copy the original guardian Job."); })]) as [{ members: number[]; sealed: boolean }];
      expect(inspection.sealed).toBe(false);
      expect(inspection.members).toEqual(expect.arrayContaining([ready.proof.pid, native.pid]));
      expect((await workerExit)[0]).toBe(0);
    }
    const activation = once(child, "message", { signal: AbortSignal.timeout(15_000) });
    child.send("activate"); expect((await activation)[0]).toEqual({ kind: "activated" });
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("Original Controller did not exit.")), 15_000); timer.unref(); })]);
    expect(await processProof.inspectProcessProof(native)).toBe("running");
    const restartedWorker = spawn(process.execPath, ["--input-type=module", "-e", observer], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    children.push(restartedWorker);
    const restartedExit = once(restartedWorker, "exit"); void restartedExit.catch(() => {});
    const [recovered] = await Promise.race([once(restartedWorker, "message", { signal: AbortSignal.timeout(30_000) }), restartedExit.then(() => { throw new Error("Restarted Worker could not copy the original guardian Job."); })]) as [{ members: number[] }];
    expect(recovered.members).toContain(native.pid);
    expect((await restartedExit)[0]).toBe(0);
    expect(await processProof.inspectProcessProof(original.guardian)).toBe("running");
    process.kill(original.guardian.pid, "SIGKILL");
    await vi.waitFor(async () => expect(await processProof.inspectProcessProof(original.guardian)).toBe("stopped"), { timeout: 15_000, interval: 25 });
    await vi.waitFor(async () => expect(await processProof.inspectProcessProof(native!)).toBe("stopped"), { timeout: 15_000, interval: 25 });
    const { openWindowsGuardianJob } = await import("../../../src/commands/controller/windows-job-guardian.js");
    await expect(openWindowsGuardianJob(original)).rejects.toThrow();
    expect(lifecycle.readWindowsJobSource(journalPath, source.ticket)).toEqual(original);
    expect(lifecycle.readWindowsJobReceipt(journalPath, source.ticket)).toBeNull();
    const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "windows", buildPrompt: () => "managed", emit: () => {}, now: Date.now, request: vi.fn() });
    const operation = createOperation({ limits: { totalMs: 30_000 } });
    try { expect(await backend.observeExecutionStop(task, operation)).toMatchObject({ kind: "unknown" }); }
    finally { operation.dispose(); }
  } catch (error) { console.error("Guardian fixture diagnostic:", await guardianDiagnostic(context)); throw error; }
  finally {
    try {
      await forceOsWriterFixture(child, native);
      if (child.exitCode === null && child.signalCode === null) await Promise.race([exited, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("Controller fixture did not exit.")), 15_000); timer.unref(); })]);
    } finally { await releaseFixtureGuardian(context); }
  }
}, 180_000);

it.skipIf(process.platform !== "win32")("commits the original stop after the guardian dies while a Worker holds its Job", async () => {
  const f = await fixture(), source = await cleanupSource(f, f.store.getTask(f.identity)!);
  vi.restoreAllMocks();
  const journalPath = path.join(launchTickets.controllerExecutionDirectory(f.home, source.ticket.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalPath), { recursive: true });
  lifecycle.openControllerLifecycleStore(journalPath, source.ticket).close();
  const context = { ticket: source.ticket, journalPath };
  const proofUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/commands/controller/process-proof.js")).href;
  const stopUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/commands/controller/controller-stop.js")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", osWriterScript(proofUrl, source.ticket.launchId, false, context)], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  children.push(child);
  const childExit = once(child, "exit"); void childExit.catch(() => {});
  let native: processProof.ProcessProof | undefined, worker: ChildProcess | undefined;
  try {
    const [ready] = await Promise.race([once(child, "message", { signal: AbortSignal.timeout(45_000) }), childExit.then(() => { throw new Error("Controller exited before its guardian was ready."); })]) as [{ kind: string; proof: processProof.ProcessProof; native: processProof.ProcessProof }];
    expect(ready.kind).toBe("ready"); native = ready.native;
    const journal = lifecycle.openControllerLifecycleStore(journalPath, source.ticket);
    journal.patchSnapshot({ controllerProcess: ready.proof, nativeProcesses: [native], lifecycle: "working", activity: "working", nativeStopped: false, stoppedAt: null }); journal.close();
    const original = lifecycle.readWindowsJobSource(journalPath, source.ticket);
    if (original?.phase !== "assigned") throw new Error("Original guardian source was not assigned.");
    const activation = once(child, "message", { signal: AbortSignal.timeout(15_000) });
    child.send("activate"); expect((await activation)[0]).toEqual({ kind: "activated" });
    const workerScript = `
      import { once } from "node:events";
      const { openControllerStop } = await import(${JSON.stringify(stopUrl)});
      const stop = await openControllerStop(${JSON.stringify({ journalPath, ticket: source.ticket, controller: ready.proof, native: [native] })});
      process.send({ kind: "held" });
      await once(process, "message");
      await stop.stop(Date.now() + 30000); await stop.commit(); await stop.close();
      process.send({ kind: "committed" }, () => process.disconnect());
    `;
    worker = spawn(process.execPath, ["--input-type=module", "-e", workerScript], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    children.push(worker);
    const workerExit = once(worker, "exit"); void workerExit.catch(() => {});
    const [held] = await Promise.race([once(worker, "message", { signal: AbortSignal.timeout(30_000) }), workerExit.then(() => { throw new Error("Worker failed to hold the original Job."); })]);
    expect(held).toEqual({ kind: "held" });
    expect(await processProof.inspectProcessProof(original.guardian)).toBe("running");
    process.kill(original.guardian.pid, "SIGKILL");
    await vi.waitFor(async () => expect(await processProof.inspectProcessProof(original.guardian)).toBe("stopped"), { timeout: 15_000, interval: 25 });
    expect(await processProof.inspectProcessProof(native)).toBe("running");
    expect(lifecycle.readWindowsJobReceipt(journalPath, source.ticket)).toBeNull();
    const committed = once(worker, "message", { signal: AbortSignal.timeout(45_000) });
    worker.send("stop");
    expect((await Promise.race([committed, workerExit.then(() => { throw new Error("Worker exited before committing its stop receipt."); })]))[0]).toEqual({ kind: "committed" });
    expect((await workerExit)[0]).toBe(0);
    expect(await processProof.inspectProcessProof(native)).toBe("stopped");
    expect(lifecycle.readWindowsJobReceipt(journalPath, source.ticket)).toMatchObject({ source: original, sealed: true, empty: true, controllerStopped: true, nativeProcessesStopped: true });
  } catch (error) { console.error("Guardian fixture diagnostic:", await guardianDiagnostic(context)); throw error; }
  finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    try { await forceOsWriterFixture(child, native); }
    finally { await releaseFixtureGuardian(context); }
  }
}, 180_000);

it.skipIf(process.platform === "win32")("uses the actual OS process group and controller journal to stop a live original writer", async () => {
  const f = await fixture(), source = await cleanupSource(f, f.store.getTask(f.identity)!);
  vi.restoreAllMocks();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const proof = await processProof.captureProcessProof(child.pid!);
  const task = f.store.updateWebExecution(source.task, { controllerProcess: proof }, 6);
  const journalPath = path.join(launchTickets.controllerExecutionDirectory(f.home, source.ticket.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalPath), { recursive: true });
  const journal = lifecycle.openControllerLifecycleStore(journalPath, source.ticket);
  journal.patchSnapshot({ controllerProcess: proof, lifecycle: "working", activity: "working", nativeStopped: false, stoppedAt: null });
  journal.close();
  expect(await processProof.confirmControllerProcessesStopped(proof, [])).toBe(false);
  const request = vi.fn<typeof requestController>().mockRejectedValue(new Error("Original IPC endpoint is unavailable."));
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 20, request });
  const outcome = await backend.cleanup(task, cleanupRequest(task, "shutdown", 20));
  expect(outcome.complete).toBe(true);
  expect(await processProof.confirmControllerProcessesStopped(proof, [])).toBe(true);
  expect(lifecycle.readControllerSnapshot(journalPath)).toMatchObject({ lifecycle: "stopped", nativeStopped: true, controllerProcess: proof });
  expect(f.git.removeWorktree).not.toHaveBeenCalled();
});
