import { createOperation } from "../../../src/api/operation.js";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import type { CleanupRequest } from "../../../src/commands/worker/execution-stop.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
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

const cleanupRequest = (owner: { projectId: string; taskId: string; claimId: string; worktreeId: string }, kind: "terminal" | "shutdown", deadline: number): CleanupRequest => kind === "shutdown"
  ? { kind, deadline, immediateStop: true }
  : { kind, deadline, immediateStop: false, scope: { attempt: { attemptId: "test", owner }, onExecutionStopped: () => {} } };

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

const osWriterScript = (moduleUrl: string, launchId: string, failCapture = false): string => {
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
    const proof = await captureControllerProcessProof(${JSON.stringify(launchId)});
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
  const child = spawn(process.execPath, ["--input-type=module", "-e", osWriterScript(moduleUrl, randomUUID(), true)], { detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
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
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const joined = once(child, "message", { signal: AbortSignal.timeout(15_000) });
      child.send("abort");
      expect((await joined)[0]).toMatchObject({ kind: "aborted" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exited, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Fixture leader did not exit after descendant join.")), 15_000); })]); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }
  }
}, 90_000);

it.each(["lost activation receipt", "leader crash before activation"] as const)("reaps the descendant after %s", async scenario => {
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/commands/controller/process-proof.js")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", osWriterScript(moduleUrl, randomUUID())], { detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
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
  } finally {
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
  }
}, 90_000);

it("observes the original OS writer stop before terminal archive joins", async () => {
  const f = await fixture(), source = await cleanupSource(f, f.store.getTask(f.identity)!);
  vi.restoreAllMocks();
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/commands/controller/process-proof.js")).href;
  const script = osWriterScript(moduleUrl, source.ticket.launchId);
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
    const journalPath = path.join(launchTickets.controllerExecutionDirectory(f.home, source.ticket.executionId), "journal.sqlite");
    await mkdir(path.dirname(journalPath), { recursive: true });
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
      const { inspectControllerJob } = await import("../../../src/commands/controller/windows-job.js");
      expect(proof.jobObjectName).toBeDefined();
      expect(await inspectControllerJob(proof.jobObjectName!)).toEqual(expect.arrayContaining([proof.pid, native.pid]));
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
    expect(await processProof.confirmControllerProcessesStopped(proof, [native])).toBe(true);
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  } catch (error) {
    console.error(JSON.stringify({ fixture: "web-stop-os-writer", stage, platform: process.platform, pid: proof?.pid ?? child.pid, descendantPid, jobObjectName: proof?.jobObjectName ?? null, exitCode: child.exitCode, signalCode: child.signalCode, stderr: stderr.slice(0, 2048) }));
    throw error;
  } finally {
    release(); operation.dispose();
    try { if (cleanup !== undefined) await bounded(cleanup, 60_000, "Cleanup join"); }
    finally {
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
    }
  }
}, 240_000);

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
