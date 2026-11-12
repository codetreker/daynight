import { testIsolation } from "../../../../scripts/test-bootstrap.js";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveToolLaunch, toolCommand } from "../../../../src/platform/tool-executables.js";
import { createOperation } from "../../../../src/api/operation.js";
import * as nativeJob from "../../../../src/commands/worker/bots/windows-job-lease.js";
import * as windowsJob from "../../../../src/commands/controller/windows-job.js";
import * as processProof from "../../../../src/commands/controller/process-proof.js";
import { BotCliProbeCleanupError, createBotCliProbe, type BotCliProbe } from "../../../../src/commands/worker/bots/cli-probe.js";

const roots: string[] = [];
const scopes: BotCliProbe[] = [];
const operations: ReturnType<typeof createOperation>[] = [];
const fixture = async (tail = "console.log('help-result');", signal?: AbortSignal, requestMs = 5_000) => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../../.tmp");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "bot-probe-")); roots.push(root);
  const pidFile = path.join(root, "descendants");
  const file = path.join(root, "wrapper.cjs");
  await writeFile(file, `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); require('node:fs').appendFileSync(${JSON.stringify(pidFile)}, String(child.pid)+'\\n'); child.unref(); ${tail}\n`);
  const operation = createOperation({ ...(signal === undefined ? {} : { signal }), limits: { totalMs: 90_000, requestMs } }); operations.push(operation);
  const scope = await createBotCliProbe({ environment: process.env, cwd: root }, operation); scopes.push(scope);
  return { root, file, pidFile, scope, operation };
};
const checkStopped = async (scope: BotCliProbe) => {
  expect(scope.ownership.process).not.toBeNull();
  expect(await processProof.confirmControllerProcessesStopped(scope.ownership.process!, [])).toBe(true);
};
// These diagnostics cover only fixed, test-owned OS probes. Their commands and
// output contain fixture process metadata, never CLI credentials or target output.
const diagnostic = (stage: string, failure: unknown): void => {
  if (process.platform !== "win32") return;
  const describe = (value: unknown, depth = 0): unknown => {
    if (!(value instanceof Error) || depth > 4) return undefined;
    const fields = value as Error & { code?: unknown; signal?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown };
    return { name: fields.name, message: fields.message, code: fields.code, signal: fields.signal, killed: fields.killed,
      stdout: fields.stdout, stderr: fields.stderr, cause: describe(fields.cause, depth + 1) };
  };
  console.error(JSON.stringify({ fixture: "bot-cli-probe", stage, error: describe(failure) }));
};
beforeEach(() => {
  if (process.platform !== "win32") return;
  const capture = processProof.captureProcessProof;
  vi.spyOn(processProof, "captureProcessProof").mockImplementation(async (pid, timeoutMs) => {
    try { return await capture(pid, timeoutMs); }
    catch (error) { diagnostic("capture-process-proof", error); throw error; }
  });
  const stop = processProof.stopControllerProcesses;
  vi.spyOn(processProof, "stopControllerProcesses").mockImplementation(async (...args) => {
    try { return await stop(...args); }
    catch (error) { diagnostic("stop-process-scope", error); throw error; }
  });
  const inspectJob = windowsJob.inspectControllerJob;
  vi.spyOn(windowsJob, "inspectControllerJob").mockImplementation(async (...args) => {
    try {
      const pids = await inspectJob(...args);
      console.error(JSON.stringify({ fixture: "bot-cli-probe", stage: "inspect-job", job: args[0], stop: args[1] === true, pids }));
      return pids;
    } catch (error) { diagnostic("inspect-job", error); throw error; }
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  const failures: unknown[] = [];
  for (const scope of [...scopes]) {
    try { await scope.close(); scopes.splice(scopes.indexOf(scope), 1); }
    catch (error) { diagnostic("fixture-cleanup", error); failures.push(error); }
  }
  for (const operation of operations.splice(0)) operation.dispose();
  // Retain failed owners and their directories for the next cleanup attempt;
  // removing an open Windows cwd only hides the original failure with EBUSY.
  if (failures.length !== 0) throw new AggregateError(failures, "Bot probe fixtures retain unconfirmed process ownership.");
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("owned Bot CLI capability probes", () => {
  it("keeps one gated leader across commands and stops detached-stdio descendants after success", async () => {
    const f = await fixture(); const originalPid = f.scope.ownership.pid;
    expect(f.scope.ownership.targetStarted).toBe(false);
    if (process.platform === "win32") expect(await windowsJob.inspectControllerJob(f.scope.ownership.jobObjectName!)).toContain(originalPid);
    expect((await f.scope.run(process.execPath, [f.file])).stdout).toBe("help-result\n");
    expect((await f.scope.run(process.execPath, [f.file])).stdout).toBe("help-result\n");
    expect(f.scope.ownership.pid).toBe(originalPid);
    expect((await readFile(f.pidFile, "utf8")).trim().split("\n")).toHaveLength(2);
    if (process.platform === "win32") expect(f.scope.ownership.jobObjectName).toMatch(/^Local\\Daynight-/);
    await f.scope.close(); await f.scope.close();
    await checkStopped(f.scope);
    await expect(f.scope.run(process.execPath, [f.file])).rejects.toThrow(/closed/);
  }, 120_000);

  it("stops the complete scope after a command exits unsuccessfully", async () => {
    const f = await fixture("process.exitCode = 1;");
    await expect(f.scope.run(process.execPath, [f.file])).rejects.toThrow(/command failed/);
    expect((await readFile(f.pidFile, "utf8")).trim()).not.toBe("");
    await f.scope.close(); await checkStopped(f.scope);
  }, 120_000);

  it("reports an output limit distinctly and still stops every owned descendant", async () => {
    const f = await fixture("process.stdout.write('x'.repeat(65537));");
    await expect(f.scope.run(process.execPath, [f.file])).rejects.toMatchObject({ code: "limit_exceeded" });
    expect((await readFile(f.pidFile, "utf8")).trim()).not.toBe("");
    await f.scope.close(); await checkStopped(f.scope);
  }, 120_000);

  it("stops the complete scope after a command deadline", async () => {
    const f = await fixture("setInterval(() => {}, 1000);", undefined, 5_000);
    await expect(f.scope.run(process.execPath, [f.file])).rejects.toThrow(/deadline/);
    expect((await readFile(f.pidFile, "utf8")).trim()).not.toBe("");
    await f.scope.close(); await checkStopped(f.scope);
  }, 120_000);

  it("joins the complete scope after cancellation while a descendant is running", async () => {
    const controller = new AbortController();
    const f = await fixture("setInterval(() => {}, 1000);", controller.signal, 15_000);
    const result = f.scope.run(process.execPath, [f.file]); void result.catch(() => {});
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { if ((await readFile(f.pidFile, "utf8")).length > 0) break; } catch { /* Wait for the fixture's spawn receipt. */ }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect((await readFile(f.pidFile, "utf8")).trim()).not.toBe("");
    controller.abort();
    await expect(result).rejects.toThrow(/cancel/);
    await f.scope.close(); await checkStopped(f.scope);
  }, 120_000);

  it.skipIf(process.platform === "win32")("cancels and cleans the owned process scope after a Node loader execve", async () => {
    const controller = new AbortController();
    const f = await fixture("", controller.signal, 15_000);
    const receipt = path.join(f.root, "execve-receipt.json"), before = path.join(f.root, "before-execve");
    const native = `const fs = require('node:fs');
const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({pid:process.pid, child:child.pid, args:process.argv.slice(1)}));
setInterval(() => {}, 1000);`;
    await writeFile(f.file, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(before)}, String(process.pid));\nprocess.execve(process.execPath, [process.execPath, '-e', ${JSON.stringify(native)}, '--', ...process.argv.slice(2)], process.env);\n`);
    const launch = await resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "path", path: f.file }, cwd: f.root, environment: process.env }, f.operation);
    const args = ["space and 中文", "$(literal)", "&"], command = toolCommand(launch, args);
    const running = f.scope.run(command.file, command.args); void running.catch(() => {});
    await vi.waitFor(async () => expect((await stat(receipt)).isFile()).toBe(true), { timeout: 10_000, interval: 20 });
    const observed = JSON.parse(await readFile(receipt, "utf8")) as { pid: number; child: number; args: string[] };
    expect(observed.pid).toBe(Number(await readFile(before, "utf8")));
    expect(observed.args).toEqual(args);
    const targetProof = await processProof.captureProcessProof(observed.pid);
    const childProof = await processProof.captureProcessProof(observed.child);
    controller.abort();
    await expect(running).rejects.toThrow(/cancel/);
    await f.scope.close(); await checkStopped(f.scope);
    expect(await processProof.inspectProcessProof(targetProof)).toBe("stopped");
    expect(await processProof.inspectProcessProof(childProof)).toBe("stopped");
  }, 120_000);

  it("retains typed process ownership and a working retry after unconfirmed cleanup", async () => {
    let lease: nativeJob.WindowsBotJobLease | undefined;
    if (process.platform === "win32") {
      const create = nativeJob.createWindowsBotJobLease;
      vi.spyOn(nativeJob, "createWindowsBotJobLease").mockImplementation(async (...args) => { lease = await create(...args); return lease; });
    }
    const f = await fixture(); await f.scope.run(process.execPath, [f.file]);
    if (lease !== undefined) vi.spyOn(lease, "terminate").mockImplementationOnce(() => { throw new nativeJob.WindowsBotJobError("fixture-stop", 5); });
    else vi.spyOn(processProof, "stopControllerProcesses").mockRejectedValueOnce(new Error("private-process-error"));
    let failure: BotCliProbeCleanupError | undefined;
    try { await f.scope.close(); } catch (error) { failure = error as BotCliProbeCleanupError; }
    expect(failure).toBeInstanceOf(BotCliProbeCleanupError);
    expect(failure?.ownership.process?.pid).toBe(f.scope.ownership.pid);
    expect(failure?.cause).toBeUndefined();
    expect(String(failure)).not.toContain("private-process-error");
    if (lease !== undefined) expect(lease.inspect()).toContain(f.scope.ownership.pid);
    await failure!.retryCleanup(); await checkStopped(f.scope);
    if (lease !== undefined) expect(lease.inspect()).toEqual([]);
  }, 120_000);

  it("never launches the target when process ownership cannot be captured", async () => {
    const operation = createOperation({ limits: { totalMs: 30_000 } }); operations.push(operation);
    vi.spyOn(processProof, "captureProcessProof").mockRejectedValueOnce(new Error("ownership unavailable"));
    await expect(createBotCliProbe({ environment: process.env, cwd: process.cwd() }, operation)).rejects.toThrow("ownership unavailable");
  }, 120_000);

  it("refuses an ownership proof outside the current parent before opening the command gate", async () => {
    const operation = createOperation({ limits: { totalMs: 30_000 } }); operations.push(operation);
    const original = processProof.captureProcessProof;
    let captured: processProof.ProcessProof | undefined;
    vi.spyOn(processProof, "captureProcessProof").mockImplementationOnce(async (pid, timeoutMs) => {
      captured = await original(pid, timeoutMs);
      return { ...captured, parentPid: process.pid + 1 };
    });
    await expect(createBotCliProbe({ environment: process.env, cwd: process.cwd() }, operation)).rejects.toThrow(/ownership changed/);
    expect(captured).toBeDefined();
    expect(await processProof.inspectProcessProof(captured!)).toBe("stopped");
  }, 120_000);


  it("keeps Node preload hooks behind the ownership gate while preserving them for the CLI", async () => {
    const scratch = path.resolve(import.meta.dirname, "../../../../../../.tmp");
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(path.join(scratch, "bot-hook-")); roots.push(root);
    const marker = path.join(root, "hook-ran");
    const hook = path.join(root, "hook.cjs");
    await writeFile(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    const preload = `--require ${JSON.stringify(hook)}`;
    const operation = createOperation({ limits: { totalMs: 90_000, requestMs: 10_000 } }); operations.push(operation);
    const scope = await createBotCliProbe({ environment: { ...process.env, NODE_OPTIONS: preload }, cwd: root }, operation); scopes.push(scope);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const result = await scope.run(process.execPath, ["-e", "console.log(process.env.NODE_OPTIONS)"]);
    expect(result.stdout.trim()).toBe(testIsolation.guardedEnvironment({ NODE_OPTIONS: preload }).NODE_OPTIONS);
    expect(await readFile(marker, "utf8")).toBe("executed");
    await scope.close(); await checkStopped(scope);
  }, 120_000);

});
