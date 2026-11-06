import { ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { performance } from "node:perf_hooks";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { hasHerdrCommandCleanupFailure, hasUnconfirmedHerdrCommandCleanup, HerdrCommandCleanupError, HerdrCommandError, runHerdrCommand, terminateOwnedHerdrProcess } from "../../../src/commands/worker/herdr/command.js";
import type { HerdrSpawn } from "../../../src/commands/worker/herdr/command.js";

const operations: Operation[] = [];
const roots: string[] = [];
const children: ChildProcess[] = [];
const operation = (milliseconds = 5_000, signal?: AbortSignal): Operation => { const op = createOperation({ ...(signal === undefined ? {} : { signal }), limits: { totalMs: milliseconds, requestMs: milliseconds } }); operations.push(op); return op; };
const start: HerdrSpawn = (file, args, options) => { const child = spawn(file, [...args], options); children.push(child); return child; };
const command = (source: string, environment: NodeJS.ProcessEnv = process.env) => ({ file: process.execPath, args: ["--input-type=module", "--eval", source], environment });
const root = async (): Promise<string> => { const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-command"); await mkdir(scratch, { recursive: true }); const created = await mkdtemp(path.join(scratch, "command-")); roots.push(created); return created; };
const waitFor = async (file: string): Promise<string> => {
  const deadline = Date.now() + 4_000;
  while (true) {
    try { return await readFile(file, "utf8"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (Date.now() >= deadline) throw new Error("The owned command did not create its checkpoint.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
};
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  operations.splice(0).forEach((op) => op.dispose());
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) continue;
    terminateOwnedHerdrProcess(child);
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Owned prerequisite process did not close.")), 3_000); child.once("close", () => { clearTimeout(timer); resolve(); }); });
  }
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("bounded Herdr prerequisite commands", () => {
  it("captures Unicode output incrementally and preserves the supplied environment", async () => {
    const environment = { ...process.env, HERDR_FIXTURE_VALUE: "调用方" };
    const result = await runHerdrCommand(command("process.stdout.write(process.env.HERDR_FIXTURE_VALUE);process.stderr.write('diagnostic');", environment), operation(), start);
    expect(result).toEqual({ stdout: "调用方", stderr: "diagnostic" }); expect(environment.HERDR_FIXTURE_VALUE).toBe("调用方"); expect(process.env.HERDR_FIXTURE_VALUE).toBeUndefined();
  });

  it("runs a metadata command from its explicit task working directory", async () => {
    const directory = await root();
    const result = await runHerdrCommand({ ...command("process.stdout.write(process.cwd());"), cwd: directory }, operation(), start);
    expect(path.normalize(result.stdout)).toBe(path.normalize(directory));
    expect(process.cwd()).not.toBe(directory);
  });

  it("rejects ambiguous command working directories before spawning", async () => {
    for (const cwd of ["relative", "/invalid\0directory"]) {
      await expect(runHerdrCommand({ ...command(""), cwd }, operation(), () => { throw new Error("must not spawn"); })).rejects.toThrow("working directory must be absolute");
    }
  });

  it("preserves nonzero status and diagnostics without putting possible secrets into the message", async () => {
    const error: unknown = await runHerdrCommand(command("process.stderr.write('sensitive-config-value');process.exit(7);"), operation(), start).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HerdrCommandError); expect(error).toMatchObject({ exitCode: 7, signal: null, stderr: "sensitive-config-value" }); expect((error as Error).message).not.toContain("sensitive-config-value");
  });

  it("retains executable lookup failures", async () => {
    await expect(runHerdrCommand({ file: path.join(await root(), "missing-executable"), args: ["--version"], environment: process.env }, operation(), start)).rejects.toMatchObject({ cause: { code: "ENOENT" } });
  });

  it("rejects output beyond the capture budget and reaps the owned child", async () => {
    const error: unknown = await runHerdrCommand(command("process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000);"), operation(), start).catch((failure: unknown) => failure);
    const primary = error instanceof AggregateError ? error.cause : error;
    expect(primary).toBeInstanceOf(RangeError); expect((primary as Error).message).toContain("64 KiB");
    expect(children.at(-1)?.exitCode !== null || children.at(-1)?.signalCode !== null).toBe(true);
  });

  it("cancels the owned command tree and waits for its output streams to close", async () => {
    const directory = await root(); const checkpoint = path.join(directory, "checkpoint"); const ticks = path.join(directory, "ticks");
    const leaf = `import {appendFileSync,writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(checkpoint)},String(process.pid));setInterval(()=>appendFileSync(${JSON.stringify(ticks)},'tick\\n'),10);`;
    const source = `import {spawn} from 'node:child_process';spawn(process.execPath,['--input-type=module','--eval',${JSON.stringify(leaf)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
    const controller = new AbortController(); const op = operation(8_000, controller.signal);
    const pending = runHerdrCommand(command(source), op, start); const leafPid = Number(await waitFor(checkpoint));
    try {
      controller.abort(new Error("Stop the owned prerequisite tree"));
      const failure: unknown = await pending.catch((error: unknown) => error);
      const primary = failure instanceof AggregateError ? failure.cause : failure; expect(primary).toBe(op.signal.reason);
      const before = await readFile(ticks, "utf8").catch((error: unknown) => { if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""; throw error; });
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      const after = await readFile(ticks, "utf8").catch((error: unknown) => { if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""; throw error; }); expect(after).toBe(before);
    } finally {
      try { process.kill(leafPid, "SIGKILL"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    }
  });

  it("does not spawn a prerequisite after its operation was already cancelled", async () => {
    const controller = new AbortController(); controller.abort(); const op = operation(1_000, controller.signal);
    await expect(runHerdrCommand(command("throw new Error('must not start');"), op, () => { throw new Error("must not spawn"); })).rejects.toBe(op.signal.reason);
  });

  it("bounds one command without aborting its still-valid parent operation", async () => {
    const op = createOperation({ limits: { totalMs: 5_000, requestMs: 150 } }); operations.push(op);
    await expect(runHerdrCommand(command("setInterval(()=>{},1000);"), op, start)).rejects.toThrow("command deadline elapsed");
    expect(op.signal.aborted).toBe(false); expect(() => op.check()).not.toThrow();
    const child = children.at(-1)!; expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("reserves termination and actual stream closure inside a strict collection deadline", async () => {
    const op = operation(1_200); const began = performance.now();
    await expect(runHerdrCommand(command("process.stdout.write('started');setInterval(()=>{},1000);"), op, start, { cleanupWithinDeadline: true })).rejects.toThrow("command deadline elapsed");
    expect(performance.now() - began).toBeLessThan(1_400);
    const child = children.at(-1)!;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(child.stdout?.destroyed).toBe(true); expect(child.stderr?.destroyed).toBe(true);
  });

  it("keeps missing close acknowledgement explicit within the strict total budget", async () => {
    const op = operation(200); const began = performance.now();
    const failure: unknown = await runHerdrCommand(command(""), op, () => new ChildProcess(), { cleanupWithinDeadline: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HerdrCommandCleanupError);
    expect(hasHerdrCommandCleanupFailure(new Error("Probe failed", { cause: failure }))).toBe(true);
    expect(hasHerdrCommandCleanupFailure(new AggregateError([new Error("ordinary field failure")]))).toBe(false);
    expect(performance.now() - began).toBeLessThan(400);
  });
});


describe("late prerequisite cleanup acknowledgement", () => {
  const timedOutCommand = async (child = new ChildProcess()) => {
    const op = operation(100);
    const start = vi.fn(() => child);
    const pending = runHerdrCommand(command(""), op, start, { cleanupWithinDeadline: true }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(110);
    const error = await pending;
    expect(error).toBeInstanceOf(HerdrCommandCleanupError);
    expect(start).toHaveBeenCalledTimes(1);
    expect(getEventListeners(op.signal, "abort")).toHaveLength(0);
    op.dispose();
    return { child, error, start };
  };

  it("acknowledges only the original child close while preserving its historical failure", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const child = new ChildProcess();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const { error, start } = await timedOutCommand(child);
    const wrapper = new Error("Probe unavailable", { cause: new AggregateError([error]) });
    const listeners = child.listenerCount("close");
    expect(hasUnconfirmedHerdrCommandCleanup(wrapper)).toBe(true);
    child.emit("exit", 0, null);
    child.stdout.emit("close"); child.stderr.emit("close");
    new ChildProcess().emit("close", 0, null);
    expect(hasUnconfirmedHerdrCommandCleanup(wrapper)).toBe(true);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(hasUnconfirmedHerdrCommandCleanup(wrapper)).toBe(true);
    }
    expect(child.listenerCount("close")).toBe(listeners);
    expect(child.stdout.listenerCount("data")).toBe(1);
    expect(child.stderr.listenerCount("data")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    child.emit("close", 0, null);
    expect(hasUnconfirmedHerdrCommandCleanup(wrapper)).toBe(false);
    expect(hasHerdrCommandCleanupFailure(wrapper)).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(child.listenerCount("close")).toBe(0);
    child.stdout.destroy(); child.stderr.destroy();
  });

  it("keeps a failed termination unconfirmed even after the original close", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const child = new ChildProcess();
    const terminationError = new Error("Cannot inspect the owned process for termination");
    // Fail before platform-specific process termination without targeting any real PID.
    Object.defineProperty(child, "pid", { get: () => { throw terminationError; } });
    const { error } = await timedOutCommand(child);
    child.emit("close", 0, null);
    expect(error).toMatchObject({ errors: expect.arrayContaining([terminationError]) });
    expect(hasUnconfirmedHerdrCommandCleanup(error)).toBe(true);
    expect(hasHerdrCommandCleanupFailure(error)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains every unresolved cleanup in mixed cause and aggregate branches", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const first = await timedOutCommand();
    const second = await timedOutCommand();
    const mixed = new AggregateError([new Error("First probe", { cause: first.error })], "Both probes", { cause: second.error });
    first.child.emit("close", 0, null);
    expect(hasUnconfirmedHerdrCommandCleanup(mixed)).toBe(true);
    second.child.emit("close", 0, null);
    expect(hasUnconfirmedHerdrCommandCleanup(mixed)).toBe(false);
    expect(hasHerdrCommandCleanupFailure(mixed)).toBe(true);
    const legacy = new HerdrCommandCleanupError([new Error("Unowned cleanup")], undefined);
    expect(hasUnconfirmedHerdrCommandCleanup(new AggregateError([mixed, legacy]))).toBe(true);
  });

  it("does not start another command after cancellation and late acknowledgement", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const { child, error } = await timedOutCommand();
    const controller = new AbortController();
    const op = operation(100, controller.signal);
    const reason = new Error("Collector stopped"); controller.abort(reason);
    child.emit("close", 0, null);
    expect(hasUnconfirmedHerdrCommandCleanup(error)).toBe(false);
    const start = vi.fn(() => new ChildProcess());
    await expect(runHerdrCommand(command(""), op, start)).rejects.toBe(op.signal.reason);
    expect(start).not.toHaveBeenCalled();
    op.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
