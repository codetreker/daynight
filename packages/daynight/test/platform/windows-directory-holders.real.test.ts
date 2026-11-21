import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { windowsDirectoryHolders, windowsDirectoryHolderKernel } from "../../src/platform/windows-directory-holders.js";

// SysWOW64\cmd.exe is the 32-bit command processor present on every 64-bit
// Windows installation, so a WOW64 holder needs no fixture binary.
const wow64Shell = "C:\\Windows\\SysWOW64\\cmd.exe";
const nativeShell = "C:\\Windows\\System32\\cmd.exe";
const windows = process.platform === "win32";

const children: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  // Windows holds a directory handle briefly after the process that had it as
  // its working directory exits, which is the window these fixtures sit in the
  // moment they are killed. Without retries the removal loses that race, the
  // swallowed failure goes unnoticed, and each run leaves a directory behind.
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
});

/** A live shell whose working directory is `directory`, kept open by `pause`. */
const holdDirectory = async (shell: string, directory: string): Promise<number> => {
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

describe.skipIf(!windows)("Windows directory holders against real processes", () => {
  it("finds a native 64-bit process that holds the directory", async () => {
    const base = path.resolve("../../.tmp/holder-tests");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, "native-")); roots.push(root);
    const held = path.join(root, "held"); await mkdir(held);
    const pid = await holdDirectory(nativeShell, held);
    const inventory = await windowsDirectoryHolders(held, () => {});
    try {
      const holder = inventory.holders.find(entry => entry.pid === pid);
      expect(holder).toBeDefined();
      expect(path.win32.resolve(holder!.directory).toLowerCase()).toBe(path.win32.resolve(held).toLowerCase());
      expect(holder!.birth).toBeGreaterThan(0n);
    } finally { inventory.release(); }
  });

  it.skipIf(!windows || !existsSync(wow64Shell))("finds a 32-bit WOW64 process, whose working directory lives in its 32-bit process parameters", async () => {
    const base = path.resolve("../../.tmp/holder-tests");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, "wow64-")); roots.push(root);
    const held = path.join(root, "held"); await mkdir(held);
    const pid = await holdDirectory(wow64Shell, held);
    // Reading the native structures of this process would yield no usable
    // directory, so a holder here proves the WOW64 layout is used.
    const inventory = await windowsDirectoryHolders(held, () => {});
    try {
      const holder = inventory.holders.find(entry => entry.pid === pid);
      expect(holder).toBeDefined();
      expect(path.win32.resolve(holder!.directory).toLowerCase()).toBe(path.win32.resolve(held).toLowerCase());
    } finally { inventory.release(); }
  });

  it("does not report a process whose working directory is outside the root", async () => {
    const base = path.resolve("../../.tmp/holder-tests");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, "outside-")); roots.push(root);
    const held = path.join(root, "held"), other = path.join(root, "other");
    await mkdir(held); await mkdir(other);
    const pid = await holdDirectory(nativeShell, other);
    const inventory = await windowsDirectoryHolders(held, () => {});
    try { expect(inventory.holders.some(entry => entry.pid === pid)).toBe(false); }
    finally { inventory.release(); }
  });

  it("reads the real parent of a process, which is what the ancestor walk follows", async () => {
    // An injected kernel proves the walk; it cannot prove that the offset the
    // parent is read from describes what Windows stores. A wrong one fails
    // silently: the walk finds nothing and an ancestor holding the worktree
    // gets terminated along with this process. Node knows both answers here.
    const api = await windowsDirectoryHolderKernel();
    const child = spawn(nativeShell, ["/c", "pause"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });

    const rows = api.processes(() => {});
    const self = rows.find(entry => entry.pid === process.pid);
    expect(self).toBeDefined();
    expect(self!.parent).toBe(process.ppid);
    const spawned = rows.find(entry => entry.pid === child.pid);
    expect(spawned).toBeDefined();
    expect(spawned!.parent).toBe(process.pid);
  });
});
