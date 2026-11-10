import { CLEANUP_OPERATION_MS, cleanupOperation } from "../cleanup-operation.js";
import { readWorkerClaim, readSessionStartupReport, readTaskPaused } from "../../api/task-properties.js";
import { legacyBranchLatch } from "./backends/orchestration.js";
import { WorktreePreconditionError } from "./worktrees.js";
import { sameStartupReport, type SessionStartupReport } from "../../session/startup.js";
import { WebRecoveryBlockedError, type WebExecutionBackend } from "./backends/web.js";
import type { WebExecutionStore } from "./backends/web-store.js";
import type { WorkerSessionApi } from "./backends/session-api.js";
import { requireImplementedWorkerBackend } from "./backend.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { resolvePhysicalDirectory } from "../../platform/filesystem.js";
import { repositoryIdentity } from "../../repository/identity.js";
import { setTimeout as delay } from "node:timers/promises";
import { OperationError } from "../../api/operation.js";
import type { Task, TaskPlatform, WorkerMachine, WorkerTaskInventory, WorkerTaskReference } from "../../api/types.js";
import { ensureCleanupSchedule } from "./cleanup-schedule.js";
import { WorkerCleanupError } from "./cleanup-error.js";
import { createCleanupDriver } from "./cleanup.js";
import { assertHerdrResourceBudget, reconcileDeletedHerdrResource } from "./resource-disposal.js";
import { actualTaskPane, createExecutionDriver, executionContext, isWorkerCancellation, liveAgent, sameClaim, settleWorkerStops, workerOperation } from "./execution.js";
import type { ExecutionDependencies, ExecutionInput, WorkerEvent, WorkerGitManager, WorkerObservedPhase } from "./execution.js";
import { HerdrAgentActionError, HerdrRpcError } from "./herdr.js";
import { HerdrInputWaitingError } from "./herdr/agents.js";
import type { HerdrAgentObservation, HerdrOwnedWorkspace, WorkerHerdrAdapter } from "./herdr.js";
import type { ManagedAssignment } from "./prompts.js";
import type { WorkerPromptTuple } from "./prompt-source.js";
import type { ExecutionAdvance } from "./execution.js";
import { isUnavailableProject } from "./remote.js";
import type { WorkerRemote } from "./remote.js";
import type { WorkerStore } from "./store.js";
import type { ClaimIdentity, ExecutionConfiguration, LocalTask, ResourceOwner, WorkerProject } from "./types.js";
import type { createMonitoringObserver } from "./monitoring/observer.js";
import { MonitoringRecoveryEvidence } from "./monitoring/diagnostics.js";

export type WorkerRepositoryAssignment = { project: WorkerProject; configuration: ExecutionConfiguration };
export type WorkerInputWait = { kind: "waiting_input"; reason: "prompt_unknown" | "prompt_too_large" };
export type WorkerCoordinatorOptions = {
  hasHerdrJournal?: boolean;
  availableDiskBytes?: () => bigint;
  webBackend?: Pick<WebExecutionBackend, "advance" | "cleanup"> & Partial<Pick<WebExecutionBackend, "observeStartupReport" | "advanceResult" | "setMonitoringObserver">>;
  webStore?: WebExecutionStore; verifyWebServer?: WorkerSessionApi["verifySupport"]; verifyWebUnregistered?: WorkerSessionApi["verifyUnregistered"];
  verifyWebStartupReporting?: WorkerSessionApi["supportsStartupReports"];
  store: WorkerStore; git: WorkerGitManager; herdr: WorkerHerdrAdapter; remote: WorkerRemote;
  serverOrigin: string; workerId: string; platform: TaskPlatform; machine: WorkerMachine;
  readyProjectIds?: readonly string[]; targetProjectIds?: readonly string[];
  repositories: readonly WorkerRepositoryAssignment[]; globalConfiguration: ExecutionConfiguration | null; maxConcurrent: number;
  preferPlatformSpecificTasks: boolean;
  prepareProject?: (projectId: string, signal: AbortSignal) => Promise<void>;
  configurationComplete?: () => boolean;
  buildPrompt: (assignment: ManagedAssignment, platform: TaskPlatform) => string;
  promptSource?: { current(projectId: string): WorkerPromptTuple | null };
  preparePromptSource?: (projectId: string, signal?: AbortSignal) => Promise<void>;
  onPromptDemand?: (projectIds: readonly string[]) => void;
  onInventory?: (inventory: WorkerTaskInventory | null) => void; onClaim?: (reference: WorkerTaskReference) => void;
  emit: (event: WorkerEvent) => void; signal?: AbortSignal; now?: () => number;
  monitoring?: ReturnType<typeof createMonitoringObserver>;
};
export type WorkerCoordinatorConfiguration = Pick<WorkerCoordinatorOptions, "repositories" | "globalConfiguration" | "maxConcurrent" | "preferPlatformSpecificTasks" | "readyProjectIds" | "targetProjectIds">;

const configurationView = (value: WorkerCoordinatorConfiguration): WorkerCoordinatorConfiguration => Object.freeze({
  maxConcurrent: value.maxConcurrent,
  preferPlatformSpecificTasks: value.preferPlatformSpecificTasks,
  ...(value.readyProjectIds === undefined ? {} : { readyProjectIds: Object.freeze([...value.readyProjectIds]) }),
  ...(value.targetProjectIds === undefined ? {} : { targetProjectIds: Object.freeze([...value.targetProjectIds]) }),
  globalConfiguration: value.globalConfiguration === null ? null : Object.freeze({ ...value.globalConfiguration, args: Object.freeze([...value.globalConfiguration.args]) }),
  repositories: Object.freeze(value.repositories.map(repository => Object.freeze({ project: Object.freeze({ ...repository.project }), configuration: Object.freeze({ ...repository.configuration, args: Object.freeze([...repository.configuration.args]) }) }))),
});

type CleanupTarget = ClaimIdentity & { worktreeId?: string };
const hasWorktreeIdentity = (target: CleanupTarget): target is ResourceOwner => target.worktreeId !== undefined;
type Snapshot = { herdr: HerdrOwnedWorkspace[]; owners: Map<string, ResourceOwner>; proven: Set<string>; unresolved: Set<string>; scannedProjects: Set<string>; unavailableProjects: Set<string>; quarantined: Map<string, ResourceOwner> };
const key = (identity: ClaimIdentity): string => `${identity.projectId}/${identity.taskId}/${identity.claimId}`;
const taskKey = (identity: Pick<ClaimIdentity, "projectId" | "taskId">): string => `${identity.projectId}/${identity.taskId}`;
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
  const deps: ExecutionDependencies = { store: options.store, git: options.git, herdr: options.herdr, readTask: options.remote.readTask, platform: options.platform, workerId: options.workerId, serverOrigin: options.serverOrigin, buildPrompt: options.buildPrompt, ...(options.promptSource === undefined ? {} : { promptSource: options.promptSource }), ...(options.preparePromptSource === undefined ? {} : { preparePromptSource: options.preparePromptSource }), emit: options.emit, now,
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
  const execution = createExecutionDriver(deps);
  const cleanup = createCleanupDriver(deps);
  const normalSignal = options.signal === undefined ? new AbortController().signal : options.signal;
  const tails = new Map<string, Promise<void>>();
  const jobs = new Map<string, Promise<void>>();
  const monitoringJobs = new Map<string, string>();
  const monitoringActivities = new Map<string, string>();
  const monitoringFailures = new Map<string, string>();
  const monitoringFailurePhases = new Map<string, string>();
  const monitoringPhases = new Map<string, string>();
  const monitoringOperations = new Map<string, string>();
  const projectMonitoringFailures = new Map<string, string>();
  const resourceMonitoringFailures = new Map<string, string>();
  const quarantinedMonitoringFailures = new Map<string, { owner: ResourceOwner; operationId: string }>();
  const candidateMonitoringFailures = new Map<string, string>();
  const inventoryMonitoringFailures = new Map<string, string>();
  const nameMonitoringFailures = new Map<string, string>();
  const nameFailureThisJob = new Set<string>();
  const monitoringLimitRetries = new Set<string>();
  const recoveredLimitNames = new Map<string, Set<string>>();
  const pausedClaims = new Set<string>();
  const webMonitoringState = new Map<string, string>();
  const webRecoveryFailures = new Map<string, { id: string; reason: "native_identity_missing" | "recovery_limit" | "recovery_blocked" }>();
  const controllers = new Map<string, { controller: AbortController; terminal: boolean }>();
  const ending = new Map<string, CleanupTarget>(options.store.listCleanupSchedules().map(record => [key(record), record]));
  let capacityWarning = "";
  const cleanupRetries = new Map<string, { failures: number; nextAttemptAt: number; stage: string; lastError: string }>();
  const failures = new Map<string, number>();
  const inputWaiting = new Map<string, string>();
  const snapshotWarnings = new Map<string, Set<string>>();
  let unmappedWarnings = new Set<string>();
  let nextRepository = 0;
  let nextPlatformRepository = 0;
  let nextPendingProject = 0;
  let shuttingDown = false;
  let ticking = false;
  let cycleCoverage: "unknown" | "complete" | "partial" = "unknown";
  let reconciliationPhase: "reconciliation" | "inventory" | "project-preparation" | "resource-observation" | "claim-search" | "claim-request" = "reconciliation";
  let projectSearchFailure = false;
  let projectInventoryFailure = false;
  const schedulerFailures = new Map<string, string>();
  const recoverScheduler = (phase: string): void => {
    const operationId = schedulerFailures.get(phase);
    if (operationId !== undefined) { observe(m => m.recover(operationId)); schedulerFailures.delete(phase); }
  };
  let archiveJob: Promise<void> | null = null;
  let archiveCursor = "";
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
    observe(m => m.fail({ operationId: failureId, component: "execution", phase: phase.phase, scope: { kind: "claim", projectId: identity.projectId, taskId: identity.taskId, claimId: identity.claimId }, error, ...(observedFailure === undefined ? {} : { observedFailure }), ...(observedFailure?.running ? { retryState: "running" as const } : {}) }));
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
  try { options.webBackend?.setMonitoringObserver?.({ ...(deps.observePhase === undefined ? {} : { observePhase: deps.observePhase }), observeSelect: (identity, phase, operationKey) => { monitoringPhases.set(key(identity), phase.phase); monitoringOperations.set(key(identity), operationKey); }, observeSuccess: (identity, phase, operationKey) => {
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
  const promptUnavailable = new Set<string>();
  let activeCoverage: { covered: Set<string>; unavailable: Set<string> } | undefined;
  const invalidateProject = (projectId: string): void => {
    promptUnavailable.add(projectId);
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
    if (task.agentControlMode === "web") { const frozen = options.webStore?.getTask(task)?.configuration; if (frozen) return frozen; }
    const repository = configuration.repositories.find(repository => repository.project.projectId === task.projectId);
    if (repository === undefined && (configuration.targetProjectIds?.includes(task.projectId) || configuration.targetProjectIds === undefined && configuration.readyProjectIds !== undefined && selected(task.projectId))) return null;
    const current = repository?.configuration ?? configuration.globalConfiguration;
    if (current === null) return null;
    const frozen = options.store.getNativeConfiguration(task);
    if (frozen !== null) return { ...frozen, agentControlMode: task.agentControlMode ?? "herdr", recoveryLimit: current.recoveryLimit };
    return current.agent === task.agent ? { ...current, agentControlMode: task.agentControlMode ?? "herdr" } : { agent: task.agent, agentControlMode: task.agentControlMode ?? "herdr", model: null, args: [], recoveryLimit: current.recoveryLimit };
  };
  const canAdvance = (task: LocalTask): boolean => canAdvanceProject(task.projectId) && configurationFor(task) !== null;
  const updatePromptDemand = (): void => {
    options.onPromptDemand?.([...new Set(options.store.listUnfinishedTasks().filter(task => task.status === "active" && !promptUnavailable.has(task.projectId) && canAdvance(task)).map(task => task.projectId))]);
  };
  // Cleanup-only backend access stays inside its claim job and retry schedule.
  const needsHerdr = (): boolean => configuration.globalConfiguration?.agentControlMode !== undefined && configuration.globalConfiguration.agentControlMode !== "web" && options.store.listProjects().length > 0
    || configuration.repositories.some(repository => repository.configuration.agentControlMode !== "web")
    || options.store.listUnfinishedTasks().some(task => task.agentControlMode !== "web" && !ending.has(key(task)));
  const hasHerdrCleanup = (): boolean => [...ending.values()].some(owner => options.store.getTask(owner)?.agentControlMode !== "web" && options.webStore?.getTask(owner) == null);
  const hasDurableOwnership = (): boolean => options.hasHerdrJournal === true || options.store.listTasks().some(task => task.agentControlMode !== "web" && (task.status !== "done" || options.platform === "macos"));
  const lifecycle = () => needsHerdr() || hasHerdrCleanup() || hasDurableOwnership() ? options.herdr.lifecycle : undefined;
  const responsibilities = (): ResourceOwner[] => lifecycle()?.responsibilities() ?? [];
  const isStopped = (owner: ResourceOwner): boolean => lifecycle()?.isStopped(owner) === true;
  const pendingStops = () => needsHerdr() || hasHerdrCleanup() ? options.herdr.tasks.pendingStops() : [];

  const ensureHerdr = async (signal?: AbortSignal): Promise<void> => { if (needsHerdr()) await workerOperation(operation => options.herdr.ensureInstance(operation), signal); };
  const listHerdr = async (signal?: AbortSignal): Promise<HerdrOwnedWorkspace[]> => needsHerdr() ? workerOperation(operation => options.herdr.tasks.listResources(operation), signal) : [];
  const snapshot = async (signal: AbortSignal, coveredProjects: ReadonlySet<string>, currentClaims: readonly ResourceOwner[] = [], unavailable: ReadonlySet<string> = new Set()): Promise<Snapshot> => {
    const observed = await listHerdr(signal);
    const herdr = observed;
    const owners = new Map<string, ResourceOwner>();
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
    const nativeOwners = responsibilities();
    for (const owner of nativeOwners) {
      recordOwner(owner); proven.add(key(owner));
    }
    for (const workspace of herdr) { recordOwner(workspace.owner); proven.add(key(workspace.owner)); }
    for (const task of options.webStore?.listUnfinishedTasks() ?? []) { recordOwner(task); proven.add(key(task)); }
    const independentOwners = [...currentClaims, ...nativeOwners, ...herdr.map(item => item.owner), ...(options.webStore?.listUnfinishedTasks() ?? []), ...options.store.listCleanupSchedules()];
    const provenQuarantine = async (owner: ResourceOwner, scannedProject: WorkerProject): Promise<boolean> => {
      const matches = independentOwners.filter(other => key(other) === key(owner));
      const mapping = options.store.getProject(owner);
      if (mapping === null || matches.length === 0 || matches.some(other => other.worktreeId !== owner.worktreeId)) return false;
      // A matching claim cannot bound a registration moved into another repo.
      // The project mapping and original execution bindings must agree with
      // the physical repository that supplied this scan, including aliases.
      const root = await realpath(scannedProject.localPath);
      const remote = repositoryIdentity(scannedProject.repoUrl);
      if (await realpath(mapping.localPath) !== root || repositoryIdentity(mapping.repoUrl) !== remote) return false;
      const native = lifecycle();
      let nativePaths: string[];
      if (native?.worktreePath !== undefined) {
        const original = native.worktreePath(owner);
        nativePaths = original === null ? [] : [original];
      } else {
        // Older adapters expose the original path through retained resources.
        const records = native?.archive?.resources().filter(record => key(record.owner) === key(owner)) ?? [];
        if (records.some(record => record.owner.worktreeId !== owner.worktreeId)) return false;
        nativePaths = records.map(record => record.worktreePath);
      }
      for (const nativePath of nativePaths) {
        if (!path.isAbsolute(nativePath)) return false;
        const original = await resolvePhysicalDirectory(nativePath);
        const expected = await resolvePhysicalDirectory(path.join(root, ".worktrees", "daynight", owner.taskId));
        if (path.join(original.ancestorPath, ...original.missingComponents) !== path.join(expected.ancestorPath, ...expected.missingComponents)) return false;
      }
      const web = options.webStore?.getTask(owner);
      if (web != null) {
        if (web.worktreeId !== owner.worktreeId || await realpath(web.repositoryPath) !== root || repositoryIdentity(web.repoUrl) !== remote) return false;
        if (web.resources.worktree !== null && await realpath(web.resources.worktree.repositoryPath) !== root) return false;
      }
      return true;
    };
    for (const project of options.store.listProjects()) {
      const warnings = new Map<string, string>();
      currentWarnings.set(project.projectId, warnings);
      const warn = (category: string, owner: ResourceOwner, message: string): void => {
        warnings.set(JSON.stringify([category, owner.projectId, owner.taskId, owner.claimId, owner.worktreeId]), message);
      };
      let worktrees: Awaited<ReturnType<WorkerGitManager["listWorktrees"]>>;
      const target = configuration.targetProjectIds === undefined
        ? configuration.repositories.some(repository => repository.project.projectId === project.projectId)
        : configuration.targetProjectIds.includes(project.projectId);
      try {
        const scan = await workerOperation(operation => options.git.scanWorktrees(project, operation, unavailable.has(project.projectId) || !target, true), signal);
        if (!scan.enumerationComplete || scan.unknown.length > 0) throw scan.unknown[0]?.error ?? new Error("Git resource enumeration is incomplete.");
        for (const item of scan.quarantined) {
          if (!await provenQuarantine(item.owner, project)) throw new Error("The quarantined worktree has no unambiguous independent ownership proof.", { cause: item.error });
        }
        for (const item of scan.quarantined) {
          const identity = key(item.owner);
          recordOwner(item.owner); proven.add(identity); quarantined.set(identity, item.owner); unresolved.add(identity);
          const failure = quarantinedMonitoringFailures.get(identity) ?? { owner: item.owner, operationId: randomUUID() };
          quarantinedMonitoringFailures.set(identity, failure);
          const error = item.error instanceof WorktreePreconditionError ? item.error : new WorktreePreconditionError("validation_failed", "The original worktree failed validation and remains reserved.", { cause: item.error });
          observe(m => m.fail({ operationId: failure.operationId, component: "resources", phase: "resource-observation", scope: { kind: "claim", projectId: item.owner.projectId, taskId: item.owner.taskId, claimId: item.owner.claimId }, error }));
          warn("quarantined", item.owner, `Quarantined worktree ${identity} retains capacity and blocks its task; unrelated tasks may use remaining capacity.`);
          if (!snapshotWarnings.get(project.projectId)?.has(JSON.stringify(["quarantined", item.owner.projectId, item.owner.taskId, item.owner.claimId, item.owner.worktreeId]))) options.emit({ kind: "resource-quarantined", message: `Worktree ${identity} failed validation; its original resources are retained.`, error: item.error });
        }
        worktrees = scan.validated;
      }
      catch (error) {
        if (isWorkerCancellation(error, signal ?? normalSignal)) throw error;
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
      for (const worktree of worktrees) {
        recordOwner(worktree.owner);
        if (!proven.has(key(worktree.owner))) {
          if (!coveredProjects.has(worktree.owner.projectId)) unresolved.add(key(worktree.owner));
          else warn("unproven-ownership", worktree.owner, `Preserved unproven Git ownership for ${key(worktree.owner)}; a static marker does not identify this worker.`);
        }
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
    return { herdr, owners, proven, unresolved, scannedProjects, unavailableProjects, quarantined };
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
    const result = new Map<string, Task>();
    for (const task of observation.tasks) {
      if (invalidated(task.projectId)) continue;
      const owner = remoteOwner(task);
      observe(m => {
        const identity = key(owner), paused = readTaskPaused(task.properties) === true;
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
  const publishSummary = async (task: LocalTask, result: ExecutionAdvance, remoteTask: Task, signal: AbortSignal): Promise<void> => {
    const worker = readWorkerClaim(remoteTask.properties)!;
    const observed = result.observation;
    const herdr = observed === null ? worker.herdr : { session: observed.binding.session, workspaceId: observed.binding.workspaceId, paneId: observed.binding.paneId };
    const phase = result.kind === "waiting_input" || observed?.status === "blocked" ? "waiting" as const : "executing" as const;
    const nativeSessionId = observed?.nativeSession?.sessionId ?? task.sessionId ?? worker.nativeSessionId;
    if (worker.phase === phase && worker.nativeSessionId === nativeSessionId && isDeepStrictEqual(worker.herdr, herdr)) return;
    try { await options.remote.update(remoteTask, { phase, herdr, nativeSessionId }, signal); }
    catch (error) { if (!isWorkerCancellation(error, signal)) options.emit({ kind: "summary-error", task, message: "The observed execution summary was not confirmed; the next round will read it again.", error }); }
  };
  const startJob = (identity: ClaimIdentity, action: (signal: AbortSignal) => Promise<void>, terminal: boolean): void => {
    const identityKey = key(identity);
    if (shuttingDown || jobs.has(identityKey) || !terminal && !canAdvanceProject(identity.projectId)) return;
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
    controllers.set(identityKey, { controller, terminal });
    const signal = AbortSignal.any([normalSignal, controller.signal]);
    const job = serialize(identity, () => {
      if (!terminal && !canAdvanceProject(identity.projectId)) return Promise.resolve();
      if (operationId !== undefined && (terminal || !pausedClaims.has(identityKey))) observe(m => {
        m.updateActivity(operationId!, { status: "running", waitReason: null, nextAttemptAt: null });
        const failure = terminal ? monitoringFailures.get(`true/${identityKey}/observation`) : undefined;
        if (failure !== undefined) m.updateFailureRetry(failure, "running");
      });
      return action(signal).then(() => {
        if (terminal) for (const [failureKey, failure] of monitoringFailures) if (failureKey.startsWith(`true/${identityKey}/`)) { observe(m => m.recover(failure)); monitoringFailures.delete(failureKey); }
      });
    }).then(() => { inputWaiting.delete(identityKey); }).catch((error: unknown) => {
      if (isWorkerCancellation(error, signal)) return;
      if (!terminal && error instanceof HerdrInputWaitingError) {
        if (operationId !== undefined) observe(m => m.updateActivity(operationId!, pausedClaims.has(identityKey) ? { phase: "paused", status: "paused", waitReason: "task-paused" } : { phase: "waiting", status: "waiting", waitReason: "native-input" }));
        if (inputWaiting.get(identityKey) !== error.message) {
          inputWaiting.set(identityKey, error.message);
          const task = options.store.getTask(identity);
          options.emit({ kind: "waiting", ...(task === null ? {} : { task }), message: error.message });
        }
        return;
      }
      inputWaiting.delete(identityKey);
      let cleanupMessage: string | undefined;
      let reportedError = error;
      let task: LocalTask | null = null;
      if (terminal) {
        const owner = ending.get(identityKey)!;
        let count = cleanupRetries.get(identityKey)?.failures ?? 0;
        let previous: ReturnType<WorkerStore["getCleanupSchedule"]> = null;
        try { previous = options.store.getCleanupSchedule(owner); count = Math.max(count, previous?.failures ?? 0); }
        catch (storageError) { reportedError = new AggregateError([error, storageError], "Cleanup failed and its retry state could not be read."); }
        count = Math.min(count + 1, Number.MAX_SAFE_INTEGER);
        const retryMs = Math.min(60_000, 1000 * 2 ** Math.min(count - 1, 6));
        const stage = error instanceof WorkerCleanupError ? error.stage : "observation";
        const nextAttemptAt = now() + retryMs;
        if (operationId !== undefined) {
          const failureKey = `true/${identityKey}/${stage}`, failureId = monitoringFailures.get(failureKey) ?? randomUUID();
          monitoringFailures.set(failureKey, failureId);
          observe(m => m.fail({ operationId: failureId, component: "cleanup", phase: stage, scope, error, retryState: "scheduled", nextAttemptAt: new Date(nextAttemptAt).toISOString() }));
          for (const [key, pending] of monitoringFailures) if (key.startsWith(`true/${identityKey}/`) && key !== failureKey) observe(m => m.updateFailureRetry(pending, "scheduled", new Date(nextAttemptAt).toISOString()));
          observe(m => m.updateActivity(operationId!, { phase: stage as "observation" | "agent-stop" | "backend-close" | "archive" | "worktree-removal", status: "waiting", waitReason: "retry-backoff", nextAttemptAt: new Date(nextAttemptAt).toISOString() }));
        }
        // Storage failures must not reject the job or prevent shutdown from proving stop.
        const lastError = error instanceof Error ? error.message || error.name : String(error) || "Unknown cleanup error";
        cleanupRetries.set(identityKey, { failures: count, nextAttemptAt, stage, lastError });
        try {
          if (previous === null && hasWorktreeIdentity(owner)) previous = ensureCleanupSchedule(options.store, owner, now());
          if (previous !== null) options.store.saveCleanupSchedule(previous, { ...previous, failures: count, nextAttemptAt, stage, lastError });
          task = options.store.getTask(identity);
        } catch (storageError) { reportedError = new AggregateError([reportedError, storageError], "Cleanup failed; retry persistence is unconfirmed and in-process backoff remains active."); }
        const stopStatus = stage === "archive" || stage === "worktree-removal" || stage === "backend-close" ? "Agent stop confirmed; " : "";
        cleanupMessage = `Cleanup ${key(owner)} failed at ${stage}; ${stopStatus}next retry ${new Date(nextAttemptAt).toISOString()} (${retryMs} ms). Resources retain capacity; correct the reported cause and normal reconciliation retries automatically.`;
      } else {
        task = options.store.getTask(identity);
        if (task?.agentControlMode !== "web") failures.set(identityKey, (failures.get(identityKey) ?? 0) + 1);
        if (operationId !== undefined && !signal.aborted && !nameFailureThisJob.has(identityKey) && monitoringOperations.get(identityKey) !== "grant-identity-lost" && !(error instanceof WebRecoveryBlockedError && webRecoveryFailures.has(identityKey))) {
          const phase = monitoringPhases.get(identityKey) ?? "observation";
          const failureKey = `false/${identityKey}/${monitoringOperations.get(identityKey) ?? phase}`, failureId = monitoringFailures.get(failureKey) ?? randomUUID();
          monitoringFailures.set(failureKey, failureId);
          observe(m => m.fail({ operationId: failureId, component: "execution", phase, scope, error }));
        }
      }
      options.emit({ kind: terminal ? "cleanup-error" : "execution-error", ...(task === null ? {} : { task }), message: terminal ? cleanupMessage! : task?.agentControlMode === "web" ? "The task operation failed; native recovery accounting remains independent of orchestration retries." : "The task operation failed; this process retains its recovery count.", error: reportedError });
    }).finally(() => {
      if (!terminal && monitoringLimitRetries.delete(identityKey)) { const failure = monitoringFailures.get(`limit/${identityKey}`); if (failure !== undefined) observe(m => m.updateFailureRetry(failure, "none")); }
      monitoringJobs.delete(identityKey); if (jobs.get(identityKey) === job) { jobs.delete(identityKey); controllers.delete(identityKey); }
    });
    jobs.set(identityKey, job);
  };
  const recordMissingClaim = (owner: ResourceOwner, pane: HerdrOwnedWorkspace["panes"][number] | undefined): LocalTask | null => {
    const task = options.store.getTask(owner);
    if (task !== null) return task;
    if (pane === undefined && !pendingStops().some((stop) => sameClaim(stop.context, owner))) return null;
    const agent = pane?.kind ?? pane?.nativeSession?.agent;
    if (agent === undefined) throw new Error(`Cannot preserve ownership of ${key(owner)} without an observed native agent type; retain its Herdr resources and private instance.`);
    // Persist ownership before a stop can close the only workspace proving it.
    return options.store.registerPending({ ...owner, agent, sessionId: pane !== undefined && liveAgent(pane) && pane.nativeSession !== null ? pane.nativeSession.sessionId : null });
  };
  const runCleanup = async (owner: CleanupTarget, deleteWorktree: boolean, signal?: AbortSignal): Promise<void> => {
    if (!hasWorktreeIdentity(owner)) {
      const local = options.store.getTask(owner);
      if (local === null) throw new Error("The original claim identity is missing before reservation cleanup.");
      const web = options.webStore?.getTask(owner);
      if (web != null) { ending.set(key(owner), web); return runCleanup(web, deleteWorktree, signal); }
      if (local.agentControlMode === "web") {
        if (!options.verifyWebUnregistered || local.sessionId !== null) throw new Error("The ended Web claim has no original resource evidence; its ownership record is retained.");
        await options.verifyWebUnregistered(local, signal ?? new AbortController().signal, CLEANUP_OPERATION_MS);
      } else {
        const durable = lifecycle();
        if (durable !== undefined) {
          const actual = durable.responsibilities().find(record => sameClaim(record, owner));
          if (actual !== undefined) { ending.set(key(owner), actual); return runCleanup(actual, deleteWorktree, signal); }
          options.emit({ kind: "stop-unknown", task: local, message: "The ended Herdr claim has no durable run evidence; its ownership record and resources are retained." });
          throw new WorkerCleanupError("agent-stop", new Error("The ended Herdr claim has no durable run evidence."));
        }
        await cleanupOperation(operation => options.herdr.ensureInstance(operation), signal);
        const observed = await cleanupOperation(operation => options.herdr.tasks.listResources(operation), signal);
        const matches = observed.filter(resource => sameClaim(resource.owner, owner));
        if (matches.length > 1) throw new Error("The claim has conflicting Herdr resources before reservation cleanup.");
        const actual = matches[0]?.owner ?? pendingStops().find(stop => sameClaim(stop.context, owner))?.context;
        if (actual !== undefined) { ending.set(key(owner), actual); return runCleanup(actual, deleteWorktree, signal); }
      }
      if (deleteWorktree) {
        const worktrees = await cleanupOperation(operation => options.git.listWorktrees(projectFor(owner), operation), signal);
        const sameTask = worktrees.filter(resource => resource.owner.taskId === owner.taskId);
        if (sameTask.length > 1) throw new Error("The task has conflicting Git resources before reservation cleanup.");
        const actual = sameTask[0]?.owner;
        if (actual !== undefined && sameClaim(actual, owner)) { ending.set(key(owner), actual); return runCleanup(actual, true, signal); }
        if (actual !== undefined) { options.store.completeTask(owner); return; }
        try { await cleanupOperation(operation => options.git.removeEmptyReservation(projectFor(owner), owner.taskId, operation), signal); }
        catch (error) { throw new WorkerCleanupError("worktree-removal", error); }
        options.store.completeTask(owner);
      }
      return;
    }
    const schedule = deleteWorktree ? ensureCleanupSchedule(options.store, owner, now()) : null;
    const local = options.store.getTask(owner);
    const webRecord = options.webStore?.getTask(owner);
    if (webRecord != null && webRecord.worktreeId !== owner.worktreeId) throw new Error("The Web cleanup claim has conflicting worktree identities.");
    if (local?.agentControlMode === "web" || webRecord != null) {
      if (!options.webBackend || !options.webStore) throw new Error("The Web execution backend is unavailable.");
      if (webRecord == null) {
        // Registration precedes every native launch. Missing local evidence alone proves nothing.
        if (local?.sessionId !== null && local?.sessionId !== undefined) throw new Error("The original native identity has no local Web stop evidence.");
        if (!options.verifyWebUnregistered) throw new Error("Web launch provenance cannot be verified.");
        await options.verifyWebUnregistered(owner, signal ?? new AbortController().signal, CLEANUP_OPERATION_MS);
        if (deleteWorktree) { await cleanupOperation(operation => options.git.removeWorktree(projectFor(owner), owner, operation), signal); if (local) options.store.completeTask(owner); }
        return;
      }
      while (true) {
        const result = await options.webBackend.cleanup(webRecord, deleteWorktree ? "terminal" : "shutdown", schedule?.deadline ?? now() + 600_000, signal);
        if (result.complete) {
          if (deleteWorktree) { if (result.task.status !== "done") options.webStore.completeTask(owner, now()); if (local) options.store.completeTask(owner); }
          return;
        }
        await delay(1000, undefined, signal === undefined ? {} : { signal });
      }
    }
    if (lifecycle() !== undefined) {
      await cleanup.advance({ owner, project: projectFor(owner), ...(local === null ? {} : { task: local }) }, deleteWorktree, signal);
      if (deleteWorktree && local !== null && local.status !== "done") options.store.completeTask(owner);
      return;
    }
    await cleanupOperation(operation => options.herdr.ensureInstance(operation), signal);
    const resources = await cleanupOperation(operation => options.herdr.tasks.listResources(operation), signal);
    const task = recordMissingClaim(owner, actualTaskPane(owner, resources));
    await cleanup.advance({ owner, project: projectFor(owner), ...(task === null ? {} : { task }) }, deleteWorktree, signal);
    if (deleteWorktree && task !== null && task.status !== "done") options.store.completeTask(owner);
  };

  const launchCleanups = (): void => {
    for (const [identityKey, owner] of ending) {
      // A stopped archive owns its separate persisted retry schedule. Native
      // cleanup must not consume or erase that schedule after a runner restart.
      if (hasWorktreeIdentity(owner) && lifecycle()?.archive && isStopped(owner)) continue;
      if (jobs.has(identityKey)) continue;
      if (now() < (cleanupRetries.get(identityKey)?.nextAttemptAt ?? 0)) continue;
      // Creation and ownership validation run inside the isolated job's error boundary.
      let nextAttemptAt = 0;
      try { nextAttemptAt = options.store.getCleanupSchedule(owner)?.nextAttemptAt ?? 0; }
      catch { /* The job records the storage failure without stopping other claims. */ }
      if (now() < nextAttemptAt) continue;
      startJob(owner, async (signal) => {
        await runCleanup(owner, true, signal);
        options.store.deleteCleanupSchedule(owner);
        ending.delete(identityKey);
        cleanupRetries.delete(identityKey);
        const activity = monitoringActivities.get(`true/${identityKey}`);
        if (activity !== undefined) { observe(m => m.endActivity(activity)); monitoringActivities.delete(`true/${identityKey}`); }
      }, true);
    }
  };
  const syncWorkspaceName = async (task: LocalTask, owner: ResourceOwner, title: string, signal: AbortSignal): Promise<void> => {
    const identity = key(task);
    const failName = (boundary: "admission" | "discovery" | "rename", error: unknown): void => {
      if (isWorkerCancellation(error, signal)) return;
      const failureKey = `${identity}/${boundary}`, operationId = nameMonitoringFailures.get(failureKey) ?? randomUUID();
      nameMonitoringFailures.set(failureKey, operationId); nameFailureThisJob.add(identity);
      observe(m => m.fail({ operationId, component: "execution", phase: "observation", scope: { kind: "claim", projectId: task.projectId, taskId: task.taskId, claimId: task.claimId }, error }));
    };
    const recoverName = (boundary: "admission" | "discovery" | "rename"): void => {
      const failureKey = `${identity}/${boundary}`, previous = nameMonitoringFailures.get(failureKey);
      if (previous !== undefined) {
        observe(m => m.recover(previous)); nameMonitoringFailures.delete(failureKey);
        if (monitoringFailures.has(`limit/${identity}`) && !monitoringLimitRetries.has(identity)) {
          const boundaries = recoveredLimitNames.get(identity) ?? new Set<string>(); boundaries.add(boundary); recoveredLimitNames.set(identity, boundaries);
        }
      }
      if (previous !== undefined || recoveredLimitNames.get(identity)?.has(boundary)) recoverLimitIfReady(identity);
    };
    let pending: ReturnType<typeof pendingStops>;
    try {
      pending = pendingStops().filter((stop) => sameClaim(stop.context, owner));
      if (pending.some((stop) => stop.context.worktreeId !== owner.worktreeId)) throw new Error("The claim has conflicting pending Herdr stop identities.");
      recoverName("admission");
    } catch (error) { failName("admission", error); throw error; }
    if (pending.length > 0) return;
    let workspaceId: string | null = null;
    try {
      const resources = await workerOperation((operation) => options.herdr.tasks.listResources(operation), signal);
      const pane = actualTaskPane(owner, resources);
      recoverName("discovery");
      if (pane === undefined) return;
      workspaceId = pane.binding.workspaceId;
      await workerOperation((operation) => options.herdr.tasks.syncWorkspaceName(
        executionContext({ task, owner, project: projectFor(task) }), pane.binding, title, operation,
      ), signal);
      recoverName("rename");
    } catch (error) {
      if (isWorkerCancellation(error, signal)) throw error;
      failName(workspaceId === null ? "discovery" : "rename", error);
      const snapshotFailure = (error instanceof HerdrRpcError && error.method === "session.snapshot")
        || (error instanceof OperationError && error.kind === "deadline");
      if (!snapshotFailure && (!(error instanceof HerdrAgentActionError) || error.action !== "workspace.rename")) throw error;
      const subject = workspaceId === null ? `workspace discovery for worktree ${owner.worktreeId}` : `workspace ${workspaceId}, worktree ${owner.worktreeId}`;
      options.emit({ kind: "workspace-name-error", task, message: `Could not confirm workspace.rename for ${subject}; the next inventory will observe its name again.`, error });
    }
  };
  const finishShutdown = async (record: NonNullable<ReturnType<WebExecutionStore["getTask"]>>, signal: AbortSignal) => {
    if (!options.webBackend || !options.webStore || record.cleanup?.kind !== "shutdown") throw new Error("Only an original shutdown may resume ordinary Web execution.");
    const stopped = await options.webBackend.cleanup(record, "shutdown", now(), signal, true);
    if (!stopped.complete) throw new Error("The original Web resources remain before restart.");
    return options.webStore.clearShutdown(stopped.task, now());
  };
  const ensure = async (task: LocalTask, remoteTask: Task, signal: AbortSignal, execute = true): Promise<WorkerInputWait | undefined> => {
    if (ending.has(key(task))) return;
    const owner = remoteOwner(remoteTask);
    if (!sameClaim(task, owner) || readWorkerClaim(remoteTask.properties)!.workerId !== options.workerId || readWorkerClaim(remoteTask.properties)!.agent !== task.agent || readWorkerClaim(remoteTask.properties)!.agentControlMode !== (task.agentControlMode ?? "herdr")) throw new Error("The local execution does not match the observed original worker claim.");
    if (task.agentControlMode === "web") {
      if (!options.webStore || !options.webBackend) throw new Error("The Web execution backend is unavailable.");
      const configuration = configurationFor(task);
      if (configuration === null) return;
      const worker = readWorkerClaim(remoteTask.properties)!;
      let record = options.webStore.getTask(task);
      if (record !== null && (record.worktreeId !== owner.worktreeId || record.workerId !== options.workerId || record.userId !== worker.userId || record.serverOrigin !== options.serverOrigin)) throw new Error("The durable Web execution does not match the observed original worker claim.");
      let observed = false;
      let advancing = false;
      let waitingInput: WorkerInputWait | undefined;
      try {
        if (record === null || record.recovery.pauseReason === null || record.recovery.retryAuthorized || legacyBranchLatch(record)) {
          requireImplementedWorkerBackend(configuration);
          await options.verifyWebServer?.(configuration.agent, signal);
          if (record === null) {
            if (!options.verifyWebUnregistered) throw new Error("Web launch provenance cannot be verified.");
            await options.verifyWebUnregistered(task, signal);
            if (task.sessionId !== null || worker.nativeSessionId !== null) throw new Error("The original native identity has no local Web execution evidence.");
          }
          record = options.webStore.register({ ...owner, project: projectFor(task), serverOrigin: options.serverOrigin, workerId: options.workerId, userId: worker.userId, configuration }, now());
          if (record.cleanup !== null) record = await finishShutdown(record, signal);
          advancing = true;
          if (options.webBackend.advanceResult) {
            const result = await options.webBackend.advanceResult(record, signal);
            record = result.task;
            if (result.kind === "waiting_input") waitingInput = { kind: "waiting_input", reason: result.reason };
          } else record = await options.webBackend.advance(record, signal);
          observed = true;
        }
      } catch (error) {
        if (isWorkerCancellation(error, signal)) throw error;
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
        if (!signal.aborted && (observed || !execute || record !== null)) {
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
              observe(m => m.fail({ operationId: id, component: "execution", phase: "paused", scope: { kind: "claim", projectId: task.projectId, taskId: task.taskId, claimId: task.claimId }, error: new MonitoringRecoveryEvidence(recoveryReason), retryState: "manual" }));
            } else if (recovery !== undefined && recoveryReason === null && observed && !paused && waitingInput === undefined && !record?.recovery.retryAuthorized && record?.webExecution?.activity !== "initializing") {
              observe(m => m.recover(recovery.id)); webRecoveryFailures.delete(recoveryKey);
            }
            const failureKey = `false/${key(task)}/observation`;
            const previous = monitoringFailures.get(failureKey);
            if (observed && !paused && waitingInput === undefined && !record?.recovery.retryAuthorized && record?.webExecution?.activity !== "initializing" && previous !== undefined) {
              observe(m => m.recover(previous)); monitoringFailures.delete(failureKey);
            }
          }
          let startupReport: SessionStartupReport | undefined;
          try {
            // Observation and transport must never become another native recovery attempt.
            const report = record === null ? null : options.webBackend.observeStartupReport?.(record) ?? null;
            const changedReport = report !== null && !sameStartupReport(readSessionStartupReport(remoteTask.properties), report);
            startupReport = changedReport && await options.verifyWebStartupReporting?.(signal) ? report : undefined;
          } catch (error) { if (!isWorkerCancellation(error, signal)) options.emit({ kind: "summary-error", task, message: "The startup report could not be prepared; ordinary execution summary reconciliation remains available.", error }); }
          try {
            if (worker.phase !== phase || worker.nativeSessionId !== nativeSessionId || worker.herdr !== null || startupReport !== undefined) {
              await options.remote.update(remoteTask, { phase, nativeSessionId, herdr: null, ...(startupReport === undefined ? {} : { startupReport }) }, signal);
            }
          } catch (error) { if (!isWorkerCancellation(error, signal)) options.emit({ kind: "summary-error", task, message: "The Web execution summary was not confirmed; the next round will read it again.", error }); }
        }
      }
      return waitingInput;
    }
    await syncWorkspaceName(task, owner, remoteTask.title, signal);
    nameFailureThisJob.delete(key(task));
    if (!execute) return;
    const currentConfiguration = configurationFor(task);
    if (currentConfiguration === null) return;
    if (task.sessionId === null) options.store.freezeNativeConfiguration(task, currentConfiguration);
    const input: ExecutionInput = { task, project: projectFor(task), owner, title: remoteTask.title, configuration: currentConfiguration };
    const observed = await execution.advance(input, signal);
    const latest = options.store.getTask(task)!;
    await publishSummary(latest, observed, remoteTask, signal);
    return observed.kind === "waiting_input" ? { kind: "waiting_input", reason: observed.reason } : undefined;
  };
  const reservations = (resources: Snapshot) => {
    const stopped = new Set(responsibilities().filter(isStopped).map(key));
    const live = new Set([...resources.herdr.map(resource => key(resource.owner)), ...pendingStops().map(stop => key(stop.context)), ...ending.keys(), ...controllers.keys()]);
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
    for (const stop of pendingStops()) add(key(stop.context), "pending-stop");
    return [...roles].filter(([identity]) => {
      if (resources.quarantined.has(identity)) return true;
      if (stopped.has(identity) && controllers.get(identity)?.terminal !== false) return false;
      if (resources.owners.has(identity) && !resources.proven.has(identity)) return true;
      const owner = resources.owners.get(identity) ?? options.store.listTasks().find(task => key(task) === identity);
      return owner === undefined || canAdvanceProject(owner.projectId) || !stoppedProjects.has(owner.projectId) || live.has(identity);
    }).map(([identity, roleSet]) => ({ identity, roles: [...roleSet] }));
  };
  let latestReservations: ReturnType<typeof reservations> = [];
  const capacity = (resources: Snapshot): number => {
    latestReservations = reservations(resources);
    return latestReservations.length;
  };
  const blockedByOldClaim = (task: LocalTask, owners: Iterable<ResourceOwner>): boolean =>
    options.store.listUnfinishedTasks().some((other) => other.projectId === task.projectId && other.taskId === task.taskId && other.claimId !== task.claimId && other.status === "active")
    || [...owners, ...ending.values(), ...pendingStops().map((stop) => stop.context)].some((owner) => owner.projectId === task.projectId && owner.taskId === task.taskId && owner.claimId !== task.claimId);
  const schedule = (task: LocalTask, remoteTask: Task): void => {
    if (!canAdvance(task) || jobs.has(key(task)) || ending.has(key(task))) return;
    updatePromptDemand();
    const count = failures.get(key(task)) ?? 0;
    startJob(task, signal => {
      if (!canAdvance(task)) return Promise.resolve();
      const current = configurationFor(task);
      if (current === null) return Promise.resolve();
      const exhausted = task.agentControlMode !== "web" && count > current.recoveryLimit;
      observe(m => {
        const identity = key(task), activity = monitoringActivities.get(`false/${identity}`), limitKey = `limit/${identity}`;
        if (exhausted) {
          monitoringLimitRetries.delete(identity);
          if (!monitoringFailures.has(limitKey)) {
            const operationId = randomUUID(); monitoringFailures.set(limitKey, operationId);
            m.fail({ operationId, component: "execution", phase: "paused", scope: { kind: "claim", projectId: task.projectId, taskId: task.taskId, claimId: task.claimId }, error: new MonitoringRecoveryEvidence("recovery_limit"), retryState: "manual" });
          }
          if (activity !== undefined) m.updateActivity(activity, pausedClaims.has(identity) ? { phase: "paused", status: "paused", waitReason: "task-paused" } : { phase: "paused", status: "paused", waitReason: "recovery-blocked" });
        } else {
          const failure = monitoringFailures.get(limitKey);
          if (failure !== undefined) { monitoringLimitRetries.add(identity); m.updateFailureRetry(failure, "running"); }
        }
      });
      return ensure(task, remoteTask, signal, !exhausted).then(() => undefined);
    }, false);
  };
  // Stop the original execution without terminal cleanup, releasing neither claim nor worktree.
  const stopOwner = async (owner: ResourceOwner, signal?: AbortSignal): Promise<void> => {
    const webRecord = options.webStore?.getTask(owner);
    if (webRecord != null) {
      if (webRecord.worktreeId !== owner.worktreeId) throw new Error("The Web stop claim has conflicting worktree identities.");
      if (!options.webBackend) throw new Error("The Web execution backend is unavailable.");
      const stopped = await options.webBackend.cleanup(webRecord, "shutdown", now(), signal, true);
      if (!stopped.complete) throw new Error("The original Web resources remain during stop.");
      return;
    }
    if (options.store.getTask(owner)?.agentControlMode === "web") throw new Error("The original Web execution evidence is missing.");
    const durable = lifecycle();
    if (durable !== undefined) {
      if (!durable.isStopped(owner)) await cleanupOperation(operation => durable.stop(owner, "shutdown", operation), signal);
      if (!durable.isStopped(owner)) throw new Error("The original Herdr run stop is not confirmed.");
      return;
    }
    if (options.store.getTask(owner) === null) {
      const observed = await cleanupOperation(operation => options.herdr.tasks.listResources(operation), signal);
      recordMissingClaim(owner, actualTaskPane(owner, observed));
    }
    await settleWorkerStops(deps, owner, signal, cleanupOperation);
    const resources = await cleanupOperation(operation => options.herdr.tasks.listResources(operation), signal);
    const pane = actualTaskPane(owner, resources);
    if (pane !== undefined) {
      const context = { ...owner, cwd: path.join(projectFor(owner).localPath, ".worktrees", "daynight", owner.taskId) };
      await cleanupOperation(operation => options.herdr.tasks.stopAndClose(context, pane.binding, operation), signal);
    }
    await settleWorkerStops(deps, owner, signal, cleanupOperation);
    if (actualTaskPane(owner, await cleanupOperation(operation => options.herdr.tasks.listResources(operation), signal)) !== undefined) throw new Error("The original Herdr pane remains after stop.");
  };
  const stopProject = (projectId: string, signal?: AbortSignal): Promise<void> => {
    const existing = projectStops.get(projectId);
    if (existing !== undefined) return existing;
    stoppedProjects.delete(projectId);
    for (const [identity, running] of controllers) {
      if (identity.startsWith(`${projectId}/`) && !running.terminal) running.controller.abort(new Error("The project was excluded from worker execution."));
    }
    for (const [identity, activity] of monitoringActivities) if (identity.startsWith(`false/${projectId}/`)) observe(m => m.updateActivity(activity, { phase: "waiting", status: "waiting", waitReason: "resource-stop" }));
    const operationSignal = signal === undefined ? normalSignal : AbortSignal.any([normalSignal, signal]);
    const operation = (async () => {
      const endStoppedActivity = (owner: ClaimIdentity): void => {
        const identity = `false/${key(owner)}`, activity = monitoringActivities.get(identity);
        if (activity !== undefined) { observe(m => m.endActivity(activity)); monitoringActivities.delete(identity); }
      };
      const stopObserved = async (owner: ResourceOwner): Promise<void> => {
        await stopOwner(owner, operationSignal);
        endStoppedActivity(owner);
      };
      await Promise.all([...jobs].filter(([identity]) => identity.startsWith(`${projectId}/`)).map(([, job]) => job));
      operationSignal.throwIfAborted();
      const local = options.store.listUnfinishedTasks().filter(task => task.projectId === projectId);
      const webMissing = local.filter(task => task.agentControlMode === "web" && options.webStore?.getTask(task) == null);
      const missingResults = await Promise.allSettled(webMissing.map(async task => {
        if (task.status !== "pending" || task.sessionId !== null || !options.verifyWebUnregistered) throw new Error("The original Web execution evidence is missing; stop is unconfirmed.");
        await options.verifyWebUnregistered(task, operationSignal, CLEANUP_OPERATION_MS);
      }));
      const webOwners = (options.webStore?.listUnfinishedTasks() ?? []).filter(owner => owner.projectId === projectId);
      const webResults = await Promise.allSettled(webOwners.map(owner => serialize(owner, () => stopObserved(owner))));
      const failures = [...missingResults, ...webResults].flatMap(result => result.status === "rejected" ? [result.reason] : []);
      await ensureHerdr(operationSignal);
      const workspaces = await listHerdr(operationSignal);
      const durable = lifecycle();
      const owned = [...responsibilities(), ...workspaces.map(workspace => workspace.owner), ...pendingStops().map(stop => stop.context), ...webOwners].filter(owner => owner.projectId === projectId);
      if (durable !== undefined) for (const task of local) {
        if (task.agentControlMode !== "web" && task.status === "active" && !owned.some(owner => sameClaim(owner, task))) failures.push(new Error("The original Herdr execution evidence is missing; stop is unconfirmed."));
      }
      const owners = new Map<string, ResourceOwner>();
      const conflicting = new Set<string>();
      for (const owner of owned) {
        const previous = owners.get(key(owner));
        if (previous !== undefined && previous.worktreeId !== owner.worktreeId) {
          conflicting.add(key(owner));
          failures.push(new Error("The original claim has conflicting stop identities."));
          continue;
        }
        owners.set(key(owner), owner);
      }
      const webKeys = new Set(webOwners.map(key));
      const results = await Promise.allSettled([...owners.values()].filter(owner => !webKeys.has(key(owner)) && !conflicting.has(key(owner))).map(owner => serialize(owner, () => stopObserved(owner))));
      failures.push(...results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
      if (failures.length > 0) throw new AggregateError(failures, "Project execution stop was not confirmed.");
      operationSignal.throwIfAborted();
      if (durable === undefined) for (const task of local) if (task.agentControlMode !== "web" && !owned.some(owner => sameClaim(owner, task))) endStoppedActivity(task);
      if (selected(projectId) && (configuration.targetProjectIds === undefined || configuration.targetProjectIds.includes(projectId))) stoppedProjects.delete(projectId);
      else stoppedProjects.add(projectId);
    })().finally(() => { projectStops.delete(projectId); });
    projectStops.set(projectId, operation);
    updatePromptDemand();
    return operation;
  };
  const reconcileDeletedArchives = (): void => {
    for (const resource of lifecycle()?.archive?.resources() ?? []) {
      const identity = key(resource.owner);
      if (!resource.worktreeDeleted || jobs.has(identity)) continue;
      const monitoringKey = `archive/${identity}/${resource.sessionId}`;
      observe(m => { const failure = monitoringFailures.get(monitoringKey); if (failure !== undefined) m.updateFailureRetry(failure, "running"); });
      try {
        const pending = ending.get(identity);
        if (pending && hasWorktreeIdentity(pending) && pending.worktreeId !== resource.owner.worktreeId) throw new Error("The pending cleanup belongs to another original worktree.");
        reconcileDeletedHerdrResource(options.store, resource);
        ending.delete(identity); cleanupRetries.delete(identity);
        const task = options.store.getTask(resource.owner); if (task !== null) execution.forget(task);
        observe(m => {
          const failure = monitoringFailures.get(monitoringKey), activity = monitoringActivities.get(monitoringKey);
          if (failure !== undefined) m.recover(failure);
          if (activity !== undefined) m.endActivity(activity);
          monitoringFailures.delete(monitoringKey); monitoringFailurePhases.delete(monitoringKey); monitoringActivities.delete(monitoringKey); monitoringFailurePhases.delete(`archive-observed/${monitoringKey}`);
        });
      } catch (error) {
        observe(m => {
          let operationId = monitoringActivities.get(monitoringKey);
          if (operationId === undefined) {
            operationId = m.startActivity({ kind: "cleanup", phase: "worktree-removal", scope: { kind: "claim", projectId: resource.owner.projectId, taskId: resource.owner.taskId, claimId: resource.owner.claimId }, status: "waiting", waitReason: "unknown" });
            monitoringActivities.set(monitoringKey, operationId);
          }
          monitoringFailures.set(monitoringKey, operationId); monitoringFailurePhases.set(monitoringKey, "worktree-removal");
          m.fail({ operationId, component: "cleanup", phase: "worktree-removal", scope: { kind: "claim", projectId: resource.owner.projectId, taskId: resource.owner.taskId, claimId: resource.owner.claimId }, error });
          m.updateActivity(operationId, { phase: "worktree-removal", status: "waiting", waitReason: "unknown", nextAttemptAt: null });
        });
        options.emit({ kind: "cleanup-error", message: `Herdr deleted-resource reconciliation for ${identity} remains incomplete; the original deletion evidence is retained for retry.`, error });
      }
    }
  };
  const advanceArchive = (inventory: ReadonlyMap<string, Task>, coveredProjects: ReadonlySet<string>): void => {
    const archive = lifecycle()?.archive;
    if (!archive || archiveJob !== null || shuttingDown) return;
    const retained = archive.resources();
    for (const resource of retained) {
      if (!resource.stopped || resource.worktreeDeleted || resource.disposition !== null || !coveredProjects.has(resource.owner.projectId) || inventory.has(key(resource.owner))) continue;
      const monitoringKey = `archive/${key(resource.owner)}/${resource.sessionId}`;
      observe(m => {
        let operationId = monitoringActivities.get(monitoringKey);
        if (operationId === undefined) {
          operationId = m.startActivity({ kind: "cleanup", phase: "archive", scope: { kind: "claim", projectId: resource.owner.projectId, taskId: resource.owner.taskId, claimId: resource.owner.claimId }, status: "waiting", waitReason: resource.nextAttemptAt !== null ? "retry-backoff" : "unknown", nextAttemptAt: resource.nextAttemptAt === null ? null : new Date(resource.nextAttemptAt).toISOString() });
          monitoringActivities.set(monitoringKey, operationId);
        }
        // This is the existing resource snapshot; repeated reads of the same error are not new failures.
        if (resource.error !== null && monitoringFailurePhases.get(monitoringKey) !== "worktree-removal") {
          const signatureKey = `archive-observed/${monitoringKey}`;
          const signature = JSON.stringify([resource.state, resource.error, resource.nextAttemptAt]);
          if (monitoringFailurePhases.get(signatureKey) !== signature) {
            monitoringFailurePhases.set(signatureKey, signature);
            monitoringFailures.set(monitoringKey, operationId); monitoringFailurePhases.set(monitoringKey, "archive");
            m.fail({ operationId, component: "cleanup", phase: "archive", scope: { kind: "claim", projectId: resource.owner.projectId, taskId: resource.owner.taskId, claimId: resource.owner.claimId }, error: undefined, retryState: resource.nextAttemptAt === null ? "manual" : "scheduled", nextAttemptAt: resource.nextAttemptAt === null ? null : new Date(resource.nextAttemptAt).toISOString() });
          } else m.updateFailureRetry(operationId, resource.nextAttemptAt === null ? "manual" : "scheduled", resource.nextAttemptAt === null ? null : new Date(resource.nextAttemptAt).toISOString());
        }
      });
    }
    const candidates = retained.filter(resource => resource.stopped && !resource.worktreeDeleted
      && resource.disposition === null && coveredProjects.has(resource.owner.projectId) && !inventory.has(key(resource.owner))
      && (["pending", "ready", "unavailable"].includes(resource.state) || resource.state === "failed" && resource.nextAttemptAt !== null)
      && (resource.nextAttemptAt === null || resource.nextAttemptAt <= now())
      && !jobs.has(key(resource.owner)) && options.store.getProject(resource.owner) !== null
      && now() >= (options.store.getCleanupSchedule(resource.owner)?.nextAttemptAt ?? 0))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    const selected = candidates.find(resource => resource.sessionId > archiveCursor) ?? candidates[0];
    if (!selected) return;
    archiveCursor = selected.sessionId;
    const owner = selected.owner;
    const monitoringKey = `archive/${key(owner)}/${selected.sessionId}`;
    let monitoringPhase: "archive" | "worktree-removal" = "archive";
    let monitoringRetryAt: number | null = null;
    const job = serialize(owner, async () => {
      observe(m => {
        const activity = monitoringActivities.get(monitoringKey), failure = monitoringFailures.get(monitoringKey);
        if (activity !== undefined) m.updateActivity(activity, { phase: "archive", status: "running", waitReason: null, nextAttemptAt: null });
        if (failure !== undefined) m.updateFailureRetry(failure, "running");
      });
      if (!isStopped(owner)) throw new Error("The retained original execution no longer has confirmed stop evidence.");
      const ready = await cleanupOperation(operation => archive.advance(owner, operation), normalSignal);
      if (!ready) { observe(m => { const activity = monitoringActivities.get(monitoringKey), failure = monitoringFailures.get(monitoringKey); if (activity !== undefined) m.updateActivity(activity, { status: "waiting", waitReason: "unknown" }); if (failure !== undefined) m.updateFailureRetry(failure, "none"); }); return; }
      observe(m => {
        const activity = monitoringActivities.get(monitoringKey), failure = monitoringFailures.get(monitoringKey);
        if (failure !== undefined && monitoringFailurePhases.get(monitoringKey) === "archive") { m.recover(failure); monitoringFailures.delete(monitoringKey); monitoringFailurePhases.delete(monitoringKey); }
        if (activity !== undefined) m.updateActivity(activity, { phase: "archive", progress: true });
      });
      monitoringPhase = "worktree-removal";
      observe(m => { const activity = monitoringActivities.get(monitoringKey); if (activity !== undefined) m.updateActivity(activity, { phase: "worktree-removal", status: "running", waitReason: null }); });
      try {
        await cleanupOperation(operation => options.git.removeWorktree(projectFor(owner), owner, operation), normalSignal);
        if (await cleanupOperation(operation => options.git.findWorktree(projectFor(owner), owner, operation), normalSignal) !== null) throw new Error("The original archived worktree still exists after cleanup.");
        archive.cleaned(owner);
        const deleted = archive.resources().find(resource => resource.sessionId === selected.sessionId && sameClaim(resource.owner, owner) && resource.owner.worktreeId === owner.worktreeId);
        if (!deleted || !reconcileDeletedHerdrResource(options.store, deleted)) throw new Error("The original archive deletion has no durable readback.");
        ending.delete(key(owner));
        cleanupRetries.delete(key(owner));
        observe(m => {
          const failure = monitoringFailures.get(monitoringKey), activity = monitoringActivities.get(monitoringKey);
          if (failure !== undefined) m.recover(failure);
          if (activity !== undefined) { m.updateActivity(activity, { progress: true }); m.endActivity(activity); }
          monitoringFailures.delete(monitoringKey); monitoringFailurePhases.delete(monitoringKey); monitoringActivities.delete(monitoringKey); monitoringFailurePhases.delete(`archive-observed/${monitoringKey}`);
        });
      } catch (error) {
        const previous = ensureCleanupSchedule(options.store, owner, now()), failures = previous.failures + 1;
        const nextAttemptAt = now() + Math.min(300_000, 5000 * 2 ** Math.min(failures - 1, 6));
        options.store.saveCleanupSchedule(previous, { ...previous, failures, nextAttemptAt, stage: "worktree-removal", lastError: error instanceof Error ? error.message : String(error) });
        monitoringRetryAt = nextAttemptAt;
        throw error;
      }
    }).catch(error => {
      if (!isWorkerCancellation(error, normalSignal)) {
        observe(m => {
          const activity = monitoringActivities.get(monitoringKey);
          if (activity === undefined) return;
          const nextAttemptAt = monitoringRetryAt === null ? null : new Date(monitoringRetryAt).toISOString();
          monitoringFailures.set(monitoringKey, activity); monitoringFailurePhases.set(monitoringKey, monitoringPhase);
          m.fail({ operationId: activity, component: "cleanup", phase: monitoringPhase, scope: { kind: "claim", projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId }, error, retryState: nextAttemptAt === null ? "none" : "scheduled", nextAttemptAt });
          m.updateActivity(activity, { phase: monitoringPhase, status: "waiting", waitReason: nextAttemptAt === null ? "unknown" : "retry-backoff", nextAttemptAt });
        });
        options.emit({ kind: "cleanup-error", message: `Herdr archive finalization for ${key(owner)} remains incomplete; the original source and resource responsibility are retained.`, error });
      }
    }).finally(() => { if (archiveJob === job) archiveJob = null; });
    archiveJob = job;
  };
  const reconcileNeverStarted = (): void => {
    for (const retired of lifecycle()?.neverStarted?.retired() ?? []) {
      const { owner, cwd, agent } = retired, identity = key(owner);
      if (jobs.has(identity)) throw new Error("A retired claim still has an in-flight execution job.");
      const task = options.store.getTask(owner), schedule = options.store.getCleanupSchedule(owner);
      if (task !== null && (task.agent !== agent || task.agentControlMode === "web" || task.sessionId !== null)
        || schedule !== null && schedule.worktreeId !== owner.worktreeId) throw new Error("Never-started retirement conflicts with the original local ownership.");
      if (task !== null && task.status !== "done" || schedule !== null) {
        const project = projectFor(owner);
        if (path.join(project.localPath, ".worktrees", "daynight", owner.taskId) !== cwd) throw new Error("Never-started retirement has no matching original project path.");
      }
      // A failure aborts this tick before admission. Restart retries only these original SQLite rows,
      // never filesystem paths that a successor may now own.
      if (task !== null && task.status !== "done") options.store.completeTask(owner);
      if (schedule !== null) options.store.deleteCleanupSchedule(owner);
      ending.delete(identity); cleanupRetries.delete(identity);
      if (task !== null) execution.forget(task);
    }
  };
  const retireNeverStarted = async (inventory: ReadonlyMap<string, Task>, coveredProjects: ReadonlySet<string>): Promise<void> => {
    const retirement = lifecycle()?.neverStarted;
    if (!retirement) return;
    for (const owner of retirement.candidates()) {
      if (!coveredProjects.has(owner.projectId) || inventory.has(key(owner)) || jobs.has(key(owner))) continue;
      try {
        await serialize(owner, async () => {
          const project = projectFor(owner);
          await cleanupOperation(operation => retirement.retire(owner, operation, async cwd => {
            if (cwd !== path.join(project.localPath, ".worktrees", "daynight", owner.taskId)) throw new Error("Never-started retirement has no matching original project path.");
            if (await options.git.findWorktree(project, owner, operation) !== null) throw new Error("The original Git worktree still exists; never-started retirement is prohibited.");
          }), normalSignal);
        });
      } catch (error) {
        if (isWorkerCancellation(error, normalSignal)) throw error;
        options.emit({ kind: "cleanup-error", message: `Never-started retirement for ${key(owner)} remains unconfirmed; original ownership is retained.`, error });
      }
      reconcileNeverStarted();
    }
  };
  const reconcile = async (): Promise<void> => {
    reconciliationPhase = "reconciliation";
    observe(m => m.setPhase("reconciliation"));
    reconcileNeverStarted();
    reconcileDeletedArchives();
    launchCleanups();
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
    const prepared = new Set(coveredProjects);
    const preparationFailed = new Set<string>();
    reconciliationPhase = "project-preparation";
    observe(m => m.setPhase("project-preparation"));
    for (const repository of configuration.repositories) {
      const projectId = repository.project.projectId;
      if (!coveredProjects.has(projectId) || !options.prepareProject) continue;
      try {
        await options.prepareProject(projectId, normalSignal);
        const previous = projectMonitoringFailures.get(projectId);
        if (previous !== undefined) { observe(m => m.recover(previous)); projectMonitoringFailures.delete(projectId); }
      }
      catch (error) {
        if (isWorkerCancellation(error, normalSignal)) throw error;
        if (isUnavailableProject(error)) { invalidateProject(projectId); coveredProjects.delete(projectId); unavailable.add(projectId); }
        prepared.delete(projectId);
        preparationFailed.add(projectId);
        const operationId = projectMonitoringFailures.get(projectId) ?? randomUUID();
        projectMonitoringFailures.set(projectId, operationId);
        observe(m => m.fail({ operationId, component: "project", phase: "project-preparation", scope: { kind: "project", projectId }, error }));
        options.emit({ kind: "warning", message: `Could not prepare project ${projectId}; its work is not admitted.`, error });
      }
    }
    await retireNeverStarted(inventory, coveredProjects);
    advanceArchive(inventory, coveredProjects);
    // Ownership loss is authoritative even when the following resource observations fail.
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
      execution.forget(local);
    }
    reconciliationPhase = "resource-observation";
    observe(m => m.setPhase("resource-observation"));
    await ensureHerdr(normalSignal);
    const observed = await listHerdr(normalSignal);
    const knownOwners = [...responsibilities(), ...observed.map((workspace) => workspace.owner), ...pendingStops().map((stop) => stop.context), ...(options.webStore?.listUnfinishedTasks() ?? [])];
    for (const owner of knownOwners) {
      if (!coveredProjects.has(owner.projectId) || options.store.getProject(owner) === null || inventory.has(key(owner)) || isStopped(owner)) continue;
      ending.set(key(owner), owner);
    }
    launchCleanups();
    for (const remoteTask of inventory.values()) {
      const local = options.store.getTask(remoteOwner(remoteTask));
      if (local !== null && coveredProjects.has(local.projectId) && prepared.has(local.projectId) && local.status === "active" && !blockedByOldClaim(local, knownOwners)) schedule(local, remoteTask);
    }
    const resources = await snapshot(normalSignal, coveredProjects, [...inventory.values()].map((task) => remoteOwner(task)), unavailable);
    if (resources.unavailableProjects.size === 0 && resources.quarantined.size === 0) recoverScheduler("resource-observation");
    const observedAt = new Date(now()).toISOString();
    const publishCapacity = (): void => {
      const projection = latestReservations;
      if (unavailable.size > 0 || resources.unavailableProjects.size > 0 || !allMappingsObserved()) { observe(m => m.staleCapacity()); return; }
      observe(m => m.setCapacity({ limit: configuration.maxConcurrent, occupied: projection.length, observedAt,
        reservations: projection.map(({ identity, roles }) => {
          const [projectId, taskId, claimId] = identity.split("/");
          return { identity: { projectId: projectId!, taskId: taskId!, claimId: claimId! }, roles };
        }) }));
    };
    // New mappings require both a claim inventory and resource discovery before admission.
    const allMappingsObserved = (): boolean => configurationObserved()
      && options.store.listProjects().every(project => resources.scannedProjects.has(project.projectId))
      && (configuration.targetProjectIds ?? []).every(id => unavailable.has(id) || options.store.getProject({ projectId: id }) !== null);
    const quarantinedTask = (task: Pick<ClaimIdentity, "projectId" | "taskId">): boolean => [...resources.quarantined.values()].some(owner => taskKey(owner) === taskKey(task));
    const quarantinedReasons = (observedAt: string) => [...resources.quarantined.values()].map(owner => ({
      code: "retained-resource-conflict" as const,
      scope: { kind: "claim" as const, projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId },
      observedAt, nextAttemptAt: null,
    }));
    cycleCoverage = allMappingsObserved() && unavailable.size === 0 && resources.unavailableProjects.size === 0 && resources.quarantined.size === 0
      && configuration.repositories.every(repository => prepared.has(repository.project.projectId)) ? "complete" : "partial";
    for (const [identityKey, owner] of resources.owners) {
      if (!resources.quarantined.has(identityKey) && coveredProjects.has(owner.projectId) && resources.proven.has(identityKey) && !inventory.has(identityKey) && !isStopped(owner)) ending.set(identityKey, owner);
    }
    for (const local of options.store.listUnfinishedTasks()) {
      if (!coveredProjects.has(local.projectId) || resources.unavailableProjects.has(local.projectId) || resources.quarantined.has(key(local)) || inventory.has(key(local))) continue;
      const owner = resources.owners.get(key(local));
      if (owner !== undefined && isStopped(owner)) {
        ending.delete(key(local));
        if (!jobs.has(key(local))) options.store.completeTask(local);
      } else if (owner !== undefined) ending.set(key(local), owner);
      else if (!jobs.has(key(local)) && !ending.has(key(local))) ending.set(key(local), local);
    }

    launchCleanups();
    for (const [identityKey, remoteTask] of inventory) {
      let local = options.store.getTask(remoteOwner(remoteTask));
      if (local === null) continue;
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
    const cleanupFailure = (identity: string) => options.store.getCleanupSchedule(ending.get(identity)!) ?? cleanupRetries.get(identity);
    const occupied = capacity(resources);
    const blocked = occupied >= configuration.maxConcurrent
      ? [...ending.keys()].filter(identity => cleanupFailure(identity)?.lastError != null).sort() : [];
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
      ...(latestReservations.some(item => item.roles.includes("cleanup")) && latestReservations.filter(item => !item.roles.includes("cleanup") || inventory.has(item.identity) || resources.unresolved.has(item.identity)).length < configuration.maxConcurrent ? [{ code: "cleanup-capacity-blocked" as const, scope: { kind: "worker" as const }, observedAt: admissionAt, nextAttemptAt: null }] : []),
    ]));
    else if (configuration.repositories.length === 0) observe(m => m.setAdmission("complete", [{ code: "no-projects-selected", scope: { kind: "worker" }, observedAt: admissionAt, nextAttemptAt: null }]));
    const warning = blocked.join(",");
    if (warning !== capacityWarning) {
      capacityWarning = warning;
      if (warning !== "") options.emit({ kind: "cleanup-capacity-blocked", message: `Worker capacity is full; failed cleanup retains ${blocked.length} slot(s). ${blocked.map(identity => { const state = cleanupFailure(identity)!; return `${identity}: ${state.stage}, next retry ${new Date(state.nextAttemptAt).toISOString()}, ${state.lastError}`; }).join("; ")}. Correct the reported resource or archive failure; retries are automatic. No slot is released until cleanup is confirmed.` });
    }
    if (!allMappingsObserved() || capacity(resources) >= configuration.maxConcurrent || configuration.repositories.length === 0) return;
    reconciliationPhase = "claim-search";
    observe(m => { m.setPhase("claim-search"); if (cycleCoverage === "complete") m.setAdmission("unknown", []); });
    const acquisitionConfiguration = configuration;
    const tiers = acquisitionConfiguration.preferPlatformSpecificTasks ? [true, false] : [undefined];
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
            page = platformSpecific === undefined
              ? options.remote.candidates(repository.project.projectId, options.platform, normalSignal)
              : options.remote.candidates(repository.project.projectId, options.platform, normalSignal, platformSpecific);
            candidates.set(index, page);
          }
          let next: IteratorResult<Task>;
          try { next = await page.next(); }
          catch (error) {
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
            if ([...resources.owners.values()].some(owner => owner.projectId === candidate.projectId && owner.taskId === candidate.id)) throw new Error("An original task resource still reserves its worktree; a new claim cannot be acquired.");
          }
          catch (error) {
            if ([...resources.owners.values()].some(owner => owner.projectId === candidate.projectId && owner.taskId === candidate.id)) retainedConflicts.add(candidate.projectId);
            options.emit({ kind: "warning", message: `Skipping ${candidate.projectId}/${candidate.id}: ${error instanceof Error ? error.message : "retained resource admission failed"}`, error });
            continue;
          }
          requireImplementedWorkerBackend(currentRepository.configuration);
          if (currentRepository.configuration.agentControlMode === "web") await options.verifyWebServer?.(currentRepository.configuration.agent, normalSignal);
          if (configuration !== claimConfiguration || !coveredProjects.has(candidate.projectId) || !allMappingsObserved()) continue;
          const claimId = randomUUID();
          reconciliationPhase = "claim-request";
          observe(m => m.setPhase("claim-request"));
          try {
            const granted = await options.remote.claim(candidate, { claimId, workerId: options.workerId, machine: options.machine, platform: options.platform, agent: currentRepository.configuration.agent, ...(currentRepository.configuration.agentControlMode === "web" ? { agentControlMode: "web" as const } : {}), worktreeId: randomUUID() }, normalSignal);
            const owner = remoteOwner(granted);
            const local = options.store.registerPending({ projectId: granted.projectId, taskId: granted.id, claimId: owner.claimId, agent: readWorkerClaim(granted.properties)!.agent, agentControlMode: readWorkerClaim(granted.properties)!.agentControlMode, nativeConfiguration: currentRepository.configuration });
            registerClaim(granted);
            confirmWebClaim(owner);
            options.onClaim?.({ projectId: granted.projectId, taskId: granted.id, claimId: owner.claimId });
            if (!quarantinedTask(local) && allMappingsObserved() && coveredProjects.has(local.projectId) && selected(local.projectId) && canAdvance(local) && !blockedByOldClaim(local, resources.owners.values()) && capacity(resources) < configuration.maxConcurrent) schedule(options.store.activateTask(local), granted);
            if (configuration !== acquisitionConfiguration || !allMappingsObserved()) cycleCoverage = "partial";
            observe(m => m.staleCapacity());
            return;
          } catch (error) {
            if (isWorkerCancellation(error, normalSignal)) throw error;
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
    if (!sawCandidate && !searchIncomplete && cycleCoverage === "complete" && configuration === acquisitionConfiguration && allMappingsObserved() && latestReservations.length < configuration.maxConcurrent) {
      observe(m => m.setAdmission("complete", [{ code: "no-ready-tasks", scope: { kind: "worker" }, observedAt: new Date(now()).toISOString(), nextAttemptAt: null }]));
    }
  };
  const assertCanAcquire = (target: Pick<ClaimIdentity, "projectId" | "taskId">): void => {
    reconcileNeverStarted();
    const retained = responsibilities();
    assertHerdrResourceBudget(lifecycle()?.archive?.resources() ?? [], options.availableDiskBytes?.() ?? 1073741824n);
    if (retained.some(owner => owner.projectId === target.projectId && owner.taskId === target.taskId)) throw new Error("The original Herdr worktree remains reserved until archive finalization; a new claim cannot be acquired.");
  };
  const registerClaim = (task: Task): void => {
    const claim = readWorkerClaim(task.properties);
    if (task.status !== "in_progress" || claim?.state !== "active" || claim.workerId !== options.workerId) throw new Error("Fresh claim registration requires an active grant on this worker.");
    const owner = remoteOwner(task);
    const local = options.store.getTask(owner);
    if (local?.status !== "pending" || local.agent !== claim.agent || (local.agentControlMode ?? "herdr") !== claim.agentControlMode) throw new Error("Fresh claim registration requires its matching pending local task.");
    if (claim.agentControlMode === "herdr") options.herdr.lifecycle?.registerClaim(executionContext({ task: local, owner, project: projectFor(task) }), claim.userId);
  };
  const readSource = async (identity: ClaimIdentity): Promise<{ task: LocalTask; owner: ResourceOwner; remoteTask: Task }> => {
    const task = options.store.getTask(identity);
    if (task === null || task.status === "done") throw new Error("The original unfinished local claim is missing.");
    const remoteTask = await options.remote.readTask(identity.projectId, identity.taskId, normalSignal);
    const worker = readWorkerClaim(remoteTask.properties);
    if (worker === undefined || worker.claimId !== identity.claimId || worker.workerId !== options.workerId || worker.state !== "active") throw new Error("The original claim is no longer active on this worker.");
    return { task, owner: remoteOwner(remoteTask), remoteTask };
  };
  return {
    invalidateProject,
    updateConfiguration: (value: WorkerCoordinatorConfiguration): void => {
      const next = configurationView(value);
      // Claim admission fences actual view changes, not repeated heartbeat acknowledgments.
      if (!isDeepStrictEqual(configuration, next)) {
        configuration = next;
        updatePromptDemand();
        options.onInventory?.(null);
        for (const [identity, running] of controllers) {
          const projectId = identity.slice(0, identity.indexOf("/"));
          if (!running.terminal && configuration.targetProjectIds !== undefined && !configuration.targetProjectIds.includes(projectId)) running.controller.abort(new Error("The project is no longer available for worker execution."));
        }
        for (const projectId of stoppedProjects) if (canAdvanceProject(projectId)) stoppedProjects.delete(projectId);
      }
    },
    stopProject,
    assertCanAcquire,
    registerClaim,
    tick: async (): Promise<void> => {
      if (shuttingDown || ticking) return;
      ticking = true;
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
      finally { updatePromptDemand(); activeCoverage = undefined; ticking = false; }
    },
    advanceRetry: async (identity: ClaimIdentity): Promise<WorkerInputWait | undefined> => {
      const { task, remoteTask } = await readSource(identity);
      if (task.status !== "active") throw new Error("Only an active original claim may be retried; pending work is started by worker run.");
      const webRecord = task.agentControlMode === "web" ? options.webStore?.getTask(task) : null;
      const worker = readWorkerClaim(remoteTask.properties)!;
      if (task.agentControlMode === "web" && !webRecord) throw new Error("Retry requires the original Web execution evidence; it cannot start a replacement assignment.");
      if (webRecord && (webRecord.worktreeId !== worker.worktreeId || webRecord.workerId !== worker.workerId || webRecord.userId !== worker.userId || webRecord.serverOrigin !== options.serverOrigin)) throw new Error("The original Web execution ownership no longer matches the active claim.");
      if (configurationFor(task) === null) throw new Error("Native configuration is unavailable for this project; correct its cloud settings before retrying execution.");
      failures.delete(key(identity));
      await ensureHerdr(normalSignal);
      return serialize(identity, async () => {
        if (task.agentControlMode === "web" && options.webStore) {
          let record = options.webStore.getTask(task);
          if (record !== null) {
            if (record.cleanup !== null) record = await finishShutdown(record, normalSignal);
            options.webStore.authorizeRecoveryRetry(record, now());
          }
        }
        return ensure(task, remoteTask, normalSignal);
      });
    },
    cleanupSource: async (identity: ClaimIdentity, settings: { deleteWorktree?: boolean } = {}): Promise<ResourceOwner> => {
      const { owner } = await readSource(identity);
      await ensureHerdr(normalSignal);
      await serialize(identity, async () => { await runCleanup(owner, settings.deleteWorktree === true, normalSignal); if (settings.deleteWorktree === true) options.store.deleteCleanupSchedule(owner); });
      return owner;
    },
    completeSource: async (owner: ResourceOwner): Promise<void> => {
      await ensureHerdr(normalSignal);
      await serialize(owner, async () => { await runCleanup(owner, true, normalSignal); options.store.deleteCleanupSchedule(owner); });
    },
    shutdown: async (): Promise<boolean> => {
      cancel();
      normalSignal.removeEventListener("abort", cancel);
      await Promise.all(jobs.values());
      await Promise.allSettled(projectStops.values());
      await archiveJob;
      let complete = true;
      for (const task of options.store.listUnfinishedTasks()) if (task.agentControlMode === "web" && options.webStore?.getTask(task) == null) {
        if (task.status === "pending" && task.sessionId === null && options.verifyWebUnregistered) {
          try { await options.verifyWebUnregistered(task, new AbortController().signal, CLEANUP_OPERATION_MS); continue; }
          catch { /* Missing launch evidence must not be interpreted as a confirmed native stop. */ }
        }
        complete = false;
        options.emit({ kind: "shutdown-error", task, message: "The original Web execution evidence is missing; complete native stop cannot be confirmed." });
      }
      const owners = new Map<string, ResourceOwner>([...ending].filter((entry): entry is [string, ResourceOwner] => hasWorktreeIdentity(entry[1])));
      for (const owner of responsibilities()) {
        if (options.store.getProject(owner) === null) {
          complete = false;
          options.emit({ kind: "shutdown-error", message: `Retained durable Herdr responsibility for an unmapped project: ${key(owner)}.` });
        } else owners.set(key(owner), owner);
      }
      if (lifecycle() !== undefined) {
        const registered = new Set(responsibilities().map(key));
        for (const local of options.store.listUnfinishedTasks()) if (local.agentControlMode !== "web" && local.status === "active" && !registered.has(key(local))) {
          complete = false;
          options.emit({ kind: "shutdown-error", task: local, message: "The original Herdr execution evidence is missing; complete native stop cannot be confirmed." });
        }
      }

      for (const { context } of pendingStops()) {
        if (options.store.getProject(context) === null) {
          complete = false;
          options.emit({ kind: "shutdown-error", message: `Retained an unhandled stop operation for ${context.projectId}/${context.taskId}/${context.claimId}.` });
        } else owners.set(key(context), context);
      }
      try {
        let workspaces: HerdrOwnedWorkspace[] = [];
        if (needsHerdr() || hasHerdrCleanup()) {
          await cleanupOperation(operation => options.herdr.ensureInstance(operation));
          workspaces = await cleanupOperation(operation => options.herdr.tasks.listResources(operation));
        }
        for (const workspace of workspaces) {
          if (options.store.getProject(workspace.owner) === null) {
            complete = false;
            options.emit({ kind: "shutdown-error", message: `Retained unhandled Herdr resources for ${workspace.owner.projectId}/${workspace.owner.taskId}/${workspace.owner.claimId}; restore their original project configuration before stopping the private instance.` });
          } else owners.set(key(workspace.owner), workspace.owner);
        }
      } catch (error) {
        complete = false;
        options.emit({ kind: "shutdown-error", message: "Could not inspect every owned Herdr workspace during shutdown.", error });
      }
      // Git inventory cannot prove whether an agent stopped. Terminal deletion stays pending.
      for (const record of options.webStore?.listUnfinishedTasks() ?? []) owners.set(key(record), record);
      await Promise.all([...owners.values()].map(async (owner) => {
        try {
          await serialize(owner, async () => {
            const webRecord = options.webStore?.getTask(owner);
            if (webRecord != null) {
              if (webRecord.worktreeId !== owner.worktreeId) throw new Error("The Web cleanup claim has conflicting worktree identities.");
              if (!options.webBackend) throw new Error("The Web execution backend is unavailable during shutdown.");
              const stopped = await options.webBackend.cleanup(webRecord, "shutdown", now(), undefined, true);
              if (!stopped.complete) throw new Error("The original Web resources remain during shutdown.");
              return;
            }
            if (options.store.getTask(owner)?.agentControlMode === "web") return;
            const durable = lifecycle();
            if (durable !== undefined) {
              if (durable.isStopped(owner)) return;
              await cleanupOperation(operation => durable.stop(owner, "shutdown", operation));
              if (!durable.isStopped(owner)) throw new Error("The original Herdr run stop is not confirmed.");
              return;
            }
            if (options.store.getTask(owner) === null) {
              const observed = await cleanupOperation((operation) => options.herdr.tasks.listResources(operation));
              recordMissingClaim(owner, actualTaskPane(owner, observed));
            }
            await settleWorkerStops(deps, owner, undefined, cleanupOperation);
            const resources = await cleanupOperation((operation) => options.herdr.tasks.listResources(operation));
            const pane = actualTaskPane(owner, resources);
            if (pane === undefined) return;
            const context = { ...owner, cwd: path.join(projectFor(owner).localPath, ".worktrees", "daynight", owner.taskId) };
            await cleanupOperation((operation) => options.herdr.tasks.stopAndClose(context, pane.binding, operation));
          });
        }
        catch (error) { complete = false; options.emit({ kind: "shutdown-error", ...(options.store.getTask(owner) === null ? {} : { task: options.store.getTask(owner)! }), message: error instanceof WorkerCleanupError && error.stage === "backend-close" ? "The original Agent is stopped, but backend resource closure is unconfirmed." : "Could not confirm the original task resources stopped and closed.", error }); }
      }));
      return complete;
    },
  };
};
