import { parseStartupObservation, type SessionStartupReport, type StartupObservation } from "../../../session/startup.js";
import { CLEANUP_OPERATION_MS, cleanupOperation } from "../../cleanup-operation.js";
import path from "node:path";
import { lstat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { controllerExecutionDirectory, readLaunchTicket } from "../../controller/launch-ticket.js";
import { requestController } from "../../controller/local-client.js";
import { readControllerOperation, readControllerSnapshot, recordStoppedControllerGeneration, type ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { confirmControllerProcessesStopped, inspectProcessProof, stopControllerProcesses } from "../../controller/process-proof.js";
import { WorktreePreconditionError } from "../worktrees.js";
import { continuingInitialGeneration, healthyOriginalGeneration, legacyBranchLatch, preservesControllerEvidence, preservesControllerProcessProof, preservesNativeProcessPrefix, sameOrchestrationIdentity, verifyLegacyBranchProvenance, type OrchestrationBlocker } from "./orchestration.js";
import { observeWorkerPhase, workerOperation, type WorkerGitManager, type WorkerObservedPhase, type WorkerPhaseObserver } from "../execution.js";
import type { ClaimIdentity } from "../types.js";
import { appendWorkerPrompts, workerCleanupPrompt } from "../prompts.js";
import { PromptInputLimitError } from "../prompt-input-limit.js";
import type { WorkerPromptSource, WorkerPromptTuple } from "../prompt-source.js";
import { WorkerCleanupError, type WorkerCleanupStage } from "../cleanup-error.js";
import { taskAgentControlMode, type CleanupState, type LocalTask, type RecoveryState } from "./web-types.js";
import type { WebExecutionStore } from "./web-store.js";
import type { TaskPlatform } from "../../../api/types.js";
import type { createWebControllerLauncher } from "./web-process.js";
export type WebBackendOptions = {
  homeDirectory: string; store: WebExecutionStore; git: WorkerGitManager; launcher: ReturnType<typeof createWebControllerLauncher>;
  platform: TaskPlatform; buildPrompt: (task: LocalTask, platform: TaskPlatform) => string; emit: (event: { kind: string; message: string; task?: LocalTask }) => void; now: () => number;
  promptSource?: Pick<WorkerPromptSource, "current">;
  preparePromptSource?: (projectId: string, signal: AbortSignal) => Promise<void>;
  request?: typeof requestController;
  archive?: (task: LocalTask, journalPath: string, signal: AbortSignal) => Promise<void>;
};
export class WebRecoveryBlockedError extends Error {
  constructor(readonly reasonCode: NonNullable<RecoveryState["reasonCode"]>, message: string, options?: ErrorOptions) { super(message, options); }
}
export type WebCleanupOutcome = { task: LocalTask; complete: boolean };
export type WebInputWaitingReason = "prompt_unknown" | "prompt_too_large";
export type WebAdvanceResult = { kind: "observed"; task: LocalTask } | { kind: "waiting_input"; reason: WebInputWaitingReason; task: LocalTask };
class PromptUnknownError extends Error {}
export const createWebExecutionBackend = (options: WebBackendOptions) => {
  let monitoring: { observePhase?: WorkerPhaseObserver; observeSuccess?: (identity: ClaimIdentity, phase: WorkerObservedPhase) => void } = {};
  const phase = (identity: ClaimIdentity, value: WorkerObservedPhase, progressed = false, deadlineAt?: number): void => observeWorkerPhase(monitoring.observePhase, identity, value, progressed, deadlineAt);
  const success = (identity: ClaimIdentity, value: WorkerObservedPhase): void => { try { monitoring.observeSuccess?.(identity, value); } catch { /* Monitoring cannot change the operation result. */ } };
  const request = options.request ?? requestController;
  const waiting = new Map<string, WebInputWaitingReason>();
  const rejected = new Map<string, string>();
  const signature = (task: LocalTask, tuple: WorkerPromptTuple): string => JSON.stringify([tuple.user.revision, tuple.project.revision, tuple.worker.revision, task.configuration]);
  const current = (task: LocalTask): LocalTask => { const latest = options.store.getTask(task); if (latest === null || taskAgentControlMode(latest) !== "web") throw new Error("The frozen Web execution disappeared."); return latest; };
  const journal = (task: LocalTask): string => path.join(controllerExecutionDirectory(options.homeDirectory, task.webExecution!.executionId), "journal.sqlite");
  const remember = (input: LocalTask, snapshot: ControllerSnapshot): LocalTask => {
    let task = current(input);
    if (!matchesGeneration(task, snapshot)) throw new Error("Controller observation does not match the original execution generation.");
    if (snapshot.startup !== undefined) options.store.observeStartup(task, parseStartupObservation(snapshot.startup), options.now());
    task = options.store.updateWebExecution(task, { launchSubmission: "acknowledged", initialInputState: snapshot.initialInputState, activity: snapshot.activity, controllerProcess: snapshot.controllerProcess ?? task.webExecution!.controllerProcess, nativeProcesses: snapshot.nativeProcesses }, options.now());
    if (snapshot.nativeSessionId !== null) task = options.store.bindNativeSession(task, { source: "controller", sessionId: snapshot.nativeSessionId }, options.now());
    return task;
  };
  const removeEndpoint = async (endpoint: string): Promise<void> => {
    if (process.platform === "win32") return;
    try { await unlink(endpoint); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    try { await lstat(endpoint); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
    throw new Error("The original controller endpoint still exists after cleanup.");
  };
  const matchesGeneration = (task: LocalTask, snapshot: ControllerSnapshot): boolean => {
    const execution = task.webExecution!;
    return snapshot.executionId === execution.executionId && snapshot.claimId === task.claimId && snapshot.sessionId === execution.sessionId
      && snapshot.executionGeneration === execution.executionGeneration && snapshot.controllerInstanceId === execution.controllerInstanceId;
  };
  const observeStartupReport = (input: LocalTask): SessionStartupReport | null => {
    const task = current(input), execution = task.webExecution;
    if (execution === null || execution.sessionId === null) return null;
    const saved = readControllerSnapshot(journal(task));
    let startup: StartupObservation = saved !== null && matchesGeneration(task, saved) && saved.startup !== undefined
      ? parseStartupObservation(saved.startup)
      : execution.startupReport?.startup ?? { state: "unknown", reasonCode: "evidence_missing" };
    if (startup.state === "starting" && saved !== null && matchesGeneration(task, saved) && ["stopped", "stopping", "failed", "paused"].includes(saved.lifecycle)) {
      startup = { state: "unknown", reasonCode: "controller_start_unknown" };
    }
    return options.store.observeStartup(task, startup, options.now());
  };
  const verifyWorktree = async (task: LocalTask, signal: AbortSignal): Promise<LocalTask> => {
    try {
      const project = { projectId: task.projectId, repoUrl: task.repoUrl, localPath: task.repositoryPath };
      phase(task, { kind: "execution", phase: "worktree-preparation" });
      const preparing = task.resources.worktree === null;
      if (preparing) task = options.store.bindWorktree(task, await workerOperation(operation => options.git.prepareWorktree(project, task, operation), signal), options.now());
      else { await workerOperation(operation => options.git.verifyWorktree(project, task, operation), signal); task = current(task); }
      success(task, { kind: "execution", phase: "worktree-preparation" });
      if (preparing) phase(task, { kind: "execution", phase: "worktree-preparation" }, true);
      return task;
    } catch (error) {
      signal.throwIfAborted();
      const failure = error instanceof WorktreePreconditionError ? error : new WorktreePreconditionError("validation_failed", error instanceof Error ? error.message : String(error), { cause: error });
      options.store.blockOrchestration(task, { source: "worktree", code: failure.code, message: failure.message }, options.now());
      throw failure;
    }
  };
  const resumeOrchestration = async (input: LocalTask, blocker: OrchestrationBlocker, signal: AbortSignal): Promise<{ task: LocalTask; live: boolean }> => {
    let task = current(input);
    const legacyReport = blocker.source === "legacy_worktree" ? input.webExecution?.startupReport : undefined;
    const correctLegacyLatch = blocker.source === "legacy_worktree" && !task.recovery.retryAuthorized;
    if (!sameOrchestrationIdentity(task, blocker)) throw new Error("The orchestration block belongs to another original execution.");
    task = await verifyWorktree(task, signal);
    const execution = task.webExecution;
    if (execution === null || execution.launchSubmission === "not-submitted") return { task: options.store.clearOrchestration(task, blocker, null, options.now()), live: false };
    if (execution.ticketPath === null) throw new Error("Orchestration verification cannot replace missing launch evidence.");
    const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId);
    if (ticket.executionId !== execution.executionId || ticket.sessionId !== execution.sessionId || ticket.executionGeneration !== execution.executionGeneration
      || ticket.controllerInstanceId !== execution.controllerInstanceId || ticket.controllerId !== execution.controllerId || ticket.claimId !== task.claimId
      || ticket.projectId !== task.projectId || ticket.taskId !== task.taskId || ticket.workerId !== task.workerId || ticket.worktreeId !== task.worktreeId
      || ticket.userId !== task.userId || ticket.serverOrigin !== task.serverOrigin || ticket.provider !== task.configuration?.agent
      || ticket.cwd !== task.resources.worktree!.worktreePath || ticket.initialOperationId !== execution.initialOperationId || ticket.initialPrompt !== execution.initialPrompt
      || JSON.stringify(ticket.configuration) !== JSON.stringify(task.configuration)) throw new Error("Orchestration verification found conflicting original launch ownership.");
    const saved = readControllerSnapshot(journal(task));
    const firstNativeObservation = blocker.source !== "legacy_worktree" && execution.executionGeneration === "1" && task.resources.nativeSession === null;
    if (saved === null || !matchesGeneration(task, saved) || (!firstNativeObservation && (saved.nativeSessionId === null || saved.nativeSessionId !== task.resources.nativeSession?.sessionId))
      || saved.controllerProcess === null || execution.controllerProcess === null || !preservesControllerProcessProof(execution.controllerProcess, saved.controllerProcess, ticket.launchId)
      || !preservesNativeProcessPrefix(execution.nativeProcesses, saved.nativeProcesses)) throw new Error("Orchestration verification requires original generation and process evidence.");
    let observed: ControllerSnapshot | null = null;
    phase(task, { kind: "execution", phase: "agent-observation" });
    try { observed = (await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 })).snapshot; }
    catch (error) { signal.throwIfAborted(); if (correctLegacyLatch) throw error; }
    if (observed !== null && !matchesGeneration(task, observed)) throw new Error("Orchestration verification found a conflicting controller generation.");
    const initialContinuation = blocker.source !== "legacy_worktree" && observed !== null && continuingInitialGeneration(task, observed);
    const liveObservation = observed !== null && (healthyOriginalGeneration(task, observed) || initialContinuation);
    if (observed !== null && !preservesControllerEvidence(saved, observed, ticket.launchId)) throw new Error("The native observation conflicts with the original controller journal.");
    if (observed !== null && ((!firstNativeObservation && observed.nativeSessionId !== task.resources.nativeSession?.sessionId)
      || ((observed.lifecycle === "ready" || observed.lifecycle === "working") && !liveObservation))) throw new Error("Orchestration verification found conflicting original native evidence.");
    const unusedRetry = task.recovery.retryAuthorized && task.recovery.pauseReason !== null;
    if (unusedRetry || execution.restartAfterShutdown || observed === null || !liveObservation) {
      const stopped = await confirmControllerProcessesStopped(saved.controllerProcess, saved.nativeProcesses);
      if (correctLegacyLatch || !stopped) {
        if (observed !== null && ["paused", "failed", "stopped", "stopping"].includes(observed.lifecycle)) options.store.pauseRecovery(task, observed.error ?? "The native controller is paused or stopped.", options.now(), "recovery_blocked");
        throw new Error("Orchestration verification could not confirm the healthy original native identity or complete process stop.");
      }
      const stoppedSnapshot = await recordStoppedControllerGeneration(journal(task), ticket);
      if (!matchesGeneration(task, stoppedSnapshot) || stoppedSnapshot.lifecycle !== "stopped" || !stoppedSnapshot.nativeStopped || stoppedSnapshot.stoppedAt === null
        || !preservesControllerEvidence(saved, stoppedSnapshot, ticket.launchId)
        || (observed !== null && !preservesControllerEvidence(observed, stoppedSnapshot, ticket.launchId))) throw new Error("The stopped native observation conflicts with the original controller evidence.");
      task = await verifyWorktree(task, signal);
      if (firstNativeObservation) {
        if (stoppedSnapshot.nativeSessionId === null) throw new Error("The stopped original native session identity is unavailable.");
        task = options.store.bindNativeSession(task, { source: "controller", sessionId: stoppedSnapshot.nativeSessionId }, options.now(), stoppedSnapshot);
        blocker = { ...blocker, identity: { ...blocker.identity, nativeSessionId: stoppedSnapshot.nativeSessionId } };
      }
      return { task: options.store.clearOrchestration(task, blocker, stoppedSnapshot, options.now()), live: false };
    }
    for (const proof of [observed.controllerProcess!, ...observed.nativeProcesses]) {
      if (await inspectProcessProof(proof) !== "running") throw new Error("Orchestration verification could not confirm the original running processes.");
    }
    signal.throwIfAborted();
    task = await verifyWorktree(task, signal);
    task = options.store.clearOrchestration(task, blocker, observed, options.now(), legacyReport);
    task = remember(task, observed);
    if (task.recovery.retryAuthorized) task = options.store.completeRecoveryRetry(task, observed, options.now());
    if (observed.lifecycle === "ready" || observed.lifecycle === "working") success(task, { kind: "execution", phase: "agent-observation" });
    if (initialContinuation && observed.initialInputState === "not_submitted") {
      await options.launcher.refreshGrant(task, ticket, signal);
      phase(task, { kind: "execution", phase: "input-submission" });
      const response = await request(ticket, { kind: "submit_initial", operationId: execution.initialOperationId }, { signal, timeoutMs: 30000 });
      task = remember(task, response.snapshot);
      if (response.snapshot.initialInputState === "confirmed") { success(task, { kind: "execution", phase: "input-submission" }); phase(task, { kind: "execution", phase: "input-submission" }, true); }
    }
    return { task, live: true };
  };
  const backend = {
    observeStartupReport,
    advance: async (input: LocalTask, signal: AbortSignal): Promise<LocalTask> => {
      let task = current(input);
      waiting.delete(task.claimId);
      if (task.cleanup !== null || task.control !== null || task.configuration === null) throw new Error("Ordinary Web execution is fenced by cleanup or management.");
      if (legacyBranchLatch(task)) {
        await verifyLegacyBranchProvenance(options.homeDirectory, task, signal);
        const blocker = options.store.blockOrchestration(task, { source: "legacy_worktree", code: "branch_mismatch", message: task.recovery.pauseReason! }, options.now());
        return (await resumeOrchestration(task, blocker, signal)).task;
      }
      if (task.recovery.pauseReason !== null && !task.recovery.retryAuthorized) return task;
      const blocker = options.store.getOrchestrationBlocker(task);
      if (blocker !== null) {
        const result = await resumeOrchestration(task, blocker, signal);
        task = result.task;
        if (result.live) return task;
      }
      const retryAttempt = task.recovery.retryAuthorized;
      let recovering = retryAttempt;
      let capturedSignature: string | null = null;
      const pause = (error: unknown): LocalTask => options.store.pauseRecovery(task, error instanceof Error ? error.message : String(error), options.now(), error instanceof WebRecoveryBlockedError ? error.reasonCode : undefined);
      const originalSnapshot = (): ControllerSnapshot => {
        const saved = readControllerSnapshot(journal(task)), execution = task.webExecution!;
        if (saved === null || saved.executionId !== execution.executionId || saved.claimId !== task.claimId || saved.sessionId !== execution.sessionId || saved.executionGeneration !== execution.executionGeneration || saved.controllerInstanceId !== execution.controllerInstanceId) throw new Error("The original controller generation evidence is unavailable.");
        return saved;
      };
      try {
        if (retryAttempt && task.recovery.pauseReason !== null) {
          // Authorization permits one replacement generation only after proving the old writer stopped.
          if (task.webExecution === null || task.resources.nativeSession === null) throw new WebRecoveryBlockedError("native_identity_missing", "Web retry requires the original native session identity.");
          if (task.webExecution.launchSubmission === "not-submitted" && BigInt(task.webExecution.executionGeneration) > 1n) {
            // Preparation may fail after allocating a generation but before any writer is launched.
            const previous = readControllerSnapshot(journal(task));
            if (previous === null || previous.controllerProcess === null || previous.lifecycle !== "stopped" || !previous.nativeStopped || previous.stoppedAt === null) throw new Error("Unsubmitted recovery requires the original complete stopped generation evidence.");
            if (!await confirmControllerProcessesStopped(previous.controllerProcess, previous.nativeProcesses)) throw new Error("Unsubmitted recovery requires complete original controller and native process stop.");
            signal.throwIfAborted();
            if (JSON.stringify(readControllerSnapshot(journal(task))) !== JSON.stringify(previous)) throw new Error("The original stopped generation changed during unsubmitted recovery verification.");
            task = options.store.retryUnsubmittedWebGeneration(task, previous, options.now());
          } else {
            const saved = originalSnapshot();
            if (saved.nativeSessionId === null || saved.nativeSessionId !== task.resources.nativeSession.sessionId) throw new WebRecoveryBlockedError("native_identity_missing", "Web retry requires the original native session identity.");
            task = remember(task, saved);
            const proof = task.webExecution!.controllerProcess;
            if (proof === null || !await confirmControllerProcessesStopped(proof, task.webExecution!.nativeProcesses)) throw new Error("Web retry requires complete original controller and native process stop.");
            const ticket = await readLaunchTicket(options.homeDirectory, task.webExecution!.launchId);
            const stopped = await recordStoppedControllerGeneration(journal(task), ticket);
            task = options.store.beginWebGeneration(task, stopped, options.now());
          }
        } else if (!retryAttempt && task.webExecution !== null && task.webExecution.launchSubmission !== "not-submitted" && task.recovery.count >= task.configuration!.recoveryLimit) {
          // Older versions recorded exhaustion without a pause. Inspect before any launch preparation.
          try {
            const saved = originalSnapshot();
            task = remember(task, saved);
            const proof = task.webExecution!.controllerProcess;
            if (proof === null) throw new Error("The exhausted execution has no complete original process stop evidence.");
            const stopped = await confirmControllerProcessesStopped(proof, task.webExecution!.nativeProcesses);
            if (stopped) {
              if (!task.webExecution!.restartAfterShutdown || saved.error !== null) return pause(new WebRecoveryBlockedError("recovery_limit", "The execution recovery budget is exhausted."));
            } else {
              if (["stopped", "stopping", "failed", "paused"].includes(saved.lifecycle)) throw new Error("The exhausted execution is stopped or failed, but complete original process stop is unproven.");
              const ticket = await readLaunchTicket(options.homeDirectory, task.webExecution!.launchId);
              const observed = (await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 })).snapshot;
              if (observed.lifecycle !== "ready" && observed.lifecycle !== "working" && observed.lifecycle !== "starting") throw new Error(observed.error ?? "The exhausted controller is not healthy.");
              task = remember(task, observed);
            }
          } catch (error) { signal.throwIfAborted(); return pause(error); }
        }
        task = await verifyWorktree(task, signal);
        task = options.store.initializeWebExecution(task, options.now());
        if (task.webExecution!.initialPrompt === null && options.promptSource !== undefined) {
          await options.preparePromptSource?.(task.projectId, signal);
          const tuple = options.promptSource.current(task.projectId);
          if (tuple === null) { waiting.set(task.claimId, "prompt_unknown"); return task; }
          if (rejected.get(task.claimId) === signature(task, tuple)) { waiting.set(task.claimId, "prompt_too_large"); return task; }
        }
        const preparedTask = task;
        const prompt = task.webExecution!.initialPrompt ?? (options.promptSource === undefined
          ? options.buildPrompt(task, options.platform)
          : () => {
            const tuple = options.promptSource!.current(preparedTask.projectId);
            if (tuple === null) throw new PromptUnknownError();
            capturedSignature = signature(preparedTask, tuple);
            return appendWorkerPrompts(options.buildPrompt(preparedTask, options.platform), tuple);
          });
        phase(task, { kind: "execution", phase: "agent-start" });
        let ticket = await options.launcher.prepare(task, prompt, signal);
        rejected.delete(task.claimId);
        task = current(task);
        const wasUnsubmitted = task.webExecution?.launchSubmission === "not-submitted";
        await options.launcher.launch(task, ticket, signal);
        task = current(task);
        if (wasUnsubmitted && task.webExecution?.launchSubmission !== "not-submitted") { success(task, { kind: "execution", phase: "agent-start" }); phase(task, { kind: "execution", phase: "agent-start" }, true); }
        let snapshot: ControllerSnapshot;
        phase(task, { kind: "execution", phase: "agent-observation" });
        try { snapshot = (await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 })).snapshot; }
        catch (error) {
          signal.throwIfAborted();
          // A retry never grants a second generation when its first observation fails.
          if (retryAttempt) throw error;
          const saved = originalSnapshot();
          task = remember(task, saved);
          const proof = task.webExecution!.controllerProcess;
          if (proof === null || !await confirmControllerProcessesStopped(proof, task.webExecution!.nativeProcesses)) throw new Error("The original controller is unreachable; its native writer may still be alive and will not be replaced.", { cause: error });
          if (saved.nativeSessionId === null) throw new WebRecoveryBlockedError("native_identity_missing", "The stopped native launch has no proven session identity; recovery cannot create another conversation.");
          const stopped = await recordStoppedControllerGeneration(journal(task), ticket);
          if (!task.webExecution!.restartAfterShutdown) task = options.store.beginRecovery(task, options.now());
          if (task.recovery.pauseReason !== null) return task;
          recovering = true;
          task = options.store.beginWebGeneration(task, stopped, options.now());
          phase(task, { kind: "execution", phase: "agent-start" });
          ticket = await options.launcher.prepare(task, task.webExecution!.initialPrompt!, signal);
          await options.launcher.launch(current(task), ticket, signal);
          success(task, { kind: "execution", phase: "agent-start" });
          phase(task, { kind: "execution", phase: "agent-observation" });
          snapshot = (await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 })).snapshot;
        }
        task = remember(current(task), snapshot);
        if (snapshot.lifecycle === "failed" || snapshot.lifecycle === "paused" || snapshot.lifecycle === "stopped" || snapshot.lifecycle === "stopping") {
          recovering = true;
          const error = new Error(snapshot.error ?? "The native controller is paused or stopped.");
          // A confirmed native lifecycle failure is independent of the number of orchestration attempts.
          pause(error);
          throw error;
        }
        if ((snapshot.lifecycle === "ready" || snapshot.lifecycle === "working") && snapshot.initialInputState === "not_submitted" && BigInt(task.webExecution!.executionGeneration) > 1n) {
          recovering = true;
          throw new Error("Recovery cannot resubmit the original managed assignment.");
        }
        if (snapshot.lifecycle === "ready" || snapshot.lifecycle === "working") {
          if (task.recovery.retryAuthorized) task = options.store.completeRecoveryRetry(task, snapshot, options.now());
          success(task, { kind: "execution", phase: "agent-observation" });
          recovering = false;
        }
        await options.launcher.refreshGrant(task, ticket, signal);
        if (snapshot.lifecycle === "starting") return options.store.updateWebExecution(task, { activity: "initializing" }, options.now());
        if (snapshot.initialInputState === "not_submitted") {
          phase(task, { kind: "execution", phase: "input-submission" });
          const response = await request(ticket, { kind: "submit_initial", operationId: task.webExecution!.initialOperationId }, { signal, timeoutMs: 30000 });
          task = remember(task, response.snapshot);
          if (response.snapshot.initialInputState === "confirmed") { success(task, { kind: "execution", phase: "input-submission" }); phase(task, { kind: "execution", phase: "input-submission" }, true); }
        }
        options.emit({ kind: "web-observed", task, message: `Original ${ticket.provider} controller generation ${ticket.executionGeneration} is bound to session ${ticket.sessionId}.` });
        return current(task);
      } catch (error) {
        if (!signal.aborted && error instanceof PromptUnknownError) { waiting.set(task.claimId, "prompt_unknown"); return current(task); }
        if (!signal.aborted && error instanceof PromptInputLimitError && capturedSignature !== null) {
          if (rejected.get(task.claimId) !== capturedSignature) {
            rejected.set(task.claimId, capturedSignature);
            options.emit({ kind: "waiting", task: current(task), message: `Prompt input ${error.inputPath} exceeds ${error.maxBytes} bytes (${error.actualBytes} bytes); revisions ${JSON.parse(capturedSignature).slice(0, 3).join(", ")}.` });
          }
          waiting.set(task.claimId, "prompt_too_large");
          return current(task);
        }
        if (!signal.aborted && !(error instanceof WorktreePreconditionError) && (recovering && (retryAttempt || current(task).recovery.count >= task.configuration!.recoveryLimit))) pause(error);
        throw error;
      }
    },
    cleanup: async (input: LocalTask, kind: CleanupState["kind"], deadline: number, signal: AbortSignal = new AbortController().signal, immediateStop = false): Promise<WebCleanupOutcome> => {
      let stage: WorkerCleanupStage = "observation";
      phase(input, { kind: "cleanup", phase: stage });
      try {
        const startedAt = options.now();
        let task = current(input);
        if (task.status !== "done" && kind === "shutdown" && task.cleanup === null && task.recovery.retryAuthorized && task.recovery.pauseReason === null) task = options.store.pauseRecovery(task, "The explicit recovery attempt stopped before a successful observation.", options.now());
        if (task.status !== "done" && kind === "shutdown" && task.cleanup === null && task.recovery.pauseReason === null && task.configuration !== null && task.recovery.count >= task.configuration.recoveryLimit && task.webExecution !== null && task.webExecution.launchSubmission !== "not-submitted") {
          // Shutdown provenance must not turn an already exhausted writer into a healthy orderly restart.
          try {
            const saved = readControllerSnapshot(journal(task));
            if (saved === null || !matchesGeneration(task, saved) || saved.controllerProcess === null) throw new Error("The exhausted execution has no original generation evidence before shutdown.");
            if (["failed", "paused", "stopped", "stopping"].includes(saved.lifecycle) || await confirmControllerProcessesStopped(saved.controllerProcess, saved.nativeProcesses)) task = options.store.pauseRecovery(task, "The execution recovery budget is exhausted.", options.now());
          } catch (error) {
            signal.throwIfAborted();
            task = options.store.pauseRecovery(task, error instanceof Error ? error.message : String(error), options.now());
          }
        }
        if (task.status !== "done") task = options.store.beginCleanup(task, { kind, deadline: Math.max(startedAt, deadline) }, startedAt);
        const intent = task.cleanup;
        if (intent === null) throw new Error("The original cleanup intent is missing.");
        const execution = task.webExecution;
        if (execution === null && task.configuration === null) throw new Error("The recovered Web claim has no original launch provenance; its resources are retained.");
        success(task, { kind: "cleanup", phase: "observation" });
        stage = "agent-stop";
        phase(task, { kind: "cleanup", phase: stage }, false);
        let launched = false;
        if (execution !== null) {
          let saved = readControllerSnapshot(journal(task));
          if (saved !== null && !matchesGeneration(task, saved)) {
            if (execution.launchSubmission !== "not-submitted" || saved.executionId !== execution.executionId || saved.claimId !== task.claimId
              || saved.controllerProcess === null || BigInt(saved.executionGeneration) + 1n !== BigInt(execution.executionGeneration)
              || !await confirmControllerProcessesStopped(saved.controllerProcess, saved.nativeProcesses)) throw new Error("The original controller generation cannot be identified and stopped from its journal.");
            saved = null;
          }
          launched = saved !== null || execution.launchSubmission !== "not-submitted";
          if (launched) {
            const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId);
            if (ticket.executionId !== execution.executionId || ticket.claimId !== task.claimId || ticket.sessionId !== execution.sessionId
              || ticket.executionGeneration !== execution.executionGeneration || ticket.controllerInstanceId !== execution.controllerInstanceId
              || ticket.worktreeId !== task.worktreeId || ticket.workerId !== task.workerId || ticket.serverOrigin !== task.serverOrigin) throw new Error("The cleanup ticket does not identify the original execution.");
            let response: Awaited<ReturnType<typeof request>> | undefined;
            try { response = await request(ticket, { kind: "observe" }, { signal, timeoutMs: CLEANUP_OPERATION_MS }); }
            catch (error) {
              signal.throwIfAborted();
              const observed = readControllerSnapshot(journal(task));
              if (observed !== null) {
                if (!matchesGeneration(task, observed)) throw new Error("The original controller journal belongs to a different generation.", { cause: error });
                if (saved !== null && !preservesControllerEvidence(saved, observed, ticket.launchId)) throw new Error("The cleanup observation conflicts with the original controller journal.");
                saved = observed;
              }
            }
            const reachable = response !== undefined;
            if (response !== undefined) {
              if (!matchesGeneration(task, response.snapshot)) throw new Error("The observed controller belongs to a different generation.");
              if (saved !== null && !preservesControllerEvidence(saved, response.snapshot, ticket.launchId)) throw new Error("The cleanup observation conflicts with the original controller journal.");
              saved = response.snapshot;
            }
            if (saved?.controllerProcess != null && execution.controllerProcess !== null) {
              if (!preservesControllerProcessProof(execution.controllerProcess, saved.controllerProcess, ticket.launchId)) throw new Error("The original controller process identity conflicts with its journal.");
            }
            if (saved !== null && !preservesNativeProcessPrefix(execution.nativeProcesses, saved.nativeProcesses)) throw new Error("The original native process identities conflict with their journal.");
            if (saved?.nativeSessionId != null && task.status !== "done") task = options.store.bindNativeSession(task, { source: "controller", sessionId: saved.nativeSessionId }, options.now(), saved);
            const proof = saved?.controllerProcess ?? execution.controllerProcess;
            const native = saved?.nativeProcesses ?? execution.nativeProcesses;
            if (proof === null) throw new Error("The original controller process identity is missing; cleanup cannot infer stop.");
            let stopped = await confirmControllerProcessesStopped(proof, native);
            if (!immediateStop && task.status !== "done" && !stopped && options.now() < intent.deadline) {
              if (!reachable) throw new Error("The original controller is unavailable; cleanup retains its fixed deadline and process identity.");
              if (task.webExecution!.cleanupOperationId === null) task = options.store.updateWebExecution(task, { cleanupOperationId: randomUUID() }, options.now());
              const operationId = task.webExecution!.cleanupOperationId!;
              let operation = readControllerOperation(journal(task), operationId);
              if (operation === null) {
                try { await request(ticket, { kind: "cleanup", operationId, prompt: workerCleanupPrompt(task, intent.deadline), deadline: intent.deadline }, { signal, timeoutMs: Math.max(1, Math.min(CLEANUP_OPERATION_MS, intent.deadline - options.now())) }); }
                catch (error) {
                  signal.throwIfAborted();
                  operation = readControllerOperation(journal(task), operationId);
                  if (operation === null) throw error;
                }
                operation = readControllerOperation(journal(task), operationId);
              }
              if (operation !== null && (operation.kind !== "cleanup" || operation.executionGeneration !== execution.executionGeneration)) throw new Error("The cleanup operation belongs to a different controller generation.");
              if (operation === null || !["confirmed", "failed", "rejected", "expired"].includes(operation.state)) return { task, complete: false };
            }
            if (!stopped) {
              if (reachable) try { await request(ticket, { kind: "stop", deadline: options.now() + CLEANUP_OPERATION_MS }, { signal, timeoutMs: CLEANUP_OPERATION_MS }); } catch { /* OS process observation remains authoritative after an IPC loss. */ }
              signal.throwIfAborted();
              try { await stopControllerProcesses(proof, native, Date.now() + CLEANUP_OPERATION_MS); }
              catch (error) { if (!await confirmControllerProcessesStopped(proof, native)) throw error; }
              stopped = await confirmControllerProcessesStopped(proof, native);
            }
            if (!stopped) throw new Error("The original controller or its native processes still exist.");
            if (saved !== null) await recordStoppedControllerGeneration(journal(task), ticket);
            success(task, { kind: "cleanup", phase: "agent-stop" });
            phase(task, { kind: "cleanup", phase: "agent-stop" }, true);
            stage = "backend-close";
            phase(task, { kind: "cleanup", phase: stage }, false);
            await removeEndpoint(ticket.ipcEndpoint);
            success(task, { kind: "cleanup", phase: "backend-close" });
            phase(task, { kind: "cleanup", phase: "backend-close" }, true);
          }
        }
        signal.throwIfAborted();
        if (!launched) success(task, { kind: "cleanup", phase: "agent-stop" });
        if (kind === "shutdown") return { task, complete: true };
        if (launched) {
          stage = "archive";
          phase(task, { kind: "cleanup", phase: stage }, false);
          if (!options.archive) throw new Error("Session archive uploader is unavailable; the original worktree is retained.");
          await options.archive(task, journal(task), signal);
          success(task, { kind: "cleanup", phase: "archive" });
          phase(task, { kind: "cleanup", phase: "archive" }, true);
        }
        stage = "worktree-removal";
        phase(task, { kind: "cleanup", phase: stage }, false);
        const project = { projectId: task.projectId, repoUrl: task.repoUrl, localPath: task.repositoryPath };
        await cleanupOperation(operation => options.git.removeWorktree(project, task, operation), signal);
        if (await cleanupOperation(operation => options.git.findWorktree(project, task, operation), signal) !== null) throw new Error("The original task still has Git worktree resources after cleanup.");
        success(task, { kind: "cleanup", phase: "worktree-removal" });
        phase(task, { kind: "cleanup", phase: "worktree-removal" }, true);
        waiting.delete(task.claimId); rejected.delete(task.claimId);
        return { task, complete: true };
      } catch (error) {
        throw new WorkerCleanupError(stage, error);
      }
    },
  };
  return {
    ...backend,
    setMonitoringObserver: (value: { observePhase?: WorkerPhaseObserver; observeSuccess?: (identity: ClaimIdentity, phase: WorkerObservedPhase) => void }): void => { monitoring = value; },
    advanceResult: async (task: LocalTask, signal: AbortSignal): Promise<WebAdvanceResult> => {
      const result = await backend.advance(task, signal);
      const reason = waiting.get(task.claimId);
      return reason === undefined ? { kind: "observed", task: result } : { kind: "waiting_input", reason, task: result };
    },
  };
};
export type WebExecutionBackend = ReturnType<typeof createWebExecutionBackend>;
