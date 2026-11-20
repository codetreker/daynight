import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { workerOperation } from "../../../src/commands/worker/execution.js";
import { createWebExecutionBackend } from "../../../src/commands/worker/backends/web.js";
import { ExecutionSourceConflictError } from "../../../src/commands/worker/execution-stop.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as launchObservation from "../../../src/commands/controller/launch-observation.js";
import { createWebBackendFixtures } from "./web-backend.fixtures.js";

const { fixture, cleanupSource, recoveryFixture } = createWebBackendFixtures("memory");

it("re-reads the journal after the Controller stops and observes newly recorded providers", async () => {
  const f = await fixture();
  const source = await cleanupSource(f, f.store.getTask(f.identity)!);
  const native = { pid: 988, parentPid: 987, processGroupId: 987, startedAt: "native", commandHash: "b".repeat(64) };
  source.saved.mockReturnValueOnce(source.snapshot).mockReturnValueOnce({ ...source.snapshot, nativeProcesses: [native] });
  const inspect = vi.spyOn(processProof, "inspectProcessProof").mockResolvedValueOnce("stopped").mockResolvedValueOnce("running");
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 10 });
  const observation = await workerOperation(operation => backend.observeExecutionStop(source.task, operation));
  expect(observation.kind).toBe("running");
  expect(inspect.mock.calls.map(([proof]) => proof)).toEqual([source.snapshot.controllerProcess, native]);
});

it("reports conflicting journal identity and process inspection errors as unknown", async () => {
  const f = await fixture();
  const source = await cleanupSource(f, f.store.getTask(f.identity)!);
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 10 });
  const inspect = vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("stopped");
  source.saved.mockReturnValueOnce(source.snapshot).mockReturnValueOnce({ ...source.snapshot, controllerInstanceId: randomUUID() });
  const conflict = await workerOperation(operation => backend.observeExecutionStop(source.task, operation));
  expect(conflict).toMatchObject({ kind: "unknown", error: expect.any(ExecutionSourceConflictError) });
  const failure = new Error("process access denied");
  inspect.mockRejectedValueOnce(failure);
  expect(await workerOperation(operation => backend.observeExecutionStop(source.task, operation))).toMatchObject({ kind: "unknown", error: failure });
});

it("keeps execution running while unrecorded descendants remain in the original boundary", async () => {
  const f = await fixture();
  const source = await cleanupSource(f, f.store.getTask(f.identity)!);
  vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("stopped");
  source.stopped.mockResolvedValue(false);
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 10 });
  expect(await workerOperation(operation => backend.observeExecutionStop(source.task, operation))).toMatchObject({ kind: "running" });
  expect(source.stopped).toHaveBeenCalledWith(source.snapshot.controllerProcess, source.snapshot.nativeProcesses, expect.any(Number));
  source.stopped.mockResolvedValue(true);
  expect(await workerOperation(operation => backend.observeExecutionStop(source.task, operation))).toMatchObject({ kind: "stopped" });
});

it.each(["empty", "occupied", "conflict"] as const)("confirms the original complete boundary after replaced process evidence: %s", async boundary => {
  const f = await fixture();
  const source = await cleanupSource(f, f.store.getTask(f.identity)!);
  const native = { pid: 988, parentPid: 987, processGroupId: 987, startedAt: "native", commandHash: "b".repeat(64) };
  source.saved.mockReturnValue({ ...source.snapshot, nativeProcesses: [native] });
  const inspect = vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("replaced");
  const conflict = new Error("An original process has conflicting identity evidence");
  if (boundary === "conflict") source.stopped.mockRejectedValue(conflict);
  else source.stopped.mockResolvedValue(boundary === "empty");
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 10 });
  const observed = await workerOperation(operation => backend.observeExecutionStop(source.task, operation));
  expect(observed).toMatchObject(boundary === "conflict" ? { kind: "unknown", error: conflict } : { kind: boundary === "empty" ? "stopped" : "running" });
  expect(inspect.mock.calls.map(([proof]) => proof)).toEqual([source.snapshot.controllerProcess, native]);
  expect(source.stopped).toHaveBeenCalledWith(source.snapshot.controllerProcess, [native], expect.any(Number));
});

it("confirms the preceding boundary after PID reuse before releasing unsubmitted recovery", async () => {
  const f = await recoveryFixture();
  const allocated = f.store.beginWebGeneration(f.task, f.snapshot, 30);
  vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("replaced");
  f.stopped.mockResolvedValue(true);
  expect(await workerOperation(operation => f.backend.observeExecutionStop(allocated, operation))).toMatchObject({ kind: "not-started" });
  expect(f.stopped).toHaveBeenCalledWith(f.snapshot.controllerProcess, f.snapshot.nativeProcesses, expect.any(Number));
});

it("retains occupied capacity when recorded PIDs stopped but the native boundary is unknown", async () => {
  const f = await fixture();
  const source = await cleanupSource(f, f.store.getTask(f.identity)!);
  const failure = new Error("resource group unavailable");
  const bootstrapFailure = new Error("bootstrap stop failed");
  const bootstrap = vi.spyOn(launchObservation, "stopControllerBootstrap").mockRejectedValue(bootstrapFailure);
  const events: string[] = [];
  vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("stopped");
  source.stopped.mockImplementation(async () => { events.push("resource check"); throw failure; });
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 10, request: source.request });
  const attempt = { attemptId: randomUUID(), owner: source.task };
  const notices: unknown[] = [];
  const error = await backend.cleanup(source.task, { kind: "terminal", deadline: 10, immediateStop: true, scope: { attempt, onExecutionStopped: notice => { events.push("notice"); notices.push(notice); } } }).catch(error => error);
  expect(error.stage).toBe("agent-stop"); expect(error.cause.errors[0].errors).toEqual([failure, failure]); expect(error.cause.errors[1]).toBe(bootstrapFailure);
  expect(bootstrap).toHaveBeenCalledWith(source.task.webExecution!.controllerProcess, expect.any(Number));
  expect(events).toEqual(["resource check", "resource check", "resource check"]);
  expect(notices).toHaveLength(0);
  expect(f.git.removeWorktree).not.toHaveBeenCalled();
});

it("reports unknown observation and retains it with a resource stop error", async () => {
  const f = await fixture();
  const source = await cleanupSource(f, f.store.getTask(f.identity)!);
  const cause = new Error("process source denied"), resourceError = new Error("resource check failed"), observationError = new Error("process inspection failed", { cause });
  const bootstrapFailure = new Error("bootstrap stop failed");
  const bootstrap = vi.spyOn(launchObservation, "stopControllerBootstrap").mockRejectedValue(bootstrapFailure);
  vi.spyOn(processProof, "inspectProcessProof").mockRejectedValue(observationError);
  source.stopped.mockRejectedValue(resourceError);
  const emit = vi.fn();
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit, now: () => 10, request: source.request });
  const notice = vi.fn();
  const error = await backend.cleanup(source.task, { kind: "terminal", deadline: 10, immediateStop: true, scope: { attempt: { attemptId: randomUUID(), owner: source.task }, onExecutionStopped: notice } }).catch(error => error);
  expect(error.stage).toBe("agent-stop"); expect(error.cause.errors[0].errors).toEqual([resourceError, observationError]); expect(error.cause.errors[1]).toBe(bootstrapFailure);
  expect(bootstrap).toHaveBeenCalledWith(source.task.webExecution!.controllerProcess, expect.any(Number));
  expect(notice).not.toHaveBeenCalled();
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "execution-stop-observation-error", task: source.task, error: observationError }));
});

it("notifies a stopped execution before a pending Controller IPC observation", async () => {
  const f = await fixture();
  const source = await cleanupSource(f, f.store.getTask(f.identity)!);
  vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("stopped");
  let entered!: () => void, release!: () => void;
  const enteredIpc = new Promise<void>(resolve => { entered = resolve; });
  const ipc = new Promise<void>(resolve => { release = resolve; });
  source.request.mockImplementation(async () => { entered(); await ipc; return { requestId: randomUUID(), ok: true, snapshot: source.snapshot }; });
  const notices: string[] = [];
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 10, archive: async () => {}, request: source.request });
  const work = backend.cleanup(source.task, { kind: "terminal", deadline: 10, immediateStop: true, scope: { attempt: { attemptId: randomUUID(), owner: source.task }, onExecutionStopped: notice => { notices.push(notice.observation.kind); } } });
  try {
    await enteredIpc;
    expect(notices).toEqual(["stopped"]);
    expect(source.stopped).toHaveBeenCalledTimes(1);
  } finally { release(); await work; }
});

it("retains unsubmitted recovery capacity until the preceding native boundary is proven stopped", async () => {
  const f = await recoveryFixture();
  const allocated = f.store.beginWebGeneration(f.task, f.snapshot, 30);
  const failure = new Error("predecessor resource check failed");
  const order: string[] = [];
  vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("stopped");
  f.stopped.mockImplementation(async () => { order.push("resource check"); throw failure; });
  const notices: string[] = [];
  const error = await f.backend.cleanup(allocated, { kind: "terminal", deadline: 40, immediateStop: true, scope: { attempt: { attemptId: randomUUID(), owner: allocated }, onExecutionStopped: notice => { order.push("notice"); notices.push(notice.observation.kind); } } }).catch(cause => cause);
  expect(error).toMatchObject({ stage: "agent-stop", cause: expect.any(AggregateError) });
  expect(error.cause.errors).toEqual([failure, failure]);
  expect(order).toEqual(["resource check", "resource check", "resource check"]);
  expect(notices).toEqual([]);
  expect(f.git.removeWorktree).not.toHaveBeenCalled();
});
