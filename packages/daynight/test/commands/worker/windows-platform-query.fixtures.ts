import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Operation } from "../../../src/api/operation.js";
import type { HerdrCommand, HerdrSpawn } from "../../../src/commands/worker/herdr/command.js";
type Stage = "external-script" | "processes" | "console";
export type WindowsQueryObservation = { stage: Stage; elapsedMs: number; code: number | string | null; killed: boolean | null; signal: string | null; stdoutBytes: number; stderrBytes: number; closed: boolean; cleanupConfirmed: boolean; errorType: string | null };
/** Observer execution belongs to the test harness. Native/daemon environments
 * remain inputs under test; provider and agent configuration is never copied.
 */
export const prepareWindowsObserverEnvironment = async (root: string, harness: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> => {
  const entries = Object.entries(harness), environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "SystemDrive", "ComSpec", "WINDIR", "OS", "PATH", "PATHEXT", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432"]) {
    const value = entries.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (value !== undefined) environment[name] = value;
  }
  if (!environment.SystemRoot || !path.win32.isAbsolute(environment.SystemRoot)) throw new Error("The Windows observer requires the harness's absolute SystemRoot.");
  if (!path.isAbsolute(root)) throw new Error("The Windows observer requires an absolute task directory.");
  const directory = path.join(root, "observer"), home = path.join(directory, "home"), appData = path.join(home, "AppData"), roaming = path.join(appData, "Roaming"), local = path.join(appData, "Local"), temporary = path.join(directory, "tmp");
  for (const target of [directory, home, appData, roaming, local, temporary]) {
    try { await mkdir(target, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("The Windows observer requires ordinary task-owned directories.");
  }
  // Only the selected system PS5's built-in modules may supply these queries.
  // https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-5.1
  return { ...environment, HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local, TEMP: temporary, TMP: temporary,
    PSModulePath: path.win32.join(environment.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") };
};
export const decodeWindowsPlatformJson = (stage: Stage, stdout: string, observations: WindowsQueryObservation[]): unknown => {
  try { return JSON.parse(stdout); }
  catch {
    const observation = observations.at(-1);
    if (observation?.stage === stage) observation.errorType = "InvalidJson";
    throw new Error(`The independent Windows ${stage} query did not produce complete JSON (stdoutBytes=${Buffer.byteLength(stdout)}).`);
  }
};
/** Fixed UTF-8 fields avoid JSON modules and console-code-page substitution. */
export const windowsExternalScriptQuery = (source: string): string => "$ErrorActionPreference='Stop'; $c=Get-Command -CommandType ExternalScript -Name '" + source.replaceAll("'", "''") + "' -ErrorAction Stop; $text=[string]::Join(\"`n\",[string[]]@($PSVersionTable.PSVersion.ToString(),$c.CommandType.ToString(),$c.Source)); [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)))";
export const decodeWindowsExternalScript = (stdout: string, observations: WindowsQueryObservation[] = []): { version: string; type: string; source: string } => {
  try {
    const envelope = stdout.trim(), bytes = Buffer.from(envelope, "base64");
    if (!envelope || bytes.toString("base64") !== envelope) throw new Error("Invalid Base64 envelope.");
    const fields = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n");
    if (fields.length !== 3 || fields.some(field => field.length === 0 || /[\0\r]/.test(field))) throw new Error("Incomplete ExternalScript fields.");
    return { version: fields[0]!, type: fields[1]!, source: fields[2]! };
  } catch {
    const observation = observations.at(-1);
    if (observation?.stage === "external-script") observation.errorType = "InvalidExternalScript";
    throw new Error(`The independent ExternalScript proof is incomplete (stdoutBytes=${Buffer.byteLength(stdout)}).`);
  }
};

/** Only transport is shared with production. Each script remains an independent
 * OS observation, using its caller's explicit environment and the original
 * ten-second request limit.
 */
export const runWindowsPlatformQuery = async (stage: Stage, input: HerdrCommand, operation: Operation, observations: WindowsQueryObservation[]): Promise<string> => {
  const command = await import(new URL("../../../dist/commands/worker/herdr/command.js", import.meta.url).href) as typeof import("../../../src/commands/worker/herdr/command.js");
  const observation: WindowsQueryObservation = { stage, elapsedMs: 0, code: null, killed: null, signal: null, stdoutBytes: 0, stderrBytes: 0, closed: false, cleanupConfirmed: false, errorType: null };
  const started = performance.now();
  const start: HerdrSpawn = (file, args, options) => {
    const child = command.spawnHerdrProcess(file, args, { ...options, ...(process.platform === "win32" ? { detached: false } : {}) });
    child.stdout?.on("data", (value: Buffer) => { observation.stdoutBytes += value.length; });
    child.stderr?.on("data", (value: Buffer) => { observation.stderrBytes += value.length; });
    child.once("close", (code, signal) => { observation.closed = true; if (typeof observation.code !== "string") observation.code = code; observation.signal = signal; observation.killed = child.killed; });
    child.once("error", error => { const code = (error as NodeJS.ErrnoException).code; if (typeof code === "string" && /^E[A-Z0-9_]{1,63}$/.test(code)) observation.code = code; });
    return child;
  };
  try {
    const result = await command.runHerdrCommand(input, operation, start);
    observation.cleanupConfirmed = observation.closed;
    if (!observation.closed) throw new Error("The independent Windows query close is unconfirmed.");
    observation.elapsedMs = Math.round(performance.now() - started);
    return result.stdout;
  } catch (error) {
    observation.cleanupConfirmed = observation.closed && !command.hasUnconfirmedHerdrCommandCleanup(error);
    observation.errorType = error instanceof command.HerdrCommandCleanupError ? "HerdrCommandCleanupError" : error instanceof command.HerdrCommandDeadlineError ? "HerdrCommandDeadlineError" : error instanceof command.HerdrCommandError ? "HerdrCommandError" : error instanceof RangeError ? "RangeError" : "Error";
    observation.elapsedMs = Math.round(performance.now() - started);
    // Error causes may include EncodedCommand and output. Keep only the bounded
    // observation, and preserve cleanup uncertainty in the caller's evidence.
    throw new Error(`The independent Windows ${stage} query failed: ${JSON.stringify(observation)}.`);
  } finally { observations.push(observation); }
};
