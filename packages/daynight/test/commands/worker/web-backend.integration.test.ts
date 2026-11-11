import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
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
import type { requestController } from "../../../src/commands/controller/local-client.js";
import { createWebBackendFixtures } from "./web-backend.fixtures.js";

const { children, stores, fixture, cleanupSource, recoveryFixture } = createWebBackendFixtures("file");

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
  const source = await cleanupSource(f, task);
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
  const outcome = await backend.cleanup(task, { kind: "shutdown", deadline: 20, immediateStop: true });
  expect(outcome.complete).toBe(true);
  expect(await processProof.confirmControllerProcessesStopped(proof, [])).toBe(true);
  expect(lifecycle.readControllerSnapshot(journalPath)).toMatchObject({ lifecycle: "stopped", nativeStopped: true, controllerProcess: proof });
  expect(f.git.removeWorktree).not.toHaveBeenCalled();
});
