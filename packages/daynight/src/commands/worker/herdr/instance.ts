import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, openSync } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { gte, valid } from "semver";
import type { Operation } from "../../../api/operation.js";
import { replaceFileAtomically } from "../../../platform/files.js";
import { toolCommand, verifyToolLaunch, type ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import type { WorkerPaths } from "../paths.js";
import { createHerdrRpcClient, herdrIpcAddress } from "./rpc.js";
import type { HerdrRpcResult } from "./rpc.js";
import { runHerdrCommand, spawnHerdrProcess, terminateOwnedHerdrProcess } from "./command.js";
import type { HerdrSpawn } from "./command.js";
import { optionalOwnedJson, posixToolMappingRc, publishOwnedJson } from "./tool-launch.js";

const session = "w";
const managedConfiguration = "onboarding = false\n\n[session]\nresume_agents_on_restore = false\n";
const isolatedConfiguration = `${managedConfiguration}\n[update]\nversion_check = false\nmanifest_check = false\n`;
// Bash privileged mode also ignores imported shell functions and shell-option variables.
const legacyManagedShell = '#!/bin/sh\nexec /bin/bash --noprofile --norc -p "$@"\n';
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const managedShell = (rc: string): string => `#!/bin/sh\nexec /bin/bash --noprofile --rcfile ${shellQuote(rc)} -p "$@"\n`;
const managedShellRc = (readyDirectory: string, mapping = false, runtime?: { nodeExecutable: string; childEntry: string }): string => `builtin unset PROMPT_COMMAND
PS1='bash$ '
PS2='> '
PS4='+ '
${mapping ? posixToolMappingRc(runtime) : ""}\
if [[ "\${DAYNIGHT_HERDR_SHELL_NONCE-}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  daynight_startup_umask=$(builtin umask)
  daynight_startup_options=$-
  builtin umask 077
  builtin set -o noclobber
  builtin printf '%s\\n%s\\n' "$DAYNIGHT_HERDR_SHELL_NONCE" "$$" > ${shellQuote(`${readyDirectory}/`)}"$DAYNIGHT_HERDR_SHELL_NONCE.$$"
  case "$daynight_startup_options" in *C*) ;; *) builtin set +o noclobber ;; esac
  builtin umask "$daynight_startup_umask"
fi
builtin unset DAYNIGHT_HERDR_SHELL_NONCE daynight_startup_umask daynight_startup_options
`;
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const absentConnection = (error: unknown): boolean => error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED");
const inheritedIdentity = new Set([
  "HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_SESSION", "HERDR_STARTUP_CWD", "HERDR_ENV",
  "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_TERMINAL_ID",
  "HERDR_ACTIVE_PANE_ID", "HERDR_ACTIVE_TAB_ID", "HERDR_ACTIVE_WORKSPACE_ID", "HERDR_ACTIVE_PANE_CWD", "HERDR_PANE_RUNTIME_ID",
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_TOOL_CALL_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT",
  "DAYNIGHT_HERDR_SHELL_NONCE",
  "DAYNIGHT_HERDR_TOOL_MANIFEST",
]);

export type HerdrInstancePaths = {
  privateDirectory: string;
  configurationFile: string;
  configHome: string;
  stateHome: string;
  shellHistoryFile: string;
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
  return { privateDirectory, configurationFile: paths.join(privateDirectory, "config.toml"), configHome: paths.join(privateDirectory, "c"), stateHome: paths.join(privateDirectory, "s"), shellHistoryFile: paths.join(privateDirectory, "shell.history"), sessionDirectory, apiEndpoint, clientEndpoint,
    stdoutLogFile: paths.join(worker.logsDirectory, "herdr.stdout.log"), stderrLogFile: paths.join(worker.logsDirectory, "herdr.stderr.log") };
};

export const createHerdrEnvironment = (paths: Pick<HerdrInstancePaths, "configHome" | "stateHome" | "configurationFile" | "shellHistoryFile">, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(inherited).filter(([name]) => !inheritedIdentity.has(name.toUpperCase()))),
  XDG_CONFIG_HOME: paths.configHome,
  XDG_STATE_HOME: paths.stateHome,
  HERDR_CONFIG_PATH: paths.configurationFile,
  HISTFILE: paths.shellHistoryFile,
});

export const createHerdrNativeEnvironment = (worker: Pick<WorkerPaths, "herdrDirectory">, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const environment = createHerdrEnvironment({
    configHome: path.join(worker.herdrDirectory, "c"), stateHome: path.join(worker.herdrDirectory, "s"),
    configurationFile: path.join(worker.herdrDirectory, "config.toml"), shellHistoryFile: path.join(worker.herdrDirectory, "shell.history"),
  }, inherited);
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const) {
    if (inherited[key] === undefined) delete environment[key];
    else environment[key] = inherited[key];
  }
  return environment;
};

export const createHerdrVersionObserver = (worker: Pick<WorkerPaths, "herdrDirectory" | "logsDirectory">) => ({
  observe: async (operation: Operation): Promise<string | null> => {
    const paths = resolveHerdrInstancePaths(worker);
    try {
      const pong = await createHerdrRpcClient(paths.apiEndpoint).request("ping", {}, operation);
      if (pong.type !== "pong" || typeof pong.version !== "string" || valid(pong.version) === null) throw new Error("The private Herdr instance returned an invalid version observation.");
      return pong.version;
    } catch (error) {
      // Only a failed connection establishes absence; malformed responses and permission failures remain errors.
      if (error instanceof Error && error.cause instanceof Error && absentConnection(error.cause)) return null;
      throw error;
    }
  },
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
    remainingBytes: (): number => { check(); return parent.remainingBytes(); },
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
const verifyConfiguration = async (paths: HerdrInstancePaths, expected = managedConfiguration, legacy: readonly string[] = []): Promise<boolean> => {
  const entry = await lstat(paths.configurationFile);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Private Herdr configuration ${paths.configurationFile} must be an ordinary file.`);
  const actual = await readFile(paths.configurationFile, "utf8");
  if (actual !== expected && !legacy.includes(actual)) throw new Error(`Private Herdr configuration ${paths.configurationFile} differs from the managed configuration; inspect it before starting the worker.`);
  return actual === expected;
};
const verifyManagedShell = async (file: string, expected: string, executable: boolean): Promise<void> => {
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || executable && (entry.mode & 0o111) === 0 || await readFile(file, "utf8") !== expected) throw new Error(`Private Herdr shell ${file} differs from the managed launcher; retain the original runtime and inspect its files.`);
};
const ensureManagedShell = async (file: string, expected: string, executable: boolean): Promise<void> => {
  try { await verifyManagedShell(file, expected, executable); }
  catch (error) {
    if (!missing(error)) throw error;
    await replaceFileAtomically(file, expected, executable ? 0o700 : 0o600);
  }
};
const ensureConfiguration = async (paths: HerdrInstancePaths, expected = managedConfiguration): Promise<void> => {
  await ordinaryDirectory(paths.privateDirectory);
  try { await verifyConfiguration(paths, expected); }
  catch (error) {
    if (!missing(error)) throw error;
    await replaceFileAtomically(paths.configurationFile, expected, 0o600);
  }
};
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const compatible = (pong: HerdrRpcResult): { version: string; protocol: 22 } => {
  if (pong.type !== "pong" || typeof pong.version !== "string" || valid(pong.version) === null || !gte(pong.version, "0.9.5") || pong.protocol !== 22 || !record(pong.capabilities)) {
    throw new Error("The private Herdr instance must provide version 0.9.5 or newer, protocol 22 and server capabilities.");
  }
  return { version: pong.version, protocol: 22 };
};

type OwnedChild = { child: ChildProcess; environment: NodeJS.ProcessEnv; closed: boolean; code: number | null; signal: NodeJS.Signals | null; error: Error | null };
const observeChild = (child: ChildProcess, environment: NodeJS.ProcessEnv): OwnedChild => {
  const owned: OwnedChild = { child, environment, closed: false, code: null, signal: null, error: null };
  child.once("error", (error) => { owned.error = error; });
  child.once("close", (code, signal) => { owned.closed = true; owned.code = code; owned.signal = signal; });
  return owned;
};
const liveOwnedChild = (owned: OwnedChild | null): owned is OwnedChild => owned !== null && !owned.closed && owned.error === null &&
  owned.child.pid !== undefined && owned.child.exitCode === null && owned.child.signalCode === null;

export const assertCodexIntegrationHome = (environment: NodeJS.ProcessEnv, root: string, platform: NodeJS.Platform = process.platform): void => {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const value = (name: string): string | undefined => {
    if (platform !== "win32") return environment[name];
    const key = Object.keys(environment).sort().find((key) => key.toUpperCase() === name);
    return key === undefined ? undefined : environment[key];
  };
  const parentTraversal = (directory: string): boolean => directory.split(platform === "win32" ? /[\\/]/ : /\//).includes("..");
  let directory = value("CODEX_HOME");
  if (directory === undefined || directory === "") {
    let home = value("HOME");
    if ((home === undefined || home === "") && platform === "win32") {
      home = value("USERPROFILE");
      if (home === undefined || home === "") {
        const drive = value("HOMEDRIVE");
        const suffix = value("HOMEPATH");
        if (drive !== undefined && /^[a-z]:[\\/]?$/i.test(drive) && suffix !== undefined && /^[\\/](?![\\/])/.test(suffix) && !parentTraversal(suffix)) {
          home = paths.resolve(drive, suffix);
        }
      }
    }
    if (home !== undefined && home !== "" && paths.isAbsolute(home) && !parentTraversal(home)) directory = paths.join(home, ".codex");
  }
  // Herdr uses its daemon environment, including HOME before USERPROFILE, rather than Node's OS home lookup.
  // https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/integration/env.rs#L91-L104
  // https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/integration/env.rs#L223-L244
  // Resolving '..' lexically can inspect a different directory when an earlier component is a symlink.
  if (directory === undefined || !paths.isAbsolute(directory) || /[\0\r\n]/.test(directory) || parentTraversal(directory) || paths.normalize(directory) !== paths.normalize(root)) {
    throw new Error("Cannot safely install the Codex integration: the daemon's native configuration directory does not match the inspected directory. Set an absolute CODEX_HOME and restart the worker with a newly started private daemon.");
  }
};
const killOwnedChild = (owned: OwnedChild): void => {
  if (owned.closed || owned.child.pid === undefined) return;
  terminateOwnedHerdrProcess(owned.child);
};

export const createHerdrInstance = (options: {
  paths: Pick<WorkerPaths, "herdrDirectory" | "logsDirectory">;
  executable?: string;
  toolLaunch?: ResolvedToolLaunch;
  environment?: NodeJS.ProcessEnv;
  spawnProcess?: HerdrSpawn;
  onDaemonSpawn?: (pid: number) => Promise<void>;
  retainOnStartupFailure?: boolean;
  isolatedRun?: boolean;
}) => {
  const paths = resolveHerdrInstancePaths(options.paths);
  if (options.toolLaunch !== undefined && (options.toolLaunch.tool !== "herdr" || options.toolLaunch.context !== "herdr")) throw new TypeError("A private Herdr instance requires a frozen Herdr launch.");
  const mappedShell = options.toolLaunch !== undefined && process.platform !== "win32";
  const shellFile = (options.isolatedRun && process.platform === "darwin" || mappedShell) ? path.join(paths.privateDirectory, "shell") : null;
  const shellRcFile = path.join(paths.privateDirectory, "shell.rc"), shellReadyDirectory = path.join(paths.privateDirectory, "shell-ready");
  const baseConfiguration = options.isolatedRun ? isolatedConfiguration : managedConfiguration;
  const legacyShellConfiguration = `${isolatedConfiguration}\n[terminal]\ndefault_shell = ${JSON.stringify(shellFile)}\nshell_mode = "non_login"\n`;
  const previousShellConfiguration = `${isolatedConfiguration}\n# Managed shell startup protocol: 1\n[terminal]\ndefault_shell = ${JSON.stringify(shellFile)}\nshell_mode = "non_login"\n`;
  const configuration = shellFile === null ? options.isolatedRun ? isolatedConfiguration : managedConfiguration
    : `${baseConfiguration}\n# Managed shell startup protocol: ${mappedShell ? 2 : 1}\n[terminal]\ndefault_shell = ${JSON.stringify(shellFile)}\nshell_mode = "non_login"\n`;
  const executable = options.executable === undefined ? "herdr" : options.executable;
  const command = (args: readonly string[]) => options.toolLaunch === undefined ? { file: executable, args: [...args] } : toolCommand(options.toolLaunch, args);
  const verifyLaunch = async (operation: Operation) => { if (options.toolLaunch !== undefined) await verifyToolLaunch(options.toolLaunch, operation); };
  if (executable.trim() === "" || /[\r\n\0]/.test(executable)) throw new Error("The Herdr executable must be nonempty without line breaks or NUL.");
  const environment = createHerdrEnvironment(paths, options.environment === undefined ? process.env : options.environment);
  const attachmentEnvironment: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: paths.configHome, XDG_STATE_HOME: paths.stateHome, HERDR_CONFIG_PATH: paths.configurationFile, HISTFILE: paths.shellHistoryFile };
  for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_SQLITE_HOME", "COPILOT_HOME"]) {
    if (environment[key] !== undefined) attachmentEnvironment[key] = environment[key];
  }
  const start = options.spawnProcess === undefined ? spawnHerdrProcess : options.spawnProcess;
  const rpc = createHerdrRpcClient(paths.apiEndpoint);
  let owned: OwnedChild | null = null;
  let starting: Promise<HerdrInstanceReady> | null = null;
  let managedShellReady = false;
  let mappingRuntime = { nodeExecutable: process.execPath, childEntry: fileURLToPath(new URL("./tool-launch-child.js", import.meta.url)) };
  const loadMappingRuntime = async (create: boolean): Promise<void> => {
    const file = path.join(paths.privateDirectory, "shell-tool-runtime.json");
    let value = await optionalOwnedJson(file);
    if (value === null && create) { try { await publishOwnedJson(file, mappingRuntime); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; } value = await optionalOwnedJson(file); }
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "childEntry,nodeExecutable") throw new Error("The original controlled Herdr shell runtime metadata is missing or invalid.");
    const row = value as { nodeExecutable: string; childEntry: string };
    if (![row.nodeExecutable, row.childEntry].every(item => typeof item === "string" && path.isAbsolute(item) && !/[\0\r\n]/.test(item))) throw new Error("The original controlled Herdr shell runtime paths must be absolute data.");
    mappingRuntime = { ...row };
  };
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
  const verifyExistingConfiguration = async (): Promise<void> => {
    const current = await verifyConfiguration(paths, configuration, shellFile === null ? [] : [baseConfiguration, isolatedConfiguration, legacyShellConfiguration, previousShellConfiguration]);
    if (shellFile !== null) {
      if (current) {
        if (mappedShell) await loadMappingRuntime(false);
        await verifyManagedShell(shellFile, managedShell(shellRcFile), true);
        await verifyManagedShell(shellRcFile, managedShellRc(shellReadyDirectory, mappedShell, mappingRuntime), false);
        const directory = await lstat(shellReadyDirectory);
        if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) throw new Error("The private Herdr shell readiness directory must be an ordinary owner-only directory.");
      } else {
        const existing = await readFile(paths.configurationFile, "utf8");
        if (existing === legacyShellConfiguration) await verifyManagedShell(shellFile, legacyManagedShell, true);
        if (existing === previousShellConfiguration) { await verifyManagedShell(shellFile, managedShell(shellRcFile), true); await verifyManagedShell(shellRcFile, managedShellRc(shellReadyDirectory), false); }
      }
    }
    managedShellReady = current && shellFile !== null;
  };
  const version = async (operation: Operation): Promise<void> => {
    await verifyLaunch(operation);
    const result = await runHerdrCommand({ ...command(["--version"]), environment }, operation, start);
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
        const before = await endpoints(scope);
        if (before.api && before.client) {
          // Existing runs retain their shell and startup policy across a Worker upgrade.
          const observed = await ready(scope);
          await verifyExistingConfiguration();
          return { ...observed, reconnected: true };
        }
        if (before.api || before.client) throw new Error("The private Herdr instance has only one reachable endpoint; its startup or shutdown remains unconfirmed.");
        if (owned !== null && !owned.closed) throw new Error("The owned private Herdr process is still running without both endpoints; its shutdown remains unconfirmed.");
        await ensureConfiguration(paths, configuration);
        if (shellFile !== null) {
          await ordinaryDirectory(shellReadyDirectory);
          if (mappedShell) await loadMappingRuntime(true);
          await ensureManagedShell(shellRcFile, managedShellRc(shellReadyDirectory, mappedShell, mappingRuntime), false);
          await ensureManagedShell(shellFile, managedShell(shellRcFile), true);
        }
        await verifyExistingConfiguration();
        await version(scope);
        await ordinaryDirectory(path.dirname(paths.stdoutLogFile));
        const stdout = openSync(paths.stdoutLogFile, "a", 0o600);
        let stderr: number | undefined;
        try {
          stderr = openSync(paths.stderrLogFile, "a", 0o600);
          const spawnEnvironment = Object.freeze({ ...environment });
          await verifyLaunch(scope);
          const launch = command(["--session", session, "server"]);
          owned = observeChild(start(launch.file, launch.args, { env: spawnEnvironment, detached: true, windowsHide: true, shell: false, stdio: ["ignore", stdout, stderr] }), spawnEnvironment);
          startedHere = owned;
          if (options.onDaemonSpawn) {
            await once(owned.child, "spawn");
            if (owned.child.pid === undefined) throw new Error("The original Herdr child did not report its process identity.");
            await options.onDaemonSpawn(owned.child.pid);
          }
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
        // Retained resources remain journal-owned without keeping the failed Worker alive.
        if (options.retainOnStartupFailure) startedHere?.child.unref();
        if (startedHere !== null && !startedHere.closed && !options.retainOnStartupFailure) {
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
    toolMappingRuntime: () => ({ ...mappingRuntime }),
    createShellStartup: (): { nonce: string; executable: string; isReady(pid: number): Promise<boolean> } | undefined => {
      if (!managedShellReady) return undefined;
      const nonce = randomUUID();
      return { nonce, executable: "/bin/bash", isReady: async pid => {
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("A shell readiness observation requires a positive PID.");
        let handle;
        try { handle = await open(path.join(shellReadyDirectory, `${nonce}.${pid}`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (error) { if (missing(error)) return false; throw error; }
        try {
          const entry = await handle.stat();
          if (!entry.isFile() || entry.size > 128 || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.()) throw new Error("The private shell readiness marker must be a bounded owner-only ordinary file.");
          const buffer = Buffer.alloc(129), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          return buffer.subarray(0, bytesRead).toString("utf8") === `${nonce}\n${pid}\n`;
        } finally { await handle.close(); }
      } };
    },
    attachment: { executable: command([]).file, arguments: command(["--session", session]).args, environment: attachmentEnvironment, unsetEnvironment: [...inheritedIdentity] } satisfies HerdrAttachment,
    ensure,
    assertIntegrationEnvironment: (root: string): void => {
      if (!liveOwnedChild(owned)) throw new Error("Cannot safely install the Codex integration: the private daemon is not a live process started by this worker. Stop the worker and its private daemon, then restart the worker before repairing the integration.");
      assertCodexIntegrationHome(owned.environment, root);
    },
    connect: async (operation: Operation): Promise<HerdrInstanceReady> => {
      const scope = bounded(operation, 30_000);
      try {
        try { await verifyExistingConfiguration(); }
        catch (cause) {
          if (missing(cause)) throw new Error("The worker Herdr session is not running. Start it with daynight worker run.", { cause });
          throw cause;
        }
        const existing = await endpoints(scope);
        if (!existing.api && !existing.client) throw new Error("The worker Herdr session is not running. Start it with daynight worker run.");
        if (!existing.api || !existing.client) throw new Error("The private Herdr instance has only one reachable endpoint; its startup or shutdown remains unconfirmed.");
        return { ...await ready(scope), reconnected: true };
      } finally { scope.dispose(); }
    },
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
