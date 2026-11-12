import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
const native = vi.hoisted(() => ({ spawn: vi.fn(), observe: vi.fn(), capture: vi.fn(), reconcile: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: native.spawn }));
vi.mock("../../../src/commands/controller/local-client.js", () => ({ requestController: native.observe }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureProcessProof: native.capture }));
vi.mock("../../../src/commands/controller/launch-observation.js", () => ({ reconcileSubmittedControllerLaunch: native.reconcile }));
import { controllerExecutionDirectory } from "../../../src/commands/controller/launch-ticket.js";
import { createControllerExecutionSerializer, launchControllerProcess, observeControllerProcess } from "../../../src/commands/worker/backends/controller-process.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-process"); await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "h-")); roots.push(homeDirectory);
  const executionId = randomUUID(), sessionId = randomUUID(), launchId = randomUUID(), controllerInstanceId = randomUUID();
  await mkdir(controllerExecutionDirectory(homeDirectory, executionId), { recursive: true });
  const ticket = { launchId, executionId, sessionId, controllerInstanceId, testExecutionId: executionId, executionGeneration: "1", cwd: homeDirectory, provider: "codex" } as ControllerLaunchTicket;
  const snapshot: ControllerSnapshot = { executionId, sessionId, controllerInstanceId, testExecutionId: executionId, executionGeneration: "1", lifecycle: "starting", nativeProcesses: [], nativeSessionId: null, initialInputState: "not_required", activity: "initializing", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, controllerProcess: null, nativeStopped: false, stoppedAt: null, error: null };
  const proof = { pid: 987, parentPid: 1, processGroupId: 987, startedAt: "original", commandHash: "a".repeat(64) };
  const child = Object.assign(new EventEmitter(), { pid: 987, exitCode: null, signalCode: null, unref: vi.fn() });
  const order: string[] = [];
  native.spawn.mockImplementation(() => { order.push("spawn"); queueMicrotask(() => child.emit("spawn")); return child; });
  native.capture.mockImplementation(async () => { order.push("capture"); return proof; });
  native.observe.mockImplementation(async () => { order.push("observe"); return { snapshot }; });
  native.reconcile.mockImplementation(async () => { order.push("observe"); return { kind: "observed", snapshot }; });
  const options = { homeDirectory, packageDirectory: homeDirectory, ticket, env: { HOME: "/real/home", PATH: "/real/path", DN_CONFIG_DIR: "/worker/state" }, signal: new AbortController().signal,
    onSubmitting: async () => { order.push("submitting"); }, onSpawned: async () => { order.push("spawned"); }, onObserved: async () => { order.push("observed"); } };
  return { options, order, child, snapshot, proof };
};

test("persists submission and process identity before authenticated observation while preserving the launch environment", async () => {
  const f = await fixture();
  expect(await launchControllerProcess(f.options)).toBe(f.snapshot);
  expect(f.order).toEqual(["submitting", "spawn", "capture", "spawned", "observe", "observed"]);
  expect(native.spawn).toHaveBeenCalledWith(process.execPath, [path.join(f.options.packageDirectory, "dist", "main.js"), "controller", "codex", "--launch-id", f.options.ticket.launchId], expect.objectContaining({ cwd: f.options.ticket.cwd, env: f.options.env, detached: process.platform !== "win32", windowsHide: true }));
  expect(f.child.unref).toHaveBeenCalledOnce();
});

test("does not spawn when durable submission fails", async () => {
  const f = await fixture(), failure = new Error("submission storage unavailable");
  await expect(launchControllerProcess({ ...f.options, onSubmitting: () => { throw failure; } })).rejects.toBe(failure);
  expect(native.spawn).not.toHaveBeenCalled();
});

test("does not repeat launch or observation after acknowledgement storage fails", async () => {
  const f = await fixture(), failure = new Error("acknowledgement storage unavailable");
  await expect(launchControllerProcess({ ...f.options, onObserved: () => { throw failure; } })).rejects.toBe(failure);
  expect(native.spawn).toHaveBeenCalledOnce(); expect(native.reconcile).toHaveBeenCalledOnce();
});

test("retains the original spawn outcome when process proof cannot be captured", async () => {
  const f = await fixture(), failure = new Error("process identity unavailable"); native.capture.mockRejectedValue(failure);
  await expect(launchControllerProcess(f.options)).rejects.toBe(failure);
  expect(f.order).toEqual(["submitting", "spawn"]); expect(native.spawn).toHaveBeenCalledOnce(); expect(native.observe).not.toHaveBeenCalled();
});

test("reports an exited controller without an authenticated response as unknown", async () => {
  const f = await fixture(); native.reconcile.mockResolvedValue({ kind: "pre-writer-exited", process: f.proof, journal: "missing" });
  await expect(launchControllerProcess(f.options)).rejects.toMatchObject({ observation: { state: "unknown", reasonCode: "controller_start_unknown" } });
  expect(native.spawn).toHaveBeenCalledOnce();
});

test("keeps observing one spawned instance through the launch window without acknowledging it", async () => {
  const f = await fixture();
  native.reconcile.mockResolvedValue({ kind: "running-unobserved", process: f.proof });
  let started!: () => void;
  const spawned = new Promise<void>(resolve => { started = resolve; });
  const pending = launchControllerProcess({ ...f.options, onSpawned: () => { vi.useFakeTimers(); started(); } });
  const result = expect(pending).rejects.toMatchObject({ observation: { state: "unknown", reasonCode: "controller_start_unknown" } });
  await spawned;
  await vi.advanceTimersByTimeAsync(30_100);
  await result;
  expect(native.spawn).toHaveBeenCalledOnce();
  expect(native.reconcile.mock.calls.every(([input]) => input.spawnProof === f.proof && input.ticket === f.options.ticket)).toBe(true);
  expect(f.order).not.toContain("observed");
});

test("observes the original ticket without spawning or submitting user input", async () => {
  const f = await fixture();
  expect(await observeControllerProcess(f.options.ticket, f.options.signal)).toBe(f.snapshot);
  expect(native.observe).toHaveBeenCalledWith(f.options.ticket, { kind: "observe" }, { signal: f.options.signal, timeoutMs: 1000 });
  expect(native.spawn).not.toHaveBeenCalled();
});

test("serializes the same execution, releases failures, and permits unrelated executions", async () => {
  const serialize = createControllerExecutionSerializer(), order: string[] = [];
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const first = serialize("one", async () => { order.push("first"); await wait; throw new Error("first failed"); });
  const rejected = expect(first).rejects.toThrow("first failed");
  const second = serialize("one", async () => { order.push("second"); });
  await serialize("two", async () => { order.push("independent"); });
  expect(order).toEqual(["first", "independent"]);
  release(); await rejected; await second;
  expect(order).toEqual(["first", "independent", "second"]);
});
