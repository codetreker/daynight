import * as childProcesses from "node:child_process";
import { setImmediate as yieldNative } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as suspendedChildren from "../../../src/commands/worker/suspended-node-child.js";
import { isWorkerCancellation } from "../../../src/commands/worker/execution.js";
import { withinExecutionDeadline } from "../../../src/commands/worker/execution-scope.js";
import { hasUnconfirmedOwnedCommandCleanup, isConfirmedOwnedCommandCleanupWait, OwnedCommandCleanupError } from "../../../src/commands/worker/owned-command.js";
import { ownedCommandClosure, reconcileOwnedCommandBoundary, retainedOwnedCommandBoundaries, runLifecycleOwnedCommand, type OwnedCommandLifecycleEvent } from "../../../src/commands/worker/owned-command-lifecycle.js";
import { captureSynchronousDeadline } from "../../helpers/synchronous-deadline.js";

vi.mock("node:child_process", { spy: true });
afterEach(() => vi.restoreAllMocks());

type Launcher = childProcesses.ChildProcess | suspendedChildren.GatedNodeChild;
const observeLauncher = async (observe: (child: Launcher) => void = () => {}) => {
  const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  let child: Launcher | undefined;
  vi.spyOn(childProcesses, "spawn").mockImplementationOnce((...args: Parameters<typeof native.spawn>) => {
    child = native.spawn(...args); observe(child); return child;
  });
  const suspend = suspendedChildren.createSuspendedNodeChild;
  vi.spyOn(suspendedChildren, "createSuspendedNodeChild").mockImplementationOnce(async options => {
    const result = await suspend(options); child = result.child; observe(child); return result;
  });
  return () => child!;
};

const helperFailures = {
  helper: { message: { kind: "io-error" }, expected: { message: "Owned command input or output capture failed." } },
  spawn: { message: { kind: "spawn-error", missing: true }, expected: { message: "Cannot execute the owned prerequisite command.", code: "ENOENT" } },
  malformed: { message: { kind: "result", code: 0 }, expected: { message: "Incomplete owned launcher result." } },
};

it.skipIf(process.platform !== "linux")("joins the original close and late IPC before confirming a timed-out TERM", async () => {
  const ready = Promise.withResolvers<void>(), result = Promise.withResolvers<void>(), heldClose = Promise.withResolvers<void>(), processStopped = Promise.withResolvers<void>();
  let releaseClose: (() => void) | undefined, restoreEmit: (() => void) | undefined;
  const child = await observeLauncher(launcher => {
    const emit = launcher.emit, descriptor = Object.getOwnPropertyDescriptor(launcher, "emit");
    const deliver = (event: string | symbol, ...args: unknown[]) => Reflect.apply(emit, launcher, [event, ...args]) as boolean;
    Object.defineProperty(launcher, "emit", { configurable: true, writable: true, value: (event: string | symbol, ...args: unknown[]) => {
      if (event === "close") {
        releaseClose = () => { deliver("close", ...args); };
        heldClose.resolve();
        return true;
      }
      return deliver(event, ...args);
    } });
    restoreEmit = () => { if (descriptor === undefined) Reflect.deleteProperty(launcher, "emit"); else Object.defineProperty(launcher, "emit", descriptor); };
    vi.spyOn(launcher, "send");
    launcher.on("message", (value: unknown) => {
      if (typeof value === "object" && value !== null && "kind" in value && value.kind === "result") result.resolve();
    });
  });
  const events: OwnedCommandLifecycleEvent[] = [];
  let originalError: OwnedCommandCleanupError | undefined;
  let errorsAtStopped: unknown[] | undefined;
  const sink = async (event: OwnedCommandLifecycleEvent) => {
    if (event.stage === "stopped") errorsAtStopped = [...(originalError?.errors ?? [])];
    events.push(event);
  };
  const operation = createOperation({ limits: { totalMs: 30_000, requestMs: 30_000 } });
  const now = Date.now;
  let clockAdvance = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + clockAdvance);
  const confirm = processProof.confirmControllerProcessesStopped;
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockImplementation(async (...args) => {
    const stopped = await confirm(...args);
    if (stopped) processStopped.resolve();
    return stopped;
  });
  const stop = processProof.stopControllerProcesses;
  vi.spyOn(processProof, "stopControllerProcesses").mockImplementation(async (...args) => {
    await stop(...args);
    processStopped.resolve();
  });
  const pending = runLifecycleOwnedCommand({ file: process.execPath, args: ["--eval", "process.once('SIGTERM',()=>setTimeout(()=>process.exit(0),1400));process.stdout.write('ready');setInterval(()=>{},1000);"], environment: process.env }, operation, sink,
    { cleanupWithinDeadline: true, onStdout: async () => { clockAdvance = 29_100; ready.resolve(); } }).catch(error => error);
  try {
    await Promise.race([ready.promise, pending.then(error => { throw new Error(`The command did not reach output readiness: ${events.map(event => event.stage).join(",")}; sends=${JSON.stringify(vi.mocked(child().send).mock.calls)}`, { cause: error }); })]);
    const error = await pending;
    clock.mockRestore();
    expect(error).toBeInstanceOf(OwnedCommandCleanupError);
    expect(error.cause).toBeInstanceOf(Error);
    originalError = error;
    const resourceId = events[0]!.resourceId, proof = events[1]!.proof, closure = ownedCommandClosure(resourceId);
    let closed = false;
    void closure.then(() => { closed = true; });
    await withinExecutionDeadline(result.promise, Date.now() + 5000);
    const first = reconcileOwnedCommandBoundary(resourceId, sink, Date.now() + 1000).then(() => null, failure => failure);
    await withinExecutionDeadline(heldClose.promise, Date.now() + 5000);
    await withinExecutionDeadline(processStopped.promise, Date.now() + 5000);
    expect(await first).toMatchObject({ message: expect.stringMatching(/deadline/) });
    expect(closed).toBe(false);
    expect(retainedOwnedCommandBoundaries()).toContainEqual({ resourceId, proof });
    expect(events.map(event => event.stage)).toEqual(["prepared", "bound", "unknown"]);
    child().emit("message", { kind: "io-error" });
    releaseClose!(); releaseClose = undefined;
    await reconcileOwnedCommandBoundary(resourceId, sink, Date.now() + 5000);
    await closure;
    expect(error.errors).toContainEqual(expect.objectContaining(helperFailures.helper.expected));
    expect(errorsAtStopped).toContainEqual(expect.objectContaining(helperFailures.helper.expected));
    expect(isConfirmedOwnedCommandCleanupWait(error)).toBe(false);
    expect(events.at(-1)).toMatchObject({ resourceId, stage: "stopped", proof });
    const dispatched = vi.mocked(child().send).mock.calls.filter(([message]) => typeof message === "object" && message !== null && "kind" in message && message.kind === "run").length;
    expect(dispatched).toBe(1);
  } finally {
    clock.mockRestore(); releaseClose?.(); restoreEmit?.(); await pending; operation.dispose();
    const resourceId = events[0]?.resourceId;
    if (resourceId && retainedOwnedCommandBoundaries().some(value => value.resourceId === resourceId)) await reconcileOwnedCommandBoundary(resourceId, async event => { events.push(event); }, Date.now() + 10_000);
  }
}, 20_000);

it.each([
  { source: "guardian", cancelled: false }, { source: "guardian", cancelled: true },
  { source: "helper", cancelled: false }, { source: "helper", cancelled: true },
  { source: "spawn", cancelled: true }, { source: "malformed", cancelled: true },
] as const)("retains $source capture failures after native closure (cancelled=$cancelled)", async ({ source, cancelled }) => {
  const child = await observeLauncher();
  const captured = new Error("Guardian output ended with a truncated frame."), channel = new Error("Guardian channel closed unexpectedly.");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), nativeStopped = Promise.withResolvers<void>();
  const cancellation = new AbortController(), reason = new Error("Stop the original command.");
  const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 30_000, requestMs: 30_000 } });
  const events: OwnedCommandLifecycleEvent[] = [];
  const stop = processProof.stopControllerProcesses;
  vi.spyOn(processProof, "stopControllerProcesses").mockImplementationOnce(async (...args: Parameters<typeof stop>) => {
    // Native cleanup begins after the runner has retained the cancellation.
    if (cancelled) {
      if (source !== "guardian") child().emit("message", helperFailures[source].message);
      else { child().emit("error", captured); child().emit("error", channel); }
    }
    await stop(...args); nativeStopped.resolve();
  });
  const running = runLifecycleOwnedCommand({ file: process.execPath, args: ["--eval", "process.stdout.write('captured');setInterval(()=>{},1000);"], environment: process.env }, operation,
    async event => { events.push(event); }, { onStdout: async () => { entered.resolve(); await release.promise; } });
  let settled = false;
  const outcome = running.then(value => { settled = true; return value; }, error => { settled = true; return error; });
  try {
    await Promise.race([entered.promise, outcome.then(error => { throw error; })]);
    if (cancelled) cancellation.abort(reason);
    else if (source !== "guardian") child().emit("message", helperFailures[source].message);
    else child().emit("error", captured);
    await Promise.race([nativeStopped.promise, outcome.then(error => { throw error; })]);
    expect(settled).toBe(false);
    expect(events.some(event => event.stage === "stopped")).toBe(false);
    release.resolve();
    const error = await outcome;
    if (cancelled) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(isWorkerCancellation(error.errors[0], cancellation.signal)).toBe(true);
      expect(error.errors.slice(1)).toEqual(source !== "guardian" ? [expect.objectContaining(helperFailures[source].expected)] : [captured, channel]);
    }
    else if (source !== "guardian") expect(error).toMatchObject(helperFailures[source].expected);
    else expect(error).toBe(captured);
    expect(isWorkerCancellation(error, cancellation.signal)).toBe(false);
    expect(events.map(event => event.stage)).toEqual(["prepared", "bound", "stopped"]);
    expect(await processProof.inspectProcessProof(events[1]!.proof!)).toBe("stopped");
    expect(retainedOwnedCommandBoundaries().some(value => value.resourceId === events[0]!.resourceId)).toBe(false);
  } finally {
    release.resolve(); cancellation.abort(reason); await outcome; operation.dispose();
    const resourceId = events[0]?.resourceId;
    if (resourceId && retainedOwnedCommandBoundaries().some(value => value.resourceId === resourceId)) await reconcileOwnedCommandBoundary(resourceId, async event => { events.push(event); }, Date.now() + 10_000);
  }
}, 35_000);

it.each(["success", "writer", "helper", "spawn", "malformed", "journal", "cancellation"] as const)("classifies a late %s capture result on the original error after cleanup reconciliation", async source => {
  let nativeClosed = false, consumerHeld = false;
  let dispatchedRuns: (() => number) | undefined;
  const child = await observeLauncher(launcher => {
    launcher.once("close", () => { nativeClosed = true; });
    const dispatch = vi.spyOn(launcher, "send");
    dispatchedRuns = () => dispatch.mock.calls.filter(([message]) => typeof message === "object" && message !== null && "kind" in message && message.kind === "run").length;
  });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const captured = new Error("The final captured output could not be persisted.");
  const saveFailure = new Error("The unknown responsibility could not be saved.");
  const events: OwnedCommandLifecycleEvent[] = [], sink = async (event: OwnedCommandLifecycleEvent) => {
    events.push(event);
    if (source === "journal" && event.stage === "unknown") throw saveFailure;
  };
  const operationBudget = 30_000;
  const cancellation = new AbortController();
  const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: operationBudget, requestMs: operationBudget } });
  const confirmStopped = processProof.confirmControllerProcessesStopped;
  let nativeConfirmations = 0, nativeStopped = false, cleanupDeadline: number | undefined;
  const confirmation = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockImplementation(async (...args: Parameters<typeof confirmStopped>) => {
    const stopped = await confirmStopped(...args);
    nativeConfirmations++;
    if (nativeConfirmations === 2) { nativeStopped = stopped; cleanupDeadline = args[2]; }
    return stopped;
  });
  const confirmGroup = processProof.confirmClosedOwnedCommandGroup;
  vi.spyOn(processProof, "confirmClosedOwnedCommandGroup").mockImplementation(async (...args: Parameters<typeof confirmGroup>) => {
    const stopped = await confirmGroup(...args);
    nativeConfirmations++;
    if (nativeConfirmations === 2) { nativeStopped = stopped; cleanupDeadline = args[2]; }
    return stopped;
  });
  type JoinTimer = ReturnType<typeof captureSynchronousDeadline<NodeJS.Timeout>>;
  const registered = Promise.withResolvers<{ at: number | undefined; before: number; after: number; timer: JoinTimer }>();
  const schedule = globalThis.setTimeout;
  let timer: JoinTimer | undefined, capturing = false;
  const now = Date.now;
  let outputJoinAt: number | undefined;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => {
    const value = now();
    if (!capturing && timer === undefined && consumerHeld && nativeClosed && nativeStopped) outputJoinAt = value;
    return value;
  });
  // Native proof helpers keep their real clocks. Only the next registration after
  // both closure observations and the held writer belongs to the output join.
  const scheduling = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) => {
    if (capturing || timer !== undefined || !consumerHeld || !nativeClosed || !nativeStopped) return schedule(callback, milliseconds, ...args);
    // The argument is computed before setTimeout is entered. Retain that real
    // clock read so a millisecond tick during registration cannot alter the proof.
    const at = outputJoinAt;
    const before = now();
    capturing = true;
    try { timer = captureSynchronousDeadline(() => setTimeout(callback, milliseconds, ...args)); }
    finally { capturing = false; }
    registered.resolve({ at, before, after: now(), timer });
    return timer.result;
  }) as typeof globalThis.setTimeout);
  const outcome = runLifecycleOwnedCommand({ file: process.execPath, args: ["--eval", "process.stdout.write('retained');"], environment: process.env }, operation, sink,
    { cleanupWithinDeadline: true, onStdout: async () => {
      consumerHeld = true; entered.resolve(); await release.promise;
      consumerHeld = false;
      if (source === "success" || source === "journal" || source === "cancellation") return;
      if (source === "writer") throw captured;
      child().emit("message", helperFailures[source].message);
    } }).catch(error => error);
  let settled = false;
  void outcome.then(() => { settled = true; });
  try {
    await Promise.race([entered.promise, outcome.then(error => { throw error; })]);
    if (source === "cancellation") cancellation.abort(new Error("root cancelled"));
    const join = await Promise.race([registered.promise, outcome.then(error => { throw error; })]);
    expect(join.timer.count).toBe(1);
    expect(join.at).toBeTypeOf("number");
    expect(join.at).toBeLessThanOrEqual(join.before);
    expect(join.before).toBeLessThanOrEqual(join.after);
    expect(Number.isSafeInteger(cleanupDeadline)).toBe(true);
    expect(join.at).toBeLessThan(cleanupDeadline!);
    expect(join.timer.requested).toBe(Math.max(1, cleanupDeadline! - join.at!));
    expect(nativeConfirmations).toBe(2);
    expect(nativeClosed).toBe(true);
    expect(nativeStopped).toBe(true);
    await yieldNative();
    expect(events.map(event => event.stage)).toEqual(["prepared", "bound"]);
    expect(settled).toBe(false);
    join.timer.markReady();
    await join.timer.expire();
    const error = await outcome;
    timer!.restore(); timer = undefined;
    scheduling.mockRestore();
    clock.mockRestore();
    confirmation.mockRestore();
    expect(operation.signal.aborted).toBe(source === "cancellation");
    if (source !== "cancellation") operation.check();
    expect(error).toBeInstanceOf(OwnedCommandCleanupError);
    expect(error.cause).toMatchObject({ message: "Owned command output consumers did not join." });
    expect(hasUnconfirmedOwnedCommandCleanup(error)).toBe(true);
    expect(isConfirmedOwnedCommandCleanupWait(error)).toBe(false);
    const resourceId = events[0]!.resourceId, proof = events[1]!.proof;
    expect(events).toEqual([
      { resourceId, sequence: 1, stage: "prepared", proof: null },
      { resourceId, sequence: 2, stage: "bound", proof },
      { resourceId, sequence: 3, stage: "unknown", proof },
    ]);
    expect(retainedOwnedCommandBoundaries()).toContainEqual({ resourceId, proof });
    expect(dispatchedRuns!()).toBe(1);
    const expected = source === "success" ? undefined : source === "journal" ? saveFailure : source === "cancellation" ? operation.signal.reason : source !== "writer" ? expect.objectContaining(helperFailures[source].expected) : captured;
    if (source === "journal" || source === "cancellation") expect(error.errors).toContain(expected);
    else if (expected !== undefined) expect(error.errors).not.toContainEqual(expected);
    release.resolve();
    await reconcileOwnedCommandBoundary(resourceId, sink, Date.now() + 5000);
    expect(hasUnconfirmedOwnedCommandCleanup(error)).toBe(false);
    expect(isConfirmedOwnedCommandCleanupWait(error)).toBe(source === "success");
    if (source === "cancellation") expect(isConfirmedOwnedCommandCleanupWait(error, cause => isWorkerCancellation(cause, cancellation.signal))).toBe(true);
    if (expected !== undefined) expect(error.errors).toContainEqual(expected);
    expect(events.at(-1)).toEqual({ resourceId, sequence: 4, stage: "stopped", proof });
    expect(await processProof.inspectProcessProof(proof!)).toBe("stopped");
    expect(retainedOwnedCommandBoundaries().some(value => value.resourceId === resourceId)).toBe(false);
    expect(dispatchedRuns!()).toBe(1);
  } finally {
    timer?.restore(); scheduling.mockRestore(); clock.mockRestore(); confirmation.mockRestore();
    release.resolve(); await outcome; operation.dispose();
    const resourceId = events[0]?.resourceId;
    if (resourceId && retainedOwnedCommandBoundaries().some(value => value.resourceId === resourceId)) await reconcileOwnedCommandBoundary(resourceId, sink, Date.now() + 5000);
  }
}, 35_000);
