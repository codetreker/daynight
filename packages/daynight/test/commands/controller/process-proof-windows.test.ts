import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const f = vi.hoisted(() => ({ native: vi.fn(), job: vi.fn() }));
vi.mock("../../../src/commands/controller/windows-process-proof.js", () => ({ captureWindowsProcessProof: f.native }));
vi.mock("../../../src/commands/controller/windows-job.js", () => ({ createControllerJob: vi.fn(), inspectControllerJob: f.job }));
import { stopControllerProcesses, type ProcessProof } from "../../../src/commands/controller/process-proof.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const controller: ProcessProof = { pid: 4101, parentPid: 4000, processGroupId: null, startedAt: "fixture-birth", commandHash: createHash("sha256").update("fixture-controller").digest("hex"), jobObjectName: "Local\\Daynight-11111111-1111-4111-8111-111111111111" };
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.useFakeTimers(); vi.clearAllMocks();
  f.job.mockResolvedValue([]);
  f.native.mockImplementation(async pid => ({ ...controller, pid }));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); Object.defineProperty(process, "platform", platform); });
const missing = () => { throw Object.assign(new Error("Gone"), { code: "ESRCH" }); };

test("waits for the original process after the Windows Job inventory becomes empty", async () => {
  let probes = 0;
  vi.spyOn(process, "kill").mockImplementation(() => ++probes < 3 ? true : missing());
  const completion = stopControllerProcesses(controller, [], Date.now() + 100).then(() => "stopped", error => error);
  await vi.runAllTimersAsync();
  expect(await completion).toBe("stopped");
  expect(probes).toBe(3);
  expect(f.job).toHaveBeenCalledWith(controller.jobObjectName, true);
});

test("retains resources when an original process stays live through the existing deadline", async () => {
  vi.spyOn(process, "kill").mockReturnValue(true);
  const started = Date.now();
  const completion = stopControllerProcesses(controller, [], started + 100).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await completion).toMatchObject({ message: "The original Windows Job Object did not stop completely." });
  expect(Date.now() - started).toBe(100);
});

test("does not start another identity probe when a polling delay reaches the deadline", async () => {
  const started = Date.now(), probes: number[] = [];
  vi.spyOn(process, "kill").mockImplementation(() => { probes.push(Date.now() - started); return true; });
  const completion = stopControllerProcesses(controller, [], started + 35).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await completion).toMatchObject({ message: "The original Windows Job Object did not stop completely." });
  expect(probes).toEqual([0, 25]);
});

test("does not start identity polling when the Job termination operation exhausts its budget", async () => {
  const started = Date.now();
  f.job.mockImplementationOnce(async () => { vi.setSystemTime(started + 100); return []; });
  const probe = vi.spyOn(process, "kill").mockReturnValue(true);
  await expect(stopControllerProcesses(controller, [], started + 100)).rejects.toThrow("The original Windows Job Object did not stop completely.");
  expect(probe).not.toHaveBeenCalled();
});

test("waits for a retained native process after the controller and Job stop", async () => {
  const native = { ...controller, pid: 4102 };
  let nativeProbes = 0;
  vi.spyOn(process, "kill").mockImplementation(pid => pid === native.pid && ++nativeProbes < 3 ? true : missing());
  const completion = stopControllerProcesses(controller, [native], Date.now() + 100).then(() => "stopped", error => error);
  await vi.runAllTimersAsync();
  expect(await completion).toBe("stopped");
  expect(nativeProbes).toBe(3);
});

test("does not turn process permission failures into successful stop evidence", async () => {
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Denied"), { code: "EPERM" }); });
  await expect(stopControllerProcesses(controller, [], Date.now() + 100)).rejects.toThrow("Process liveness could not be established");
  expect(vi.getTimerCount()).toBe(0);
});

test("propagates a Job inspection failure without treating it as an empty boundary", async () => {
  vi.spyOn(process, "kill").mockImplementation(missing);
  f.job.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("Job access denied"));
  await expect(stopControllerProcesses(controller, [], Date.now() + 100)).rejects.toThrow("Job access denied");
  expect(vi.getTimerCount()).toBe(0);
});

test("retains the complete Job boundary after original process identities stop", async () => {
  vi.spyOn(process, "kill").mockImplementation(missing);
  f.job.mockResolvedValueOnce([4102]).mockResolvedValueOnce([4102]).mockResolvedValueOnce([]);
  const started = Date.now();
  const completion = stopControllerProcesses(controller, [], started + 100).then(() => "stopped", error => error);
  await vi.runAllTimersAsync();
  expect(await completion).toBe("stopped");
  expect(Date.now()).toBeGreaterThan(started);
});
