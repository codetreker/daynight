import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import path from "node:path";
import { OperationError, type Operation } from "../../../src/api/operation.js";
import type { HerdrTaskBinding } from "../../../src/commands/worker/herdr/agents.js";
import type { HerdrRpcClient } from "../../../src/commands/worker/herdr/rpc.js";

type Unknown = { state: "unknown"; reason: "invalid" | "unavailable" | "deadline" | "cancelled" };
type Observation<T> = T | Unknown;
type ReadinessFile = Observation<{ state: "missing" } | { state: "present"; size: number; nonceMatches: boolean; pidMatches: boolean; executableMatches: boolean; validStartToken: boolean }>;
type TemporaryFiles = Observation<{ state: "observed"; count: number }>;
type Pane = Observation<{ state: "observed"; shellPid: number; screenBytes: number; screenSignals: string[] }>;

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const errorReason = (operation: Operation): Unknown => ({ state: "unknown", reason: operation.signal.reason instanceof OperationError && operation.signal.reason.kind === "deadline" ? "deadline" : operation.signal.aborted ? "cancelled" : "unavailable" });
const invalid = (): Unknown => ({ state: "unknown", reason: "invalid" });
const signals: readonly [string, RegExp][] = [
  ["execution-policy", /execution of scripts is disabled|running scripts is disabled|UnauthorizedAccess/i],
  ["command-not-found", /CommandNotFoundException|is not recognized as (?:the name|an internal)/i],
  ["path-not-found", /PathNotFound|Cannot find path/i],
  ["access-denied", /Access to the path .* is denied|PermissionDenied/i],
  ["parser-error", /ParserError|ParseException/i],
  ["terminating-error", /FullyQualifiedErrorId|Exception calling/i],
  ["powershell-prompt", /(?:^|\n)PS [^\r\n>]{0,256}>/i],
];

/** Read only after the fixture has verified the original private workspace and pane. */
export const inspectWindowsRootReadiness = async (input: {
  rpc: Pick<HerdrRpcClient, "request">;
  operation: Operation;
  binding: HerdrTaskBinding;
  tabId: string;
  shellPid: number;
  mapping: { manifestPath: string; nonce: string; windowsCommand: readonly string[] };
}): Promise<{ readyFile: ReadinessFile; temporaryFiles: TemporaryFiles; pane: Pane }> => {
  const { operation, binding, mapping } = input;
  if (operation.limits.totalMs > 5000 || operation.limits.requestMs > 5000 || operation.limits.responseBytes > 65536 || operation.limits.totalBytes > 131072) throw new RangeError("Readiness diagnostics require bounded operations and responses.");
  if (!path.isAbsolute(mapping.manifestPath) || path.basename(mapping.manifestPath) !== "manifest.json" || typeof mapping.windowsCommand[0] !== "string" || !Number.isSafeInteger(input.shellPid) || input.shellPid < 1 || !input.tabId) throw new TypeError("Readiness diagnostics require the original mapped pane and executable.");
  const directory = path.dirname(mapping.manifestPath);
  let readyFile: ReadinessFile;
  try {
    operation.check();
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("The original mapping directory is unavailable.");
    operation.check();
    const file = path.join(directory, "shell-ready.json");
    let entry;
    try { entry = await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { operation.check(); readyFile = { state: "missing" }; entry = null; } else throw error; }
    if (entry !== null) {
      if (!entry!.isFile() || entry!.isSymbolicLink() || entry!.size > 4096) readyFile = invalid();
      else {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.size > 4096) readyFile = invalid();
          else {
            const bytes = Buffer.alloc(4097), result = await handle.read(bytes, 0, bytes.length, 0);
            operation.check();
            if (result.bytesRead > 4096) readyFile = invalid();
            else {
              const value: unknown = JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8"));
              readyFile = record(value) ? { state: "present", size: result.bytesRead, nonceMatches: value.nonce === mapping.nonce, pidMatches: value.pid === input.shellPid, executableMatches: typeof value.executable === "string" && value.executable.toLowerCase() === mapping.windowsCommand[0]!.toLowerCase(), validStartToken: typeof value.startToken === "string" && /^\d+$/.test(value.startToken) } : invalid();
            }
          }
        } finally { await handle.close(); }
      }
    }
  } catch (error) { readyFile = error instanceof SyntaxError ? invalid() : errorReason(operation); }
  let temporaryFiles: TemporaryFiles;
  try {
    operation.check();
    let count = 0, entries = 0;
    const dir = await opendir(directory);
    for await (const entry of dir) {
      operation.check();
      if (++entries > 256) throw new RangeError("Readiness directory exceeded its observation bound.");
      if (/^shell-ready\.[0-9a-f-]{36}\.tmp$/i.test(entry.name)) count++;
    }
    operation.check();
    temporaryFiles = { state: "observed", count };
  } catch { temporaryFiles = errorReason(operation); }
  let pane: Pane;
  try {
    operation.check();
    const readInfo = async () => {
      const result = await input.rpc.request("pane.process_info", { pane_id: binding.paneId }, operation);
      if (result.type !== "pane_process_info" || !record(result.process_info) || result.process_info.pane_id !== binding.paneId || result.process_info.shell_pid !== input.shellPid) throw new TypeError("The original pane process changed.");
    };
    await readInfo();
    const result = await input.rpc.request("pane.read", { pane_id: binding.paneId, source: "visible", format: "text", strip_ansi: true }, operation);
    const screen = result.read;
    if (result.type !== "pane_read" || !record(screen) || screen.pane_id !== binding.paneId || screen.workspace_id !== binding.workspaceId || screen.tab_id !== input.tabId || screen.source !== "visible" || screen.format !== "text" || screen.truncated !== false || typeof screen.text !== "string" || Buffer.byteLength(screen.text) > 4096) throw new TypeError("The original bounded pane output is unavailable.");
    const screenBytes = Buffer.byteLength(screen.text);
    const screenSignals = signals.filter(([, pattern]) => pattern.test(screen.text as string)).map(([signal]) => signal);
    await readInfo();
    operation.check();
    pane = { state: "observed", shellPid: input.shellPid, screenBytes, screenSignals };
  } catch (error) { pane = error instanceof TypeError ? invalid() : errorReason(operation); }
  return { readyFile: readyFile!, temporaryFiles, pane };
};
