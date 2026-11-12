import { performance } from "node:perf_hooks";
import type { Operation } from "../../../src/api/operation.js";
import type { HerdrCommand, HerdrSpawn } from "../../../src/commands/worker/herdr/command.js";
type Stage = "external-script" | "processes" | "console";
export type WindowsQueryObservation = { stage: Stage; elapsedMs: number; code: number | string | null; killed: boolean | null; signal: string | null; stdoutBytes: number; stderrBytes: number; closed: boolean; cleanupConfirmed: boolean; errorType: string | null };
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
 * OS observation, using the original environment and ten-second request limit.
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
