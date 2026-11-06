import path from "node:path";
import { performance } from "node:perf_hooks";
import type { AssistantHostIssue } from "../../../src/commands/worker/bots/host-capabilities.js";
import { hasHerdrCommandCleanupFailure, hasUnconfirmedHerdrCommandCleanup, spawnHerdrProcess, type HerdrSpawn } from "../../../src/commands/worker/herdr/command.js";

const flags = new Set(["--version", "--no-auto-update", "--headless", "--help", "app-server", "--stdio", "--print", "--input-format", "stream-json", "--output-format", "--permission-prompt-tool", "stdio", "--include-partial-messages"]);
const label = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z0-9_.-]{1,96}$/.test(value) ? value : undefined;

/** Error structure only: messages, stdout, stderr and arbitrary properties can contain private data. */
const inspectHostError = (error: unknown): { detail: unknown; complete: boolean } => {
  const seen = new Set<unknown>();
  let count = 0, complete = true;
  const visit = (value: unknown, depth: number): unknown => {
    if (++count > 16 || depth > 4) { complete = false; return { truncated: true }; }
    if (!(value instanceof Error)) return { name: "non-error" };
    if (seen.has(value)) { complete = false; return { circular: true }; }
    seen.add(value);
    const result: Record<string, unknown> = { name: label(value.name) ?? "Error" };
    if ("code" in value && label(value.code) !== undefined) result.code = value.code;
    if ("kind" in value && label(value.kind) !== undefined) result.kind = value.kind;
    if ("exitCode" in value && (value.exitCode === null || Number.isSafeInteger(value.exitCode))) result.exitCode = value.exitCode;
    if ("signal" in value && (value.signal === null || label(value.signal) !== undefined)) result.signal = value.signal;
    if (value.cause !== undefined) result.cause = visit(value.cause, depth + 1);
    if (value instanceof AggregateError) {
      result.errors = value.errors.slice(0, 4).map(child => visit(child, depth + 1));
      if (value.errors.length > 4) { complete = false; result.errorsTruncated = true; }
    }
    return result;
  };
  const detail = visit(error, 0);
  return { detail, complete };
};
export const hostProbeError = (error: unknown): unknown => inspectHostError(error).detail;

type Event = { kind: string; elapsedMs: number; pid: number | null; code?: number | null; signal?: string | null; error?: unknown };
type Probe = { executable: string; args: string[]; events: Event[] };

/** Records this test's fixed metadata probes; these events do not identify a directory lock owner. */
export const createHostProbeDiagnostic = (
  spawn: HerdrSpawn = spawnHerdrProcess,
  now: () => number = () => performance.now(),
) => {
  const started = now(), probes: Probe[] = [];
  let truncated = false;
  const elapsedMs = (): number => Math.round((now() - started) * 1000) / 1000;
  const start: HerdrSpawn = (file, args, options) => {
    if (probes.length >= 6) { truncated = true; return spawn(file, args, options); }
    const probe: Probe = { executable: label(path.win32.basename(path.basename(file))) ?? "unrecorded", args: args.slice(0, 16).map(arg => flags.has(arg) ? arg : "unrecorded"), events: [] };
    if (args.length > 16) truncated = true;
    probes.push(probe);
    let child;
    try { child = spawn(file, args, options); }
    catch (error) { probe.events.push({ kind: "spawn-error", elapsedMs: elapsedMs(), pid: null, error: hostProbeError(error) }); throw error; }
    probe.events.push({ kind: "created", elapsedMs: elapsedMs(), pid: child.pid ?? null });
    const event = (kind: string, extra: Partial<Event> = {}): void => { probe.events.push({ kind, elapsedMs: elapsedMs(), pid: child.pid ?? null, ...extra }); };
    child.once("spawn", () => event("spawn"));
    child.once("error", error => event("error", { error: hostProbeError(error) }));
    child.once("exit", (code, signal) => event("exit", { code, signal }));
    child.once("close", (code, signal) => event("close", { code, signal }));
    return child;
  };
  const snapshot = (issues: readonly AssistantHostIssue[]) => ({
    elapsedMs: elapsedMs(), probes, truncated: truncated || issues.length > 3,
    issues: issues.slice(0, 3).map(issue => {
      const error = inspectHostError(issue.error);
      return { provider: issue.provider, reason: issue.reason,
        cleanupFailure: error.complete ? hasHerdrCommandCleanupFailure(issue.error) : null,
        cleanupUnconfirmed: error.complete ? hasUnconfirmedHerdrCommandCleanup(issue.error) : null,
        cleanupClassificationIncomplete: !error.complete, error: error.detail };
    }),
  });
  return {
    start, snapshot,
    cleanup: async (remove: () => Promise<void>, issues: readonly AssistantHostIssue[], emit: (text: string) => void = text => { process.stdout.write(text); }): Promise<void> => {
      try { await remove(); }
      catch (error) {
        try { emit(`${JSON.stringify({ kind: "assistant_host_cleanup_failure", ...snapshot(issues), cleanupError: hostProbeError(error) })}\n`); }
        catch { /* Diagnostic failure must not replace the original cleanup error. */ }
        throw error;
      }
    },
  };
};
