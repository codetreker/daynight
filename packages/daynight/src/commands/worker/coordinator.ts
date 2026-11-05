import { CLEANUP_OPERATION_MS, cleanupOperation } from "../cleanup-operation.js";
import { readWorkerClaim, readSessionStartupReport } from "../../api/task-properties.js";
import { sameStartupReport, type SessionStartupReport } from "../../session/startup.js";
import { WebRecoveryBlockedError, type WebExecutionBackend } from "./backends/web.js";
import type { WebExecutionStore } from "./backends/web-store.js";
import type { WorkerSessionApi } from "./backends/session-api.js";
import { requireImplementedWorkerBackend } from "./backend.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OperationError } from "../../api/operation.js";
import type { Task, TaskPlatform, WorkerMachine, WorkerTaskInventory, WorkerTaskReference } from "../../api/types.js";
import { ensureCleanupSchedule } from "./cleanup-schedule.js";
import { WorkerCleanupError } from "./cleanup-error.js";
import { createCleanupDriver } from "./cleanup.js";
import { assertHerdrResourceBudget, reconcileDeletedHerdrResource } from "./resource-disposal.js";
import { actualTaskPane, createExecutionDriver, executionContext, isWorkerCancellation, liveAgent, sameClaim, settleWorkerStops, workerOperation } from "./execution.js";
import type { ExecutionDependencies, ExecutionInput, WorkerEvent, WorkerGitManager } from "./execution.js";
import { HerdrAgentActionError, HerdrRpcError } from "./herdr.js";
import { HerdrInputBlockedError } from "./herdr/agents.js";
import type { HerdrAgentObservation, HerdrOwnedWorkspace, WorkerHerdrAdapter } from "./herdr.js";
import type { ManagedAssignment } from "./prompts.js";
import type { WorkerRemote } from "./remote.js";
import type { WorkerStore } from "./store.js";
import type { ClaimIdentity, ExecutionConfiguration, LocalTask, ResourceOwner, WorkerProject } from "./types.js";

export type WorkerRepositoryAssignment = { project: WorkerProject; configuration: ExecutionConfiguration };
export type WorkerCoordinatorOptions = {
  hasHerdrJournal?: boolean;
  availableDiskBytes?: () => bigint;
  webBackend?: Pick<WebExecutionBackend, "advance" | "cleanup"> & Partial<Pick<WebExecutionBackend, "observeStartupReport">>;
  webStore?: WebExecutionStore; verifyWebServer?: WorkerSessionApi["verifySupport"]; verifyWebUnregistered?: WorkerSessionApi["verifyUnregistered"];
  verifyWebStartupReporting?: WorkerSessionApi["supportsStartupReports"];
  store: WorkerStore; git: WorkerGitManager; herdr: WorkerHerdrAdapter; remote: WorkerRemote;
  serverOrigin: string; workerId: string; platform: TaskPlatform; machine: WorkerMachine;
  readyProjectIds?: readonly string[]; targetProjectIds?: readonly string[];
  repositories: readonly WorkerRepositoryAssignment[]; globalConfiguration: ExecutionConfiguration | null; maxConcurrent: number;
  buildPrompt: (assignment: ManagedAssignment, platform: TaskPlatform) => string;
  onInventory?: (inventory: WorkerTaskInventory) => void; onClaim?: (reference: WorkerTaskReference) => void;
  emit: (event: WorkerEvent) => void; signal?: AbortSignal; now?: () => number;
};
export type WorkerCoordinatorConfiguration = Pick<WorkerCoordinatorOptions, "repositories" | "globalConfiguration" | "maxConcurrent" | "readyProjectIds" | "targetProjectIds">;

const configurationView = (value: WorkerCoordinatorConfiguration): WorkerCoordinatorConfiguration => Object.freeze({
  maxConcurrent: value.maxConcurrent,
  ...(value.readyProjectIds === undefined ? {} : { readyProjectIds: Object.freeze([...value.readyProjectIds]) }),
  ...(value.targetProjectIds === undefined ? {} : { targetProjectIds: Object.freeze([...value.targetProjectIds]) }),
  globalConfiguration: value.globalConfiguration === null ? null : Object.freeze({ ...value.globalConfiguration, args: Object.freeze([...value.globalConfiguration.args]) }),
  repositories: Object.freeze(value.repositories.map(repository => Object.freeze({ project: Object.freeze({ ...repository.project }), configuration: Object.freeze({ ...repository.configuration, args: Object.freeze([...repository.configuration.args]) }) }))),
});

type CleanupTarget = ClaimIdentity & { worktreeId?: string };
const hasWorktreeIdentity = (target: CleanupTarget): target is ResourceOwner => target.worktreeId !== undefined;
type Snapshot = { herdr: HerdrOwnedWorkspace[]; owners: Map<string, ResourceOwner>; proven: Set<string>; unresolved: Set<string>; scannedProjects: Set<string>; unavailableProjects: Set<string> };
const key = (identity: ClaimIdentity): string => `${identity.projectId}/${identity.taskId}/${identity.claimId}`;
const taskKey = (identity: Pick<ClaimIdentity, "projectId" | "taskId">): string => `${identity.projectId}/${identity.taskId}`;
const remoteOwner = (task: Task): ResourceOwner => {
  const claim = readWorkerClaim(task.properties);
  if (claim === undefined || claim.state !== "active") throw new Error("An actual active remote claim is required.");
  return { projectId: task.projectId, taskId: task.id, claimId: claim.claimId, worktreeId: claim.worktreeId };
};

export const createWorkerCoordinator = (options: WorkerCoordinatorOptions) => {
  const now = options.now === undefined ? Date.now : options.now;
  let configuration = configurationView(options);
  const selected = (projectId: string): boolean => configuration.readyProjectIds === undefined ? configuration.repositories.some(repository => repository.project.projectId === projectId) : configuration.readyProjectIds.includes(projectId);
  const stoppedProjects = new Set<string>();
  const projectStops = new Map<string, Promise<void>>();
  const canAdvanceProject = (projectId: string): boolean => selected(projectId)
    && (configuration.targetProjectIds === undefined || configuration.targetProjectIds.includes(projectId))
    && !projectStops.has(projectId);
  const deps: ExecutionDependencies = { store: options.store, git: options.git, herdr: options.herdr, readTask: options.remote.readTask, platform: options.platform, workerId: options.workerId, serverOrigin: options.serverOrigin, buildPrompt: options.buildPrompt, emit: options.emit, now };
  const execution = createExecutionDriver(deps);
  const cleanup = createCleanupDriver(deps);
  const normalSignal = options.signal === undefined ? new AbortController().signal : options.signal;
  const tails = new Map<string, Promise<void>>();
  const jobs = new Map<string, Promise<void>>();
  const controllers = new Map<string, { controller: AbortController; terminal: boolean }>();
  const ending = new Map<string, CleanupTarget>(options.store.listCleanupSchedules().map(record => [key(record), record]));
  let capacityWarning = "";
  const cleanupRetries = new Map<string, { failures: number; nextAttemptAt: number; stage: string; lastError: string }>();
  const failures = new Map<string, number>();
  const inputWaiting = new Map<string, string>();
  const snapshotWarnings = new Map<string, Set<string>>();
  let nextRepository = 0;
  let nextPendingProject = 0;
  let shuttingDown = false;
  let ticking = false;
  let archiveJob: Promise<void> | null = null;
  let archiveCursor = "";
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
  const configurationFor = (task: LocalTask): ExecutionConfiguration | null => {
    if (task.agentControlMode === "web") { const frozen = options.webStore?.getTask(task)?.configuration; if (frozen) return frozen; }
    const repository = configuration.repositories.find(repository => repository.project.projectId === task.projectId);
    if (repository === undefined && (configuration.targetProjectIds?.includes(task.projectId) || configuration.targetProjectIds === undefined && configuration.readyProjectIds !== undefined && selected(task.projectId))) return null;
    const current = repository?.configuration ?? configuration.globalConfiguration;
    if (current === null) return null;
    return current.agent === task.agent ? { ...current, agentControlMode: task.agentControlMode ?? "herdr" } : { agent: task.agent, agentControlMode: task.agentControlMode ?? "herdr", model: null, args: [], recoveryLimit: current.recoveryLimit };
  };
  const canAdvance = (task: LocalTask): boolean => canAdvanceProject(task.projectId) && configurationFor(task) !== null;
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
  const snapshot = async (signal: AbortSignal, coveredProjects: ReadonlySet<string>, currentClaims: readonly ResourceOwner[] = []): Promise<Snapshot> => {
    const observed = await listHerdr(signal);
    const herdr = observed;
    const owners = new Map<string, ResourceOwner>();
    const proven = new Set([...options.store.listTasks().map(key), ...currentClaims.map(key)]);
    const unresolved = new Set<string>();
    const scannedProjects = new Set<string>();
    const unavailableProjects = new Set<string>();
    const currentWarnings = new Map<string, Map<string, string>>();
    const observe = (owner: ResourceOwner): void => {
      if (options.store.getProject(owner) === null) throw new Error(`Restore the project configuration for owned resources in ${owner.projectId}.`);
      const previous = owners.get(key(owner));
      if (previous !== undefined && previous.worktreeId !== owner.worktreeId) throw new Error("The same claim has conflicting resource identities.");
      owners.set(key(owner), owner);
    };
    for (const owner of responsibilities()) {
      observe(owner); proven.add(key(owner));
    }
    for (const workspace of herdr) { observe(workspace.owner); proven.add(key(workspace.owner)); }
    for (const task of options.webStore?.listUnfinishedTasks() ?? []) { observe(task); proven.add(key(task)); }
    for (const project of options.store.listProjects()) {
      scannedProjects.add(project.projectId);
      const warnings = new Map<string, string>();
      currentWarnings.set(project.projectId, warnings);
      const warn = (category: string, owner: ResourceOwner, message: string): void => {
        warnings.set(JSON.stringify([category, owner.projectId, owner.taskId, owner.claimId, owner.worktreeId]), message);
      };
      let worktrees: Awaited<ReturnType<WorkerGitManager["listWorktrees"]>>;
      try { worktrees = await workerOperation((operation) => options.git.listWorktrees(project, operation), signal); }
      catch (error) {
        if (isWorkerCancellation(error, signal ?? normalSignal)) throw error;
        unavailableProjects.add(project.projectId);
        warnings.set("discovery", `Could not inspect Git worktrees for project ${project.projectId}; its pending work and claims remain fenced.`);
        continue;
      }
      for (const worktree of worktrees) {
        observe(worktree.owner);
        if (!proven.has(key(worktree.owner))) {
          if (!coveredProjects.has(project.projectId)) unresolved.add(key(worktree.owner));
          else warn("unproven-ownership", worktree.owner, `Preserved unproven Git ownership for ${key(worktree.owner)}; a static marker does not identify this worker.`);
        }
      }
    }
    for (const [projectId, warnings] of currentWarnings) {
      const previous = snapshotWarnings.get(projectId);
      for (const [identity, message] of warnings) if (!previous?.has(identity)) options.emit({ kind: "warning", message });
      snapshotWarnings.set(projectId, new Set([...warnings.keys(), ...(coveredProjects.has(projectId) ? [] : previous ?? [])]));
    }
    return { herdr, owners, proven, unresolved, scannedProjects, unavailableProjects };
  };
  const ownInventory = async (projects: readonly WorkerProject[], signal: AbortSignal): Promise<Map<string, Task>> => {
    const tasks = await options.remote.ownInventory(projects, options.workerId, signal);
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
    if (shuttingDown || jobs.has(identityKey) || !terminal && !canAdvanceProject(identity.projectId)) return;
    const controller = new AbortController();
    controllers.set(identityKey, { controller, terminal });
    const signal = AbortSignal.any([normalSignal, controller.signal]);
    const job = serialize(identity, () => !terminal && !canAdvanceProject(identity.projectId) ? Promise.resolve() : action(signal)).then(() => { inputWaiting.delete(identityKey); }).catch((error: unknown) => {
      if (isWorkerCancellation(error, signal)) return;
      if (!terminal && error instanceof HerdrInputBlockedError) {
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
  const finishShutdown = async (record: NonNullable<ReturnType<WebExecutionStore["getTask"]>>, signal: AbortSignal) => {
    if (!options.webBackend || !options.webStore || record.cleanup?.kind !== "shutdown") throw new Error("Only an original shutdown may resume ordinary Web execution.");
    const stopped = await options.webBackend.cleanup(record, "shutdown", now(), signal, true);
    if (!stopped.complete) throw new Error("The original Web resources remain before restart.");
    return options.webStore.clearShutdown(stopped.task, now());
  };
  const ensure = async (task: LocalTask, remoteTask: Task, signal: AbortSignal, execute = true): Promise<void> => {
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
      try {
        if (!execute) {
          if (record !== null && record.recovery.pauseReason === null) record = options.webStore.pauseRecovery(record, "The Web execution failure limit was reached; explicit retry is required.", now(), "recovery_limit");
        } else if (record === null || record.recovery.pauseReason === null || record.recovery.retryAuthorized) {
          requireImplementedWorkerBackend(configuration);
          await options.verifyWebServer?.(configuration.agent, signal);
          if (record === null) {
            if (!options.verifyWebUnregistered) throw new Error("Web launch provenance cannot be verified.");
            await options.verifyWebUnregistered(task, signal);
            if (task.sessionId !== null || worker.nativeSessionId !== null) throw new Error("The original native identity has no local Web execution evidence.");
          }
          record = options.webStore.register({ ...owner, project: projectFor(task), serverOrigin: options.serverOrigin, workerId: options.workerId, userId: worker.userId, configuration }, now());
          if (record.cleanup !== null) record = await finishShutdown(record, signal);
          record = await options.webBackend.advance(record, signal);
          observed = true;
        }
      } catch (error) {
        if (isWorkerCancellation(error, signal)) throw error;
        record = options.webStore.getTask(task);
        if (record !== null && record.cleanup === null && (record.recovery.retryAuthorized || (failures.get(key(task)) ?? 0) + 1 > configuration.recoveryLimit)) {
          record = options.webStore.pauseRecovery(record, error instanceof Error ? error.message : String(error), now(), error instanceof WebRecoveryBlockedError ? error.reasonCode : record.recovery.retryAuthorized ? "recovery_blocked" : "recovery_limit");
        }
        throw error;
      } finally {
        // Summary transport is independent of native recovery and must remain live while paused.
        record = options.webStore.getTask(task);
        if (!signal.aborted && (observed || !execute || record !== null)) {
          const nativeSessionId = record?.resources.nativeSession?.sessionId ?? task.sessionId ?? worker.nativeSessionId;
          if (nativeSessionId !== null) options.store.setSessionId(task, nativeSessionId);
          const phase = !execute || record?.recovery.pauseReason != null || record?.recovery.retryAuthorized
            || record?.webExecution?.activity === "initializing" ? "waiting" as const : "executing" as const;
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
      return;
    }
    await syncWorkspaceName(task, owner, remoteTask.title, signal);
    if (!execute) return;
    const currentConfiguration = configurationFor(task);
    if (currentConfiguration === null) return;
    const input: ExecutionInput = { task, project: projectFor(task), owner, title: remoteTask.title, configuration: currentConfiguration };
    const observed = await execution.advance(input, signal);
    const latest = options.store.getTask(task)!;
    await publishSummary(latest, observed, remoteTask, signal);
  };
  const capacity = (resources: Snapshot): number => {
    const stopped = new Set(responsibilities().filter(isStopped).map(key));
    const live = new Set([...resources.herdr.map(resource => key(resource.owner)), ...pendingStops().map(stop => key(stop.context)), ...ending.keys(), ...controllers.keys()]);
    return new Set([
      ...options.store.listUnfinishedTasks().filter(task => task.status === "active").map(key),
      ...[...resources.owners.keys()].filter(identity => resources.proven.has(identity)),
      ...resources.unresolved,
      // An unreadable repository cannot disprove an unfinished Git-only owner.
      ...options.store.listUnfinishedTasks().filter(task => resources.unavailableProjects.has(task.projectId)).map(key),
      ...ending.keys(), ...pendingStops().map(stop => key(stop.context)),
    ].filter(identity => {
      if (stopped.has(identity) && controllers.get(identity)?.terminal !== false) return false;
      const owner = resources.owners.get(identity) ?? options.store.listTasks().find(task => key(task) === identity);
      return owner === undefined || canAdvanceProject(owner.projectId) || !stoppedProjects.has(owner.projectId) || live.has(identity);
    })).size;
  };
  const blockedByOldClaim = (task: LocalTask, owners: Iterable<ResourceOwner>): boolean =>
    options.store.listUnfinishedTasks().some((other) => other.projectId === task.projectId && other.taskId === task.taskId && other.claimId !== task.claimId && other.status === "active")
    || [...owners, ...ending.values(), ...pendingStops().map((stop) => stop.context)].some((owner) => owner.projectId === task.projectId && owner.taskId === task.taskId && owner.claimId !== task.claimId);
  const schedule = (task: LocalTask, remoteTask: Task): void => {
    if (!canAdvance(task) || jobs.has(key(task)) || ending.has(key(task))) return;
    const count = failures.get(key(task)) ?? 0;
    startJob(task, signal => {
      if (!canAdvance(task)) return Promise.resolve();
      const current = configurationFor(task);
      return current === null ? Promise.resolve() : ensure(task, remoteTask, signal, count <= current.recoveryLimit);
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
    const operationSignal = signal === undefined ? normalSignal : AbortSignal.any([normalSignal, signal]);
    const operation = (async () => {
      await Promise.all([...jobs].filter(([identity]) => identity.startsWith(`${projectId}/`)).map(([, job]) => job));
      operationSignal.throwIfAborted();
      const local = options.store.listUnfinishedTasks().filter(task => task.projectId === projectId);
      const webMissing = local.filter(task => task.agentControlMode === "web" && options.webStore?.getTask(task) == null);
      const missingResults = await Promise.allSettled(webMissing.map(async task => {
        if (task.status !== "pending" || task.sessionId !== null || !options.verifyWebUnregistered) throw new Error("The original Web execution evidence is missing; stop is unconfirmed.");
        await options.verifyWebUnregistered(task, operationSignal, CLEANUP_OPERATION_MS);
      }));
      const webOwners = (options.webStore?.listUnfinishedTasks() ?? []).filter(owner => owner.projectId === projectId);
      const webResults = await Promise.allSettled(webOwners.map(owner => serialize(owner, () => stopOwner(owner, operationSignal))));
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
      const results = await Promise.allSettled([...owners.values()].filter(owner => !webKeys.has(key(owner)) && !conflicting.has(key(owner))).map(owner => serialize(owner, () => stopOwner(owner, operationSignal))));
      failures.push(...results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
      if (failures.length > 0) throw new AggregateError(failures, "Project execution stop was not confirmed.");
      operationSignal.throwIfAborted();
      if (selected(projectId) && (configuration.targetProjectIds === undefined || configuration.targetProjectIds.includes(projectId))) stoppedProjects.delete(projectId);
      else stoppedProjects.add(projectId);
    })().finally(() => { projectStops.delete(projectId); });
    projectStops.set(projectId, operation);
    return operation;
  };
  const reconcileDeletedArchives = (): void => {
    for (const resource of lifecycle()?.archive?.resources() ?? []) {
      const identity = key(resource.owner);
      if (!resource.worktreeDeleted || jobs.has(identity)) continue;
      try {
        const pending = ending.get(identity);
        if (pending && hasWorktreeIdentity(pending) && pending.worktreeId !== resource.owner.worktreeId) throw new Error("The pending cleanup belongs to another original worktree.");
        reconcileDeletedHerdrResource(options.store, resource);
        ending.delete(identity); cleanupRetries.delete(identity);
        const task = options.store.getTask(resource.owner); if (task !== null) execution.forget(task);
      } catch (error) {
        options.emit({ kind: "cleanup-error", message: `Herdr deleted-resource reconciliation for ${identity} remains incomplete; the original deletion evidence is retained for retry.`, error });
      }
    }
  };
  const advanceArchive = (inventory: ReadonlyMap<string, Task>, coveredProjects: ReadonlySet<string>): void => {
    const archive = lifecycle()?.archive;
    if (!archive || archiveJob !== null || shuttingDown) return;
    const candidates = archive.resources().filter(resource => resource.stopped && !resource.worktreeDeleted
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
    const job = serialize(owner, async () => {
      if (!isStopped(owner)) throw new Error("The retained original execution no longer has confirmed stop evidence.");
      const ready = await cleanupOperation(operation => archive.advance(owner, operation), normalSignal);
      if (!ready) return;
      try {
        await cleanupOperation(operation => options.git.removeWorktree(projectFor(owner), owner, operation), normalSignal);
        if (await cleanupOperation(operation => options.git.findWorktree(projectFor(owner), owner, operation), normalSignal) !== null) throw new Error("The original archived worktree still exists after cleanup.");
        archive.cleaned(owner);
        const deleted = archive.resources().find(resource => resource.sessionId === selected.sessionId && sameClaim(resource.owner, owner) && resource.owner.worktreeId === owner.worktreeId);
        if (!deleted || !reconcileDeletedHerdrResource(options.store, deleted)) throw new Error("The original archive deletion has no durable readback.");
        ending.delete(key(owner));
        cleanupRetries.delete(key(owner));
      } catch (error) {
        const previous = ensureCleanupSchedule(options.store, owner, now()), failures = previous.failures + 1;
        options.store.saveCleanupSchedule(previous, { ...previous, failures, nextAttemptAt: now() + Math.min(300_000, 5000 * 2 ** Math.min(failures - 1, 6)), stage: "worktree-removal", lastError: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }).catch(error => {
      if (!isWorkerCancellation(error, normalSignal)) options.emit({ kind: "cleanup-error", message: `Herdr archive finalization for ${key(owner)} remains incomplete; the original source and resource responsibility are retained.`, error });
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
    reconcileNeverStarted();
    reconcileDeletedArchives();
    launchCleanups();
    await options.remote.currentUserId(normalSignal);
    const inventoryProjects = options.store.listProjects();
    const coveredProjects = new Set(inventoryProjects.map(project => project.projectId));
    const inventory = await ownInventory(inventoryProjects, normalSignal);
    await retireNeverStarted(inventory, coveredProjects);
    advanceArchive(inventory, coveredProjects);
    if (options.store.listProjects().every(project => coveredProjects.has(project.projectId))) {
      options.onInventory?.({ observedAt: new Date(now()).toISOString(), claims: [...inventory.values()].map(task => ({ projectId: task.projectId, taskId: task.id, claimId: readWorkerClaim(task.properties)!.claimId })) });
    }
    // Ownership loss is authoritative even when the following resource observations fail.
    for (const local of options.store.listUnfinishedTasks()) {
      if (!coveredProjects.has(local.projectId) || inventory.has(key(local))) continue;
      const running = controllers.get(key(local));
      if (running !== undefined && !running.terminal) running.controller.abort(new Error("The original claim no longer belongs to this worker."));
      execution.forget(local);
    }
    await ensureHerdr(normalSignal);
    const observed = await listHerdr(normalSignal);
    const knownOwners = [...responsibilities(), ...observed.map((workspace) => workspace.owner), ...pendingStops().map((stop) => stop.context), ...(options.webStore?.listUnfinishedTasks() ?? [])];
    for (const owner of knownOwners) {
      if (!coveredProjects.has(owner.projectId) || inventory.has(key(owner)) || isStopped(owner)) continue;
      ending.set(key(owner), owner);
    }
    launchCleanups();
    for (const remoteTask of inventory.values()) {
      const local = options.store.getTask(remoteOwner(remoteTask))!;
      if (local.status === "active" && !blockedByOldClaim(local, knownOwners)) schedule(local, remoteTask);
    }
    const resources = await snapshot(normalSignal, coveredProjects, [...inventory.values()].map((task) => remoteOwner(task)));
    // New mappings require both a claim inventory and resource discovery before admission.
    const allMappingsObserved = (): boolean => options.store.listProjects().every(project => coveredProjects.has(project.projectId) && resources.scannedProjects.has(project.projectId));
    for (const [identityKey, owner] of resources.owners) {
      if (coveredProjects.has(owner.projectId) && resources.proven.has(identityKey) && !inventory.has(identityKey) && !isStopped(owner)) ending.set(identityKey, owner);
    }
    for (const local of options.store.listUnfinishedTasks()) {
      if (!coveredProjects.has(local.projectId) || resources.unavailableProjects.has(local.projectId) || inventory.has(key(local))) continue;
      const owner = resources.owners.get(key(local));
      if (owner !== undefined && isStopped(owner)) {
        ending.delete(key(local));
        if (!jobs.has(key(local))) options.store.completeTask(local);
      } else if (owner !== undefined) ending.set(key(local), owner);
      else if (!jobs.has(key(local)) && !ending.has(key(local))) ending.set(key(local), local);
    }

    launchCleanups();
    for (const [identityKey, remoteTask] of inventory) {
      let local = options.store.getTask(remoteOwner(remoteTask))!;
      if (allMappingsObserved() && !resources.unavailableProjects.has(local.projectId) && canAdvance(local) && resources.owners.has(identityKey) && local.status === "pending" && !blockedByOldClaim(local, resources.owners.values())) {
        local = options.store.activateTask(local);
        schedule(local, remoteTask);
      }
    }
    const projects = options.store.listProjects().filter(project => canAdvanceProject(project.projectId) && !resources.unavailableProjects.has(project.projectId));
    while (allMappingsObserved() && capacity(resources) < configuration.maxConcurrent && projects.length > 0) {
      let started = false;
      for (let turn = 0; turn < projects.length; turn++) {
        const project = projects[nextPendingProject % projects.length]!;
        nextPendingProject = (nextPendingProject + 1) % projects.length;
        const pending = options.store.listUnfinishedTasks().filter((task) => task.projectId === project.projectId && task.status === "pending").sort((left, right) => left.taskId.localeCompare(right.taskId));
        const local = pending.find(task => canAdvance(task) && inventory.has(key(task)) && !blockedByOldClaim(task, resources.owners.values()));
        if (local === undefined) continue;
        schedule(options.store.activateTask(local), inventory.get(key(local))!);
        started = true;
        break;
      }
      if (!started) break;
    }
    const cleanupFailure = (identity: string) => options.store.getCleanupSchedule(ending.get(identity)!) ?? cleanupRetries.get(identity);
    const blocked = capacity(resources) >= configuration.maxConcurrent
      ? [...ending.keys()].filter(identity => cleanupFailure(identity)?.lastError != null).sort() : [];
    const warning = blocked.join(",");
    if (warning !== capacityWarning) {
      capacityWarning = warning;
      if (warning !== "") options.emit({ kind: "cleanup-capacity-blocked", message: `Worker capacity is full; failed cleanup retains ${blocked.length} slot(s). ${blocked.map(identity => { const state = cleanupFailure(identity)!; return `${identity}: ${state.stage}, next retry ${new Date(state.nextAttemptAt).toISOString()}, ${state.lastError}`; }).join("; ")}. Correct the reported resource or archive failure; retries are automatic. No slot is released until cleanup is confirmed.` });
    }
    if (!allMappingsObserved() || capacity(resources) >= configuration.maxConcurrent || configuration.repositories.length === 0) return;
    const candidates = new Map<number, AsyncGenerator<Task>>();
    const exhausted = new Set<number>();
    try {
      while (allMappingsObserved() && capacity(resources) < configuration.maxConcurrent && exhausted.size < configuration.repositories.length) {
        const index = nextRepository % configuration.repositories.length;
        nextRepository = (nextRepository + 1) % configuration.repositories.length;
        if (exhausted.has(index)) continue;
        const repository = configuration.repositories[index]!;
        if (!coveredProjects.has(repository.project.projectId) || resources.unavailableProjects.has(repository.project.projectId)) { exhausted.add(index); continue; }
        let page = candidates.get(index);
        if (page === undefined) {
          page = options.remote.candidates(repository.project.projectId, options.platform, normalSignal);
          candidates.set(index, page);
        }
        const next = await page.next();
        if (next.done) { exhausted.add(index); continue; }
        const candidate = next.value;
        const claimConfiguration = configuration;
        const currentRepository = claimConfiguration.repositories.find(value => value.project.projectId === candidate.projectId);
        if (currentRepository === undefined || !selected(candidate.projectId) || claimConfiguration.targetProjectIds !== undefined && !claimConfiguration.targetProjectIds.includes(candidate.projectId)) continue;
        try {
          assertCanAcquire({ projectId: candidate.projectId, taskId: candidate.id });
          if ([...resources.owners.values()].some(owner => owner.projectId === candidate.projectId && owner.taskId === candidate.id)) throw new Error("An original task resource still reserves its worktree; a new claim cannot be acquired.");
        }
        catch (error) {
          options.emit({ kind: "warning", message: `Skipping ${candidate.projectId}/${candidate.id}: ${error instanceof Error ? error.message : "retained resource admission failed"}`, error });
          continue;
        }
        requireImplementedWorkerBackend(currentRepository.configuration);
        if (currentRepository.configuration.agentControlMode === "web") await options.verifyWebServer?.(currentRepository.configuration.agent, normalSignal);
        if (configuration !== claimConfiguration || !allMappingsObserved()) continue;
        const claimId = randomUUID();
        try {
          const granted = await options.remote.claim(candidate, { claimId, workerId: options.workerId, machine: options.machine, platform: options.platform, agent: currentRepository.configuration.agent, ...(currentRepository.configuration.agentControlMode === "web" ? { agentControlMode: "web" as const } : {}), worktreeId: randomUUID() }, normalSignal);
          const owner = remoteOwner(granted);
          const local = options.store.registerPending({ projectId: granted.projectId, taskId: granted.id, claimId: owner.claimId, agent: readWorkerClaim(granted.properties)!.agent, agentControlMode: readWorkerClaim(granted.properties)!.agentControlMode });
          registerClaim(granted);
          options.onClaim?.({ projectId: granted.projectId, taskId: granted.id, claimId: owner.claimId });
          if (allMappingsObserved() && selected(local.projectId) && canAdvance(local) && !blockedByOldClaim(local, resources.owners.values()) && capacity(resources) < configuration.maxConcurrent) schedule(options.store.activateTask(local), granted);
          return;
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
    updateConfiguration: (value: WorkerCoordinatorConfiguration): void => {
      const next = configurationView(value);
      // Claim admission fences actual view changes, not repeated heartbeat acknowledgments.
      if (!isDeepStrictEqual(configuration, next)) {
        configuration = next;
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
      try { await reconcile(); } finally { ticking = false; }
    },
    advanceRetry: async (identity: ClaimIdentity): Promise<void> => {
      const { task, remoteTask } = await readSource(identity);
      if (task.status !== "active") throw new Error("Only an active original claim may be retried; pending work is started by worker run.");
      const webRecord = task.agentControlMode === "web" ? options.webStore?.getTask(task) : null;
      const worker = readWorkerClaim(remoteTask.properties)!;
      if (task.agentControlMode === "web" && !webRecord) throw new Error("Retry requires the original Web execution evidence; it cannot start a replacement assignment.");
      if (webRecord && (webRecord.worktreeId !== worker.worktreeId || webRecord.workerId !== worker.workerId || webRecord.userId !== worker.userId || webRecord.serverOrigin !== options.serverOrigin)) throw new Error("The original Web execution ownership no longer matches the active claim.");
      if (configurationFor(task) === null) throw new Error("Native configuration is unavailable for this project; correct its cloud settings before retrying execution.");
      failures.delete(key(identity));
      await ensureHerdr(normalSignal);
      await serialize(identity, async () => {
        if (task.agentControlMode === "web" && options.webStore) {
          let record = options.webStore.getTask(task);
          if (record !== null) {
            if (record.cleanup !== null) record = await finishShutdown(record, normalSignal);
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
