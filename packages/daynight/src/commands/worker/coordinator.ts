import { requireImplementedWorkerBackend } from "./backend.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstat } from "node:fs/promises";
import { ApiError } from "../../api/client.js";
import { resolvePhysicalDirectory } from "../../platform/filesystem.js";
import type { Task, TaskPlatform, WorkerMachine, WorkerPhase } from "../../api/types.js";
import { createCleanupDriver } from "./cleanup.js";
import { createWorkerControlDriver } from "./control.js";
import { createExecutionDriver, isWorkerCancellation, ownedWorkspace, workerOperation } from "./execution.js";
import type { ExecutionDependencies, WorkerEvent, WorkerGitManager } from "./execution.js";
import { HerdrAgentActionError } from "./herdr.js";
import type { HerdrOwnedWorkspace, WorkerHerdrAdapter } from "./herdr.js";
import type { WorkerRemote } from "./remote.js";
import { isUnstartedPending, isUnstartedPendingSource } from "./store.js";
import type { WorkerStore } from "./store.js";
import { backendResourcesClosed, taskAgentControlMode, executionSummary } from "./types.js";
import type { WebExecutionBackend } from "./backends/web.js";
import type { ClaimIdentity, CleanupState, FrozenExecutionConfiguration, LocalTask, WorkerProject } from "./types.js";

export type WorkerRepositoryAssignment = { project: WorkerProject; configuration: FrozenExecutionConfiguration };
export type WorkerCoordinatorOptions = {
  store: WorkerStore;
  git: WorkerGitManager;
  herdr: WorkerHerdrAdapter;
  webBackend?: WebExecutionBackend;
  verifyWebServer?: (provider: string, signal: AbortSignal) => Promise<void>;
  remote: WorkerRemote;
  serverOrigin: string;
  workerId: string;
  platform: TaskPlatform;
  machine: WorkerMachine;
  repositories: readonly WorkerRepositoryAssignment[];
  maxConcurrent: number;
  buildPrompt: (task: LocalTask, platform: TaskPlatform) => string;
  emit: (event: WorkerEvent) => void;
  signal?: AbortSignal;
  now?: () => number;
};
const claimKey = (task: ClaimIdentity): string => `${task.serverOrigin}/${task.projectId}/${task.taskId}/${task.claimId}`;
const taskKey = (task: Pick<ClaimIdentity, "serverOrigin" | "projectId" | "taskId">): string => `${task.serverOrigin}/${task.projectId}/${task.taskId}`;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const exists = async (target: string): Promise<boolean> => {
  try { await lstat(target); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
};
const physicalPath = async (target: string): Promise<string> => {
  const resolved = await resolvePhysicalDirectory(target);
  return path.join(resolved.ancestorPath, ...resolved.missingComponents);
};
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, milliseconds); });
const unknownUserScope = "The original authenticated execution owner is unknown; only an exact current own claim can establish it.";
const changedUserScope = "The current authenticated user does not match the original execution owner.";
const unscopedCleanup = "The original authenticated owner of this committed cleanup is unknown; cleanup remains paused.";
const scopePauseReasons = new Set([unknownUserScope, changedUserScope, unscopedCleanup]);
const removalBoundary = (task: LocalTask) => ({ control: task.control !== null, terminal: task.cleanup?.kind === "terminal", deleted: task.cleanup?.worktreeDeleted === true, done: task.status === "done" });
const unsettledRemoval = (task: LocalTask): boolean => (task.control !== null || task.cleanup?.kind === "terminal") && task.cleanup?.worktreeDeleted !== true;

export const createWorkerCoordinator = (options: WorkerCoordinatorOptions) => {
  let backendUnavailable = false;
  const requireBackend: typeof requireImplementedWorkerBackend = (configuration) => {
    try { if (configuration?.agentControlMode === "web" && options.webBackend === undefined) throw new Error("Web backend is not implemented by this coordinator; its original claim is retained."); requireImplementedWorkerBackend(configuration); }
    catch (error) { backendUnavailable = true; throw error; }
  };
  const now = options.now === undefined ? Date.now : options.now;
  const deps: ExecutionDependencies = { store: options.store, git: options.git, herdr: options.herdr, platform: options.platform, buildPrompt: options.buildPrompt, emit: options.emit, now };
  const execution = createExecutionDriver(deps);
  const cleanup = createCleanupDriver(deps);
  let inventoryHasHerdr = false;
  const needsHerdr = (): boolean => inventoryHasHerdr || options.repositories.some(r => r.configuration.agentControlMode === "herdr") || options.store.listUnfinishedTasks().some(t => t.workerId === options.workerId && taskAgentControlMode(t) !== "web");
  const ensureHerdr = async (signal?: AbortSignal): Promise<void> => { if (needsHerdr()) await workerOperation(operation => options.herdr.ensureInstance(operation), signal); };
  const webBackend = (): WebExecutionBackend => { if (options.webBackend === undefined) throw new Error("The Web execution backend is unavailable; its original claim is retained."); return options.webBackend; };
  const advanceCleanup = (task: LocalTask, resources: readonly HerdrOwnedWorkspace[], kind: CleanupState["kind"], deadline: number, signal?: AbortSignal): Promise<LocalTask> => taskAgentControlMode(task) === "web" ? webBackend().cleanup(task, kind, deadline, signal) : cleanup.advance(task, resources, kind, deadline, signal);
  const control = createWorkerControlDriver({ store: options.store, remote: options.remote, serverOrigin: options.serverOrigin, now });
  const normalSignal = options.signal === undefined ? new AbortController().signal : options.signal;
  const tails = new Map<string, Promise<void>>();
  let nextRepository = 0;
  let shuttingDown = false;
  let ticking = false;
  const serializeTask = async <T>(identity: Pick<ClaimIdentity, "serverOrigin" | "projectId" | "taskId">, action: () => Promise<T>): Promise<T> => {
    const key = taskKey(identity);
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    tails.set(key, tail);
    await previous;
    try { return await action(); }
    finally { release(); if (tails.get(key) === tail) tails.delete(key); }
  };
  const latest = (task: ClaimIdentity): LocalTask => {
    const result = options.store.getTask(task);
    if (result === null) throw new Error("The local execution disappeared.");
    return result;
  };
  const capacity = (): number => options.store.listUnfinishedTasks().filter((task) => task.status === "active").length;
  const workerLocalTasks = (): LocalTask[] => options.store.listUnfinishedTasks().filter((task) => task.workerId === options.workerId);
  const currentOriginTasks = (): LocalTask[] => workerLocalTasks().filter((task) => task.serverOrigin === options.serverOrigin);
  const readResources = async (signal?: AbortSignal): Promise<HerdrOwnedWorkspace[]> => {
    if (!needsHerdr()) return [];
    const resources = await workerOperation((operation) => options.herdr.tasks.listResources(operation), signal);
    for (const workspace of resources) {
      const task = options.store.getTask(workspace.owner);
      if (task === null || task.status === "done" || task.workerId !== options.workerId || task.worktreeId !== workspace.owner.worktreeId) continue;
      if (task.resources.herdr === null && task.nativeExecution?.workspaceSubmission === "not-submitted" && task.nativeExecution.launchSubmission === "never-submitted") {
        const observed = options.store.recordObservedUnattemptedWorkspace({ ...workspace.owner, workerId: options.workerId }, now());
        if (observed !== null) options.emit({ kind: "resource-provenance-unknown", task: observed, message: "An existing workspace has no original local creation attempt; native launch provenance requires observation." });
      }
    }
    return resources;
  };
  const pauseForScope = (task: LocalTask, reason: string): LocalTask => {
    const originalReason = task.recovery.pauseReason;
    const retainedReason = originalReason !== null && !scopePauseReasons.has(originalReason) ? originalReason : reason;
    if (task.status === "pending" && !isUnstartedPending(task)) task = options.store.activatePausedRecovery(task, retainedReason, now());
    else if (originalReason !== retainedReason) task = options.store.pauseTask(task, retainedReason, now());
    options.emit({ kind: "scope-paused", task, message: reason });
    return task;
  };
  const completeTerminal = (task: LocalTask, absent: boolean, authenticatedUserId?: string): LocalTask => {
    if (task.userId === null) return task;
    if (task.cleanup?.kind !== "terminal" || !task.cleanup.agentStopped || !backendResourcesClosed(task.cleanup) || !task.cleanup.worktreeDeleted || task.cleanup.result === null) return task;
    if (task.control !== null && task.control.submission !== "confirmed") {
      if (!absent || authenticatedUserId !== task.userId) return task;
      task = options.store.confirmControlOwnershipEnded(task, { completeOwnClaimInventory: true, claimAbsent: true }, now());
    }
    return options.store.completeTask(task, now());
  };
  const advanceTerminal = async (input: LocalTask, resources: readonly HerdrOwnedWorkspace[], signal: AbortSignal, continueControl = true): Promise<LocalTask> => {
    let task = latest(input);
    if (taskAgentControlMode(task) === "web") task = await advanceCleanup(task, resources, "terminal", task.cleanup?.deadline ?? now() + 600_000, signal);
    else if (task.control !== null && isUnstartedPendingSource(task)) {
      if (ownedWorkspace(task, resources) !== undefined) throw new Error("An unstarted controlled source has unexpected Herdr resources; its cleanup cannot be inferred.");
      task = options.store.confirmUnstartedControlCleanup(task, { completeHerdrInventory: true, noOwnedResources: true }, now() + 600_000, now());
    } else task = await advanceCleanup(task, resources, "terminal", task.cleanup?.deadline ?? now() + 600_000, signal);
    if (continueControl && task.control !== null) task = await control.advance(task, signal);
    return task;
  };
  const publishSummary = async (task: LocalTask, remoteTask: Task): Promise<void> => {
    const worker = remoteTask.properties.worker;
    if (worker === null || worker.claimId !== task.claimId || task.cleanup !== null || task.control !== null || (task.nativeExecution === null && task.webExecution == null)) return;
    options.store.reconcileExecutionSummary(task, { version: remoteTask.version.toString(), herdr: worker.herdr, nativeSessionId: worker.nativeSessionId, phase: worker.phase }, now());
    task = latest(task);
    const prior = executionSummary(task);
    if (prior?.submission === "unknown") return;
    const initialInputAccepted = taskAgentControlMode(task) === "web"
      ? ["provider_accepted", "confirmed"].includes(task.webExecution?.initialInputState ?? "")
      : task.nativeExecution!.promptSubmission === "submitted";
    // Native approval/turn activity belongs to Session relay. Publishing each
    // transition here would invalidate the task version an agent just read.
    const phase: WorkerPhase = task.recovery.pauseReason !== null ? "paused" : initialInputAccepted ? "executing" : "preparing";
    const target = { herdr: task.resources.herdr, nativeSessionId: task.resources.nativeSession?.sessionId ?? null, phase };
    if (same(target, { herdr: worker.herdr, nativeSessionId: worker.nativeSessionId, phase: worker.phase })) return;
    if (prior?.submission === "rejected" && prior.version === remoteTask.version.toString()) return;
    options.store.markExecutionSummarySubmitting(task, { ...target, version: remoteTask.version.toString() }, now());
    try {
      await options.remote.update(remoteTask, target, normalSignal);
      options.store.recordExecutionSummaryOutcome(task, remoteTask.version.toString(), "confirmed", now());
    } catch (error) {
      if (error instanceof ApiError && !error.outcomeUnconfirmed) {
        if (error.confirmedRefusal) options.store.recordExecutionSummaryOutcome(task, remoteTask.version.toString(), "rejected", now());
        else options.store.recordExecutionSummaryNotSubmitted(task, remoteTask.version.toString(), { notSubmitted: true }, now());
      }
      options.emit({ kind: "summary-error", task: latest(task), message: "The execution summary was not confirmed; an uncertain write will not be replayed.", error });
    }
  };
  const acknowledgeInventoryClaim = (remoteTask: Task, authenticatedUserId: string): void => {
    const worker = remoteTask.properties.worker!;
    const identity = { serverOrigin: options.serverOrigin, projectId: remoteTask.projectId, taskId: remoteTask.id, claimId: worker.claimId, workerId: worker.workerId, worktreeId: worker.worktreeId };
    const present = options.store.getTask(identity);
    const attempt = options.store.getClaimAttempt(identity);
    if (attempt !== null && attempt.claimId === worker.claimId) {
      if (attempt.userId !== authenticatedUserId || worker.userId !== authenticatedUserId) throw new Error("The original claim request belongs to another authenticated user; its scope cannot be replaced.");
      if (attempt.taskId !== remoteTask.id || attempt.workerId !== worker.workerId || attempt.worktreeId !== worker.worktreeId || (attempt.configuration.agent !== worker.agent || attempt.configuration.agentControlMode !== worker.agentControlMode)) throw new Error("The observed grant does not match the original claim request and frozen agent.");
      // An uncleared original request has not crossed the pending commit gate;
      // its absent local row proves this producer has not started resources.
      const fresh = present === null && worker.herdr === null && worker.nativeSessionId === null && worker.phase === "preparing";
      const task = options.store.registerPending(identity, { kind: fresh ? "new" : "recovered", configuration: attempt.configuration }, now(), authenticatedUserId);
      options.emit({ kind: "pending-recovered", task, message: "The original claim grant and saved configuration were committed locally before resource preparation." });
      return;
    }
    if (present !== null) {
      const originalIdentityMatches = taskAgentControlMode(present) === worker.agentControlMode && present.workerId === worker.workerId && present.worktreeId === worker.worktreeId && (present.configuration === null || (present.configuration.agent === worker.agent && present.configuration.agentControlMode === worker.agentControlMode));
      if (present.userId === null && originalIdentityMatches && present.control === null && present.cleanup?.kind !== "terminal") options.store.bindUserScope(present, authenticatedUserId, now());
    }
  };
  const recordRecovered = async (remoteTask: Task, resources: readonly HerdrOwnedWorkspace[], authenticatedUserId: string): Promise<LocalTask | null> => {
    const worker = remoteTask.properties.worker!;
    const identity = { serverOrigin: options.serverOrigin, projectId: remoteTask.projectId, taskId: remoteTask.id, claimId: worker.claimId, workerId: worker.workerId, worktreeId: worker.worktreeId };
    const present = options.store.getTask(identity);
    if (present !== null) return present;
    const project = options.store.getProject(identity);
    if (project === null) throw new Error(`The original project binding for recovered claim ${worker.claimId} is unavailable.`);
    const runtimeTrace = worker.herdr !== null || worker.nativeSessionId !== null || resources.some(({ owner }) => owner.serverOrigin === identity.serverOrigin && owner.projectId === identity.projectId && owner.taskId === identity.taskId && owner.claimId === identity.claimId);
    const configured = options.repositories.find(({ project: selected }) => selected.serverOrigin === identity.serverOrigin && selected.projectId === identity.projectId);
    // Capture original identities before filesystem reads: cleanup may finish while
    // these reads are in flight, and Git creation may precede the binding commit.
    const predecessors = workerLocalTasks().filter((task) => task.taskId === identity.taskId && claimKey(task) !== claimKey(identity))
      .map((task) => ({ task, worktreePath: task.resources.worktree?.worktreePath ?? path.join(task.repositoryPath, ".worktrees", "daynight", task.taskId) }));
    const fixedPath = path.join(project.localPath, ".worktrees", "daynight", identity.taskId);
    const prospectiveFresh = !runtimeTrace && worker.phase === "preparing";
    const matchingPredecessors: LocalTask[] = [];
    const deferForRemoval = (): boolean => {
      for (const previous of matchingPredecessors) {
        const current = options.store.getTask(previous);
        if (current === null) throw new Error("The original predecessor execution record disappeared.");
        if (unsettledRemoval(previous) || unsettledRemoval(current) || !same(removalBoundary(previous), removalBoundary(current))) {
          options.emit({ kind: "handoff-waiting", task: current, message: `New claim ${identity.claimId} in project ${identity.projectId} is waiting for the original worktree removal boundary to settle.` });
          return true;
        }
      }
      return false;
    };
    let pathTrace = await exists(fixedPath);
    if (prospectiveFresh && predecessors.length > 0) {
      const target = await physicalPath(fixedPath);
      for (const { task: previous, worktreePath } of predecessors) {
        try { if (await physicalPath(worktreePath) === target) matchingPredecessors.push(previous); }
        catch (error) {
          if (isWorkerCancellation(error, normalSignal)) throw error;
          if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) throw error;
          options.emit({ kind: "worktree-conflict", task: previous, message: "The original predecessor path could not be inspected.", error });
        }
      }
      if (deferForRemoval()) return null;
      if (pathTrace) for (const previous of matchingPredecessors) {
        try {
          const original = await workerOperation((operation) => options.git.findWorktree(previous, operation), normalSignal);
          pathTrace = original === null ? await exists(fixedPath) : false;
          break;
        } catch (error) {
          if (isWorkerCancellation(error, normalSignal)) throw error;
          if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) throw error;
          pathTrace = await exists(fixedPath);
          options.emit({ kind: "worktree-conflict", task: previous, message: "The occupied task path could not be attributed to its previous claim; the new execution remains unverified.", error });
        }
      }
    }
    if (pathTrace) pathTrace = await exists(fixedPath);
    // No filesystem await may separate this boundary check from materialization.
    if (prospectiveFresh && deferForRemoval()) return null;
    const trace = runtimeTrace || pathTrace;
    const configuredExecution = configured?.configuration;
    const configuration = configuredExecution === undefined ? undefined : configuredExecution.agent === worker.agent && configuredExecution.agentControlMode === worker.agentControlMode ? configuredExecution
      : { agent: worker.agent, agentControlMode: worker.agentControlMode, model: null, args: [], recoveryLimit: configuredExecution.recoveryLimit };
    const fresh = worker.agentControlMode !== "web" && !trace && configuration !== undefined && worker.phase === "preparing";
    const task = options.store.registerPending(identity, fresh ? { kind: "new", configuration } : { kind: "recovered", configuration: null, agentControlMode: worker.agentControlMode }, now(), authenticatedUserId);
    options.emit({ kind: fresh ? "pending-recovered" : "recovery-paused", task, message: fresh ? "Recovered the actual remote claim before resource creation and froze its effective configuration." : "Recovered an existing claim without its original frozen configuration; execution is paused." });
    return task;
  };
  const reconcileTask = async (input: LocalTask, remoteTask: Task | undefined, resources: readonly HerdrOwnedWorkspace[], authenticatedUserId: string): Promise<void> => {
    await serializeTask(input, async () => {
      let task = latest(input);
      let currentResources = resources;
      if (task.status === "done") return;
      requireBackend(task.configuration);
      if (task.control !== null || task.cleanup?.kind === "terminal") {
        if (task.userId === null) { pauseForScope(task, unscopedCleanup); return; }
        task = await advanceTerminal(task, resources, normalSignal, remoteTask !== undefined || task.userId !== authenticatedUserId);
        if (task.status !== "done") completeTerminal(task, remoteTask === undefined, authenticatedUserId);
        return;
      }
      if (task.userId === null || task.userId !== authenticatedUserId) {
        pauseForScope(task, task.userId === null ? unknownUserScope : changedUserScope);
        return;
      }
      if (remoteTask === undefined && isUnstartedPending(task)) {
        if (ownedWorkspace(task, resources) !== undefined) throw new Error("The pending execution has unexpected Herdr resources; its unstarted state cannot authorize cleanup completion.");
        task = options.store.completeUnstartedPending(task, { completeOwnClaimInventory: true, claimAbsent: true, authenticatedUserId }, now());
        options.emit({ kind: "done-unstarted", task, message: "The claim ended before activation or resource creation; local responsibility is complete." });
        return;
      }
      if (remoteTask === undefined) {
        task = await advanceCleanup(task, resources, "terminal", now() + 600_000, normalSignal);
        completeTerminal(task, true, authenticatedUserId);
        return;
      }
      if (task.cleanup?.kind === "shutdown") {
        task = await advanceCleanup(task, resources, "shutdown", task.cleanup.deadline, normalSignal);
        if (!task.cleanup!.agentStopped || !backendResourcesClosed(task.cleanup!) || task.cleanup!.result === null) return;
        task = options.store.resumeAfterShutdown(task, now());
        currentResources = await readResources(normalSignal);
      }
      const worker = remoteTask.properties.worker!;
      if (worker.agentControlMode !== taskAgentControlMode(task) || worker.workerId !== task.workerId || worker.worktreeId !== task.worktreeId || worker.platform !== options.platform || (task.configuration !== null && (worker.agent !== task.configuration.agent || worker.agentControlMode !== task.configuration.agentControlMode))) {
        task = options.store.pauseTask(task, "The authoritative claim identity, actual platform or original frozen native kind does not match this execution.", now());
        options.emit({ kind: "paused", task, message: task.recovery.pauseReason! });
        return;
      }
      if (task.configuration === null) {
        if (task.status === "pending") task = options.store.activatePausedRecovery(task, task.recovery.pauseReason ?? "The original frozen execution configuration is missing.", now());
        options.emit({ kind: "paused", task, message: task.recovery.pauseReason ?? "The original frozen execution configuration is missing." });
        return;
      }
      if (task.recovery.pauseReason !== null && scopePauseReasons.has(task.recovery.pauseReason)) task = options.store.clearPause(task, now());
      if (task.status === "pending" && taskAgentControlMode(task) !== "web" && task.nativeExecution?.launchSubmission !== "never-submitted") task = task.recovery.pauseReason === null
        ? options.store.activateTask(task, now())
        : options.store.activatePausedRecovery(task, task.recovery.pauseReason, now());
      if (task.status === "pending") {
        if (capacity() >= options.maxConcurrent || workerLocalTasks().some((other) => other.status === "active" && other.taskId === task.taskId)) return;
        task = options.store.activateTask(task, now());
      }
      try { task = taskAgentControlMode(task) === "web" ? await webBackend().advance(task, normalSignal) : await execution.advance(task, currentResources, normalSignal); }
      catch (error) {
        if (isWorkerCancellation(error, normalSignal)) throw error;
        if (error instanceof HerdrAgentActionError && error.submission === "unknown" && ["workspace.create", "workspace.close", "tab.create", "pane.close"].includes(error.action)) {
          task = latest(task);
          options.emit({ kind: "resource-unknown", task, message: "A resource mutation has an uncertain outcome; the next complete resource observation will reconcile its original identity.", error });
        } else {
          task = options.store.pauseTask(task, errorText(error), now());
          options.emit({ kind: "paused", task, message: "Execution paused with its original resources and capacity retained.", error });
        }
      }
      await publishSummary(latest(task), remoteTask);
    });
  };
  const claimOne = async (repository: WorkerRepositoryAssignment, resources: readonly HerdrOwnedWorkspace[], authenticatedUserId: string): Promise<boolean> => {
    if (repository.configuration.agentControlMode === "web") await options.verifyWebServer?.(repository.configuration.agent, normalSignal);
    if (options.store.getClaimAttempt(repository.project) !== null) {
      options.emit({ kind: "claim-unknown", message: `Project ${repository.project.projectId} has an unresolved original claim request; no claim is replayed.` });
      return false;
    }
    for await (const candidate of options.remote.candidates(repository.project.projectId, options.platform, normalSignal)) {
      if (shuttingDown || capacity() >= options.maxConcurrent) return false;
      if (options.store.listUnfinishedTasks().some((task) => task.serverOrigin === options.serverOrigin && task.projectId === candidate.projectId && task.taskId === candidate.id)) continue;
      const descriptor = { claimId: randomUUID(), workerId: options.workerId, worktreeId: randomUUID(), machine: options.machine, platform: options.platform, agent: repository.configuration.agent, agentControlMode: repository.configuration.agentControlMode };
      options.store.beginClaimAttempt(repository.project, { taskId: candidate.id, claimId: descriptor.claimId, workerId: options.workerId, worktreeId: descriptor.worktreeId, userId: authenticatedUserId, expectedVersion: candidate.version.toString(), configuration: repository.configuration });
      let granted: Task;
      try { granted = await options.remote.claim(candidate, descriptor, normalSignal); }
      catch (error) {
        if (error instanceof ApiError && !error.outcomeUnconfirmed) {
          options.store.rejectClaimAttempt(repository.project, descriptor.claimId, error.confirmedRefusal ? { definiteRejection: true } : { notSubmitted: true });
          options.emit({ kind: "claim-rejected", message: `Claim refused for project ${candidate.projectId}, task ${candidate.id}; no resources started.`, error });
          continue;
        }
        options.emit({ kind: "claim-unknown", message: `Claim outcome unknown for project ${candidate.projectId}, task ${candidate.id}, claim ${descriptor.claimId}; the original request is durably fenced.`, error });
        return false;
      }
      const worker = granted.properties.worker;
      if (worker === null || worker.userId !== authenticatedUserId) throw new Error("The granted claim does not match the verified authenticated user.");
      const task = options.store.registerPending({ serverOrigin: options.serverOrigin, projectId: granted.projectId, taskId: granted.id, claimId: descriptor.claimId, workerId: options.workerId, worktreeId: descriptor.worktreeId }, { kind: "new", configuration: repository.configuration }, now(), authenticatedUserId);
      options.emit({ kind: "pending", task, message: "Actual remote claim committed locally before activating or creating resources." });
      await reconcileTask(task, granted, resources, authenticatedUserId);
      return true;
    }
    return false;
  };
  return {
    serializeTask,
    advanceCommittedCleanups: async (identity?: ClaimIdentity): Promise<void> => {
      if (shuttingDown) return;
      normalSignal.throwIfAborted();
      const committed = workerLocalTasks().filter((task) => (task.cleanup !== null || task.control !== null) && (identity === undefined || claimKey(task) === claimKey(identity)));
      const results = await Promise.allSettled(committed.map((input) => serializeTask(input, async () => {
        normalSignal.throwIfAborted();
        let task = latest(input);
        if (task.status === "done" || (task.cleanup === null && task.control === null)) return;
        requireBackend(task.configuration);
        if (task.userId === null && (task.control !== null || task.cleanup?.kind === "terminal")) { pauseForScope(task, unscopedCleanup); return; }
        if (task.cleanup?.result !== null && task.cleanup?.agentStopped && backendResourcesClosed(task.cleanup) && (task.cleanup.kind === "shutdown" || task.cleanup.worktreeDeleted)) {
          if (task.control !== null) task = await control.advance(task, normalSignal);
          if (task.status !== "done") completeTerminal(task, false);
          return;
        }
        if (taskAgentControlMode(task) === "web" || !(task.control !== null && isUnstartedPendingSource(task))) task = options.store.beginCleanup(task, { kind: task.control !== null ? "terminal" : task.cleanup!.kind, deadline: task.cleanup?.deadline ?? now() + 600_000 }, now());
        await ensureHerdr(normalSignal);
        const resources = await readResources(normalSignal);
        task = task.control !== null ? await advanceTerminal(task, resources, normalSignal) : await advanceCleanup(task, resources, task.cleanup!.kind, task.cleanup!.deadline, normalSignal);
        if (task.status !== "done") completeTerminal(task, false);
      })));
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]!;
        if (result.status === "rejected" && !normalSignal.aborted) {
          let task = latest(committed[index]!);
          if (task.cleanup !== null) task = options.store.recordCleanupError(task, errorText(result.reason), now());
          options.emit({ kind: "cleanup-error", task, message: "Committed local cleanup remains active and will continue independently of remote inventory.", error: result.reason });
        }
      }
      normalSignal.throwIfAborted();
    },
    cleanupTask: async (identity: ClaimIdentity, kind: CleanupState["kind"] = "terminal"): Promise<LocalTask> => serializeTask(identity, async () => {
      requireBackend(latest(identity).configuration);
      await ensureHerdr();
      const resources = await readResources();
      const task = latest(identity);
      if (task.userId === null && (kind === "terminal" || task.control !== null || task.cleanup?.kind === "terminal")) return pauseForScope(task, unscopedCleanup);
      return task.control !== null ? advanceTerminal(task, resources, normalSignal) : advanceCleanup(task, resources, kind, now() + 600_000);
    }),
    advanceRetry: async (identity: ClaimIdentity): Promise<LocalTask> => {
      const authenticatedUserId = await options.remote.currentUserId(normalSignal);
      const task = latest(identity);
      requireBackend(task.configuration);
      if (task.serverOrigin !== options.serverOrigin || task.userId !== authenticatedUserId || task.workerId !== options.workerId) throw new Error("Retry must retain the original service, authenticated user and worker identity.");
      const remoteTask = await options.remote.readTask(task.projectId, task.taskId, normalSignal);
      const worker = remoteTask.properties.worker;
      if (worker?.state !== "active" || worker.claimId !== task.claimId || worker.userId !== task.userId) throw new Error("Retry requires the exact still-active source claim.");
      requireBackend(worker);
      await options.remote.authorizeControl(task.projectId, task.userId, undefined, normalSignal);
      await ensureHerdr(normalSignal);
      const resources = await readResources(normalSignal);
      await reconcileTask(task, remoteTask, resources, authenticatedUserId);
      return latest(identity);
    },
    tick: async (): Promise<void> => {
      if (shuttingDown) return;
      if (ticking) throw new Error("A worker reconciliation is already running.");
      ticking = true;
      try {
        normalSignal.throwIfAborted();
        for (const repository of options.repositories) requireBackend(repository.configuration);
        for (const task of workerLocalTasks()) requireBackend(task.configuration);
        const authenticatedUserId = await options.remote.currentUserId(normalSignal);
        const projects = options.store.listProjects().filter((project) => project.serverOrigin === options.serverOrigin);
        const inventory = await options.remote.ownInventory(projects, options.workerId, normalSignal);
        if (inventory.some((task) => task.properties.worker === null || task.properties.worker.userId !== authenticatedUserId || task.properties.worker.workerId !== options.workerId)) throw new Error("The own-claim inventory does not match its verified authenticated user and worker scope.");
        inventoryHasHerdr = inventory.some(task => task.properties.worker?.agentControlMode !== "web");
        for (const task of inventory) {
          requireBackend(task.properties.worker!);
          acknowledgeInventoryClaim(task, authenticatedUserId);
        }
        const byClaim = new Map(inventory.map((task) => [claimKey({ serverOrigin: options.serverOrigin, projectId: task.projectId, taskId: task.id, claimId: task.properties.worker!.claimId }), task]));
        await ensureHerdr(normalSignal);
        let resources = await readResources(normalSignal);
        for (const task of inventory) await recordRecovered(task, resources, authenticatedUserId);
        for (const workspace of resources) {
          const owner = workspace.owner;
          if (owner.serverOrigin !== options.serverOrigin || options.store.getTask(owner) !== null) continue;
          if (options.store.getProject(owner) === null) {
            options.emit({ kind: "orphan-unattributed", message: `Owned workspace ${workspace.workspaceId} has no persisted project binding; its resources were retained.` });
            continue;
          }
          options.store.registerPending({ ...owner, workerId: options.workerId }, { kind: "recovered", configuration: null }, now(), null);
        }
        const existing = currentOriginTasks().sort((left, right) => Number(right.status === "active") - Number(left.status === "active"));
        for (const task of existing) {
          try { await reconcileTask(task, byClaim.get(claimKey(task)), resources, authenticatedUserId); }
          catch (error) {
            if (isWorkerCancellation(error, normalSignal)) throw error;
            options.emit({ kind: "reconciliation-error", task: latest(task), message: "The original execution remains owned locally; reconciliation will preserve its recorded progress.", error });
          }
        }
        resources = await readResources(normalSignal);
        let misses = 0;
        while (!shuttingDown && options.repositories.length > 0 && capacity() < options.maxConcurrent && misses < options.repositories.length) {
          normalSignal.throwIfAborted();
          const repository = options.repositories[nextRepository % options.repositories.length]!;
          nextRepository = (nextRepository + 1) % options.repositories.length;
          const claimed = await claimOne(repository, resources, authenticatedUserId);
          misses = claimed ? 0 : misses + 1;
        }
      } finally { ticking = false; }
    },
    shutdown: async (): Promise<boolean> => {
      shuttingDown = true;
      await Promise.all([...tails.values()]);
      if (backendUnavailable) return false;
      const tasks = workerLocalTasks();
      for (const task of tasks) {
        try { requireBackend(task.configuration); }
        catch (error) { options.emit({ kind: "shutdown-error", task, message: "The original backend is unavailable; its execution responsibility is retained.", error }); return false; }
      }
      const deadline = now() + 600_000;
      const results = await Promise.allSettled(tasks.map((input) => serializeTask(input, async () => {
        let task = latest(input);
        if (task.status === "done") return;
        if (isUnstartedPending(task)) {
          await ensureHerdr();
          await readResources();
          task = latest(input);
          if (isUnstartedPending(task)) return;
        }
        if (task.userId === null && (task.control !== null || task.cleanup?.kind === "terminal")) { pauseForScope(task, unscopedCleanup); throw new Error(unscopedCleanup); }
        if (taskAgentControlMode(task) === "web" || !(task.control !== null && isUnstartedPendingSource(task))) task = options.store.beginCleanup(task, { kind: task.control !== null || task.cleanup?.kind === "terminal" ? "terminal" : "shutdown", deadline }, now());
        await ensureHerdr();
        while (true) {
          const resources = await readResources();
          task = task.control !== null ? await advanceTerminal(task, resources, new AbortController().signal, false) : await advanceCleanup(task, resources, task.cleanup!.kind, task.cleanup!.deadline);
          if (task.cleanup!.agentStopped && backendResourcesClosed(task.cleanup!)) { if (task.status !== "done") completeTerminal(task, false); return; }
          await sleep(Math.max(1, Math.min(250, task.cleanup!.deadline - now())));
        }
      })));
      let stopped = true;
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]!;
        if (result.status === "rejected") { stopped = false; options.emit({ kind: "shutdown-error", task: latest(tasks[index]!), message: "Original agent stop could not be confirmed; its resources were retained.", error: result.reason }); }
      }
      try {
        await ensureHerdr();
        const remaining = await readResources();
        if (remaining.length > 0) {
          stopped = false;
          options.emit({ kind: "shutdown-error", message: "The private Herdr instance still contains task resources, including any resources without an unfinished local execution; stop cannot be confirmed." });
        }
      } catch (error) {
        stopped = false;
        options.emit({ kind: "shutdown-error", message: "The private Herdr instance cannot be inspected; original stop is not confirmed.", error });
      }
      return stopped;
    },
  };
};
export type WorkerCoordinator = ReturnType<typeof createWorkerCoordinator>;
