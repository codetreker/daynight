import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { createWindowsCommandJob, WindowsCommandCleanupError, WindowsCommandJobSetupError } from "../../src/platform/windows-command-job.js";
import type { WindowsCommandJobKernel } from "../../src/platform/windows-job.js";

const fixture = () => {
  const job = {}, signaled = new Set<number>(), owned = new Set([10, 20]), events: string[] = [];
  const api: WindowsCommandJobKernel = {
    create: vi.fn(() => { throw new Error("Named Job was not expected."); }), createAnonymousJob: vi.fn(() => job),
    killOnClose: vi.fn(() => { events.push("armed"); }), sealAdmissions: vi.fn(() => { events.push("sealed"); }),
    clearKillOnClose: vi.fn(() => { events.push("disarmed"); }), restoreKillOnClose: vi.fn(() => { events.push("restored"); }),
    assign: vi.fn(), assignHandle: vi.fn(), open: vi.fn(pid => pid),
    identity: vi.fn(handle => ({ pid: handle as number, parentPid: process.pid, birth: 1n })),
    contains: vi.fn((_job, handle) => owned.has(handle as number)),
    inspect: vi.fn(() => { events.push("inventory"); return [10, 20]; }),
    signaled: vi.fn(handle => signaled.has(handle as number)), active: vi.fn(() => 0),
    terminate: vi.fn(() => { events.push("terminate"); signaled.add(10); signaled.add(20); }),
    closeProcess: vi.fn(), close: vi.fn(() => { events.push("close"); }),
  };
  return { job, api, signaled, owned, events };
};
const owner = (f: ReturnType<typeof fixture>) => createWindowsCommandJob(f.api, { anonymous: true, seal: true, name: null });
const rejection = async (pending: Promise<void>): Promise<WindowsCommandCleanupError> => {
  try { await pending; throw new Error("Expected rejected cleanup."); }
  catch (error) { expect(error).toBeInstanceOf(WindowsCommandCleanupError); return error as WindowsCommandCleanupError; }
};

describe("Windows command Job lifetime policies", () => {
  it("creates anonymous ownership and seals before inventory or termination", async () => {
    const f = fixture(), scope = owner(f); scope.assignGate(10);
    const pending = scope.stopUntil(performance.now() + 100);
    expect(scope.stopUntil(performance.now() + 100)).toBe(pending);
    await pending;
    expect(f.api.createAnonymousJob).toHaveBeenCalledOnce(); expect(f.api.create).not.toHaveBeenCalled();
    expect(f.api.assignHandle).toHaveBeenCalledWith(f.job, 10);
    expect(f.events).toEqual(["armed", "sealed", "inventory", "terminate", "close"]);
    expect(f.api.closeProcess).toHaveBeenCalledTimes(2);
    expect(() => scope.assignGate(20)).toThrow("admission is closed");
  });

  it("preserves a seal failure and still terminates without a substitute limit", async () => {
    const f = fixture(), scope = owner(f), failed = new Error("seal failed"); scope.assignGate(10);
    f.api.sealAdmissions = vi.fn(() => { throw failed; });
    const error = await rejection(scope.stopUntil(performance.now() + 100));
    expect(error.errors[0]).toBe(failed); expect(f.api.terminate).toHaveBeenCalledOnce();
    expect(f.api.close).not.toHaveBeenCalled(); expect(f.api.closeProcess).not.toHaveBeenCalled();
    expect(scope.requestFailureClose()).toEqual([]); expect(scope.requestFailureClose()).toEqual([]);
    expect(f.api.terminate).toHaveBeenCalledOnce(); expect(f.api.close).toHaveBeenCalledOnce();
    expect(scope.closeObservations()).toEqual([]); expect(f.api.closeProcess).toHaveBeenCalledTimes(2);
    expect(error.errors[0]).toBe(failed);
  });

  it("does not replace a held pending object's signal with zero active membership", async () => {
    const f = fixture(), scope = owner(f); scope.assignGate(10);
    f.api.inspect = () => []; f.api.terminate = () => {};
    let completed = false;
    const pending = scope.stopUntil(performance.now() + 100).finally(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(completed).toBe(false);
    f.signaled.add(10); await pending;
    expect(f.api.close).toHaveBeenCalledOnce();
  });

  it("finalizes an unconfirmed stop without erasing pending-object failure", async () => {
    const f = fixture(), scope = owner(f); scope.assignGate(10);
    f.api.terminate = vi.fn(() => { f.signaled.add(20); });
    const error = await rejection(scope.stopUntil(performance.now() + 5));
    expect(String(error.errors[0])).toContain("did not signal exit");
    expect(f.api.closeProcess).not.toHaveBeenCalled();
    scope.requestFailureClose(); scope.closeObservations();
    expect(f.api.close).toHaveBeenCalledOnce(); expect(f.api.closeProcess).toHaveBeenCalledTimes(2);
    expect(String(error.errors[0])).toContain("did not signal exit"); expect(scope.killPolicy).toBe("ON");
  });

  it("retains the native termination error through one final close and individual observation releases", async () => {
    const f = fixture(), scope = owner(f), denied = new Error("native access denied"), closeFailed = new Error("close failed"); scope.assignGate(10);
    f.api.terminate = vi.fn(() => { throw denied; });
    f.api.close = vi.fn(() => { throw closeFailed; });
    const error = await rejection(scope.stopUntil(performance.now() + 5));
    expect(error.errors[0]).toBe(denied);
    expect(scope.requestFailureClose()).toEqual([closeFailed]);
    expect(scope.requestFailureClose()).toEqual([]);
    scope.closeObservations();
    expect(f.api.terminate).toHaveBeenCalledOnce(); expect(f.api.close).toHaveBeenCalledOnce();
    expect(f.api.closeProcess).toHaveBeenCalledTimes(2); expect(error.errors[0]).toBe(denied);
  });

  it("excludes a stale unrelated PID object and handles a disappeared list member", async () => {
    const f = fixture(), scope = owner(f); scope.assignGate(10);
    f.api.inspect = () => [10, 20, 30, 40]; f.api.open = vi.fn(pid => pid === 40 ? null : pid);
    await scope.stopUntil(performance.now() + 100);
    expect(f.api.closeProcess).toHaveBeenCalledWith(30); expect(f.signaled.has(30)).toBe(false);
    expect(f.api.assign).not.toHaveBeenCalled();
  });

  it("commits OFF synchronously before closing while leaving background members alone", () => {
    const f = fixture(), scope = owner(f); scope.assignGate(10); f.signaled.add(10);
    scope.release(() => { expect(scope.killPolicy).toBe("OFF"); expect(f.api.close).not.toHaveBeenCalled(); f.events.push("commit"); });
    expect(f.events).toEqual(["armed", "disarmed", "commit", "close"]);
    expect(f.api.inspect).not.toHaveBeenCalled(); expect(f.api.sealAdmissions).not.toHaveBeenCalled();
    expect(f.api.terminate).not.toHaveBeenCalled(); expect(f.signaled.has(20)).toBe(false);
    expect(scope.requestFailureClose()[0]).toBeInstanceOf(Error); expect(f.api.terminate).not.toHaveBeenCalled();
  });

  it("keeps OFF after close failure without rearming or terminating released members", () => {
    const f = fixture(), scope = owner(f), failed = new Error("close failed"); scope.assignGate(10); f.signaled.add(10);
    f.api.close = vi.fn(() => { throw failed; });
    let error: unknown;
    try { scope.release(() => {}); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(WindowsCommandCleanupError); expect((error as WindowsCommandCleanupError).errors).toEqual([failed]);
    expect(scope.killPolicy).toBe("OFF"); expect(scope.restoreKillOnCloseUntil(performance.now() + 10)).toEqual([]);
    expect(f.api.restoreKillOnClose).not.toHaveBeenCalled(); expect(f.api.terminate).not.toHaveBeenCalled();
    expect(f.api.closeProcess).toHaveBeenCalledOnce();
  });

  it("records UNKNOWN before a failed disarm and attempts ON restoration only once", () => {
    const f = fixture(), scope = owner(f), failed = new Error("clear failed"), restoreFailed = new Error("restore failed"); scope.assignGate(10); f.signaled.add(10);
    f.api.clearKillOnClose = () => { expect(scope.killPolicy).toBe("UNKNOWN"); throw failed; };
    expect(() => scope.release(() => {})).toThrow(failed);
    f.api.restoreKillOnClose = vi.fn(() => { throw restoreFailed; });
    expect(scope.restoreKillOnCloseUntil(performance.now() + 100)).toEqual([restoreFailed]);
    expect(scope.restoreKillOnCloseUntil(performance.now() + 100)).toEqual([restoreFailed]);
    expect(f.api.restoreKillOnClose).toHaveBeenCalledOnce(); expect(scope.killPolicy).toBe("UNKNOWN");
    scope.requestFailureClose(); expect(f.api.close).toHaveBeenCalledOnce();
  });

  it("restores ON without granting another wait budget", () => {
    const f = fixture(), scope = owner(f); scope.assignGate(10); f.signaled.add(10);
    f.api.clearKillOnClose = () => { throw new Error("clear failed"); };
    expect(() => scope.release(() => {})).toThrow("clear failed");
    expect(scope.restoreKillOnCloseUntil(performance.now() - 1)).toHaveLength(1);
    expect(scope.restoreKillOnCloseUntil(performance.now() + 100)).toHaveLength(1);
    expect(f.api.restoreKillOnClose).not.toHaveBeenCalled(); expect(scope.killPolicy).toBe("UNKNOWN");
  });

  it("preserves partially configured ownership for its caller's finite cleanup", () => {
    const f = fixture(), failed = new Error("configuration failed"); f.api.killOnClose = () => { throw failed; };
    let setup: WindowsCommandJobSetupError | undefined;
    try { owner(f); } catch (error) { setup = error as WindowsCommandJobSetupError; }
    expect(setup).toBeInstanceOf(WindowsCommandJobSetupError); expect(setup!.cause).toBe(failed);
    expect(setup!.scope.requestFailureClose()).toEqual([]); setup!.scope.closeObservations();
    expect(f.api.close).toHaveBeenCalledOnce();
  });
});
