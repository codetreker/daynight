import { describe, expect, it } from "vitest";
import { windowsDirectoryHolders, type WindowsDirectoryHolderKernel } from "../../src/platform/windows-directory-holders.js";

const root = "C:\\worktrees\\daynight\\55555555-5555-4555-8555-555555555555";
const check = (): void => {};

const kernelFor = (rows: readonly { pid: number; image: string; directory?: string; birth?: bigint }[], closed: number[] = []): WindowsDirectoryHolderKernel => ({
  processes: () => rows.map(({ pid, image }) => ({ pid, image })),
  inspect: pid => {
    const row = rows.find(entry => entry.pid === pid);
    if (row === undefined || row.directory === undefined) return null;
    return { birth: row.birth ?? 1n, directory: row.directory, handle: { pid } };
  },
  close: handle => { closed.push((handle as { pid: number }).pid); },
});

describe("Windows directory holders", () => {
  it("reports the processes whose working directory is the root or below it", async () => {
    const kernel = kernelFor([
      { pid: 10, image: "node.exe", directory: root },
      { pid: 11, image: "git.exe", directory: `${root}\\packages\\app` },
      { pid: 12, image: "node.exe", directory: "C:\\worktrees\\daynight\\other" },
      { pid: 13, image: "code.exe", directory: "C:\\Users\\someone" },
    ]);
    const inventory = await windowsDirectoryHolders(root, check, kernel);
    expect(inventory.holders.map(holder => holder.pid)).toEqual([10, 11]);
    inventory.release();
  });

  it("does not treat a sibling that merely shares the root's prefix as a holder", async () => {
    // A path comparison without a separator boundary would accept this one.
    const kernel = kernelFor([{ pid: 20, image: "node.exe", directory: `${root}-backup` }]);
    const inventory = await windowsDirectoryHolders(root, check, kernel);
    expect(inventory.holders).toEqual([]);
    inventory.release();
  });

  it("matches without regard to case or a trailing separator", async () => {
    const kernel = kernelFor([
      { pid: 30, image: "node.exe", directory: `${root.toUpperCase()}\\` },
      { pid: 31, image: "node.exe", directory: `${root.toLowerCase()}\\sub\\` },
    ]);
    const inventory = await windowsDirectoryHolders(root, check, kernel);
    expect(inventory.holders.map(holder => holder.pid)).toEqual([30, 31]);
    inventory.release();
  });

  it("skips a process it cannot read instead of failing the inventory", async () => {
    const kernel = kernelFor([
      { pid: 40, image: "secure.exe" },
      { pid: 41, image: "node.exe", directory: root },
    ]);
    const inventory = await windowsDirectoryHolders(root, check, kernel);
    expect(inventory.holders.map(holder => holder.pid)).toEqual([41]);
    inventory.release();
  });

  it("never reports this process, whose own directory is not evidence of a stale holder", async () => {
    const kernel = kernelFor([{ pid: process.pid, image: "node.exe", directory: root }]);
    const inventory = await windowsDirectoryHolders(root, check, kernel);
    expect(inventory.holders).toEqual([]);
    inventory.release();
  });

  it("closes the handles of processes outside the root and of reported holders on release", async () => {
    const closed: number[] = [];
    const kernel = kernelFor([
      { pid: 50, image: "node.exe", directory: root },
      { pid: 51, image: "node.exe", directory: "C:\\elsewhere" },
    ], closed);
    const inventory = await windowsDirectoryHolders(root, check, kernel);
    // The unrelated process is released immediately; the holder is pinned
    // until the caller has finished acting on it.
    expect(closed).toEqual([51]);
    inventory.release();
    expect(closed).toEqual([51, 50]);
  });

  it("releases every captured handle when the inventory fails partway", async () => {
    const closed: number[] = [];
    const failure = new Error("inventory interrupted");
    const base = kernelFor([{ pid: 60, image: "node.exe", directory: root }], closed);
    let inspected = 0;
    const kernel: WindowsDirectoryHolderKernel = {
      ...base,
      processes: () => [{ pid: 60, image: "node.exe" }, { pid: 61, image: "node.exe" }],
      inspect: pid => { if (++inspected > 1) throw failure; return base.inspect(pid); },
    };
    await expect(windowsDirectoryHolders(root, check, kernel)).rejects.toBe(failure);
    expect(closed).toEqual([60]);
  });

  it("carries the observed creation time so a caller can pin the identifier", async () => {
    const kernel = kernelFor([{ pid: 70, image: "node.exe", directory: root, birth: 133_000_000_000_000_000n }]);
    const inventory = await windowsDirectoryHolders(root, check, kernel);
    expect(inventory.holders[0]).toMatchObject({ pid: 70, birth: 133_000_000_000_000_000n, image: "node.exe", directory: root });
    inventory.release();
  });

  it("propagates cancellation from the caller's check", async () => {
    const cancelled = new Error("cancelled");
    const kernel = kernelFor([{ pid: 80, image: "node.exe", directory: root }]);
    await expect(windowsDirectoryHolders(root, () => { throw cancelled; }, kernel)).rejects.toBe(cancelled);
  });
});
