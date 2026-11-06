import { describe, expect, it, vi } from "vitest";
import { stopWindowsProcessTree, type WindowsProcessStopKernel } from "../../../src/commands/review/windows-process-stop.js";

type Identity = { pid: number; parentPid: number; birth: bigint };
const fixture = () => {
  const identities = new Map<number, Identity>([
    [10, { pid: 10, parentPid: process.pid, birth: 1n }],
    [20, { pid: 20, parentPid: 10, birth: 2n }],
    [30, { pid: 30, parentPid: 20, birth: 3n }],
  ]);
  const rows = [...identities.values()].map(({ pid, parentPid }) => ({ pid, parentPid }));
  const signaled = new Set<number>();
  const api: WindowsProcessStopKernel = {
    open: vi.fn(pid => identities.has(pid) ? pid : null),
    identity: vi.fn(handle => identities.get(handle as number)!),
    snapshot: vi.fn(() => rows),
    signaled: vi.fn(handle => signaled.has(handle as number)),
    close: vi.fn(),
  };
  const terminate = vi.fn(async () => { for (const pid of identities.keys()) signaled.add(pid); });
  const options: Parameters<typeof stopWindowsProcessTree>[0] = { pid: 10, graceMs: 200, assertCurrent: vi.fn(), terminate };
  return { identities, rows, signaled, api, options };
};
const messages = (error: unknown): string => error instanceof AggregateError ? `${error.message}: ${error.errors.map(messages).join("; ")}` : String(error);
const failure = async (operation: Promise<void>): Promise<string> => {
  try { await operation; throw new Error("Expected failure."); } catch (error) { return messages(error); }
};

describe("Windows review termination confirmation", () => {
  it("joins the retained leaf after taskkill and both ancestors have exited", async () => {
    const f = fixture();
    let releaseLeaf!: () => void;
    f.options.terminate = vi.fn(async () => { f.signaled.add(10); f.signaled.add(20); });
    const leafPending = new Promise<void>(resolve => { releaseLeaf = resolve; });
    f.api.signaled = vi.fn(handle => {
      if (handle === 30 && f.signaled.has(10) && !f.signaled.has(30)) releaseLeaf();
      return f.signaled.has(handle as number);
    });
    let settled = false;
    const operation = stopWindowsProcessTree(f.options, f.api).finally(() => { settled = true; });
    await leafPending;
    expect(settled).toBe(false);
    expect(f.api.close).not.toHaveBeenCalled();
    f.signaled.add(30);
    await operation;
    expect(f.api.close).toHaveBeenCalledTimes(3);
    expect(f.options.terminate).toHaveBeenCalledOnce();
  });

  it("retains failure when a captured leaf never signals", async () => {
    const f = fixture(); f.options.graceMs = 10;
    f.options.terminate = vi.fn(async () => { f.signaled.add(10); f.signaled.add(20); });
    expect(await failure(stopWindowsProcessTree(f.options, f.api))).toContain("did not signal exit");
    expect(f.api.close).toHaveBeenCalledTimes(3);
  });

  it.each(["leaf", "whole branch"])("accepts an already disappeared %s without abandoning inventory", async kind => {
    const f = fixture(); f.identities.delete(30);
    if (kind === "whole branch") f.identities.delete(20);
    await stopWindowsProcessTree(f.options, f.api);
    expect(f.api.open).toHaveBeenCalledWith(30);
    expect(f.options.terminate).toHaveBeenCalledOnce();
  });

  it("retains a live descendant beyond a vanished intermediate as uncertain while still attempting taskkill", async () => {
    const f = fixture(); f.identities.delete(20);
    expect(await failure(stopWindowsProcessTree(f.options, f.api))).toContain("cannot be attributed");
    expect(f.api.open).toHaveBeenCalledWith(30);
    expect(f.options.terminate).toHaveBeenCalledOnce();
    expect(f.api.close).toHaveBeenCalledTimes(2);
  });

  it.each(["different parent", "older child"])("rejects a reused PID with %s and retains the original kill attempt", async kind => {
    const f = fixture();
    f.identities.set(30, { pid: 30, parentPid: kind === "different parent" ? 90 : 20, birth: kind === "older child" ? 1n : 3n });
    expect(await failure(stopWindowsProcessTree(f.options, f.api))).toContain("cannot be attributed");
    expect(f.options.terminate).toHaveBeenCalledOnce();
    expect(f.api.close).toHaveBeenCalledTimes(3);
  });

  it("does not target the root PID after the root signals during inventory", async () => {
    const f = fixture();
    f.api.snapshot = () => { f.signaled.add(10); return f.rows; };
    expect(await failure(stopWindowsProcessTree(f.options, f.api))).toContain("root exited");
    expect(f.options.terminate).not.toHaveBeenCalled();
    expect(f.api.close).toHaveBeenCalledTimes(3);
  });

  it("retains inventory and termination failures while closing every acquired handle", async () => {
    const f = fixture();
    f.api.open = vi.fn(pid => { if (pid === 20) throw new Error("access denied"); return pid; });
    f.options.terminate = vi.fn(async () => { f.signaled.add(10); throw new Error("taskkill failed"); });
    const result = await failure(stopWindowsProcessTree(f.options, f.api));
    expect(result).toContain("access denied"); expect(result).toContain("taskkill failed");
    expect(f.api.open).toHaveBeenCalledWith(30);
    expect(f.api.close).toHaveBeenCalledTimes(2);
  });

  it("preserves a native wait failure and attempts all handle releases after a release failure", async () => {
    const f = fixture(); let killed = false;
    f.options.terminate = vi.fn(async () => { killed = true; });
    f.api.signaled = handle => { if (killed && handle === 30) throw new Error("wait failed"); return killed; };
    f.api.close = vi.fn(handle => { if (handle === 10) throw new Error("close failed"); });
    const result = await failure(stopWindowsProcessTree(f.options, f.api));
    expect(result).toContain("wait failed"); expect(result).toContain("close failed");
    expect(f.api.close).toHaveBeenCalledTimes(3);
  });

  it("rechecks the original ChildProcess before acquiring a native handle", async () => {
    const f = fixture(); f.options.assertCurrent = () => { throw new Error("original child closed"); };
    expect(await failure(stopWindowsProcessTree(f.options, f.api))).toContain("original child closed");
    expect(f.api.open).not.toHaveBeenCalled(); expect(f.options.terminate).not.toHaveBeenCalled();
  });
});
