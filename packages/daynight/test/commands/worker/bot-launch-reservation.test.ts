import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { cleanupBotProcesses, fixture, id } from "./bot-process.fixtures.js";
import { BotAdmissionBlockedError } from "../../../src/commands/worker/bots/process.js";
import { launchControllerProcess } from "../../../src/commands/worker/backends/controller-process.js";
import { openLifecycleStore, type LifecycleBinding } from "../../../src/commands/worker/lifecycle-store.js";
import { withWorkerLifecycle } from "../../../src/commands/worker/lifecycle-context.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { resolveBotControllerStateDirectory } from "../../../src/commands/worker/bots/paths.js";
import { openControllerWorkerLifecycle } from "../../../src/commands/controller/worker-lifecycle.js";
import { readLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), suspended: vi.fn(), capture: vi.fn(), reconcile: vi.fn(), prepare: vi.fn() }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: native.spawn }));
vi.mock("../../../src/platform/windows-suspended-process.js", () => ({ createSuspendedProcess: native.suspended }));
vi.mock("../../../src/commands/controller/windows-job.js", async original => ({ ...await original<typeof import("../../../src/commands/controller/windows-job.js")>(),
  createControllerJobLease: vi.fn(async () => ({})), releaseControllerJobLease: vi.fn() }));
vi.mock("../../../src/commands/controller/process-proof.js", async original => ({ ...await original<typeof import("../../../src/commands/controller/process-proof.js")>(), captureProcessProof: native.capture }));
vi.mock("../../../src/commands/controller/launch-observation.js", async original => ({ ...await original<typeof import("../../../src/commands/controller/launch-observation.js")>(), reconcileSubmittedControllerLaunch: native.reconcile }));
vi.mock("../../../src/commands/controller/storage-preparation.js", async original => {
  const actual = await original<typeof import("../../../src/commands/controller/storage-preparation.js")>();
  return { ...actual, prepareControllerStorage: native.prepare.mockImplementation(actual.prepareControllerStorage) };
});

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); cleanupBotProcesses(); });

const setup = () => {
  const f = fixture("codex", {}, true, true);
  const paths = resolveWorkerPaths(f.home);
  mkdirSync(paths.workerDirectory, { recursive: true, mode: 0o700 });
  const identity = { serverOrigin: f.owner.serverOrigin, userId: f.owner.ownerUserId, workerId: f.owner.workerId };
  const authority = openLifecycleStore({ file: path.join(paths.workerDirectory, "lifecycle.sqlite"), identity, allowCreate: true });
  authority.bindInstance({ instanceId: id(80), instanceEpoch: "1", intentVersion: "1", desired: "enabled" });
  const activate = (action: "bootstrap" | "resume", generation: string): LifecycleBinding => {
    const state = authority.readState();
    authority.markStopped({ localEpoch: state.localEpoch, inventoryRevision: state.inventoryRevision, owners: [] });
    const binding = { ...identity, instanceId: id(80), instanceEpoch: "1", intentVersion: "1", localEpoch: state.localEpoch, scopeGeneration: generation };
    const activation = { binding, action, operationId: id(action === "bootstrap" ? 81 : 82) };
    authority.prepareActivation(activation);
    authority.commitActivation({ ...activation, receipt: { protocolVersion: 1, admission: "open", action, operationId: activation.operationId,
      workerId: identity.workerId, instanceEpoch: "1", intentVersion: "1", localEpoch: binding.localEpoch, scopeGeneration: generation } });
    return binding;
  };
  let binding = activate("bootstrap", "1");
  const proof = { pid: 987, parentPid: 1, processGroupId: 987, startedAt: "original", commandHash: "a".repeat(64) };
  const dispatch = vi.fn();
  const child = Object.assign(new EventEmitter(), { pid: proof.pid, connected: true, exitCode: null, signalCode: null,
    unref: vi.fn(), send: dispatch, resume: dispatch, close: vi.fn(), terminate: vi.fn(), hasExited: () => true });
  native.spawn.mockImplementation(() => { queueMicrotask(() => child.emit("spawn")); return child; });
  native.suspended.mockResolvedValue(child);
  native.capture.mockResolvedValue(proof);
  native.reconcile.mockImplementation(async ({ ticket }) => ({ kind: "observed", snapshot: { ...await f.observe(ticket),
    controllerProcess: process.platform === "win32" ? { ...proof, jobObjectName: `Local\\Daynight-${ticket.launchId}` } : proof } }));
  const leases = { enabled: false, retainBirthCleanup: () => () => {}, cleanupBirth: async () => {}, adopt: () => {},
    retain: async () => undefined, get: async () => undefined, release: async () => {}, close: async () => {} };
  let manager = f.createProcess({ launch: launchControllerProcess }, 3, leases);
  const signal = AbortSignal.timeout(10_000);
  const run = () => withWorkerLifecycle({ store: authority, binding, failed: error => { throw error; } }, () => manager.advance(f.current(), signal));
  const restart = () => { f.reopen(); manager = f.createProcess({ launch: launchControllerProcess }, 3, leases); };
  const resume = () => { authority.closeAdmission({ operationId: id(83), local: true }); binding = activate("resume", "2"); };
  const storage = () => resolveBotControllerStateDirectory(f.home, f.current());
  const ticket = () => manager.readTicket(f.current());
  return { ...f, get executions() { return f.executions; }, authority, run, restart, resume, storage, ticket, dispatch, proof, binding: () => binding };
};

test.each(["same lifecycle", "reopened Bot stores", "resumed lifecycle"] as const)("retries a Bot refused during log open with a new reservation: %s", async mode => {
  const f = setup();
  const open = fs.open;
  let refuse = true;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await open(...args);
    if (String(args[0]).endsWith("controller.log") && refuse) f.setAdmission(false);
    return file;
  });
  try {
    await expect(f.run()).rejects.toBeInstanceOf(BotAdmissionBlockedError);
    const original = await f.ticket(), intent = f.current().intent!, execution = f.executions.get(f.current())!;
    const resource = f.authority.getResource(original.launchId);
    expect(resource).toMatchObject({ stage: "not_dispatched", saveState: "durable", processProof: null });
    expect(execution).toMatchObject({ launchSubmission: "not-submitted", controllerProcess: null, snapshot: null, startup: null });
    expect(native.spawn).not.toHaveBeenCalled(); expect(native.suspended).not.toHaveBeenCalled();
    if (mode === "reopened Bot stores") f.restart();
    if (mode === "resumed lifecycle") f.resume();
    refuse = false; f.setAdmission(true);
    await expect(f.run()).resolves.toMatchObject({ lifecycle: "ready", executionGeneration: "1" });
    const replacement = await f.ticket();
    expect(replacement.launchId).not.toBe(original.launchId);
    expect(replacement).toEqual({ ...original, launchId: replacement.launchId, ipcEndpoint: replacement.ipcEndpoint,
      ipcSecret: replacement.ipcSecret, lifecycleBinding: f.binding() });
    expect(f.current().intent).toEqual({ ...intent, launchId: replacement.launchId, ticketPath: f.current().intent!.ticketPath });
    expect(f.executions.get(f.current())).toMatchObject({ launchSubmission: "acknowledged", retainedLaunchIds: [original.launchId], recoveryCount: 0 });
    expect(await readLaunchTicket(f.home, original.launchId, f.storage())).toEqual(original);
    expect(f.authority.getResource(original.launchId)).toEqual(resource);
    expect(f.authority.getResource(replacement.launchId)).toMatchObject({ stage: "running", identity: { launchId: replacement.launchId } });
    expect(f.authority.listResources()).toHaveLength(2);
    const stale = openControllerWorkerLifecycle(f.home, original, f.storage())!;
    try { expect(() => stale.reserveLaunch()).toThrow(); } finally { stale.close(); }
    expect(f.register).toHaveBeenCalledOnce(); expect(f.dispatch).toHaveBeenCalledOnce();
  } finally { f.authority.close(); }
});

test("keeps the original Bot ticket when no launch reservation was ever made", async () => {
  const f = setup();
  try {
    f.grant.mockRejectedValueOnce(new Error("grant unavailable"));
    await expect(f.run()).rejects.toThrow("grant unavailable");
    const original = await f.ticket();
    expect(f.authority.listResources()).toEqual([]);
    await expect(f.run()).resolves.toMatchObject({ lifecycle: "ready" });
    expect(await f.ticket()).toEqual(original);
    expect(f.executions.get(f.current())!.retainedLaunchIds).toEqual([]);
    expect(f.authority.listResources()).toHaveLength(1);
    expect(f.dispatch).toHaveBeenCalledOnce();
  } finally { f.authority.close(); }
});

test.each(["reserved", "unknown", "pending save", "wrong ticket"] as const)("does not replace a Bot launch with %s reservation evidence", async state => {
  const f = setup();
  try {
    f.grant.mockRejectedValueOnce(new Error("grant unavailable"));
    await expect(f.run()).rejects.toThrow("grant unavailable");
    const original = await f.ticket(), intent = f.current().intent!;
    const reservationTicket = state === "wrong ticket" ? { ...original, ipcSecret: "b".repeat(64) } : original;
    const launcher = openControllerWorkerLifecycle(f.home, reservationTicket, f.storage())!;
    try { launcher.reserveLaunch(); } finally { launcher.close(); }
    if (state !== "reserved") f.authority.recordResource({ resourceId: original.launchId,
      stage: state === "unknown" ? "unknown" : "not_dispatched", saveState: state === "pending save" ? "pending" : "durable" });
    const resources = f.authority.listResources();
    await expect(f.run()).rejects.toThrow("does not prove the original attempt was never dispatched");
    expect(f.current().intent).toEqual(intent);
    expect(await f.ticket()).toEqual(original);
    expect(f.authority.listResources()).toEqual(resources);
    expect(f.grant).toHaveBeenCalledOnce(); expect(f.dispatch).not.toHaveBeenCalled();
  } finally { f.authority.close(); }
});

test("replaces a never-dispatched recovery attempt without changing the remote recovery fence", async () => {
  const f = setup();
  try {
    // The stopped native generation is a controlled input. Reservation, launcher,
    // Bot rows, tickets and log I/O remain real throughout recovery submission.
    await f.process.advance(f.current(), AbortSignal.timeout(10_000));
    const stopped: ControllerSnapshot = { ...f.executions.get(f.current())!.snapshot!, controllerProcess: {
      pid: 123, parentPid: 12, processGroupId: 123, startedAt: "original", commandHash: "a".repeat(64),
    }, lifecycle: "stopped", nativeStopped: true, stoppedAt: "2026-11-05T00:00:00Z" };
    f.executions.update(f.current(), { snapshot: stopped });
    f.executions.beginRecovery(f.current(), stopped, f.home);
    const prepare = native.prepare.getMockImplementation()!;
    native.prepare.mockImplementation(() => ({ kind: "prepared", snapshot: stopped, legacyTimelineCleanupPending: false }));
    let refuse = true;
    // Abort at the real launch callback after reservation, before submission.
    const failure = new Error("recovery submission interrupted");
    const update = f.executions.update;
    const submission = vi.spyOn(f.executions, "update").mockImplementation((record, patch) => {
      if (refuse && patch.launchSubmission === "unknown") throw failure;
      return update(record, patch);
    });
    try {
      await expect(f.run()).rejects.toBe(failure);
      const original = await f.ticket(), intent = f.current().intent!, execution = f.executions.get(f.current())!;
      const resource = f.authority.getResource(original.launchId);
      expect(resource).toMatchObject({ stage: "not_dispatched", saveState: "durable" });
      refuse = false;
      await expect(f.run()).resolves.toMatchObject({ lifecycle: "ready", executionGeneration: "2", nativeSessionId: id(9) });
      const replacement = await f.ticket();
      expect(replacement.launchId).not.toBe(original.launchId);
      expect(f.current().intent).toEqual({ ...intent, launchId: replacement.launchId, ticketPath: f.current().intent!.ticketPath });
      expect(f.executions.get(f.current())).toMatchObject({ previous: execution.previous, recoveryCount: execution.recoveryCount,
        retainedLaunchIds: [...execution.retainedLaunchIds, original.launchId] });
      expect(f.authority.getResource(original.launchId)).toEqual(resource);
      expect(await readLaunchTicket(f.home, original.launchId, f.storage())).toEqual(original);
      const previous = execution.previous!;
      expect(f.grant).toHaveBeenLastCalledWith(f.current(), expect.any(AbortSignal), {
        generation: previous.generation, instanceId: previous.instanceId, recordId: previous.recordId, stoppedAt: previous.stoppedAt });
      expect(f.register).toHaveBeenCalledOnce(); expect(f.dispatch).toHaveBeenCalledOnce();
    } finally { submission.mockRestore(); native.prepare.mockImplementation(prepare); }
  } finally { f.authority.close(); }
});
