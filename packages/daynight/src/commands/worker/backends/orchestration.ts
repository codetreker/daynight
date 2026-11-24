import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { resolveConfigurationPaths } from "../../../config/paths.js";
import { controllerPayloadHash } from "../../controller/launch-ticket.js";
import type { ControllerOperation, ControllerSnapshot } from "../../controller/lifecycle-store.js";
import type { ControllerProcessProof } from "../../controller/process-proof.js";
import { isLinuxControllerLaunch } from "../../controller/linux-controller-launch.js";
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

/** The detached POSIX Controller may be reparented between launcher and self-capture. Windows retains its parent and adds the launch Job. */
export const preservesControllerProcessProof = (previous: ControllerProcessProof, observed: ControllerProcessProof | null, launchId: string): boolean => {
  if (observed === null) return false;
  if (isLinuxControllerLaunch(previous) || isLinuxControllerLaunch(observed))
    return isLinuxControllerLaunch(previous) && isLinuxControllerLaunch(observed)
      && previous.launchId === launchId && observed.launchId === launchId && previous.pid === observed.pid;
  return observed.pid === previous.pid && (previous.processGroupId !== null || observed.parentPid === previous.parentPid)
  && observed.processGroupId === previous.processGroupId && observed.startedAt === previous.startedAt && observed.commandHash === previous.commandHash
  && (previous.jobObjectName !== undefined ? observed.jobObjectName === previous.jobObjectName
    : observed.jobObjectName === undefined || (previous.processGroupId === null && observed.jobObjectName === `Local\\Daynight-${launchId}`));
};

/** Controller startup appends captured processes; every previously captured identity must remain unchanged. */
export const preservesNativeProcessPrefix = (previous: ControllerSnapshot["nativeProcesses"], observed: ControllerSnapshot["nativeProcesses"]): boolean =>
  previous.length <= observed.length && previous.every((proof, index) => JSON.stringify(proof) === JSON.stringify(observed[index]));

/** Fresh IPC or journal observations cannot replace identities or undo delivery already recorded by the same Controller. */
export const preservesControllerEvidence = (previous: ControllerSnapshot, observed: ControllerSnapshot, launchId: string): boolean =>
  (previous.nativeSessionId === null || observed.nativeSessionId === previous.nativeSessionId)
  && (previous.controllerProcess === null || preservesControllerProcessProof(previous.controllerProcess, observed.controllerProcess, launchId))
  && preservesNativeProcessPrefix(previous.nativeProcesses, observed.nativeProcesses)
  && preservesInitialInputEvidence(previous.initialInputState, observed.initialInputState);

export const preservesInitialInputEvidence = (previous: ControllerSnapshot["initialInputState"], observed: ControllerSnapshot["initialInputState"]): boolean =>
  previous === "not_submitted" || observed !== "not_submitted"
    && (!["provider_accepted", "confirmed"].includes(previous) || ["provider_accepted", "confirmed"].includes(observed));

/** The current ticket authenticates the journal; an inherited initial operation retains its original positive generation and frozen payload. */
export const matchesInitialOperation = (operation: ControllerOperation, owner: { initialOperationId: string; initialPrompt: string; executionGeneration: string }, inherited: boolean): boolean => {
  const payload = { text: owner.initialPrompt };
  return operation.operationId === owner.initialOperationId && operation.kind === "initial"
    && typeof operation.executionGeneration === "string" && /^[1-9][0-9]*$/.test(operation.executionGeneration)
    && (inherited ? BigInt(operation.executionGeneration) < BigInt(owner.executionGeneration) : operation.executionGeneration === owner.executionGeneration)
    && operation.payloadHash === controllerPayloadHash({ kind: "initial", payload }) && controllerPayloadHash(operation.payload) === controllerPayloadHash(payload);
};

/** Process capture can continue after any generation's first observation. Delivery and retry authorization are separate gates. */
const runningOriginalGeneration = (task: LocalTask, snapshot: ControllerSnapshot, allowFirstNativeBinding = false): boolean => {
  const execution = task.webExecution;
  return execution !== null && snapshot.executionId === execution.executionId
    && snapshot.claimId === task.claimId && snapshot.testExecutionId === undefined && snapshot.sessionId === execution.sessionId
    && snapshot.executionGeneration === execution.executionGeneration && snapshot.controllerInstanceId === execution.controllerInstanceId
    && (task.resources.nativeSession === null ? allowFirstNativeBinding : snapshot.nativeSessionId === task.resources.nativeSession.sessionId)
    && (snapshot.lifecycle === "ready" || snapshot.lifecycle === "working")
    && snapshot.startup?.state === "ready" && !snapshot.nativeStopped && snapshot.stoppedAt === null && snapshot.error === null
    && snapshot.controllerProcess !== null && execution.controllerProcess !== null
    && preservesControllerProcessProof(execution.controllerProcess, snapshot.controllerProcess, execution.launchId)
    && snapshot.nativeProcesses.length > 0 && preservesNativeProcessPrefix(execution.nativeProcesses, snapshot.nativeProcesses)
    && preservesInitialInputEvidence(execution.initialInputState, snapshot.initialInputState);
};

export const healthyOriginalGeneration = (task: LocalTask, snapshot: ControllerSnapshot): boolean =>
  runningOriginalGeneration(task, snapshot) && ["provider_accepted", "confirmed"].includes(snapshot.initialInputState);

/** A later generation may continue the original initial input only with separate journal evidence. */
export const recoveringInitialGeneration = (task: LocalTask, snapshot: ControllerSnapshot): boolean =>
  task.webExecution !== null && BigInt(task.webExecution.executionGeneration) > 1n
  && task.webExecution.initialInputState === "not_submitted" && snapshot.initialInputState === "not_submitted"
  && runningOriginalGeneration(task, snapshot);

/** An authenticated first-generation observation can establish its first native identity without creating another conversation. */
export const continuingInitialGeneration = (task: LocalTask, snapshot: ControllerSnapshot): boolean => {
  const execution = task.webExecution;
  return execution !== null && execution.executionGeneration === "1" && task.recovery.count === 0 && task.recovery.pauseReason === null
    && !task.recovery.retryAuthorized && !execution.restartAfterShutdown && execution.initialInputState !== "failed"
    && runningOriginalGeneration(task, snapshot, true)
    && ["not_submitted", "dispatching", "provider_accepted", "unknown", "confirmed"].includes(snapshot.initialInputState)
    && (snapshot.initialInputState !== "not_submitted" || execution.initialInputState === "not_submitted");
};
/** Later generations may observe the inherited first input without replaying it or consuming another recovery. */
export const continuingOriginalGeneration = (task: LocalTask, snapshot: ControllerSnapshot, operation?: ControllerOperation | null): boolean => {
  if (continuingInitialGeneration(task, snapshot)) return true;
  const execution = task.webExecution;
  return execution !== null && BigInt(execution.executionGeneration) > 1n && task.recovery.pauseReason === null
    && !task.recovery.retryAuthorized && !execution.restartAfterShutdown && runningOriginalGeneration(task, snapshot)
    && ["dispatching", "unknown"].includes(snapshot.initialInputState) && operation != null && execution.initialPrompt !== null
    && (matchesInitialOperation(operation, { ...execution, initialPrompt: execution.initialPrompt }, true)
      || matchesInitialOperation(operation, { ...execution, initialPrompt: execution.initialPrompt }, false));
};
export const stoppedOriginalGeneration = (task: LocalTask, snapshot: ControllerSnapshot): boolean => {
  const execution = task.webExecution;
  return execution !== null && snapshot.executionId === execution.executionId && snapshot.claimId === task.claimId && snapshot.testExecutionId === undefined
    && snapshot.sessionId === execution.sessionId && snapshot.executionGeneration === execution.executionGeneration && snapshot.controllerInstanceId === execution.controllerInstanceId
    && snapshot.nativeSessionId !== null && snapshot.nativeSessionId === task.resources.nativeSession?.sessionId
    && snapshot.lifecycle === "stopped" && snapshot.nativeStopped && snapshot.stoppedAt !== null && snapshot.controllerProcess !== null
    && execution.controllerProcess !== null && preservesControllerProcessProof(execution.controllerProcess, snapshot.controllerProcess, execution.launchId);
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

// The old producer timestamps execution-error after persisting the report and awaiting
// capability discovery (10s) and claim summary (30s). Allow another 5s for local scheduling.
// Keep this compatibility bound tied to that producer, independent of future API limits:
// https://github.com/codetreker/daynight/blob/47c5152b5c1c3947977482c07bed34b5a068b78f/packages/daynight/src/commands/worker/coordinator.ts#L395-L440
const LEGACY_DIAGNOSTIC_REPORT_DELAY_MS = 45_000;

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
        if (!Number.isFinite(time) || time < reportTime - 600_000 || time > reportTime + LEGACY_DIAGNOSTIC_REPORT_DELAY_MS) continue;
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
