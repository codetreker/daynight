import type { WebExecutionBackend } from "./backends/web.js";
import type { WebExecutionStore } from "./backends/web-store.js";
import type { WorkerSessionApi } from "./backends/session-api.js";
import { requireImplementedWorkerBackend } from "./backend.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OperationError } from "../../api/operation.js";
import type { Task, TaskPlatform, WorkerMachine, WorkerTaskInventory, WorkerTaskReference } from "../../api/types.js";
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
  const claim = task.properties.worker;
  if (claim === null || claim.state !== "active") throw new Error("An actual active remote claim is required.");
  return { projectId: task.projectId, taskId: task.id, claimId: claim.claimId, worktreeId: claim.worktreeId };
};

export const createWorkerCoordinator = (options: WorkerCoordinatorOptions) => {
  const now = options.now === undefined ? Date.now : options.now;
  const deps: ExecutionDependencies = { store: options.store, git: options.git, herdr: options.herdr, platform: options.platform, workerId: options.workerId, serverOrigin: options.serverOrigin, buildPrompt: options.buildPrompt, emit: options.emit, now };
  const execution = createExecutionDriver(deps);
  const cleanup = createCleanupDriver(deps);
  const normalSignal = options.signal === undefined ? new AbortController().signal : options.signal;
  const tails = new Map<string, Promise<void>>();
  const jobs = new Map<string, Promise<void>>();
  const controllers = new Map<string, { controller: AbortController; terminal: boolean }>();
  const ending = new Map<string, ResourceOwner>();
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
  const needsHerdr = (): boolean => options.globalConfiguration.agentControlMode !== "web"
    || options.repositories.some(repository => repository.configuration.agentControlMode !== "web")
    || options.store.listUnfinishedTasks().some(task => task.agentControlMode !== "web");
  const pendingStops = () => needsHerdr() ? options.herdr.tasks.pendingStops() : [];
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
      if (task.properties.worker!.workerId !== options.workerId) throw new Error("The claim inventory contains another worker's claim.");
      if (result.has(key(owner))) throw new Error("The claim inventory contains duplicate claims.");
      result.set(key(owner), task);
      options.store.registerPending({ projectId: task.projectId, taskId: task.id, claimId: owner.claimId, agent: task.properties.worker!.agent, agentControlMode: task.properties.worker!.agentControlMode });
    }
    return result;
  };
  const publishSummary = async (task: LocalTask, observed: HerdrAgentObservation, remoteTask: Task, signal: AbortSignal): Promise<void> => {
    const worker = remoteTask.properties.worker!;
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
      if (!terminal) failures.set(identityKey, (failures.get(identityKey) ?? 0) + 1);
      const task = options.store.getTask(identity);
      options.emit({ kind: terminal ? "cleanup-error" : "execution-error", ...(task === null ? {} : { task }), message: terminal ? "The resource cleanup failed and will be retried from actual observations." : "The task operation failed; this process retains its recovery count.", error });
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
    const local = options.store.getTask(owner);
    const webRecord = options.webStore?.getTask(owner);
    if (local?.agentControlMode === "web" || webRecord != null) {
      if (!options.webBackend || !options.webStore) throw new Error("The Web execution backend is unavailable.");
      if (webRecord == null) {
        // Registration precedes every native launch. Missing local evidence alone proves nothing.
        if (local?.sessionId !== null && local?.sessionId !== undefined) throw new Error("The original native identity has no local Web stop evidence.");
        if (!options.verifyWebUnregistered) throw new Error("Web launch provenance cannot be verified.");
        await options.verifyWebUnregistered(owner, signal ?? new AbortController().signal);
        if (deleteWorktree) { await workerOperation(operation => options.git.removeWorktree(projectFor(owner), owner, operation), signal); if (local) options.store.completeTask(owner); }
        return;
      }
      while (true) {
        const result = await options.webBackend.cleanup(webRecord, deleteWorktree ? "terminal" : "shutdown", now() + 600_000, signal);
        if (result.cleanup?.agentStopped && result.cleanup.backendResourcesClosed && (!deleteWorktree || result.cleanup.worktreeDeleted)) {
          if (deleteWorktree) { options.webStore.completeTask(owner, now()); if (local) options.store.completeTask(owner); }
          return;
        }
        await delay(1000, undefined, signal === undefined ? {} : { signal });
      }
    }
    while (true) {
      const resources = await workerOperation((operation) => options.herdr.tasks.listResources(operation), signal);
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
      startJob(owner, async (signal) => { await runCleanup(owner, true, signal); ending.delete(identityKey); }, true);
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
    if (!sameClaim(task, owner) || remoteTask.properties.worker!.workerId !== options.workerId || remoteTask.properties.worker!.agent !== task.agent || remoteTask.properties.worker!.agentControlMode !== (task.agentControlMode ?? "herdr")) throw new Error("The local execution does not match the observed original worker claim.");
    if (task.agentControlMode === "web") {
      if (!execute) return;
      if (!options.webStore || !options.webBackend) throw new Error("The Web execution backend is unavailable.");
      const configuration = configurationFor(task);
      requireImplementedWorkerBackend(configuration);
      await options.verifyWebServer?.(configuration.agent, signal);
      if (options.webStore.getTask(task) === null) {
        if (!options.verifyWebUnregistered) throw new Error("Web launch provenance cannot be verified.");
        await options.verifyWebUnregistered(task, signal);
        if (task.sessionId !== null || remoteTask.properties.worker!.nativeSessionId !== null) throw new Error("The original native identity has no local Web execution evidence.");
      }
      let record = options.webStore.register({ ...owner, project: projectFor(task), serverOrigin: options.serverOrigin, workerId: options.workerId, userId: remoteTask.properties.worker!.userId, configuration }, now());
      if (record.cleanup !== null) record = options.webStore.clearShutdown(record, now());
      const result = await options.webBackend.advance(record, signal);
      const nativeSessionId = result.resources.nativeSession?.sessionId ?? task.sessionId;
      if (nativeSessionId !== null) options.store.setSessionId(task, nativeSessionId);
      const phase = "executing" as const;
      const worker = remoteTask.properties.worker!;
      if (worker.phase !== phase || worker.nativeSessionId !== nativeSessionId || worker.herdr !== null) {
        try { await options.remote.update(remoteTask, { phase, nativeSessionId, herdr: null }, signal); }
        catch (error) { if (isWorkerCancellation(error, signal)) throw error; options.emit({ kind: "summary-error", task, message: "The Web execution summary was not confirmed; the next round will read it again.", error }); }
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
    options.onInventory?.({ observedAt: new Date(now()).toISOString(), claims: [...inventory.values()].map(task => ({ projectId: task.projectId, taskId: task.id, claimId: task.properties.worker!.claimId })) });
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
      else if (!jobs.has(key(local))) {
        if (local.agentControlMode === "web") {
          if (!options.verifyWebUnregistered || local.sessionId !== null) throw new Error("The ended Web claim has no original resource evidence; its ownership record is retained.");
          await options.verifyWebUnregistered(local, normalSignal);
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
          const local = options.store.registerPending({ projectId: granted.projectId, taskId: granted.id, claimId: owner.claimId, agent: granted.properties.worker!.agent, agentControlMode: granted.properties.worker!.agentControlMode });
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
    const worker = remoteTask.properties.worker;
    if (worker === null || worker.claimId !== identity.claimId || worker.workerId !== options.workerId || worker.state !== "active") throw new Error("The original claim is no longer active on this worker.");
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
      failures.delete(key(identity));
      if (task.agentControlMode === "web" && options.webStore?.getTask(task)) options.webStore.authorizeRecoveryRetry(task, now());
      await ensureHerdr(normalSignal);
      await serialize(identity, () => ensure(task, remoteTask, normalSignal));
    },
    cleanupSource: async (identity: ClaimIdentity, settings: { deleteWorktree?: boolean } = {}): Promise<ResourceOwner> => {
      const { owner } = await readSource(identity);
      await ensureHerdr(normalSignal);
      await serialize(identity, () => runCleanup(owner, settings.deleteWorktree === true, normalSignal));
      return owner;
    },
    completeSource: async (owner: ResourceOwner): Promise<void> => {
      await ensureHerdr(normalSignal);
      await serialize(owner, () => runCleanup(owner, true, normalSignal));
    },
    shutdown: async (): Promise<boolean> => {
      cancel();
      normalSignal.removeEventListener("abort", cancel);
      await Promise.all(jobs.values());
      let complete = true;
      for (const task of options.store.listUnfinishedTasks()) if (task.agentControlMode === "web" && options.webStore?.getTask(task) == null) {
        if (task.status === "pending" && task.sessionId === null && options.verifyWebUnregistered) {
          try { await options.verifyWebUnregistered(task, new AbortController().signal); continue; }
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
        const workspaces = await listHerdr();
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
      await Promise.all(options.store.listProjects().map(async (project) => {
        try {
          const resources = await snapshot(undefined, project);
          for (const [identity, owner] of resources.owners) if (resources.proven.has(identity)) owners.set(identity, owner);
        } catch (error) {
          complete = false;
          options.emit({ kind: "shutdown-error", message: `Could not observe owned resources in project ${project.projectId} during shutdown.`, error });
        }
      }));
      await Promise.all([...owners.values()].map(async (owner) => {
        try {
          await serialize(owner, async () => {
            const webRecord = options.webStore?.getTask(owner);
            if (webRecord != null) {
              if (!options.webBackend) throw new Error("The Web execution backend is unavailable during shutdown.");
              await options.webBackend.cleanup(webRecord, "shutdown", now(), undefined, true);
              return;
            }
            if (options.store.getTask(owner)?.agentControlMode === "web") return;
            if (options.store.getTask(owner) === null) {
              const observed = await workerOperation((operation) => options.herdr.tasks.listResources(operation));
              recordMissingClaim(owner, actualTaskPane(owner, observed));
            }
            await settleWorkerStops(deps, owner);
            const resources = await workerOperation((operation) => options.herdr.tasks.listResources(operation));
            const pane = actualTaskPane(owner, resources);
            if (pane === undefined) return;
            const context = { ...owner, cwd: path.join(projectFor(owner).localPath, ".worktrees", "daynight", owner.taskId) };
            await workerOperation((operation) => options.herdr.tasks.stopAndClose(context, pane.binding, operation));
          });
        }
        catch (error) { complete = false; options.emit({ kind: "shutdown-error", ...(options.store.getTask(owner) === null ? {} : { task: options.store.getTask(owner)! }), message: "Could not stop the original task resources.", error }); }
      }));
      return complete;
    },
  };
};
