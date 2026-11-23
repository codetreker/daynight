import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const f = vi.hoisted(() => ({ capture: vi.fn(), inspect: vi.fn(), handles: vi.fn(), job: vi.fn() }));
vi.mock("../../../src/commands/controller/windows-process-proof.js", () => ({ captureWindowsProcessProof: f.capture, inspectWindowsProcessProof: f.inspect, withWindowsProcessStopHandles: f.handles }));
vi.mock("../../../src/commands/controller/windows-job.js", () => ({ createOwnedControllerJob: vi.fn(), inspectControllerJobLease: f.job }));
import * as localClient from "../../../src/commands/controller/local-client.js";
import { reconcileSubmittedControllerLaunch } from "../../../src/commands/controller/launch-observation.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import path from "node:path";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
const lease = {} as ControllerJobLease;
import { confirmControllerProcessesStopped, inspectBootstrapProcessProof, inspectProcessProof, stopControllerProcesses, type ProcessProof } from "../../../src/commands/controller/process-proof.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const controller: ProcessProof = { pid: 4101, parentPid: 4000, processGroupId: null, startedAt: "fixture-birth", commandHash: createHash("sha256").update("fixture-controller").digest("hex"), jobObjectName: "Local\\Daynight-11111111-1111-4111-8111-111111111111" };
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.useFakeTimers(); vi.clearAllMocks();
  f.job.mockReset().mockResolvedValue([]);
  f.capture.mockReset();
  f.inspect.mockReset().mockResolvedValue("stopped");
  f.handles.mockReset().mockImplementation(async (_proofs, _deadline, stop: () => Promise<void>) => { await stop(); });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); Object.defineProperty(process, "platform", platform); });
const missing = () => { throw Object.assign(new Error("Gone"), { code: "ESRCH" }); };

test("an expired cleanup deadline never pins a process or opens the Job", async () => {
  await expect(stopControllerProcesses(controller, [], Date.now() - 1, lease)).rejects.toThrow(/deadline/);
  expect(f.handles).not.toHaveBeenCalled(); expect(f.job).not.toHaveBeenCalled();
});

test("does not infer complete stopping or terminate without an authenticated Job lease", async () => {
  await expect(confirmControllerProcessesStopped(controller, [])).rejects.toThrow(/lease is unavailable/);
  await expect(stopControllerProcesses(controller, [], Date.now() + 100)).rejects.toThrow(/lease is unavailable/);
  expect(f.handles).not.toHaveBeenCalled(); expect(f.job).not.toHaveBeenCalled();
});

test("requires the original Job boundary even if all known processes have exited", async () => {
  const { jobObjectName: _, ...withoutJob } = controller;
  await expect(confirmControllerProcessesStopped(withoutJob, [], Date.now() + 100, lease)).rejects.toThrow(/no Job Object boundary/);
  await expect(stopControllerProcesses(withoutJob, [], Date.now() + 100, lease)).rejects.toThrow(/no Job Object boundary/);
  expect(f.handles).not.toHaveBeenCalled(); expect(f.job).not.toHaveBeenCalled();
});

test("confirmation shares the remaining deadline across original processes", async () => {
  const start = Date.now(), native = { ...controller, pid: 4102 }, probes: number[] = [];
  f.inspect.mockImplementation(async (proof: ProcessProof, timeout: number) => {
    probes.push(timeout);
    vi.setSystemTime(start + (proof.pid === controller.pid ? 70 : 100));
    return "stopped";
  });
  await expect(confirmControllerProcessesStopped(controller, [native], start + 100, lease)).rejects.toThrow(/deadline/);
  expect(probes).toEqual([100, 30]); expect(f.job).not.toHaveBeenCalled();
});

test("retains a live original birth with conflicting command evidence before inspecting the Job", async () => {
  const failure = new Error("The original Windows process has inconsistent identity evidence; ownership remains unknown.");
  f.inspect.mockRejectedValue(failure);
  await expect(confirmControllerProcessesStopped(controller, [], Date.now() + 100, lease)).rejects.toBe(failure);
  expect(f.job).not.toHaveBeenCalled();
});

test("Windows inspection never treats Node ESRCH as native exit completion", async () => {
  const kill = vi.spyOn(process, "kill").mockImplementation(missing);
  f.inspect.mockResolvedValue("running");
  expect(await inspectProcessProof(controller)).toBe("running");
  f.inspect.mockResolvedValue("exiting");
  expect(await inspectBootstrapProcessProof(controller)).toBe("exiting");
  await expect(inspectProcessProof(controller)).rejects.toThrow(/exiting/);
  expect(await confirmControllerProcessesStopped(controller, [], Date.now() + 100, lease)).toBe(false);
  expect(kill).not.toHaveBeenCalled(); expect(f.job).not.toHaveBeenCalled();
});

test("Windows observation errors are preserved even if Node would report ESRCH", async () => {
  const kill = vi.spyOn(process, "kill").mockImplementation(missing), failure = new Error("Native access denied");
  f.inspect.mockRejectedValue(failure);
  await expect(inspectProcessProof(controller)).rejects.toBe(failure);
  expect(kill).not.toHaveBeenCalled();
});

test("pins every known original before Job termination and waits for original handles afterwards", async () => {
  const native = { ...controller, pid: 4102 }, deadline = Date.now() + 100, order: string[] = [];
  let release!: () => void;
  const signal = new Promise<void>(resolve => { release = resolve; });
  f.handles.mockImplementation(async (proofs, actualDeadline, stop: () => Promise<void>) => {
    expect(proofs).toEqual([controller, native]); expect(actualDeadline).toBe(deadline);
    order.push("pinned"); await stop(); order.push("waiting"); await signal; order.push("signaled");
  });
  f.job.mockImplementation(async () => { order.push("job-empty"); return []; });
  let completed = false;
  const completion = stopControllerProcesses(controller, [native], deadline, lease).then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(order).toEqual(["pinned", "job-empty", "waiting"]); expect(completed).toBe(false);
  release(); await completion;
  expect(order).toEqual(["pinned", "job-empty", "waiting", "signaled"]); expect(completed).toBe(true);
  expect(f.job).toHaveBeenCalledExactlyOnceWith(lease, controller, true, deadline);
  expect(f.inspect).not.toHaveBeenCalled();
});

test("retained-handle acquisition failure prevents Job termination", async () => {
  const failure = new Error("Native process identity unknown"); f.handles.mockRejectedValueOnce(failure);
  await expect(stopControllerProcesses(controller, [], Date.now() + 100, lease)).rejects.toBe(failure);
  expect(f.job).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

test("retains resources when original handle completion reaches the existing deadline", async () => {
  const start = Date.now();
  f.handles.mockImplementation(async (_proofs, deadline: number, stop: () => Promise<void>) => {
    await stop(); await new Promise(resolve => setTimeout(resolve, deadline - Date.now()));
    throw new Error("The original Windows process did not stop by its deadline.");
  });
  const completion = stopControllerProcesses(controller, [], start + 100, lease).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await completion).toMatchObject({ message: "The original Windows process did not stop by its deadline." });
  expect(Date.now() - start).toBe(100);
});

test("Job termination cannot reset the deadline before retained-handle completion", async () => {
  const start = Date.now();
  f.job.mockImplementationOnce(async () => { vi.setSystemTime(start + 100); return []; });
  await expect(stopControllerProcesses(controller, [], start + 100, lease)).rejects.toThrow(/deadline/);
  expect(f.handles.mock.calls[0]?.[1]).toBe(start + 100); expect(f.inspect).not.toHaveBeenCalled();
});

test("propagates Job inspection failure through the retained-handle owner", async () => {
  const failure = new Error("Job access denied"); f.job.mockRejectedValueOnce(failure);
  await expect(stopControllerProcesses(controller, [], Date.now() + 100, lease)).rejects.toBe(failure);
  expect(f.handles).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

test("does not suppress combined process completion and close failures", async () => {
  const primary = new Error("wait failed"), close = new Error("close failed");
  const failure = new AggregateError([primary, close], "Process stop and close failed", { cause: primary });
  f.handles.mockRejectedValueOnce(failure);
  await expect(stopControllerProcesses(controller, [], Date.now() + 100, lease)).rejects.toBe(failure);
});

test("complete confirmation requires empty original Job membership", async () => {
  f.job.mockResolvedValueOnce([4103]);
  expect(await confirmControllerProcessesStopped(controller, [], Date.now() + 100, lease)).toBe(false);
  expect(f.job).toHaveBeenCalledExactlyOnceWith(lease, controller, false, expect.any(Number));
});

test("classifies a different Windows process birth as the original's exit without signaling the replacement", async () => {
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  f.inspect.mockImplementation(async (_proof, _timeout, mismatch) => { mismatch?.({ status: null, sameBirth: false, sameParent: true, sameGroup: true, sameCommand: true }); return "replaced"; });
  vi.spyOn(localClient, "requestController").mockRejectedValue(new localClient.ControllerIpcOutcomeUnknownError("IPC unavailable"));
  const result = await reconcileSubmittedControllerLaunch({ journalFile: path.resolve(".tmp", "missing-original-journal", "journal.sqlite"), ticket: {} as ControllerLaunchTicket, spawnProof: controller, signal: new AbortController().signal });
  expect(result).toEqual({ kind: "pre-writer-exited", process: controller, journal: "missing" });
  expect(kill).not.toHaveBeenCalled();
});

test("does not infer exit from conflicting Windows command evidence at the same birth", async () => {
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  f.inspect.mockRejectedValue(new Error("Original birth has conflicting command evidence"));
  vi.spyOn(localClient, "requestController").mockRejectedValue(new localClient.ControllerIpcOutcomeUnknownError("IPC unavailable"));
  const result = await reconcileSubmittedControllerLaunch({ journalFile: path.resolve(".tmp", "missing-original-journal", "journal.sqlite"), ticket: {} as ControllerLaunchTicket, spawnProof: controller, signal: new AbortController().signal });
  expect(result.kind).toBe("unknown"); expect(kill).not.toHaveBeenCalled();
});
