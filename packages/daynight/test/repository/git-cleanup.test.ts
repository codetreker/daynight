import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../src/api/operation.js";
import { runRepositoryGit } from "../../src/repository/git.js";

const boundary = vi.hoisted(() => ({
  wrapper: undefined as string | undefined,
  root: undefined as ChildProcess | undefined,
  rootClosed: undefined as Promise<void> | undefined,
  closed: false,
  terminate: undefined as ((pid: number) => Buffer) | undefined,
  calls: [] as number[],
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn: typeof actual.spawn = (...args: unknown[]) => {
    if (args[0] !== "git" || boundary.wrapper === undefined) return Reflect.apply(actual.spawn, undefined, args);
    const child = actual.spawn(process.execPath, [boundary.wrapper], args[2] as Parameters<typeof actual.spawn>[2]);
    boundary.root = child;
    boundary.rootClosed = new Promise<void>((resolve) => { child.once("close", () => { boundary.closed = true; resolve(); }); });
    return child;
  };
  const execFileSync: typeof actual.execFileSync = (...args: unknown[]) => {
    if (typeof args[0] !== "string" || !/[\\/]System32[\\/]taskkill\.exe$/i.test(args[0])) return Reflect.apply(actual.execFileSync, undefined, args);
    const pid = Number((args[1] as string[])[1]);
    boundary.calls.push(pid);
    if (boundary.terminate === undefined) throw new Error("The taskkill fixture must define its outcome.");
    return boundary.terminate(pid);
  };
  return { ...actual, spawn, execFileSync };
});

const nativeProcess = process;
const directories: string[] = [];
const readTicks = async (filename: string): Promise<string> => readFile(filename, "utf8").catch((error: unknown) => {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
  throw error;
});
const pause = async (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10); });
const kill = (pid: number): void => {
  try { nativeProcess.kill(pid, "SIGKILL"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
};
const waitUntilGone = async (pid: number): Promise<void> => {
  const deadline = performance.now() + 1000;
  for (;;) {
    try { nativeProcess.kill(pid, 0); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return; throw error; }
    if (performance.now() >= deadline) throw new Error(`Owned fixture process ${pid} did not exit.`);
    await pause();
  }
};
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  boundary.wrapper = undefined; boundary.root = undefined; boundary.rootClosed = undefined; boundary.closed = false; boundary.terminate = undefined; boundary.calls.splice(0);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("Windows Git process-tree confirmation", () => {
  it.each([
    { outcome: "confirmed", heartbeatDelayMs: 0 },
    { outcome: "uncertain", heartbeatDelayMs: 0 },
    { outcome: "uncertain", heartbeatDelayMs: 250 },
  ] as const)("preserves the $outcome taskkill outcome after the real wrapper closes with a $heartbeatDelayMs ms heartbeat delay", async ({ outcome, heartbeatDelayMs }) => {
    const scratch = path.resolve(import.meta.dirname, "../../../../.tmp/repository-git-cleanup-tests");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(path.join(scratch, "Cleanup 中文 ")); directories.push(directory);
    const marker = path.join(directory, "descendant ready.json");
    const childPidFile = path.join(directory, "descendant pid.json");
    const ticks = path.join(directory, "ticks");
    const descendant = path.join(directory, "descendant.mjs");
    const wrapper = path.join(directory, "wrapper.mjs");
    await writeFile(descendant, `import { appendFileSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid }));\nsetTimeout(() => setInterval(() => appendFileSync(${JSON.stringify(ticks)}, 'tick\\n'), 10), ${heartbeatDelayMs});\n`);
    // The descendant's working directory must outlive the per-case control files: Windows locks a process's current directory.
    // https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setcurrentdirectory#remarks
    await writeFile(wrapper, `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst child = spawn(process.execPath, [${JSON.stringify(descendant)}], { cwd: ${JSON.stringify(scratch)}, detached: true, windowsHide: true, stdio: 'ignore' });\nwriteFileSync(${JSON.stringify(childPidFile)}, JSON.stringify({ pid: child.pid }));\nchild.once('exit', () => process.exit(0));\nsetInterval(() => {}, 1000);\n`);
    boundary.wrapper = wrapper;
    vi.stubGlobal("process", new Proxy(nativeProcess, { get: (target, key, receiver) => key === "platform" ? "win32" : Reflect.get(target, key, receiver) }));
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const controller = new AbortController(); const op = createOperation({ signal: controller.signal, limits: { totalMs: 8000 } });
    const pending = runRepositoryGit(directory, ["fixture"], op).catch((error: unknown) => error);
    let ownedPid: number | undefined;
    try {
      const readyDeadline = performance.now() + 4000;
      while (ownedPid === undefined && performance.now() < readyDeadline) {
        const ready = await readTicks(marker);
        if (ready !== "") ownedPid = (JSON.parse(ready) as { pid: number }).pid;
        if (ownedPid === undefined) await pause();
      }
      expect(ownedPid).toBeTypeOf("number");
      const uncertainty = Object.assign(new Error("Fixture taskkill could not confirm the process tree."), { status: 255, signal: null });
      boundary.terminate = (rootPid) => {
        if (outcome === "confirmed") { kill(ownedPid!); return Buffer.alloc(0); }
        kill(rootPid);
        throw uncertainty;
      };
      const cancelled = performance.now();
      controller.abort(new Error("Cancel the owned Git wrapper"));
      const error: unknown = await pending;
      expect(boundary.calls).toEqual([boundary.root!.pid]);
      expect(boundary.closed).toBe(true);
      expect(performance.now() - cancelled).toBeLessThan(2500);
      if (outcome === "confirmed") {
        expect(error).toBe(op.signal.reason);
        await waitUntilGone(ownedPid!);
        const stopped = await readTicks(ticks); await new Promise((resolve) => { setTimeout(resolve, 50); });
        expect(await readTicks(ticks)).toBe(stopped);
      } else {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([uncertainty]);
        expect((error as AggregateError).errors[0]).toBe(uncertainty);
        expect((error as AggregateError).cause).toBe(op.signal.reason);
        expect(nativeProcess.kill(ownedPid!, 0)).toBe(true);
        const running = await readTicks(ticks);
        await expect.poll(async () => (await readTicks(ticks)).length, { timeout: 1000, interval: 10 }).toBeGreaterThan(running.length);
      }
    } finally {
      controller.abort(new Error("Clean up the owned Git wrapper"));
      await pending;
      if (ownedPid === undefined) {
        const recorded = await readTicks(childPidFile);
        if (recorded !== "") ownedPid = (JSON.parse(recorded) as { pid: number }).pid;
      }
      if (ownedPid !== undefined) { kill(ownedPid); await waitUntilGone(ownedPid); }
      if (boundary.root?.pid !== undefined) { kill(boundary.root.pid); await waitUntilGone(boundary.root.pid); }
      if (boundary.rootClosed !== undefined) await boundary.rootClosed;
      op.dispose();
    }
  }, 10_000);
});
