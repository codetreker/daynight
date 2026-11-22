import path from "node:path";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { removeWorktreeContents } from "../../../src/commands/worker/remove-worktree-contents.js";
import { stopWindowsWorktreeProcesses } from "../../../src/commands/worker/windows-worktree-processes.js";
import { windowsDirectoryHolders } from "../../../src/platform/windows-directory-holders.js";
import { createOperation } from "../../../src/api/operation.js";

const shell = "C:\\Windows\\System32\\cmd.exe";
const windows = process.platform === "win32";
const code = (error: unknown): string | undefined => (error instanceof Error && "code" in error ? (error as { code?: string }).code : undefined);
const identity = async (target: string): Promise<string> => { const entry = await lstat(target, { bigint: true }); return `${entry.dev}:${entry.ino}`; };
const operation = () => createOperation({ limits: { totalMs: 60_000 } });

const children: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
});

/** A live shell whose working directory is `directory`, kept open by `pause`. */
const holdDirectory = async (directory: string): Promise<number> => {
  const child = spawn(shell, ["/c", "pause"], { cwd: directory, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  // The working directory is assigned during startup; poll rather than sleep.
  for (let attempt = 0; attempt < 100; attempt++) {
    const inventory = await windowsDirectoryHolders(directory, () => {});
    const found = inventory.holders.some(holder => holder.pid === child.pid);
    inventory.release();
    if (found) return child.pid!;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return child.pid!;
};

describe.skipIf(!windows)("Windows worktree recovery against a real holder", () => {
  it("removes a worktree the content walk could not, after terminating its holder", async () => {
    const base = path.resolve("../../.tmp/holder-tests");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, "recovery-")); roots.push(root);
    const target = path.join(root, "worktree"), nested = path.join(target, "packages", "daynight");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "keep.txt"), "retained");
    const pid = await holdDirectory(nested);
    const leaf = await identity(target);

    let refused: unknown;
    try { await removeWorktreeContents({ target, expectedIdentity: leaf, operation: operation() }); }
    catch (error) { refused = error; }
    // The recovery is wired to EBUSY, and this is where that code comes from:
    // the walk removes each directory with a nonrecursive `rmdir`, which is
    // what Windows answers for a directory held as a working directory. A
    // recursive `rm` over the same tree reports EPERM instead, so a refactor
    // to one would leave this failure unrecognized and the recovery unreached.
    expect(code(refused)).toBe("EBUSY");
    expect(existsSync(nested)).toBe(true);

    const stop = await stopWindowsWorktreeProcesses(target, operation());
    expect(stop.observed.map(entry => entry.pid)).toContain(pid);
    expect(stop.terminated).toContain(pid);

    await removeWorktreeContents({ target, expectedIdentity: leaf, operation: operation() });
    expect(existsSync(path.join(target, "packages"))).toBe(false);
  }, 90_000);

  it("terminates the working-directory holder and leaves a process that only has a file open", async () => {
    const base = path.resolve("../../.tmp/holder-tests");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, "fileholder-")); roots.push(root);
    const target = path.join(root, "worktree"), nested = path.join(target, "packages");
    await mkdir(nested, { recursive: true });
    const file = path.join(nested, "held.txt"), marker = path.join(root, "ready.txt");
    await writeFile(file, "retained");

    // Holds the file and nothing else: its working directory is outside the
    // worktree. Over-terminating here would end a process that was never an
    // obstacle, which is the risk this target carries. It reports only after
    // the descriptor is open, so an unopened file cannot pass for a held one.
    const reader = spawn(process.execPath, ["-e", "const fs=require('fs');fs.openSync(process.argv[1],'r');fs.writeFileSync(process.argv[2],'held');setTimeout(() => {}, 600000)", file, marker], { cwd: base, stdio: "ignore" });
    children.push(reader);
    for (let attempt = 0; attempt < 300 && !existsSync(marker); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(existsSync(marker)).toBe(true);
    const held = await holdDirectory(nested);

    const stop = await stopWindowsWorktreeProcesses(target, operation());
    expect(stop.terminated).toContain(held);
    expect(stop.observed.map(entry => entry.pid)).not.toContain(reader.pid);
    expect(stop.terminated).not.toContain(reader.pid);
    // Still running: nothing ended it, and nothing had reason to.
    expect(() => process.kill(reader.pid!, 0)).not.toThrow();

    // Its open file does not refuse removal either, so the retry completes
    // with that process still holding the descriptor.
    await removeWorktreeContents({ target, expectedIdentity: await identity(target), operation: operation() });
    expect(existsSync(nested)).toBe(false);
    expect(() => process.kill(reader.pid!, 0)).not.toThrow();
  }, 90_000);

  it("leaves the holder alone when its working directory is outside the worktree", async () => {
    const base = path.resolve("../../.tmp/holder-tests");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, "untouched-")); roots.push(root);
    const target = path.join(root, "worktree"), outside = path.join(root, "outside");
    await mkdir(target); await mkdir(outside);
    const pid = await holdDirectory(outside);

    const stop = await stopWindowsWorktreeProcesses(target, operation());
    expect(stop.observed.map(entry => entry.pid)).not.toContain(pid);
    expect(stop.terminated).not.toContain(pid);
    const inventory = await windowsDirectoryHolders(outside, () => {});
    try { expect(inventory.holders.map(holder => holder.pid)).toContain(pid); }
    finally { inventory.release(); }
  }, 90_000);
});
