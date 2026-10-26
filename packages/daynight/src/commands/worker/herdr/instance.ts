import type { ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { Socket } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { gte, valid } from "semver";
import type { Operation } from "../../../api/operation.js";
import { replaceFileAtomically } from "../../../platform/files.js";
import type { WorkerPaths } from "../paths.js";
import { createHerdrRpcClient, herdrIpcAddress } from "./rpc.js";
import type { HerdrRpcResult } from "./rpc.js";
import { runHerdrCommand, spawnHerdrProcess, terminateOwnedHerdrProcess } from "./command.js";
import type { HerdrSpawn } from "./command.js";

const session = "w";
const managedConfiguration = "onboarding = false\n\n[session]\nresume_agents_on_restore = false\n";
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const absentConnection = (error: unknown): boolean => error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED");
const inheritedIdentity = new Set([
  "HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_SESSION", "HERDR_STARTUP_CWD", "HERDR_ENV",
  "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_TERMINAL_ID",
  "HERDR_ACTIVE_PANE_ID", "HERDR_ACTIVE_TAB_ID", "HERDR_ACTIVE_WORKSPACE_ID", "HERDR_ACTIVE_PANE_CWD", "HERDR_PANE_RUNTIME_ID",
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_TOOL_CALL_ID",
]);

export type HerdrInstancePaths = {
  privateDirectory: string;
  configurationFile: string;
  configHome: string;
  stateHome: string;
  sessionDirectory: string;
  apiEndpoint: string;
  clientEndpoint: string;
  stdoutLogFile: string;
  stderrLogFile: string;
};
export type HerdrAttachment = { executable: string; arguments: readonly string[]; environment: NodeJS.ProcessEnv; unsetEnvironment: readonly string[] };
export type HerdrInstanceReady = { reconnected: boolean; version: string; protocol: 22; snapshot: Record<string, unknown> };
export type HerdrInstanceStopped = { apiClosed: true; clientClosed: true; ownedChildClosed: boolean | null };

export const resolveHerdrInstancePaths = (
  worker: Pick<WorkerPaths, "herdrDirectory" | "logsDirectory">,
  platform: NodeJS.Platform = process.platform,
): HerdrInstancePaths => {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(worker.herdrDirectory) || !paths.isAbsolute(worker.logsDirectory)) throw new Error("Worker Herdr and log directories must be absolute.");
  const privateDirectory = worker.herdrDirectory;
  const sessionDirectory = paths.join(privateDirectory, "c", "herdr", "sessions", session);
  const apiEndpoint = paths.join(sessionDirectory, "herdr.sock");
  const clientEndpoint = paths.join(sessionDirectory, "herdr-client.sock");
  for (const endpoint of [apiEndpoint, clientEndpoint]) {
    if (/[\r\n\0]/.test(endpoint)) throw new Error("The private Herdr endpoint contains a line break or NUL.");
    if (platform === "win32") {
      if (herdrIpcAddress(endpoint, platform).length > 256) throw new Error(`The private Herdr pipe exceeds 256 characters: ${endpoint}.`);
    } else {
      const maximum = platform === "darwin" ? 103 : 107;
      if (Buffer.byteLength(endpoint, "utf8") > maximum) throw new Error(`The private Herdr socket exceeds ${maximum} UTF-8 bytes: ${endpoint}.`);
    }
  }
  return { privateDirectory, configurationFile: paths.join(privateDirectory, "config.toml"), configHome: paths.join(privateDirectory, "c"), stateHome: paths.join(privateDirectory, "s"), sessionDirectory, apiEndpoint, clientEndpoint,
    stdoutLogFile: paths.join(worker.logsDirectory, "herdr.stdout.log"), stderrLogFile: paths.join(worker.logsDirectory, "herdr.stderr.log") };
};

export const createHerdrEnvironment = (paths: HerdrInstancePaths, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(inherited).filter(([name]) => !inheritedIdentity.has(name.toUpperCase()))),
  XDG_CONFIG_HOME: paths.configHome,
  XDG_STATE_HOME: paths.stateHome,
  HERDR_CONFIG_PATH: paths.configurationFile,
});

const bounded = (parent: Operation, maximumMs: number) => {
  parent.check();
  const milliseconds = Math.max(1, Math.ceil(Math.min(maximumMs, parent.remainingMs())));
  const deadline = performance.now() + milliseconds;
  const controller = new AbortController();
  const abort = (): void => { controller.abort(parent.signal.reason); };
  const timer = setTimeout(() => controller.abort(new Error("The private Herdr operation deadline elapsed.")), milliseconds);
  parent.signal.addEventListener("abort", abort, { once: true });
  if (parent.signal.aborted) abort();
  const check = (): void => {
    parent.check();
    if (controller.signal.aborted) throw controller.signal.reason;
    if (performance.now() >= deadline) throw new Error("The private Herdr operation deadline elapsed.");
  };
  return {
    signal: controller.signal,
    limits: { ...parent.limits, totalMs: milliseconds, requestMs: Math.min(milliseconds, parent.limits.requestMs) },
    check,
    remainingMs: (): number => { check(); return Math.max(0, Math.min(parent.remainingMs(), deadline - performance.now())); },
    consume: (bytes: number): void => { check(); parent.consume(bytes); },
    dispose: (): void => { clearTimeout(timer); parent.signal.removeEventListener("abort", abort); },
  } satisfies Operation;
};
const pause = async (operation: Operation): Promise<void> => { operation.check(); await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, operation.remainingMs()))); operation.check(); };
const observeStartup = <T>(startup: Promise<T>, operation: Operation): Promise<T> => new Promise((resolve, reject) => {
  operation.check();
  const done = (outcome: { result: T } | { error: unknown }): void => {
    clearTimeout(timer); operation.signal.removeEventListener("abort", abort);
    if ("error" in outcome) reject(outcome.error); else resolve(outcome.result);
  };
  const abort = (): void => done({ error: operation.signal.reason });
  const timer = setTimeout(() => done({ error: new Error("The Herdr startup observer deadline elapsed.") }), Math.max(1, Math.ceil(operation.remainingMs())));
  operation.signal.addEventListener("abort", abort, { once: true });
  if (operation.signal.aborted) abort();
  startup.then((result) => done({ result }), (error: unknown) => done({ error }));
});
const probeEndpoint = (endpoint: string, operation: Operation): Promise<boolean> => new Promise((resolve, reject) => {
  operation.check();
  const socket = new Socket();
  let outcome: boolean | Error | undefined;
  const finish = (value: boolean | Error): void => { if (outcome !== undefined) return; outcome = value; socket.destroy(); };
  const abort = (): void => { finish(operation.signal.reason instanceof Error ? operation.signal.reason : new Error("Herdr endpoint probe cancelled.", { cause: operation.signal.reason })); };
  const timer = setTimeout(() => finish(new Error(`Cannot determine whether private Herdr endpoint ${endpoint} is available: connection deadline elapsed.`)), Math.max(1, Math.ceil(Math.min(1_000, operation.remainingMs()))));
  socket.once("connect", () => finish(true));
  socket.once("error", (error) => finish(absentConnection(error) ? false : new Error(`Cannot inspect private Herdr endpoint ${endpoint}.`, { cause: error })));
  socket.once("close", () => {
    clearTimeout(timer); operation.signal.removeEventListener("abort", abort);
    if (outcome instanceof Error) reject(outcome); else if (outcome !== undefined) resolve(outcome); else reject(new Error(`Private Herdr endpoint ${endpoint} closed without an observation.`));
  });
  operation.signal.addEventListener("abort", abort, { once: true });
  if (operation.signal.aborted) abort();
  else try { socket.connect({ path: herdrIpcAddress(endpoint) }); } catch (cause) { finish(new Error(`Cannot connect to private Herdr endpoint ${endpoint}.`, { cause })); }
});

const ordinaryDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Private Herdr directory ${directory} must be an ordinary directory.`);
};
const ensureConfiguration = async (paths: HerdrInstancePaths): Promise<void> => {
  await ordinaryDirectory(paths.privateDirectory);
  try {
    const entry = await lstat(paths.configurationFile);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Private Herdr configuration ${paths.configurationFile} must be an ordinary file.`);
    if (await readFile(paths.configurationFile, "utf8") !== managedConfiguration) throw new Error(`Private Herdr configuration ${paths.configurationFile} differs from the managed configuration; inspect it before starting the worker.`);
  } catch (error) {
    if (!missing(error)) throw error;
    await replaceFileAtomically(paths.configurationFile, managedConfiguration, 0o600);
  }
};
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const compatible = (pong: HerdrRpcResult): { version: string; protocol: 22 } => {
  if (pong.type !== "pong" || typeof pong.version !== "string" || valid(pong.version) === null || !gte(pong.version, "0.9.5") || pong.protocol !== 22 || !record(pong.capabilities)) {
    throw new Error("The private Herdr instance must provide version 0.9.5 or newer, protocol 22 and server capabilities.");
  }
  return { version: pong.version, protocol: 22 };
};

type OwnedChild = { child: ChildProcess; closed: boolean; code: number | null; signal: NodeJS.Signals | null; error: Error | null };
const observeChild = (child: ChildProcess): OwnedChild => {
  const owned: OwnedChild = { child, closed: false, code: null, signal: null, error: null };
  child.once("error", (error) => { owned.error = error; });
  child.once("close", (code, signal) => { owned.closed = true; owned.code = code; owned.signal = signal; });
  return owned;
};
const killOwnedChild = (owned: OwnedChild): void => {
  if (owned.closed || owned.child.pid === undefined) return;
  terminateOwnedHerdrProcess(owned.child);
};

export const createHerdrInstance = (options: {
  paths: Pick<WorkerPaths, "herdrDirectory" | "logsDirectory">;
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  spawnProcess?: HerdrSpawn;
}) => {
  const paths = resolveHerdrInstancePaths(options.paths);
  const executable = options.executable === undefined ? "herdr" : options.executable;
  if (executable.trim() === "" || /[\r\n\0]/.test(executable)) throw new Error("The Herdr executable must be nonempty without line breaks or NUL.");
  const environment = createHerdrEnvironment(paths, options.environment === undefined ? process.env : options.environment);
  const attachmentEnvironment: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: paths.configHome, XDG_STATE_HOME: paths.stateHome, HERDR_CONFIG_PATH: paths.configurationFile };
  for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_SQLITE_HOME", "COPILOT_HOME"]) {
    if (environment[key] !== undefined) attachmentEnvironment[key] = environment[key];
  }
  const start = options.spawnProcess === undefined ? spawnHerdrProcess : options.spawnProcess;
  const rpc = createHerdrRpcClient(paths.apiEndpoint);
  let owned: OwnedChild | null = null;
  let starting: Promise<HerdrInstanceReady> | null = null;
  const endpoints = async (operation: Operation) => {
    const results = await Promise.allSettled([probeEndpoint(paths.apiEndpoint, operation), probeEndpoint(paths.clientEndpoint, operation)]);
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason as unknown);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Both private Herdr endpoints could not be inspected.");
    const [api, client] = results;
    if (api?.status !== "fulfilled" || client?.status !== "fulfilled") throw new Error("Private Herdr endpoint inspection was incomplete.");
    return { api: api.value, client: client.value };
  };
  const ready = async (operation: Operation): Promise<Omit<HerdrInstanceReady, "reconnected">> => {
    const version = compatible(await rpc.request("ping", {}, operation));
    const result = await rpc.request("session.snapshot", {}, operation);
    if (result.type !== "session_snapshot" || !record(result.snapshot)) throw new Error("The private Herdr instance did not return its restored session snapshot.");
    return { ...version, snapshot: result.snapshot };
  };
  const version = async (operation: Operation): Promise<void> => {
    const result = await runHerdrCommand({ file: executable, args: ["--version"], environment }, operation, start);
    const match = /^herdr\s+(\S+)\s*$/.exec(result.stdout);
    if (match === null || valid(match[1]) === null || !gte(match[1]!, "0.9.5")) throw new Error("Herdr 0.9.5 or newer is required before starting the private instance.");
  };
  const ensure = async (operation: Operation): Promise<HerdrInstanceReady> => {
    operation.check();
    if (starting !== null) return observeStartup(starting, operation);
    starting = (async () => {
      const scope = bounded(operation, 30_000);
      let startedHere: OwnedChild | null = null;
      try {
        await ensureConfiguration(paths);
        const before = await endpoints(scope);
        if (before.api && before.client) return { ...await ready(scope), reconnected: true };
        if (before.api || before.client) throw new Error("The private Herdr instance has only one reachable endpoint; its startup or shutdown remains unconfirmed.");
        if (owned !== null && !owned.closed) throw new Error("The owned private Herdr process is still running without both endpoints; its shutdown remains unconfirmed.");
        await version(scope);
        await ordinaryDirectory(path.dirname(paths.stdoutLogFile));
        const stdout = openSync(paths.stdoutLogFile, "a", 0o600);
        let stderr: number | undefined;
        try {
          stderr = openSync(paths.stderrLogFile, "a", 0o600);
          owned = observeChild(start(executable, ["--session", session, "server"], { env: environment, detached: true, windowsHide: true, stdio: ["ignore", stdout, stderr] }));
          startedHere = owned;
        } finally { closeSync(stdout); if (stderr !== undefined) closeSync(stderr); }
        while (true) {
          const observed = await endpoints(scope);
          if (observed.api && observed.client) {
            const result = await ready(scope);
            owned.child.unref();
            return { ...result, reconnected: owned.closed };
          }
          if (owned.error !== null || owned.closed) throw new Error(`The private Herdr process exited before readiness: exit=${String(owned.code)}, signal=${String(owned.signal)}.`, { cause: owned.error });
          await pause(scope);
        }
      } catch (error) {
        if (startedHere !== null && !startedHere.closed) {
          try { killOwnedChild(startedHere); }
          catch (cause) { throw new AggregateError([error, cause], "Private Herdr startup failed and its owned process could not be terminated."); }
          const deadline = performance.now() + 2_000;
          while (!startedHere.closed && performance.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
          if (!startedHere.closed) throw new AggregateError([error, new Error("The owned Herdr process did not close after failed startup.")], "Private Herdr startup and process cleanup failed.");
        }
        throw error;
      } finally { scope.dispose(); }
    })();
    try { return await starting; } finally { starting = null; }
  };
  return {
    paths, environment, rpc,
    attachment: { executable, arguments: ["--session", session], environment: attachmentEnvironment, unsetEnvironment: [...inheritedIdentity] } satisfies HerdrAttachment,
    ensure,
    stop: async (operation: Operation): Promise<HerdrInstanceStopped> => {
      const scope = bounded(operation, 15_000);
      let requestFailure: unknown;
      let probeFailure: unknown;
      let submitted = false;
      try {
        while (true) {
          let current: { api: boolean; client: boolean };
          try { current = await endpoints(scope); }
          catch (error) { probeFailure = error; await pause(scope); continue; }
          if (!current.api && !current.client && (owned === null || owned.closed)) return { apiClosed: true, clientClosed: true, ownedChildClosed: owned === null ? null : true };
          if (current.api && !submitted) {
            submitted = true;
            try { const response = await rpc.request("server.stop", {}, scope); if (response.type !== "ok") throw new Error("Private Herdr returned an invalid stop acknowledgement."); }
            catch (error) { requestFailure = error; }
          }
          await pause(scope);
        }
      } catch (error) {
        const failures = [requestFailure, probeFailure].filter((failure) => failure !== undefined);
        if (failures.length !== 0) throw new AggregateError([...failures, error], "Private Herdr stop remained unconfirmed.");
        throw error;
      } finally { scope.dispose(); }
    },
  };
};

export type HerdrInstance = ReturnType<typeof createHerdrInstance>;
