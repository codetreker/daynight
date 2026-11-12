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

it("notifies stopped capacity before a resource stop failure while retaining that failure", async () => {
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
  expect(error.stage).toBe("agent-stop"); expect(error.cause.errors).toEqual([failure, bootstrapFailure]);
  expect(bootstrap).toHaveBeenCalledWith(source.task.webExecution!.controllerProcess, expect.any(Number));
  expect(events).toEqual(["notice", "resource check", "notice"]);
  expect(notices).toHaveLength(2);
  expect(notices[0]).toMatchObject({ attempt, observation: { kind: "stopped", execution: { backend: "web" } } });
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
    expect(source.stopped).not.toHaveBeenCalled();
  } finally { release(); await work; }
});

it("releases an unsubmitted recovery after its recorded predecessor stops despite resource check failure", async () => {
  const f = await recoveryFixture();
  const allocated = f.store.beginWebGeneration(f.task, f.snapshot, 30);
  const failure = new Error("predecessor resource check failed");
  const order: string[] = [];
  vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("stopped");
  f.stopped.mockImplementation(async () => { order.push("resource check"); throw failure; });
  const notices: string[] = [];
  await expect(f.backend.cleanup(allocated, { kind: "terminal", deadline: 40, immediateStop: true, scope: { attempt: { attemptId: randomUUID(), owner: allocated }, onExecutionStopped: notice => { order.push("notice"); notices.push(notice.observation.kind); } } })).rejects.toMatchObject({ stage: "agent-stop", cause: failure });
  expect(order).toEqual(["notice", "resource check", "notice"]);
  expect(notices).toEqual(["not-started", "not-started"]);
  expect(f.git.removeWorktree).not.toHaveBeenCalled();
});
