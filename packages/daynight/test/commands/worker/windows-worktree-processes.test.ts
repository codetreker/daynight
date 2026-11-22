import { describe, expect, it } from "vitest";
import { stopWindowsWorktreeProcesses } from "../../../src/commands/worker/windows-worktree-processes.js";
import type { WindowsDirectoryHolder, WindowsDirectoryInventory } from "../../../src/platform/windows-directory-holders.js";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";

const target = "C:\\worktrees\\daynight\\55555555-5555-4555-8555-555555555555";
const holder = (pid: number, directory = target): WindowsDirectoryHolder =>
  ({ pid, birth: BigInt(pid), image: "node.exe", directory, handle: { pid } });

const operations: Operation[] = [];
const operation = (): Operation => {
  const created = createOperation({ limits: { totalMs: 30_000 } });
  operations.push(created);
  return created;
};
const inventory = (holders: readonly WindowsDirectoryHolder[], released: number[] = []): WindowsDirectoryInventory =>
  ({ holders, release: () => { released.push(holders.length); } });

describe("Windows worktree process termination", () => {
  it("terminates every holder of the verified worktree and reports them", async () => {
    const asked: number[] = [];
    const result = await stopWindowsWorktreeProcesses(target, operation(), {
      holders: async () => inventory([holder(10), holder(11, `${target}\\packages`)]),
      terminate: async current => { asked.push(current.pid); },
    });
    expect(asked).toEqual([10, 11]);
    expect(result.terminated).toEqual([10, 11]);
    expect(result.observed).toEqual([
      { pid: 10, image: "node.exe", directory: target },
      { pid: 11, image: "node.exe", directory: `${target}\\packages` },
    ]);
  });

  it("reports an empty result without terminating anything when no process holds the worktree", async () => {
    let asked = 0;
    const result = await stopWindowsWorktreeProcesses(target, operation(), {
      holders: async () => inventory([]),
      terminate: async () => { asked++; },
    });
    expect(asked).toBe(0);
    expect(result).toEqual({ observed: [], terminated: [] });
  });

  it("releases the pinned handles after terminating, and after a termination failure", async () => {
    const released: number[] = [];
    await stopWindowsWorktreeProcesses(target, operation(), {
      holders: async () => inventory([holder(20)], released),
      terminate: async () => {},
    });
    expect(released).toEqual([1]);
    await expect(stopWindowsWorktreeProcesses(target, operation(), {
      holders: async () => inventory([holder(21)], released),
      terminate: async () => { throw new Error("denied"); },
    })).rejects.toThrow("No Windows worktree holder could be terminated");
    expect(released).toEqual([1, 1]);
  });

  it("keeps a partially successful termination rather than discarding the holders it stopped", async () => {
    // One survivor still blocks removal, but the caller's retry decides that;
    // this step reports what it achieved instead of failing the whole attempt.
    const result = await stopWindowsWorktreeProcesses(target, operation(), {
      holders: async () => inventory([holder(30), holder(31)]),
      terminate: async current => { if (current.pid === 30) throw new Error("denied"); },
    });
    expect(result.terminated).toEqual([31]);
    expect(result.observed.map(entry => entry.pid)).toEqual([30, 31]);
  });

  it("fails with every termination error when no holder could be stopped", async () => {
    const first = new Error("denied 40"), second = new Error("denied 41");
    const error = await stopWindowsWorktreeProcesses(target, operation(), {
      holders: async () => inventory([holder(40), holder(41)]),
      terminate: async current => { throw current.pid === 40 ? first : second; },
    }).catch(failure => failure as AggregateError);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([first, second]);
    expect((error as AggregateError).cause).toBe(first);
  });

  it("stops before terminating anything once the operation is cancelled", async () => {
    const current = operation(), asked: number[] = [];
    const controller = new AbortController();
    const cancelled: Operation = { ...current, signal: controller.signal, check: () => { controller.signal.throwIfAborted(); } };
    controller.abort(new Error("cleanup cancelled"));
    await expect(stopWindowsWorktreeProcesses(target, cancelled, {
      holders: async () => inventory([holder(50)]),
      terminate: async entry => { asked.push(entry.pid); },
    })).rejects.toThrow("cleanup cancelled");
    expect(asked).toEqual([]);
  });

  it("releases the pinned handles when cancellation arrives between terminations", async () => {
    const current = operation(), released: number[] = [], asked: number[] = [];
    const controller = new AbortController();
    const cancelled: Operation = { ...current, signal: controller.signal, check: () => { controller.signal.throwIfAborted(); } };
    await expect(stopWindowsWorktreeProcesses(target, cancelled, {
      holders: async () => inventory([holder(60), holder(61)], released),
      terminate: async entry => { asked.push(entry.pid); controller.abort(new Error("cleanup cancelled")); },
    })).rejects.toThrow("cleanup cancelled");
    expect(asked).toEqual([60]);
    expect(released).toEqual([2]);
  });

  it("reports what it observed even when releasing the inventory clears the list", async () => {
    // The inventory in use hands out a copy, so reading it after release
    // happens to work. Nothing in the contract says it must, and an inventory
    // that cleared its list while closing the handles would report that
    // nothing was ever observed while still terminating everything.
    const holders = [holder(120), holder(121)];
    const result = await stopWindowsWorktreeProcesses(target, operation(), {
      holders: async () => ({ holders, release: () => { holders.length = 0; } }),
      terminate: async () => {},
    });
    expect(result.observed.map(entry => entry.pid)).toEqual([120, 121]);
    expect(result.terminated).toEqual([120, 121]);
  });

  it("keeps the cancellation as the cause when releasing the handles also fails", async () => {
    // A throw from the release would replace the error already on its way out,
    // and the caller would read a handle failure where the real cause was the
    // cancellation that ended the loop.
    const current = operation();
    const controller = new AbortController();
    const cancelled: Operation = { ...current, signal: controller.signal, check: () => { controller.signal.throwIfAborted(); } };
    const cancellation = new Error("cleanup cancelled");
    const releaseFailure = new Error("CloseHandle failed");
    const error = await stopWindowsWorktreeProcesses(target, cancelled, {
      holders: async () => ({ holders: [holder(100), holder(101)], release: () => { throw releaseFailure; } }),
      terminate: async () => { controller.abort(cancellation); },
    }).catch(failure => failure as AggregateError);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([cancellation, releaseFailure]);
    expect((error as AggregateError).cause).toBe(cancellation);
  });

  it("reports the release failure on its own when nothing else went wrong", async () => {
    const releaseFailure = new Error("CloseHandle failed");
    await expect(stopWindowsWorktreeProcesses(target, operation(), {
      holders: async () => ({ holders: [holder(110)], release: () => { throw releaseFailure; } }),
      terminate: async () => {},
    })).rejects.toBe(releaseFailure);
  });

  it("reports a termination before cancellation discards the accumulated result", async () => {
    // The return value never arrives on this path, so a caller that read only
    // the result would report that nothing had been terminated. Process 70 is
    // gone either way, which is what the caller has to be able to say.
    const current = operation(), reported: number[] = [];
    const controller = new AbortController();
    const cancelled: Operation = { ...current, signal: controller.signal, check: () => { controller.signal.throwIfAborted(); } };
    await expect(stopWindowsWorktreeProcesses(target, cancelled, {
      holders: async () => inventory([holder(70), holder(71)]),
      terminate: async entry => { if (entry.pid === 70) controller.abort(new Error("cleanup cancelled")); },
      onTerminated: entry => { reported.push(entry.pid); },
    })).rejects.toThrow("cleanup cancelled");
    expect(reported).toEqual([70]);
  });

  it("reports each termination with the image and directory of its holder", async () => {
    const reported: { pid: number; image: string; directory: string }[] = [];
    const nested = `${target}\\packages`;
    const result = await stopWindowsWorktreeProcesses(target, operation(), {
      holders: async () => inventory([holder(80), holder(81, nested)]),
      terminate: async () => {},
      onTerminated: entry => { reported.push(entry); },
    });
    expect(reported).toEqual([
      { pid: 80, image: "node.exe", directory: target },
      { pid: 81, image: "node.exe", directory: nested },
    ]);
    expect(result.terminated).toEqual([80, 81]);
  });

  it("does not report a holder whose termination failed", async () => {
    const reported: number[] = [];
    const result = await stopWindowsWorktreeProcesses(target, operation(), {
      holders: async () => inventory([holder(90), holder(91)]),
      terminate: async entry => { if (entry.pid === 90) throw new Error("access denied"); },
      onTerminated: entry => { reported.push(entry.pid); },
    });
    expect(reported).toEqual([91]);
    expect(result.terminated).toEqual([91]);
  });
});
