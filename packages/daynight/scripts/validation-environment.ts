import os from "node:os";
import path from "node:path";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { spawnSync as nativeSpawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import crossSpawn from "cross-spawn";
import Database from "better-sqlite3";

const require = createRequire(import.meta.url);
const spawnRequire = createRequire(require.resolve("cross-spawn"));
type CommandOptions = SpawnSyncOptionsWithStringEncoding & { cwd: string; env: NodeJS.ProcessEnv };
// Reuse the pinned launcher's PATH/PATHEXT and shim rules so the recorded tool matches its launch.
const resolveCommand = spawnRequire("./lib/util/resolveCommand.js") as (command: { command: string; options: CommandOptions }) => string | undefined;
type ParsedCommand = { command: string; args: string[]; file?: string; original: { command: string; args: string[] }; options: CommandOptions & { windowsVerbatimArguments?: boolean } };
const parseCommand = spawnRequire("./lib/parse.js") as (file: string, args: string[], options: CommandOptions) => ParsedCommand;
const verifyENOENTSync = (spawnRequire("./lib/enoent.js") as { verifyENOENTSync: (status: number | null, parsed: ParsedCommand) => Error | null }).verifyENOENTSync;
const timeoutMs = 10_000;
const preparationTimeoutMs = 20_000;
const maxBuffer = 1_048_576;
const diagnosticOutputLimit = 16_384;
type ProbeError = { name: string; message: string; code?: string | number; errno?: string | number; syscall?: string; path?: string; stack?: string; cause?: ProbeError; errors?: ProbeError[] };
type ProbePhase = "resolving" | "preparing" | "running";
type Probe = {
  file: string; args: string[]; startedAt: string; state: ProbePhase | "completed" | "failed"; failurePhase?: ProbePhase | null;
  resolvedExecutable: string | null; launcher: string | null; elapsedMs: number | null;
  timeoutMs: number; executionTimeoutMs: number | null; executionElapsedMs?: number | null; maxBuffer: number; pid: number | null;
  preparation: { timeoutMs: number; bytesRead: number; sha256: string | null; elapsedMs: number | null; helperPid: number | null } | null; exitCode: number | null; signal: NodeJS.Signals | null;
  stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean; error: ProbeError | null;
};

const sensitiveEnvironmentName = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH|AUTHORIZATION|API_KEY|ACCESS_KEY|PRIVATE_KEY)(?:_|$)/i;
const sensitiveEnvironmentValues = (environment: NodeJS.ProcessEnv): string[] => [...new Set(Object.entries(environment)
  .filter(([name, value]) => sensitiveEnvironmentName.test(name) && value !== undefined && value !== "")
  .map(([, value]) => value!))].sort((a, b) => b.length - a.length);
const redact = (value: string, secrets: readonly string[]): string => {
  let text = secrets.reduce((current, secret) => current.replaceAll(secret, "[REDACTED]"), value);
  while (secrets.some(secret => text.includes(secret))) {
    for (const secret of secrets) text = text.replaceAll(secret, "");
  }
  return text;
};
const serializeError = (error: unknown, detail = false): ProbeError => {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  return { name: error.name, message: error.message,
    ...("code" in error && (typeof error.code === "string" || typeof error.code === "number") ? { code: error.code } : {}),
    ...(detail && "errno" in error && (typeof error.errno === "number" || typeof error.errno === "string") ? { errno: error.errno } : {}),
    ...("syscall" in error && typeof error.syscall === "string" ? { syscall: error.syscall } : {}),
    ...(detail && "path" in error && typeof error.path === "string" ? { path: error.path } : {}),
    ...(detail && error.stack !== undefined ? { stack: error.stack } : {}),
    ...(detail && error.cause !== undefined ? { cause: serializeError(error.cause, true) } : {}),
    ...(detail && error instanceof AggregateError ? { errors: error.errors.map((item: unknown) => serializeError(item, true)) } : {}),
  };
};

const provenanceHelperArgument = "--daynight-gh-provenance-helper";
type ProvenanceRequest = { file: string; args: string[]; cwd: string; environment: NodeJS.ProcessEnv };
type PreparedCommand = { command: string; args: string[]; file: string | null; windowsVerbatimArguments: boolean; original: { command: string; args: string[] } };
type ProvenanceEvent =
  | { kind: "resolved"; resolvedExecutable: string | null; launcher: string | null; parsed: PreparedCommand }
  | { kind: "progress"; bytesRead: number }
  | { kind: "complete"; bytesRead: number; sha256: string | null }
  | { kind: "error"; bytesRead: number; error: ProbeError };
const writeProvenanceEvent = (event: ProvenanceEvent): void => {
  const data = Buffer.from(`${JSON.stringify(event)}\n`);
  for (let offset = 0; offset < data.length;) {
    const written = writeSync(1, data, offset, data.length - offset);
    if (written === 0) throw new Error("GH provenance helper could not write its progress.");
    offset += written;
  }
};
const runProvenanceHelper = (request: ProvenanceRequest): void => {
  let bytesRead = 0;
  try {
    const options: CommandOptions = { cwd: request.cwd, env: request.environment, encoding: "utf8", shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer };
    const resolvedExecutable = resolveCommand({ command: request.file, options }) ?? null;
    const parsed = parseCommand(request.file, request.args, options);
    const launcher = resolveCommand({ command: parsed.command, options }) ?? null;
    writeProvenanceEvent({ kind: "resolved", resolvedExecutable, launcher, parsed: { command: parsed.command, args: parsed.args, file: parsed.file ?? null,
      windowsVerbatimArguments: parsed.options.windowsVerbatimArguments ?? false, original: parsed.original } });
    if (resolvedExecutable === null) { writeProvenanceEvent({ kind: "complete", bytesRead, sha256: null }); return; }
    const file = resolvedExecutable;
    const descriptor = openSync(file, "r");
    let result: { sha256: string } | undefined;
    let failed = false;
    let failure: unknown;
    try {
      const buffer = Buffer.allocUnsafe(maxBuffer);
      const hash = createHash("sha256");
      for (;;) {
        const count = readSync(descriptor, buffer, 0, buffer.length, null);
        if (count === 0) break;
        bytesRead += count;
        hash.update(buffer.subarray(0, count));
        writeProvenanceEvent({ kind: "progress", bytesRead });
      }
      result = { sha256: hash.digest("hex") };
    } catch (error) { failed = true; failure = error; }
    try { closeSync(descriptor); }
    catch (error) {
      if (failed) throw new AggregateError([failure, error], "GH provenance read and close failed.", { cause: failure });
      throw error;
    }
    if (failed) throw failure;
    writeProvenanceEvent({ kind: "complete", bytesRead, sha256: result!.sha256 });
  } catch (error) {
    writeProvenanceEvent({ kind: "error", bytesRead, error: serializeError(error, true) });
    process.exitCode = 1;
  }
};

const isProvenanceError = (value: unknown, depth = 0): value is ProbeError => {
  if (depth > 16 || typeof value !== "object" || value === null) return false;
  const error = value as Record<string, unknown>;
  return typeof error.name === "string" && typeof error.message === "string"
    && (error.code === undefined || typeof error.code === "string" || typeof error.code === "number")
    && (error.errno === undefined || typeof error.errno === "number" || typeof error.errno === "string")
    && (error.syscall === undefined || typeof error.syscall === "string")
    && (error.path === undefined || typeof error.path === "string")
    && (error.stack === undefined || typeof error.stack === "string")
    && (error.cause === undefined || isProvenanceError(error.cause, depth + 1))
    && (error.errors === undefined || Array.isArray(error.errors) && error.errors.every(item => isProvenanceError(item, depth + 1)));
};

const readProvenanceEvents = (stdout: string, allowPartial: boolean): ProvenanceEvent[] => {
  if (!allowPartial && stdout !== "" && !stdout.endsWith("\n")) throw new Error("Incomplete GH provenance helper output.");
  let previousBytes = 0;
  let resolved = false;
  let terminal = false;
  return stdout.split("\n").slice(0, -1).map(line => {
    const event: unknown = JSON.parse(line);
    if (terminal || typeof event !== "object" || event === null || !("kind" in event)) {
      throw new Error("Invalid GH provenance helper output.");
    }
    const value = event as Record<string, unknown>;
    if (value.kind === "resolved") {
      const parsed = value.parsed as Record<string, unknown> | null;
      const original = parsed?.original as Record<string, unknown> | null;
      if (resolved || (value.resolvedExecutable !== null && typeof value.resolvedExecutable !== "string") || (value.launcher !== null && typeof value.launcher !== "string")
        || typeof parsed !== "object" || parsed === null || typeof parsed.command !== "string" || !Array.isArray(parsed.args) || !parsed.args.every(item => typeof item === "string")
        || (parsed.file !== null && typeof parsed.file !== "string") || typeof parsed.windowsVerbatimArguments !== "boolean"
        || typeof original !== "object" || original === null || typeof original.command !== "string" || !Array.isArray(original.args) || !original.args.every(item => typeof item === "string")) {
        throw new Error("Invalid GH provenance resolution.");
      }
      resolved = true;
      return value as ProvenanceEvent;
    }
    if (!Number.isSafeInteger(value.bytesRead) || (value.bytesRead as number) < previousBytes) throw new Error("Invalid GH provenance byte count.");
    if (value.kind === "progress" && !resolved) throw new Error("GH provenance progress precedes resolution.");
    if (value.kind === "complete" && (!resolved || (value.sha256 !== null && (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256))))) throw new Error("Invalid GH provenance hash.");
    if (value.kind === "error" && !isProvenanceError(value.error)) throw new Error("Invalid GH provenance error.");
    if (value.kind !== "progress" && value.kind !== "complete" && value.kind !== "error") throw new Error("Invalid GH provenance event.");
    terminal = value.kind === "complete" || value.kind === "error";
    previousBytes = value.bytesRead as number;
    return value as ProvenanceEvent;
  });
};

const restoreProvenanceError = (error: ProbeError): Error => {
  const { cause, errors, ...properties } = error;
  const options = cause === undefined ? undefined : { cause: restoreProvenanceError(cause) };
  const restored = errors === undefined
    ? new Error(error.message, options)
    : new AggregateError(errors.map(restoreProvenanceError), error.message, options);
  return Object.assign(restored, properties);
};

export const createValidationProbeRecorder = (options: {
  directory: string;
  environment: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  now?: () => number;
  execute?: (file: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
  preparationTimeoutMs?: number;
  prepare?: (request: ProvenanceRequest, options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
}) => {
  const directory = path.resolve(options.directory);
  const log = options.log === undefined ? (message: string): void => { process.stdout.write(message); } : options.log;
  const execute = options.execute === undefined ? crossSpawn.sync : options.execute;
  const prepare = options.prepare === undefined
    ? (_request: ProvenanceRequest, spawnOptions: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> => nativeSpawnSync(process.execPath, [fileURLToPath(import.meta.url), provenanceHelperArgument], spawnOptions)
    : options.prepare;
  const preparationBudget = options.preparationTimeoutMs ?? preparationTimeoutMs;
  if (!Number.isSafeInteger(preparationBudget) || preparationBudget <= 0) throw new RangeError("GH preparation timeout must be a positive integer.");
  const now = options.now === undefined ? () => performance.now() : options.now;
  const secrets = sensitiveEnvironmentValues(options.environment);
  const safe = (value: string): string => redact(value, secrets);
  const safeError = (error: ProbeError): ProbeError => ({ ...error, message: safe(error.message),
    ...(error.syscall === undefined ? {} : { syscall: safe(error.syscall) }),
    ...(error.path === undefined ? {} : { path: safe(error.path) }),
    ...(error.stack === undefined ? {} : { stack: safe(error.stack) }),
    ...(error.cause === undefined ? {} : { cause: safeError(error.cause) }),
    ...(error.errors === undefined ? {} : { errors: error.errors.map(safeError) }),
  });
  const safeProbe = (probe: Probe): Probe => {
    return { ...probe, args: probe.args.map(safe),
      resolvedExecutable: probe.resolvedExecutable === null ? null : safe(probe.resolvedExecutable),
      launcher: probe.launcher === null ? null : safe(probe.launcher),
      stdout: safe(probe.stdout), stderr: safe(probe.stderr), error: probe.error === null ? null : safeError(probe.error) };
  };
  const probes: Probe[] = [];
  const diagnostics: { capturedAt: string; platform: string; architecture: string; probes: Probe[]; error: ProbeError | null } = {
    capturedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, probes, error: null,
  };
  let redactError = false;
  mkdirSync(directory, { recursive: true });
  const persist = (): void => {
    const snapshot = { ...diagnostics, probes: probes.map(probe => probe.file === "gh" ? safeProbe(probe) : probe),
      error: redactError && diagnostics.error !== null ? safeError(diagnostics.error) : diagnostics.error };
    writeFileSync(path.join(directory, "validation-probes.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  };
  persist();
  const command = (file: string, args: readonly string[], version: boolean): string => {
    const started = now();
    const preparationDeadline = started + preparationBudget;
    const timeoutError = (phase: "prepare" | "execute", budget: number): Error => Object.assign(new Error(`Cannot ${phase} ${file} ${args.join(" ")} within ${budget}ms.`), { code: "ETIMEDOUT" });
    const remainingPreparationTime = (): number => {
      const remaining = Math.floor(preparationDeadline - now());
      if (remaining <= 0) throw timeoutError("prepare", preparationBudget);
      return remaining;
    };
    const checkPreparationDeadline = (): void => { remainingPreparationTime(); };
    let phase: ProbePhase = "resolving";
    const probe: Probe = { file, args: [...args], startedAt: new Date().toISOString(), state: "resolving",
      ...(file === "gh" ? { failurePhase: null, executionElapsedMs: null } : {}), resolvedExecutable: null, launcher: null, elapsedMs: null, timeoutMs, executionTimeoutMs: null, maxBuffer, pid: null, preparation: null,
      exitCode: null, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, error: null };
    probes.push(probe);
    const record = (): void => { persist(); log(`Validation probe: ${JSON.stringify(file === "gh" ? safeProbe(probe) : probe)}\n`); };
    record();
    try {
      const environment = file === "gh" ? {
        ...options.environment,
        GH_CONFIG_DIR: path.join(directory, "gh", "config"),
        XDG_STATE_HOME: path.join(directory, "gh", "state"),
        XDG_DATA_HOME: path.join(directory, "gh", "data"),
        GH_TELEMETRY: "0",
      } : { ...options.environment };
      const executionOptions: CommandOptions = {
        cwd: process.cwd(), env: environment, encoding: "utf8", shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer,
      };
      let preparedCommand: PreparedCommand | undefined;
      if (file === "gh") {
        probe.state = "preparing";
        const preparation = { timeoutMs: preparationBudget, bytesRead: 0, sha256: null as string | null, elapsedMs: null as number | null, helperPid: null as number | null };
        probe.preparation = preparation;
        const preparationStarted = now();
        try {
          record();
          const helperEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "NODE_OPTIONS" && !sensitiveEnvironmentName.test(name)));
          const request: ProvenanceRequest = { file, args: [...args], cwd: executionOptions.cwd,
            environment: Object.fromEntries(Object.entries(environment).filter(([name]) => name.toUpperCase() === "PATH")) };
          const result = prepare(request, { cwd: process.cwd(), env: helperEnvironment, encoding: "utf8", shell: false, windowsHide: true,
            input: JSON.stringify(request), timeout: remainingPreparationTime(), killSignal: "SIGKILL", maxBuffer });
          preparation.helperPid = result.pid || null;
          const events = readProvenanceEvents(typeof result.stdout === "string" ? result.stdout : "", result.error !== undefined && result.error !== null);
          const resolution = events.find(event => event.kind === "resolved");
          if (resolution?.kind === "resolved") {
            probe.resolvedExecutable = resolution.resolvedExecutable;
            probe.launcher = resolution.launcher;
            preparedCommand = resolution.parsed;
            if (resolution.resolvedExecutable !== null) phase = "preparing";
          }
          const last = events.at(-1);
          if (last !== undefined && last.kind !== "resolved") preparation.bytesRead = last.bytesRead;
          if (result.error !== undefined && result.error !== null) {
            if ("code" in result.error && result.error.code === "ETIMEDOUT") throw timeoutError("prepare", preparationBudget);
            throw result.error;
          }
          if (last?.kind === "error") throw restoreProvenanceError(last.error);
          if (result.status !== 0 || result.signal !== null || last?.kind !== "complete" || preparedCommand === undefined
            || (probe.resolvedExecutable !== null && last.sha256 === null) || (probe.resolvedExecutable === null && last.sha256 !== null)) {
            const stderr = typeof result.stderr === "string" ? result.stderr.slice(0, diagnosticOutputLimit) : "";
            throw new Error(`GH provenance helper failed: exit=${result.status}, signal=${result.signal}.`, stderr === "" ? undefined : { cause: new Error(stderr) });
          }
          preparation.sha256 = last.sha256;
          checkPreparationDeadline();
        } finally { preparation.elapsedMs = now() - preparationStarted; }
        if (probe.resolvedExecutable === null) probe.preparation = null;
      } else {
        probe.resolvedExecutable = resolveCommand({ command: file, options: executionOptions }) ?? null;
        const parsed = parseCommand(file, [...args], executionOptions);
        probe.launcher = resolveCommand({ command: parsed.command, options: executionOptions }) ?? null;
      }
      if (file === "gh") checkPreparationDeadline();
      probe.executionTimeoutMs = timeoutMs;
      probe.state = "running";
      record();
      if (file === "gh") checkPreparationDeadline();
      phase = "running";
      executionOptions.timeout = probe.executionTimeoutMs;
      const executionStarted = file === "gh" ? now() : 0;
      let executionCompletedAt = executionStarted;
      let result: SpawnSyncReturns<string>;
      try {
        if (file === "gh" && options.execute === undefined) {
          if (preparedCommand === undefined) throw new Error("GH command resolution did not complete.");
          const parsed: ParsedCommand = { command: preparedCommand.command, args: preparedCommand.args, original: preparedCommand.original,
            ...(preparedCommand.file === null ? {} : { file: preparedCommand.file }),
            options: { ...executionOptions, windowsVerbatimArguments: preparedCommand.windowsVerbatimArguments } };
          result = nativeSpawnSync(parsed.command, parsed.args, parsed.options);
          if (result.error === undefined || result.error === null) {
            const error = verifyENOENTSync(result.status, parsed);
            if (error !== null) result.error = error;
          }
        } else result = execute(file, [...args], executionOptions);
      }
      finally { if (file === "gh") { executionCompletedAt = now(); probe.executionElapsedMs = executionCompletedAt - executionStarted; } }
      probe.pid = result.pid;
      const stdout = typeof result.stdout === "string" ? (file === "gh" ? safe(result.stdout) : result.stdout) : "";
      const stderr = typeof result.stderr === "string" ? (file === "gh" ? safe(result.stderr) : result.stderr) : "";
      probe.exitCode = result.status;
      probe.signal = result.signal;
      probe.stdout = stdout.slice(0, diagnosticOutputLimit);
      probe.stderr = stderr.slice(0, diagnosticOutputLimit);
      probe.stdoutTruncated = stdout.length > diagnosticOutputLimit;
      probe.stderrTruncated = stderr.length > diagnosticOutputLimit;
      if (result.error !== undefined && result.error !== null) throw result.error;
      if (result.status !== 0 || result.signal !== null) {
        throw new Error(`Cannot record ${file} ${args.join(" ")}: exit=${result.status}, signal=${result.signal}.`);
      }
      const output = stdout.trim();
      if (version && output === "") throw new Error(`The ${file} version command returned no output.`);
      const elapsed = (file === "gh" ? executionCompletedAt : now()) - started;
      if (file === "gh" && probe.executionElapsedMs! >= timeoutMs) throw timeoutError("execute", timeoutMs);
      probe.state = "completed";
      probe.elapsedMs = elapsed;
      record();
      return version ? output.split(/\r?\n/)[0]! : output;
    } catch (error) {
      probe.state = "failed";
      if (file === "gh") {
        probe.failurePhase = phase;
        if (phase !== "running") probe.executionTimeoutMs = null;
      }
      probe.elapsedMs = now() - started;
      probe.error = serializeError(error, file === "gh");
      diagnostics.error = probe.error;
      redactError = file === "gh";
      record();
      throw error;
    }
  };
  return {
    command: (file: string, args: readonly string[]): string => command(file, args, false),
    version: (file: string): string => command(file, ["--version"], true),
    fail: (error: unknown): void => { diagnostics.error = serializeError(error, redactError); persist(); },
  };
};

export const recordValidationEnvironment = async (directory: string, environment: NodeJS.ProcessEnv): Promise<void> => {
  const probes = createValidationProbeRecorder({ directory, environment });
  try {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string; dependencies: Record<string, string>;
    };
    const database = new Database(":memory:");
    let sqliteVersion: string;
    try { sqliteVersion = (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version; }
    finally { database.close(); }
    const { header } = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
    const evidence = {
      capturedAt: new Date().toISOString(),
      sourceRevision: probes.command("git", ["rev-parse", "HEAD"]),
      sourceDirty: probes.command("git", ["status", "--porcelain"]) !== "",
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      osVersion: os.version(),
      glibcVersionRuntime: header.glibcVersionRuntime,
      versions: { node: process.version, nodeAbi: process.versions.modules, nodeApi: process.versions.napi,
        pnpm: probes.version("pnpm"), git: probes.version("git"), gh: probes.version("gh") },
      packageVersion: manifest.version,
      sqlite: { packageVersion: manifest.dependencies["better-sqlite3"], engineVersion: sqliteVersion },
      liveCopilotExercised: false,
    };
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    await writeFile(path.join(directory, "validation-environment.json"), serialized);
    process.stdout.write(serialized);
  } catch (error) { probes.fail(error); throw error; }
};

if (import.meta.main && process.argv[2] === provenanceHelperArgument) {
  if (process.argv.length !== 3) throw new Error("The GH provenance helper requires one request on stdin.");
  runProvenanceHelper(JSON.parse(readFileSync(0, "utf8")) as ProvenanceRequest);
} else if (import.meta.main) {
  try { await recordValidationEnvironment(path.resolve(".tmp"), process.env); }
  catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${redact(message, sensitiveEnvironmentValues(process.env))}\n`);
    process.exitCode = 1;
  }
}
