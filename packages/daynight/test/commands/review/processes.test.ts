import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import which from "which";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProcessSupervisor, processGroupIsExecuting } from "../../../src/commands/review/processes.js";
import { formatError } from "../../../src/platform/diagnostics.js";
import type { CopilotAttemptOutcome } from "../../../src/commands/review/adapters/copilot.js";
import type { ReviewState } from "../../../src/commands/review/model.js";

const review = (pid: number | null): ReviewState => ({ id: "review", host: "github.com", githubId: "1", number: 1, revision: 1,
  headSha: "a".repeat(40), baseRef: "main", baseSha: "b".repeat(40), status: "running", attemptCount: 1, maxAttempts: 3,
  retryAt: null, processOwner: "owner", processId: pid, processIdentity: pid === null ? null : "identity", stdoutLogPath: "out", stderrLogPath: "err", lastError: null, createdAt: 1, updatedAt: 1 });
const outcome = (): CopilotAttemptOutcome => ({ attempt: { reviewId: "review", attempt: 1 }, sessionId: "session", sessionMode: "create", stdoutLogPath: "out", stderrLogPath: "err", completed: false,
  directProcessClosed: true, captureComplete: true, exitCode: 7, signal: null, lastNonemptyLine: null, interruption: null, launchFailure: null, processExclusionFailure: null, errors: [] });
const waitForFile = async (file: string): Promise<string> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { return await readFile(file, "utf8"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  throw new Error(`Fixture did not create ${file}.`);
};
const kill = process.kill.bind(process);
const killPosixFixture = async (pid: number, closed: Promise<unknown[]>): Promise<void> => {
  try { kill(-pid, "SIGKILL"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  await closed;
};
const nativeTree = async (ignoreTerm: boolean, name: string) => {
  const marker = path.join(directory, `${name}.txt`);
  const termMarker = path.join(directory, `${name}.term`);
  const fixture = path.join(directory, `${name}.cjs`);
  await writeFile(fixture, `const {spawn}=require('node:child_process');const fs=require('node:fs');\nif(process.argv[2]==='leaf'){setInterval(()=>fs.writeFileSync(process.argv[3],String(Date.now())),15);}else{const leaf=spawn(process.execPath,[__filename,'leaf',process.argv[2]],{stdio:'ignore'});process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(termMarker)},'received');${ignoreTerm ? "" : "if(leaf.exitCode!==null||leaf.signalCode!==null)process.exit(0);else leaf.once('close',()=>process.exit(0));"}});setInterval(()=>{},1000);}`);
  let file = process.execPath;
  let args = [fixture, marker];
  if (process.platform === "win32") {
    file = path.join(directory, `${name}.cmd`);
    await writeFile(file, `@echo off\r\n"${process.execPath}" "${fixture}" "${marker}"\r\n`);
    args = [];
  }
  const child = crossSpawn(file, args, { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const closed = once(child, "close");
  child.stdout!.resume(); child.stderr!.resume();
  await once(child, "spawn");
  return { child, closed, marker, termMarker };
};
const expectHeartbeatStopped = async (marker: string): Promise<void> => {
  const stoppedValue = await readFile(marker, "utf8");
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  expect(await readFile(marker, "utf8")).toBe(stoppedValue);
};
let directory: string;
beforeAll(async () => {
  const temporary = fileURLToPath(new URL("../../../../../.tmp/", import.meta.url));
  await mkdir(temporary, { recursive: true }); directory = await mkdtemp(path.join(temporary, "processes-"));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("current-run process supervision", () => {
  it.each(["", "12 42 Z\n13 99 S\n", "12 42 Z+\n13 42 Z\n"])("excludes a denied group only when scoped status has no executing members: %j", async (status) => {
    const denied = Object.assign(new Error("group permission denied"), { code: "EPERM" });
    const readStatus = vi.fn(async () => status);
    await expect(processGroupIsExecuting(42, { probe: () => { throw denied; }, readStatus })).resolves.toBe(false);
    expect(readStatus).toHaveBeenCalledOnce();
  });

  it.each(["12 42 S\n", "12 42 Z\n13 42 R+\n"])("preserves the original permission denial for an executing group: %j", async (status) => {
    const denied = Object.assign(new Error("group permission denied"), { code: "EPERM" });
    await expect(processGroupIsExecuting(42, { probe: () => { throw denied; }, readStatus: async () => status })).rejects.toBe(denied);
  });

  it("distinguishes an absent group from probe, inspection, and parse failures", async () => {
    const absent = Object.assign(new Error("absent group"), { code: "ESRCH" });
    const readStatus = vi.fn(async () => "12 42 S\n");
    await expect(processGroupIsExecuting(42, { probe: () => { throw absent; }, readStatus })).resolves.toBe(false);
    expect(readStatus).not.toHaveBeenCalled();
    const probeFailure = Object.assign(new Error("invalid probe"), { code: "EINVAL" });
    await expect(processGroupIsExecuting(42, { probe: () => { throw probeFailure; }, readStatus })).rejects.toBe(probeFailure);
    expect(readStatus).not.toHaveBeenCalled();
    const denied = Object.assign(new Error("group permission denied"), { code: "EPERM" });
    const inspectionFailure = new Error("ps failed");
    await expect(processGroupIsExecuting(42, { probe: () => { throw denied; }, readStatus: async () => { throw inspectionFailure; } })).rejects.toBe(inspectionFailure);
    await expect(processGroupIsExecuting(42, { probe: () => { throw denied; }, readStatus: async () => "malformed status" })).rejects.toThrow("Cannot interpret");
  });

  it("retains unsafe execution when a denied probe finds an executing POSIX group", async () => {
    const denied = Object.assign(new Error("group permission denied"), { code: "EPERM" });
    await expect(processGroupIsExecuting(42, { probe: () => { throw denied; }, readStatus: async () => "12 42 S\n" })).rejects.toBe(denied);
    if (process.platform !== "win32") {
      const supervisor = createProcessSupervisor({ graceMs: 1_000 });
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout!.resume(); child.stderr!.resume();
      await once(child, "spawn"); supervisor.onProcess(child, { reviewId: "review", attempt: 1 });
      const kill = process.kill.bind(process);
      const closed = once(child, "close");
      const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -child.pid! && signal === 0) throw denied;
        return kill(pid, signal);
      });
      try {
        const result = await supervisor.stop(child, { reviewId: "review", attempt: 1 }).catch((error: unknown) => error);
        expect(formatError(result)).toContain("Caused by: group permission denied");
        expect(supervisor.safeToReleaseLock).toBe(false);
      } finally {
        probe.mockRestore();
        kill(-child.pid!, "SIGKILL");
        await closed;
      }
    }
  });

  it("accepts a normal fully drained nonzero foreground exit for retry", async () => {
    const supervisor = createProcessSupervisor({ graceMs: 1_000 });
    const child = spawn(process.execPath, ["-e", "process.stdout.write('done'); process.exitCode = 7"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.resume(); child.stderr!.resume();
    await once(child, "spawn"); supervisor.onProcess(child, { reviewId: "review", attempt: 1 });
    await once(child, "close");
    await expect(supervisor.exclude(review(child.pid!), outcome())).resolves.toEqual({ processesExcluded: true });
    expect(supervisor.safeToReleaseLock).toBe(true);
  });

  it("keeps one child per attempt until exclusion removes the previous handle", async () => {
    const supervisor = createProcessSupervisor({ graceMs: 1_000 });
    const attempt = { reviewId: "review", attempt: 1 };
    const children = [0, 1].map(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
      { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }));
    for (const child of children) { child.stdout!.resume(); child.stderr!.resume(); }
    await Promise.all(children.map((child) => once(child, "spawn")));
    const first = children[0]!; const second = children[1]!;
    try {
      supervisor.onProcess(first, attempt);
      expect(() => supervisor.onProcess(second, attempt)).toThrow("more than one process");
      await supervisor.stop(first, attempt);
      await supervisor.exclude(review(first.pid!));
      expect(() => supervisor.onProcess(second, attempt)).not.toThrow();
      await supervisor.stop(second, attempt);
      await supervisor.exclude(review(second.pid!));
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
      }
    }
    expect(supervisor.safeToReleaseLock).toBe(false);
  });

  it.each([false, true])("terminates a managed native wrapper tree (ignore TERM=%s)", async (ignoreTerm) => {
    const { child, closed, marker } = await nativeTree(ignoreTerm, `tree-${ignoreTerm}`);
    const supervisor = createProcessSupervisor({ graceMs: process.platform === "win32" ? 3_000 : 300 });
    supervisor.onProcess(child, { reviewId: "review", attempt: 1 });
    let stopped = false;
    try {
      await waitForFile(marker);
      await supervisor.stop(child, { reviewId: "review", attempt: 1 });
      stopped = true;
      await closed;
      await expectHeartbeatStopped(marker);
      await expect(supervisor.exclude(review(child.pid!))).resolves.toEqual({ processesExcluded: true });
    } finally {
      if (process.platform !== "win32" && !stopped) await killPosixFixture(child.pid!, closed);
      else if (!stopped && child.exitCode === null && child.signalCode === null) await supervisor.stop(child, { reviewId: "review", attempt: 1 });
      await closed;
    }
  }, 15_000);

  it("inspects a real POSIX process group beyond its short termination grace", async () => {
    if (process.platform === "win32") return;
    const realPs = await which("ps");
    const proxyDirectory = await mkdtemp(path.join(directory, "delayed-ps-"));
    const invocation = path.join(proxyDirectory, "invocation.json");
    const result = path.join(proxyDirectory, "result.json");
    const { child, closed, marker, termMarker } = await nativeTree(true, "delayed-inspection");
    const supervisor = createProcessSupervisor({ graceMs: 300 });
    supervisor.onProcess(child, { reviewId: "review", attempt: 1 });
    const previousPath = process.env.PATH;
    let stopped = false;
    try {
      await writeFile(path.join(proxyDirectory, "ps"), `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const first = !existsSync(${JSON.stringify(invocation)});
if (first) writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({ args, pid: process.pid }));
setTimeout(() => {
  const beforeTerm = !existsSync(${JSON.stringify(termMarker)});
  const stdout = execFileSync(${JSON.stringify(realPs)}, args, { encoding: "utf8" });
  if (first) writeFileSync(${JSON.stringify(result)}, JSON.stringify({ stdout, beforeTerm }));
  process.stdout.write(stdout);
}, first ? 450 : 0);
`, { mode: 0o755 });
      process.env.PATH = `${proxyDirectory}${path.delimiter}${previousPath}`;
      await waitForFile(marker);
      await supervisor.stop(child, { reviewId: "review", attempt: 1 });
      stopped = true;
      await closed;
      const firstInvocation = JSON.parse(await readFile(invocation, "utf8")) as { args: string[]; pid: number };
      expect(firstInvocation.args).toEqual(["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="]);
      expect(firstInvocation.pid).not.toBe(child.pid);
      const firstResult = JSON.parse(await readFile(result, "utf8")) as { stdout: string; beforeTerm: boolean };
      expect(firstResult.beforeTerm).toBe(true);
      expect(firstResult.stdout.split("\n").some((line) => {
        const members = line.trim().split(/\s+/);
        return Number(members[1]) === child.pid && !members[2]!.startsWith("Z");
      })).toBe(true);
      expect(child.signalCode).toBe("SIGKILL");
      await expectHeartbeatStopped(marker);
      await expect(supervisor.exclude(review(child.pid!))).resolves.toEqual({ processesExcluded: true });
      expect(supervisor.safeToReleaseLock).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (!stopped) await killPosixFixture(child.pid!, closed);
      await closed;
    }
  }, 15_000);

  it("retains native POSIX inspection failures and prevents exclusion", async () => {
    if (process.platform === "win32") return;
    const proxyDirectory = await mkdtemp(path.join(directory, "failed-ps-"));
    const { child, closed, marker } = await nativeTree(false, "failed-inspection");
    const supervisor = createProcessSupervisor({ graceMs: 300 });
    const attempt = { reviewId: "review", attempt: 1 };
    supervisor.onProcess(child, attempt);
    const previousPath = process.env.PATH;
    try {
      await writeFile(path.join(proxyDirectory, "ps"), "#!/usr/bin/env node\nprocess.stderr.write('inspection fixture failed'); process.exitCode = 7;\n", { mode: 0o755 });
      process.env.PATH = `${proxyDirectory}${path.delimiter}${previousPath}`;
      await waitForFile(marker);
      const failure: unknown = await supervisor.stop(child, attempt).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ cause: { code: 7, killed: false, signal: null } });
      expect(formatError(failure)).toContain("Caused by: Command failed: ps -A -o pid= -o pgid= -o stat=");
      expect(formatError(failure)).toContain("inspection fixture failed");
      expect(supervisor.safeToReleaseLock).toBe(false);
      await expect(supervisor.exclude(review(child.pid!))).rejects.toBe(failure);
      expect(child.exitCode).toBe(null);
      expect(child.signalCode).toBe(null);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      await killPosixFixture(child.pid!, closed);
    }
  }, 15_000);

  it("retains uncertainty for persisted process identities and never targets their PIDs", async () => {
    const supervisor = createProcessSupervisor();
    await expect(supervisor.exclude(review(process.pid))).rejects.toThrow("not launched by this CLI");
    expect(supervisor.safeToReleaseLock).toBe(false);
    await expect(supervisor.recover(review(process.pid))).rejects.toThrow("instance-lock owner's confirmation");
    const recovered = createProcessSupervisor({ previousProcessesExcluded: true });
    await expect(recovered.recover(review(null))).resolves.toEqual({ processesExcluded: true, operationsStopped: true });
  });

  it("requires Windows foreground completion evidence after the root has already disappeared", async () => {
    const supervisor = createProcessSupervisor({ graceMs: 1_000 });
    const child = spawn(process.execPath, ["-e", "process.exitCode = 1"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.resume(); child.stderr!.resume();
    await once(child, "spawn"); supervisor.onProcess(child, { reviewId: "review", attempt: 1 });
    await once(child, "close");
    const incomplete = { ...outcome(), captureComplete: false };
    if (process.platform === "win32") {
      const result = await supervisor.exclude(review(child.pid!), incomplete).catch((error: unknown) => error);
      expect(formatError(result)).toContain("Cannot confirm that the current agent and its foreground tools have stopped; execution state was retained.");
      expect(formatError(result)).toContain("Caused by: The Windows agent exited before its current process tree could be terminated; operator recovery is required.");
      expect(supervisor.safeToReleaseLock).toBe(false);
    } else await expect(supervisor.exclude(review(child.pid!), incomplete)).resolves.toEqual({ processesExcluded: true });
  });
});
