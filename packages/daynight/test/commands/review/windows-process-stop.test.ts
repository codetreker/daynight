import { describe, expect, it, vi } from "vitest";
import { stopWindowsProcessTree } from "../../../src/commands/review/windows-process-stop.js";
import type { WindowsProcessStopKernel } from "../../../src/commands/review/windows-process-stop.js";
import { formatError } from "../../../src/platform/diagnostics.js";

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
const diagnosticFailure = async (operation: Promise<void>) => {
  try { await operation; throw new Error("Expected failure."); }
  catch (error) {
    const text = formatError(error);
    const prefix = "Windows review ancestry: ";
    const line = text.split("\n").find(value => value.startsWith(prefix));
    expect(line).toBeDefined();
    return { text, ancestry: JSON.parse(line!.slice(prefix.length)) };
  }
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
    const { ancestry } = await diagnosticFailure(stopWindowsProcessTree(f.options, f.api));
    expect(ancestry).toEqual({ schemaVersion: 1, root: { pid: 10, parentPid: process.pid, birth: "1" }, liveRejected: 1, omitted: 0,
      candidates: [{ reason: "parent-unproven", snapshot: { pid: 30, parentPid: 20 },
        member: { pid: 30, parentPid: 20, birth: "3" }, parent: null, signaled: false }] });
    expect(f.api.open).toHaveBeenCalledWith(30);
    expect(f.options.terminate).toHaveBeenCalledOnce();
    expect(f.api.close).toHaveBeenCalledTimes(2);
  });

  it.each(["different parent", "older child"])("rejects a reused PID with %s and retains the original kill attempt", async kind => {
    const f = fixture();
    f.identities.set(30, { pid: 30, parentPid: kind === "different parent" ? 90 : 20, birth: kind === "older child" ? 1n : 3n });
    Object.assign(f.rows.find(row => row.pid === 30)!, { commandLine: "fixture-command-line", environment: "fixture-environment" });
    Object.assign(f.identities.get(30)!, { commandLine: "fixture-command-line", environment: "fixture-environment" });
    const { text, ancestry } = await diagnosticFailure(stopWindowsProcessTree(f.options, f.api));
    expect(ancestry.candidates).toEqual([{ reason: kind === "different parent" ? "parent-changed" : "child-predates-parent",
      snapshot: { pid: 30, parentPid: 20 }, member: { pid: 30, parentPid: kind === "different parent" ? 90 : 20, birth: kind === "older child" ? "1" : "3" },
      parent: { pid: 20, parentPid: 10, birth: "2" }, signaled: false }]);
    expect(text).not.toContain("fixture-command-line"); expect(text).not.toContain("fixture-environment");
    expect(f.options.terminate).toHaveBeenCalledOnce();
    expect(f.api.close).toHaveBeenCalledTimes(3);
  });

  it("retains the failure for an unrelated old branch alongside a stopped owned tree", async () => {
    const f = fixture();
    for (const identity of f.identities.values()) identity.birth += 9_007_199_254_740_999n;
    // Windows can reuse an exited parent's PID while its old descendants live:
    // https://devblogs.microsoft.com/oldnewthing/20150403-00/?p=44313
    for (const identity of [
      { pid: 40, parentPid: 10, birth: 1n }, { pid: 50, parentPid: 40, birth: 2n },
      { pid: 60, parentPid: 50, birth: 3n }, { pid: 70, parentPid: 60, birth: 4n },
    ]) { f.identities.set(identity.pid, identity); f.rows.push({ pid: identity.pid, parentPid: identity.parentPid }); }
    // Only the known owned processes stop. This does not model taskkill's native target selection.
    f.options.terminate = vi.fn(async () => { for (const pid of [10, 20, 30]) f.signaled.add(pid); });
    const { ancestry } = await diagnosticFailure(stopWindowsProcessTree(f.options, f.api));
    expect(ancestry.root).toEqual({ pid: 10, parentPid: process.pid, birth: "9007199254741000" });
    expect(ancestry.liveRejected).toBe(4);
    expect(ancestry.omitted).toBe(0);
    expect(ancestry.candidates.map((candidate: { reason: string }) => candidate.reason)).toEqual([
      "child-predates-parent", "parent-unproven", "parent-unproven", "parent-unproven",
    ]);
    expect([...f.signaled]).toEqual([10, 20, 30]);
    expect(f.options.terminate).toHaveBeenCalledOnce();
    expect(f.api.close).toHaveBeenCalledTimes(7);
  });

  it("does not report an already signaled older child as a live ancestry failure", async () => {
    const f = fixture(); f.identities.get(30)!.birth = 1n; f.signaled.add(30);
    await stopWindowsProcessTree(f.options, f.api);
    expect(f.options.terminate).toHaveBeenCalledOnce();
    expect(f.api.close).toHaveBeenCalledTimes(3);
  });

  it("bounds ancestry facts without truncating inventory, failure or handle cleanup", async () => {
    const f = fixture();
    for (const identity of f.identities.values()) identity.birth += 100n;
    for (let pid = 40; pid < 60; pid++) {
      f.identities.set(pid, { pid, parentPid: 10, birth: 1n }); f.rows.push({ pid, parentPid: 10 });
    }
    f.options.terminate = vi.fn(async () => { for (const pid of [10, 20, 30]) f.signaled.add(pid); throw new Error("taskkill failed"); });
    f.api.close = vi.fn(handle => { if (handle === 10) throw new Error("close failed"); });
    const { text, ancestry } = await diagnosticFailure(stopWindowsProcessTree(f.options, f.api));
    expect(ancestry.liveRejected).toBe(20);
    expect(ancestry.candidates).toHaveLength(8);
    expect(ancestry.omitted).toBe(12);
    expect(ancestry.candidates.every((candidate: { reason: string }) => candidate.reason === "child-predates-parent")).toBe(true);
    expect(text).toContain("taskkill failed"); expect(text).toContain("close failed");
    expect(f.api.open).toHaveBeenCalledWith(59);
    expect(f.options.terminate).toHaveBeenCalledOnce();
    expect(f.api.close).toHaveBeenCalledTimes(23);
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
