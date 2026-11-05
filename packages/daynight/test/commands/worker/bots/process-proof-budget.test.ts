import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ execute: vi.fn(), job: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: fixture.execute }));
vi.mock("../../../../src/commands/controller/windows-job.js", () => ({ createControllerJob: fixture.job, inspectControllerJob: vi.fn() }));
import { captureControllerProcessProof, captureProcessProof, inspectProcessProof } from "../../../../src/commands/controller/process-proof.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { ...platform, value });
const birth = "2026-11-05T00:00:00.0000000Z", command = "controlled process";
const windowsOutput = (pid: number) => JSON.stringify({ ProcessId: pid, ParentProcessId: 1, Birth: birth, CommandLine: command });
const proof = (pid: number) => ({ pid, parentPid: 1, processGroupId: null, startedAt: birth, commandHash: createHash("sha256").update(command).digest("hex") });
const queryPid = (args: string[]) => Number(/ProcessId = (\d+)/u.exec(args.at(-1)!)![1]);
const delayedWindowsQuery = (durationMs: number) => {
  const failure = Object.assign(new Error("Controlled CIM query exceeded its observation budget."), { killed: true, signal: "SIGTERM" });
  fixture.execute.mockImplementation((_file, args, options, callback) => {
    setTimeout(() => options.timeout < durationMs ? callback(failure, "") : callback(null, windowsOutput(queryPid(args))), Math.min(durationMs, options.timeout));
  });
  return failure;
};

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  fixture.job.mockResolvedValue("Local\\Daynight-controlled");
  fixture.execute.mockImplementation((_file, args, _options, callback) => callback(null, process.platform === "win32"
    ? windowsOutput(queryPid(args))
    : `${args[1]} 1 ${args[1]} Thu Nov 5 00:00:00 2026 ${command}\n`));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  Object.defineProperty(process, "platform", platform);
});

describe("process ownership capture budgets", () => {
  it.each([["win32", 15_000], ["linux", 5000], ["darwin", 5000]] as const)("uses the %s startup budget without changing proof fields", async (target, timeout) => {
    setPlatform(target);
    const captured = await captureProcessProof(42);
    expect(captured.pid).toBe(42);
    if (target === "win32") expect(captured).toEqual(proof(42));
    expect(fixture.execute.mock.calls[0]?.[2]).toMatchObject({ timeout });
  });

  it("captures a spawned Windows process after the former five-second limit", async () => {
    setPlatform("win32"); delayedWindowsQuery(6000);
    const pending = captureProcessProof(42).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toEqual({ value: proof(42) });
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it("establishes the Controller's delayed self-proof before assigning its Job Object", async () => {
    setPlatform("win32"); delayedWindowsQuery(6000);
    const pending = captureControllerProcessProof("controlled").then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fixture.job).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ value: { ...proof(process.pid), jobObjectName: "Local\\Daynight-controlled" } });
    expect(fixture.job).toHaveBeenCalledExactlyOnceWith("controlled", process.pid);
  });

  it("preserves a real startup timeout without assigning a Job Object or retrying", async () => {
    setPlatform("win32"); const failure = delayedWindowsQuery(16_000);
    const pending = captureControllerProcessProof("controlled").catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toBe(failure);
    expect(fixture.job).not.toHaveBeenCalled(); expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it("honors an explicit capture deadline and preserves its original timeout", async () => {
    setPlatform("win32"); const failure = delayedWindowsQuery(6000);
    const pending = captureProcessProof(42, 5000).catch(error => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe(failure);
    expect(fixture.execute.mock.calls[0]?.[2]).toMatchObject({ timeout: 5000 });
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it.each(["win32", "linux"])("passes an explicit finite capture budget on %s", async target => {
    setPlatform(target);
    expect((await captureProcessProof(42, 15_000)).pid).toBe(42);
    expect(fixture.execute.mock.calls[0]?.[2]).toMatchObject({ timeout: 15_000 });
  });

  it.each([0, -1, Infinity, 1.5, 2_147_483_648])("rejects invalid budget %s before spawning", async budget => {
    await expect(captureProcessProof(42, budget)).rejects.toThrow(/timeout/);
    expect(fixture.execute).not.toHaveBeenCalled();
  });
});

describe("ordinary process ownership inspection", () => {
  it("retains the five-second Windows recapture bound and propagates uncertainty", async () => {
    setPlatform("win32"); const failure = delayedWindowsQuery(6000);
    const liveness = vi.spyOn(process, "kill").mockReturnValue(true);
    const pending = inspectProcessProof(proof(42)).catch(error => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe(failure);
    expect(fixture.execute.mock.calls[0]?.[2]).toMatchObject({ timeout: 5000 });
    expect(fixture.execute).toHaveBeenCalledOnce(); expect(liveness).toHaveBeenCalledTimes(2);
    expect(fixture.job).not.toHaveBeenCalled();
  });
});
