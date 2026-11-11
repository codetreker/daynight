import path from "node:path";
import { PassThrough } from "node:stream";
import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../src/api/operation.js";
import { RepositoryGitError, runRepositoryGit } from "../../src/repository/git.js";
import { WindowsCommandCleanupError } from "../../src/platform/windows-owned-command.js";
import type { WindowsOwnedCommand, WindowsOwnedCommandOptions, WindowsTargetReceipt } from "../../src/platform/windows-owned-command.js";

const boundary = vi.hoisted(() => ({
  wrapper: undefined as string | undefined,
  owner: undefined as WindowsOwnedCommand | undefined,
  options: undefined as WindowsOwnedCommandOptions | undefined,
  root: undefined as ChildProcess | undefined,
  rootClosed: undefined as Promise<void> | undefined,
  closed: false,
  terminate: undefined as ((pid: number) => Promise<void>) | undefined,
  calls: [] as number[],
}));
vi.mock("../../src/platform/windows-owned-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/platform/windows-owned-command.js")>();
  const { spawn } = await import("node:child_process");
  const spawnWindowsOwnedCommand: typeof actual.spawnWindowsOwnedCommand = options => {
    boundary.options = options;
    if (boundary.owner !== undefined) return boundary.owner;
    if (boundary.wrapper === undefined) throw new Error("An owned-command fixture must be configured.");
    const child = spawn(process.execPath, [boundary.wrapper], { cwd: options.cwd, env: options.environment, stdio: ["ignore", "pipe", "pipe"] });
    boundary.root = child;
    let result: import("../../src/platform/windows-owned-command.js").WindowsTargetReceipt | undefined;
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => { result = { kind: "exit", code, signal, failure: null }; boundary.closed = true; resolve(); });
    });
    boundary.rootClosed = closed;
    return {
      stdin: null, stdout: child.stdout!, stderr: child.stderr!, get result() { return result; }, closed,
      start: async () => {},
      stop: async () => {
        boundary.calls.push(child.pid!);
        if (boundary.terminate === undefined) throw new Error("The owned-command fixture must define its STOP outcome.");
        await boundary.terminate(child.pid!);
      },
      release: async () => { throw new Error("The cancelled fixture must not RELEASE its live descendant."); },
    };
  };
  return { ...actual, spawnWindowsOwnedCommand };
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
  boundary.owner = undefined; boundary.options = undefined;
  boundary.wrapper = undefined; boundary.root = undefined; boundary.rootClosed = undefined; boundary.closed = false; boundary.terminate = undefined; boundary.calls.splice(0);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("Windows Git owned-command confirmation", () => {
  it.each([
    { outcome: "confirmed", heartbeatDelayMs: 0 },
    { outcome: "uncertain", heartbeatDelayMs: 0 },
    { outcome: "uncertain", heartbeatDelayMs: 250 },
  ] as const)("preserves the $outcome owned-command outcome after the real wrapper closes with a $heartbeatDelayMs ms heartbeat delay", async ({ outcome, heartbeatDelayMs }) => {
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
      const uncertainty = Object.assign(new Error("Fixture owned command could not confirm the process tree."), { status: 255, signal: null });
      boundary.terminate = async (rootPid) => {
        if (outcome === "confirmed") { kill(ownedPid!); await boundary.rootClosed; return; }
        // A separate fixture owner retains the descendant after the product owner closes.
        kill(rootPid);
        await boundary.rootClosed;
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

const controlledOwner = (receipt: WindowsTargetReceipt | undefined, output = Buffer.alloc(0)) => {
  const stdout = new PassThrough(), stderr = new PassThrough();
  let close!: () => void, rejectClose!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { close = resolve; rejectClose = reject; });
  const start = vi.fn(async () => { stdout.end(output); stderr.end(); close(); });
  const stop = vi.fn(async () => {});
  const release = vi.fn(async () => { boundary.options!.onReleased!(); });
  const owner: WindowsOwnedCommand = { stdin: null, stdout, stderr, result: receipt, closed, start, stop, release };
  boundary.owner = owner;
  vi.stubGlobal("process", new Proxy(nativeProcess, { get: (target, key, receiver) => key === "platform" ? "win32" : Reflect.get(target, key, receiver) }));
  return { owner, start, stop, release, close, rejectClose, stdout, stderr };
};

describe("Windows Git target results and settlement", () => {
  it.each([
    { code: 0, allowExitOne: false, accepted: true },
    { code: 1, allowExitOne: true, accepted: true },
    { code: 1, allowExitOne: false, accepted: false },
    { code: 7, allowExitOne: false, accepted: false },
    { code: 128, allowExitOne: false, accepted: false },
  ])("uses target exit $code and preserves normal RELEASE", async ({ code, allowExitOne, accepted }) => {
    const fixture = controlledOwner({ kind: "exit", code, signal: null, failure: null }, Buffer.from("file\0name\0"));
    const operation = createOperation();
    try {
      const result = await runRepositoryGit(".", ["ls-files", "-z"], operation, { allowExitOne }).catch((error: unknown) => error);
      if (accepted) expect(result).toEqual({ stdout: "file\0name\0", stderr: "", exitCode: code });
      else expect(result).toMatchObject({ name: "RepositoryGitError", exitCode: code, signal: null });
      expect(fixture.release).toHaveBeenCalledOnce(); expect(fixture.stop).not.toHaveBeenCalled();
      expect(boundary.options).toMatchObject({ file: "git", args: ["--no-pager", "-c", "core.fsmonitor=false", "ls-files", "-z"], cwd: path.resolve("."),
        stdin: "ignore", resolver: "node", graceMs: 1000, pipeCloseMs: 1000, normalDisposition: "release", stopAdmission: "seal", failureDisposition: "last-close" });
    } finally { operation.dispose(); }
  });

  it.each(["own", "inherit"] as const)("keeps target environment isolation with an inner owner in %s mode", async processGroup => {
    controlledOwner({ kind: "exit", code: 0, signal: null, failure: null });
    const operation = createOperation();
    try {
      await runRepositoryGit(".", ["version"], operation, { processGroup, environment: { GIT_DIR: "wrong", GIT_TRACE: "wrong", FIXTURE_VALUE: "target", NODE_OPTIONS: "--require target-preload.cjs" } });
      expect(boundary.options!.environment).toMatchObject({ FIXTURE_VALUE: "target", NODE_OPTIONS: "--require target-preload.cjs", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
      expect(boundary.options!.environment).not.toHaveProperty("GIT_DIR"); expect(boundary.options!.environment).not.toHaveProperty("GIT_TRACE");
    } finally { operation.dispose(); }
  });

  it("retains the real not-started error fields after releasing the empty owner", async () => {
    const error = { name: "Error", message: "spawn git ENOENT", code: "ENOENT", errno: -4058, syscall: "spawn git", path: "git", spawnargs: ["version"] };
    const fixture = controlledOwner({ kind: "not-started", error });
    const operation = createOperation();
    try {
      const result = await runRepositoryGit(".", ["version"], operation).catch((failure: unknown) => failure);
      expect(result).toBeInstanceOf(RepositoryGitError);
      expect((result as Error).cause).toMatchObject({ ...error, origin: "windows-target" });
      expect(fixture.release).toHaveBeenCalledOnce(); expect(fixture.stop).not.toHaveBeenCalled();
    } finally { operation.dispose(); }
  });

  it("reports the target signal without substituting a helper exit code", async () => {
    const fixture = controlledOwner({ kind: "exit", code: null, signal: "SIGTERM", failure: null });
    const operation = createOperation();
    try {
      await expect(runRepositoryGit(".", ["version"], operation)).rejects.toMatchObject({ name: "RepositoryGitError", exitCode: null, signal: "SIGTERM" });
      expect(fixture.release).toHaveBeenCalledOnce(); expect(fixture.stop).not.toHaveBeenCalled();
    } finally { operation.dispose(); }
  });

  it("refuses a missing target receipt and preserves the parent failure during STOP", async () => {
    const fixture = controlledOwner(undefined);
    const native = new Error("Native cleanup rejected");
    fixture.stop.mockRejectedValue(new WindowsCommandCleanupError([native]));
    const operation = createOperation();
    try {
      const result = await runRepositoryGit(".", ["version"], operation).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toEqual([native]); expect((result as AggregateError).errors[0]).toBe(native);
      expect((result as AggregateError).cause).toMatchObject({ name: "RepositoryGitError", cause: { message: "The owned Git command closed without a target receipt." } });
      expect(fixture.stop).toHaveBeenCalledOnce(); expect(fixture.release).not.toHaveBeenCalled();
    } finally { operation.dispose(); }
  });

  it("counts initialization against the original per-command deadline", async () => {
    const fixture = controlledOwner(undefined);
    fixture.start.mockImplementation(() => new Promise<void>(() => {}));
    const operation = createOperation();
    try {
      await expect(runRepositoryGit(".", ["version"], operation, { timeoutMs: 20 })).rejects.toThrow("Repository Git command deadline exceeded");
      expect(fixture.start).toHaveBeenCalledOnce(); expect(fixture.stop).toHaveBeenCalledOnce(); expect(fixture.release).not.toHaveBeenCalled();
      expect(operation.signal.aborted).toBe(false);
    } finally { operation.dispose(); }
  });

  it.each(["start", "closed before start"] as const)("keeps the command deadline and native cause when %s rejects after it before timer dispatch", async rejection => {
    const fixture = controlledOwner(undefined), native = new Error("Original native admission failure");
    const operation = createOperation({ limits: { totalMs: 1000 } });
    let now = performance.now(), timerDispatched = false;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const timer = setTimeout(() => { timerDispatched = true; }, 0);
    fixture.start.mockImplementation(async () => {
      now = boundary.options!.deadline + 1;
      if (rejection === "closed before start") fixture.rejectClose(native);
      throw native;
    });
    try {
      const error: unknown = await runRepositoryGit(".", ["version"], operation, { timeoutMs: 50 }).catch((failure: unknown) => failure);
      expect(timerDispatched).toBe(false);
      expect(error).toBeInstanceOf(RepositoryGitError);
      expect((error as Error).message).toContain("Repository Git command deadline exceeded");
      expect((error as Error).cause).toBe(native);
      expect(operation.signal.aborted).toBe(false); expect(() => operation.check()).not.toThrow();
      expect(fixture.stop).toHaveBeenCalledOnce(); expect(fixture.release).not.toHaveBeenCalled();
    } finally { clearTimeout(timer); clock.mockRestore(); fixture.stdout.destroy(); fixture.stderr.destroy(); operation.dispose(); }
  });

  it.each(["cancellation", "total deadline"] as const)("keeps the original Operation %s above a late native rejection", async reason => {
    const fixture = controlledOwner(undefined), native = new Error("Original native admission failure");
    const controller = new AbortController(), operation = createOperation({ signal: controller.signal, limits: { totalMs: 1000 } });
    let now = performance.now();
    const started = now, clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    fixture.start.mockImplementation(async () => {
      now = reason === "total deadline" ? started + 1001 : boundary.options!.deadline + 1;
      if (reason === "cancellation") controller.abort(new Error("Caller cancellation remains primary"));
      throw native;
    });
    try {
      const error: unknown = await runRepositoryGit(".", ["version"], operation, { timeoutMs: 50 }).catch((failure: unknown) => failure);
      expect(error).toBe(operation.signal.reason);
      expect(error).toMatchObject({ name: "OperationError", kind: reason === "cancellation" ? "cancelled" : "deadline" });
      expect(fixture.stop).toHaveBeenCalledOnce(); expect(fixture.release).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); fixture.stdout.destroy(); fixture.stderr.destroy(); operation.dispose(); }
  });

  it.each([
    { rejection: "start", reason: "cancellation" },
    { rejection: "closed before start", reason: "cancellation" },
    { rejection: "start", reason: "total deadline" },
    { rejection: "closed before start", reason: "total deadline" },
  ] as const)("retains creation cleanup from $rejection with the original Operation $reason", async ({ rejection, reason }) => {
    const fixture = controlledOwner(undefined), cleanup = new Error("Creation attribute teardown failed");
    const creationFailure = new WindowsCommandCleanupError([cleanup]);
    const controller = new AbortController(), operation = createOperation({ signal: controller.signal, limits: { totalMs: 1000 } });
    let now = performance.now();
    const started = now, clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    fixture.start.mockImplementation(async () => {
      now = reason === "total deadline" ? started + 1001 : boundary.options!.deadline + 1;
      if (rejection === "closed before start") fixture.rejectClose(creationFailure);
      if (reason === "cancellation") controller.abort(new Error("Caller cancellation remains primary"));
      throw creationFailure;
    });
    try {
      const error: unknown = await runRepositoryGit(".", ["version"], operation, { timeoutMs: 50 }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([cleanup]);
      expect((error as AggregateError).errors[0]).toBe(cleanup);
      expect((error as AggregateError).cause).toBe(operation.signal.reason);
      expect((error as AggregateError).cause).toMatchObject({ name: "OperationError", kind: reason === "cancellation" ? "cancelled" : "deadline" });
      expect(fixture.stop).toHaveBeenCalledOnce(); expect(fixture.stop).toHaveResolved(); expect(fixture.release).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); fixture.stdout.destroy(); fixture.stderr.destroy(); operation.dispose(); }
  });

  it("deduplicates the same cleanup object across closed, start and STOP without merging distinct native errors", async () => {
    const fixture = controlledOwner(undefined), cleanup = new Error("Native cleanup failed"), distinctCleanup = new Error("Native cleanup failed");
    const creationFailure = new WindowsCommandCleanupError([cleanup]);
    fixture.start.mockImplementation(async () => { fixture.rejectClose(creationFailure); throw creationFailure; });
    fixture.stop.mockRejectedValue(new WindowsCommandCleanupError([cleanup, distinctCleanup]));
    const operation = createOperation();
    try {
      const error: unknown = await runRepositoryGit(".", ["version"], operation).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([cleanup, distinctCleanup]);
      expect((error as AggregateError).errors[0]).toBe(cleanup); expect((error as AggregateError).errors[1]).toBe(distinctCleanup);
      expect(((error as AggregateError).cause as Error).cause).toBe(creationFailure);
      expect(fixture.stop).toHaveBeenCalledOnce(); expect(fixture.release).not.toHaveBeenCalled();
    } finally { fixture.stdout.destroy(); fixture.stderr.destroy(); operation.dispose(); }
  });

  it("keeps an ordinary launch error as the primary cause without classifying it as cleanup uncertainty", async () => {
    const fixture = controlledOwner(undefined), launchFailure = new Error("Ordinary launch failed");
    fixture.start.mockRejectedValue(launchFailure);
    const operation = createOperation();
    try {
      const error: unknown = await runRepositoryGit(".", ["version"], operation).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(RepositoryGitError); expect(error).not.toBeInstanceOf(AggregateError);
      expect((error as Error).cause).toBe(launchFailure);
      expect(fixture.stop).toHaveBeenCalledOnce(); expect(fixture.release).not.toHaveBeenCalled();
    } finally { fixture.stdout.destroy(); fixture.stderr.destroy(); operation.dispose(); }
  });

  it("does not STOP released background work when OFF close fails or cancellation arrives after commit", async () => {
    const fixture = controlledOwner({ kind: "exit", code: 7, signal: null, failure: null });
    const native = new Error("Close of the disarmed owner failed");
    const controller = new AbortController(), operation = createOperation({ signal: controller.signal });
    fixture.release.mockImplementation(async () => {
      boundary.options!.onReleased!();
      controller.abort(new Error("After the normal handoff"));
      throw new WindowsCommandCleanupError([native]);
    });
    try {
      const result = await runRepositoryGit(".", ["version"], operation).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AggregateError); expect((result as AggregateError).errors[0]).toBe(native);
      expect((result as AggregateError).cause).toMatchObject({ name: "RepositoryGitError", exitCode: 7 });
      expect(fixture.stop).not.toHaveBeenCalled(); expect(fixture.release).toHaveBeenCalledOnce();
    } finally { operation.dispose(); }
  });

  it.each(["stdout", "stderr"] as const)("retains the per-stream 1 MiB %s limit and its original cleanup cause", async stream => {
    const fixture = controlledOwner(undefined);
    const native = new Error("Output-limit cleanup rejected");
    fixture.start.mockImplementation(async () => { fixture[stream].write(Buffer.alloc(1_048_577, "x")); });
    fixture.stop.mockRejectedValue(new WindowsCommandCleanupError([native]));
    const operation = createOperation();
    try {
      const result = await runRepositoryGit(".", ["version"], operation).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AggregateError); expect((result as AggregateError).errors[0]).toBe(native);
      expect(((result as AggregateError).cause as Error).message).toContain(`${stream} exceeded its 1048576-byte limit`);
      expect(fixture.release).not.toHaveBeenCalled(); expect(fixture.stop).toHaveBeenCalledOnce();
    } finally { fixture.stdout.destroy(); fixture.stderr.destroy(); operation.dispose(); }
  });
});
