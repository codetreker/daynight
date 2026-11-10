import { describe, expect, it, vi } from "vitest";
import { createWindowsReviewJobScope, WindowsReviewJobSetupError } from "../../../src/commands/review/windows-job-scope.js";
import type { WindowsOwnedJobKernel } from "../../../src/platform/windows-job.js";
import { formatError } from "../../../src/platform/diagnostics.js";

const fixture = () => {
  const job = {}, signaled = new Set<number>(), owned = new Set([10, 20]);
  const api: WindowsOwnedJobKernel = {
    create: vi.fn(() => job), killOnClose: vi.fn(), assign: vi.fn(), assignHandle: vi.fn(),
    open: vi.fn(pid => pid), identity: vi.fn(handle => ({ pid: handle as number, parentPid: process.pid, birth: 1n })),
    contains: vi.fn((_job, handle) => owned.has(handle as number)),
    inspect: vi.fn(() => [10, 20]), signaled: vi.fn(handle => signaled.has(handle as number)),
    active: vi.fn(() => 0), terminate: vi.fn(() => { signaled.add(10); signaled.add(20); }),
    closeProcess: vi.fn(), close: vi.fn(),
  };
  return { job, api, signaled, owned };
};
const failed = async (operation: Promise<void>) => { try { await operation; throw new Error("Expected failure."); } catch (error) { return formatError(error); } };

describe("Windows review held Job ownership", () => {
  it("assigns and verifies the retained guardian object before admission, and deduplicates stopping", async () => {
    const f = fixture(), scope = await createWindowsReviewJobScope(f.api);
    expect(f.api.killOnClose).toHaveBeenCalledWith(f.job);
    scope.assignGuardian(10);
    expect(f.api.assignHandle).toHaveBeenCalledWith(f.job, 10);
    expect(f.api.contains).toHaveBeenCalledWith(f.job, 10);
    const stopping = scope.stop(100);
    expect(scope.stop(100)).toBe(stopping);
    await stopping;
    expect(f.api.terminate).toHaveBeenCalledExactlyOnceWith(f.job);
    expect(f.api.closeProcess).toHaveBeenCalledTimes(2);
    expect(f.api.close).toHaveBeenCalledExactlyOnceWith(f.job);
    expect(() => scope.assignGuardian(10)).toThrow("admission is closed");
  });

  it("does not confuse an empty membership list with a captured object's signaled state", async () => {
    const f = fixture(), scope = await createWindowsReviewJobScope(f.api);
    scope.assignGuardian(10);
    f.api.inspect = () => [];
    f.api.terminate = () => {};
    let finished = false;
    const stopping = scope.stop(200).finally(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(finished).toBe(false); expect(f.api.close).not.toHaveBeenCalled();
    f.signaled.add(10);
    await stopping;
    expect(f.api.closeProcess).toHaveBeenCalledExactlyOnceWith(10);
  });

  it("retains the Job when a captured object never signals despite zero active count", async () => {
    const f = fixture(), scope = await createWindowsReviewJobScope(f.api);
    scope.assignGuardian(10); f.api.terminate = () => { f.signaled.add(20); };
    expect(await failed(scope.stop(10))).toContain("did not signal exit");
    expect(f.api.closeProcess).toHaveBeenCalledWith(20);
    expect(f.api.closeProcess).not.toHaveBeenCalledWith(10);
    expect(f.api.close).not.toHaveBeenCalled();
  });

  it("requires zero active membership after releasing signaled observations", async () => {
    const f = fixture(), scope = await createWindowsReviewJobScope(f.api);
    scope.assignGuardian(10); f.api.active = () => 1;
    expect(await failed(scope.stop(10))).toContain("members remain active");
    expect(f.api.closeProcess).toHaveBeenCalledTimes(2);
    expect(f.api.close).not.toHaveBeenCalled();
  });

  it("leaves a reused PID outside the Job alone and tolerates a disappeared member", async () => {
    const f = fixture(), scope = await createWindowsReviewJobScope(f.api);
    scope.assignGuardian(10);
    f.api.inspect = () => [10, 20, 30, 40];
    f.api.open = vi.fn(pid => pid === 40 ? null : pid);
    await scope.stop(100);
    expect(f.api.closeProcess).toHaveBeenCalledWith(30);
    expect(f.signaled.has(30)).toBe(false);
    expect(f.api.assign).not.toHaveBeenCalled();
    expect(f.api.terminate).toHaveBeenCalledExactlyOnceWith(f.job);
  });

  it.each(["open", "identity", "contains", "signaled", "active", "terminate", "closeProcess", "close"] as const)("retains native %s failures", async operation => {
    const f = fixture(), scope = await createWindowsReviewJobScope(f.api);
    scope.assignGuardian(10);
    f.api[operation] = vi.fn(() => { throw new Error(`${operation} failed`); }) as never;
    expect(await failed(scope.stop(10))).toContain(`${operation} failed`);
    if (operation !== "close") expect(f.api.close).not.toHaveBeenCalled();
  });

  it.each(["different guardian", "assignment", "membership"])("refuses %s before command admission", async failure => {
    const f = fixture(), scope = await createWindowsReviewJobScope(f.api);
    if (failure === "different guardian") f.api.identity = handle => ({ pid: handle as number, parentPid: process.pid + 1, birth: 1n });
    if (failure === "assignment") f.api.assignHandle = () => { throw new Error("assignment failed"); };
    if (failure === "membership") f.api.contains = () => false;
    expect(() => scope.assignGuardian(10)).toThrow();
    await scope.stop(100);
  });

  it("retains the lease when kill-on-close setup fails so its caller can clean it", async () => {
    const f = fixture(); f.api.killOnClose = () => { throw new Error("configuration failed"); };
    let setup: WindowsReviewJobSetupError | undefined;
    try { await createWindowsReviewJobScope(f.api); } catch (error) { setup = error as WindowsReviewJobSetupError; }
    expect(setup).toBeInstanceOf(WindowsReviewJobSetupError);
    await setup!.scope.stop(100);
    expect(f.api.close).toHaveBeenCalledExactlyOnceWith(f.job);
  });
});
