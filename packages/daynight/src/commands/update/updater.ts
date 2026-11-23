import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import readCmdShim from "read-cmd-shim";
import { SemVer, compare } from "semver";

const packageName = "@codetreker/daynight";
const recovery = "Use the original package manager, or install globally with npm install --global @codetreker/daynight@latest.";
const unsupported = (): Error => new Error(`Self-update requires the current npm global installation and its daynight launcher. ${recovery}`);

export type UpdateResult = {
  status: "current" | "ahead" | "updated";
  previousVersion: string;
  targetVersion: string;
};

export type UpdateCommand = {
  executable: string;
  arguments: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  output: "capture" | "inherit";
  cleanupProcessGroup?: boolean;
};

type UpdateOperations = {
  readFile: (filename: string) => Promise<string>;
  realpath: (filename: string) => Promise<string>;
  readCmdShim: (filename: string) => Promise<string>;
  run: (command: UpdateCommand) => Promise<string>;
};

export type UpdateOptions = {
  packageDirectory: string;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
  workingDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  operations?: UpdateOperations;
};

// The anchor is evaluated from memory because npm may replace this installation while
// the updater is running. Its stdout is a private pipe to the parent in capture mode:
// the command inherits that pipe directly so its EOF also accounts for descendants.
const posixAnchor = String.raw`
const { spawn } = require("node:child_process");
const { closeSync } = require("node:fs");
let started = false;
let cleaning = false;
let finished = false;
function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (!process.connected) { process.kill(0, "SIGKILL"); return; }
  process.send({ type: "cleaning" }, () => {
    try { process.kill(0, "SIGKILL"); }
    catch (error) {
      if (process.connected) process.send({ type: "cleanup-error", message: String(error) }, () => process.exit(1));
      else process.exit(1);
    }
  });
}
process.on("message", (message) => {
  if (message.type === "start" && !started) {
    started = true;
    const child = spawn(message.executable, message.arguments, {
      cwd: message.cwd, env: message.environment, stdio: ["inherit", "inherit", "inherit"],
    });
    // Only the command and its descendants retain the capture pipe's write end.
    try { closeSync(1); } catch {}
    let spawnError;
    child.once("error", (error) => { spawnError = { message: error.message, code: error.code, errno: error.errno, syscall: error.syscall, path: error.path, spawnargs: error.spawnargs }; });
    child.once("close", (code, signal) => {
      if (process.connected) process.send({ type: "outcome", code, signal, spawnError });
    });
  } else if (message.type === "cleanup") cleanup();
  else if (message.type === "finish") {
    finished = true;
    if (process.connected) process.send({ type: "finished" }, () => process.disconnect());
  }
});
process.on("disconnect", () => { if (!cleaning && !finished) cleanup(); });
`;

type AnchorOutcome = {
  type: "outcome";
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: { message: string; code?: string; errno?: number; syscall?: string; path?: string; spawnargs?: string[] };
};

const runPosixUpdateCommand = (command: UpdateCommand): Promise<string> => new Promise((resolve, reject) => {
  // NODE_OPTIONS can load arbitrary caller preloads; only the actual command should
  // receive them, not the additional Node process used as the anchor.
  const anchorEnvironment = { ...process.env };
  delete anchorEnvironment.NODE_OPTIONS;
  const anchor = spawn(process.execPath, ["--eval", posixAnchor], {
    cwd: command.cwd, env: anchorEnvironment, detached: true,
    stdio: ["inherit", command.output === "capture" ? "pipe" : "inherit", "inherit", "ipc"],
  });
  let output = "";
  let failure: Error | undefined;
  let outcomeFailure: Error | undefined;
  let outcomeReceived = false;
  let cleaning = false;
  let cleaningAcknowledged = false;
  let finishRequested = false;
  let finishAcknowledged = false;
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let closed = false;
  let outputEnded = command.output !== "capture";
  let streamFailure: Error | undefined;
  let settled = false;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let observationTimer: NodeJS.Timeout | undefined;

  const complete = (error?: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(commandTimer);
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    if (observationTimer !== undefined) clearTimeout(observationTimer);
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    if (error !== undefined) {
      // A missed deadline must not leave the caller waiting on IPC or inherited pipes.
      if (anchor.connected) anchor.disconnect();
      anchor.stdout?.destroy();
      anchor.unref();
      reject(error);
    } else resolve(output);
  };
  const unconfirmed = (detail: string, cause?: unknown): void => {
    const original = failure ?? outcomeFailure ?? (cause instanceof Error ? cause : undefined);
    complete(new Error(`Update command cleanup-unconfirmed: ${detail}`, original === undefined ? undefined : { cause: original }));
  };
  const observe = (): void => {
    if (settled || !cleaning || !exited || !closed) return;
    if (streamFailure !== undefined) { unconfirmed(`captured output failed: ${streamFailure.message}`, streamFailure); return; }
    if (!outputEnded) return;
    if (observationTimer !== undefined) { clearTimeout(observationTimer); observationTimer = undefined; }
    if (!cleaningAcknowledged) { unconfirmed("anchor cleanup acknowledgement was lost."); return; }
    if (exitSignal !== "SIGKILL") { unconfirmed("anchor did not exit from its group cleanup signal."); return; }
    try {
      // Signal zero only observes the group: it never targets a reused PGID with
      // a destructive signal. ESRCH is accepted only after EOF and anchor close.
      process.kill(-anchor.pid!, 0);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") {
        complete(failure ?? outcomeFailure); return;
      } else { unconfirmed(`process group observation failed: ${String(cause)}`, cause); return; }
    }
    observationTimer = setTimeout(observe, 20);
  };
  const beginCleanup = (): void => {
    if (cleaning || settled) return;
    cleaning = true;
    clearTimeout(commandTimer);
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => { unconfirmed("cleanup did not finish within 10 seconds."); }, 10_000);
    if (!anchor.connected || anchor.pid === undefined) { unconfirmed("anchor IPC is unavailable."); return; }
    anchor.send({ type: "cleanup" }, (error) => {
      if (error !== null) unconfirmed(`cannot request anchor cleanup: ${error.message}`, error);
    });
  };
  const finishNormally = (): void => {
    if (settled || cleaning || finishRequested || !outcomeReceived || !outputEnded) return;
    if (!anchor.connected) { unconfirmed("anchor IPC was lost before completion."); return; }
    finishRequested = true;
    clearTimeout(commandTimer);
    cleanupTimer = setTimeout(() => { unconfirmed("anchor release did not finish within 10 seconds."); }, 10_000);
    anchor.send({ type: "finish" }, (error) => {
      if (error !== null) unconfirmed(`cannot release anchor: ${error.message}`, error);
    });
  };
  const interrupt = (signal: NodeJS.Signals): void => {
    if (failure === undefined) failure = new Error(`The update command was interrupted by ${signal}.`);
    beginCleanup();
  };
  const onInt = (): void => { interrupt("SIGINT"); };
  const onTerm = (): void => { interrupt("SIGTERM"); };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  anchor.stdout?.setEncoding("utf8");
  anchor.stdout?.on("data", (chunk: string) => {
    if (failure !== undefined) return;
    output += chunk;
    if (Buffer.byteLength(output, "utf8") > 64 * 1024) {
      failure = new Error("npm returned more than 64 KiB while checking the update version.");
      beginCleanup();
    }
  });
  anchor.stdout?.once("end", () => { outputEnded = true; if (cleaning) observe(); else finishNormally(); });
  anchor.stdout?.once("error", (error) => { streamFailure = error; if (failure === undefined) failure = outcomeFailure ?? error; beginCleanup(); });
  anchor.on("message", (message: AnchorOutcome | { type: "cleaning" } | { type: "finished" } | { type: "cleanup-error"; message: string }) => {
    if (message.type === "cleaning") { cleaningAcknowledged = true; return; }
    if (message.type === "finished") { finishAcknowledged = true; return; }
    if (message.type === "cleanup-error") { unconfirmed(`anchor could not signal its group: ${message.message}`); return; }
    if (message.type !== "outcome" || outcomeReceived) return;
    outcomeReceived = true;
    if (message.spawnError !== undefined) {
      outcomeFailure = Object.assign(new Error(message.spawnError.message), message.spawnError);
    } else if (message.signal !== null) {
      outcomeFailure = new Error(`The update command was terminated by ${message.signal}.`);
    } else if (message.code !== 0) {
      outcomeFailure = new Error(`The update command exited with code ${String(message.code)}.`);
    }
    if (command.cleanupProcessGroup === true) beginCleanup();
    else finishNormally();
  });
  anchor.once("error", (error) => {
    if (anchor.pid === undefined) complete(error);
    else { if (failure === undefined) failure = error; unconfirmed("anchor IPC or process failed.", error); }
  });
  anchor.once("disconnect", () => {
    if (settled) return;
    if (cleaning && !cleaningAcknowledged || !cleaning && !finishAcknowledged) unconfirmed("anchor IPC was lost.");
  });
  anchor.once("exit", (code, signal) => { exitCode = code; exitSignal = signal; exited = true; if (cleaning) observe(); });
  anchor.once("close", () => {
    closed = true;
    if (cleaning) observe();
    else if (!outcomeReceived || !finishAcknowledged || exitCode !== 0 || exitSignal !== null) unconfirmed("anchor exited without a complete IPC exchange.");
    else complete(failure ?? outcomeFailure);
  });
  const commandTimer = setTimeout(() => {
    if (failure === undefined) failure = new Error(`The update command timed out after ${command.timeoutMs / 1_000} seconds.`);
    beginCleanup();
  }, command.timeoutMs);
  anchor.send({ type: "start", executable: command.executable, arguments: command.arguments, cwd: command.cwd, environment: command.environment }, (error) => {
    if (error !== null) { if (failure === undefined) failure = error; unconfirmed("cannot start command through anchor IPC.", error); }
  });
});

/** Supervises commands; POSIX group cleanup either confirms completion or reports it unconfirmed. */
export const runUpdateCommand = async (command: UpdateCommand): Promise<string> => {
  if (process.platform !== "win32") return runPosixUpdateCommand(command);
  let taskkill: string | undefined;
  if (process.platform === "win32") {
    const systemRoot = Object.entries(command.environment).find(([name]) => name.toLowerCase() === "systemroot")?.[1];
    if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) throw new Error("Cannot supervise the update command: SystemRoot must name the Windows installation directory.");
    taskkill = path.win32.join(systemRoot, "System32", "taskkill.exe");
    try { if (!(await stat(taskkill)).isFile()) throw new Error("taskkill.exe is not a file."); }
    catch (cause) { throw new Error("Cannot supervise the update command because Windows taskkill.exe is unavailable.", { cause }); }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.arguments, {
      cwd: command.cwd,
      env: command.environment,
      windowsHide: true,
      // Detached Windows processes cannot write to inherited console handles.
      detached: process.platform !== "win32",
      stdio: ["inherit", command.output === "capture" ? "pipe" : "inherit", "inherit"],
    });
    let output = "";
    let failure: Error | undefined;
    let termination: Promise<void> | undefined;
    const terminate = (): void => {
      if (child.pid === undefined || termination !== undefined) return;
      if (process.platform === "win32") {
        termination = new Promise((done) => {
          const terminator = spawn(taskkill!, ["/PID", String(child.pid!), "/T", "/F"], { windowsHide: true, stdio: "inherit", timeout: 10_000, killSignal: "SIGKILL" });
          terminator.once("error", (cause) => { failure = new Error(`Cannot terminate the npm process tree: ${cause.message}`, { cause: failure === undefined ? cause : failure }); child.kill("SIGKILL"); });
          terminator.once("close", (code) => {
            if (code !== 0) {
              failure = new Error(`Cannot confirm termination of the npm process tree: taskkill exited with ${String(code)}.`, { cause: failure });
              child.kill("SIGKILL");
            }
            done();
          });
        });
        return;
      }
      const signal = (value: NodeJS.Signals): void => {
        try { process.kill(-child.pid!, value); }
        catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) failure = new Error(`Cannot terminate the npm process group: ${String(cause)}`, { cause: failure === undefined ? cause : failure });
        }
      };
      signal("SIGKILL");
      termination = Promise.resolve();
    };
    const interrupt = (signal: NodeJS.Signals): void => {
      if (failure === undefined) failure = new Error(`The update command was interrupted by ${signal}.`);
      terminate();
    };
    const interruptByInt = (): void => { interrupt("SIGINT"); };
    const interruptByTerm = (): void => { interrupt("SIGTERM"); };
    process.on("SIGINT", interruptByInt);
    process.on("SIGTERM", interruptByTerm);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (failure !== undefined) return;
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > 64 * 1024) {
        failure = new Error("npm returned more than 64 KiB while checking the update version.");
        terminate();
      }
    });
    const timer = setTimeout(() => {
      if (failure === undefined) failure = new Error(`The update command timed out after ${command.timeoutMs / 1_000} seconds.`);
      terminate();
    }, command.timeoutMs);
    child.once("error", (cause) => { if (failure === undefined) failure = cause; });
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      if (command.cleanupProcessGroup === true && process.platform !== "win32") terminate();
      if (termination !== undefined) await termination;
      process.removeListener("SIGINT", interruptByInt);
      process.removeListener("SIGTERM", interruptByTerm);
      if (failure !== undefined) reject(failure);
      else if (signal !== null) reject(new Error(`The update command was terminated by ${signal}.`));
      else if (code !== 0) reject(new Error(`The update command exited with code ${String(code)}.`));
      else resolve(output);
    });
  });
};

const defaultOperations: UpdateOperations = {
  readFile: (filename) => readFile(filename, "utf8"),
  realpath,
  readCmdShim,
  run: runUpdateCommand,
};

const parseVersion = (value: unknown, subject: string): string => {
  if (typeof value !== "string") throw new Error(`${subject} must be a canonical semantic version.`);
  let parsed: SemVer;
  try { parsed = new SemVer(value); }
  catch (cause) { throw new Error(`${subject} must be a canonical semantic version.`, { cause }); }
  const canonical = `${parsed.version}${parsed.build.length === 0 ? "" : `+${parsed.build.join(".")}`}`;
  if (value !== canonical) throw new Error(`${subject} must be a canonical semantic version.`);
  return value;
};

const isMissing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && (cause.code === "ENOENT" || cause.code === "ENOTDIR");

/** Updates the owning npm global installation and refreshes its existing skills without opening review state. */
export const updateSelf = async (options: UpdateOptions): Promise<UpdateResult> => {
  const operations = options.operations === undefined ? defaultOperations : options.operations;
  const platform = options.platform === undefined ? process.platform : options.platform;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const environment = options.environment === undefined ? process.env : options.environment;
  const nodeExecutable = options.nodeExecutable === undefined ? process.execPath : options.nodeExecutable;
  const packageDirectory = await operations.realpath(options.packageDirectory);
  const samePath = (left: string, right: string): boolean => paths.relative(left, right) === "";
  const contains = (parent: string, child: string): boolean => {
    const relative = paths.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${paths.sep}`) && relative !== ".." && !paths.isAbsolute(relative));
  };
  const manifestAt = async (directory: string): Promise<Record<string, unknown>> => {
    const manifest: unknown = JSON.parse(await operations.readFile(paths.join(directory, "package.json")));
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) throw new Error(`Invalid package manifest in ${directory}.`);
    return manifest as Record<string, unknown>;
  };
  const initialManifest = await manifestAt(packageDirectory);
  const validManifest = (manifest: Record<string, unknown>): boolean => manifest.name === packageName && manifest.private !== true &&
    typeof manifest.bin === "object" && manifest.bin !== null && "daynight" in manifest.bin && manifest.bin.daynight === "dist/main.js";
  if (!validManifest(initialManifest)) throw unsupported();
  const previousVersion = parseVersion(initialManifest.version, "The installed package version");
  const prefix = platform === "win32" ? paths.resolve(packageDirectory, "../../..") : paths.resolve(packageDirectory, "../../../..");
  const expectedRoot = platform === "win32" ? paths.join(prefix, "node_modules", packageName) : paths.join(prefix, "lib", "node_modules", packageName);
  if (!samePath(packageDirectory, expectedRoot)) throw unsupported();
  const main = paths.join(packageDirectory, "dist", "main.js");
  const launcher = platform === "win32" ? paths.join(prefix, "daynight.cmd") : paths.join(prefix, "bin", "daynight");
  const verifyLauncher = async (): Promise<void> => {
    try {
      const target = platform === "win32" ? paths.resolve(paths.dirname(launcher), await operations.readCmdShim(launcher)) : launcher;
      if (!samePath(await operations.realpath(target), main) || !samePath(await operations.realpath(main), main)) throw unsupported();
    } catch (cause) {
      if (isMissing(cause) || cause instanceof Error && "code" in cause && cause.code === "ENOTASHIM") throw new Error(unsupported().message, { cause });
      throw cause;
    }
  };
  await verifyLauncher();
  const nodeDirectory = paths.dirname(await operations.realpath(nodeExecutable));
  const npmCandidates = [paths.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"), paths.resolve(nodeDirectory, "../lib/node_modules/npm/bin/npm-cli.js")];
  const executableName = platform === "win32" ? "npm.cmd" : "npm";
  const pathEntry = Object.entries(environment).find(([name]) => platform === "win32" ? name.toLowerCase() === "path" : name === "PATH");
  if (pathEntry !== undefined && pathEntry[1] !== undefined) for (const directory of pathEntry[1].split(paths.delimiter)) {
    if (directory !== "") npmCandidates.push(paths.join(directory, executableName));
  }
  let npmCli: string | undefined;
  for (const candidate of npmCandidates) {
    try {
      const target = platform === "win32" && candidate.endsWith(".cmd") ? paths.resolve(paths.dirname(candidate), await operations.readCmdShim(candidate)) : candidate;
      const resolved = await operations.realpath(target);
      if (paths.basename(resolved) !== "npm-cli.js" || contains(packageDirectory, resolved)) continue;
      const manifest = await manifestAt(paths.resolve(resolved, "../.."));
      if (manifest.name === "npm") { npmCli = resolved; break; }
    } catch (cause) {
      if (isMissing(cause) || cause instanceof Error && "code" in cause && cause.code === "ENOTASHIM") continue;
      throw cause;
    }
  }
  if (npmCli === undefined) throw new Error(`Cannot locate npm's JavaScript CLI for the current Node.js installation. ${recovery}`);
  const execute = (argumentsValue: string[], output: "capture" | "inherit", timeoutMs: number): Promise<string> => operations.run({
    executable: nodeExecutable, arguments: [npmCli, ...argumentsValue], cwd: prefix, environment, timeoutMs, output,
  });
  const metadata = await execute(["view", `${packageName}@latest`, "version", "--json", "--global", "--prefix", prefix, "--prefer-online"], "capture", 60_000);
  let latest: unknown;
  try { latest = JSON.parse(metadata); }
  catch (cause) { throw new Error("npm returned invalid JSON for the latest package version.", { cause }); }
  const targetVersion = parseVersion(Array.isArray(latest) && latest.length === 1 ? latest[0] : latest, "The latest npm package version");
  const order = compare(previousVersion, targetVersion);
  const workingDirectory = await operations.realpath(options.workingDirectory === undefined ? process.cwd() : options.workingDirectory);
  const refresh = async (status: UpdateResult["status"]): Promise<UpdateResult> => {
    try {
      await operations.run({
        executable: nodeExecutable, arguments: [paths.join(packageDirectory, "dist", "commands", "skill", "refresh-installed.js")],
        cwd: workingDirectory, environment, timeoutMs: 60_000, output: "inherit", cleanupProcessGroup: true,
      });
    } catch (cause) {
      const outcome = status === "updated" ? `The daynight package was updated from ${previousVersion} to ${targetVersion}` : `The daynight package remains at ${previousVersion}`;
      throw new Error(`${outcome}, but refreshing installed using-daynight skills failed. Resolve the reported error and run daynight update again.`, { cause });
    }
    return { status, previousVersion, targetVersion };
  };
  if (order >= 0) return refresh(order === 0 ? "current" : "ahead");
  if (contains(packageDirectory, workingDirectory)) throw new Error("Run daynight update from a directory outside its installation so npm can replace the package.");
  await execute(["install", `${packageName}@${targetVersion}`, "--global", "--prefix", prefix, "--engine-strict", "--force=false", "--no-audit", "--no-fund"], "inherit", 10 * 60_000);
  const installedManifest = await manifestAt(packageDirectory);
  if (!validManifest(installedManifest) || parseVersion(installedManifest.version, "The updated package version") !== targetVersion) {
    throw new Error(`npm completed, but the installed package does not match ${packageName}@${targetVersion}.`);
  }
  await verifyLauncher();
  const installedVersion = (await operations.run({ executable: nodeExecutable, arguments: [main, "--version"], cwd: prefix, environment, timeoutMs: 30_000, output: "capture" })).trim();
  if (installedVersion !== targetVersion) throw new Error(`The updated executable returned version ${JSON.stringify(installedVersion)}; expected ${targetVersion}.`);
  return refresh("updated");
};
