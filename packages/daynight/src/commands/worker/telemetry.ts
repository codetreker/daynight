import { constants } from "node:fs";
import { access, stat, statfs } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createOperation, OperationError } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import type { TaskPlatform, WorkerCPU, WorkerDisk, WorkerExecutableProbe, WorkerMachine, WorkerProbe, WorkerProbeCode, WorkerTelemetry } from "../../api/types.js";
import { hasHerdrCommandCleanupFailure, HerdrCommandDeadlineError, HerdrCommandError, runHerdrCommand, spawnHerdrProcess } from "./herdr/command.js";
import { createHerdrNativeEnvironment, createHerdrVersionObserver } from "./herdr/instance.js";
import { NativeVersionOutputError, probeNativeAgentVersion } from "./herdr/version-probe.js";
import type { WorkerPaths } from "./paths.js";

export type WorkerTelemetryIssue = {
  component: "os" | "cpu" | "memory" | "disk" | "herdr" | "codex" | "copilot";
  code: WorkerProbeCode;
  error: unknown;
};
export type WorkerTelemetrySample = { telemetry: WorkerTelemetry; issues: readonly WorkerTelemetryIssue[] };

class SampleError extends Error {
  constructor(readonly code: WorkerProbeCode, message: string, options?: ErrorOptions) { super(message, options); this.name = "WorkerSampleError"; }
}
const codeOf = (error: unknown): WorkerProbeCode => {
  if (error instanceof SampleError) return error.code;
  if (error instanceof OperationError || error instanceof HerdrCommandDeadlineError) return "timeout";
  if (error instanceof NativeVersionOutputError) return "invalid_output";
  if (error instanceof HerdrCommandError) return "command_failed";
  if (error instanceof Error && "code" in error) {
    if (error.code === "EACCES" || error.code === "EPERM") return "permission_denied";
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return "not_found";
  }
  if (error instanceof Error && error.cause !== undefined) return codeOf(error.cause);
  return "io_error";
};
const integer = (value: number | bigint): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || (typeof value === "bigint" && BigInt(result) !== value)) throw new SampleError("out_of_range", "A resource byte or counter value is outside the safe integer range.");
  return result;
};
const text = (value: string): string => {
  if (value.trim().length === 0 || value.includes("\0") || !value.isWellFormed()) throw new SampleError("invalid_sample", "Resource metadata must contain valid nonempty text without NUL.");
  return value;
};
const observe = <T>(pending: Promise<T>, operation: Operation): Promise<T> => new Promise((resolve, reject) => {
  try { operation.check(); }
  catch (error) { void pending.then(() => undefined, () => undefined); reject(error); return; }
  let settled = false;
  const finish = (result: { value: T } | { error: unknown }): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer); operation.signal.removeEventListener("abort", abort);
    if ("error" in result) reject(result.error); else resolve(result.value);
  };
  const abort = (): void => finish({ error: operation.signal.reason });
  const timer = setTimeout(() => finish({ error: new OperationError("deadline") }), Math.max(1, Math.floor(operation.remainingMs())));
  operation.signal.addEventListener("abort", abort, { once: true });
  if (operation.signal.aborted) abort();
  pending.then((value) => finish({ value }), (error: unknown) => finish({ error }));
});

const cpuSnapshot = (): { model: string; times: readonly { idle: number; total: number }[] } => {
  const processors = os.cpus();
  if (processors.length === 0 || !Number.isSafeInteger(processors.length)) throw new SampleError("invalid_sample", "No logical CPU counters are available.");
  return { model: text(processors[0]!.model), times: processors.map(({ times }) => ({ idle: integer(times.idle), total: integer(Object.values(times).reduce((sum, value) => sum + integer(value), 0)) })) };
};
const cpuInterval = (operation: Operation): Promise<void> => new Promise((resolve, reject) => {
  operation.check();
  const abort = (): void => { clearTimeout(timer); operation.signal.removeEventListener("abort", abort); reject(operation.signal.reason); };
  const timer = setTimeout(() => {
    operation.signal.removeEventListener("abort", abort);
    try { operation.check(); resolve(); } catch (error) { reject(error); }
  }, 200);
  operation.signal.addEventListener("abort", abort, { once: true });
  if (operation.signal.aborted) abort();
});
const sampleCPU = async (operation: Operation): Promise<WorkerCPU> => {
  const before = cpuSnapshot();
  await cpuInterval(operation);
  const after = cpuSnapshot();
  if (before.times.length !== after.times.length || before.model !== after.model) throw new SampleError("invalid_sample", "The logical CPU inventory changed during the sample.");
  let elapsed = 0; let idle = 0;
  after.times.forEach((current, index) => {
    const previous = before.times[index]!;
    const totalDelta = current.total - previous.total; const idleDelta = current.idle - previous.idle;
    if (totalDelta < 0 || idleDelta < 0 || idleDelta > totalDelta) throw new SampleError("invalid_sample", "The logical CPU counters did not produce a valid interval.");
    elapsed += totalDelta; idle += idleDelta;
  });
  if (!Number.isSafeInteger(elapsed) || !Number.isSafeInteger(idle) || elapsed <= 0) throw new SampleError("invalid_sample", "The logical CPU counters did not advance safely.");
  const usagePercent = 100 * (elapsed - idle) / elapsed;
  if (!Number.isFinite(usagePercent) || usagePercent < 0 || usagePercent > 100) throw new SampleError("invalid_sample", "The CPU interval produced an invalid utilization percentage.");
  return { model: after.model, logicalProcessors: after.times.length, usagePercent };
};

const hasCode = (error: unknown, code: string): boolean => error instanceof Error && (("code" in error && error.code === code) || hasCode(error.cause, code));
const executableMissing = async (agent: string, environment: NodeJS.ProcessEnv, cwd: string, operation: Operation): Promise<boolean> => {
  const directory = await observe(stat(cwd), operation);
  if (!directory.isDirectory()) throw new SampleError("io_error", "The native version probe working directory is not a directory.");
  const env = (name: string): string | undefined => {
    const key = process.platform === "win32" ? Object.keys(environment).find((key) => key.toUpperCase() === name) : name;
    return key === undefined ? undefined : environment[key];
  };
  const search = env("PATH");
  if (search === undefined) return false;
  const directories = [...(process.platform === "win32" ? [cwd] : []), ...search.split(path.delimiter)];
  const extensions = process.platform === "win32" ? (env("PATHEXT") === undefined ? [".EXE", ".CMD", ".BAT", ".COM"] : env("PATHEXT")!.split(";")).flatMap((extension) => [extension, extension.toLowerCase()]) : [""];
  for (const directory of directories) for (const extension of extensions) {
    const candidate = path.resolve(cwd, directory.replace(/^"(.*)"$/, "$1"), `${agent}${extension}`);
    try { await observe(access(candidate, constants.F_OK), operation); return false; }
    catch (error) { if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTDIR")) throw error; }
  }
  return true;
};

export const createWorkerTelemetryCollector = (options: {
  paths: WorkerPaths; homeDirectory: string; version: string; workingDirectory: string; machine: WorkerMachine; platform: TaskPlatform;
}) => {
  if (!path.isAbsolute(options.workingDirectory) || /[\0\r\n]/.test(options.workingDirectory)) throw new TypeError("The Worker startup directory must be absolute and contain no control separators.");
  const environment = createHerdrNativeEnvironment(options.paths, process.env);
  const herdr = createHerdrVersionObserver(options.paths);
  const cache = new Map<"codex" | "copilot", { started: number; probe: WorkerExecutableProbe; issue?: WorkerTelemetryIssue; cleanupUncertain: boolean }>();
  let pendingDisk: Promise<WorkerDisk> | null = null;
  const disk = async (operation: Operation): Promise<WorkerDisk> => {
    // A timed-out OS request cannot be cancelled; avoid adding I/O or observers while it remains pending.
    if (pendingDisk !== null) throw new SampleError("timeout", "The previous filesystem observation remains pending.");
    const request = statfs(options.workingDirectory, { bigint: true }).then((sample) => {
      if (sample.bsize <= 0n || sample.blocks < 0n || sample.bavail < 0n) throw new SampleError("invalid_sample", "Filesystem counters must be nonnegative with a positive block size.");
      const totalBytes = integer(sample.blocks * sample.bsize); const availableBytes = integer(sample.bavail * sample.bsize);
      if (totalBytes <= 0 || availableBytes > totalBytes) throw new SampleError("invalid_sample", "Filesystem availability must fit its positive total capacity.");
      return { totalBytes, availableBytes };
    });
    pendingDisk = request;
    void request.then(() => { if (pendingDisk === request) pendingDisk = null; }, () => { if (pendingDisk === request) pendingDisk = null; });
    return observe(request, operation);
  };
  return {
    collect: async (operation: Operation): Promise<WorkerTelemetrySample> => {
      operation.check();
      const collection = createOperation({ signal: operation.signal, limits: { ...operation.limits, totalMs: Math.max(1, Math.floor(Math.min(5_000, operation.remainingMs()))), requestMs: Math.min(5_000, operation.limits.requestMs) } });
      const issues: WorkerTelemetryIssue[] = [];
      const probe = async <T>(component: WorkerTelemetryIssue["component"], sample: () => T | Promise<T>): Promise<WorkerProbe<T>> => {
        const checkedAt = new Date().toISOString();
        try { collection.check(); return { state: "ok", checkedAt, value: await sample() }; }
        catch (error) { const code = codeOf(error); issues.push({ component, code, error }); return { state: "error", checkedAt, code }; }
      };
      const version = async (agent: "codex" | "copilot"): Promise<WorkerExecutableProbe> => {
        const previous = cache.get(agent);
        // A missing close acknowledgement leaves ownership uncertain; starting a replacement could leak another process tree.
        if (previous?.cleanupUncertain === true) {
          const error = previous.issue!.error;
          issues.push({ component: agent, code: "unavailable", error });
          return { state: "error", checkedAt: new Date().toISOString(), code: "unavailable" };
        }
        if (previous !== undefined && performance.now() - previous.started < 60_000) {
          if (previous.issue !== undefined) issues.push(previous.issue);
          return previous.probe;
        }
        const started = performance.now(); const checkedAt = new Date().toISOString();
        let result: WorkerExecutableProbe; let issue: WorkerTelemetryIssue | undefined;
        let cleanupUncertain = false;
        try {
          result = { state: "ok", checkedAt, value: await probeNativeAgentVersion({ agent, environment, cwd: options.workingDirectory, runCommand: (command, childOperation) => runHerdrCommand(command, childOperation, spawnHerdrProcess, { cleanupWithinDeadline: true }) }, collection) };
        } catch (error) {
          cleanupUncertain = hasHerdrCommandCleanupFailure(error);
          try {
            if (!cleanupUncertain && hasCode(error, "ENOENT") && await executableMissing(agent, environment, options.workingDirectory, collection)) result = { state: "not_installed", checkedAt };
            else { const code = codeOf(error); issue = { component: agent, code, error }; result = { state: "error", checkedAt, code }; }
          } catch (lookupError) { const code = codeOf(lookupError); issue = { component: agent, code, error: new Error("Native executable absence could not be established.", { cause: lookupError }) }; result = { state: "error", checkedAt, code }; }
        }
        cache.set(agent, { started, probe: result, ...(issue === undefined ? {} : { issue }), cleanupUncertain });
        if (issue !== undefined) issues.push(issue);
        return result;
      };
      const sampledAt = new Date().toISOString();
      try {
        const [system, cpu, memory, filesystem, daemon, codex, copilot] = await Promise.all([
          probe("os", () => ({ type: text(os.type()), release: text(os.release()), version: text(os.version()), arch: text(os.arch()) })),
          probe("cpu", () => sampleCPU(collection)),
          probe("memory", () => { const totalBytes = integer(os.totalmem()); const free = integer(os.freemem()); if (totalBytes <= 0 || free > totalBytes) throw new SampleError("invalid_sample", "Available memory must fit its positive total capacity."); return { totalBytes, usedBytes: totalBytes - free }; }),
          probe("disk", () => disk(collection)),
          probe("herdr", () => herdr.observe(collection)), version("codex"), version("copilot"),
        ]);
        try { operation.check(); }
        catch (error) {
          const cleanup = issues.filter((issue) => hasHerdrCommandCleanupFailure(issue.error)).map((issue) => issue.error);
          if (cleanup.length !== 0) throw new AggregateError([error, ...cleanup], "Worker telemetry was cancelled with unconfirmed native process cleanup.", { cause: error });
          throw error;
        }
        return { telemetry: { machine: { ...options.machine }, platform: options.platform, workingDirectory: options.workingDirectory, sampledAt, os: system, cpu, memory, disk: filesystem,
          versions: { daynight: options.version, codex, copilot, herdr: daemon.state === "error" ? daemon : daemon.value === null ? { state: "not_running", checkedAt: daemon.checkedAt } : { state: "ok", checkedAt: daemon.checkedAt, value: daemon.value } } }, issues };
      } finally { collection.dispose(); }
    },
  };
};
