import type { EventEmitter } from "node:events";
import * as childProcesses from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as suspendedChildren from "../../../src/commands/worker/suspended-node-child.js";
import { isWorkerCancellation } from "../../../src/commands/worker/execution.js";
import { hasUnconfirmedOwnedCommandCleanup, OwnedCommandCleanupError } from "../../../src/commands/worker/owned-command.js";
import { reconcileOwnedCommandBoundary, retainedOwnedCommandBoundaries, runLifecycleOwnedCommand, type OwnedCommandLifecycleEvent } from "../../../src/commands/worker/owned-command-lifecycle.js";

vi.mock("node:child_process", { spy: true });
afterEach(() => vi.restoreAllMocks());

it.each([false, true])("retains guardian capture failures after native closure (cancelled=%s)", async cancelled => {
  const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  let child: EventEmitter | undefined;
  vi.spyOn(childProcesses, "spawn").mockImplementationOnce((...args: Parameters<typeof native.spawn>) => child = native.spawn(...args));
  const suspend = suspendedChildren.createSuspendedNodeChild;
  vi.spyOn(suspendedChildren, "createSuspendedNodeChild").mockImplementationOnce(async options => {
    const result = await suspend(options); child = result.child; return result;
  });
  const captured = new Error("Guardian output ended with a truncated frame."), channel = new Error("Guardian channel closed unexpectedly.");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), nativeStopped = Promise.withResolvers<void>();
  const cancellation = new AbortController(), reason = new Error("Stop the original command.");
  const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 30_000, requestMs: 30_000 } });
  const events: OwnedCommandLifecycleEvent[] = [];
  const stop = processProof.stopControllerProcesses;
  vi.spyOn(processProof, "stopControllerProcesses").mockImplementationOnce(async (...args: Parameters<typeof stop>) => {
    // Native cleanup begins after the runner has retained the cancellation.
    if (cancelled) { child!.emit("error", captured); child!.emit("error", channel); }
    await stop(...args); nativeStopped.resolve();
  });
  const running = runLifecycleOwnedCommand({ file: process.execPath, args: ["--eval", "process.stdout.write('captured');setInterval(()=>{},1000);"], environment: process.env }, operation,
    async event => { events.push(event); }, { onStdout: async () => { entered.resolve(); await release.promise; } });
  let settled = false;
  const outcome = running.then(value => { settled = true; return value; }, error => { settled = true; return error; });
  try {
    await Promise.race([entered.promise, outcome.then(error => { throw error; })]);
    if (cancelled) cancellation.abort(reason);
    else child!.emit("error", captured);
    await Promise.race([nativeStopped.promise, outcome.then(error => { throw error; })]);
    expect(settled).toBe(false);
    expect(events.some(event => event.stage === "stopped")).toBe(false);
    release.resolve();
    const error = await outcome;
    if (cancelled) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(isWorkerCancellation(error.errors[0], cancellation.signal)).toBe(true);
      expect(error.errors.slice(1)).toEqual([captured, channel]);
    }
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

it("keeps a late capture failure on the original error after cleanup reconciliation", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const captured = new Error("The final captured output could not be persisted.");
  const events: OwnedCommandLifecycleEvent[] = [], sink = async (event: OwnedCommandLifecycleEvent) => { events.push(event); };
  const operation = createOperation({ limits: { totalMs: 3000, requestMs: 3000 } });
  const outcome = runLifecycleOwnedCommand({ file: process.execPath, args: ["--eval", "process.stdout.write('retained');"], environment: process.env }, operation, sink,
    { cleanupWithinDeadline: true, onStdout: async () => { entered.resolve(); await release.promise; throw captured; } }).catch(error => error);
  try {
    await Promise.race([entered.promise, outcome.then(error => { throw error; })]);
    const error = await outcome;
    expect(error).toBeInstanceOf(OwnedCommandCleanupError);
    expect(hasUnconfirmedOwnedCommandCleanup(error)).toBe(true);
    expect(error.errors).not.toContain(captured);
    release.resolve();
    await reconcileOwnedCommandBoundary(events[0]!.resourceId, sink, Date.now() + 5000);
    expect(hasUnconfirmedOwnedCommandCleanup(error)).toBe(false);
    expect(error.errors).toContain(captured);
    expect(events.at(-1)?.stage).toBe("stopped");
  } finally {
    release.resolve(); await outcome; operation.dispose();
    const resourceId = events[0]?.resourceId;
    if (resourceId && retainedOwnedCommandBoundaries().some(value => value.resourceId === resourceId)) await reconcileOwnedCommandBoundary(resourceId, sink, Date.now() + 5000);
  }
}, 15_000);
