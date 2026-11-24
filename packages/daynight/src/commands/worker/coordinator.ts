import { executionRecoveryResult, type LifecycleTaskRecoveryEvidence } from "./lifecycle-recovery.js";
import { ArchiveRepairRequiredError, type ArchiveRepairCode } from "../controller/archive-error.js";
import { CLEANUP_OPERATION_MS, cleanupOperation } from "../cleanup-operation.js";
import { readWorkerClaim, readSessionStartupReport, readTaskBlocked } from "../../api/task-properties.js";
import { legacyBranchLatch } from "./backends/orchestration.js";
import { WorktreePreconditionError, type RegisteredWorktree } from "./worktrees.js";
import { retainedWorktreePathInScope, sameWorktreeLocation } from "./worktrees/paths.js";
import { sameStartupReport, type SessionStartupReport } from "../../session/startup.js";
import { WebRecoveryBlockedError, type WebExecutionBackend } from "./backends/web.js";
import type { WebExecutionStore } from "./backends/web-store.js";
import type { WorkerSessionApi } from "./backends/session-api.js";
import { requireImplementedWorkerBackend } from "./backend.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { withOwnedCommandLifecycle, type OwnedCommandLifecycleSink } from "./owned-command-lifecycle.js";
import path from "node:path";
import { resolvePhysicalDirectory } from "../../platform/filesystem.js";
import { repositoryIdentity } from "../../repository/identity.js";
import { setTimeout as delay } from "node:timers/promises";
import { OperationError } from "../../api/operation.js";
import { ApiError } from "../../api/client.js";
import type { Task, TaskPlatform, WorkerClaim, WorkerMachine, WorkerTaskInventory, WorkerTaskReference } from "../../api/types.js";
import { ARCHIVE_REPAIR_PROBE_INTERVAL_MS, ensureCleanupSchedule } from "./cleanup-schedule.js";
import { assertWorkerLifecycleAdmission, withLifecycleProducer, withLifecycleReservation } from "./lifecycle-context.js";
import { WorkerCleanupError } from "./cleanup-error.js";
import { createExecutionCapacity } from "./execution-capacity.js";
import { cleanupRetiredClaim } from "./retired-claim-cleanup.js";
import type { RetiredClaimNativeCleanup, LocatedClaimNative } from "./backends/retired-claim-native.js";
import type { CleanupAttempt, CleanupTarget, TerminalCleanupContext } from "./execution-stop.js";
import { isWorkerCancellation, sameClaim, workerOperation } from "./execution.js";
import type { WorkerEvent, WorkerGitManager, WorkerObservedPhase, WorkerPhaseObserver } from "./execution.js";
import { ConfigurationAdmissionWaiting, assertConfigurationAdmission } from "./configuration-admission.js";
import { isUnavailableProject } from "./remote.js";
import type { WorkerRemote } from "./remote.js";
import type { WorkerStore } from "./store.js";
import type { ClaimIdentity, ExecutionConfiguration, LocalTask, ResourceOwner, WorkerProject, WorktreeBinding } from "./types.js";
import type { createMonitoringObserver } from "./monitoring/observer.js";
import { MonitoringArchiveBusyEvidence, MonitoringOwnershipUnconfirmedEvidence, MonitoringRecoveryEvidence } from "./monitoring/diagnostics.js";
import { encodeWorktree } from "./monitoring/worktree.js";
import { createSelectedWorktrees } from "./monitoring/selected-worktrees.js";
import type { FailureWorktree } from "./monitoring/types.js";
import type { createWebArchiveMaintenance } from "./web-archive-backfill.js";

export type WorkerRepositoryAssignment = { project: WorkerProject; configuration: ExecutionConfiguration };
export type WorkerInputWait = { kind: "waiting_input"; reason: "prompt_unknown" | "prompt_too_large" | "storage_maintenance" | "configuration_pending" | "task_paused" | "claim_invalid" | "native_input" };
export type WorkerCoordinatorOptions = {
  retiredNativeCleanup?: RetiredClaimNativeCleanup;
  cleanupCommandLifecycle?: (identity: ClaimIdentity) => OwnedCommandLifecycleSink;
  freezeConfiguration?: (configuration: ExecutionConfiguration, signal: AbortSignal) => Promise<ExecutionConfiguration>;
  webBackend: Pick<WebExecutionBackend, "advance" | "cleanup" | "observeExecutionStop"> & Partial<Pick<WebExecutionBackend, "requestExecutionStop" | "observeStartupReport" | "advanceResult" | "confirmUpgrade" | "setMonitoringObserver" | "probeArchive">>;
  webStore: WebExecutionStore; verifyWebServer?: WorkerSessionApi["verifySupport"]; verifyWebUnregistered?: WorkerSessionApi["verifyUnregistered"];
  archiveMaintenance?: Pick<ReturnType<typeof createWebArchiveMaintenance>, "recordLegacyFailure"> & Partial<Pick<ReturnType<typeof createWebArchiveMaintenance>, "discardLocal" | "discardOne">>;
  archiveSessions?: () => boolean | null;
  verifyWebStartupReporting?: WorkerSessionApi["supportsStartupReports"];
  store: WorkerStore; git: WorkerGitManager; remote: WorkerRemote;
  serverOrigin: string; workerId: string; userId?: string; platform: TaskPlatform; machine: WorkerMachine;
  readyProjectIds?: readonly string[]; targetProjectIds?: readonly string[];
  repositories: readonly WorkerRepositoryAssignment[]; globalConfiguration: ExecutionConfiguration | null; maxConcurrent: number;
  platformTaskMode: "all" | "prefer" | "only";
  recoveryLimit?: number;
  taskTagFilterKey?: string | null;
  onConfigurationStale?: () => void;
  prepareProject?: (projectId: string, signal: AbortSignal) => Promise<void>;
  configurationComplete?: () => boolean;
  onPromptDemand?: (projectIds: readonly string[]) => void;
  onInventory?: (inventory: WorkerTaskInventory | null) => void; onClaim?: (reference: WorkerTaskReference) => void;
  emit: (event: WorkerEvent) => void; signal?: AbortSignal; now?: () => number;
  requestReconcile?: () => void;
  monitoring?: ReturnType<typeof createMonitoringObserver>;
};
export type WorkerCoordinatorConfiguration = Pick<WorkerCoordinatorOptions, "repositories" | "globalConfiguration" | "maxConcurrent" | "platformTaskMode" | "readyProjectIds" | "targetProjectIds" | "recoveryLimit" | "taskTagFilterKey">;

const configurationView = (value: WorkerCoordinatorConfiguration): WorkerCoordinatorConfiguration => Object.freeze({
  maxConcurrent: value.maxConcurrent,
  ...(value.taskTagFilterKey === undefined ? {} : { taskTagFilterKey: value.taskTagFilterKey }),
  ...(value.recoveryLimit === undefined ? {} : { recoveryLimit: value.recoveryLimit }),
  platformTaskMode: value.platformTaskMode,
  ...(value.readyProjectIds === undefined ? {} : { readyProjectIds: Object.freeze([...value.readyProjectIds]) }),
  ...(value.targetProjectIds === undefined ? {} : { targetProjectIds: Object.freeze([...value.targetProjectIds]) }),
  globalConfiguration: value.globalConfiguration === null ? null : Object.freeze({ ...value.globalConfiguration, args: Object.freeze([...value.globalConfiguration.args]) }),
  repositories: Object.freeze(value.repositories.map(repository => Object.freeze({ project: Object.freeze({ ...repository.project }), configuration: Object.freeze({ ...repository.configuration, args: Object.freeze([...repository.configuration.args]) }) }))),
});

const hasWorktreeIdentity = (target: CleanupTarget): target is ResourceOwner => target.worktreeId !== undefined;
type Snapshot = { conflicts: Set<string>; owners: Map<string, ResourceOwner>; proven: Set<string>; unresolved: Set<string>; scannedProjects: Set<string>; unavailableProjects: Set<string>; quarantined: Map<string, ResourceOwner> };
const key = (identity: ClaimIdentity): string => `${identity.projectId}/${identity.taskId}/${identity.claimId}`;
const taskKey = (identity: Pick<ClaimIdentity, "projectId" | "taskId">): string => `${identity.projectId}/${identity.taskId}`;
const isArchiveBusy = (error: unknown): boolean => {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if ("status" in error && error.status === 429 && "code" in error && error.code === "resource_busy") return true;
    error = error.cause;
  }
  return false;
};
const remoteOwner = (task: Task): ResourceOwner => {
  const claim = readWorkerClaim(task.properties);
  if (claim === undefined || claim.state !== "active") throw new Error("An actual active remote claim is required.");
  return { projectId: task.projectId, taskId: task.id, claimId: claim.claimId, worktreeId: claim.worktreeId };
};

export const createWorkerCoordinator = (options: WorkerCoordinatorOptions) => {
  const now = options.now === undefined ? Date.now : options.now;
  // Monitoring must never alter scheduling or the original error chain.
  const observe = (action: (monitor: NonNullable<WorkerCoordinatorOptions["monitoring"]>) => void): void => {
    if (options.monitoring !== undefined) try { action(options.monitoring); } catch { /* Local execution remains authoritative. */ }
  };
  let configuration = configurationView(options);
  const archiveSessions = (): boolean | null => options.archiveSessions === undefined ? true : options.archiveSessions();
  const selected = (projectId: string): boolean => configuration.readyProjectIds === undefined ? configuration.repositories.some(repository => repository.project.projectId === projectId) : configuration.readyProjectIds.includes(projectId);
  const stoppedProjects = new Set<string>();
  const projectStops = new Map<string, Promise<void>>();
  const canAdvanceProject = (projectId: string): boolean => selected(projectId)
    && (configuration.targetProjectIds === undefined || configuration.targetProjectIds.includes(projectId))
    && !projectStops.has(projectId);
  const recoverCleanupPhase = (identity: ClaimIdentity, phase: string): void => {
    const failureKey = `true/${key(identity)}/${phase}`, failure = monitoringFailures.get(failureKey);
    if (failure !== undefined) { observe(m => m.recover(failure)); monitoringFailures.delete(failureKey); }
  };
  const recoverLimitIfReady = (identity: string): void => {
    const limitKey = `limit/${identity}`, failure = monitoringFailures.get(limitKey);
    if (failure === undefined || !monitoringLimitRetries.has(identity)) return;
    if ([...monitoringFailures.keys()].some(value => value.startsWith(`false/${identity}/`)) || [...nameMonitoringFailures.keys()].some(value => value.startsWith(`${identity}/`))) return;
    observe(m => m.recover(failure)); monitoringFailures.delete(limitKey); recoveredLimitNames.delete(identity);
  };
  const deps: { observePhase: WorkerPhaseObserver; observeSuccess: (identity: ClaimIdentity, phase: Extract<WorkerObservedPhase, { kind: "execution" }>, operationKey?: string) => void } = {
    observePhase: (identity, phase, progressed, _deadlineAt, operationKey) => {
      const identityKey = key(identity);
      const operationId = monitoringJobs.get(identityKey);
      monitoringPhases.set(identityKey, phase.phase);
      monitoringOperations.set(identityKey, operationKey ?? phase.phase);
      if (operationId !== undefined) observe(m => {
        m.updateActivity(operationId, { phase: pausedClaims.has(identityKey) && phase.kind === "execution" ? "paused" : phase.phase, progress: progressed, status: pausedClaims.has(identityKey) && phase.kind === "execution" ? "paused" : phase.phase === "waiting" ? "waiting" : "running", waitReason: pausedClaims.has(identityKey) && phase.kind === "execution" ? "task-paused" : phase.phase === "waiting" ? "native-input" : null });
        if (phase.kind === "execution" && !progressed && phase.phase !== "waiting" && phase.phase !== "paused" && !operationKey?.startsWith("grant-refresh/")) {
          const failure = monitoringFailures.get(`false/${identityKey}/${operationKey ?? phase.phase}`);
          if (failure !== undefined) m.updateFailureRetry(failure, "running");
        }
        if (phase.kind === "cleanup") {
          const failure = monitoringFailures.get(`true/${identityKey}/${phase.phase}`);
          if (progressed) recoverCleanupPhase(identity, phase.phase);
          else if (failure !== undefined) m.updateFailureRetry(failure, "running");
        }
      });
    },
    observeSuccess: (identity, phase, operationKey) => {
      const ownerKey = key(identity), failureKey = `false/${ownerKey}/${operationKey ?? phase.phase}`, previous = monitoringFailures.get(failureKey);
      if (previous !== undefined) {
        observe(m => m.recover(previous)); monitoringFailures.delete(failureKey);
        recoverLimitIfReady(ownerKey);
      }
    },
  };
  // Only an operation-selected target or a durable original binding can identify a path.
  const selectedWorktrees = createSelectedWorktrees();
  const selectWorktree = selectedWorktrees.select;
  const worktreeContext = (identity: ClaimIdentity, originalPath?: string): { worktree?: FailureWorktree } => {
    try {
      const web = options.webStore.getTask(identity);
      if (web?.resources.worktree && (!("worktreeId" in identity) || identity.worktreeId === web.worktreeId)) return { worktree: encodeWorktree(web.repositoryPath, web.resources.worktree.worktreePath) };
      if (originalPath !== undefined || "worktreeId" in identity && typeof identity.worktreeId === "string") {
        const project = options.store.getProject(identity);
        if (project !== null) {
          const target = originalPath;
          if (target != null) return { worktree: encodeWorktree(project.localPath, target) };
        }
      }
      const selected = selectedWorktrees.get(identity);
      if (selected !== undefined) return { worktree: selected };
    } catch { /* Optional context must not suppress the failure. */ }
    return {};
  };
  const executionCancellation = new AbortController();
  const normalSignal = options.signal === undefined ? executionCancellation.signal : AbortSignal.any([options.signal, executionCancellation.signal]);
  const tails = new Map<string, Promise<void>>();
  const jobs = new Map<string, Promise<void>>();
  const monitoringJobs = new Map<string, string>();
  const monitoringActivities = new Map<string, string>();
  const monitoringFailures = new Map<string, string>();
  const monitoringPhases = new Map<string, string>();
  const monitoringOperations = new Map<string, string>();
  const projectMonitoringFailures = new Map<string, string>();
  const resourceMonitoringFailures = new Map<string, string>();
  const quarantinedMonitoringFailures = new Map<string, { owner: ResourceOwner; operationId: string }>();
  const unprovenMonitoringFailures = new Map<string, { projectId: string; operationId: string }>();
  const candidateMonitoringFailures = new Map<string, string>();
  const inventoryMonitoringFailures = new Map<string, string>();
  const nameMonitoringFailures = new Map<string, string>();
  const nameFailureThisJob = new Set<string>();
  const monitoringLimitRetries = new Set<string>();
  const recoveredLimitNames = new Map<string, Set<string>>();
  const pausedClaims = new Set<string>();
  const lifecycleRecovery = new Map<string, LifecycleTaskRecoveryEvidence>();
  const lifecycleAuthority = new Map<string, "ownership_changed" | "independent_blocker">();
  const webMonitoringState = new Map<string, string>();
  const webRecoveryFailures = new Map<string, { id: string; reason: "native_identity_missing" | "recovery_limit" | "recovery_blocked" }>();
  const controllers = new Map<string, { controller: AbortController; terminal: boolean; webClaim?: WorkerClaim }>();
  const releaseObservedCapacity = (owner: ResourceOwner): void => {
    options.requestReconcile?.();
    const current = ending.get(key(owner)), index = publishedReservations.findIndex(item => item.identity === key(owner));
    if (!current || !hasWorktreeIdentity(current) || current.worktreeId !== owner.worktreeId || index < 0) return;
    observe(m => {
      const snapshot = m.capture(), capacity = snapshot.capacity;
      if (capacity === null || capacity.quality !== "current") return;
      publishedReservations[index] = { ...publishedReservations[index]!, occupied: false };
      m.setCapacity({ limit: capacity.limit, occupied: publishedReservations.filter(item => item.occupied).length, observedAt: capacity.observedAt,
        partial: capacity.detailCoverage === "partial", reservations: publishedReservations.map(({ identity, roles, occupied }) => {
          const [projectId, taskId, claimId] = identity.split("/");
          return { identity: { projectId: projectId!, taskId: taskId!, claimId: claimId! }, roles, occupied };
        }) });
    });
  };
  const executionCapacity = createExecutionCapacity((owner, stopped) => {
    if (stopped) releaseObservedCapacity(owner);
    else options.requestReconcile?.();
  });
  const executionStoppedOrEmpty = (owner: ResourceOwner): boolean => executionCapacity.stopped(owner);
  let settlementSequence = 0;
  const settledCleanups = new Map<string, { worktreeId: string; sequence: number }>();
  const recordSettledCleanup = (owner: ResourceOwner): void => {
    if (ticking) settledCleanups.set(key(owner), { worktreeId: owner.worktreeId, sequence: ++settlementSequence });
  };
  const cleanupAlreadySettled = (owner: ResourceOwner, observedBefore: number): boolean => {
    const settled = settledCleanups.get(key(owner));
    if (settled?.worktreeId !== owner.worktreeId || settled.sequence <= observedBefore) return false;
    const current = options.store.getTask(owner);
    return (current === null || current.status === "done") && getCleanupSchedule(owner) === null
      && !unfinishedWeb().some(value => sameClaim(value, owner));
  };
  // Web journals and observed native cleanup owners bind schedules to an exact worktree.
  const webOwner = (identity: ClaimIdentity, expectedUserId = options.userId): ResourceOwner | undefined => {
    const web = options.webStore.getTask(identity);
    if (web == null || web.workerId !== options.workerId || web.serverOrigin !== options.serverOrigin || web.userId !== expectedUserId) return undefined;
    if ("worktreeId" in identity && identity.worktreeId !== web.worktreeId) throw new Error("The Web execution has a conflicting worktree identity.");
    return web;
  };
  const unfinishedWeb = () => options.webStore.listUnfinishedTasks().filter(record => webOwner(record) !== undefined);
  const prelaunchLegacy = (record: NonNullable<ReturnType<WebExecutionStore["getTask"]>>): boolean =>
    record.status === "active" && record.resources.worktree === null && record.resources.nativeSession === null && record.webExecution === null;
  const observeLegacyBinding = async (
    record: NonNullable<ReturnType<WebExecutionStore["getTask"]>>, signal: AbortSignal, evidence: "current-claim" | "stopped",
  ): Promise<WorktreeBinding | undefined> => {
    if (!prelaunchLegacy(record)) return;
    const project = projectFor(record);
    const scan = await workerOperation(operation => options.git.scanWorktrees(project, operation, true), signal);
    if (!scan.enumerationComplete || scan.unknown.length > 0) throw scan.unknown[0]?.error ?? new Error("Git resource enumeration is incomplete.");
    const legacy = [...scan.validated, ...scan.quarantined].find(item => item.taskId === record.taskId && path.basename(item.binding.worktreePath) === record.taskId);
    if (legacy === undefined) return;
    if ([...options.store.listUnfinishedTasks(), ...options.webStore.listUnfinishedTasks(), ...ending.values()]
      .some(other => other.taskId === record.taskId && !sameClaim(other, record))) throw new Error("Another execution reserves the registered task worktree.");
    if (evidence === "current-claim") {
      if (!options.verifyWebUnregistered) throw new Error("Web launch provenance cannot be verified.");
      await options.verifyWebUnregistered(record, signal);
    }
    return workerOperation(operation => options.git.verifyWorktree(project, record, operation, legacy.binding.worktreePath, true), signal);
  };
  const needsNativeCleanup = (identity: CleanupTarget): boolean => {
    const web = options.webStore.getTask(identity);
    if (web !== null && webOwner(identity) === undefined) throw new Error("The Web execution belongs to another Worker identity.");
    return web === null || web.webExecution === null
      || web.webExecution.launchSubmission !== "not-submitted" && web.webExecution.controllerProcess === null;
  };
  const nativeCleanupBatch = (targets: readonly CleanupTarget[], signal: AbortSignal) => {
    let batch: ReturnType<RetiredClaimNativeCleanup["locate"]> | undefined;
    return async (target: CleanupTarget): Promise<LocatedClaimNative> => {
      if (options.retiredNativeCleanup === undefined) throw new Error("Original claim native inventory cleanup is unavailable.");
      batch ??= cleanupOperation(operation => options.retiredNativeCleanup!.locate(targets, operation), signal);
      const result = (await batch).get(key(target));
      if (result === undefined) throw new Error("Original claim native inventory is incomplete.");
      if ("error" in result) throw result.error;
      return result.located;
    };
  };
  const getCleanupSchedule = (identity: ClaimIdentity, expectedUserId = options.userId) => {
    const owner = webOwner(identity, expectedUserId);
    if (owner !== undefined) return options.store.getCleanupSchedule(identity, owner);
    if (!retiredClaims.has(key(identity))) return null;
    const retained = ending.get(key(identity));
    return options.store.getCleanupSchedule(identity, retained !== undefined && hasWorktreeIdentity(retained) ? retained : undefined);
  };
  const deleteCleanupSchedule = (identity: ClaimIdentity, expectedUserId = options.userId): void => {
    const owner = webOwner(identity, expectedUserId);
    if (owner !== undefined) options.store.deleteCleanupSchedule(identity, owner);
    else if (retiredClaims.has(key(identity))) {
      const retained = ending.get(key(identity));
      options.store.deleteCleanupSchedule(identity, retained !== undefined && hasWorktreeIdentity(retained) ? retained : undefined);
    }
  };
  const cleanupSchedules = () => {
    const schedules: NonNullable<ReturnType<WorkerStore["getCleanupSchedule"]>>[] = [];
    for (const record of [...options.webStore.listUnfinishedTasks(), ...options.webStore.listCompletedTasks()]) {
      try { const schedule = getCleanupSchedule(record); if (schedule !== null) schedules.push(schedule); }
      catch (error) { options.emit({ kind: "cleanup-error", identity: record, message: "The cleanup schedule conflicts with the original Web execution; it remains retained.", error }); }
    }
    return schedules;
  };
  const ending = new Map<string, CleanupTarget>(cleanupSchedules().map(record => [key(record), record]));
  const retiredClaims = new Set<string>();
  const ownedClaims = new Set<string>();
  let capacityWarning = "";
  const cleanupRetries = new Map<string, { failures: number; nextAttemptAt: number; stage: string; lastError: string | null; archiveRepairCode?: ArchiveRepairCode | null }>();
  const snapshotWarnings = new Map<string, Set<string>>();
  let unmappedWarnings = new Set<string>();
  let nextRepository = 0;
  let nextPlatformRepository = 0;
  let nextPendingProject = 0;
  let shuttingDown = false;
  let ticking = false;
  let tickJoined: Promise<void> = Promise.resolve();
  let shutdownWork: Promise<boolean> | undefined;
  const shutdownTerminalJobs = new Map<string, Promise<void>>();
  let cycleCoverage: "unknown" | "complete" | "partial" = "unknown";
  let reconciliationPhase: "reconciliation" | "inventory" | "project-preparation" | "resource-observation" | "claim-search" | "claim-request" = "reconciliation";
  let projectSearchFailure = false;
  let projectInventoryFailure = false;
  const schedulerFailures = new Map<string, string>();
  const recoverScheduler = (phase: string): void => {
    const operationId = schedulerFailures.get(phase);
    if (operationId !== undefined) { observe(m => m.recover(operationId)); schedulerFailures.delete(phase); }
  };
  let webDiscardJob: Promise<void> | null = null;
  const confirmedClaims = new Set<string>();
  const unattributedWebIdentities = new Map<string, { identity: ClaimIdentity; operationKey: string }>();
  const pendingWebFailures = new Map<string, { identity: ClaimIdentity; phase: Extract<WorkerObservedPhase, { kind: "execution" }>; error: unknown; operationKey: string; observedFailure: { firstObservedAt: string; lastObservedAt: string; occurrencesInRun: number; running?: boolean } }>();
  const partialKey = (identity: string, operationKey: string): string => `web-renewal/${identity}/${operationKey}`;
  const recordWebFailure = (identity: ClaimIdentity, phase: Extract<WorkerObservedPhase, { kind: "execution" }>, error: unknown, operationKey: string, observedFailure?: { firstObservedAt: string; lastObservedAt: string; occurrencesInRun: number; running?: boolean }): void => {
    const identityKey = key(identity), pendingKey = `${identityKey}/${operationKey}`;
    if (!confirmedClaims.has(identityKey)) {
      const at = new Date(now()).toISOString(), previous = pendingWebFailures.get(pendingKey);
      const prior = previous?.operationKey === operationKey ? previous.observedFailure : undefined;
      pendingWebFailures.set(pendingKey, { identity, phase, error, operationKey, observedFailure: { firstObservedAt: prior?.firstObservedAt ?? observedFailure?.firstObservedAt ?? at, lastObservedAt: observedFailure?.lastObservedAt ?? at, occurrencesInRun: Math.min(Number.MAX_SAFE_INTEGER, (prior?.occurrencesInRun ?? 0) + (observedFailure?.occurrencesInRun ?? 1)), running: observedFailure?.running ?? prior?.running ?? false } });
      observe(m => m.setUnattributed(partialKey(identityKey, operationKey), true));
      return;
    }
    observe(m => m.setUnattributed(partialKey(identityKey, operationKey), false));
    const failureKey = `false/${identityKey}/${operationKey}`, failureId = monitoringFailures.get(failureKey) ?? randomUUID();
    monitoringFailures.set(failureKey, failureId);
    observe(m => m.fail({ operationId: failureId, component: "execution", phase: phase.phase, scope: { kind: "claim", projectId: identity.projectId, taskId: identity.taskId, claimId: identity.claimId }, ...worktreeContext(identity), error, ...(observedFailure === undefined ? {} : { observedFailure }), ...(observedFailure?.running ? { retryState: "running" as const } : {}) }));
  };
  const confirmWebClaim = (identity: ClaimIdentity): void => {
    const identityKey = key(identity); confirmedClaims.add(identityKey);
    for (const [pendingKey, pending] of pendingWebFailures) if (key(pending.identity) === identityKey) { pendingWebFailures.delete(pendingKey); observe(m => m.setUnattributed(partialKey(identityKey, pending.operationKey), false)); recordWebFailure(pending.identity, pending.phase, pending.error, pending.operationKey, pending.observedFailure); }
  };
  const discardWebClaim = (identityKey: string): void => {
    confirmedClaims.delete(identityKey);
    for (const [pendingKey, pending] of unattributedWebIdentities) if (key(pending.identity) === identityKey) { unattributedWebIdentities.delete(pendingKey); observe(m => m.setUnattributed(partialKey(identityKey, pending.operationKey), false)); }
    for (const [pendingKey, pending] of pendingWebFailures) if (key(pending.identity) === identityKey) { pendingWebFailures.delete(pendingKey); observe(m => m.setUnattributed(partialKey(identityKey, pending.operationKey), false)); }
  };
  try { options.webBackend.setMonitoringObserver?.({ observeWorktree: selectWorktree, ...(deps.observePhase === undefined ? {} : { observePhase: deps.observePhase }), observeSelect: (identity, phase, operationKey) => { monitoringPhases.set(key(identity), phase.phase); monitoringOperations.set(key(identity), operationKey); }, observeSuccess: (identity, phase, operationKey) => {
    const identityKey = key(identity), pendingKey = `${identityKey}/${operationKey}`, pending = pendingWebFailures.get(pendingKey);
    if (pending !== undefined) { pendingWebFailures.delete(pendingKey); observe(m => m.setUnattributed(partialKey(identityKey, pending.operationKey), false)); return; }
    if (phase.kind === "execution") deps.observeSuccess?.(identity, phase, operationKey); else if (controllers.get(identityKey)?.terminal === true) recoverCleanupPhase(identity, phase.phase);
  }, observeFailure: (identity, phase, error, operationKey, observedFailure) => {
    if (phase.kind !== "execution") return false;
    recordWebFailure(identity, phase, error, operationKey ?? phase.phase, observedFailure);
    return true;
  }, observeRetry: (identity, operationKey, running) => {
    const identityKey = key(identity), failure = monitoringFailures.get(`false/${identityKey}/${operationKey}`), pending = pendingWebFailures.get(`${identityKey}/${operationKey}`);
    if (pending !== undefined) pending.observedFailure.running = running;
    if (failure !== undefined) observe(m => m.updateFailureRetry(failure, running ? "running" : "none"));
  }, observeUnattributed: (identity, operationKey, value) => {
    const identityKey = key(identity), pendingKey = `${identityKey}/${operationKey}`;
    if (value) unattributedWebIdentities.set(pendingKey, { identity: { projectId: identity.projectId, taskId: identity.taskId, claimId: identity.claimId }, operationKey });
    else unattributedWebIdentities.delete(pendingKey);
    observe(m => m.setUnattributed(partialKey(identityKey, operationKey), value));
    return true;
  }, observeDiscard: (identity, operationKey) => {
    const identityKey = key(identity), pendingKey = `${identityKey}/${operationKey}`, failureKey = `false/${identityKey}/${operationKey}`, failure = monitoringFailures.get(failureKey);
    if (pendingWebFailures.delete(pendingKey)) observe(m => m.setUnattributed(partialKey(identityKey, operationKey), false));
    if (failure !== undefined) { observe(m => m.discardFailure(failure)); monitoringFailures.delete(failureKey); }
  } }); } catch { /* Monitoring remains independent of the backend. */ }
  const cancel = (): void => {
    shuttingDown = true;
    const reason = normalSignal.aborted ? normalSignal.reason : new Error("Worker shutdown requested.");
    executionCancellation.abort(reason);
    for (const running of controllers.values()) running.controller.abort(reason);
  };
  normalSignal.addEventListener("abort", cancel, { once: true });
  if (normalSignal.aborted) cancel();
  const serialize = async <T>(identity: ClaimIdentity, action: () => Promise<T>): Promise<T> => {
    const identityKey = taskKey(identity);
    const previous = tails.get(identityKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    tails.set(identityKey, tail);
    await previous;
    try { return await action(); }
    finally { release(); if (tails.get(identityKey) === tail) tails.delete(identityKey); }
  };
  const projectFor = (identity: { projectId: string }): WorkerProject => {
    const project = options.store.getProject(identity);
    if (project === null) throw new Error(`The project mapping is missing for ${identity.projectId}.`);
    return project;
  };
  const projectInvalidations = new Map<string, number>();
  const preparedProjects = new Set<string>();
  const preparationJobs = new Map<string, Promise<void>>();
  const promptUnavailable = new Set<string>();
  let activeCoverage: { covered: Set<string>; unavailable: Set<string> } | undefined;
  const invalidateProject = (projectId: string): void => {
    promptUnavailable.add(projectId);
    preparedProjects.delete(projectId);
    updatePromptDemand();
    projectInvalidations.set(projectId, (projectInvalidations.get(projectId) ?? 0) + 1);
    activeCoverage?.covered.delete(projectId);
    activeCoverage?.unavailable.add(projectId);
    options.onInventory?.(null);
    for (const [identity, activity] of monitoringActivities) if (identity.startsWith(`false/${projectId}/`)) {
      observe(m => m.endActivity(activity)); monitoringActivities.delete(identity);
      const limitKey = `limit/${identity.slice("false/".length)}`, limitFailure = monitoringFailures.get(limitKey);
      if (limitFailure !== undefined) { observe(m => m.discardFailure(limitFailure)); monitoringFailures.delete(limitKey); }
      const ownerKey = identity.slice("false/".length);
      for (const [failureKey, operationId] of nameMonitoringFailures) if (failureKey.startsWith(`${ownerKey}/`)) { observe(m => m.discardFailure(operationId)); nameMonitoringFailures.delete(failureKey); }
      nameFailureThisJob.delete(ownerKey);
      const recovery = webRecoveryFailures.get(identity.slice("false/".length));
      if (recovery !== undefined) observe(m => m.discardFailure(recovery.id));
      webRecoveryFailures.delete(identity.slice("false/".length));
    }
    for (const [failureKey, operationId] of monitoringFailures) if (failureKey.startsWith(`false/${projectId}/`) || failureKey.startsWith(`limit/${projectId}/`)) { observe(m => m.discardFailure(operationId)); monitoringFailures.delete(failureKey); }
    for (const [failureKey, operationId] of nameMonitoringFailures) if (failureKey.startsWith(`${projectId}/`)) { observe(m => m.discardFailure(operationId)); nameMonitoringFailures.delete(failureKey); }
    for (const identity of monitoringLimitRetries) if (identity.startsWith(`${projectId}/`)) monitoringLimitRetries.delete(identity);
    for (const identity of recoveredLimitNames.keys()) if (identity.startsWith(`${projectId}/`)) recoveredLimitNames.delete(identity);
    for (const [identity, recovery] of webRecoveryFailures) if (identity.startsWith(`${projectId}/`)) { observe(m => m.discardFailure(recovery.id)); webRecoveryFailures.delete(identity); }
    for (const identity of confirmedClaims) if (identity.startsWith(`${projectId}/`)) discardWebClaim(identity);
    for (const pending of pendingWebFailures.values()) if (pending.identity.projectId === projectId) discardWebClaim(key(pending.identity));
    for (const pending of unattributedWebIdentities.values()) if (pending.identity.projectId === projectId) discardWebClaim(key(pending.identity));
    for (const [identity, running] of controllers) {
      if (identity.startsWith(`${projectId}/`) && !running.terminal) running.controller.abort(new Error("The project is unavailable; its original claim and resources are retained."));
    }
  };
  const configurationFor = (task: LocalTask): ExecutionConfiguration | null => {
    const mode = "web";
    const repository = configuration.repositories.find(repository => repository.project.projectId === task.projectId);
    const current = repository?.configuration ?? configuration.globalConfiguration;
    // Fresh claims freeze native settings before their Web execution record exists.
    const frozen = options.webStore.getTask(task)?.configuration ?? options.store.getNativeConfiguration(task);
    const recoveryLimit = configuration.recoveryLimit ?? current?.recoveryLimit ?? (frozen != null && "recoveryLimit" in frozen ? frozen.recoveryLimit as number : undefined);
    if (frozen != null && recoveryLimit !== undefined) return { ...frozen, agentControlMode: mode, recoveryLimit };
    if (repository === undefined && (configuration.targetProjectIds?.includes(task.projectId) || configuration.targetProjectIds === undefined && configuration.readyProjectIds !== undefined && selected(task.projectId))) return null;
    // An unfrozen historical claim cannot borrow parameters validated for another backend.
    if (current == null || current.agentControlMode !== mode) return null;
    return current.agent === task.agent ? { ...current, agentControlMode: mode } : { agent: task.agent, agentControlMode: mode, model: null, args: [], recoveryLimit: current.recoveryLimit };
  };
  const canAdvance = (task: LocalTask): boolean => canAdvanceProject(task.projectId) && configurationFor(task) !== null;
  const updatePromptDemand = (): void => {
    options.onPromptDemand?.([...new Set(options.store.listUnfinishedTasks().filter(task => task.status === "active" && !promptUnavailable.has(task.projectId) && canAdvance(task)).map(task => task.projectId))]);
  };
  const snapshot = async (signal: AbortSignal, coveredProjects: ReadonlySet<string>, currentClaims: readonly ResourceOwner[] = [], unavailable: ReadonlySet<string> = new Set(), fileGated: ReadonlySet<string> = new Set()): Promise<Snapshot> => {
    const owners = new Map<string, ResourceOwner>();
    const conflicts = new Set<string>();
    const proven = new Set([...options.store.listTasks().map(key), ...currentClaims.map(key)]);
    const unresolved = new Set<string>();
    const quarantined = new Map<string, ResourceOwner>();
    const scannedProjects = new Set<string>();
    const unavailableProjects = new Set<string>();
    const currentWarnings = new Map<string, Map<string, string>>();
    const unmapped = new Set<string>();
    const recordOwner = (owner: ResourceOwner): void => {
      if (options.store.getProject(owner) === null) {
        unmapped.add(key(owner));
        if (!unmappedWarnings.has(key(owner))) options.emit({ kind: "warning", message: `Restore the project configuration for owned resources in ${owner.projectId}; they retain capacity.` });
      }
      const previous = owners.get(key(owner));
      if (previous !== undefined && previous.worktreeId !== owner.worktreeId) throw new Error("The same claim has conflicting resource identities.");
      owners.set(key(owner), owner);
    };
    const webRecords = unfinishedWeb();
    for (const task of webRecords) { recordOwner(task); proven.add(key(task)); }
    const knownByTask = new Map<string, ResourceOwner[]>();
    const retainKnown = (owner: ResourceOwner): void => {
      const known = knownByTask.get(owner.taskId);
      if (known === undefined) knownByTask.set(owner.taskId, [owner]);
      else known.push(owner);
    };
    for (const owner of [...currentClaims, ...webRecords, ...options.store.listCleanupSchedules(), ...[...ending.values()].filter(hasWorktreeIdentity)]) retainKnown(owner);
    let completedObserved = false;
    for (const project of options.store.listProjects()) {
      const warnings = new Map<string, string>();
      currentWarnings.set(project.projectId, warnings);
      if (fileGated.has(project.projectId)) continue;
      const target = configuration.targetProjectIds === undefined
        ? configuration.repositories.some(repository => repository.project.projectId === project.projectId)
        : configuration.targetProjectIds.includes(project.projectId);
      try {
        const scan = await workerOperation(operation => options.git.scanWorktrees(project, operation, unavailable.has(project.projectId) || !target), signal);
        if (!scan.enumerationComplete || scan.unknown.length > 0) throw scan.unknown[0]?.error ?? new Error("Git resource enumeration is incomplete.");
        const matchOwner = async (item: RegisteredWorktree): Promise<ResourceOwner | undefined> => {
          const matches = new Map<string, ResourceOwner>();
          for (const owner of knownByTask.get(item.taskId) ?? []) {
            const mapping = options.store.getProject(owner);
            if (mapping === null || repositoryIdentity(mapping.repoUrl) !== repositoryIdentity(project.repoUrl)
              || !await sameWorktreeLocation(mapping.localPath, project.localPath)) continue;
            const web = options.webStore.getTask(owner);
            if (web != null && (web.worktreeId !== owner.worktreeId || webOwner(web) === undefined)) continue;
            if (web != null && web.resources.worktree !== null) {
              const original = web.resources.worktree;
              if (original.branch !== item.binding.branch || repositoryIdentity(web.repoUrl) !== repositoryIdentity(project.repoUrl)
                || !await sameWorktreeLocation(original.repositoryPath, item.binding.repositoryPath)
                || !await sameWorktreeLocation(original.commonDirectory, item.binding.commonDirectory)
                || !await sameWorktreeLocation(original.worktreePath, item.binding.worktreePath)) continue;
            } else {
              const directoryName = path.basename(item.binding.worktreePath);
              if (directoryName !== owner.worktreeId && (directoryName !== owner.taskId || web == null || !prelaunchLegacy(web))) continue;
            }
            const previous = matches.get(key(owner));
            if (previous !== undefined && previous.worktreeId !== owner.worktreeId) throw new Error("The same claim has conflicting resource identities.");
            matches.set(key(owner), owner);
          }
          if (matches.size > 1) throw new Error("The registered task worktree matches more than one execution.");
          return matches.values().next().value;
        };
        const observeRegistration = async (item: RegisteredWorktree & { error?: unknown }): Promise<void> => {
          let owner = await matchOwner(item);
          if (owner === undefined && !completedObserved) {
            for (const record of options.webStore.listCompletedTasks()) if (webOwner(record) !== undefined) retainKnown(record);
            completedObserved = true;
            owner = await matchOwner(item);
          }
          if (owner === undefined) {
            const identity = taskKey({ projectId: project.projectId, taskId: item.taskId });
            conflicts.add(identity);
            warnings.set(identity, `Retained registered worktree ${item.binding.worktreePath} for ${identity}; no original execution matches its path.`);
            const failure = unprovenMonitoringFailures.get(identity) ?? { projectId: project.projectId, operationId: randomUUID() };
            unprovenMonitoringFailures.set(identity, failure);
            observe(m => m.fail({ operationId: failure.operationId, component: "resources", phase: "resource-observation",
              scope: { kind: "project", projectId: project.projectId },
              error: new MonitoringOwnershipUnconfirmedEvidence(), retryState: "manual" }));
            return;
          }
          const identity = key(owner);
          recordOwner(owner);
          proven.add(identity);
          if (item.error === undefined) return;
          quarantined.set(identity, owner);
          unresolved.add(identity);
          const fresh = !quarantinedMonitoringFailures.has(identity);
          const failure = quarantinedMonitoringFailures.get(identity) ?? { owner, operationId: randomUUID() };
          quarantinedMonitoringFailures.set(identity, failure);
          const error = item.error instanceof WorktreePreconditionError ? item.error : new WorktreePreconditionError("validation_failed", "The original worktree failed validation and remains reserved.", { cause: item.error });
          observe(m => m.fail({ operationId: failure.operationId, component: "resources", phase: "resource-observation", scope: { kind: "claim", projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId }, ...worktreeContext(owner), error }));
          if (fresh) options.emit({ kind: "resource-quarantined", message: `Worktree ${identity} failed validation; its original resources are retained.`, error: item.error });
        };
        for (const item of scan.validated) await observeRegistration(item);
        for (const item of scan.quarantined) await observeRegistration(item);
      } catch (error) {
        if (isWorkerCancellation(error, signal)) throw error;
        unavailableProjects.add(project.projectId);
        const operationId = resourceMonitoringFailures.get(project.projectId) ?? randomUUID();
        resourceMonitoringFailures.set(project.projectId, operationId);
        observe(m => m.fail({ operationId, component: "resources", phase: "resource-observation", scope: { kind: "project", projectId: project.projectId }, error }));
        warnings.set("discovery", `Could not inspect Git worktrees for project ${project.projectId}; its pending work and claims remain fenced.`);
        continue;
      }
      const previousFailure = resourceMonitoringFailures.get(project.projectId);
      if (previousFailure !== undefined) { observe(m => m.recover(previousFailure)); resourceMonitoringFailures.delete(project.projectId); }
      scannedProjects.add(project.projectId);
    }
    for (const [identity, failure] of unprovenMonitoringFailures) {
      if (scannedProjects.has(failure.projectId) && coveredProjects.has(failure.projectId) && !conflicts.has(identity)) {
        observe(m => m.recover(failure.operationId));
        unprovenMonitoringFailures.delete(identity);
      }
    }
    for (const [projectId, warnings] of currentWarnings) {
      const previous = snapshotWarnings.get(projectId);
      for (const [identity, message] of warnings) if (!previous?.has(identity)) options.emit({ kind: "warning", message });
      snapshotWarnings.set(projectId, new Set([...warnings.keys(), ...(coveredProjects.has(projectId) ? [] : previous ?? [])]));
    }
    for (const [identity, failure] of quarantinedMonitoringFailures) {
      if (!quarantined.has(identity) && scannedProjects.has(failure.owner.projectId) && coveredProjects.has(failure.owner.projectId)) {
        observe(m => m.recover(failure.operationId)); quarantinedMonitoringFailures.delete(identity);
      }
    }
    unmappedWarnings = unmapped;
    return { conflicts, owners, proven, unresolved, scannedProjects, unavailableProjects, quarantined };
  };
  const ownInventory = async (signal: AbortSignal, initialInvalidations: ReadonlyMap<string, number>): Promise<{ tasks: Map<string, Task>; covered: Set<string>; unavailable: Set<string> }> => {
    const projects = [...new Set([...options.store.listProjects().map(project => project.projectId), ...configuration.repositories.map(repository => repository.project.projectId), ...(configuration.targetProjectIds ?? [])])].map(projectId => ({ projectId }));
    const observation = await options.remote.ownInventory(projects, options.workerId, signal, invalidateProject, (projectId, error) => {
      if (isWorkerCancellation(error, signal)) return;
      projectInventoryFailure = true;
      const operationId = inventoryMonitoringFailures.get(projectId) ?? randomUUID();
      inventoryMonitoringFailures.set(projectId, operationId);
      observe(m => m.fail({ operationId, component: "inventory", phase: "inventory", scope: { kind: "project", projectId }, error }));
    });
    const invalidated = (id: string): boolean => (projectInvalidations.get(id) ?? 0) !== (initialInvalidations.get(id) ?? 0);
    const observedTasks = [...observation.tasks];
    const result = new Map<string, Task>();
    for (const task of observedTasks) {
      if (invalidated(task.projectId) || readWorkerClaim(task.properties)?.agentControlMode !== "web") continue;
      const owner = remoteOwner(task);
      observe(m => {
        const identity = key(owner), paused = readTaskBlocked(task.properties) === true;
        const wasPaused = pausedClaims.has(identity), activity = monitoringActivities.get(`false/${identity}`);
        if (paused) pausedClaims.add(identity); else pausedClaims.delete(identity);
        if (activity !== undefined && paused !== wasPaused) {
          const previous = monitoringPhases.get(identity);
          const phase = previous === "waiting" ? "waiting" : "observation";
          m.updateActivity(activity, paused
            ? { phase: "paused", status: "paused", waitReason: "task-paused" }
            : { phase, status: phase === "waiting" ? "waiting" : "running", waitReason: phase === "waiting" ? "native-input" : null });
        }
      });
      if (readWorkerClaim(task.properties)!.workerId !== options.workerId) throw new Error("The claim inventory contains another worker's claim.");
      if (result.has(key(owner))) throw new Error("The claim inventory contains duplicate claims.");
      result.set(key(owner), task);
      confirmWebClaim(owner);
      if (options.store.getProject(owner) !== null) options.store.registerPending({ projectId: task.projectId, taskId: task.id, claimId: owner.claimId, agent: readWorkerClaim(task.properties)!.agent, agentControlMode: readWorkerClaim(task.properties)!.agentControlMode });
    }
    const covered = new Set(observation.coveredProjectIds.filter(id => !invalidated(id)));
    for (const pending of pendingWebFailures.values()) if (covered.has(pending.identity.projectId) && !result.has(key(pending.identity))) discardWebClaim(key(pending.identity));
    for (const pending of unattributedWebIdentities.values()) if (covered.has(pending.identity.projectId) && !result.has(key(pending.identity))) discardWebClaim(key(pending.identity));
    for (const identity of confirmedClaims) if (covered.has(identity.slice(0, identity.indexOf("/"))) && !result.has(identity)) discardWebClaim(identity);
    for (const projectId of covered) {
      const previous = inventoryMonitoringFailures.get(projectId);
      if (previous !== undefined) { observe(m => m.recover(previous)); inventoryMonitoringFailures.delete(projectId); }
    }
    const unavailable = new Set([...observation.unavailableProjectIds, ...projects.map(project => project.projectId).filter(invalidated)]);
    for (const id of covered) promptUnavailable.delete(id);
    for (const id of unavailable) promptUnavailable.add(id);
    updatePromptDemand();
    return { tasks: result, covered, unavailable };
  };
  const startJob = (identity: ClaimIdentity, action: (signal: AbortSignal) => Promise<void>, terminal: boolean, webClaim?: WorkerClaim, shutdownCleanup = false): void => {
    const identityKey = key(identity);
    if (shuttingDown && !shutdownCleanup || jobs.has(identityKey) || !terminal && !canAdvanceProject(identity.projectId)) return;
    if (!terminal) { nameFailureThisJob.delete(identityKey); monitoringPhases.set(identityKey, "observation"); monitoringOperations.set(identityKey, "observation"); }
    const controller = new AbortController();
    let operationId: string | undefined;
    const scope = { kind: "claim" as const, projectId: identity.projectId, taskId: identity.taskId, claimId: identity.claimId };
    observe(m => {
      const activityKey = `${terminal}/${identityKey}`;
      operationId = monitoringActivities.get(activityKey);
      if (operationId === undefined) {
        operationId = m.startActivity(terminal
          ? { kind: "cleanup", phase: "observation", scope, status: tails.has(taskKey(identity)) ? "queued" : "running", waitReason: tails.has(taskKey(identity)) ? "operation-lock" : null }
          : { kind: "execution", phase: pausedClaims.has(identityKey) ? "paused" : "observation", scope, status: pausedClaims.has(identityKey) ? "paused" : tails.has(taskKey(identity)) ? "queued" : "running", waitReason: pausedClaims.has(identityKey) ? "task-paused" : tails.has(taskKey(identity)) ? "operation-lock" : null });
        monitoringActivities.set(activityKey, operationId);
      }
      monitoringJobs.set(identityKey, operationId);
    });
    controllers.set(identityKey, { controller, terminal, ...(webClaim === undefined ? {} : { webClaim }) });
    const signal = shutdownCleanup ? AbortSignal.timeout(CLEANUP_OPERATION_MS) : AbortSignal.any([normalSignal, controller.signal]);
    const job = serialize(identity, () => {
      if (!terminal && !canAdvanceProject(identity.projectId)) return Promise.resolve();
      if (operationId !== undefined && (terminal || !pausedClaims.has(identityKey))) observe(m => {
        m.updateActivity(operationId!, { status: "running", waitReason: null, nextAttemptAt: null });
        const failure = terminal ? monitoringFailures.get(`true/${identityKey}/observation`) : undefined;
        if (failure !== undefined) m.updateFailureRetry(failure, "running");
      });
      const execute = () => action(signal);
      const work = terminal && options.cleanupCommandLifecycle !== undefined ? withOwnedCommandLifecycle(options.cleanupCommandLifecycle(identity), execute) : execute();
      return work.then(() => {
        if (terminal) for (const [failureKey, failure] of monitoringFailures) if (failureKey.startsWith(`true/${identityKey}/`)) { observe(m => m.recover(failure)); monitoringFailures.delete(failureKey); }
      });
    }).catch((error: unknown) => {
      if (isWorkerCancellation(error, signal)) return;
      let cleanupMessage: string | undefined;
      let reportedError = error;
      let task: LocalTask | null = null;
      if (terminal) {
        const owner = ending.get(identityKey)!;
        let count = cleanupRetries.get(identityKey)?.failures ?? 0;
        let previous: ReturnType<WorkerStore["getCleanupSchedule"]> = null;
        try { previous = getCleanupSchedule(owner); count = Math.max(count, previous?.failures ?? 0); }
        catch (storageError) { reportedError = new AggregateError([error, storageError], "Cleanup failed and its retry state could not be read."); }
        const cause = error instanceof WorkerCleanupError ? error.cause : error;
        const stage = error instanceof WorkerCleanupError ? error.stage : "observation";
        const repairCode = stage !== "archive" ? null : cause instanceof ArchiveRepairRequiredError ? cause.code : cleanupRetries.get(identityKey)?.archiveRepairCode ?? previous?.archiveRepairCode ?? null;
        const archiveBusy = stage === "archive" && isArchiveBusy(cause);
        if (!archiveBusy) count = Math.min(count + 1, Number.MAX_SAFE_INTEGER);
        const retryMs = archiveBusy ? 5000 + Math.floor(Math.random() * 2001) : repairCode === null ? Math.min(60_000, 1000 * 2 ** Math.min(count - 1, 6)) : ARCHIVE_REPAIR_PROBE_INTERVAL_MS;
        const nextAttemptAt = now() + retryMs;
        if (operationId !== undefined) {
          const failureKey = `true/${identityKey}/${repairCode !== null && !(cause instanceof ArchiveRepairRequiredError) ? "archive-observation" : stage}`, failureId = monitoringFailures.get(failureKey) ?? randomUUID();
          monitoringFailures.set(failureKey, failureId);
          observe(m => m.fail({ operationId: failureId, component: "cleanup", phase: stage, scope, ...worktreeContext(owner), error: archiveBusy ? new MonitoringArchiveBusyEvidence(error) : error, retryState: "scheduled", nextAttemptAt: new Date(nextAttemptAt).toISOString() }));
          for (const [key, pending] of monitoringFailures) if (key.startsWith(`true/${identityKey}/`) && key !== failureKey) observe(m => m.updateFailureRetry(pending, "scheduled", new Date(nextAttemptAt).toISOString()));
          observe(m => m.updateActivity(operationId!, { phase: stage as "observation" | "agent-stop" | "backend-close" | "archive" | "worktree-removal", status: "waiting", waitReason: archiveBusy || repairCode === null ? "retry-backoff" : "recovery-blocked", nextAttemptAt: new Date(nextAttemptAt).toISOString() }));
        }
        // Storage failures must not reject the job or prevent shutdown from proving stop.
        const lastError = error instanceof Error ? error.message || error.name : String(error) || "Unknown cleanup error";
        cleanupRetries.set(identityKey, { failures: count, nextAttemptAt, stage, lastError, archiveRepairCode: repairCode });
        try {
          const web = options.webStore.getTask(owner);
          if (previous === null && hasWorktreeIdentity(owner) && (retiredClaims.has(identityKey) || web != null && webOwner(owner) !== undefined && web.worktreeId === owner.worktreeId)) previous = ensureCleanupSchedule(options.store, owner, now(), webOwner(owner) ?? owner);
          if (previous !== null && !retiredClaims.has(identityKey) && (web == null || webOwner(previous) === undefined || web.worktreeId !== previous.worktreeId)) throw new Error("Cleanup schedule does not match the original Web execution.");
          if (previous !== null) options.store.saveCleanupSchedule(previous, { ...previous, failures: count, nextAttemptAt, stage, lastError, archiveRepairCode: repairCode }, webOwner(previous) ?? previous);
          task = options.store.getTask(identity);
        } catch (storageError) { reportedError = new AggregateError([reportedError, storageError], "Cleanup failed; retry persistence is unconfirmed and in-process backoff remains active."); }
        const stopStatus = stage === "archive" || stage === "worktree-removal" || stage === "backend-close" ? "Agent stop confirmed; " : "";
        cleanupMessage = archiveBusy ? `Cleanup ${key(owner)}: archive busy, short retry at ${new Date(nextAttemptAt).toISOString()} (${retryMs} ms). Originals retained; failure count unchanged.` : repairCode !== null ? `Archive requires repair (${repairCode}); originals retained; next condition probe ${new Date(nextAttemptAt).toISOString()}.` : `Cleanup ${key(owner)} failed at ${stage}; ${stopStatus}next retry ${new Date(nextAttemptAt).toISOString()} (${retryMs} ms). Resources remain retained; correct the reported cause and normal reconciliation retries automatically.`;
      } else {
        task = options.store.getTask(identity);
        if (operationId !== undefined && !signal.aborted && !nameFailureThisJob.has(identityKey) && monitoringOperations.get(identityKey) !== "grant-identity-lost" && !(error instanceof WebRecoveryBlockedError && webRecoveryFailures.has(identityKey))) {
          const phase = monitoringPhases.get(identityKey) ?? "observation";
          const failureKey = `false/${identityKey}/${monitoringOperations.get(identityKey) ?? phase}`, failureId = monitoringFailures.get(failureKey) ?? randomUUID();
          monitoringFailures.set(failureKey, failureId);
          observe(m => m.fail({ operationId: failureId, component: "execution", phase, scope, ...worktreeContext(identity), error }));
        }
      }
      options.emit({ kind: terminal ? "cleanup-error" : "execution-error", ...(task === null ? {} : { task }), message: terminal ? cleanupMessage! : "The task operation failed; native recovery accounting remains independent of orchestration retries.", error: reportedError });
    }).finally(() => {
      if (!terminal && monitoringLimitRetries.delete(identityKey)) { const failure = monitoringFailures.get(`limit/${identityKey}`); if (failure !== undefined) observe(m => m.updateFailureRetry(failure, "none")); }
      monitoringJobs.delete(identityKey); if (jobs.get(identityKey) === job) { jobs.delete(identityKey); controllers.delete(identityKey); }
    });
    jobs.set(identityKey, job);
  };
  const runCleanup = async (owner: CleanupTarget, deleteWorktree: boolean, signal?: AbortSignal, scope?: TerminalCleanupContext, control = false, expectedUserId = options.userId): Promise<void> => {
    if (deleteWorktree && hasWorktreeIdentity(owner) && scope === undefined) {
      const attempt = { owner, attemptId: randomUUID() };
      executionCapacity.beginAttempt(attempt);
      const context: TerminalCleanupContext = { attempt, onExecutionStopped: notice => {
        const current = ending.get(key(owner));
        const controller = controllers.get(key(owner));
        if ((!current || hasWorktreeIdentity(current) && current.worktreeId === owner.worktreeId) && (controller?.terminal === true || control && controller === undefined)) executionCapacity.notice(notice);
      } };
      try { return await runCleanup(owner, deleteWorktree, signal, context, control, expectedUserId); }
      finally { executionCapacity.endAttempt(attempt); }
    }
    if (!hasWorktreeIdentity(owner)) {
      const local = options.store.getTask(owner);
      if (local === null) throw new Error("The original claim identity is missing before reservation cleanup.");
      const web = options.webStore.getTask(owner);
      if (web != null) { ending.set(key(owner), web); return runCleanup(web, deleteWorktree, signal, undefined, control, expectedUserId); }
      if (local.agentControlMode === "web") {
        if (!options.verifyWebUnregistered || local.sessionId !== null) throw new Error("The ended Web claim has no original resource evidence; its ownership record is retained.");
        await options.verifyWebUnregistered(local, signal ?? new AbortController().signal, CLEANUP_OPERATION_MS);
      }
      if (deleteWorktree) {
        const previous = options.store.getCleanupSchedule(local);
        if (previous !== null) {
          ending.set(key(owner), previous);
          return runCleanup(previous, true, signal, undefined, control, expectedUserId);
        }
        options.store.completeTask(owner);
      }
      return;
    }
    const local = options.store.getTask(owner);
    let webRecord = options.webStore.getTask(owner);
    if (webRecord != null && (webRecord.worktreeId !== owner.worktreeId || webRecord.workerId !== options.workerId || webRecord.serverOrigin !== options.serverOrigin || webRecord.userId !== expectedUserId)) throw new Error("The Web cleanup claim has conflicting execution identities.");
    if ((deleteWorktree || control) && webRecord !== null) {
      const legacy = await observeLegacyBinding(webRecord, signal ?? normalSignal, "current-claim");
      if (legacy !== undefined) webRecord = options.webStore.bindWorktree(owner, legacy, now());
    }
    const previous = getCleanupSchedule(owner, expectedUserId);
    if (previous !== null && (webRecord == null || previous.worktreeId !== webRecord.worktreeId)) throw new Error("Cleanup schedule does not match the original Web execution.");
    const schedule = deleteWorktree && webRecord != null ? ensureCleanupSchedule(options.store, owner, now(), webOwner(owner, expectedUserId)!) : null;
    if (local?.agentControlMode === "web" || webRecord != null) {
      if (schedule?.stage === "archive") {
        signal?.throwIfAborted();
        try {
          if (webRecord == null || !options.archiveMaintenance) throw new Error("Legacy archive maintenance registration is unavailable.");
          options.archiveMaintenance.recordLegacyFailure(webRecord, schedule, control ? expectedUserId : undefined);
        } catch (error) {
          try { options.emit({ kind: "session-archive-retry", identity: owner, component: "archive", phase: "archive-backfill", message: "Legacy archive failure registration failed; its source remains available for retry.", error: new AggregateError([new Error(schedule.lastError ?? "Legacy archive failure."), error], "Legacy archive failure registration failed.", { cause: error }) }); } catch { /* Diagnostics cannot prevent cleanup. */ }
        }
      }
      if (webRecord == null) {
        // Registration precedes every native launch. Missing local evidence alone proves nothing.
        if (local?.sessionId !== null && local?.sessionId !== undefined) throw new Error("The original native identity has no local Web stop evidence.");
        if (!options.verifyWebUnregistered) throw new Error("Web launch provenance cannot be verified.");
        await options.verifyWebUnregistered(owner, signal ?? new AbortController().signal, CLEANUP_OPERATION_MS);
        if (options.webStore.getTask(owner) != null) throw new Error("The original Web execution appeared during cleanup verification.");
        const unregisteredSchedule = options.store.getCleanupSchedule(owner);
        if (unregisteredSchedule !== null && unregisteredSchedule.worktreeId !== owner.worktreeId) throw new Error("The cleanup claim has conflicting worktree identities.");
        if (deleteWorktree) {
          scope!.onExecutionStopped({ attempt: scope!.attempt, observation: { kind: "not-started", owner, observedAt: now() } });
          const project = projectFor(owner);
          const binding = await cleanupOperation(operation => options.git.resolveWorktreeBinding(project, owner, operation), signal);
          if (binding === null) await cleanupOperation(operation => options.git.removeUnregisteredReservation(project, owner, operation), signal);
          else {
            const outcome = await options.git.removeWorktree(project, owner, signal === undefined ? {} : { signal });
            if (outcome.effectErrors.length > 0) {
              try { options.emit({ kind: "cleanup-effect-error", identity: owner, component: "cleanup", phase: "worktree-removal", message: "Worktree removal reported errors, but the original resources are confirmed absent.", error: new AggregateError(outcome.effectErrors, "Worktree removal effect failed after reaching its postcondition.", { cause: outcome.effectErrors[0] }) }); } catch { /* Diagnostics do not change resource settlement. */ }
            }
          }
          signal?.throwIfAborted();
          if (local && executionCapacity.stopped(owner)) {
            options.store.completeTask(owner);
            if (unregisteredSchedule !== null) options.store.deleteCleanupSchedule(owner);
          }
          return;
        }
        return;
      }
      while (true) {
        const result = await options.webBackend.cleanup(webRecord, deleteWorktree ? { kind: "terminal", deadline: schedule!.deadline, immediateStop: retiredClaims.has(key(owner)), scope: scope!, ...(control && expectedUserId !== undefined ? { ownerUserId: expectedUserId } : {}), ...(signal === undefined ? {} : { signal }) } : { kind: "shutdown", deadline: now() + 600_000, immediateStop: true, ...(signal === undefined ? {} : { signal }) });
        signal?.throwIfAborted();
        if (result.complete) {
          if (deleteWorktree) { if (result.task.status !== "done") options.webStore.completeTask(owner, now()); if (local && executionCapacity.stopped(owner)) options.store.completeTask(owner); }
          return;
        }
        await delay(1000, undefined, signal === undefined ? {} : { signal });
      }
    }
    throw new Error("The original Web execution identity is missing.");
  };

  const completeCleanup = async (owner: CleanupTarget, signal: AbortSignal, control = false, locate?: (target: CleanupTarget) => Promise<LocatedClaimNative>): Promise<void> => {
    const identityKey = key(owner);
    if (retiredClaims.has(identityKey) && needsNativeCleanup(owner)) {
      if (options.retiredNativeCleanup === undefined) throw new Error("Original claim native inventory cleanup is unavailable.");
      const currentWeb = options.webStore.getTask(owner);
      const project = projectFor(owner);
      if (currentWeb !== null && (repositoryIdentity(currentWeb.repoUrl) !== repositoryIdentity(project.repoUrl)
        || !await sameWorktreeLocation(currentWeb.repositoryPath, project.localPath)
        || currentWeb.resources.worktree !== null && (!retainedWorktreePathInScope(project.localPath, currentWeb, currentWeb.resources.worktree.worktreePath)
          || !await sameWorktreeLocation(currentWeb.resources.worktree.repositoryPath, project.localPath))))
        throw new WorkerCleanupError("observation", new Error("The retained Web execution has a conflicting repository binding."));
      if (currentWeb !== null && currentWeb.status !== "done") options.webStore.beginCleanup(owner, { kind: "terminal", deadline: now() + CLEANUP_OPERATION_MS }, now());
      const target = currentWeb ?? owner;
      let attempt: CleanupAttempt | undefined;
      if (hasWorktreeIdentity(target)) { attempt = { owner: target, attemptId: randomUUID() }; executionCapacity.beginAttempt(attempt); }
      try { await cleanupRetiredClaim({ target, located: (locate ?? nativeCleanupBatch([target], signal))(target), native: options.retiredNativeCleanup,
        project, store: options.store, git: options.git, signal,
        ...(currentWeb?.resources.worktree == null ? {} : { originalCwd: currentWeb.resources.worktree.worktreePath }),
        ...(currentWeb !== null && prelaunchLegacy(currentWeb)
          ? { findLegacyCwd: async () => (await observeLegacyBinding(currentWeb, signal, "stopped"))?.worktreePath } : {}),
        deadline: Date.now() + CLEANUP_OPERATION_MS, now,
        onEffectError: error => { try { options.emit({ kind: "cleanup-effect-error", identity: owner, component: "cleanup", phase: "worktree-removal", message: "Worktree removal reported errors, but the original resources are confirmed absent.", error }); } catch { /* Diagnostics do not change resource settlement. */ } },
        onOwner: actual => { ending.set(identityKey, actual); },
        onCleared: (actual, observedAt) => {
          if (attempt === undefined) { attempt = { owner: actual, attemptId: randomUUID() }; executionCapacity.beginAttempt(attempt); }
          executionCapacity.notice({ attempt, observation: { kind: "resources-cleared", owner: actual, observedAt } });
        },
      }); } finally { if (attempt !== undefined) executionCapacity.endAttempt(attempt); }
      signal.throwIfAborted();
      const actual = ending.get(identityKey);
      if (actual && hasWorktreeIdentity(actual) && !executionStoppedOrEmpty(actual)) throw new WorkerCleanupError("agent-stop", new Error("Original claim resource clearance was invalidated before settlement."));
      if (currentWeb !== null && currentWeb.status !== "done") options.webStore.completeTask(owner, now());
      if (options.store.getTask(owner) !== null) options.store.completeTask(owner);
    } else await runCleanup(owner, true, signal, undefined, control);
    signal.throwIfAborted();
    const actual = ending.get(identityKey);
    if (actual && hasWorktreeIdentity(actual) && !executionStoppedOrEmpty(actual)) throw new WorkerCleanupError("agent-stop", new Error("The original execution stop remains unknown; its reservation is retained."));
    deleteCleanupSchedule(owner);
    if (actual && hasWorktreeIdentity(actual)) recordSettledCleanup(actual);
    selectedWorktrees.release(actual ?? owner);
    ending.delete(identityKey);
    cleanupRetries.delete(identityKey);
    retiredClaims.delete(identityKey);
    const activity = monitoringActivities.get(`true/${identityKey}`);
    if (activity !== undefined) { observe(m => m.endActivity(activity)); monitoringActivities.delete(`true/${identityKey}`); }
  };
  const launchCleanups = (): void => {
    const ready: CleanupTarget[] = [];
    for (const [identityKey, owner] of ending) {
      if (jobs.has(identityKey)) continue;
      const currentRetry = cleanupRetries.get(identityKey);
      let retained: ReturnType<WorkerStore["getCleanupSchedule"]> = null;
      let legacyWebArchive = false;
      try {
        retained = getCleanupSchedule(owner);
        legacyWebArchive = retained?.stage === "archive"
          && (options.webStore.getTask(owner) != null || options.store.getTask(owner)?.agentControlMode === "web");
      }
      catch { /* Read failures are handled inside the isolated cleanup job. */ }
      // Old Web archive retries are maintenance, not a worktree-removal gate.
      // New cleanup failures retain their own in-process and persisted backoff.
      if (now() < Math.max(currentRetry?.nextAttemptAt ?? 0, legacyWebArchive ? 0 : retained?.nextAttemptAt ?? 0)) continue;
      ready.push(owner);
    }
    const locate = nativeCleanupBatch(ready, normalSignal);
    for (const owner of ready) startJob(owner, signal => completeCleanup(owner, signal, false, locate), true);
  };
  const finishShutdown = async (record: NonNullable<ReturnType<WebExecutionStore["getTask"]>>, signal: AbortSignal) => {
    if (record.cleanup?.kind !== "shutdown") throw new Error("Only an original shutdown may resume ordinary Web execution.");
    const stopped = await options.webBackend.cleanup(record, { kind: "shutdown", deadline: now(), immediateStop: true, ...(signal === undefined ? {} : { signal }) });
    if (!stopped.complete) throw new Error("The original Web resources remain before restart.");
    return options.webStore.clearShutdown(stopped.task, now());
  };
  // An adoption can replace at most one legacy generation during this Worker run.
  const webUpgradeAttempts = new Set<string>();
  const checkWebAuthority = async (original: NonNullable<ReturnType<WebExecutionStore["getTask"]>>, inputSignal: AbortSignal, explicitRetry: boolean, allowShutdown = false): Promise<"task_paused" | "claim_invalid" | null> => {
    lifecycleAuthority.delete(key(original));
    const fresh = await options.remote.readTask(original.projectId, original.taskId, inputSignal);
    const claim = readWorkerClaim(fresh.properties);
    const latest = options.webStore.getTask(original);
    if (fresh.projectId !== original.projectId || fresh.id !== original.taskId || claim?.claimId !== original.claimId || claim.workerId !== original.workerId || claim.worktreeId !== original.worktreeId || claim.userId !== original.userId)
      lifecycleAuthority.set(key(original), "ownership_changed");
    else if (fresh.status !== "in_progress" || !fresh.allowAgents || readTaskBlocked(fresh.properties) || (explicitRetry ? projectStops.has(original.projectId) : !canAdvanceProject(original.projectId)))
      lifecycleAuthority.set(key(original), "independent_blocker");
    if ((explicitRetry ? projectStops.has(original.projectId) : !canAdvanceProject(original.projectId)) || fresh.projectId !== original.projectId || fresh.id !== original.taskId
      || fresh.status !== "in_progress" || !fresh.allowAgents || claim?.state !== "active"
      || claim.claimId !== original.claimId || claim.workerId !== original.workerId || claim.worktreeId !== original.worktreeId
      || claim.userId !== original.userId || claim.agent !== original.configuration?.agent || claim.agentControlMode !== "web"
      || latest === null || latest.status !== "active" || (latest.cleanup !== null && !(allowShutdown && latest.cleanup.kind === "shutdown")) || latest.control !== null
      || latest.workerId !== original.workerId || latest.worktreeId !== original.worktreeId
      || (claim.nativeSessionId !== null && latest.resources.nativeSession !== null && claim.nativeSessionId !== latest.resources.nativeSession.sessionId)) return "claim_invalid";
    return readTaskBlocked(fresh.properties) ? "task_paused" : null;
  };
  const ensure = (task: LocalTask, remoteTask: Task, signal: AbortSignal, explicitRetry = false, allowWorktreeRestore = true): Promise<WorkerInputWait | undefined> => withLifecycleProducer("task", { kind: "task_advance", projectId: task.projectId, taskId: task.taskId, claimId: task.claimId }, () => ensureAdmitted(task, remoteTask, signal, explicitRetry, allowWorktreeRestore));
  const ensureAdmitted = async (task: LocalTask, remoteTask: Task, signal: AbortSignal, explicitRetry: boolean, allowWorktreeRestore: boolean): Promise<WorkerInputWait | undefined> => {
    assertWorkerLifecycleAdmission();
    lifecycleRecovery.delete(key(task));
    lifecycleAuthority.delete(key(task));
    if (ending.has(key(task))) return;
    const owner = remoteOwner(remoteTask);
    if (!sameClaim(task, owner) || readWorkerClaim(remoteTask.properties)!.workerId !== options.workerId || readWorkerClaim(remoteTask.properties)!.agent !== task.agent || readWorkerClaim(remoteTask.properties)!.agentControlMode !== "web") {
      lifecycleAuthority.set(key(task), "ownership_changed");
      throw new Error("The local execution does not match the observed original worker claim.");
    }
    {
      let configuration = configurationFor(task);
      if (configuration === null) return;
      const worker = readWorkerClaim(remoteTask.properties)!;
      let record = options.webStore.getTask(task);
      if (record !== null && (record.worktreeId !== owner.worktreeId || record.workerId !== options.workerId || record.userId !== worker.userId || record.serverOrigin !== options.serverOrigin)) throw new Error("The durable Web execution does not match the observed original worker claim.");
      let observed = false;
      let advancing = false;
      let waitingInput: WorkerInputWait | undefined;
      const canAdmitNewExecution = () => (explicitRetry ? !projectStops.has(task.projectId) : canAdvanceProject(task.projectId)) && (options.configurationComplete?.() ?? true);
      const authority = (original: NonNullable<ReturnType<WebExecutionStore["getTask"]>>, _ticket: unknown, inputSignal: AbortSignal) => checkWebAuthority(original, inputSignal, explicitRetry);
      try {
        if (record === null || record.recovery.pauseReason === null || record.recovery.retryAuthorized || legacyBranchLatch(record)) {
          requireImplementedWorkerBackend(configuration);
          await options.verifyWebServer?.(configuration.agent, signal);
          signal.throwIfAborted();
          if (record === null) {
            assertConfigurationAdmission(canAdmitNewExecution);
            if (!options.verifyWebUnregistered) throw new Error("Web launch provenance cannot be verified.");
            await options.verifyWebUnregistered(task, signal);
            if (task.sessionId !== null || worker.nativeSessionId !== null) throw new Error("The original native identity has no local Web execution evidence.");
            assertConfigurationAdmission(canAdmitNewExecution);
            if (options.freezeConfiguration !== undefined) configuration = await options.freezeConfiguration(configuration, signal);
            assertConfigurationAdmission(canAdmitNewExecution);
          }
          signal.throwIfAborted();
          if (record !== null && task.sessionId === null && worker.nativeSessionId === null) {
            const legacy = await observeLegacyBinding(record, signal, "current-claim");
            if (legacy !== undefined) record = options.webStore.bindWorktree(owner, legacy, now());
          }
          record = options.webStore.register({ ...owner, project: projectFor(task), serverOrigin: options.serverOrigin, workerId: options.workerId, userId: worker.userId, configuration }, now());
          // A persisted orderly stop already commits this run to its replacement generation.
          if (record.cleanup?.kind === "shutdown" || record.webExecution?.restartAfterShutdown) webUpgradeAttempts.add(key(task));
          if (record.cleanup !== null) {
            if (await checkWebAuthority(record, signal, explicitRetry, true) === "claim_invalid") { waitingInput = { kind: "waiting_input", reason: "claim_invalid" }; return waitingInput; }
            record = await finishShutdown(record, signal);
          }
          if (record.webExecution?.restartAfterShutdown) {
            const reason = await authority(record, null, signal);
            if (reason !== null) { waitingInput = { kind: "waiting_input", reason }; return waitingInput; }
          }
          advancing = true;
          if (options.webBackend.advanceResult) {
            const precedingGeneration = record.webExecution?.executionGeneration;
            const result = await options.webBackend.advanceResult(record, signal, canAdmitNewExecution, authority, allowWorktreeRestore);
            record = result.task;
            if (precedingGeneration !== undefined && record.webExecution?.executionGeneration !== precedingGeneration) webUpgradeAttempts.add(key(task));
            if (result.kind === "waiting_input") waitingInput = { kind: "waiting_input", reason: result.reason };
            if (result.kind === "upgrade") {
              if (webUpgradeAttempts.has(key(task))) throw new Error("The replacement Controller does not support Worker input protocol 1.");
              if (!options.webBackend.confirmUpgrade) throw new Error("Legacy Controller adoption cannot verify its original input state.");
              const confirmation = await options.webBackend.confirmUpgrade(record, authority, signal);
              record = confirmation.task;
              if (confirmation.kind === "waiting_input") waitingInput = { kind: "waiting_input", reason: confirmation.reason };
              else {
                webUpgradeAttempts.add(key(task));
                const stopped = await options.webBackend.cleanup(record, { kind: "shutdown", deadline: now(), immediateStop: true, signal });
                if (!stopped.complete) throw new Error("The original Web resources remain before restart.");
                record = options.webStore.clearShutdown(stopped.task, now());
              }
            }
          } else record = await options.webBackend.advance(record, signal, canAdmitNewExecution, authority, allowWorktreeRestore);
          observed = true;
        }
      } catch (error) {
        if (isWorkerCancellation(error, signal)) throw error;
        if (error instanceof ConfigurationAdmissionWaiting) { waitingInput = { kind: "waiting_input", reason: "configuration_pending" }; return waitingInput; }
        record = options.webStore.getTask(task);
        if (record !== null && record.cleanup === null && record.recovery.pauseReason === null) {
          if (error instanceof WebRecoveryBlockedError) record = options.webStore.pauseRecovery(record, error.message, now(), error.reasonCode);
          else if (error instanceof WorktreePreconditionError) options.webStore.blockOrchestration(record, { source: "worktree", code: error.code, message: error.message }, now());
          else if (!advancing) options.webStore.blockOrchestration(record, { source: "coordinator", code: "advance_failed", message: error instanceof Error ? error.message : String(error) }, now());
        }
        throw error;
      } finally {
        // Summary transport is independent of native recovery and must remain live while paused.
        record = options.webStore.getTask(task);
        if (record !== null) {
          const execution = record.webExecution;
          lifecycleRecovery.set(key(task), { projectId: task.projectId, taskId: task.taskId, claimId: task.claimId,
            executionId: execution?.executionId ?? null, sessionId: execution?.sessionId ?? null, executionGeneration: execution?.executionGeneration ?? null,
            ...executionRecoveryResult({ ownershipChanged: lifecycleAuthority.get(key(task)) === "ownership_changed" || waitingInput?.reason === "claim_invalid" && lifecycleAuthority.get(key(task)) !== "independent_blocker",
              independentBlocker: lifecycleAuthority.get(key(task)) === "independent_blocker" || waitingInput?.reason === "task_paused" || readTaskBlocked(remoteTask.properties) === true || pausedClaims.has(key(task)) || options.webStore.getOrchestrationBlocker(record) !== null || record.recovery.reasonCode === "recovery_limit",
              nativeBlocked: record.recovery.pauseReason !== null && record.recovery.reasonCode !== "recovery_limit",
              outcomeUnknown: signal.aborted || waitingInput !== undefined || execution?.launchSubmission === "unknown" || ["unknown", "dispatching"].includes(execution?.initialInputState ?? ""),
              verified: observed && execution !== null && execution.sessionId !== null && record.resources.nativeSession !== null && ["confirmed", "provider_accepted"].includes(execution.initialInputState) && execution.activity !== "initializing" && execution.activity !== "unknown" }),
          });
        }
        if (!signal.aborted && (observed || record !== null || waitingInput !== undefined)) {
          const nativeSessionId = record?.resources.nativeSession?.sessionId ?? task.sessionId ?? worker.nativeSessionId;
          if (nativeSessionId !== null) options.store.setSessionId(task, nativeSessionId);
          const phase = waitingInput !== undefined || (record !== null && options.webStore.getOrchestrationBlocker(record) !== null) || record?.recovery.pauseReason != null || record?.recovery.retryAuthorized
            || record?.webExecution?.activity === "initializing" ? "waiting" as const : "executing" as const;
          const activity = monitoringJobs.get(key(task));
          if (activity !== undefined) {
            const taskPaused = pausedClaims.has(key(task));
            const paused = taskPaused || record?.recovery.pauseReason != null || (record !== null && options.webStore.getOrchestrationBlocker(record) !== null);
            const nativeWaiting = waitingInput !== undefined || record?.webExecution?.activity === "waiting_input";
            const monitoringPhase = nativeWaiting ? "waiting" : phase;
            const state = JSON.stringify([phase, paused, record?.webExecution?.activity, record?.webExecution?.executionGeneration, nativeSessionId]);
            const progress = observed && webMonitoringState.get(key(task)) !== state;
            if (observed) webMonitoringState.set(key(task), state);
            observe(m => m.updateActivity(activity, { phase: paused ? "paused" : monitoringPhase, status: paused ? "paused" : monitoringPhase === "waiting" ? "waiting" : "running", waitReason: taskPaused ? "task-paused" : paused ? "recovery-blocked" : nativeWaiting ? "native-input" : monitoringPhase === "waiting" ? "initializing" : null, progress }));
            const recoveryKey = key(task);
            const recoveryReason = record?.recovery.pauseReason != null ? record.recovery.reasonCode ?? "recovery_blocked" : null;
            const recovery = webRecoveryFailures.get(recoveryKey);
            if (recoveryReason !== null && recovery?.reason !== recoveryReason) {
              if (recovery !== undefined) observe(m => m.discardFailure(recovery.id));
              const id = randomUUID();
              webRecoveryFailures.set(recoveryKey, { id, reason: recoveryReason });
              observe(m => m.fail({ operationId: id, component: "execution", phase: "paused", scope: { kind: "claim", projectId: task.projectId, taskId: task.taskId, claimId: task.claimId }, ...worktreeContext(task), error: new MonitoringRecoveryEvidence(recoveryReason), retryState: "manual" }));
            } else if (recovery !== undefined && recoveryReason === null && observed && !paused && waitingInput === undefined && !record?.recovery.retryAuthorized && record?.webExecution?.activity !== "initializing") {
              observe(m => m.recover(recovery.id)); webRecoveryFailures.delete(recoveryKey);
            }
            const failureKey = `false/${key(task)}/observation`;
            const previous = monitoringFailures.get(failureKey);
            if (observed && !paused && waitingInput === undefined && !record?.recovery.retryAuthorized && record?.webExecution?.activity !== "initializing" && previous !== undefined) {
              observe(m => m.recover(previous)); monitoringFailures.delete(failureKey);
            }
          }
          try {
            let report: SessionStartupReport | null = null;
            try {
              // Observation and transport must never become another native recovery attempt.
              report = record === null ? null : options.webBackend.observeStartupReport?.(record) ?? null;
            } catch (error) { if (!isWorkerCancellation(error, signal)) options.emit({ kind: "summary-error", task, message: "The startup report could not be prepared; ordinary execution summary reconciliation remains available.", error }); }
            if (worker.phase !== phase || worker.nativeSessionId !== nativeSessionId || report !== null && !sameStartupReport(readSessionStartupReport(remoteTask.properties), report)) {
              let supportedReport: SessionStartupReport | undefined;
              try {
                supportedReport = report !== null && await options.verifyWebStartupReporting?.(signal) ? report : undefined;
              } catch (error) { if (!isWorkerCancellation(error, signal)) options.emit({ kind: "summary-error", task, message: "The startup report could not be prepared; ordinary execution summary reconciliation remains available.", error }); }
              // Avoid an extra read when an unsupported report was the only candidate change.
              if (!signal.aborted && (worker.phase !== phase || worker.nativeSessionId !== nativeSessionId || supportedReport !== undefined)) {
                let fresh: Task | undefined;
                try { fresh = await options.remote.readTask(task.projectId, task.taskId, signal); }
                catch (error) { if (!isWorkerCancellation(error, signal)) options.emit({ kind: "summary-error", task, message: "The Web execution summary could not read the current task; the next round will observe it again.", error }); }
                if (fresh !== undefined) {
                  const current = readWorkerClaim(fresh.properties);
                  if (fresh.projectId === task.projectId && fresh.id === task.taskId && fresh.status === "in_progress"
                    && current?.state === "active" && current.claimId === task.claimId && current.workerId === options.workerId
                    && current.userId === worker.userId && (options.userId === undefined || current.userId === options.userId)
                    && current.worktreeId === owner.worktreeId && current.agent === task.agent && current.agentControlMode === "web"
                    && compatibleWebSessions(task.sessionId, worker.nativeSessionId, nativeSessionId, current.nativeSessionId)
                    && (current.nativeSessionId === null || current.nativeSessionId === nativeSessionId)) {
                    const startupReport = supportedReport !== undefined && !sameStartupReport(readSessionStartupReport(fresh.properties), supportedReport) ? supportedReport : undefined;
                    if (current.phase !== phase || current.nativeSessionId !== nativeSessionId || startupReport !== undefined) {
                      try { await options.remote.update(fresh, { phase, nativeSessionId, ...(startupReport === undefined ? {} : { startupReport }) }, signal); }
                      catch (error) {
                        if (!isWorkerCancellation(error, signal)) {
                          const conflict = error instanceof ApiError && error.phase === "response" && error.confirmedRefusal && error.status === 409 && error.code === "version_conflict";
                          const refusal = error instanceof ApiError && error.phase === "response" && error.confirmedRefusal;
                          options.emit({ kind: "summary-error", task, message: conflict ? "The Web execution summary was rejected because the task version changed; the next round will read it again." : refusal ? "The Web execution summary was rejected; the next round will read it again." : "The Web execution summary was not confirmed; the next round will read it again.", error });
                        }
                      }
                    }
                  }
                }
              }
            }
          } catch (error) { if (!isWorkerCancellation(error, signal)) options.emit({ kind: "summary-error", task, message: "The Web execution summary could not be prepared; the next round will observe it again.", error }); }
        }
      }
      return waitingInput;
    }
  };
  const reservations = (resources: Snapshot) => {
    const live = new Set([...ending.keys(), ...controllers.keys()]);
    const roles = new Map<string, Set<"active-task" | "resource-owner" | "unresolved" | "cleanup" | "pending-stop">>();
    const add = (identity: string, role: "active-task" | "resource-owner" | "unresolved" | "cleanup" | "pending-stop"): void => {
      const current = roles.get(identity) ?? new Set();
      current.add(role);
      roles.set(identity, current);
    };
    for (const task of options.store.listUnfinishedTasks()) {
      if (task.status === "active") add(key(task), "active-task");
      // An unreadable repository cannot disprove an unfinished Git-only owner.
      if (resources.unavailableProjects.has(task.projectId)) add(key(task), "unresolved");
    }
    for (const identity of resources.owners.keys()) add(identity, "resource-owner");
    for (const identity of resources.unresolved) add(identity, "unresolved");
    for (const identity of ending.keys()) add(identity, "cleanup");
    return [...roles].map(([identity, roleSet]) => {
      const target = ending.get(identity);
      const observedOwner = resources.owners.get(identity);
      const local = options.store.listTasks().find(task => key(task) === identity);
      // Cleanup can finish after this round's inventory but before its stop read
      // returns. Keep its exact stopped fact for that stale owner; an active
      // reservation or a replacement worktree never inherits the exemption.
      const completedOwner = target === undefined && (local === undefined || local.status === "done") ? observedOwner : undefined;
      const stoppedOwner = target !== undefined && hasWorktreeIdentity(target) ? target : completedOwner;
      const terminalStopped = stoppedOwner !== undefined && (observedOwner === undefined || observedOwner.worktreeId === stoppedOwner.worktreeId)
        && controllers.get(identity)?.terminal !== false && executionStoppedOrEmpty(stoppedOwner);
      const owner = observedOwner ?? local;
      const occupied = terminalStopped ? false : resources.quarantined.has(identity) ? true
        : resources.owners.has(identity) && !resources.proven.has(identity) ? true
        : owner === undefined || canAdvanceProject(owner.projectId) || !stoppedProjects.has(owner.projectId) || live.has(identity);
      return { identity, roles: [...roleSet], occupied };
    });
  };
  let latestReservations: ReturnType<typeof reservations> = [];
  let publishedReservations: ReturnType<typeof reservations> = [];
  const capacity = (resources: Snapshot): number => {
    latestReservations = reservations(resources);
    return latestReservations.filter(item => item.occupied).length;
  };
  const blockedByOldClaim = (task: LocalTask, owners: Iterable<ResourceOwner>): boolean =>
    options.store.listUnfinishedTasks().some((other) => other.projectId === task.projectId && other.taskId === task.taskId && other.claimId !== task.claimId && other.status === "active")
    || [...owners, ...ending.values()].some((owner) => owner.projectId === task.projectId && owner.taskId === task.taskId && owner.claimId !== task.claimId);
  const schedule = (task: LocalTask, remoteTask: Task): void => {
    assertWorkerLifecycleAdmission();
    if (!canAdvance(task) || jobs.has(key(task)) || ending.has(key(task))) return;
    updatePromptDemand();
    const owner = remoteOwner(remoteTask);
    executionCapacity.invalidate(owner);
    startJob(owner, signal => {
      if (!canAdvance(task)) return Promise.resolve();
      return ensure(task, remoteTask, signal).then(() => undefined);
    }, false, readWorkerClaim(remoteTask.properties));
  };
  const compatibleWebSessions = (...sessions: readonly (string | null | undefined)[]): boolean => new Set(sessions.filter((session): session is string => session != null)).size <= 1;
  // A partial repository scan cannot authorize new work. An already submitted
  // Web execution can still be reconciled after its own binding and competing
  // same-task responsibilities are independently verified.
  const scheduleKnownWebDuringIncompleteScan = (task: LocalTask, observed: Task): void => {
    if (!canAdvance(task) || jobs.has(key(task)) || ending.has(key(task))) return;
    const owner = remoteOwner(observed), claim = readWorkerClaim(observed.properties)!;
    const activityKey = `false/${key(owner)}`, hadActivity = monitoringActivities.has(activityKey);
    startJob(owner, async signal => {
      let admitted = false;
      try {
        const record = options.webStore.getTask(owner), original = record?.resources.worktree;
        if (record == null || original == null || record.status !== "active" || record.control !== null
          || record.cleanup !== null && record.cleanup.kind !== "shutdown" || record.webExecution == null
          || record.webExecution.launchSubmission === "not-submitted" && !(BigInt(record.webExecution.executionGeneration) > 1n && record.resources.nativeSession !== null)
          || record.serverOrigin !== options.serverOrigin || record.workerId !== options.workerId || record.userId !== options.userId
          || record.userId !== claim.userId || record.worktreeId !== owner.worktreeId || record.configuration?.agent !== task.agent
          || !compatibleWebSessions(task.sessionId, claim.nativeSessionId, record.resources.nativeSession?.sessionId)) return;
        const project = projectFor(task);
        if (repositoryIdentity(project.repoUrl) !== repositoryIdentity(record.repoUrl)
          || !await sameWorktreeLocation(project.localPath, record.repositoryPath)
          || !await sameWorktreeLocation(project.localPath, original.repositoryPath)) return;
        const noCompetingTask = (): boolean => {
          // Task IDs identify the shared branch even when projects use different
          // worktree roots for the same Git common directory.
          for (const other of [...options.store.listUnfinishedTasks(), ...options.store.listCleanupSchedules(), ...ending.values(), ...options.webStore.listUnfinishedTasks()]) {
            if (other.taskId === task.taskId && !sameClaim(other, task)) return false;
          }
          for (const other of options.webStore.listCompletedTasks()) {
            if (other.taskId === task.taskId && !sameClaim(other, task) && options.store.getCleanupSchedule(other, other) !== null) return false;
          }
          return true;
        };
        if (!noCompetingTask()) return;
        const binding = await workerOperation(operation => options.git.verifyWorktree(project, owner, operation, original.worktreePath), signal);
        if (binding.branch !== original.branch || !await sameWorktreeLocation(binding.worktreePath, original.worktreePath)
          || !await sameWorktreeLocation(binding.repositoryPath, original.repositoryPath)
          || !await sameWorktreeLocation(binding.commonDirectory, original.commonDirectory)) return;
        signal.throwIfAborted();
        const fresh = await options.remote.readTask(owner.projectId, owner.taskId, signal), currentClaim = readWorkerClaim(fresh.properties);
        if (fresh.projectId !== owner.projectId || fresh.id !== owner.taskId || fresh.status !== "in_progress" || !fresh.allowAgents || readTaskBlocked(fresh.properties)
          || currentClaim?.state !== "active" || currentClaim.agentControlMode !== "web" || currentClaim.claimId !== owner.claimId
          || currentClaim.workerId !== options.workerId || currentClaim.userId !== options.userId || currentClaim.worktreeId !== owner.worktreeId
          || currentClaim.agent !== task.agent || !compatibleWebSessions(task.sessionId, currentClaim.nativeSessionId, record.resources.nativeSession?.sessionId)
          || !isDeepStrictEqual(options.webStore.getTask(owner), record) || !canAdvance(task) || ending.has(key(task)) || !noCompetingTask()) return;
        signal.throwIfAborted();
        admitted = true;
        await ensure(task, fresh, signal, false, false);
      } finally {
        if (!admitted && !hadActivity) {
          const activity = monitoringActivities.get(activityKey);
          if (activity !== undefined) { observe(m => m.endActivity(activity)); monitoringActivities.delete(activityKey); }
        }
      }
    }, false, claim);
  };
  // Project removal joins only Web executions whose original identity is proved.
  const stopProject = (projectId: string, signal?: AbortSignal): Promise<void> => {
    const existing = projectStops.get(projectId);
    if (existing !== undefined) return existing;
    stoppedProjects.delete(projectId);
    // The job's frozen claim and journal prove the original local execution even if authority is unavailable.
    const interruptedWebJobs = new Set<string>();
    for (const [identity, running] of controllers) {
      const claim = running.webClaim;
      if (running.terminal || claim === undefined || claim.agentControlMode !== "web" || claim.workerId !== options.workerId || options.userId === undefined || claim.userId !== options.userId) continue;
      const local = options.store.listUnfinishedTasks().find(task => key(task) === identity), web = local === undefined ? null : options.webStore.getTask(local);
      if (local?.projectId !== projectId || local.agentControlMode !== "web" || local.claimId !== claim.claimId || local.agent !== claim.agent) continue;
      const schedule = getCleanupSchedule(local);
      if (schedule !== null && schedule.worktreeId !== claim.worktreeId) continue;
      if (web == null) {
        if (local.sessionId !== null || claim.nativeSessionId !== null) continue;
      } else if (web.serverOrigin !== options.serverOrigin || web.workerId !== claim.workerId || web.userId !== claim.userId || web.worktreeId !== claim.worktreeId || !compatibleWebSessions(local.sessionId, web.resources.nativeSession?.sessionId, claim.nativeSessionId)) continue;
      interruptedWebJobs.add(identity);
      running.controller.abort(new Error("The project was excluded from worker execution."));
    }
    const operationSignal = signal === undefined ? normalSignal : AbortSignal.any([normalSignal, signal]);
    const operation = (async () => {
      const local = options.store.listUnfinishedTasks().filter(task => task.projectId === projectId);
      const webOwners = options.webStore.listUnfinishedTasks().filter(owner => owner.projectId === projectId);
      const missing = local.filter(task => task.agentControlMode === "web" && options.webStore.getTask(task) == null);
      const failures: unknown[] = [];
      const proven: typeof webOwners[number][] = [];
      if (webOwners.length > 0) {
        let userId: string;
        try { userId = options.userId ?? await options.remote.currentUserId(operationSignal); }
        catch (error) { throw new AggregateError([error], "Project execution stop was not confirmed."); }
        const checks = await Promise.allSettled(webOwners.map(async owner => {
          const localTask = options.store.getTask(owner), current = options.webStore.getTask(owner);
          if (localTask === null || localTask.agentControlMode !== "web" || current == null || current.worktreeId !== owner.worktreeId || current.workerId !== options.workerId || current.serverOrigin !== options.serverOrigin || current.userId !== userId) throw new Error("The original Web execution identity is missing or conflicting.");
          const running = controllers.get(key(owner));
          if (running !== undefined && !running.terminal && !interruptedWebJobs.has(key(owner))) throw new Error("The running execution identity is not proven to be Web.");
          const schedule = getCleanupSchedule(localTask);
          if (schedule !== null && schedule.worktreeId !== current.worktreeId) throw new Error("The original Web worktree identity is conflicting.");
          if (!compatibleWebSessions(localTask.sessionId, current.resources.nativeSession?.sessionId)) throw new Error("The original Web session identity is conflicting.");
          return owner;
        }));
        for (const result of checks) if (result.status === "fulfilled") proven.push(result.value); else failures.push(result.reason);
      }
      const webKeys = new Set(proven.map(key));
      for (const identity of webKeys) {
        const activity = monitoringActivities.get(`false/${identity}`);
        if (activity !== undefined) observe(m => m.updateActivity(activity, { phase: "waiting", status: "waiting", waitReason: "resource-stop" }));
      }
      await Promise.all([...jobs].filter(([identity]) => webKeys.has(identity)).map(([, job]) => job));
      operationSignal.throwIfAborted();
      const missingResults = await Promise.allSettled(missing.map(task => serialize(task, async () => {
        const current = options.store.getTask(task);
        if (current?.agentControlMode !== "web" || current.status !== "pending" && !interruptedWebJobs.has(key(task)) || current.sessionId !== null || !options.verifyWebUnregistered || options.webStore.getTask(task) != null) throw new Error("The original Web execution evidence is missing; stop is unconfirmed.");
        await options.verifyWebUnregistered(current, operationSignal, CLEANUP_OPERATION_MS);
      })));
      const webResults = await Promise.allSettled(proven.map(owner => serialize(owner, async () => {
        const current = options.webStore.getTask(owner), localTask = options.store.getTask(owner);
        const running = controllers.get(key(owner));
        if (running !== undefined && !running.terminal && !interruptedWebJobs.has(key(owner))) throw new Error("The running execution identity is not proven to be Web.");
        if (current == null || current.worktreeId !== owner.worktreeId || current.workerId !== owner.workerId || current.serverOrigin !== owner.serverOrigin || current.userId !== owner.userId || localTask?.agentControlMode !== "web") throw new Error("The original Web execution evidence is missing or conflicting.");
        const schedule = getCleanupSchedule(localTask);
        if (schedule !== null && schedule.worktreeId !== current.worktreeId) throw new Error("The original Web worktree identity changed before stop.");
        if (!compatibleWebSessions(localTask.sessionId, current.resources.nativeSession?.sessionId)) throw new Error("The original Web session identity changed before stop.");
        const stopped = await options.webBackend.cleanup(current, { kind: "shutdown", deadline: now(), immediateStop: true, signal: operationSignal });
        if (!stopped.complete) throw new Error("The original Web resources remain during stop.");
        const identity = `false/${key(owner)}`, activity = monitoringActivities.get(identity);
        if (activity !== undefined) { observe(m => m.endActivity(activity)); monitoringActivities.delete(identity); }
      })));
      failures.push(...[...missingResults, ...webResults].flatMap(result => result.status === "rejected" ? [result.reason] : []));
      if (failures.length > 0) throw new AggregateError(failures, "Project execution stop was not confirmed.");
      operationSignal.throwIfAborted();
      if (selected(projectId) && (configuration.targetProjectIds === undefined || configuration.targetProjectIds.includes(projectId))) stoppedProjects.delete(projectId);
      else stoppedProjects.add(projectId);
    })().finally(() => { projectStops.delete(projectId); });
    projectStops.set(projectId, operation);
    updatePromptDemand();
    return operation;
  };
  const startLocalDiscard = (): void => {
    if (shuttingDown) return;
    const settled = (owner: ClaimIdentity): boolean => {
      const identity = key(owner);
      return !jobs.has(identity) && !ending.has(identity)
        && options.store.getTask(owner)?.status === "done"
        && getCleanupSchedule(owner) === null;
    };
    if (webDiscardJob === null && options.archiveMaintenance?.discardLocal !== undefined) {
      const webJob = options.archiveMaintenance.discardLocal(settled, archiveSessions(), normalSignal).catch(error => {
        if (!isWorkerCancellation(error, normalSignal)) options.emit({ kind: "cleanup-error", message: "Local Web recording maintenance failed; it will be retried.", error });
      }).finally(() => { if (webDiscardJob === webJob) webDiscardJob = null; });
      webDiscardJob = webJob;
    }
  };
  const reconcile = async (): Promise<void> => {
    reconciliationPhase = "reconciliation";
    observe(m => m.setPhase("reconciliation"));
    launchCleanups();
    startLocalDiscard();
    const inventoryConfiguration = configuration;
    const initialInvalidations = new Map(projectInvalidations);
    let observation: Awaited<ReturnType<typeof ownInventory>>;
    try {
      reconciliationPhase = "inventory";
      observe(m => m.setPhase("inventory"));
      await options.remote.currentUserId(normalSignal);
      observation = await ownInventory(normalSignal, initialInvalidations);
      recoverScheduler("inventory");
    } catch (error) {
      options.onInventory?.(null);
      throw error;
    }
    const { tasks: inventory, covered: coveredProjects, unavailable } = observation;
    activeCoverage = { covered: coveredProjects, unavailable };
    // A 404 can arrive after ownInventory resolves but before this continuation runs.
    for (const projectId of coveredProjects) {
      if ((projectInvalidations.get(projectId) ?? 0) === (initialInvalidations.get(projectId) ?? 0)) continue;
      coveredProjects.delete(projectId);
      unavailable.add(projectId);
      for (const [identity, task] of inventory) if (task.projectId === projectId) inventory.delete(identity);
    }
    const projectObserved = (id: string): boolean => coveredProjects.has(id) || unavailable.has(id);
    const configurationObserved = (): boolean => configuration === inventoryConfiguration && (options.configurationComplete?.() ?? true)
      && (configuration.targetProjectIds ?? []).every(projectObserved)
      && configuration.repositories.every(repository => projectObserved(repository.project.projectId))
      && options.store.listProjects().every(project => projectObserved(project.projectId));
    options.onInventory?.(unavailable.size === 0 && configurationObserved()
      ? { observedAt: new Date(now()).toISOString(), claims: [...inventory.values()].map(task => ({ projectId: task.projectId, taskId: task.id, claimId: readWorkerClaim(task.properties)!.claimId })) }
      : null);
    const prepared = new Set<string>();
    const preparationFailed = new Set<string>();
    reconciliationPhase = "project-preparation";
    observe(m => m.setPhase("project-preparation"));
    for (const project of options.store.listProjects()) {
      const projectId = project.projectId;
      if (!coveredProjects.has(projectId)) continue;
      if (!options.prepareProject || preparedProjects.has(projectId)) { prepared.add(projectId); continue; }
      preparationFailed.add(projectId);
      if (preparationJobs.has(projectId)) continue;
      const generation = projectInvalidations.get(projectId) ?? 0;
      const job = options.prepareProject(projectId, normalSignal).then(() => {
        if (normalSignal.aborted || (projectInvalidations.get(projectId) ?? 0) !== generation) return;
        preparedProjects.add(projectId);
        const previous = projectMonitoringFailures.get(projectId);
        if (previous !== undefined) { observe(m => m.recover(previous)); projectMonitoringFailures.delete(projectId); }
        options.requestReconcile?.();
      }).catch(error => {
        if (isWorkerCancellation(error, normalSignal)) return;
        if (isUnavailableProject(error)) invalidateProject(projectId);
        const operationId = projectMonitoringFailures.get(projectId) ?? randomUUID();
        projectMonitoringFailures.set(projectId, operationId);
        observe(m => m.fail({ operationId, component: "project", phase: "project-preparation", scope: { kind: "project", projectId }, error }));
        options.emit({ kind: "warning", message: `Could not prepare project ${projectId}; its work is not admitted.`, error });
      }).finally(() => { preparationJobs.delete(projectId); });
      preparationJobs.set(projectId, job);
    }
    // Ownership loss is authoritative even when the following resource observations fail.
    for (const owner of [...options.store.listUnfinishedTasks(), ...unfinishedWeb(), ...ending.values(), ...options.store.listCleanupSchedules()]) {
      if (!coveredProjects.has(owner.projectId)) continue;
      if (inventory.has(key(owner))) { retiredClaims.delete(key(owner)); ownedClaims.add(key(owner)); }
      else { retiredClaims.add(key(owner)); ownedClaims.delete(key(owner)); }
    }
    for (const local of options.store.listUnfinishedTasks()) {
      if (unavailable.has(local.projectId)) {
        const running = controllers.get(key(local));
        if (running !== undefined && !running.terminal) running.controller.abort(new Error("The project is unavailable; its original claim and resources are retained."));
        continue;
      }
      if (!coveredProjects.has(local.projectId) || inventory.has(key(local))) continue;
      const running = controllers.get(key(local));
      if (running !== undefined && !running.terminal) running.controller.abort(new Error("The original claim no longer belongs to this worker."));
      const identity = key(local), activity = monitoringActivities.get(`false/${identity}`);
      discardWebClaim(identity);
      if (activity !== undefined) { observe(m => m.endActivity(activity)); monitoringActivities.delete(`false/${identity}`); }
      for (const [failureKey, operationId] of monitoringFailures) if (failureKey.startsWith(`false/${identity}/`)) { observe(m => m.discardFailure(operationId)); monitoringFailures.delete(failureKey); }
      const limitKey = `limit/${identity}`, limitFailure = monitoringFailures.get(limitKey);
      if (limitFailure !== undefined) { observe(m => m.discardFailure(limitFailure)); monitoringFailures.delete(limitKey); }
      monitoringLimitRetries.delete(identity); recoveredLimitNames.delete(identity);
      for (const [failureKey, operationId] of nameMonitoringFailures) if (failureKey.startsWith(`${identity}/`)) { observe(m => m.discardFailure(operationId)); nameMonitoringFailures.delete(failureKey); }
      nameFailureThisJob.delete(identity);
      const recovery = webRecoveryFailures.get(identity);
      if (recovery !== undefined) { observe(m => m.discardFailure(recovery.id)); webRecoveryFailures.delete(identity); }
      webMonitoringState.delete(identity);
      webUpgradeAttempts.delete(identity);
    }
    reconciliationPhase = "resource-observation";
    observe(m => m.setPhase("resource-observation"));
    const observedBefore = settlementSequence;
    const failedRechecks = new Map<string, ResourceOwner>();
    const recheckFailedProjects = new Set<string>();
    let globalRecheckFailure = false;
    const recheckSettled = async (owner: ResourceOwner, before: number): Promise<boolean> => {
      try { return await cleanupAlreadySettled(owner, before); }
      catch (error) {
        if (isWorkerCancellation(error, normalSignal)) throw error;
        failedRechecks.set(key(owner), owner);
        globalRecheckFailure = true;
        recheckFailedProjects.add(owner.projectId);
        preparationFailed.add(owner.projectId);
        ending.delete(key(owner));
        executionCapacity.invalidate(owner);
        options.emit({ kind: "cleanup-error", identity: owner, message: "Could not recheck original cleanup settlement.", error });
        return true;
      }
    };
    // Historical Web schedules without a journal are claim-level evidence only.
    // Reconcile them after authoritative inventory; worktree identity is used
    // only after verifying that no Web execution was registered.
    for (const schedule of options.store.listCleanupSchedules()) {
      if (!coveredProjects.has(schedule.projectId) || inventory.has(key(schedule)) || options.webStore.getTask(schedule) != null) continue;
      if (!ending.has(key(schedule))) ending.set(key(schedule), { projectId: schedule.projectId, taskId: schedule.taskId, claimId: schedule.claimId });
    }
    const knownOwners = unfinishedWeb();
    for (const owner of knownOwners) {
      if (recheckFailedProjects.has(owner.projectId)) continue;
      if (!coveredProjects.has(owner.projectId) || options.store.getProject(owner) === null || inventory.has(key(owner)) || await recheckSettled(owner, observedBefore)) continue;
      ending.set(key(owner), owner);
    }
    for (const local of options.store.listUnfinishedTasks()) {
      if (coveredProjects.has(local.projectId) && retiredClaims.has(key(local)) && !ending.has(key(local))) ending.set(key(local), local);
    }
    launchCleanups();
    const snapshotBefore = settlementSequence;
    const resources = await snapshot(normalSignal, coveredProjects, [...inventory.values()].map((task) => remoteOwner(task)), unavailable, preparationFailed);
    const retainFailedRechecks = (): void => {
      for (const [identity, owner] of failedRechecks) {
        resources.scannedProjects.delete(owner.projectId);
        resources.unavailableProjects.add(owner.projectId);
        resources.owners.set(identity, owner);
        resources.unresolved.add(identity);
        resources.quarantined.set(identity, owner);
      }
    };
    retainFailedRechecks();
    if (resources.unavailableProjects.size === 0 && resources.quarantined.size === 0) recoverScheduler("resource-observation");
    const observedAt = new Date(now()).toISOString();
    const publishCapacity = (): void => {
      const projection = latestReservations;
      if (unavailable.size > 0 || resources.unavailableProjects.size > 0 || preparationFailed.size > 0 || !allMappingsObserved()) { observe(m => m.staleCapacity()); return; }
      publishedReservations = projection.map(item => ({ ...item, roles: [...item.roles] }));
      observe(m => m.setCapacity({ limit: configuration.maxConcurrent, occupied: projection.filter(item => item.occupied).length, observedAt,
        reservations: projection.map(({ identity, roles, occupied }) => {
          const [projectId, taskId, claimId] = identity.split("/");
          return { identity: { projectId: projectId!, taskId: taskId!, claimId: claimId! }, roles, occupied };
        }) }));
    };
    // New mappings require both a claim inventory and resource discovery before admission.
    const allMappingsObserved = (): boolean => !globalRecheckFailure && configurationObserved()
      && options.store.listProjects().every(project => resources.scannedProjects.has(project.projectId) || preparationFailed.has(project.projectId))
      && (configuration.targetProjectIds ?? []).every(id => unavailable.has(id) || options.store.getProject({ projectId: id }) !== null);
    const quarantinedTask = (task: Pick<ClaimIdentity, "projectId" | "taskId">): boolean => resources.conflicts.has(taskKey(task)) || [...resources.quarantined.values()].some(owner => taskKey(owner) === taskKey(task));
    const quarantinedReasons = (observedAt: string) => [...resources.quarantined.values()].map(owner => ({
      code: "retained-resource-conflict" as const,
      scope: { kind: "claim" as const, projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId },
      observedAt, nextAttemptAt: null,
    }));
    for (const [identityKey, owner] of resources.owners) {
      if (recheckFailedProjects.has(owner.projectId)) continue;
      if (!resources.quarantined.has(identityKey) && coveredProjects.has(owner.projectId) && resources.proven.has(identityKey) && !inventory.has(identityKey) && !await recheckSettled(owner, snapshotBefore)) { retiredClaims.add(identityKey); ending.set(identityKey, owner); }
    }
    retainFailedRechecks();
    cycleCoverage = allMappingsObserved() && unavailable.size === 0 && resources.unavailableProjects.size === 0 && resources.quarantined.size === 0
      && configuration.repositories.every(repository => prepared.has(repository.project.projectId)) ? "complete" : "partial";
    for (const local of options.store.listUnfinishedTasks()) {
      if (!coveredProjects.has(local.projectId) || preparationFailed.has(local.projectId) || resources.unavailableProjects.has(local.projectId) || resources.quarantined.has(key(local)) || inventory.has(key(local))) continue;
      const owner = resources.owners.get(key(local));
      if (owner !== undefined) ending.set(key(local), owner);
      else if (!jobs.has(key(local)) && !ending.has(key(local))) ending.set(key(local), local);
    }

    launchCleanups();
    await Promise.all([...ending.values()].filter(hasWorktreeIdentity).map(async owner => {
      const local = options.store.getTask(owner), web = options.webStore.getTask(owner);
      const sequence = executionCapacity.beginObservation(owner);
      const observer = options.webBackend.observeExecutionStop;
      try {
        const observation = await cleanupOperation(operation => observer(owner, operation), normalSignal);
        executionCapacity.observe(owner, sequence, observation);
        if (observation.kind === "unknown") options.emit({ kind: "stop-unknown", identity: owner, component: "cleanup", phase: "agent-stop", ...(local === null ? {} : { task: local }), message: "The original execution stop could not be observed.", error: observation.error });
      } catch (error) {
        if (isWorkerCancellation(error, normalSignal)) throw error;
        executionCapacity.observe(owner, sequence, { kind: "unknown", target: owner, error, observedAt: now() });
        options.emit({ kind: "stop-unknown", identity: owner, component: "cleanup", phase: "agent-stop", ...(local === null ? {} : { task: local }), message: "The original execution stop could not be observed.", error });
      }
    }));
    for (const [identityKey, remoteTask] of inventory) {
      let local = options.store.getTask(remoteOwner(remoteTask));
      if (local === null) continue;
      if (local.status === "active" && !quarantinedTask(local) && coveredProjects.has(local.projectId) && prepared.has(local.projectId) && !recheckFailedProjects.has(local.projectId) && !blockedByOldClaim(local, resources.owners.values())) {
        if (resources.unavailableProjects.has(local.projectId)) scheduleKnownWebDuringIncompleteScan(local, remoteTask);
        else schedule(local, remoteTask);
      }
      if (!quarantinedTask(local) && allMappingsObserved() && coveredProjects.has(local.projectId) && prepared.has(local.projectId) && resources.scannedProjects.has(local.projectId) && canAdvance(local) && resources.owners.has(identityKey) && local.status === "pending" && !blockedByOldClaim(local, resources.owners.values())) {
        local = options.store.activateTask(local);
        schedule(local, remoteTask);
      }
    }
    const projects = options.store.listProjects().filter(project => coveredProjects.has(project.projectId) && canAdvanceProject(project.projectId) && prepared.has(project.projectId) && resources.scannedProjects.has(project.projectId));
    while (allMappingsObserved() && capacity(resources) < configuration.maxConcurrent && projects.length > 0) {
      let started = false;
      for (let turn = 0; turn < projects.length; turn++) {
        const project = projects[nextPendingProject % projects.length]!;
        nextPendingProject = (nextPendingProject + 1) % projects.length;
        if (!coveredProjects.has(project.projectId)) continue;
        const pending = options.store.listUnfinishedTasks().filter((task) => task.projectId === project.projectId && task.status === "pending").sort((left, right) => left.taskId.localeCompare(right.taskId));
        const local = pending.find(task => !quarantinedTask(task) && canAdvance(task) && inventory.has(key(task)) && !blockedByOldClaim(task, resources.owners.values()));
        if (local === undefined) continue;
        schedule(options.store.activateTask(local), inventory.get(key(local))!);
        started = true;
        break;
      }
      if (!started) break;
    }
    const cleanupFailure = (identity: string) => {
      try { return getCleanupSchedule(ending.get(identity)!) ?? cleanupRetries.get(identity); }
      catch { return cleanupRetries.get(identity); }
    };
    const occupied = capacity(resources);
    const blocked = occupied >= configuration.maxConcurrent
      ? latestReservations.filter(item => item.occupied && ending.has(item.identity) && cleanupFailure(item.identity)?.lastError != null).map(item => item.identity).sort() : [];
    publishCapacity();
    const admissionAt = new Date(now()).toISOString();
    if (cycleCoverage !== "complete") observe(m => m.setAdmission("partial", [
      ...[...unavailable].map(projectId => ({ code: "project-unavailable" as const, scope: { kind: "project" as const, projectId }, observedAt: admissionAt, nextAttemptAt: null })),
      ...[...preparationFailed].filter(projectId => !unavailable.has(projectId)).map(projectId => ({ code: "project-preparation-failed" as const, scope: { kind: "project" as const, projectId }, observedAt: admissionAt, nextAttemptAt: null })),
      ...quarantinedReasons(admissionAt),
      ...(occupied >= configuration.maxConcurrent ? [{ code: "capacity-full" as const, scope: { kind: "worker" as const }, observedAt: admissionAt, nextAttemptAt: null }] : []),
      ...[...resources.unavailableProjects].map(projectId => ({ code: "resource-observation-unavailable" as const, scope: { kind: "project" as const, projectId }, observedAt: admissionAt, nextAttemptAt: null })),
    ]));
    else if (occupied >= configuration.maxConcurrent) observe(m => m.setAdmission("complete", [
      { code: "capacity-full", scope: { kind: "worker" }, observedAt: admissionAt, nextAttemptAt: null },
      ...(latestReservations.some(item => item.occupied && item.roles.includes("cleanup")) && latestReservations.filter(item => item.occupied && (!item.roles.includes("cleanup") || inventory.has(item.identity) || resources.unresolved.has(item.identity))).length < configuration.maxConcurrent ? [{ code: "cleanup-capacity-blocked" as const, scope: { kind: "worker" as const }, observedAt: admissionAt, nextAttemptAt: null }] : []),
    ]));
    else if (configuration.repositories.length === 0) observe(m => m.setAdmission("complete", [{ code: "no-projects-selected", scope: { kind: "worker" }, observedAt: admissionAt, nextAttemptAt: null }]));
    const warning = blocked.join(",");
    if (warning !== capacityWarning) {
      capacityWarning = warning;
      if (warning !== "") options.emit({ kind: "cleanup-capacity-blocked", message: `Worker capacity is full; failed cleanup retains ${blocked.length} slot(s). ${blocked.map(identity => { const state = cleanupFailure(identity)!; return `${identity}: ${state.stage}, next retry ${new Date(state.nextAttemptAt).toISOString()}, ${state.lastError}`; }).join("; ")}. Correct the reported resource or archive failure; retries are automatic. Unconfirmed execution stops retain their slots.` });
    }
    if (!allMappingsObserved() || capacity(resources) >= configuration.maxConcurrent || configuration.repositories.length === 0 || configuration.taskTagFilterKey === null) return;
    reconciliationPhase = "claim-search";
    observe(m => { m.setPhase("claim-search"); if (cycleCoverage === "complete") m.setAdmission("unknown", []); });
    const acquisitionConfiguration = configuration;
    const tiers = acquisitionConfiguration.platformTaskMode === "all" ? [undefined] : acquisitionConfiguration.platformTaskMode === "prefer" ? [true, false] : [true];
    let sawCandidate = false;
    let searchIncomplete = false;
    const retainedConflicts = new Set<string>();
    const searchUnavailable = new Set<string>();
    for (const platformSpecific of tiers) {
      const candidates = new Map<number, AsyncGenerator<Task>>();
      const exhausted = new Set<number>();
      try {
        while (configuration === acquisitionConfiguration && allMappingsObserved() && capacity(resources) < configuration.maxConcurrent && exhausted.size < configuration.repositories.length) {
          const index = (platformSpecific === true ? nextPlatformRepository : nextRepository) % configuration.repositories.length;
          if (platformSpecific === true) nextPlatformRepository = (index + 1) % configuration.repositories.length;
          else nextRepository = (index + 1) % configuration.repositories.length;
          if (exhausted.has(index)) continue;
          const repository = configuration.repositories[index]!;
          if (!coveredProjects.has(repository.project.projectId) || !prepared.has(repository.project.projectId) || !resources.scannedProjects.has(repository.project.projectId)) { searchIncomplete = true; cycleCoverage = "partial"; exhausted.add(index); continue; }
          let page = candidates.get(index);
          if (page === undefined) {
            page = typeof acquisitionConfiguration.taskTagFilterKey === "string"
              ? options.remote.candidates(repository.project.projectId, options.platform, normalSignal, platformSpecific, options.workerId)
              : platformSpecific === undefined
                ? options.remote.candidates(repository.project.projectId, options.platform, normalSignal)
                : options.remote.candidates(repository.project.projectId, options.platform, normalSignal, platformSpecific);
            candidates.set(index, page);
          }
          let next: IteratorResult<Task>;
          try { next = await page.next(); }
          catch (error) {
            if (acquisitionConfiguration.taskTagFilterKey !== undefined && error instanceof ApiError && error.phase === "response" && error.status === 400 && (error.code === "invalid_cursor" || error.code === "invalid_input" && error.serverMessage === "Cursor is invalid for this list.")) options.onConfigurationStale?.();
            if (!isUnavailableProject(error)) {
              if (!isWorkerCancellation(error, normalSignal)) {
                projectSearchFailure = true;
                const searchKey = `${repository.project.projectId}/${platformSpecific ?? "all"}`;
                const operationId = candidateMonitoringFailures.get(searchKey) ?? randomUUID();
                candidateMonitoringFailures.set(searchKey, operationId);
                observe(m => m.fail({ operationId, component: "scheduler", phase: "claim-search", scope: { kind: "project", projectId: repository.project.projectId }, error }));
              }
              throw error;
            }
            invalidateProject(repository.project.projectId);
            searchUnavailable.add(repository.project.projectId);
            observe(m => m.setAdmission("partial", [
              ...quarantinedReasons(admissionAt),
              ...[...searchUnavailable].map(projectId => ({ code: "project-unavailable" as const, scope: { kind: "project" as const, projectId }, observedAt: new Date(now()).toISOString(), nextAttemptAt: null })),
            ]));
            searchIncomplete = true;
            cycleCoverage = "partial";
            coveredProjects.delete(repository.project.projectId);
            unavailable.add(repository.project.projectId);
            exhausted.add(index);
            continue;
          }
          if (configuration !== acquisitionConfiguration) { cycleCoverage = "partial"; return; }
          if (next.done) {
            const searchKey = `${repository.project.projectId}/${platformSpecific ?? "all"}`, previous = candidateMonitoringFailures.get(searchKey);
            if (previous !== undefined) { observe(m => m.recover(previous)); candidateMonitoringFailures.delete(searchKey); }
            exhausted.add(index); continue;
          }
          const candidate = next.value;
          sawCandidate = true;
          if (!coveredProjects.has(candidate.projectId)) { exhausted.add(index); continue; }
          const claimConfiguration = configuration;
          const currentRepository = claimConfiguration.repositories.find(value => value.project.projectId === candidate.projectId);
          if (currentRepository === undefined || !selected(candidate.projectId) || claimConfiguration.targetProjectIds !== undefined && !claimConfiguration.targetProjectIds.includes(candidate.projectId)) continue;
          try {
            assertCanAcquire({ projectId: candidate.projectId, taskId: candidate.id });
            if (resources.conflicts.has(taskKey({ projectId: candidate.projectId, taskId: candidate.id }))) throw new Error("A registered worktree remains for this task without a matching execution.");
            if ([...resources.owners.values()].some(owner => owner.projectId === candidate.projectId && owner.taskId === candidate.id)) throw new Error("An original task resource still reserves its worktree; a new claim cannot be acquired.");
          }
          catch (error) {
            if (resources.conflicts.has(taskKey({ projectId: candidate.projectId, taskId: candidate.id })) || [...resources.owners.values()].some(owner => owner.projectId === candidate.projectId && owner.taskId === candidate.id)) retainedConflicts.add(candidate.projectId);
            options.emit({ kind: "warning", message: `Skipping ${candidate.projectId}/${candidate.id}: ${error instanceof Error ? error.message : "retained resource admission failed"}`, error });
            continue;
          }
          requireImplementedWorkerBackend(currentRepository.configuration);
          if (currentRepository.configuration.agentControlMode === "web") await options.verifyWebServer?.(currentRepository.configuration.agent, normalSignal);
          const frozenConfiguration = options.freezeConfiguration === undefined ? currentRepository.configuration : await options.freezeConfiguration(currentRepository.configuration, normalSignal);
          normalSignal.throwIfAborted();
          if (configuration !== claimConfiguration || !coveredProjects.has(candidate.projectId) || !allMappingsObserved()) continue;
          const claimId = randomUUID(), worktreeId = randomUUID();
          reconciliationPhase = "claim-request";
          observe(m => m.setPhase("claim-request"));
          try {
            const descriptor = { claimId, workerId: options.workerId, machine: options.machine, platform: options.platform, agent: currentRepository.configuration.agent, agentControlMode: "web" as const, worktreeId };
            const granted = await withLifecycleReservation("task", { kind: "task_claim", projectId: candidate.projectId, taskId: candidate.id, claimId, worktreeId, candidateVersion: String(candidate.version), frozenConfiguration }, async () => {
              const result = typeof claimConfiguration.taskTagFilterKey === "string"
              ? await options.remote.claim(candidate, descriptor, normalSignal, claimConfiguration.taskTagFilterKey)
              : await options.remote.claim(candidate, descriptor, normalSignal);
              const claim = readWorkerClaim(result.properties);
              if (claim === undefined || claim.claimId !== claimId) throw new Error("Original claim receipt identity changed.");
              options.store.registerPending({ projectId: result.projectId, taskId: result.id, claimId, agent: claim.agent, agentControlMode: "web", nativeConfiguration: frozenConfiguration });
              return result;
            }, claimId);
            const owner = remoteOwner(granted);
            if (readWorkerClaim(granted.properties)?.agentControlMode !== "web") throw new Error("The granted claim is not a Web execution.");
            const local = options.store.registerPending({ projectId: granted.projectId, taskId: granted.id, claimId: owner.claimId, agent: readWorkerClaim(granted.properties)!.agent, agentControlMode: "web", nativeConfiguration: frozenConfiguration });
            registerClaim(granted);
            confirmWebClaim(owner);
            options.onClaim?.({ projectId: granted.projectId, taskId: granted.id, claimId: owner.claimId });
            if (!quarantinedTask(local) && allMappingsObserved() && coveredProjects.has(local.projectId) && selected(local.projectId) && canAdvance(local) && !blockedByOldClaim(local, resources.owners.values()) && capacity(resources) < configuration.maxConcurrent) schedule(options.store.activateTask(local), granted);
            capacity(resources);
            if (configuration !== acquisitionConfiguration || !allMappingsObserved()) cycleCoverage = "partial";
            observe(m => m.staleCapacity());
            return;
          } catch (error) {
            if (isWorkerCancellation(error, normalSignal)) throw error;
            if (claimConfiguration.taskTagFilterKey !== undefined && error instanceof ApiError && error.phase === "response" && error.confirmedRefusal && error.status === 409 && ["claim_conflict", "version_conflict", "worker_task_tag_filter_unsupported"].includes(error.code ?? "")) options.onConfigurationStale?.();
            if (isUnavailableProject(error)) options.onInventory?.(null);
            cycleCoverage = "partial";
            observe(m => m.setAdmission("partial", [...quarantinedReasons(admissionAt), { code: "claim-unconfirmed", scope: { kind: "project", projectId: candidate.projectId }, observedAt: new Date(now()).toISOString(), nextAttemptAt: null }]));
            options.emit({ kind: "warning", message: `Claim request for ${candidate.projectId}/${candidate.id}/${claimId} did not confirm a grant; the next complete inventory will reconcile it.`, error });
            return;
          }
        }
      } finally {
        await Promise.all([...candidates.values()].map((page) => page.return(undefined)));
      }
    }
    if (configuration !== acquisitionConfiguration || !allMappingsObserved()) cycleCoverage = "partial";
    if (!searchIncomplete && configuration === acquisitionConfiguration && cycleCoverage === "complete") recoverScheduler("claim-search");
    if (retainedConflicts.size > 0 || searchUnavailable.size > 0) {
      const observedAt = new Date(now()).toISOString();
      observe(m => m.setAdmission(searchIncomplete || cycleCoverage !== "complete" ? "partial" : "complete", [
        ...[...searchUnavailable].map(projectId => ({ code: "project-unavailable" as const, scope: { kind: "project" as const, projectId }, observedAt, nextAttemptAt: null })),
        ...quarantinedReasons(observedAt),
        ...[...retainedConflicts].map(projectId => ({ code: "retained-resource-conflict" as const, scope: { kind: "project" as const, projectId }, observedAt, nextAttemptAt: null })),
      ]));
    }
    if (!sawCandidate && !searchIncomplete && cycleCoverage === "complete" && configuration === acquisitionConfiguration && allMappingsObserved() && latestReservations.filter(item => item.occupied).length < configuration.maxConcurrent) {
      observe(m => m.setAdmission("complete", [{ code: "no-ready-tasks", scope: { kind: "worker" }, observedAt: new Date(now()).toISOString(), nextAttemptAt: null }]));
    }
  };
  const assertCanAcquire = (target: Pick<ClaimIdentity, "projectId" | "taskId">): void => {
    assertWorkerLifecycleAdmission();
    normalSignal.throwIfAborted();
    if (options.store.listClaimToolReservations().some(reservation => reservation.projectId === target.projectId && reservation.taskId === target.taskId)) throw new Error("The original claim request remains unconfirmed; its frozen selection is reserved.");
    // A Git mutation may have removed its visible worktree before its owned
    // process joins. Consult persisted responsibilities too, including before
    // the first reconciliation after restart. Settled metadata alone is not a barrier.
    const sameTask = (owner: Pick<ClaimIdentity, "projectId" | "taskId">): boolean => owner.projectId === target.projectId && owner.taskId === target.taskId;
    if ([...ending.values(), ...cleanupSchedules(), ...options.store.listUnfinishedTasks(), ...unfinishedWeb()].some(sameTask)) throw new Error("The original task cleanup remains pending; a new claim cannot be acquired.");
  };
  const registerClaim = (task: Task): void => {
    const claim = readWorkerClaim(task.properties);
    if (task.status !== "in_progress" || claim?.state !== "active" || claim.workerId !== options.workerId) throw new Error("Fresh claim registration requires an active grant on this worker.");
    const owner = remoteOwner(task);
    const local = options.store.getTask(owner);
    if (local?.status !== "pending" || local.agent !== claim.agent || local.agentControlMode !== "web" || claim.agentControlMode !== "web") throw new Error("Fresh claim registration requires its matching pending local task.");
  };
  const readSource = async (identity: ClaimIdentity): Promise<{ task: LocalTask; owner: ResourceOwner; remoteTask: Task }> => {
    const task = options.store.getTask(identity);
    if (task === null || task.status === "done") throw new Error("The original unfinished local claim is missing.");
    const remoteTask = await options.remote.readTask(identity.projectId, identity.taskId, normalSignal);
    const worker = readWorkerClaim(remoteTask.properties);
    if (worker === undefined || worker.claimId !== identity.claimId || worker.workerId !== options.workerId || worker.state !== "active" || worker.agentControlMode !== "web") throw new Error("The original claim is no longer active on this worker.");
    return { task, owner: remoteOwner(remoteTask), remoteTask };
  };
  return {
    invalidateProject,
    archiveYield: (): boolean => ending.size > 0 || [...cleanupRetries.values()].some(retry => retry.stage === "archive") || latestReservations.filter(item => item.occupied).length >= configuration.maxConcurrent,
    updateConfiguration: (value: WorkerCoordinatorConfiguration): void => {
      const next = configurationView(value);
      // Claim admission fences actual view changes, not repeated heartbeat acknowledgments.
      if (!isDeepStrictEqual(configuration, next)) {
        configuration = next;
        updatePromptDemand();
        options.onInventory?.(null);
        for (const projectId of stoppedProjects) if (canAdvanceProject(projectId)) stoppedProjects.delete(projectId);
      }
    },
    stopProject,
    assertCanAcquire,
    registerClaim,
    closeAdmission: (reason: unknown = new Error("Worker execution admission is closed.")): void => { executionCancellation.abort(reason); },
    executionSnapshot: () => ({
      admissionClosed: shuttingDown,
      jobs: [...jobs.keys()], preparationJobs: [...preparationJobs.keys()], projectStops: [...projectStops.keys()],
      taskWriters: [...tails.keys()],
      reconciling: ticking,
      claims: options.store.listUnfinishedTasks().map(({ projectId, taskId, claimId, status }) => ({ projectId, taskId, claimId, status })),
      claimReservations: options.store.listClaimToolReservations().map(reservation => ({ ...reservation, version: reservation.version.toString() })),
      webExecutions: options.webStore.listUnfinishedTasks().map(({ projectId, taskId, claimId, worktreeId, webExecution }) => ({
        projectId, taskId, claimId, worktreeId, executionId: webExecution?.executionId ?? null,
        sessionId: webExecution?.sessionId ?? null, executionGeneration: webExecution?.executionGeneration ?? null,
      })),
      recovery: options.webStore.listUnfinishedTasks().map((record): LifecycleTaskRecoveryEvidence => {
        const execution = record.webExecution, previous = lifecycleRecovery.get(key(record));
        const same = previous !== undefined && previous.executionId === (execution?.executionId ?? null) && previous.sessionId === (execution?.sessionId ?? null) && previous.executionGeneration === (execution?.executionGeneration ?? null);
        const result = executionRecoveryResult({ ownershipChanged: lifecycleAuthority.get(key(record)) === "ownership_changed" || ending.has(key(record)) || same && previous.reasonCode === "ownership_changed",
          independentBlocker: lifecycleAuthority.get(key(record)) === "independent_blocker" || pausedClaims.has(key(record)) || options.webStore.getOrchestrationBlocker(record) !== null || record.recovery.reasonCode === "recovery_limit" || same && previous.reasonCode === "independent_blocker",
          nativeBlocked: record.recovery.pauseReason !== null && record.recovery.reasonCode !== "recovery_limit",
          outcomeUnknown: shuttingDown || execution?.launchSubmission === "unknown" || ["unknown", "dispatching"].includes(execution?.initialInputState ?? ""),
          verified: same && previous.recoverability === "eligible" });
        return { projectId: record.projectId, taskId: record.taskId, claimId: record.claimId,
          executionId: execution?.executionId ?? null, sessionId: execution?.sessionId ?? null, executionGeneration: execution?.executionGeneration ?? null, ...result };
      }),
      ending: [...ending.values()].map(owner => ({ ...owner })),
    }),
    tick: async (): Promise<void> => {
      if (shuttingDown || ticking) return;
      ticking = true;
      let joined!: () => void;
      tickJoined = new Promise<void>(resolve => { joined = resolve; });
      cycleCoverage = "unknown";
      projectSearchFailure = false;
      projectInventoryFailure = false;
      observe(m => m.startCycle("reconciliation"));
      try { await reconcile(); observe(m => { if (cycleCoverage === "complete") m.markCycleSuccessful(); m.endCycle("completed", cycleCoverage); }); }
      catch (error) {
        const cancelled = isWorkerCancellation(error, normalSignal);
        observe(m => {
          m.staleCapacity();
          m.setAdmission("unknown", []);
          if (!cancelled && !projectSearchFailure && !projectInventoryFailure) {
            const operationId = schedulerFailures.get(reconciliationPhase) ?? randomUUID();
            schedulerFailures.set(reconciliationPhase, operationId);
            m.fail({ operationId, component: reconciliationPhase === "inventory" ? "inventory" : reconciliationPhase === "resource-observation" ? "resources" : "scheduler", phase: reconciliationPhase, scope: { kind: "worker" }, error });
          }
          m.endCycle(cancelled ? "cancelled" : "failed", "partial");
        });
        throw error;
      }
      finally {
        try { updatePromptDemand(); }
        finally {
          activeCoverage = undefined; ticking = false;
          settledCleanups.clear();
          joined();
        }
      }
    },
    advanceRetry: async (identity: ClaimIdentity, prepareRepository?: () => Promise<void>): Promise<WorkerInputWait | undefined> => {
      const { task, owner, remoteTask } = await readSource(identity);
      if (task.status !== "active") throw new Error("Only an active original claim may be retried; pending work is started by worker run.");
      const webRecord = task.agentControlMode === "web" ? options.webStore.getTask(task) : null;
      const worker = readWorkerClaim(remoteTask.properties)!;
      if (task.agentControlMode === "web" && !webRecord) throw new Error("Retry requires the original Web execution evidence; it cannot start a replacement assignment.");
      if (webRecord && (webRecord.worktreeId !== worker.worktreeId || webRecord.workerId !== worker.workerId || webRecord.userId !== worker.userId || webRecord.serverOrigin !== options.serverOrigin)) throw new Error("The original Web execution ownership no longer matches the active claim.");
      if (configurationFor(task) === null) throw new Error("Native configuration is unavailable for this project; correct its cloud settings before retrying execution.");
      executionCapacity.invalidate(remoteOwner(remoteTask));
      await prepareRepository?.();
      return serialize(identity, async () => {
        if (task.agentControlMode === "web") {
          let record = options.webStore.getTask(task);
          if (record !== null) {
            if (record.cleanup !== null) {
              if (await checkWebAuthority(record, normalSignal, true, true) === "claim_invalid") return { kind: "waiting_input", reason: "claim_invalid" };
              webUpgradeAttempts.add(key(task));
              record = await finishShutdown(record, normalSignal);
            }
            const reason = await checkWebAuthority(record, normalSignal, true);
            if (reason !== null) return { kind: "waiting_input", reason };
            options.webStore.authorizeRecoveryRetry(record, now());
          }
        }
        return ensure(task, remoteTask, normalSignal, true);
      });
    },
    cleanupSource: async (identity: ClaimIdentity, settings: { deleteWorktree?: boolean; ownerUserId?: string } = {}, prepareLegacyRepository?: () => Promise<void>): Promise<ResourceOwner> => {
      const { owner, remoteTask } = await readSource(identity);
      const originalUserId = readWorkerClaim(remoteTask.properties)!.userId;
      if (settings.ownerUserId !== undefined && settings.ownerUserId !== originalUserId) throw new Error("The original execution owner changed before cleanup.");
      await serialize(identity, async () => {
        const record = options.webStore.getTask(owner);
        if (record !== null && prelaunchLegacy(record)) await prepareLegacyRepository?.();
        await runCleanup(owner, settings.deleteWorktree === true, normalSignal, undefined, true, originalUserId);
        normalSignal.throwIfAborted();
        if (settings.deleteWorktree === true) {
          if (!executionStoppedOrEmpty(owner)) throw new Error("The original execution stop remains unknown; its reservation is retained.");
          deleteCleanupSchedule(owner, originalUserId);
          recordSettledCleanup(owner);
        }
      });
      return owner;
    },
    completeSource: async (owner: ResourceOwner, originalUserId = options.userId): Promise<void> => {
      await serialize(owner, async () => {
        await runCleanup(owner, true, normalSignal, undefined, true, originalUserId);
        normalSignal.throwIfAborted();
        if (!executionStoppedOrEmpty(owner)) throw new Error("The original execution stop remains unknown; its reservation is retained.");
        deleteCleanupSchedule(owner, originalUserId);
        recordSettledCleanup(owner);
      });
      const settled = (): boolean => options.store.getTask(owner)?.status === "done"
        && getCleanupSchedule(owner, originalUserId) === null && !jobs.has(key(owner)) && !ending.has(key(owner));
      const web = options.webStore.getTask(owner);
      if (web != null) {
        if (web.cleanup?.discardRecording && options.archiveMaintenance?.discardOne !== undefined) await options.archiveMaintenance.discardOne(web, settled, normalSignal, originalUserId);
      }
    },
    shutdown: (settings: { deadline?: number; currentTasks?: ReadonlyMap<string, Task | Promise<Task>>; pendingClaims?: readonly ClaimIdentity[]; unresolvedTasks?: ReadonlySet<string> } = {}): Promise<boolean> => {
      if (shutdownWork !== undefined) return shutdownWork;
      const deadline = settings.deadline ?? Date.now() + 20_000;
      const bounded = async (work: Promise<unknown>, until = deadline): Promise<boolean> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            work.then(() => true, error => { options.emit({ kind: "shutdown-error", message: "Task resource closure failed; original responsibility is retained.", error }); return false; }),
            new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, until - Date.now())); }),
          ]);
        } finally { clearTimeout(timer); }
      };
      const work = (async (): Promise<boolean> => {
        cancel();
        normalSignal.removeEventListener("abort", cancel);
        // Reserve half the remaining budget for observing known native owners,
        // even when a producer does not acknowledge cancellation.
        const joins = Promise.allSettled([tickJoined, ...jobs.values(), ...tails.values(), ...preparationJobs.values(), ...projectStops.values(), webDiscardJob]).then(results => {
          const failures = results.flatMap(result => result.status === "rejected" && !isWorkerCancellation(result.reason, normalSignal) ? [result.reason] : []);
          if (failures.length) throw new AggregateError(failures, "Task execution producers failed to join cleanly.");
        });
        const joined = await bounded(joins,
          Math.min(deadline, Date.now() + Math.max(0, (deadline - Date.now()) / 2)));
        let complete = joined;
        const candidates = [...options.store.listUnfinishedTasks(), ...options.store.listCleanupSchedules(), ...unfinishedWeb(), ...ending.values(), ...(settings.pendingClaims ?? [])];
        const locateNative = nativeCleanupBatch(candidates, AbortSignal.timeout(CLEANUP_OPERATION_MS));
        const currentTasks = new Map<string, Promise<Task>>();
        const ownershipSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
        let identityCheck: Promise<void> | undefined;
        const observeOwnership = async (owner: CleanupTarget): Promise<boolean> => {
          if (settings.unresolvedTasks?.has(taskKey(owner))) { retiredClaims.delete(key(owner)); complete = false; return false; }
          if ((retiredClaims.has(key(owner)) || ownedClaims.has(key(owner))) && !settings.currentTasks?.has(taskKey(owner))) return true;
          try {
            const identity = taskKey(owner);
            let observed = currentTasks.get(identity);
            if (observed === undefined) {
              observed = (async () => {
                const reconciled = settings.currentTasks?.get(identity);
                if (reconciled !== undefined) return reconciled;
                identityCheck ??= options.remote.currentUserId(ownershipSignal).then(userId => {
                  if (options.userId !== undefined && userId !== options.userId) throw new Error("The original Worker account changed before ownership observation.");
                });
                await identityCheck;
                return options.remote.readTask(owner.projectId, owner.taskId, ownershipSignal);
              })();
              currentTasks.set(identity, observed);
            }
            const task = await observed, claim = readWorkerClaim(task.properties);
            ownershipSignal.throwIfAborted();
            if (task.projectId !== owner.projectId || task.id !== owner.taskId) throw new Error("The current Task observation has a conflicting identity.");
            if (task.status === "in_progress" && claim?.state === "active" && claim.workerId === options.workerId && claim.claimId === owner.claimId) { retiredClaims.delete(key(owner)); ownedClaims.add(key(owner)); return true; }
            retiredClaims.add(key(owner));
            ownedClaims.delete(key(owner));
            ending.set(key(owner), webOwner(owner) ?? owner);
          } catch (error) {
            options.emit({ kind: "warning", identity: owner, message: "Current Task ownership could not be observed; the original stop responsibility is retained.", error });
            if (settings.currentTasks?.has(taskKey(owner))) { retiredClaims.delete(key(owner)); complete = false; return false; }
          }
          return true;
        };
        const unregistered = Promise.all([...new Map(candidates.map(owner => [key(owner), owner])).values()].map(async owner => {
          try { if (webOwner(owner) !== undefined) return; }
          catch (error) {
            complete = false;
            options.emit({ kind: "shutdown-error", identity: owner, message: "The original Web execution identity conflicts with the retained cleanup target.", error });
            return;
          }
          if (!await observeOwnership(owner)) return;
          if (retiredClaims.has(key(owner))) return;
          const task = options.store.getTask(owner);
          if (task === null || task.status === "done" || task.agentControlMode !== "web") return;
          if (options.webStore.getTask(task) != null) {
            complete = false;
            options.emit({ kind: "shutdown-error", task, message: "The original Web execution identity conflicts with this worker." });
            return;
          }
          if (task.status === "pending" && task.sessionId === null && options.verifyWebUnregistered && Date.now() < deadline) {
            try {
              if (await bounded(options.verifyWebUnregistered(task, AbortSignal.timeout(Math.max(1, deadline - Date.now())), Math.max(1, deadline - Date.now())))) return;
            }
            catch { /* Missing launch evidence must not be interpreted as a confirmed native stop. */ }
          }
          complete = false;
          options.emit({ kind: "shutdown-error", task, message: "The original Web execution evidence is missing; complete native stop cannot be confirmed." });
        }));
        const owners = new Map<string, CleanupTarget>(ending);
        for (const owner of candidates) if (!owners.has(key(owner))) owners.set(key(owner), owner);
        // Git inventory cannot prove whether an agent stopped. Terminal deletion stays pending.
        for (const record of unfinishedWeb()) owners.set(key(record), record);
        const stopOwners = Promise.all([...owners.values()].map(async (owner) => {
          try {
            if (!await observeOwnership(owner)) return;
            const terminalJob = shutdownTerminalJobs.get(key(owner));
            if (terminalJob !== undefined) {
              await terminalJob;
              if (ending.has(key(owner))) throw new Error("The original terminal cleanup remains pending.");
              return;
            }
            const originalJob = jobs.get(key(owner));
            if (controllers.get(key(owner))?.terminal === true && originalJob !== undefined) {
              await originalJob;
              if (Date.now() >= deadline) { complete = false; return; }
              const joinedCleanup = shutdownTerminalJobs.get(key(owner));
              if (joinedCleanup !== undefined) {
                await joinedCleanup;
                if (ending.has(key(owner))) throw new Error("The original terminal cleanup remains pending.");
                return;
              }
              if (!ending.has(key(owner))) return;
            }
            if (tails.has(taskKey(owner))) {
              // A cancelled producer can retain the Task writer. Stop only its
              // proven native boundary; cleanup mutations must wait for that writer.
              complete = false;
              const record = options.webStore.getTask(owner);
              if (record === null || record.worktreeId !== owner.worktreeId || options.webBackend.requestExecutionStop === undefined) throw new Error("The retained Task writer has no independent native stop boundary.");
              await options.webBackend.requestExecutionStop(record, deadline);
              return;
            }
            if (retiredClaims.has(key(owner))) {
              startJob(owner, signal => completeCleanup(owner, signal, true, locateNative), true, undefined, true);
              const cleanup = jobs.get(key(owner));
              if (cleanup === undefined) throw new Error("The original terminal cleanup owner is unavailable.");
              shutdownTerminalJobs.set(key(owner), cleanup);
              try { await cleanup; }
              finally { shutdownTerminalJobs.delete(key(owner)); }
              if (ending.has(key(owner))) throw new Error("The original terminal cleanup remains pending.");
              return;
            }
            await serialize(owner, async () => {
              const webRecord = options.webStore.getTask(owner);
              if (webRecord != null) {
                if (webRecord.worktreeId !== owner.worktreeId) throw new Error("The Web cleanup claim has conflicting worktree identities.");
                const stopped = await options.webBackend.cleanup(webRecord, { kind: "shutdown", deadline: now(), immediateStop: true, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
                if (!stopped.complete) throw new Error("The original Web resources remain during shutdown.");
                return;
              }
              if (options.store.getTask(owner)?.agentControlMode === "web") return;
              throw new Error("The original Web execution identity is missing.");
            });
          }
          catch (error) { complete = false; options.emit({ kind: "shutdown-error", ...(options.store.getTask(owner) === null ? {} : { task: options.store.getTask(owner)! }), message: error instanceof WorkerCleanupError && error.stage === "backend-close" ? "The original Agent is stopped, but backend resource closure is unconfirmed." : "Could not confirm the original task resources stopped and closed.", error }); }
        }));
        const stopped = await bounded(Promise.all([unregistered, stopOwners]));
        if (options.store.listClaimToolReservations().length > 0) {
          complete = false;
          options.emit({ kind: "shutdown-error", message: "Original claim request outcomes remain unconfirmed; frozen selections and claim responsibility are retained." });
        }
        if (!joined || !stopped) options.emit({ kind: "shutdown-error", message: "Task resources did not close within the stop deadline; original claims and resource responsibility are retained." });
        return complete && stopped;
      })();
      shutdownWork = work.finally(() => { shutdownWork = undefined; });
      return shutdownWork;
    },
  };
};
