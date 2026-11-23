import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
const native = vi.hoisted(() => ({ spawn: vi.fn(), observe: vi.fn(), capture: vi.fn(), reconcile: vi.fn(), prepare: vi.fn(), suspended: vi.fn(), job: vi.fn(), retainJob: vi.fn(), releaseJob: vi.fn() }));
vi.mock("../../../src/platform/windows-suspended-process.js", () => ({ createSuspendedProcess: native.suspended }));
vi.mock("../../../src/commands/controller/windows-job.js", () => ({ createControllerJobLease: native.job, releaseControllerJobLease: native.releaseJob }));
vi.mock("node:child_process", () => ({ spawn: native.spawn }));
vi.mock("../../../src/commands/controller/local-client.js", () => ({ requestController: native.observe }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureProcessProof: native.capture }));
vi.mock("../../../src/commands/controller/launch-observation.js", () => ({ reconcileSubmittedControllerLaunch: native.reconcile }));
vi.mock("../../../src/commands/controller/storage-preparation.js", async importOriginal => ({ ...await importOriginal<typeof import("../../../src/commands/controller/storage-preparation.js")>(), prepareControllerStorage: native.prepare }));
import { createControllerJobLeases } from "../../../src/commands/worker/backends/controller-job-leases.js";
import { controllerExecutionDirectory } from "../../../src/commands/controller/launch-ticket.js";
import { createControllerExecutionSerializer, launchControllerProcess, observeControllerProcess } from "../../../src/commands/worker/backends/controller-process.js";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-process"); await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "h-")); roots.push(homeDirectory);
  const executionId = randomUUID(), sessionId = randomUUID(), launchId = randomUUID(), controllerInstanceId = randomUUID();
  await mkdir(controllerExecutionDirectory(homeDirectory, executionId), { recursive: true });
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId, executionId, sessionId, controllerId: randomUUID(), controllerInstanceId, testExecutionId: executionId, executionGeneration: "1", cwd: homeDirectory, provider: "codex",
    serverOrigin: "https://daynight.example", ownerUserId: randomUUID(), nativeHome: path.join(homeDirectory, "native"), initialInput: "none", initialPrompt: "", initialOperationId: randomUUID(), resumeNativeSessionId: null,
    configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, credentialFile: path.join(homeDirectory, "grant.json"), ipcEndpoint: path.join(homeDirectory, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const snapshot: ControllerSnapshot = { executionId, sessionId, controllerInstanceId, testExecutionId: executionId, executionGeneration: "1", lifecycle: "starting", nativeProcesses: [], nativeSessionId: null, initialInputState: "not_required", activity: "initializing", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, controllerProcess: null, nativeStopped: false, stoppedAt: null, error: null };
  const proof = { pid: 987, parentPid: 1, processGroupId: 987, startedAt: "original", commandHash: "a".repeat(64) };
  const child = Object.assign(new EventEmitter(), { pid: 987, exitCode: null, signalCode: null, connected: true,
    unref: vi.fn(), send: vi.fn(() => order.push("resume")), kill: vi.fn(() => { queueMicrotask(() => child.emit("close")); }),
    resume: vi.fn(() => order.push("resume")), terminate: vi.fn(), hasExited: vi.fn(() => true), close: vi.fn(), releaseAfterResume: vi.fn() });
  const order: string[] = [];
  native.prepare.mockImplementation(() => { order.push("prepare"); return { kind: "prepared", snapshot: null, legacyTimelineCleanupPending: false }; });
  native.spawn.mockImplementation(() => { order.push("spawn"); queueMicrotask(() => child.emit("spawn")); return child; });
  native.suspended.mockImplementation(async () => { order.push("spawn"); return child; });
  native.job.mockImplementation(async () => { order.push("assign"); return {}; });
  native.capture.mockImplementation(async () => { order.push("capture"); return proof; });
  native.observe.mockImplementation(async () => { order.push("observe"); return { snapshot }; });
  native.reconcile.mockImplementation(async () => { order.push("observe"); return { kind: "observed", snapshot }; });
  const options = { homeDirectory, packageDirectory: homeDirectory, ticket, env: { HOME: "/real/home", PATH: "/real/path", DN_CONFIG_DIR: "/worker/state" }, signal: new AbortController().signal,
    retainBirthCleanup: () => () => {},
    onSubmitting: async () => { order.push("submitting"); }, onSpawned: async () => { order.push("spawned"); }, onObserved: async () => { order.push("observed"); } };
  return { options, order, child, snapshot, proof };
};

test("persists submission and process identity before authenticated observation while preserving the launch environment", async () => {
  const f = await fixture();
  expect(await launchControllerProcess(f.options)).toBe(f.snapshot);
  expect(f.order).toEqual(["prepare", "submitting", "spawn", "capture", ...(process.platform === "win32" ? ["assign"] : []), "spawned", "resume", "observe", "observed"]);
  if (process.platform === "win32") {
    expect(native.suspended).toHaveBeenCalledWith(expect.objectContaining({ cwd: f.options.ticket.cwd, environment: expect.objectContaining(f.options.env) }));
    expect(f.child.resume).toHaveBeenCalledOnce();
  } else {
    expect(native.spawn).toHaveBeenCalledWith(process.execPath, [expect.stringContaining("controller-bootstrap.js"), path.join(f.options.packageDirectory, "dist", "main.js"), "codex", f.options.ticket.launchId, expect.stringContaining("controller.log")], expect.objectContaining({ cwd: f.options.ticket.cwd, env: f.options.env, detached: true, windowsHide: true }));
    expect(f.child.unref).toHaveBeenCalledOnce();
  }
});

test("does not spawn when durable submission fails", async () => {
  const f = await fixture(), failure = new Error("submission storage unavailable");
  await expect(launchControllerProcess({ ...f.options, onSubmitting: () => { throw failure; } })).rejects.toBe(failure);
  expect(native.spawn).not.toHaveBeenCalled();
});

test("prepares and observes the dedicated journal and passes its location without changing CLI authentication", async () => {
  const f = await fixture(), storageStateDirectory = path.join(f.options.homeDirectory, "bots", randomUUID());
  const directory = controllerExecutionDirectory(f.options.homeDirectory, f.options.ticket.executionId, storageStateDirectory);
  await mkdir(directory, { recursive: true });
  await launchControllerProcess({ ...f.options, storageStateDirectory });
  expect(native.prepare).toHaveBeenCalledWith(expect.objectContaining({ journalFile: path.join(directory, "journal.sqlite") }), expect.anything());
  expect(native.reconcile).toHaveBeenCalledWith(expect.objectContaining({ journalFile: path.join(directory, "journal.sqlite") }));
  expect((process.platform === "win32" ? native.suspended.mock.calls[0]![0].environment : native.spawn.mock.calls[0]![2].env)).toEqual({ ...f.options.env, DAYNIGHT_CONTROLLER_STORAGE_DIR: storageStateDirectory, ...(process.platform === "win32" ? { DAYNIGHT_CONTROLLER_ASSIGNED_JOB: f.options.ticket.launchId } : {}) });
  expect(f.options.env).not.toHaveProperty("DAYNIGHT_CONTROLLER_STORAGE_DIR");
});

test("keeps a synchronous submission check and spawn in the same event-loop turn", async () => {
  const f = await fixture();
  let admission = true, admittedAtSpawn = false;
  (process.platform === "win32" ? native.suspended : native.spawn).mockImplementationOnce(() => {
    admittedAtSpawn = admission;
    f.order.push("spawn");
    queueMicrotask(() => f.child.emit("spawn"));
    return f.child;
  });
  await launchControllerProcess({ ...f.options, onSubmitting: () => {
    expect(admission).toBe(true);
    f.order.push("submitting");
    queueMicrotask(() => { admission = false; });
  } });
  expect(admittedAtSpawn).toBe(true);
  expect(admission).toBe(false);
  expect(process.platform === "win32" ? native.suspended : native.spawn).toHaveBeenCalledOnce();
});

test("awaits asynchronous durable submission before spawning", async () => {
  const f = await fixture();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const committed = new Promise<void>(resolve => { release = resolve; });
  const pending = launchControllerProcess({ ...f.options, onSubmitting: async () => {
    enter();
    await committed;
    f.order.push("submitting");
  } });
  await entered;
  expect(native.spawn).not.toHaveBeenCalled();
  release();
  await expect(pending).resolves.toBe(f.snapshot);
  expect(f.order).toEqual(["prepare", "submitting", "spawn", "capture", ...(process.platform === "win32" ? ["assign"] : []), "spawned", "resume", "observe", "observed"]);
});

test("keeps the original launch unsubmitted while another writer owns storage", async () => {
  const f = await fixture();
  const journal = path.join(controllerExecutionDirectory(f.options.homeDirectory, f.options.ticket.executionId), "journal.sqlite");
  const permit = acquireControllerStoragePermit(journal);
  try {
    await expect(launchControllerProcess(f.options)).rejects.toMatchObject({ reason: "lock_busy" });
    expect(f.order).toEqual([]);
    expect(native.spawn).not.toHaveBeenCalled();
    expect(native.prepare).not.toHaveBeenCalled();
  } finally { permit.release(); }
  await expect(launchControllerProcess(f.options)).resolves.toBe(f.snapshot);
  expect(process.platform === "win32" ? native.suspended : native.spawn).toHaveBeenCalledOnce();
});

test("releases preflight storage after a reader wait and submits only after admission", async () => {
  const f = await fixture(), cause = new Error("Previous readers remain active.");
  native.prepare.mockReturnValueOnce({ kind: "waiting", reason: "reader_busy", cause });
  await expect(launchControllerProcess(f.options)).rejects.toMatchObject({ reason: "reader_busy", cause });
  expect(native.spawn).not.toHaveBeenCalled();
  expect(f.order).not.toContain("submitting");
  await expect(launchControllerProcess(f.options)).resolves.toBe(f.snapshot);
  expect(process.platform === "win32" ? native.suspended : native.spawn).toHaveBeenCalledOnce();
});

test("does not repeat launch or observation after acknowledgement storage fails", async () => {
  const f = await fixture(), failure = new Error("acknowledgement storage unavailable");
  await expect(launchControllerProcess({ ...f.options, onObserved: () => { throw failure; } })).rejects.toBe(failure);
  expect(process.platform === "win32" ? native.suspended : native.spawn).toHaveBeenCalledOnce(); expect(native.reconcile).toHaveBeenCalledOnce();
});

test("retains the original spawn outcome when process proof cannot be captured", async () => {
  const f = await fixture(), failure = new Error("process identity unavailable"); native.capture.mockRejectedValue(failure);
  await expect(launchControllerProcess(f.options)).rejects.toBe(failure);
  expect(f.order).toEqual(["prepare", "submitting", "spawn"]); expect(process.platform === "win32" ? native.suspended : native.spawn).toHaveBeenCalledOnce(); expect(native.observe).not.toHaveBeenCalled();
});

test("reports an exited controller without an authenticated response as unknown", async () => {
  const f = await fixture(); native.reconcile.mockResolvedValue({ kind: "pre-writer-exited", process: f.proof, journal: "missing" });
  await expect(launchControllerProcess(f.options)).rejects.toMatchObject({ observation: { state: "unknown", reasonCode: "controller_start_unknown" } });
  expect(process.platform === "win32" ? native.suspended : native.spawn).toHaveBeenCalledOnce();
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
  expect(process.platform === "win32" ? native.suspended : native.spawn).toHaveBeenCalledOnce();
  expect(native.reconcile.mock.calls.every(([input]) => input.spawnProof.pid === f.proof.pid && input.ticket === f.options.ticket)).toBe(true);
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

test("does not release the Controller gate when its birth proof cannot be committed", async () => {
  const f = await fixture(), failure = new Error("birth proof storage failed");
  await expect(launchControllerProcess({ ...f.options, onSpawned: () => { throw failure; } })).rejects.toBe(failure);
  expect(f.child.send).not.toHaveBeenCalled();
  expect(f.child.resume).not.toHaveBeenCalled();
  expect(native.reconcile).not.toHaveBeenCalled();
});

test("rechecks cancellation after the birth proof commit before releasing the Controller gate", async () => {
  const f = await fixture(), abort = new AbortController();
  const entered = Promise.withResolvers<void>(), commit = Promise.withResolvers<void>();
  const pending = launchControllerProcess({ ...f.options, signal: abort.signal, onSpawned: async () => { entered.resolve(); await commit.promise; } });
  const rejected = expect(pending).rejects.toThrow("cancelled before Controller gate");
  await entered.promise;
  abort.abort(new Error("cancelled before Controller gate")); commit.resolve();
  await rejected;
  expect(f.child.send).not.toHaveBeenCalled(); expect(f.child.resume).not.toHaveBeenCalled();
  expect(native.reconcile).not.toHaveBeenCalled();
});


test("retains failed pre-dispatch native cleanup in the original owner for bounded reconciliation", async () => {
  const f = await fixture(), owner = createControllerJobLeases(process.platform);
  const stop = process.platform === "win32" ? f.child.terminate : f.child.kill;
  stop.mockImplementationOnce(() => { throw new Error("native stop temporarily unavailable"); });
  const pending = launchControllerProcess({ ...f.options,
    retainBirthCleanup: cleanup => owner.retainBirthCleanup(f.options.ticket.launchId, cleanup),
    onSpawned: () => { throw new Error("birth proof commit failed"); },
  });
  await expect(pending).rejects.toThrow("retained original birth handles");
  expect(stop).toHaveBeenCalledOnce(); expect(f.child.send).not.toHaveBeenCalled(); expect(f.child.resume).not.toHaveBeenCalled();
  await owner.cleanupBirth(f.options.ticket.launchId, Date.now() + 5000);
  expect(stop).toHaveBeenCalledTimes(2);
  await owner.close();
  expect(stop).toHaveBeenCalledTimes(2);
  expect(process.platform === "win32" ? native.suspended : native.spawn).toHaveBeenCalledOnce();
});
