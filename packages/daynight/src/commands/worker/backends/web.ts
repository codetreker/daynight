import { ConfigurationAdmissionWaiting, assertConfigurationAdmission } from "../configuration-admission.js";
import type { ArchiveProbeResult } from "../../controller/archive-error.js";
import { parseStartupObservation, type SessionStartupReport, type StartupObservation } from "../../../session/startup.js";
import { CLEANUP_OPERATION_MS, cleanupOperation } from "../../cleanup-operation.js";
import path from "node:path";
import { lstat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { controllerExecutionDirectory, readLaunchTicket, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import { matchesLaunchConfiguration, readLaunchToolSelection } from "../../controller/launch-tool-selection.js";
import { ToolSelectionError } from "../../../platform/tool-executables.js";
import { ControllerIpcIdentityConflictError, ControllerIpcOutcomeUnknownError, LegacyWorkerControllerError, requestController } from "../../controller/local-client.js";
import { readCompatibleControllerOperation, readControllerSnapshot, readCompatibleControllerSnapshot, readCurrentControllerSnapshot, readProvenWindowsStoppedControllerGeneration, readRecoverableInitialInput, recordStoppedControllerGeneration, type ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { confirmControllerProcessesStopped, inspectProcessProof, stopControllerProcesses, type ProcessProof } from "../../controller/process-proof.js";
import { ControllerBootstrapReplacedError, ControllerLaunchJournalConflictError, hasUnsafeControllerObservationFailure, isControllerJournalIoFailure, reconcileSubmittedControllerLaunch, stopControllerBootstrap } from "../../controller/launch-observation.js";
import { WorktreePreconditionError, WorktreeRestoreRequiredError } from "../worktrees.js";
import { sameWorktreeLocation } from "../worktrees/paths.js";
import { continuingOriginalGeneration, healthyOriginalGeneration, recoveringInitialGeneration, legacyBranchLatch, preservesControllerEvidence, preservesControllerProcessProof, preservesNativeProcessPrefix, sameOrchestrationIdentity, verifyLegacyBranchProvenance, type OrchestrationBlocker } from "./orchestration.js";
import { observeWorkerPhase, workerOperation, type WorkerGitManager, type WorkerObservedPhase, type WorkerPhaseObserver } from "../execution.js";
import type { ClaimIdentity } from "../types.js";
import { appendWorkerPrompts, workerCleanupPrompt } from "../prompts.js";
import { PromptInputLimitError } from "../prompt-input-limit.js";
import type { WorkerPromptSource, WorkerPromptTuple } from "../prompt-source.js";
import { WorkerCleanupError, type WorkerCleanupStage } from "../cleanup-error.js";
import { taskAgentControlMode, type LocalTask, type RecoveryState } from "./web-types.js";
import type { WebExecutionStore } from "./web-store.js";
import type { TaskPlatform } from "../../../api/types.js";
import type { createWebControllerLauncher } from "./web-process.js";
import { createWebStopObserver } from "./web-stop.js";
import type { CleanupRequest } from "../execution-stop.js";
import { createControllerJobLeases, type ControllerJobLeases } from "./controller-job-leases.js";
import { acquireControllerStoragePermit, controllerStorageConnectionIsOpen, isControllerStorageLockHeld } from "../../controller/storage-lock.js";
import { ControllerStorageWaitingError, prepareControllerStorage } from "../../controller/storage-preparation.js";
import { prepareControllerLaunchStorage } from "./controller-process.js";
import { SqliteAccessError } from "../../../platform/sqlite-error.js";
import { withWebRecordingSource } from "../web-recording-source.js";
import { createWebInput, type WebAutomaticInputWait } from "./web-input.js";
export type WebBackendOptions = {
  jobLeases?: ControllerJobLeases;
  homeDirectory: string; store: WebExecutionStore; git: WorkerGitManager; launcher: Pick<ReturnType<typeof createWebControllerLauncher>, "prepare" | "launch" | "refreshGrant"> & Partial<Pick<ReturnType<typeof createWebControllerLauncher>, "setGrantObserver">>;
  platform: TaskPlatform; buildPrompt: (task: LocalTask, platform: TaskPlatform) => string; emit: (event: { kind: string; message: string; task?: LocalTask; component?: string; phase?: string; attemptId?: string; runKey?: string; error?: unknown }) => void; now: () => number;
  promptSource?: Pick<WorkerPromptSource, "current">;
  preparePromptSource?: (projectId: string, signal: AbortSignal) => Promise<void>;
  request?: typeof requestController;
  probeArchive?: (task: LocalTask, journalPath: string, signal: AbortSignal) => Promise<ArchiveProbeResult>;
  archive?: (task: LocalTask, journalPath: string, signal: AbortSignal) => Promise<void>;
  archiveSessions?: () => boolean | null;
  onArchiveFailure?: (task: LocalTask, error: unknown, ownerUserId?: string) => void;
  onUnattributed?: (identity: ClaimIdentity, operationKey: string, value: boolean) => void;
};
export class WebRecoveryBlockedError extends Error {
  constructor(readonly reasonCode: NonNullable<RecoveryState["reasonCode"]>, message: string, options?: ErrorOptions) { super(message, options); }
}
export type WebCleanupOutcome = { task: LocalTask; complete: boolean };
export type WebInputAuthority = (task: LocalTask, ticket: ControllerLaunchTicket, signal: AbortSignal) => Promise<"task_paused" | "claim_invalid" | null>;
export type WebInputWaitingReason = WebAutomaticInputWait | "storage_maintenance" | "configuration_pending";
export type WebAdvanceResult = { kind: "observed" | "upgrade"; task: LocalTask } | { kind: "waiting_input"; reason: WebInputWaitingReason; task: LocalTask };
class PromptUnknownError extends Error {}
export const createWebExecutionBackend = (options: WebBackendOptions) => {
  const jobLeases = options.jobLeases ?? createControllerJobLeases();
  const previousLaunchId = (proof: ProcessProof, fallback: string): string => {
    if (!jobLeases.enabled) return fallback;
    const match = /^Local\\Daynight-([0-9a-f-]{36})$/.exec(proof.jobObjectName ?? "");
    if (match === null) throw new Error("The preceding Windows controller has no original Job identity.");
    return match[1]!;
  };
  const confirmWithLease = async (launchId: string, controller: ProcessProof, native: readonly ProcessProof[], deadline?: number, snapshot?: ControllerSnapshot, ticketHint?: ControllerLaunchTicket) => {
    if (!jobLeases.enabled) return deadline === undefined ? confirmControllerProcessesStopped(controller, native) : confirmControllerProcessesStopped(controller, native, deadline);
    const lease = await jobLeases.get(launchId);
    if (lease === undefined && snapshot?.lifecycle === "stopped" && snapshot.nativeStopped) {
      let ticket = ticketHint;
      if (ticket === undefined) {
        if (deadline === undefined) ticket = await readLaunchTicket(options.homeDirectory, launchId);
        else {
          if (deadline <= Date.now()) throw new Error("Web stop proof verification exceeded its deadline.");
          const timeout = new Error("Web stop proof verification exceeded its deadline.");
          try { ticket = await readLaunchTicket(options.homeDirectory, launchId); }
          catch (error) { if (Date.now() >= deadline) throw new AggregateError([error, timeout], "Web stop proof ticket read failed at its deadline.", { cause: error }); throw error; }
          if (Date.now() >= deadline) throw timeout;
        }
      }
      if (ticket === undefined || ticket.launchId !== launchId) throw new Error("Web stop proof ticket conflicts with its original launch.");
      const proven = readProvenWindowsStoppedControllerGeneration(path.join(controllerExecutionDirectory(options.homeDirectory, ticket.executionId), "journal.sqlite"), ticket, deadline);
      if (JSON.stringify(proven) !== JSON.stringify(snapshot) || !preservesControllerProcessProof(controller, proven.controllerProcess, launchId) || JSON.stringify(native) !== JSON.stringify(proven.nativeProcesses)) throw new Error("Web durable stop proof conflicts with its original execution evidence.");
      return true;
    }
    return confirmControllerProcessesStopped(controller, native, deadline, lease);
  };
  const stopWithLease = async (launchId: string, controller: ProcessProof, native: readonly ProcessProof[], deadline: number) => jobLeases.enabled
    ? stopControllerProcesses(controller, native, deadline, await jobLeases.get(launchId)) : stopControllerProcesses(controller, native, deadline);
  const recordWithLease = async (file: string, ticket: ControllerLaunchTicket, deadline?: number, maintain = false): Promise<ControllerSnapshot> => {
    const jobLease = jobLeases.enabled ? await jobLeases.get(ticket.launchId) : undefined;
    const stopOptions = { ...(deadline === undefined ? {} : { deadline }), ...(jobLease === undefined ? {} : { jobLease }) };
    if (!maintain) return recordStoppedControllerGeneration(file, ticket, stopOptions);
    let permit: ReturnType<typeof acquireControllerStoragePermit>;
    try { permit = acquireControllerStoragePermit(file); }
    catch (cause) {
      if (cause instanceof Error && isControllerStorageLockHeld(cause)) throw new ControllerStorageWaitingError("lock_busy", cause);
      throw cause;
    }
    let snapshot: ControllerSnapshot | undefined, failure: unknown, failed = false;
    try {
      snapshot = await recordStoppedControllerGeneration(file, ticket, { ...stopOptions, permit });
      const prepared = prepareControllerStorage({ journalFile: file, mode: "stopped-maintenance", ticket }, permit);
      if (prepared.kind === "waiting") throw new ControllerStorageWaitingError(prepared.reason, prepared.cause);
    } catch (cause) { failed = true; failure = cause; }
    try { if (!failed || !controllerStorageConnectionIsOpen(failure)) permit.release(); }
    catch (cause) {
      const releaseFailure = failed ? new AggregateError([failure, cause], "Controller recovery preparation and storage release failed.", { cause: failure }) : cause;
      if (snapshot !== undefined) throw new SqliteAccessError("cleanup-failed", { database: "controller-journal", file, phase: "release" }, { cause: releaseFailure, outcome: "committed", connectionClosed: true });
      throw releaseFailure;
    }
    if (failed) throw failure;
    return snapshot!;
  };
  type FailureObservation = { firstObservedAt: string; lastObservedAt: string; occurrencesInRun: number; running?: boolean };
  type Monitoring = { observeWorktree?: (identity: ClaimIdentity, root: string, target: string) => void; observePhase?: WorkerPhaseObserver; observeSelect?: (identity: ClaimIdentity, phase: WorkerObservedPhase, operationKey: string) => void; observeSuccess?: (identity: ClaimIdentity, phase: WorkerObservedPhase, operationKey?: string) => void; observeFailure?: (identity: ClaimIdentity, phase: WorkerObservedPhase, error: unknown, operationKey?: string, observedFailure?: FailureObservation) => boolean; observeRetry?: (identity: ClaimIdentity, operationKey: string, running: boolean) => void; observeDiscard?: (identity: ClaimIdentity, operationKey: string) => void; observeUnattributed?: (identity: ClaimIdentity, operationKey: string, value: boolean) => boolean };
  let monitoring: Monitoring = {};
  const pendingFailures = new Map<string, { identity: ClaimIdentity; operationKey: string; error: unknown; observedFailure: FailureObservation }>();
  const pendingIdentities = new Map<string, { identity: ClaimIdentity; operationKey: string }>();
  const identityKey = (task: ClaimIdentity): string => `${task.projectId}/${task.taskId}/${task.claimId}`;
  const markUnattributed = (task: ClaimIdentity, operationKey: string, value: boolean): void => { try { options.onUnattributed?.(task, operationKey, value); } catch { /* Optional monitoring cannot alter renewal. */ } };
  const markIdentityUnknown = (task: ClaimIdentity, operationKey: string, value: boolean): void => {
    markUnattributed(task, operationKey, value);
    const pendingKey = `${identityKey(task)}/${operationKey}`;
    try { if (monitoring.observeUnattributed?.(task, operationKey, value) === true) { pendingIdentities.delete(pendingKey); return; } } catch { /* Retain the current unattributed state. */ }
    if (value) pendingIdentities.set(pendingKey, { identity: { projectId: task.projectId, taskId: task.taskId, claimId: task.claimId }, operationKey });
    else pendingIdentities.delete(pendingKey);
  };
  const generations = new Map<string, { generation: bigint; launchId: string }>();
  const grantOperation = (task: LocalTask, kind: "grant-refresh" | "grant-ticket" | "grant-identity" | "grant-eligibility"): string | null => {
    const execution = task.webExecution;
    if (execution === null) return null;
    const identity = identityKey(task), generation = BigInt(execution.executionGeneration), previous = generations.get(identity);
    if (previous !== undefined && (generation < previous.generation || generation === previous.generation && previous.launchId !== execution.launchId)) return null;
    if (previous !== undefined && generation > previous.generation) {
      for (const oldKind of ["grant-refresh", "grant-ticket", "grant-identity", "grant-eligibility"] as const) {
        const oldOperation = `${oldKind}/${previous.generation}/${previous.launchId}`, pendingKey = `${identity}/${oldOperation}`;
        pendingFailures.delete(pendingKey); if (oldKind === "grant-identity") markIdentityUnknown(task, oldOperation, false); else markUnattributed(task, oldOperation, false);
        try { monitoring.observeDiscard?.(task, oldOperation); } catch { /* Optional monitoring cannot alter renewal. */ }
      }
    }
    generations.set(identity, { generation, launchId: execution.launchId });
    return `${kind}/${generation}/${execution.launchId}`;
  };
  const phase = (identity: ClaimIdentity, value: WorkerObservedPhase, progressed = false, deadlineAt?: number, operationKey?: string): void => observeWorkerPhase(monitoring.observePhase, identity, value, progressed, deadlineAt, operationKey);
  const success = (identity: ClaimIdentity, value: WorkerObservedPhase, operationKey?: string): void => { try { if (operationKey === undefined) monitoring.observeSuccess?.(identity, value); else monitoring.observeSuccess?.(identity, value, operationKey); } catch { /* Monitoring cannot change the operation result. */ } };
  const backgroundFailure = (task: LocalTask, error: unknown, operationKey: string): void => {
    try {
      try { if (monitoring.observeFailure?.(task, { kind: "execution", phase: "preparing" }, error, operationKey) === true) return; } catch { /* Retain the current failure until it is accepted. */ }
      const key = `${identityKey(task)}/${operationKey}`, previous = pendingFailures.get(key), at = new Date(options.now()).toISOString();
      const prior = previous?.operationKey === operationKey ? previous.observedFailure : undefined;
      pendingFailures.set(key, { identity: { projectId: task.projectId, taskId: task.taskId, claimId: task.claimId }, error, operationKey, observedFailure: { firstObservedAt: prior?.firstObservedAt ?? at, lastObservedAt: at, occurrencesInRun: Math.min(Number.MAX_SAFE_INTEGER, (prior?.occurrencesInRun ?? 0) + 1), running: prior?.running ?? false } });
      markUnattributed(task, operationKey, true);
    } catch { /* Optional monitoring cannot alter renewal. */ }
  };
  const backgroundSuccess = (task: LocalTask, operationKey: string): void => {
    const key = `${identityKey(task)}/${operationKey}`, pending = pendingFailures.get(key);
    if (pending !== undefined) { pendingFailures.delete(key); markUnattributed(task, operationKey, false); return; }
    success(task, { kind: "execution", phase: "preparing" }, operationKey);
  };
  const backgroundRetry = (task: LocalTask, running: boolean): void => {
    const operationKey = grantOperation(task, "grant-refresh"); if (operationKey === null) return;
    const pending = pendingFailures.get(`${identityKey(task)}/${operationKey}`);
    if (pending !== undefined) pending.observedFailure.running = running;
    else try { monitoring.observeRetry?.(task, operationKey, running); } catch { /* Optional monitoring cannot alter renewal. */ }
  };
  try { options.launcher.setGrantObserver?.({
    started: task => backgroundRetry(task, true),
    settled: task => backgroundRetry(task, false),
    checked: task => { const operationKey = grantOperation(task, "grant-eligibility"); if (operationKey !== null) backgroundSuccess(task, operationKey); },
    refreshed: task => { const operationKey = grantOperation(task, "grant-refresh"); if (operationKey !== null) backgroundSuccess(task, operationKey); },
    failed: (task, error, started) => { const operationKey = grantOperation(task, started ? "grant-refresh" : "grant-eligibility"); if (operationKey !== null) backgroundFailure(task, error, operationKey); },
    ticketFailed: (task, error) => { const operationKey = grantOperation(task, "grant-ticket"); if (operationKey !== null) backgroundFailure(task, error, operationKey); },
    ticketVerified: task => { const operationKey = grantOperation(task, "grant-ticket"); if (operationKey !== null) backgroundSuccess(task, operationKey); },
    identityUnknown: task => { const operationKey = grantOperation(task, "grant-identity"); if (operationKey !== null) markIdentityUnknown(task, operationKey, true); },
    identityResolved: task => { const operationKey = grantOperation(task, "grant-identity"); if (operationKey !== null) markIdentityUnknown(task, operationKey, false); },
    identityLost: task => { try { monitoring.observeSelect?.(task, { kind: "execution", phase: "preparing" }, "grant-identity-lost"); } catch { /* Optional monitoring cannot alter identity handling. */ } },
  }); } catch { /* Optional monitoring cannot alter execution. */ }
  const refreshGrant = async (task: LocalTask, ticket: ControllerLaunchTicket, signal: AbortSignal): Promise<void> => {
    const operationKey = grantOperation(task, "grant-refresh"), eligibilityKey = grantOperation(task, "grant-eligibility");
    if (eligibilityKey !== null) try { monitoring.observeSelect?.(task, { kind: "execution", phase: "preparing" }, eligibilityKey); } catch { /* Optional monitoring cannot alter renewal. */ }
    let started = false;
    try {
      await options.launcher.refreshGrant(task, ticket, signal, () => { if (operationKey !== null) success(task, { kind: "execution", phase: "preparing" }, operationKey); }, () => { started = true; if (operationKey !== null) { phase(task, { kind: "execution", phase: "preparing" }, false, undefined, operationKey); backgroundRetry(task, true); } });
    } finally { if (started) backgroundRetry(task, false); }
  };
  const prepareTicket = async (task: LocalTask, prompt: string | (() => string), signal: AbortSignal, canAdmitNewExecution?: () => boolean): Promise<ControllerLaunchTicket> => {
    phase(task, { kind: "execution", phase: "agent-start" }, false, undefined, "web-ticket");
    const ticket = await options.launcher.prepare(task, prompt, signal, canAdmitNewExecution);
    success(task, { kind: "execution", phase: "agent-start" }, "web-ticket");
    return ticket;
  };
  const request = options.request ?? requestController;
  const observeExecutionStop = createWebStopObserver({ ...options, confirmStopped: confirmWithLease });
  const waiting = new Map<string, WebInputWaitingReason>();
  const upgrades = new Set<string>();
  const rejected = new Map<string, string>();
  const signature = (task: LocalTask, tuple: WorkerPromptTuple): string => JSON.stringify([tuple.user.revision, tuple.project.revision, tuple.worker.revision, task.configuration]);
  const current = (task: LocalTask): LocalTask => { const latest = options.store.getTask(task); if (latest === null || taskAgentControlMode(latest) !== "web") throw new Error("The frozen Web execution disappeared."); return latest; };
  const journal = (task: LocalTask): string => path.join(controllerExecutionDirectory(options.homeDirectory, task.webExecution!.executionId), "journal.sqlite");
  const autoInput = createWebInput({
    current, buildPrompt: task => options.buildPrompt(task, options.platform), request,
    currentSnapshot: (task, ticket) => readCurrentControllerSnapshot(journal(task), ticket),
    initialSnapshot: (task, ticket) => readCompatibleControllerSnapshot(journal(task), ticket),
    ...(options.promptSource === undefined ? {} : { promptSource: options.promptSource }),
    ...(options.preparePromptSource === undefined ? {} : { preparePromptSource: options.preparePromptSource }),
    readOperation: (task, operationId, ticket) => readCompatibleControllerOperation(journal(task), ticket, operationId), now: options.now,
    report: (task, error) => options.emit({ kind: "web-input-error", task, message: error.message, error }),
    event: (task, event) => options.emit({ kind: "web-input", task, message: JSON.stringify(event) }),
  });
  const recoverySelection = async (task: LocalTask, ticket: ControllerLaunchTicket) => {
    if (task.configuration!.agent === "claude") return undefined;
    const selected = task.configuration!.toolLaunch ?? await readLaunchToolSelection(options.homeDirectory, ticket);
    if (selected === undefined) throw new ToolSelectionError(task.configuration!.agent, "web", "launch", "legacy_tool_identity_missing");
    return selected;
  };
  const remember = (input: LocalTask, snapshot: ControllerSnapshot, authenticated = true): LocalTask => {
    let task = current(input);
    if (!matchesGeneration(task, snapshot)) throw new Error("Controller observation does not match the original execution generation.");
    if (snapshot.startup !== undefined) options.store.observeStartup(task, parseStartupObservation(snapshot.startup), options.now());
    task = options.store.updateWebExecution(task, { ...(authenticated ? { launchSubmission: "acknowledged" as const } : {}), initialInputState: snapshot.initialInputState, activity: snapshot.activity, controllerProcess: snapshot.controllerProcess ?? task.webExecution!.controllerProcess, nativeProcesses: snapshot.nativeProcesses }, options.now());
    if (snapshot.nativeSessionId !== null) task = options.store.bindNativeSession(task, { source: "controller", sessionId: snapshot.nativeSessionId }, options.now());
    return task;
  };
  const protocol = (response: Awaited<ReturnType<typeof request>>): 1 | undefined => {
    if (Object.hasOwn(response, "workerInputProtocol") && response.workerInputProtocol !== 1) throw new ControllerIpcIdentityConflictError("Controller Worker input protocol is unsupported.");
    return response.workerInputProtocol;
  };
  const applyInput = async (task: LocalTask, ticket: ControllerLaunchTicket, snapshot: ControllerSnapshot, capability: 1 | undefined, signal: AbortSignal, authority?: WebInputAuthority): Promise<LocalTask> => {
    const outcome = await autoInput.step({ task, ticket, snapshot, protocol: capability, signal, legacyAuthority: authority ?? (async () => "claim_invalid") });
    task = remember(task, outcome.snapshot);
    if (outcome.kind === "waiting") waiting.set(task.claimId, outcome.reason);
    else if (outcome.kind === "upgrade") upgrades.add(task.claimId);
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
  const originalSnapshot = (task: LocalTask, ticket: ControllerLaunchTicket, deadline?: number): ControllerSnapshot & { controllerProcess: ProcessProof } => {
    const execution = task.webExecution;
    if (execution === null || ticket.launchId !== execution.launchId || ticket.executionId !== execution.executionId || ticket.controllerId !== execution.controllerId
      || ticket.sessionId !== execution.sessionId || ticket.executionGeneration !== execution.executionGeneration || ticket.controllerInstanceId !== execution.controllerInstanceId
      || ticket.serverOrigin !== task.serverOrigin || ticket.projectId !== task.projectId || ticket.taskId !== task.taskId || ticket.claimId !== task.claimId
      || ticket.workerId !== task.workerId || ticket.worktreeId !== task.worktreeId || ticket.userId !== task.userId) throw new ControllerLaunchJournalConflictError("The original controller ticket conflicts with its Web execution.");
    const saved = readCompatibleControllerSnapshot(journal(task), ticket, deadline);
    if (saved === null || saved.testExecutionId !== undefined || !matchesGeneration(task, saved) || saved.controllerProcess === null || execution.controllerProcess === null
      || !preservesControllerProcessProof(execution.controllerProcess, saved.controllerProcess, ticket.launchId)
      || !preservesNativeProcessPrefix(execution.nativeProcesses, saved.nativeProcesses)) throw new ControllerLaunchJournalConflictError("The original controller generation or process evidence is unavailable.");
    return { ...saved, controllerProcess: saved.controllerProcess };
  };
  const stopLegacyController = async (task: LocalTask, ticket: ControllerLaunchTicket, signal: AbortSignal): Promise<LocalTask> => {
    try {
      originalSnapshot(current(task), ticket, Date.now() + 10_000);
      const stopped = await backend.cleanup(task, { kind: "shutdown", immediateStop: true, deadline: options.now() + CLEANUP_OPERATION_MS, signal });
      if (!stopped.complete) throw new Error("Original Controller cleanup remains incomplete.");
      waiting.set(task.claimId, "native_input");
      return options.store.clearShutdown(stopped.task, options.now());
    } catch (cause) {
      signal.throwIfAborted();
      const failure = new LegacyWorkerControllerError(ticket, { cause });
      options.store.pauseRecovery(current(task), failure.message, options.now(), "recovery_blocked");
      throw failure;
    }
  };
  const verifyRecoverableInitial = async (task: LocalTask, ticket: ControllerLaunchTicket, observed: ControllerSnapshot, capability: 1 | undefined, recoveryCapability: 1 | undefined): Promise<ControllerSnapshot | null> => {
    const execution = task.webExecution;
    if (recoveryCapability !== 1) throw new Error("The original Controller does not advertise safe recovered initial input; its execution is retained.");
    if (execution === null || capability !== 1 || task.configuration === null || task.resources.worktree === null
      || task.resources.nativeSession === null || ticket.cwd !== task.resources.worktree.worktreePath
      || ticket.provider !== task.configuration.agent || !matchesLaunchConfiguration(ticket.configuration, task.configuration)
      || ticket.initialOperationId !== execution.initialOperationId || ticket.initialPrompt !== execution.initialPrompt
      || ticket.resumeNativeSessionId !== task.resources.nativeSession.sessionId || !recoveringInitialGeneration(task, observed)) {
      throw new Error("Recovering the original initial input requires the original launch, native identity and queued input protocol.");
    }
    try {
      const saved = originalSnapshot(task, ticket);
      const evidence = await readRecoverableInitialInput(journal(task), ticket, options.homeDirectory);
      if (!recoveringInitialGeneration(task, evidence.snapshot) || !preservesControllerEvidence(saved, evidence.snapshot, ticket.launchId)
        || !preservesControllerEvidence(evidence.snapshot, observed, ticket.launchId)) {
        throw new Error("The original initial input journal conflicts with the current Controller observation.");
      }
      return evidence.snapshot;
    } catch (error) {
      // A prior IPC may cross the durable dispatch boundary after observe. Wait
      // for a fresh authenticated observation instead of pausing or resending.
      const latest = originalSnapshot(task, ticket);
      if (["dispatching", "provider_accepted", "confirmed", "failed", "unknown"].includes(latest.initialInputState)
        && recoveringInitialGeneration(task, { ...latest, initialInputState: "not_submitted" })
        && preservesControllerEvidence(observed, latest, ticket.launchId)) return null;
      throw error;
    }
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
  const verifyWorktree = async (task: LocalTask, signal: AbortSignal, allowWorktreeRestore = true): Promise<LocalTask> => {
    try {
      const project = { projectId: task.projectId, repoUrl: task.repoUrl, localPath: task.repositoryPath };
      phase(task, { kind: "execution", phase: "worktree-preparation" });
      const preparing = task.resources.worktree === null;
      const original = task.resources.worktree;
      if (preparing && task.webExecution !== null && (task.webExecution.launchSubmission !== "not-submitted" || task.webExecution.controllerProcess !== null || task.webExecution.nativeProcesses.length > 0)) throw new Error("An already started Web execution has no original worktree binding.");
      let allowRestore = task.webExecution === null;
      const admitRestore = async (): Promise<void> => {
        if (!allowWorktreeRestore) throw new ConfigurationAdmissionWaiting();
        const execution = task.webExecution;
        let ticket: ControllerLaunchTicket | undefined;
        if (execution !== null) {
          try { ticket = await readLaunchTicket(options.homeDirectory, execution.launchId); }
          catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || execution.ticketPath !== null || execution.launchSubmission !== "not-submitted") throw error;
          }
          if (ticket !== undefined && original === null) throw new Error("The original Web ticket has no worktree binding.");
          if (ticket !== undefined && (ticket.launchId !== execution.launchId || ticket.executionId !== execution.executionId || ticket.sessionId !== execution.sessionId || ticket.executionGeneration !== execution.executionGeneration
            || ticket.controllerInstanceId !== execution.controllerInstanceId || ticket.controllerId !== execution.controllerId || ticket.claimId !== task.claimId
            || ticket.projectId !== task.projectId || ticket.taskId !== task.taskId || ticket.workerId !== task.workerId || ticket.worktreeId !== task.worktreeId
            || ticket.userId !== task.userId || ticket.serverOrigin !== task.serverOrigin || ticket.provider !== task.configuration?.agent
            || ticket.cwd !== original!.worktreePath || ticket.initialOperationId !== execution.initialOperationId || ticket.initialPrompt !== execution.initialPrompt
            || execution.nativeHome !== null && ticket.nativeHome !== execution.nativeHome
            || BigInt(execution.executionGeneration) > 1n && ticket.resumeNativeSessionId !== task.resources.nativeSession?.sessionId
            || task.configuration === null || !matchesLaunchConfiguration(ticket.configuration, task.configuration))) throw new Error("The original Web ticket conflicts with its worktree binding.");
        }
        const observation = await workerOperation(operation => observeExecutionStop(task, operation), signal);
        if (observation.kind !== "not-started" && observation.kind !== "stopped") throw new Error("The original Web processes have not been confirmed stopped; the worktree cannot be restored.", observation.kind === "unknown" ? { cause: observation.error } : undefined);
        if (execution !== null && execution.launchSubmission !== "not-submitted") {
          if (ticket === undefined || execution.controllerProcess === null) throw new Error("The original Web launch identity is unavailable; the worktree cannot be restored.");
          const saved = readCurrentControllerSnapshot(journal(task), ticket);
          if (!matchesGeneration(task, saved) || saved.controllerProcess === null || !preservesControllerProcessProof(execution.controllerProcess, saved.controllerProcess, ticket.launchId)
            || !preservesNativeProcessPrefix(execution.nativeProcesses, saved.nativeProcesses) || task.resources.nativeSession !== null && saved.nativeSessionId !== task.resources.nativeSession.sessionId) throw new Error("The original Web process evidence conflicts; the worktree cannot be restored.");
          if (!await confirmWithLease(ticket.launchId, saved.controllerProcess, saved.nativeProcesses, undefined, saved, ticket)) throw new Error("The original Web process tree remains active; the worktree cannot be restored.");
          signal.throwIfAborted();
          if (JSON.stringify(readCurrentControllerSnapshot(journal(task), ticket)) !== JSON.stringify(saved)) throw new Error("The original Web journal changed during worktree restore verification.");
        }
        allowRestore = true;
      };
      if (preparing && task.webExecution !== null) await admitRestore();
      if (original !== null && task.webExecution !== null) {
        let missing = false;
        try { await lstat(original.worktreePath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; missing = true; }
        if (missing) await admitRestore();
      }
      const prepare = () => workerOperation(operation => options.git.prepareWorktree(project, task, operation, original?.worktreePath, original !== null || task.webExecution?.launchSubmission !== undefined && task.webExecution.launchSubmission !== "not-submitted", original ?? undefined, allowRestore), signal, 180_000);
      let verified;
      try { verified = await prepare(); }
      catch (error) {
        if (!(error instanceof WorktreeRestoreRequiredError) || allowRestore) throw error;
        await admitRestore();
        verified = await prepare();
      }
      if (preparing) task = options.store.bindWorktree(task, verified, options.now());
      else {
        if (original === null || !await sameWorktreeLocation(verified.worktreePath, original.worktreePath) || !await sameWorktreeLocation(verified.repositoryPath, original.repositoryPath) || !await sameWorktreeLocation(verified.commonDirectory, original.commonDirectory) || verified.branch !== original.branch) throw new Error("The original Web worktree binding differs from its manifest.");
        task = current(task);
      }
      try { if (task.resources.worktree !== null) monitoring.observeWorktree?.(task, task.repositoryPath, task.resources.worktree.worktreePath); } catch { /* Optional monitoring cannot alter worktree preparation. */ }
      success(task, { kind: "execution", phase: "worktree-preparation" });
      if (preparing) phase(task, { kind: "execution", phase: "worktree-preparation" }, true);
      return task;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ConfigurationAdmissionWaiting) throw error;
      const failure = error instanceof WorktreePreconditionError ? error : new WorktreePreconditionError("validation_failed", error instanceof Error ? error.message : String(error), { cause: error });
      options.store.blockOrchestration(task, { source: "worktree", code: failure.code, message: failure.message }, options.now());
      throw failure;
    }
  };
  const resumeOrchestration = async (original: LocalTask, blocker: OrchestrationBlocker, signal: AbortSignal, authority?: WebInputAuthority, allowWorktreeRestore = true): Promise<{ task: LocalTask; live: boolean }> => {
    let task = current(original);
    const legacyReport = blocker.source === "legacy_worktree" ? original.webExecution?.startupReport : undefined;
    const correctLegacyLatch = blocker.source === "legacy_worktree" && !task.recovery.retryAuthorized;
    if (!sameOrchestrationIdentity(task, blocker)) throw new Error("The orchestration block belongs to another original execution.");
    task = await verifyWorktree(task, signal, allowWorktreeRestore);
    const execution = task.webExecution;
    if (execution === null || execution.launchSubmission === "not-submitted") return { task: options.store.clearOrchestration(task, blocker, null, options.now()), live: false };
    phase(task, { kind: "execution", phase: "preparing" }, false, undefined, "web-orchestration-ticket");
    if (execution.ticketPath === null) throw new Error("Orchestration verification cannot replace missing launch evidence.");
    const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId);
    if (ticket.executionId !== execution.executionId || ticket.sessionId !== execution.sessionId || ticket.executionGeneration !== execution.executionGeneration
      || ticket.controllerInstanceId !== execution.controllerInstanceId || ticket.controllerId !== execution.controllerId || ticket.claimId !== task.claimId
      || ticket.projectId !== task.projectId || ticket.taskId !== task.taskId || ticket.workerId !== task.workerId || ticket.worktreeId !== task.worktreeId
      || ticket.userId !== task.userId || ticket.serverOrigin !== task.serverOrigin || ticket.provider !== task.configuration?.agent
      || ticket.cwd !== task.resources.worktree!.worktreePath || ticket.initialOperationId !== execution.initialOperationId || ticket.initialPrompt !== execution.initialPrompt
      || !matchesLaunchConfiguration(ticket.configuration, task.configuration!)) throw new Error("Orchestration verification found conflicting original launch ownership.");
    success(task, { kind: "execution", phase: "preparing" }, "web-orchestration-ticket");
    phase(task, { kind: "execution", phase: "agent-observation" });
    const saved = originalSnapshot(task, ticket);
    const firstNativeObservation = blocker.source !== "legacy_worktree" && execution.executionGeneration === "1" && task.resources.nativeSession === null;
    if (saved === null || !matchesGeneration(task, saved) || (!firstNativeObservation && (saved.nativeSessionId === null || saved.nativeSessionId !== task.resources.nativeSession?.sessionId))
      || saved.controllerProcess === null || execution.controllerProcess === null || !preservesControllerProcessProof(execution.controllerProcess, saved.controllerProcess, ticket.launchId)
      || !preservesNativeProcessPrefix(execution.nativeProcesses, saved.nativeProcesses)) throw new Error("Orchestration verification requires original generation and process evidence.");
    let observed: ControllerSnapshot | null = null;
    let capability: 1 | undefined;
    let recoveryCapability: 1 | undefined, legacy = false;
    phase(task, { kind: "execution", phase: "agent-observation" });
    try { const response = await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 }); capability = protocol(response); recoveryCapability = response.recoveredInitialInputProtocol; legacy = response.workerLifecycleProtocol === 1; observed = response.snapshot; }
    catch (error) { signal.throwIfAborted(); if (correctLegacyLatch || error instanceof ControllerIpcIdentityConflictError) throw error; }
    if (legacy) return { task: await stopLegacyController(task, ticket, signal), live: true };
    if (observed !== null && !matchesGeneration(task, observed)) throw new Error("Orchestration verification found a conflicting controller generation.");
    const initialOperation = blocker.source !== "legacy_worktree" && observed !== null && BigInt(execution.executionGeneration) > 1n
      && ["dispatching", "unknown"].includes(observed.initialInputState)
      ? readCompatibleControllerOperation(journal(task), ticket, ticket.initialOperationId) : null;
    const recoveredInitial = blocker.source !== "legacy_worktree" && observed !== null && recoveringInitialGeneration(task, observed);
    if (recoveredInitial && await verifyRecoverableInitial(task, ticket, observed!, capability, recoveryCapability) === null) {
      waiting.set(task.claimId, "native_input");
      return { task, live: true };
    }
    const initialContinuation = blocker.source !== "legacy_worktree" && observed !== null && (continuingOriginalGeneration(task, observed, initialOperation) || recoveredInitial);
    const liveObservation = observed !== null && (healthyOriginalGeneration(task, observed) || initialContinuation);
    if (observed !== null && !preservesControllerEvidence(saved, observed, ticket.launchId)) throw new Error("The native observation conflicts with the original controller journal.");
    if (observed !== null && execution.controllerProcess !== null) await jobLeases.retain(ticket.launchId, execution.controllerProcess, Date.now() + 10_000);
    if (observed !== null && ((!firstNativeObservation && observed.nativeSessionId !== task.resources.nativeSession?.sessionId)
      || ((observed.lifecycle === "ready" || observed.lifecycle === "working") && !liveObservation))) throw new Error("Orchestration verification found conflicting original native evidence.");
    const unusedRetry = task.recovery.retryAuthorized && task.recovery.pauseReason !== null;
    if (unusedRetry || execution.restartAfterShutdown || observed === null || !liveObservation) {
      const stopped = await confirmWithLease(task.webExecution!.launchId, saved.controllerProcess, saved.nativeProcesses, undefined, saved);
      if (correctLegacyLatch || !stopped) {
        if (observed !== null && ["paused", "failed", "stopped", "stopping"].includes(observed.lifecycle)) options.store.pauseRecovery(task, observed.error ?? "The native controller is paused or stopped.", options.now(), "recovery_blocked");
        throw new Error("Orchestration verification could not confirm the healthy original native identity or complete process stop.");
      }
      const stoppedSnapshot = await recordWithLease(journal(task), ticket, undefined, true);
      if (!matchesGeneration(task, stoppedSnapshot) || stoppedSnapshot.lifecycle !== "stopped" || !stoppedSnapshot.nativeStopped || stoppedSnapshot.stoppedAt === null
        || !preservesControllerEvidence(saved, stoppedSnapshot, ticket.launchId)
        || (observed !== null && !preservesControllerEvidence(observed, stoppedSnapshot, ticket.launchId))) throw new Error("The stopped native observation conflicts with the original controller evidence.");
      await jobLeases.release(ticket.launchId);
      task = await verifyWorktree(task, signal, allowWorktreeRestore);
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
    task = await verifyWorktree(task, signal, allowWorktreeRestore);
    const initialEvidence = recoveredInitial ? await verifyRecoverableInitial(task, ticket, observed, capability, recoveryCapability) : undefined;
    if (initialEvidence === null) { waiting.set(task.claimId, "native_input"); return { task, live: true }; }
    task = options.store.clearOrchestration(task, blocker, observed, options.now(), legacyReport, initialOperation, initialEvidence);
    task = remember(task, observed);
    if (task.recovery.retryAuthorized) task = options.store.completeRecoveryRetry(task, observed, options.now());
    if (observed.lifecycle === "ready" || observed.lifecycle === "working") success(task, { kind: "execution", phase: "agent-observation" });
    await refreshGrant(task, ticket, signal);
    task = await applyInput(task, ticket, observed, capability, signal, authority);
    return { task, live: true };
  };
  const backend = {
    observeStartupReport,
    advance: async (original: LocalTask, signal: AbortSignal, admission?: () => boolean, authority?: WebInputAuthority, allowWorktreeRestore = true): Promise<LocalTask> => {
      let task = current(original);
      waiting.delete(task.claimId);
      upgrades.delete(task.claimId);
      const canAdmitNewExecution = () => {
        const latest = current(task), execution = latest.webExecution;
        if (execution !== null && (execution.executionGeneration !== "1" || execution.launchSubmission !== "not-submitted"
          || execution.controllerProcess !== null || execution.nativeProcesses.length > 0 || latest.resources.nativeSession !== null
          || readControllerSnapshot(journal(latest)) !== null)) return true;
        return admission?.() ?? true;
      };
      if (task.cleanup !== null || task.control !== null || task.configuration === null) throw new Error("Ordinary Web execution is fenced by cleanup or management.");
      if (legacyBranchLatch(task)) {
        phase(task, { kind: "execution", phase: "preparing" }, false, undefined, "web-legacy-provenance");
        await verifyLegacyBranchProvenance(options.homeDirectory, task, signal);
        success(task, { kind: "execution", phase: "preparing" }, "web-legacy-provenance");
        const blocker = options.store.blockOrchestration(task, { source: "legacy_worktree", code: "branch_mismatch", message: task.recovery.pauseReason! }, options.now());
        return (await resumeOrchestration(task, blocker, signal, authority, allowWorktreeRestore)).task;
      }
      if (task.recovery.pauseReason !== null && !task.recovery.retryAuthorized) return task;
      const blocker = options.store.getOrchestrationBlocker(task);
      if (blocker !== null) {
        const result = await resumeOrchestration(task, blocker, signal, authority, allowWorktreeRestore);
        task = result.task;
        if (result.live) return task;
      }
      const retryAttempt = task.recovery.retryAuthorized;
      let recovering = retryAttempt;
      let capturedSignature: string | null = null;
      const pause = (error: unknown): LocalTask => options.store.pauseRecovery(task, error instanceof Error ? error.message : String(error), options.now(), error instanceof WebRecoveryBlockedError ? error.reasonCode : undefined);
      try {
        if (!allowWorktreeRestore) task = await verifyWorktree(task, signal, false);
        if (!allowWorktreeRestore && !retryAttempt && task.webExecution !== null && task.webExecution.launchSubmission === "not-submitted" && BigInt(task.webExecution.executionGeneration) > 1n) {
          const execution = task.webExecution, previous = readControllerSnapshot(journal(task));
          if (previous === null || previous.controllerProcess === null || previous.lifecycle !== "stopped" || !previous.nativeStopped || previous.stoppedAt === null
            || execution.controllerProcess !== null || execution.nativeProcesses.length !== 0 || previous.executionId !== execution.executionId || previous.claimId !== task.claimId
            || previous.sessionId !== execution.sessionId || String(BigInt(previous.executionGeneration) + 1n) !== execution.executionGeneration
            || previous.controllerInstanceId === execution.controllerInstanceId || previous.nativeSessionId === null || previous.nativeSessionId !== task.resources.nativeSession?.sessionId)
            throw new Error("Unsubmitted recovery requires the exact preceding stopped generation and original launch evidence.");
          if (!await confirmWithLease(previousLaunchId(previous.controllerProcess, execution.launchId), previous.controllerProcess, previous.nativeProcesses, undefined, previous)) throw new Error("Unsubmitted recovery requires complete original controller and native process stop.");
          signal.throwIfAborted();
          if (JSON.stringify(readControllerSnapshot(journal(task))) !== JSON.stringify(previous)) throw new Error("The original stopped generation changed during unsubmitted recovery verification.");
        }
        if (task.webExecution !== null && task.webExecution.launchSubmission === "unknown" && (retryAttempt || task.recovery.count >= task.configuration!.recoveryLimit)) {
          const execution = task.webExecution;
          if (execution.controllerProcess === null) throw new Error("The submitted controller has no original spawn proof; its launch is retained.");
          const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId);
          const observation = await reconcileSubmittedControllerLaunch({ journalFile: journal(task), ticket, spawnProof: execution.controllerProcess, signal });
          if (observation.kind === "running-unobserved") throw new Error("The original controller is still running without authenticated observation; its launch is retained.");
          if (observation.kind === "unknown") throw new Error("The original controller process status is unknown; its launch is retained.", { cause: observation.cause });
          if (observation.kind === "pre-writer-exited") return pause(new WebRecoveryBlockedError("native_identity_missing", `The original controller exited before committing its generation (${observation.journal}); its launch is retained.`));
          if (observation.kind === "observed") { await jobLeases.retain(ticket.launchId, execution.controllerProcess, Date.now() + 10_000); task = remember(task, observation.snapshot); }
        }
        if (retryAttempt && task.recovery.pauseReason !== null) {
          phase(task, { kind: "execution", phase: "preparing" }, false, undefined, "web-recovery-proof");
          // Authorization permits one replacement generation only after proving the old writer stopped.
          if (task.webExecution === null || task.resources.nativeSession === null) throw new WebRecoveryBlockedError("native_identity_missing", "Web retry requires the original native session identity.");
          if (task.webExecution.launchSubmission === "not-submitted" && BigInt(task.webExecution.executionGeneration) > 1n) {
            // Preparation may fail after allocating a generation but before any writer is launched.
            const previous = readControllerSnapshot(journal(task));
            if (previous === null || previous.controllerProcess === null || previous.lifecycle !== "stopped" || !previous.nativeStopped || previous.stoppedAt === null) throw new Error("Unsubmitted recovery requires the original complete stopped generation evidence.");
            const execution = task.webExecution;
            if (execution.controllerProcess !== null || execution.nativeProcesses.length !== 0 || previous.executionId !== execution.executionId || previous.claimId !== task.claimId || previous.sessionId !== execution.sessionId || String(BigInt(previous.executionGeneration) + 1n) !== execution.executionGeneration || previous.controllerInstanceId === execution.controllerInstanceId || previous.nativeSessionId === null || previous.nativeSessionId !== task.resources.nativeSession.sessionId) throw new Error("Unsubmitted recovery requires the exact preceding generation and original launch evidence.");
            if (!await confirmWithLease(previousLaunchId(previous.controllerProcess, task.webExecution!.launchId), previous.controllerProcess, previous.nativeProcesses, undefined, previous)) throw new Error("Unsubmitted recovery requires complete original controller and native process stop.");
            signal.throwIfAborted();
            if (JSON.stringify(readControllerSnapshot(journal(task))) !== JSON.stringify(previous)) throw new Error("The original stopped generation changed during unsubmitted recovery verification.");
            if (!allowWorktreeRestore) task = await verifyWorktree(task, signal, false);
            signal.throwIfAborted();
            if (JSON.stringify(readControllerSnapshot(journal(task))) !== JSON.stringify(previous)) throw new Error("The original stopped generation changed before retry authorization consumption.");
            // Consume authorization only after proving the predecessor stopped.
            task = options.store.retryUnsubmittedWebGeneration(task, previous, options.now());
            const retryTicket = await prepareTicket(task, task.webExecution!.initialPrompt!, signal);
            prepareControllerLaunchStorage(options.homeDirectory, retryTicket);
          } else {
            const saved = originalSnapshot(task, await readLaunchTicket(options.homeDirectory, task.webExecution!.launchId));
            if (saved.nativeSessionId === null || saved.nativeSessionId !== task.resources.nativeSession.sessionId) throw new WebRecoveryBlockedError("native_identity_missing", "Web retry requires the original native session identity.");
            task = remember(task, saved, false);
            const proof = task.webExecution!.controllerProcess;
            if (proof === null || !await confirmWithLease(task.webExecution!.launchId, proof, task.webExecution!.nativeProcesses, undefined, saved)) throw new Error("Web retry requires complete original controller and native process stop.");
            const ticket = await readLaunchTicket(options.homeDirectory, task.webExecution!.launchId);
            const toolLaunch = await recoverySelection(task, ticket);
            const stopped = await recordWithLease(journal(task), ticket, undefined, true);
            await jobLeases.release(ticket.launchId);
            if (!allowWorktreeRestore) task = await verifyWorktree(task, signal, false);
            task = options.store.beginWebGeneration(task, stopped, options.now(), toolLaunch);
          }
          success(task, { kind: "execution", phase: "preparing" }, "web-recovery-proof");
        } else if (!retryAttempt && task.webExecution !== null && task.webExecution.launchSubmission !== "not-submitted" && task.recovery.count >= task.configuration!.recoveryLimit) {
          // Older versions recorded exhaustion without a pause. Inspect before any launch preparation.
          try {
            const saved = originalSnapshot(task, await readLaunchTicket(options.homeDirectory, task.webExecution!.launchId));
            task = remember(task, saved, false);
            const proof = task.webExecution!.controllerProcess;
            if (proof === null) throw new Error("The exhausted execution has no complete original process stop evidence.");
            const stopped = await confirmWithLease(task.webExecution!.launchId, proof, task.webExecution!.nativeProcesses, undefined, saved);
            if (stopped) {
              if (!task.webExecution!.restartAfterShutdown || saved.error !== null) return pause(new WebRecoveryBlockedError("recovery_limit", "The execution recovery budget is exhausted."));
            } else {
              if (["stopped", "stopping", "failed", "paused"].includes(saved.lifecycle)) throw new Error("The exhausted execution is stopped or failed, but complete original process stop is unproven.");
              const ticket = await readLaunchTicket(options.homeDirectory, task.webExecution!.launchId);
              const response = await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 });
              if (response.workerLifecycleProtocol === 1) return await stopLegacyController(task, ticket, signal);
              const observed = response.snapshot;
              if (observed.lifecycle !== "ready" && observed.lifecycle !== "working" && observed.lifecycle !== "starting") throw new Error(observed.error ?? "The exhausted controller is not healthy.");
              await jobLeases.retain(ticket.launchId, proof, Date.now() + 10_000);
              task = remember(task, observed);
            }
          } catch (error) { signal.throwIfAborted(); return pause(error); }
        }
        task = await verifyWorktree(task, signal, allowWorktreeRestore);
        assertConfigurationAdmission(canAdmitNewExecution);
        task = options.store.initializeWebExecution(task, options.now());
        if (task.webExecution!.initialPrompt === null && options.promptSource !== undefined) {
          if (options.preparePromptSource !== undefined) {
            phase(task, { kind: "execution", phase: "preparing" }, false, undefined, "web-prompt-source");
            await options.preparePromptSource(task.projectId, signal);
            success(task, { kind: "execution", phase: "preparing" }, "web-prompt-source");
          }
          const tuple = options.promptSource.current(task.projectId);
          if (tuple === null) { waiting.set(task.claimId, "prompt_unknown"); return task; }
          if (rejected.get(task.claimId) === signature(task, tuple)) { waiting.set(task.claimId, "prompt_too_large"); return task; }
        }
        const preparedTask = task;
        const makePrompt = (): string => {
          phase(preparedTask, { kind: "execution", phase: "preparing" }, false, undefined, "web-prompt-build");
          const tuple = options.promptSource?.current(preparedTask.projectId);
          if (options.promptSource !== undefined && tuple == null) throw new PromptUnknownError();
          if (tuple != null) capturedSignature = signature(preparedTask, tuple);
          const builtin = options.buildPrompt(preparedTask, options.platform);
          const result = tuple == null ? builtin : appendWorkerPrompts(builtin, tuple);
          success(preparedTask, { kind: "execution", phase: "preparing" }, "web-prompt-build");
          phase(preparedTask, { kind: "execution", phase: "agent-start" }, false, undefined, "web-ticket");
          return result;
        };
        const prompt = task.webExecution!.initialPrompt ?? (options.promptSource === undefined ? makePrompt() : makePrompt);
        assertConfigurationAdmission(canAdmitNewExecution);
        let ticket = await prepareTicket(task, prompt, signal, canAdmitNewExecution);
        rejected.delete(task.claimId);
        task = current(task);
        const wasUnsubmitted = task.webExecution?.launchSubmission === "not-submitted";
        phase(task, { kind: "execution", phase: "agent-start" });
        await options.launcher.launch(task, ticket, signal, canAdmitNewExecution);
        task = current(task);
        if (wasUnsubmitted && task.webExecution?.launchSubmission !== "not-submitted") { success(task, { kind: "execution", phase: "agent-start" }); phase(task, { kind: "execution", phase: "agent-start" }, true); }
        let snapshot: ControllerSnapshot;
        let capability: 1 | undefined;
        let recoveryCapability: 1 | undefined;
        let capabilityObserved = false;
        phase(task, { kind: "execution", phase: "agent-observation" });
        try {
          const response = await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 });
          if (response.workerLifecycleProtocol === 1) return await stopLegacyController(task, ticket, signal);
          capability = protocol(response); recoveryCapability = response.recoveredInitialInputProtocol; capabilityObserved = true; snapshot = response.snapshot;
        }
        catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof ControllerIpcOutcomeUnknownError)) throw error;
          const spawnProof = task.webExecution!.controllerProcess;
          if (spawnProof === null) throw new Error("The submitted controller has no original spawn proof; its launch is retained.", { cause: error });
          const observation = await reconcileSubmittedControllerLaunch({ journalFile: journal(task), ticket, spawnProof, signal });
          if (observation.kind === "observed") {
            if (observation.workerLifecycleProtocol === 1) return await stopLegacyController(task, ticket, signal);
            snapshot = observation.snapshot;
          } else {
          if (observation.kind === "running-unobserved") throw new Error("The original controller is still running without authenticated observation; its launch is retained.", { cause: error });
          if (observation.kind === "unknown") throw new Error("The original controller process status is unknown; its launch is retained.", { cause: observation.cause });
          if (observation.kind === "pre-writer-exited") return pause(new WebRecoveryBlockedError("native_identity_missing", `The original controller exited before committing its generation (${observation.journal}); its launch is retained.`, { cause: error }));
          // A retry never grants a second generation when its first observation fails.
          if (retryAttempt) throw error;
          phase(task, { kind: "execution", phase: "preparing" }, false, undefined, "web-recovery-proof");
          const saved = observation.snapshot;
          task = remember(task, saved, false);
          const proof = task.webExecution!.controllerProcess;
          if (proof === null || !await confirmWithLease(task.webExecution!.launchId, proof, task.webExecution!.nativeProcesses, undefined, saved)) throw new Error("The original controller is unreachable; its native writer may still be alive and will not be replaced.", { cause: error });
          if (saved.nativeSessionId === null) throw new WebRecoveryBlockedError("native_identity_missing", "The stopped native launch has no proven session identity; recovery cannot create another conversation.");
          const toolLaunch = await recoverySelection(task, ticket);
          const stopped = await recordWithLease(journal(task), ticket, undefined, true);
          await jobLeases.release(ticket.launchId);
          if (!allowWorktreeRestore) task = await verifyWorktree(task, signal, false);
          if (!task.webExecution!.restartAfterShutdown) task = options.store.beginRecovery(task, options.now());
          if (task.recovery.pauseReason !== null) return task;
          recovering = true;
          task = options.store.beginWebGeneration(task, stopped, options.now(), toolLaunch);
          success(task, { kind: "execution", phase: "preparing" }, "web-recovery-proof");
          ticket = await prepareTicket(task, task.webExecution!.initialPrompt!, signal);
          phase(task, { kind: "execution", phase: "agent-start" });
          await options.launcher.launch(current(task), ticket, signal);
          success(task, { kind: "execution", phase: "agent-start" });
          phase(task, { kind: "execution", phase: "agent-observation" });
          const response = await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 });
          if (response.workerLifecycleProtocol === 1) return await stopLegacyController(current(task), ticket, signal);
          capability = protocol(response); recoveryCapability = response.recoveredInitialInputProtocol; capabilityObserved = true; snapshot = response.snapshot;
          }
        }
        const observedProof = current(task).webExecution!.controllerProcess;
        if (observedProof !== null) await jobLeases.retain(ticket.launchId, observedProof, Date.now() + 10_000);
        task = current(task);
        if ((snapshot.lifecycle === "ready" || snapshot.lifecycle === "working") && snapshot.initialInputState === "not_submitted" && BigInt(task.webExecution!.executionGeneration) > 1n) {
          recovering = true;
          if (await verifyRecoverableInitial(task, ticket, snapshot, capabilityObserved ? capability : undefined, recoveryCapability) === null) {
            waiting.set(task.claimId, "native_input");
            return task;
          }
        }
        task = remember(task, snapshot);
        if (snapshot.lifecycle === "failed" || snapshot.lifecycle === "paused" || snapshot.lifecycle === "stopped" || snapshot.lifecycle === "stopping") {
          recovering = true;
          const error = new Error(snapshot.error ?? "The native controller is paused or stopped.");
          // A confirmed native lifecycle failure is independent of the number of orchestration attempts.
          pause(error);
          throw error;
        }
        if (snapshot.lifecycle === "ready" || snapshot.lifecycle === "working") {
          if (task.recovery.retryAuthorized) task = options.store.completeRecoveryRetry(task, snapshot, options.now());
          success(task, { kind: "execution", phase: "agent-observation" });
          recovering = false;
        }
        await refreshGrant(task, ticket, signal);
        if (snapshot.lifecycle === "starting") return options.store.updateWebExecution(task, { activity: "initializing" }, options.now());
        if (capabilityObserved) task = await applyInput(task, ticket, snapshot, capability, signal, authority);
        else waiting.set(task.claimId, "native_input");
        options.emit({ kind: "web-observed", task, message: `Original ${ticket.provider} controller generation ${ticket.executionGeneration} is bound to session ${ticket.sessionId}.` });
        return current(task);
      } catch (error) {
        if (!signal.aborted && error instanceof ConfigurationAdmissionWaiting) {
          waiting.set(task.claimId, "configuration_pending");
          phase(task, { kind: "execution", phase: "waiting" }, false);
          return current(task);
        }
        if (!signal.aborted && error instanceof ControllerStorageWaitingError) {
          waiting.set(task.claimId, "storage_maintenance");
          phase(task, { kind: "execution", phase: "waiting" }, false, undefined, "web-storage-maintenance");
          return current(task);
        }
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
    cleanup: async (input: LocalTask, cleanupRequest: CleanupRequest): Promise<WebCleanupOutcome> => {
      const { kind, deadline, immediateStop } = cleanupRequest;
      let signal = cleanupRequest.signal ?? new AbortController().signal;
      const notifyStopped = async (): Promise<unknown | undefined> => {
        if (cleanupRequest.kind !== "terminal") return undefined;
        const observation = await workerOperation(operation => observeExecutionStop(input, operation), signal);
        if (observation.kind === "stopped" || observation.kind === "not-started") cleanupRequest.scope.onExecutionStopped({ attempt: cleanupRequest.scope.attempt, observation });
        if (observation.kind === "unknown") {
          const execution = input.webExecution;
          options.emit({ kind: "execution-stop-observation-error", task: input, message: "Web execution stop observation is unknown.", component: "cleanup", phase: "agent-stop", attemptId: cleanupRequest.scope.attempt.attemptId, ...(execution === null ? {} : { runKey: JSON.stringify([execution.executionId, execution.executionGeneration, execution.controllerInstanceId]) }), error: observation.error });
        }
        return observation.kind === "unknown" ? observation.error : undefined;
      };
      let stage: WorkerCleanupStage = "observation";
      let fallback: { proof: ProcessProof; deadline: number; task: LocalTask } | undefined, fallbackTicket: ControllerLaunchTicket | undefined;
      let bootstrapAttempted = false, bootstrapCompleted = false, treeAttempted = false, treeEvidenceBlocked = false, leaseAttempted = false;
      let stopRequestFailure: { cause: unknown } | undefined;
      phase(input, { kind: "cleanup", phase: stage });
      try {
        const startedAt = options.now();
        let task = current(input);
        if (task.webExecution !== null) await jobLeases.cleanupBirth(task.webExecution.launchId, Date.now() + 5000);
        if (task.status !== "done" && kind === "shutdown" && task.cleanup === null && task.recovery.retryAuthorized && task.recovery.pauseReason === null) task = options.store.pauseRecovery(task, "The explicit recovery attempt stopped before a successful observation.", options.now());
        if (task.status !== "done" && kind === "shutdown" && task.cleanup === null && task.recovery.pauseReason === null && task.configuration !== null && task.recovery.count >= task.configuration.recoveryLimit && task.webExecution !== null && task.webExecution.launchSubmission !== "not-submitted") {
          // Shutdown provenance must not turn an already exhausted writer into a healthy orderly restart.
          try {
            const saved = originalSnapshot(task, await readLaunchTicket(options.homeDirectory, task.webExecution.launchId));
            if (["failed", "paused", "stopped", "stopping"].includes(saved.lifecycle) || await confirmWithLease(task.webExecution!.launchId, saved.controllerProcess, saved.nativeProcesses, undefined, saved)) task = options.store.pauseRecovery(task, "The execution recovery budget is exhausted.", options.now());
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
        // The persisted cleanup owns bounded stop even if the caller cancels its request.
        const stopDeadline = Date.now() + CLEANUP_OPERATION_MS;
        signal = AbortSignal.timeout(CLEANUP_OPERATION_MS);
        let launched = false;
        if (execution !== null) {
          if (execution.launchSubmission !== "not-submitted" && execution.controllerProcess !== null) fallback = { proof: execution.controllerProcess, deadline: stopDeadline, task };
          await notifyStopped();
          let saved = execution.launchSubmission === "not-submitted" ? readControllerSnapshot(journal(task)) : null;
          let initialResponse: Awaited<ReturnType<typeof request>> | undefined;
          let replaced: ControllerBootstrapReplacedError | undefined;
          if (execution.launchSubmission !== "not-submitted") {
            const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId);
            if (ticket.executionId !== execution.executionId || ticket.claimId !== task.claimId || ticket.sessionId !== execution.sessionId
              || ticket.executionGeneration !== execution.executionGeneration || ticket.controllerInstanceId !== execution.controllerInstanceId
              || ticket.worktreeId !== task.worktreeId || ticket.workerId !== task.workerId || ticket.serverOrigin !== task.serverOrigin) throw new Error("The cleanup ticket does not identify the original execution.");
            if (execution.controllerProcess === null) throw new Error("The original controller spawn identity is missing; cleanup cannot infer stop.");
            fallbackTicket = ticket;
            try { initialResponse = await request(ticket, { kind: "observe" }, { signal, timeoutMs: Math.max(1, Math.min(2000, stopDeadline - Date.now())) }); }
            catch (error) { signal.throwIfAborted(); if (!(error instanceof ControllerIpcOutcomeUnknownError)) throw error; }
            let observation = initialResponse === undefined
              ? await reconcileSubmittedControllerLaunch({ journalFile: journal(task), ticket, spawnProof: execution.controllerProcess, signal, deadline: stopDeadline })
              : { kind: "observed" as const, snapshot: initialResponse.snapshot };
            if (observation.kind === "controller-exited" || observation.kind === "pre-writer-exited") bootstrapCompleted = true;
            if (observation.kind === "pre-writer-exited") treeEvidenceBlocked = true;
            if (observation.kind === "observed" || observation.kind === "running-unobserved") { leaseAttempted = true; await jobLeases.retain(ticket.launchId, execution.controllerProcess, stopDeadline); }
            if (observation.kind === "running-unobserved") {
              bootstrapAttempted = true;
              try { await stopControllerBootstrap(execution.controllerProcess, stopDeadline); bootstrapCompleted = true; }
              catch (error) { if (!(error instanceof ControllerBootstrapReplacedError)) throw error; bootstrapCompleted = true; replaced = error; }
              try { observation = await reconcileSubmittedControllerLaunch({ journalFile: journal(task), ticket, spawnProof: execution.controllerProcess, signal, deadline: stopDeadline }); }
              catch (error) { if (replaced !== undefined) throw new AggregateError([replaced, error], "Bootstrap stop and launch reconciliation failed.", { cause: error }); throw error; }
              if (replaced !== undefined && (observation.kind === "unknown" || observation.kind === "running-unobserved" || observation.kind === "observed")) { treeEvidenceBlocked = true; throw new AggregateError(observation.kind === "unknown" ? [replaced, observation.cause] : [replaced], "Bootstrap replacement could not be reconciled to the original exit.", { cause: replaced }); }
            }
            if (observation.kind === "unknown") { treeEvidenceBlocked = bootstrapCompleted; throw new Error("The original controller process status is unknown during cleanup.", { cause: observation.cause }); }
            if (observation.kind === "running-unobserved") { treeEvidenceBlocked = true; throw new Error("The original controller remains running after bootstrap cleanup."); }
            if (observation.kind === "pre-writer-exited") { treeEvidenceBlocked = true; throw new Error(`The original controller exited before committing its generation (${observation.journal}); launch and resources are retained.`, replaced === undefined ? undefined : { cause: replaced }); }
            saved = observation.kind === "observed" ? originalSnapshot(task, ticket, stopDeadline) : observation.snapshot;
          }
          try {
            if (saved !== null && !matchesGeneration(task, saved)) {
              try {
                if (execution.launchSubmission !== "not-submitted" || saved.executionId !== execution.executionId || saved.claimId !== task.claimId
                  || saved.controllerProcess === null || BigInt(saved.executionGeneration) + 1n !== BigInt(execution.executionGeneration)
                  || !await confirmWithLease(previousLaunchId(saved.controllerProcess, execution.launchId), saved.controllerProcess, saved.nativeProcesses, stopDeadline, saved)) throw new Error("The original controller generation cannot be identified and stopped from its journal.");
              } catch (error) {
                treeEvidenceBlocked = true;
                let observationError: unknown;
                try { observationError = await notifyStopped(); } catch (failure) { observationError = failure; }
                if (observationError !== undefined) throw new AggregateError([error, observationError], "Web stop and stop observation both failed.");
                throw error;
              }
              saved = null;
            }
            launched = saved !== null || execution.launchSubmission !== "not-submitted";
            if (launched) {
              const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId);
              if (ticket.executionId !== execution.executionId || ticket.claimId !== task.claimId || ticket.sessionId !== execution.sessionId
                || ticket.executionGeneration !== execution.executionGeneration || ticket.controllerInstanceId !== execution.controllerInstanceId
                || ticket.worktreeId !== task.worktreeId || ticket.workerId !== task.workerId || ticket.serverOrigin !== task.serverOrigin) throw new Error("The cleanup ticket does not identify the original execution.");
              let response = initialResponse;
              try { if (response === undefined) response = await request(ticket, { kind: "observe" }, { signal, timeoutMs: Math.max(1, Math.min(2000, stopDeadline - Date.now())) }); }
              catch (error) {
                signal.throwIfAborted();
                if (!(error instanceof ControllerIpcOutcomeUnknownError)) throw error;
                const observed = originalSnapshot(task, ticket, stopDeadline);
                if (observed !== null) {
                  if (!matchesGeneration(task, observed)) { treeEvidenceBlocked = true; throw new Error("The original controller journal belongs to a different generation.", { cause: error }); }
                  if (saved !== null && !preservesControllerEvidence(saved, observed, ticket.launchId)) { treeEvidenceBlocked = true; throw new Error("The cleanup observation conflicts with the original controller journal."); }
                  saved = observed;
                }
              }
              const reachable = response !== undefined;
              if (response !== undefined) {
                if (!matchesGeneration(task, response.snapshot)) { treeEvidenceBlocked = true; throw new Error("The observed controller belongs to a different generation."); }
                if (saved !== null && !preservesControllerEvidence(saved, response.snapshot, ticket.launchId)) { treeEvidenceBlocked = true; throw new Error("The cleanup observation conflicts with the original controller journal."); }
                saved = response.snapshot;
              }
              if (saved?.controllerProcess != null && execution.controllerProcess !== null) {
                if (!preservesControllerProcessProof(execution.controllerProcess, saved.controllerProcess, ticket.launchId)) { treeEvidenceBlocked = true; throw new Error("The original controller process identity conflicts with its journal."); }
              }
              if (saved !== null && !preservesNativeProcessPrefix(execution.nativeProcesses, saved.nativeProcesses)) { treeEvidenceBlocked = true; throw new Error("The original native process identities conflict with their journal."); }
              if (saved?.nativeSessionId != null && task.status !== "done") task = options.store.bindNativeSession(task, { source: "controller", sessionId: saved.nativeSessionId }, options.now(), saved);
              const proof = saved?.controllerProcess;
              const native = saved?.nativeProcesses ?? execution.nativeProcesses;
              if (proof == null) { treeEvidenceBlocked = true; throw new Error("The committed controller process identity is missing; cleanup cannot infer stop."); }
              let stopped: boolean;
              try {
                stopped = await confirmWithLease(execution.launchId, proof, native, stopDeadline, saved ?? undefined, ticket);
                if (!immediateStop && task.status !== "done" && !stopped && options.now() < intent.deadline) {
                  if (!reachable) throw new Error("The original controller is unavailable; cleanup retains its fixed deadline and process identity.");
                  if (task.webExecution!.cleanupOperationId === null) task = options.store.updateWebExecution(task, { cleanupOperationId: randomUUID() }, options.now());
                  const operationId = task.webExecution!.cleanupOperationId!;
                  let operation = readCompatibleControllerOperation(journal(task), ticket, operationId, stopDeadline);
                  if (operation === null) {
                    try { await request(ticket, { kind: "cleanup", operationId, prompt: workerCleanupPrompt(task, intent.deadline), deadline: intent.deadline }, { signal, timeoutMs: Math.max(1, Math.min(CLEANUP_OPERATION_MS, intent.deadline - options.now())) }); }
                    catch (error) {
                      if (hasUnsafeControllerObservationFailure(error)) throw error;
                      signal.throwIfAborted();
                      operation = readCompatibleControllerOperation(journal(task), ticket, operationId, stopDeadline);
                      if (operation === null) throw error;
                    }
                    operation = readCompatibleControllerOperation(journal(task), ticket, operationId, stopDeadline);
                  }
                  if (operation !== null && (operation.kind !== "cleanup" || operation.executionGeneration !== execution.executionGeneration)) throw new Error("The cleanup operation belongs to a different controller generation.");
                  if (operation === null || !["confirmed", "failed", "rejected", "expired"].includes(operation.state)) return { task, complete: false };
                }
                if (!stopped) {
                  if (reachable) try { await request(ticket, { kind: "stop", deadline: stopDeadline }, { signal, timeoutMs: Math.max(1, Math.min(2000, stopDeadline - Date.now())) }); } catch (error) { stopRequestFailure = { cause: error }; if (hasUnsafeControllerObservationFailure(error)) throw error; }
                  signal.throwIfAborted();
                  treeAttempted = true;
                  await stopWithLease(execution.launchId, proof, native, stopDeadline);
                  stopped = await confirmWithLease(execution.launchId, proof, native, stopDeadline, saved ?? undefined, ticket);
                }
                if (!stopped) throw new Error("The original controller or its native processes still exist.");
                treeAttempted = true;
                if (stopRequestFailure !== undefined) throw stopRequestFailure.cause;
              } catch (error) {
                let observationError: unknown;
                try { observationError = await notifyStopped(); } catch (failure) { observationError = failure; }
                if (observationError !== undefined) throw new AggregateError([error, observationError], "Web stop and stop observation both failed.");
                throw error;
              }
              await notifyStopped();
              if (saved !== null) await recordWithLease(journal(task), ticket, stopDeadline);
              await jobLeases.release(ticket.launchId);
              success(task, { kind: "cleanup", phase: "agent-stop" });
              phase(task, { kind: "cleanup", phase: "agent-stop" }, true);
              stage = "backend-close";
              phase(task, { kind: "cleanup", phase: stage }, false);
              await removeEndpoint(ticket.ipcEndpoint);
              success(task, { kind: "cleanup", phase: "backend-close" });
              phase(task, { kind: "cleanup", phase: "backend-close" }, true);
            }
          } catch (error) {
            if (replaced !== undefined) throw new AggregateError([replaced, error], "Web bootstrap replacement and complete stop failed.", { cause: error });
            throw error;
          }
        }
        signal.throwIfAborted();
        if (!launched) { await notifyStopped(); success(task, { kind: "cleanup", phase: "agent-stop" }); }
        if (kind === "shutdown" || task.status === "done") { if (kind === "terminal") autoInput.forget(task); return { task, complete: true }; }
        const fileSignal = cleanupRequest.signal ?? new AbortController().signal;
        fileSignal.throwIfAborted();
        const project = { projectId: task.projectId, repoUrl: task.repoUrl, localPath: task.repositoryPath };
        const archive = options.archiveSessions === undefined ? true : options.archiveSessions();
        if (archive === false && !task.cleanup!.discardRecording) task = options.store.discardRecording(task, options.now());
        if (launched && archive === true && !task.cleanup!.discardRecording) {
          stage = "archive";
          phase(task, { kind: "cleanup", phase: stage }, false);
          fileSignal.throwIfAborted();
          let archiveSucceeded = false;
          try {
            if (!options.archive) throw new Error("Session archive uploader is unavailable.");
            await withWebRecordingSource(options.homeDirectory, task, () => options.store.getTask(task), () => options.archive!(task, journal(task), fileSignal), fileSignal);
            archiveSucceeded = true;
          } catch (error) {
            fileSignal.throwIfAborted();
            try {
              if (options.onArchiveFailure) {
                const ownerUserId = cleanupRequest.kind === "terminal" ? cleanupRequest.ownerUserId : undefined;
                if (ownerUserId === undefined) options.onArchiveFailure(task, error);
                else options.onArchiveFailure(task, error, ownerUserId);
              } else options.emit({ kind: "session-archive-retry", task, component: "archive", phase: "archive-backfill", message: "Session archive failed; its source is retained for retry.", error });
            } catch (diagnosticError) {
              try { options.emit({ kind: "session-archive-retry", task, component: "archive", phase: "archive-backfill", message: "Session archive failure registration failed; its source is retained for retry.", error: new AggregateError([error, diagnosticError], "Archive and failure registration failed.", { cause: error }) }); } catch { /* Diagnostics cannot prevent cleanup. */ }
            }
          }
          fileSignal.throwIfAborted();
          // Archive maintenance owns failure recovery; only an actual upload is successful.
          if (archiveSucceeded) {
            success(task, { kind: "cleanup", phase: "archive" });
            phase(task, { kind: "cleanup", phase: "archive" }, true);
          }
        }
        stage = "worktree-removal";
        phase(task, { kind: "cleanup", phase: stage }, false);
        const binding = await cleanupOperation(operation => options.git.resolveWorktreeBinding(project, task, operation), fileSignal);
        if (binding === null) {
          if (launched || task.resources.worktree !== null) throw new Error("The original Web execution has no worktree manifest.");
          await cleanupOperation(operation => options.git.removeUnpublishedReservation(project, task, operation), fileSignal);
        } else {
          if (task.resources.worktree !== null && !await sameWorktreeLocation(task.resources.worktree.worktreePath, binding.worktreePath)) throw new Error("The original Web worktree differs from its manifest.");
          fileSignal.throwIfAborted();
          if (task.resources.worktree === null) task = options.store.bindWorktree(task, { ...binding, repositoryPath: task.repositoryPath }, options.now());
          const outcome = await options.git.removeWorktree(project, task, { signal: fileSignal });
          if (outcome.effectErrors.length > 0) {
            try { options.emit({ kind: "cleanup-effect-error", task, component: "cleanup", phase: "worktree-removal", message: "Worktree removal reported errors, but the original resources are confirmed absent.", error: new AggregateError(outcome.effectErrors, "Worktree removal effect failed after reaching its postcondition.", { cause: outcome.effectErrors[0] }) }); } catch { /* Diagnostics do not change resource settlement. */ }
          }
        }
        fileSignal.throwIfAborted();
        success(task, { kind: "cleanup", phase: "worktree-removal" });
        fileSignal.throwIfAborted();
        phase(task, { kind: "cleanup", phase: "worktree-removal" }, true);
        fileSignal.throwIfAborted();
        waiting.delete(task.claimId); rejected.delete(task.claimId);
        autoInput.forget(task);
        return { task, complete: true };
      } catch (error) {
        const failures: unknown[] = stopRequestFailure !== undefined && error !== stopRequestFailure.cause ? [stopRequestFailure.cause, error] : [error];
        treeEvidenceBlocked ||= hasUnsafeControllerObservationFailure(error);
        if (stage === "agent-stop" && fallback !== undefined) {
          if (!bootstrapAttempted && !bootstrapCompleted && !treeAttempted && !leaseAttempted && fallbackTicket !== undefined) {
            try { leaseAttempted = true; await jobLeases.retain(fallbackTicket.launchId, fallback.proof, fallback.deadline); } catch (leaseError) { failures.push(leaseError); }
          }
          if (!bootstrapAttempted && !bootstrapCompleted && !treeAttempted) {
            try { await stopControllerBootstrap(fallback.proof, fallback.deadline); bootstrapCompleted = true; }
            catch (stopError) { failures.push(stopError); bootstrapCompleted = stopError instanceof ControllerBootstrapReplacedError; }
          }
          if (bootstrapCompleted && !treeEvidenceBlocked && !treeAttempted && fallbackTicket !== undefined) {
            let journalIoFailure = false;
            try {
              const fallbackDeadline = fallback.deadline;
              const remaining = () => { const time = fallbackDeadline - Date.now(); if (time <= 0) throw new Error("Web bootstrap cleanup exceeded its deadline; evidence is retained."); return time; };
              const observation = await reconcileSubmittedControllerLaunch({ journalFile: journal(input), ticket: fallbackTicket, spawnProof: fallback.proof, signal: AbortSignal.timeout(remaining()), deadline: fallback.deadline });
              remaining();
              if (observation.kind === "controller-exited") {
                const saved = observation.snapshot;
                if (saved.controllerProcess === null) throw new Error("Web journal lacks complete controller proof; stopping remains unconfirmed.");
                if (!matchesGeneration(fallback.task, saved) || !preservesControllerProcessProof(fallback.proof, saved.controllerProcess, fallbackTicket.launchId) || !preservesNativeProcessPrefix(fallback.task.webExecution!.nativeProcesses, saved.nativeProcesses)) throw new Error("Web fallback journal conflicts with the original process evidence.");
                treeAttempted = true;
                await stopWithLease(fallbackTicket.launchId, saved.controllerProcess, saved.nativeProcesses, fallback.deadline); remaining();
                if (!await confirmWithLease(fallbackTicket.launchId, saved.controllerProcess, saved.nativeProcesses, fallback.deadline, saved, fallbackTicket)) throw new Error("Web original process tree did not stop; evidence is retained.");
                remaining();
              } else if (observation.kind !== "pre-writer-exited") throw new Error("Web bootstrap exit could not be classified; evidence is retained.", observation.kind === "unknown" ? { cause: observation.cause } : undefined);
            } catch (verificationError) { failures.push(verificationError); journalIoFailure = isControllerJournalIoFailure(verificationError); }
            const previous = fallback.task.webExecution!;
            if (!treeAttempted && journalIoFailure && (isControllerJournalIoFailure(error) || error instanceof ControllerIpcOutcomeUnknownError)
              && process.platform !== "win32" && previous.launchSubmission === "acknowledged"
              && fallback.proof.processGroupId === fallback.proof.pid && fallback.proof.jobObjectName === undefined) {
              try {
                if (Date.now() >= fallback.deadline) throw new Error("Web retained-proof cleanup exceeded its deadline.");
                await stopControllerProcesses(fallback.proof, previous.nativeProcesses, fallback.deadline);
                if (Date.now() >= fallback.deadline) throw new Error("Web retained-proof cleanup exceeded its deadline.");
                if (!await confirmControllerProcessesStopped(fallback.proof, previous.nativeProcesses, fallback.deadline)) throw new Error("Web retained process tree remains unconfirmed.");
                if (Date.now() >= fallback.deadline) throw new Error("Web retained-proof cleanup exceeded its deadline.");
              } catch (retainedError) { failures.push(retainedError); }
            }
          }
        }
        throw new WorkerCleanupError(stage, failures.length === 1 ? failures[0] : new AggregateError(failures, "Web cleanup observation and stopping failed.", { cause: failures[0] }));
      }
    },
  };
  return {
    ...backend,
    observeExecutionStop,
    // Native cancellation is independent of the serialized Task writer. It must
    // neither persist cleanup state nor release the writer's original leases.
    requestExecutionStop: async (input: LocalTask, deadline: number): Promise<void> => {
      const execution = input.webExecution;
      if (execution === null || execution.launchSubmission === "not-submitted" || execution.controllerProcess === null) throw new Error("The original submitted Web native boundary is unavailable.");
      const assertOriginal = (): void => {
        const latest = current(input);
        if (latest.worktreeId !== input.worktreeId || latest.serverOrigin !== input.serverOrigin || latest.workerId !== input.workerId || latest.userId !== input.userId
          || latest.webExecution === null || latest.webExecution.executionId !== execution.executionId || latest.webExecution.launchId !== execution.launchId
          || latest.webExecution.controllerId !== execution.controllerId || latest.webExecution.controllerInstanceId !== execution.controllerInstanceId
          || latest.webExecution.sessionId !== execution.sessionId || latest.webExecution.executionGeneration !== execution.executionGeneration) throw new Error("The original Web execution changed before native cancellation.");
        if (Date.now() >= deadline) throw new Error("Web native cancellation exceeded its deadline.");
      };
      assertOriginal();
      const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId);
      if (ticket.launchId !== execution.launchId || ticket.executionId !== execution.executionId || ticket.controllerId !== execution.controllerId
        || ticket.sessionId !== execution.sessionId || ticket.executionGeneration !== execution.executionGeneration || ticket.controllerInstanceId !== execution.controllerInstanceId
        || ticket.serverOrigin !== input.serverOrigin || ticket.projectId !== input.projectId || ticket.taskId !== input.taskId || ticket.claimId !== input.claimId
        || ticket.workerId !== input.workerId || ticket.worktreeId !== input.worktreeId || ticket.userId !== input.userId) throw new Error("Web native cancellation ticket conflicts with the original execution.");
      const saved = originalSnapshot(input, ticket, deadline);
      if (saved === null || saved.testExecutionId !== undefined || !matchesGeneration(input, saved) || saved.controllerProcess === null
        || !preservesControllerProcessProof(execution.controllerProcess, saved.controllerProcess, execution.launchId)
        || !preservesNativeProcessPrefix(execution.nativeProcesses, saved.nativeProcesses)) throw new Error("Web native cancellation journal conflicts with the original process boundary.");
      assertOriginal();
      await stopWithLease(execution.launchId, saved.controllerProcess, saved.nativeProcesses, deadline);
    },
    closeInput: autoInput.close,
    confirmUpgrade: async (original: LocalTask, authority: WebInputAuthority, signal: AbortSignal): Promise<WebAdvanceResult> => {
      let task = current(original);
      const execution = task.webExecution;
      if (execution === null || execution.ticketPath === null || execution.controllerProcess === null || task.cleanup !== null || task.control !== null) throw new Error("Legacy adoption requires the original running Controller evidence.");
      const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId);
      const response = await request(ticket, { kind: "observe" }, { signal, timeoutMs: 2000 });
      if (response.workerLifecycleProtocol === 1) return { kind: "waiting_input", reason: "native_input", task: await stopLegacyController(task, ticket, signal) };
      if (protocol(response) === 1) return { kind: "waiting_input", reason: "native_input", task };
      const snapshot = response.snapshot;
      if (!matchesGeneration(task, snapshot) || !preservesControllerProcessProof(execution.controllerProcess, snapshot.controllerProcess, execution.launchId)
        || !preservesNativeProcessPrefix(execution.nativeProcesses, snapshot.nativeProcesses)) throw new Error("Legacy adoption observation conflicts with the original execution.");
      task = remember(task, snapshot);
      const outcome = await autoInput.confirmUpgrade({ task, ticket, snapshot, signal, legacyAuthority: authority });
      return outcome.kind === "upgrade" ? { kind: "upgrade", task } : { kind: "waiting_input", reason: outcome.kind === "waiting" ? outcome.reason : "native_input", task };
    },
    probeArchive: async (input: LocalTask, signal: AbortSignal): Promise<ArchiveProbeResult> => {
      signal.throwIfAborted();
      const task = current(input);
      if (task.worktreeId !== input.worktreeId || task.webExecution === null || input.webExecution === null
        || task.webExecution.executionId !== input.webExecution.executionId || task.webExecution.executionGeneration !== input.webExecution.executionGeneration
        || task.webExecution.launchId !== input.webExecution.launchId || task.cleanup?.kind !== "terminal") throw new Error("Archive probing requires the original terminal execution.");
      if (!options.probeArchive) throw new Error("Archive condition probing is unavailable; the original source is retained.");
      const result = await withWebRecordingSource(options.homeDirectory, task, () => options.store.getTask(task), () => options.probeArchive!(task, journal(task), signal), signal);
      signal.throwIfAborted();
      return result;
    },
    setMonitoringObserver: (value: Monitoring): void => {
      monitoring = value;
      if (value.observeFailure !== undefined) for (const [key, pending] of pendingFailures) {
        try { if (value.observeFailure(pending.identity, { kind: "execution", phase: "preparing" }, pending.error, pending.operationKey, pending.observedFailure)) pendingFailures.delete(key); } catch { /* Retain unconfirmed current failure. */ }
      }
      if (value.observeUnattributed !== undefined) for (const [key, pending] of pendingIdentities) {
        try { if (value.observeUnattributed(pending.identity, pending.operationKey, true)) pendingIdentities.delete(key); } catch { /* Retain the current unattributed state. */ }
      }
    },
    advanceResult: async (task: LocalTask, signal: AbortSignal, canAdmitNewExecution?: () => boolean, authority?: WebInputAuthority, allowWorktreeRestore = true): Promise<WebAdvanceResult> => {
      let result: LocalTask;
      try { result = await backend.advance(task, signal, canAdmitNewExecution, authority, allowWorktreeRestore); }
      catch (cause) {
        if (signal.aborted || !(cause instanceof ControllerStorageWaitingError)) throw cause;
        result = current(task);
        waiting.set(task.claimId, "storage_maintenance");
        phase(result, { kind: "execution", phase: "waiting" }, false, undefined, "web-storage-maintenance");
      }
      const reason = waiting.get(task.claimId);
      return reason !== undefined ? { kind: "waiting_input", reason, task: result } : { kind: upgrades.has(task.claimId) ? "upgrade" : "observed", task: result };
    },
  };
};
export type WebExecutionBackend = ReturnType<typeof createWebExecutionBackend>;
