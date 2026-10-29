import { ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { hasHerdrCommandCleanupFailure, HerdrCommandCleanupError, HerdrCommandError, runHerdrCommand, terminateOwnedHerdrProcess } from "../../../src/commands/worker/herdr/command.js";
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
