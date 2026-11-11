import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ execute: vi.fn(), native: vi.fn(), guardian: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: fixture.execute }));
vi.mock("../../../../src/commands/controller/windows-process-proof.js", () => ({ captureWindowsProcessProof: fixture.native }));
vi.mock("../../../../src/commands/controller/windows-job-launch.js", () => ({ startWindowsJobGuardian: fixture.guardian }));
import { captureControllerProcessProof, captureProcessProof, inspectProcessProof } from "../../../../src/commands/controller/process-proof.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { ...platform, value });
const birth = "2026-11-05T00:00:00.0000000Z", command = "controlled process";
const proof = (pid: number) => ({ pid, parentPid: 1, processGroupId: null, startedAt: birth, commandHash: createHash("sha256").update(command).digest("hex") });
const delayedWindowsQuery = (durationMs: number) => {
  const failure = new Error("Controlled native observation exceeded its budget.");
  fixture.native.mockImplementation((pid, timeout) => new Promise((resolve, reject) => {
    setTimeout(() => timeout < durationMs ? reject(failure) : resolve(proof(pid)), Math.min(durationMs, timeout));
  }));
  return failure;
};

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  fixture.guardian.mockResolvedValue(undefined);
  fixture.native.mockImplementation(async pid => proof(pid));
  fixture.execute.mockImplementation((_file, args, _options, callback) => callback(null, `${args[1]} 1 ${args[1]} Thu Nov 5 00:00:00 2026 ${command}\n`));
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
    if (target === "win32") {
      expect(captured).toEqual(proof(42)); expect(fixture.native).toHaveBeenCalledExactlyOnceWith(42, timeout);
      expect(fixture.execute).not.toHaveBeenCalled();
    } else {
      expect(fixture.execute.mock.calls[0]?.[2]).toMatchObject({ timeout }); expect(fixture.native).not.toHaveBeenCalled();
    }
  });

  it("captures Windows ownership with PowerShell/CIM unavailable", async () => {
    setPlatform("win32");
    fixture.execute.mockImplementation((_file, _args, _options, callback) => callback(Object.assign(new Error("PowerShell/CIM unavailable"), { signal: "SIGTERM", killed: true }), ""));
    expect(await captureProcessProof(42)).toEqual(proof(42));
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("establishes the Controller's self-proof before assigning its Job Object", async () => {
    setPlatform("win32"); delayedWindowsQuery(6000);
    const context = { ticket: { launchId: "controlled" } as never, journalPath: "/original/journal.sqlite" };
    const pending = captureControllerProcessProof("controlled", context).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fixture.guardian).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ value: { ...proof(process.pid), jobObjectName: "Local\\Daynight-controlled" } });
    expect(fixture.guardian).toHaveBeenCalledExactlyOnceWith({ ...context, controller: proof(process.pid) });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("preserves a startup failure without launching a guardian or falling back", async () => {
    setPlatform("win32"); const failure = new Error("Original native capture failed"); fixture.native.mockRejectedValue(failure);
    await expect(captureControllerProcessProof("controlled")).rejects.toBe(failure);
    expect(fixture.guardian).not.toHaveBeenCalled(); expect(fixture.native).toHaveBeenCalledOnce(); expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("honors an explicit capture deadline and preserves its original failure", async () => {
    setPlatform("win32"); const failure = delayedWindowsQuery(6000);
    const pending = captureProcessProof(42, 5000).catch(error => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe(failure);
    expect(fixture.native).toHaveBeenCalledExactlyOnceWith(42, 5000); expect(fixture.execute).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux"])("passes an explicit finite capture budget on %s", async target => {
    setPlatform(target);
    expect((await captureProcessProof(42, 15_000)).pid).toBe(42);
    if (target === "win32") expect(fixture.native).toHaveBeenCalledExactlyOnceWith(42, 15_000);
    else expect(fixture.execute.mock.calls[0]?.[2]).toMatchObject({ timeout: 15_000 });
  });

  it.each([0, -1, Infinity, 1.5, 2_147_483_648])("rejects invalid budget %s before observation", async budget => {
    await expect(captureProcessProof(42, budget)).rejects.toThrow(/timeout/);
    expect(fixture.execute).not.toHaveBeenCalled(); expect(fixture.native).not.toHaveBeenCalled();
  });
});

describe("ordinary process ownership inspection", () => {
  it("retains the five-second Windows recapture bound and propagates uncertainty", async () => {
    setPlatform("win32"); const failure = delayedWindowsQuery(6000);
    const liveness = vi.spyOn(process, "kill").mockReturnValue(true);
    const pending = inspectProcessProof(proof(42)).catch(error => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe(failure);
    expect(fixture.native).toHaveBeenCalledExactlyOnceWith(42, 5000);
    expect(liveness).toHaveBeenCalledTimes(2); expect(fixture.guardian).not.toHaveBeenCalled(); expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("detects a reused Windows PID with a different birth", async () => {
    setPlatform("win32"); vi.spyOn(process, "kill").mockReturnValue(true);
    fixture.native.mockResolvedValue({ ...proof(42), startedAt: "replacement" });
    expect(await inspectProcessProof(proof(42))).toBe("replaced");
  });

  it("confirms running Windows ownership when the complete proof still matches", async () => {
    setPlatform("win32"); vi.spyOn(process, "kill").mockReturnValue(true);
    expect(await inspectProcessProof(proof(42))).toBe("running");
  });

  it.each([{ commandHash: "different-command-evidence" }, { processGroupId: 42 }])("retains unknown Windows ownership for a live original birth with conflicting evidence %j", async mismatch => {
    setPlatform("win32"); vi.spyOn(process, "kill").mockReturnValue(true);
    fixture.native.mockResolvedValue({ ...proof(42), ...mismatch });
    await expect(inspectProcessProof(proof(42))).rejects.toThrow("ownership remains unknown");
  });

  it("retains POSIX replacement semantics for a changed command with the same birth", async () => {
    setPlatform("linux"); vi.spyOn(process, "kill").mockReturnValue(true);
    const original = await captureProcessProof(42);
    fixture.execute.mockImplementation((_file, args, _options, callback) => callback(null, `${args[1]} 1 ${args[1]} Thu Nov 5 00:00:00 2026 different command\n`));
    expect(await inspectProcessProof(original)).toBe("replaced");
  });
});
