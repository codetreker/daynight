import { execFile } from "node:child_process";
import path from "node:path";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import type { HerdrCommand } from "../../../src/commands/worker/herdr/command.js";

export const preparationProbeMarker = "DAYNIGHT_FIXED_METADATA_MARKER";
type Mode = "metadata" | "execFile";
type Execution = { stdout: string; stderr: string; closed: boolean; errorType?: string | undefined; outputCaptured?: boolean };
type ProbeResult = { mode: Mode; probe: "marker" | "inventory"; elapsedMs: number; stdoutBytes: number | null; stderrBytes: number | null; closed: boolean; errorType?: string | undefined; markerMatches?: boolean | undefined; jsonRows: number | null; current: { pid: number; parentPid: number } | null };
export type PreparationProbeExecutor = (mode: Mode, command: HerdrCommand, operation: Operation) => Promise<Execution>;

/** Historical cmdlet comparison only; production metadata uses Win32 APIs. */
export const historicalWindowsInventoryCommand = (environment: NodeJS.ProcessEnv): HerdrCommand => {
  const root = environment.SystemRoot ?? environment.SYSTEMROOT;
  if (root === undefined || !path.win32.isAbsolute(root)) throw new Error("SystemRoot is required for the historical PS5 probe.");
  return {
    file: path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; [Console]::Out.Write((ConvertTo-Json -InputObject @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId -ErrorAction Stop | Select-Object ProcessId,ParentProcessId) -Compress))"],
    environment: Object.fromEntries(Object.entries(environment).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH")),
  };
};

/** Keep the former command-runner contrast in the fixture, including its
 * non-detached child and existing production cleanup/deadline mechanism.
 */
export const executeHistoricalMetadataProbe: PreparationProbeExecutor = async (_mode, input, active) => {
  const command = await import(new URL("../../../dist/commands/worker/herdr/command.js", import.meta.url).href) as typeof import("../../../src/commands/worker/herdr/command.js");
  try {
    return { ...await command.runHerdrCommand(input, active, (file, args, options) => command.spawnHerdrProcess(file, args, { ...options, detached: false })), closed: true };
  } catch (error) {
    return { stdout: "", stderr: "", closed: !command.hasUnconfirmedHerdrCommandCleanup(error), outputCaptured: false, errorType: error instanceof Error ? error.name : "unknown" };
  }
};

export const runPreparationProbeSequence = async (commands: Record<"marker" | "inventory", HerdrCommand>, execute: PreparationProbeExecutor, cancelled = () => false) => {
  const results: ProbeResult[] = [];
  for (const mode of ["metadata", "execFile"] as const) for (const probe of ["marker", "inventory"] as const) {
    if (cancelled()) return results;
    const operation = createOperation({ limits: { totalMs: 4000, requestMs: 2000 } });
    const started = Date.now();
    let result: Execution;
    try { result = await execute(mode, commands[probe], operation); }
    catch (error) { result = { stdout: "", stderr: "", closed: false, outputCaptured: false, errorType: error instanceof Error ? error.name : "unknown" }; }
    finally { operation.dispose(); }
    let jsonRows: number | null = null, current: { pid: number; parentPid: number } | null = null;
    if (probe === "inventory" && result.errorType === undefined) {
      try {
        const rows: unknown = JSON.parse(result.stdout);
        if (Array.isArray(rows)) {
          jsonRows = rows.length;
          const own = rows.find(row => row?.ProcessId === process.pid);
          if (own && Number.isSafeInteger(own.ParentProcessId)) current = { pid: process.pid, parentPid: own.ParentProcessId };
        }
      } catch { /* Output is described without retaining its contents. */ }
    }
    results.push({ mode, probe, elapsedMs: Date.now() - started, stdoutBytes: result.outputCaptured === false ? null : Buffer.byteLength(result.stdout), stderrBytes: result.outputCaptured === false ? null : Buffer.byteLength(result.stderr), closed: result.closed, errorType: result.errorType, markerMatches: probe === "marker" && result.outputCaptured !== false ? result.stdout === preparationProbeMarker : undefined, jsonRows, current });
    if (!result.closed) return results;
  }
  return results;
};

/** Fixed read-only PS5 commands own only this child; close, not exit, confirms its streams. */
export const executeRawPreparationProbe = (command: HerdrCommand): Promise<Execution> => new Promise(resolve => {
  let stdout = "", stderr = "", errorType: string | undefined, finished = false;
  const child = execFile(command.file, [...command.args], { env: command.environment, windowsHide: true, timeout: 2000, maxBuffer: 64 * 1024, encoding: "utf8" }, (error, output, errors) => { stdout = output; stderr = errors; if (error) errorType = error.name; });
  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    child.kill("SIGKILL");
    resolve({ stdout: "", stderr: "", closed: false, outputCaptured: false, errorType: "ProbeCloseDeadline" });
  }, 4000);
  child.once("close", () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    resolve({ stdout, stderr, closed: true, errorType });
  });
});
