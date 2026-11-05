import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { resolveConfigurationPaths } from "../../../config/paths.js";
import type { ControllerSnapshot } from "../../controller/lifecycle-store.js";
import type { LocalTask } from "./web-types.js";

export const LEGACY_BRANCH_ERROR = "The task worktree no longer uses its original task branch.";
export type OrchestrationFailure = { source: "worktree" | "coordinator" | "legacy_worktree"; code: "branch_mismatch" | "validation_failed" | "advance_failed"; message: string };
export type OrchestrationIdentity = {
  claimId: string; worktreeId: string; workerId: string; executionId: string | null; sessionId: string | null;
  executionGeneration: string | null; controllerInstanceId: string | null; nativeSessionId: string | null;
};
export type OrchestrationBlocker = OrchestrationFailure & { identity: OrchestrationIdentity; observedAt: number };
export const orchestrationIdentity = (task: LocalTask): OrchestrationIdentity => ({
  claimId: task.claimId, worktreeId: task.worktreeId, workerId: task.workerId,
  executionId: task.webExecution?.executionId ?? null, sessionId: task.webExecution?.sessionId ?? null,
  executionGeneration: task.webExecution?.executionGeneration ?? null, controllerInstanceId: task.webExecution?.controllerInstanceId ?? null,
  nativeSessionId: task.resources.nativeSession?.sessionId ?? null,
});
export const sameOrchestrationIdentity = (task: LocalTask, blocker: OrchestrationBlocker): boolean =>
  JSON.stringify(orchestrationIdentity(task)) === JSON.stringify(blocker.identity);

export const healthyOriginalGeneration = (task: LocalTask, snapshot: ControllerSnapshot): boolean => {
  const execution = task.webExecution;
  return execution !== null && task.resources.nativeSession !== null && snapshot.executionId === execution.executionId
    && snapshot.claimId === task.claimId && snapshot.testExecutionId === undefined && snapshot.sessionId === execution.sessionId
    && snapshot.executionGeneration === execution.executionGeneration && snapshot.controllerInstanceId === execution.controllerInstanceId
    && snapshot.nativeSessionId === task.resources.nativeSession.sessionId && (snapshot.lifecycle === "ready" || snapshot.lifecycle === "working")
    && snapshot.startup?.state === "ready" && !snapshot.nativeStopped && snapshot.stoppedAt === null && snapshot.error === null
    && snapshot.initialInputState === "confirmed"
    && snapshot.controllerProcess !== null && execution.controllerProcess !== null
    && JSON.stringify(snapshot.controllerProcess) === JSON.stringify(execution.controllerProcess)
    && snapshot.nativeProcesses.length > 0 && JSON.stringify(snapshot.nativeProcesses) === JSON.stringify(execution.nativeProcesses);
};
export const stoppedOriginalGeneration = (task: LocalTask, snapshot: ControllerSnapshot): boolean => {
  const execution = task.webExecution;
  return execution !== null && snapshot.executionId === execution.executionId && snapshot.claimId === task.claimId && snapshot.testExecutionId === undefined
    && snapshot.sessionId === execution.sessionId && snapshot.executionGeneration === execution.executionGeneration && snapshot.controllerInstanceId === execution.controllerInstanceId
    && snapshot.nativeSessionId !== null && snapshot.nativeSessionId === task.resources.nativeSession?.sessionId
    && snapshot.lifecycle === "stopped" && snapshot.nativeStopped && snapshot.stoppedAt !== null && snapshot.controllerProcess !== null
    && JSON.stringify(snapshot.controllerProcess) === JSON.stringify(execution.controllerProcess);
};

/** Only the known old producer's contradictory branch latch is eligible for provenance verification. */
export const legacyBranchLatch = (task: LocalTask): boolean => {
  const execution = task.webExecution, report = execution?.startupReport;
  return task.configuration !== null && task.configuration.recoveryLimit > 0 && task.recovery.count === 0
    && task.recovery.pauseReason === LEGACY_BRANCH_ERROR && task.recovery.reasonCode === "recovery_limit" && !task.recovery.retryAuthorized
    && task.cleanup === null && execution != null && !execution.restartAfterShutdown && execution.launchSubmission === "acknowledged"
    && report !== undefined && report.source === "worker" && report.claimId === task.claimId && report.sessionId === execution.sessionId
    && report.executionGeneration === execution.executionGeneration && report.controllerInstanceId === execution.controllerInstanceId
    && report.startup.state === "ready" && report.recovery.state === "blocked" && report.recovery.reasonCode === "recovery_limit"
    && task.resources.nativeSession !== null;
};

/** Old records lack a typed source. Their bounded, claim-specific diagnostic sequence supplies that missing evidence. */
export const verifyLegacyBranchProvenance = async (home: string, task: LocalTask, signal: AbortSignal): Promise<void> => {
  if (!legacyBranchLatch(task)) throw new Error("Legacy orchestration provenance does not match the known branch failure.");
  const reportTime = Date.parse(task.webExecution!.startupReport!.observedAt);
  const directory = path.join(resolveConfigurationPaths(home).stateDirectory, "worker", "logs");
  const events: { time: number; branch: boolean }[] = [];
  let names: string[];
  try { names = (await readdir(directory)).filter(name => /^worker-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort(); }
  catch (cause) { throw new Error("Legacy orchestration diagnostic provenance is unavailable; the recovery latch is retained.", { cause }); }
  for (const name of names) {
    signal.throwIfAborted();
    const filename = path.join(directory, name), metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    // A malformed or oversized diagnostic source cannot authorize a live-state correction.
    if (metadata.size > 64 * 1024 * 1024) continue;
    const stream = createReadStream(filename, { signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.length > 64 * 1024) continue;
        let entry: Record<string, unknown>;
        try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (entry === null || entry.workerId !== task.workerId || entry.projectId !== task.projectId || entry.taskId !== task.taskId || entry.claimId !== task.claimId || entry.kind !== "execution-error") continue;
        const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        if (!Number.isFinite(time) || time < reportTime - 600_000 || time > reportTime + 5_000) continue;
        const error = entry.error as { name?: unknown; message?: unknown } | null;
        events.push({ time, branch: entry.sessionId === task.resources.nativeSession!.sessionId && error?.name === "Error" && error.message === LEGACY_BRANCH_ERROR });
      }
    } finally { lines.close(); stream.destroy(); }
  }
  events.sort((a, b) => a.time - b.time);
  const required = task.configuration!.recoveryLimit + 1, tail = events.slice(-required);
  if (tail.length !== required || tail.some(event => !event.branch) || tail.at(-1)!.time < reportTime || tail.some((event, index) => index > 0 && event.time <= tail[index - 1]!.time)) {
    throw new Error("Legacy orchestration diagnostic provenance is incomplete or conflicting; the recovery latch is retained.");
  }
};
