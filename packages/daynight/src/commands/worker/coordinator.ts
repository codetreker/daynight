import { CLEANUP_OPERATION_MS, cleanupOperation } from "../cleanup-operation.js";
import { readWorkerClaim } from "../../api/task-properties.js";
import type { WebExecutionBackend } from "./backends/web.js";
import type { WebExecutionStore } from "./backends/web-store.js";
import type { WorkerSessionApi } from "./backends/session-api.js";
import { requireImplementedWorkerBackend } from "./backend.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OperationError } from "../../api/operation.js";
import type { Task, TaskPlatform, WorkerMachine, WorkerTaskInventory, WorkerTaskReference } from "../../api/types.js";
import { ensureCleanupSchedule } from "./cleanup-schedule.js";
import { WorkerCleanupError } from "./cleanup-error.js";
import { createCleanupDriver } from "./cleanup.js";
import { actualTaskPane, createExecutionDriver, executionContext, isWorkerCancellation, liveAgent, sameClaim, settleWorkerStops, workerOperation } from "./execution.js";
import type { ExecutionDependencies, ExecutionInput, WorkerEvent, WorkerGitManager } from "./execution.js";
import { HerdrAgentActionError, HerdrRpcError } from "./herdr.js";
import type { HerdrAgentObservation, HerdrOwnedWorkspace, WorkerHerdrAdapter } from "./herdr.js";
import type { ManagedAssignment } from "./prompts.js";
import type { WorkerRemote } from "./remote.js";
import type { WorkerStore } from "./store.js";
import type { ClaimIdentity, ExecutionConfiguration, LocalTask, ResourceOwner, WorkerProject } from "./types.js";

export type WorkerRepositoryAssignment = { project: WorkerProject; configuration: ExecutionConfiguration };
export type WorkerCoordinatorOptions = {
  webBackend?: WebExecutionBackend; webStore?: WebExecutionStore; verifyWebServer?: WorkerSessionApi["verifySupport"]; verifyWebUnregistered?: WorkerSessionApi["verifyUnregistered"];
  store: WorkerStore; git: WorkerGitManager; herdr: WorkerHerdrAdapter; remote: WorkerRemote;
  serverOrigin: string; workerId: string; platform: TaskPlatform; machine: WorkerMachine;
  repositories: readonly WorkerRepositoryAssignment[]; globalConfiguration: ExecutionConfiguration; maxConcurrent: number;
  buildPrompt: (assignment: ManagedAssignment, platform: TaskPlatform) => string;
  onInventory?: (inventory: WorkerTaskInventory) => void; onClaim?: (reference: WorkerTaskReference) => void;
  emit: (event: WorkerEvent) => void; signal?: AbortSignal; now?: () => number;
};
type Snapshot = { herdr: HerdrOwnedWorkspace[]; owners: Map<string, ResourceOwner>; proven: Set<string> };
const key = (identity: ClaimIdentity): string => `${identity.projectId}/${identity.taskId}/${identity.claimId}`;
const taskKey = (identity: Pick<ClaimIdentity, "projectId" | "taskId">): string => `${identity.projectId}/${identity.taskId}`;
const remoteOwner = (task: Task): ResourceOwner => {
  const claim = readWorkerClaim(task.properties);
  if (claim === undefined || claim.state !== "active") throw new Error("An actual active remote claim is required.");
  return { projectId: task.projectId, taskId: task.id, claimId: claim.claimId, worktreeId: claim.worktreeId };
};

export const createWorkerCoordinator = (options: WorkerCoordinatorOptions) => {
  const now = options.now === undefined ? Date.now : options.now;
  const deps: ExecutionDependencies = { store: options.store, git: options.git, herdr: options.herdr, readTask: options.remote.readTask, platform: options.platform, workerId: options.workerId, serverOrigin: options.serverOrigin, buildPrompt: options.buildPrompt, emit: options.emit, now };
  const execution = createExecutionDriver(deps);
  const cleanup = createCleanupDriver(deps);
  const normalSignal = options.signal === undefined ? new AbortController().signal : options.signal;
  const tails = new Map<string, Promise<void>>();
  const jobs = new Map<string, Promise<void>>();
  const controllers = new Map<string, { controller: AbortController; terminal: boolean }>();
  const ending = new Map<string, ResourceOwner>(options.store.listCleanupSchedules().map(record => [key(record), record]));
  let capacityWarning = "";
  const cleanupRetries = new Map<string, { failures: number; nextAttemptAt: number }>();
  const failures = new Map<string, number>();
  const snapshotWarnings = new Map<string, Set<string>>();
  let nextRepository = 0;
  let nextPendingProject = 0;
  let shuttingDown = false;
  let ticking = false;
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
  const configurationFor = (task: LocalTask): ExecutionConfiguration => {
    if (task.agentControlMode === "web") { const frozen = options.webStore?.getTask(task)?.configuration; if (frozen) return frozen; }
    const current = options.repositories.find((repository) => repository.project.projectId === task.projectId)?.configuration ?? options.globalConfiguration;
    return current.agent === task.agent ? { ...current, agentControlMode: task.agentControlMode ?? "herdr" } : { agent: task.agent, agentControlMode: task.agentControlMode ?? "herdr", model: null, args: [], recoveryLimit: current.recoveryLimit };
  };
  // Cleanup-only backend access stays inside its claim job and retry schedule.
  const needsHerdr = (): boolean => options.globalConfiguration.agentControlMode !== "web"
    || options.repositories.some(repository => repository.configuration.agentControlMode !== "web")
    || options.store.listUnfinishedTasks().some(task => task.agentControlMode !== "web" && !ending.has(key(task)));
  const hasHerdrCleanup = (): boolean => [...ending.values()].some(owner => options.store.getTask(owner)?.agentControlMode !== "web" && options.webStore?.getTask(owner) == null);
  const pendingStops = () => needsHerdr() || hasHerdrCleanup() ? options.herdr.tasks.pendingStops() : [];
  const ensureHerdr = async (signal?: AbortSignal): Promise<void> => { if (needsHerdr()) await workerOperation(operation => options.herdr.ensureInstance(operation), signal); };
  const listHerdr = async (signal?: AbortSignal): Promise<HerdrOwnedWorkspace[]> => needsHerdr() ? workerOperation(operation => options.herdr.tasks.listResources(operation), signal) : [];
  const snapshot = async (signal?: AbortSignal, scope?: WorkerProject, currentClaims: readonly ResourceOwner[] = []): Promise<Snapshot> => {
    const observed = await listHerdr(signal);
    const herdr = scope === undefined ? observed : observed.filter((resource) => resource.owner.projectId === scope.projectId);
    const owners = new Map<string, ResourceOwner>();
    const proven = new Set([...options.store.listTasks().map(key), ...currentClaims.map(key)]);
    const currentWarnings = new Map<string, Map<string, string>>();
    const observe = (owner: ResourceOwner): void => {
      if (options.store.getProject(owner) === null) throw new Error(`Restore the project configuration for owned resources in ${owner.projectId}.`);
      const previous = owners.get(key(owner));
      if (previous !== undefined && previous.worktreeId !== owner.worktreeId) throw new Error("The same claim has conflicting resource identities.");
      owners.set(key(owner), owner);
    };
    for (const workspace of herdr) { observe(workspace.owner); proven.add(key(workspace.owner)); }
    for (const task of options.webStore?.listUnfinishedTasks() ?? []) { if (scope === undefined || task.projectId === scope.projectId) { observe(task); proven.add(key(task)); } }
    for (const project of scope === undefined ? options.store.listProjects() : [scope]) {
      const warnings = new Map<string, string>();
      currentWarnings.set(project.projectId, warnings);
      const warn = (category: string, owner: ResourceOwner, message: string): void => {
        warnings.set(JSON.stringify([category, owner.projectId, owner.taskId, owner.claimId, owner.worktreeId]), message);
      };
      const worktrees = await workerOperation((operation) => options.git.listWorktrees(project, operation), signal);
      for (const worktree of worktrees) {
        observe(worktree.owner);
        if (!proven.has(key(worktree.owner))) warn("unproven-ownership", worktree.owner, `Preserved unproven Git ownership for ${key(worktree.owner)}; a static marker does not identify this worker.`);
      }
    }
    for (const [projectId, warnings] of currentWarnings) {
      const previous = snapshotWarnings.get(projectId);
      for (const [identity, message] of warnings) if (!previous?.has(identity)) options.emit({ kind: "warning", message });
      snapshotWarnings.set(projectId, new Set(warnings.keys()));
    }
    return { herdr, owners, proven };
  };
  const ownInventory = async (signal: AbortSignal): Promise<Map<string, Task>> => {
    const tasks = await options.remote.ownInventory(options.store.listProjects(), options.workerId, signal);
    const result = new Map<string, Task>();
    for (const task of tasks) {
      const owner = remoteOwner(task);
      if (readWorkerClaim(task.properties)!.workerId !== options.workerId) throw new Error("The claim inventory contains another worker's claim.");
      if (result.has(key(owner))) throw new Error("The claim inventory contains duplicate claims.");
      result.set(key(owner), task);
      options.store.registerPending({ projectId: task.projectId, taskId: task.id, claimId: owner.claimId, agent: readWorkerClaim(task.properties)!.agent, agentControlMode: readWorkerClaim(task.properties)!.agentControlMode });
    }
    return result;
  };
  const publishSummary = async (task: LocalTask, observed: HerdrAgentObservation, remoteTask: Task, signal: AbortSignal): Promise<void> => {
    const worker = readWorkerClaim(remoteTask.properties)!;
    const herdr = { session: observed.binding.session, workspaceId: observed.binding.workspaceId, paneId: observed.binding.paneId };
    const phase = observed.status === "blocked" ? "waiting" as const : "executing" as const;
    const nativeSessionId = observed.nativeSession?.sessionId ?? task.sessionId;
    if (worker.phase === phase && worker.nativeSessionId === nativeSessionId && worker.herdr?.session === herdr.session && worker.herdr.workspaceId === herdr.workspaceId && worker.herdr.paneId === herdr.paneId) return;
    try { await options.remote.update(remoteTask, { phase, herdr, nativeSessionId }, signal); }
    catch (error) { if (!isWorkerCancellation(error, signal)) options.emit({ kind: "summary-error", task, message: "The observed execution summary was not confirmed; the next round will read it again.", error }); }
  };
  const startJob = (identity: ClaimIdentity, action: (signal: AbortSignal) => Promise<void>, terminal: boolean): void => {
    const identityKey = key(identity);
    if (shuttingDown || jobs.has(identityKey)) return;
    const controller = new AbortController();
    controllers.set(identityKey, { controller, terminal });
    const signal = AbortSignal.any([normalSignal, controller.signal]);
    const job = serialize(identity, () => action(signal)).catch((error: unknown) => {
      if (isWorkerCancellation(error, signal)) return;
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
        // Storage failures must not reject the job or prevent shutdown from proving stop.
        cleanupRetries.set(identityKey, { failures: count, nextAttemptAt });
        try {
          previous ??= ensureCleanupSchedule(options.store, owner, now());
          options.store.saveCleanupSchedule(previous, { ...previous, failures: count, nextAttemptAt, stage, lastError: error instanceof Error ? error.message || error.name : String(error) || "Unknown cleanup error" });
          task = options.store.getTask(identity);
        } catch (storageError) { reportedError = new AggregateError([reportedError, storageError], "Cleanup failed; retry persistence is unconfirmed and in-process backoff remains active."); }
        const stopStatus = stage === "archive" || stage === "worktree-removal" || stage === "backend-close" ? "Agent stop confirmed; " : "";
        cleanupMessage = `Cleanup ${key(owner)} failed at ${stage}; ${stopStatus}next retry ${new Date(nextAttemptAt).toISOString()} (${retryMs} ms). Resources retain capacity; correct the reported cause and normal reconciliation retries automatically.`;
      } else {
        failures.set(identityKey, (failures.get(identityKey) ?? 0) + 1);
        task = options.store.getTask(identity);
      }
      options.emit({ kind: terminal ? "cleanup-error" : "execution-error", ...(task === null ? {} : { task }), message: terminal ? cleanupMessage! : "The task operation failed; this process retains its recovery count.", error: reportedError });
    }).finally(() => { if (jobs.get(identityKey) === job) { jobs.delete(identityKey); controllers.delete(identityKey); } });
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
  const runCleanup = async (owner: ResourceOwner, deleteWorktree: boolean, signal?: AbortSignal): Promise<void> => {
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
      if (webRecord.status === "done") {
        // A resource snapshot can finish after the cleanup job it observed.
        // Completed stop evidence is reusable, but present Git resources still require attention.
        if (!webRecord.cleanup?.agentStopped || !webRecord.cleanup.backendResourcesClosed || !webRecord.cleanup.worktreeDeleted) throw new Error("The completed Web execution has incomplete cleanup evidence.");
        if (deleteWorktree) {
          const retained = await cleanupOperation(operation => options.git.findWorktree(projectFor(owner), owner, operation), signal);
          if (retained !== null) throw new Error("The completed Web execution still has a worktree; its resources were retained.");
          if (local !== null && local.status !== "done") options.store.completeTask(owner);
        }
        return;
      }
      while (true) {
        const result = await options.webBackend.cleanup(webRecord, deleteWorktree ? "terminal" : "shutdown", schedule?.deadline ?? now() + 600_000, signal);
        if (result.cleanup?.agentStopped && result.cleanup.backendResourcesClosed && (!deleteWorktree || result.cleanup.worktreeDeleted)) {
          if (deleteWorktree) { options.webStore.completeTask(owner, now()); if (local) options.store.completeTask(owner); }
          return;
        }
        await delay(1000, undefined, signal === undefined ? {} : { signal });
      }
    }
    await cleanupOperation(operation => options.herdr.ensureInstance(operation), signal);
    while (true) {
      const resources = await cleanupOperation((operation) => options.herdr.tasks.listResources(operation), signal);
      const task = recordMissingClaim(owner, actualTaskPane(owner, resources));
      const completed = await cleanup.advance({ owner, project: projectFor(owner), ...(task === null ? {} : { task }) }, resources, deleteWorktree, signal);
      if (completed) {
        if (deleteWorktree && task !== null && task.status !== "done") options.store.completeTask(owner);
        return;
      }
      await delay(Math.max(1, Math.min(1_000, cleanup.remaining(owner))), undefined, signal === undefined ? {} : { signal });
    }
  };
  const launchCleanups = (): void => {
    for (const [identityKey, owner] of ending) {
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
      }, true);
    }
  };
  const syncWorkspaceName = async (task: LocalTask, owner: ResourceOwner, title: string, signal: AbortSignal): Promise<void> => {
    const pending = pendingStops().filter((stop) => sameClaim(stop.context, owner));
    if (pending.some((stop) => stop.context.worktreeId !== owner.worktreeId)) throw new Error("The claim has conflicting pending Herdr stop identities.");
    if (pending.length > 0) return;
    let workspaceId: string | null = null;
    try {
      const resources = await workerOperation((operation) => options.herdr.tasks.listResources(operation), signal);
      const pane = actualTaskPane(owner, resources);
      if (pane === undefined) return;
      workspaceId = pane.binding.workspaceId;
      await workerOperation((operation) => options.herdr.tasks.syncWorkspaceName(
        executionContext({ task, owner, project: projectFor(task) }), pane.binding, title, operation,
      ), signal);
    } catch (error) {
      if (isWorkerCancellation(error, signal)) throw error;
      const snapshotFailure = (error instanceof HerdrRpcError && error.method === "session.snapshot")
        || (error instanceof OperationError && error.kind === "deadline");
      if (!snapshotFailure && (!(error instanceof HerdrAgentActionError) || error.action !== "workspace.rename")) throw error;
      const subject = workspaceId === null ? `workspace discovery for worktree ${owner.worktreeId}` : `workspace ${workspaceId}, worktree ${owner.worktreeId}`;
      options.emit({ kind: "workspace-name-error", task, message: `Could not confirm workspace.rename for ${subject}; the next inventory will observe its name again.`, error });
    }
  };
  const ensure = async (task: LocalTask, remoteTask: Task, signal: AbortSignal, execute = true): Promise<void> => {
    if (ending.has(key(task))) return;
    const owner = remoteOwner(remoteTask);
    if (!sameClaim(task, owner) || readWorkerClaim(remoteTask.properties)!.workerId !== options.workerId || readWorkerClaim(remoteTask.properties)!.agent !== task.agent || readWorkerClaim(remoteTask.properties)!.agentControlMode !== (task.agentControlMode ?? "herdr")) throw new Error("The local execution does not match the observed original worker claim.");
    if (task.agentControlMode === "web") {
      if (!options.webStore || !options.webBackend) throw new Error("The Web execution backend is unavailable.");
      const configuration = configurationFor(task);
      const worker = readWorkerClaim(remoteTask.properties)!;
      let record = options.webStore.getTask(task);
      if (record !== null && (record.worktreeId !== owner.worktreeId || record.workerId !== options.workerId || record.userId !== worker.userId || record.serverOrigin !== options.serverOrigin)) throw new Error("The durable Web execution does not match the observed original worker claim.");
      let observed = false;
      try {
        if (!execute) {
          if (record !== null && record.recovery.pauseReason === null) record = options.webStore.pauseRecovery(record, "The Web execution failure limit was reached; explicit retry is required.", now());
        } else if (record === null || record.recovery.pauseReason === null || record.recovery.retryAuthorized) {
          requireImplementedWorkerBackend(configuration);
          await options.verifyWebServer?.(configuration.agent, signal);
          if (record === null) {
            if (!options.verifyWebUnregistered) throw new Error("Web launch provenance cannot be verified.");
            await options.verifyWebUnregistered(task, signal);
            if (task.sessionId !== null || worker.nativeSessionId !== null) throw new Error("The original native identity has no local Web execution evidence.");
          }
          record = options.webStore.register({ ...owner, project: projectFor(task), serverOrigin: options.serverOrigin, workerId: options.workerId, userId: worker.userId, configuration }, now());
          if (record.cleanup !== null) record = options.webStore.clearShutdown(record, now());
          record = await options.webBackend.advance(record, signal);
          observed = true;
        }
      } catch (error) {
        if (isWorkerCancellation(error, signal)) throw error;
        record = options.webStore.getTask(task);
        if (record !== null && record.cleanup === null && (record.recovery.retryAuthorized || (failures.get(key(task)) ?? 0) + 1 > configuration.recoveryLimit)) {
          record = options.webStore.pauseRecovery(record, error instanceof Error ? error.message : String(error), now());
        }
        throw error;
      } finally {
        // Summary transport is independent of native recovery and must remain live while paused.
        record = options.webStore.getTask(task);
        if (!signal.aborted && (observed || !execute || record?.recovery.pauseReason != null)) {
          const nativeSessionId = record?.resources.nativeSession?.sessionId ?? task.sessionId ?? worker.nativeSessionId;
          if (nativeSessionId !== null) options.store.setSessionId(task, nativeSessionId);
          const phase = !execute || record?.recovery.pauseReason != null || record?.recovery.retryAuthorized
            || record?.webExecution?.activity === "initializing" ? "waiting" as const : "executing" as const;
          if (worker.phase !== phase || worker.nativeSessionId !== nativeSessionId || worker.herdr !== null) {
            try { await options.remote.update(remoteTask, { phase, nativeSessionId, herdr: null }, signal); }
            catch (error) { if (!isWorkerCancellation(error, signal)) options.emit({ kind: "summary-error", task, message: "The Web execution summary was not confirmed; the next round will read it again.", error }); }
          }
        }
      }
      return;
    }
    await syncWorkspaceName(task, owner, remoteTask.title, signal);
    if (!execute) return;
    const input: ExecutionInput = { task, project: projectFor(task), owner, title: remoteTask.title, configuration: configurationFor(task) };
    const observed = await execution.advance(input, signal);
    const latest = options.store.getTask(task)!;
    await publishSummary(latest, observed, remoteTask, signal);
  };
  const capacity = (resources: Snapshot): number => new Set([
    ...options.store.listUnfinishedTasks().filter((task) => task.status === "active").map(key), ...[...resources.owners.keys()].filter((identity) => resources.proven.has(identity)),
    ...ending.keys(), ...pendingStops().map((stop) => key(stop.context)),
  ]).size;
  const blockedByOldClaim = (task: LocalTask, owners: Iterable<ResourceOwner>): boolean =>
    options.store.listUnfinishedTasks().some((other) => other.projectId === task.projectId && other.taskId === task.taskId && other.claimId !== task.claimId && other.status === "active")
    || [...owners, ...ending.values(), ...pendingStops().map((stop) => stop.context)].some((owner) => owner.projectId === task.projectId && owner.taskId === task.taskId && owner.claimId !== task.claimId);
  const schedule = (task: LocalTask, remoteTask: Task): void => {
    if (jobs.has(key(task)) || ending.has(key(task))) return;
    const count = failures.get(key(task)) ?? 0;
    startJob(task, (signal) => ensure(task, remoteTask, signal, count <= configurationFor(task).recoveryLimit), false);
  };
  const reconcile = async (): Promise<void> => {
    launchCleanups();
    await options.remote.currentUserId(normalSignal);
    const inventory = await ownInventory(normalSignal);
    options.onInventory?.({ observedAt: new Date(now()).toISOString(), claims: [...inventory.values()].map(task => ({ projectId: task.projectId, taskId: task.id, claimId: readWorkerClaim(task.properties)!.claimId })) });
    // Ownership loss is authoritative even when the following resource observations fail.
    for (const local of options.store.listUnfinishedTasks()) {
      if (inventory.has(key(local))) continue;
      const running = controllers.get(key(local));
      if (running !== undefined && !running.terminal) running.controller.abort(new Error("The original claim no longer belongs to this worker."));
      execution.forget(local);
    }
    await ensureHerdr(normalSignal);
    const observed = await listHerdr(normalSignal);
    const knownOwners = [...observed.map((workspace) => workspace.owner), ...pendingStops().map((stop) => stop.context), ...(options.webStore?.listUnfinishedTasks() ?? [])];
    for (const owner of knownOwners) {
      if (options.store.getProject(owner) === null || inventory.has(key(owner))) continue;
      ending.set(key(owner), owner);
    }
    launchCleanups();
    for (const remoteTask of inventory.values()) {
      const local = options.store.getTask(remoteOwner(remoteTask))!;
      if (local.status === "active" && !blockedByOldClaim(local, knownOwners)) schedule(local, remoteTask);
    }
    const resources = await snapshot(normalSignal, undefined, [...inventory.values()].map((task) => remoteOwner(task)));
    for (const [identityKey, owner] of resources.owners) {
      if (resources.proven.has(identityKey) && !inventory.has(identityKey)) ending.set(identityKey, owner);
    }
    for (const local of options.store.listUnfinishedTasks()) {
      if (inventory.has(key(local))) continue;
      const owner = resources.owners.get(key(local));
      if (owner !== undefined) ending.set(key(local), owner);
      else if (!jobs.has(key(local)) && !ending.has(key(local))) {
        if (local.agentControlMode === "web") {
          if (!options.verifyWebUnregistered || local.sessionId !== null) throw new Error("The ended Web claim has no original resource evidence; its ownership record is retained.");
          await options.verifyWebUnregistered(local, normalSignal, CLEANUP_OPERATION_MS);
        }
        options.store.completeTask(local);
      }
    }
    launchCleanups();
    for (const [identityKey, remoteTask] of inventory) {
      let local = options.store.getTask(remoteOwner(remoteTask))!;
      if (resources.owners.has(identityKey) && local.status === "pending" && !blockedByOldClaim(local, resources.owners.values())) {
        local = options.store.activateTask(local);
        schedule(local, remoteTask);
      }
    }
    const projects = options.store.listProjects();
    while (capacity(resources) < options.maxConcurrent && projects.length > 0) {
      let started = false;
      for (let turn = 0; turn < projects.length; turn++) {
        const project = projects[nextPendingProject % projects.length]!;
        nextPendingProject = (nextPendingProject + 1) % projects.length;
        const pending = options.store.listUnfinishedTasks().filter((task) => task.projectId === project.projectId && task.status === "pending").sort((left, right) => left.taskId.localeCompare(right.taskId));
        const local = pending.find((task) => inventory.has(key(task)) && !blockedByOldClaim(task, resources.owners.values()));
        if (local === undefined) continue;
        schedule(options.store.activateTask(local), inventory.get(key(local))!);
        started = true;
        break;
      }
      if (!started) break;
    }
    const blocked = capacity(resources) >= options.maxConcurrent
      ? [...ending.keys()].filter(identity => options.store.getCleanupSchedule(ending.get(identity)!)?.lastError != null).sort() : [];
    const warning = blocked.join(",");
    if (warning !== capacityWarning) {
      capacityWarning = warning;
      if (warning !== "") options.emit({ kind: "cleanup-capacity-blocked", message: `Worker capacity is full; failed cleanup retains ${blocked.length} slot(s). ${blocked.map(identity => { const state = options.store.getCleanupSchedule(ending.get(identity)!)!; return `${identity}: ${state.stage}, next retry ${new Date(state.nextAttemptAt).toISOString()}, ${state.lastError}`; }).join("; ")}. Correct the reported resource or archive failure; retries are automatic. No slot is released until cleanup is confirmed.` });
    }
    if (capacity(resources) >= options.maxConcurrent || options.repositories.length === 0) return;
    const candidates = new Map<number, AsyncGenerator<Task>>();
    const exhausted = new Set<number>();
    try {
      while (capacity(resources) < options.maxConcurrent && exhausted.size < options.repositories.length) {
        const index = nextRepository % options.repositories.length;
        nextRepository = (nextRepository + 1) % options.repositories.length;
        if (exhausted.has(index)) continue;
        const repository = options.repositories[index]!;
        let page = candidates.get(index);
        if (page === undefined) {
          page = options.remote.candidates(repository.project.projectId, options.platform, normalSignal);
          candidates.set(index, page);
        }
        const next = await page.next();
        if (next.done) { exhausted.add(index); continue; }
        const candidate = next.value;
        requireImplementedWorkerBackend(repository.configuration);
        if (repository.configuration.agentControlMode === "web") await options.verifyWebServer?.(repository.configuration.agent, normalSignal);
        const claimId = randomUUID();
        try {
          const granted = await options.remote.claim(candidate, { claimId, workerId: options.workerId, machine: options.machine, platform: options.platform, agent: repository.configuration.agent, ...(repository.configuration.agentControlMode === "web" ? { agentControlMode: "web" as const } : {}), worktreeId: randomUUID() }, normalSignal);
          const owner = remoteOwner(granted);
          const local = options.store.registerPending({ projectId: granted.projectId, taskId: granted.id, claimId: owner.claimId, agent: readWorkerClaim(granted.properties)!.agent, agentControlMode: readWorkerClaim(granted.properties)!.agentControlMode });
          options.onClaim?.({ projectId: granted.projectId, taskId: granted.id, claimId: owner.claimId });
          if (!blockedByOldClaim(local, resources.owners.values()) && capacity(resources) < options.maxConcurrent) schedule(options.store.activateTask(local), granted);
        } catch (error) {
          if (isWorkerCancellation(error, normalSignal)) throw error;
          options.emit({ kind: "warning", message: `Claim request for ${candidate.projectId}/${candidate.id}/${claimId} did not confirm a grant; the next complete inventory will reconcile it.`, error });
          return;
        }
      }
    } finally {
      await Promise.all([...candidates.values()].map((page) => page.return(undefined)));
    }
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
    tick: async (): Promise<void> => {
      if (shuttingDown || ticking) return;
      ticking = true;
      try { await reconcile(); } finally { ticking = false; }
    },
    advanceRetry: async (identity: ClaimIdentity): Promise<void> => {
      const { task, remoteTask } = await readSource(identity);
      if (task.status !== "active") throw new Error("Only an active original claim may be retried; pending work is started by worker run.");
      const webRecord = task.agentControlMode === "web" ? options.webStore?.getTask(task) : null;
      const worker = readWorkerClaim(remoteTask.properties)!;
      if (task.agentControlMode === "web" && !webRecord) throw new Error("Retry requires the original Web execution evidence; it cannot start a replacement assignment.");
      if (webRecord && (webRecord.worktreeId !== worker.worktreeId || webRecord.workerId !== worker.workerId || webRecord.userId !== worker.userId || webRecord.serverOrigin !== options.serverOrigin)) throw new Error("The original Web execution ownership no longer matches the active claim.");
      failures.delete(key(identity));
      await ensureHerdr(normalSignal);
      await serialize(identity, async () => {
        if (task.agentControlMode === "web" && options.webStore) {
          let record = options.webStore.getTask(task);
          if (record !== null) {
            if (record.cleanup !== null) record = options.webStore.clearShutdown(record, now());
            options.webStore.authorizeRecoveryRetry(record, now());
          }
        }
        await ensure(task, remoteTask, normalSignal);
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
      let complete = true;
      for (const task of options.store.listUnfinishedTasks()) if (task.agentControlMode === "web" && options.webStore?.getTask(task) == null) {
        if (task.status === "pending" && task.sessionId === null && options.verifyWebUnregistered) {
          try { await options.verifyWebUnregistered(task, new AbortController().signal, CLEANUP_OPERATION_MS); continue; }
          catch { /* Missing launch evidence must not be interpreted as a confirmed native stop. */ }
        }
        complete = false;
        options.emit({ kind: "shutdown-error", task, message: "The original Web execution evidence is missing; complete native stop cannot be confirmed." });
      }
      const owners = new Map(ending);
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
              if (webRecord.status === "done") {
                if (!webRecord.cleanup?.agentStopped || !webRecord.cleanup.backendResourcesClosed || !webRecord.cleanup.worktreeDeleted) throw new Error("The completed Web execution has incomplete cleanup evidence.");
                return;
              }
              if (!options.webBackend) throw new Error("The Web execution backend is unavailable during shutdown.");
              await options.webBackend.cleanup(webRecord, "shutdown", now(), undefined, true);
              return;
            }
            if (options.store.getTask(owner)?.agentControlMode === "web") return;
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
