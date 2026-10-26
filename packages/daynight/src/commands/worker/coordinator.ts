import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstat } from "node:fs/promises";
import { ApiError } from "../../api/client.js";
import type { Task, TaskPlatform, WorkerMachine, WorkerPhase } from "../../api/types.js";
import { createCleanupDriver } from "./cleanup.js";
import { createExecutionDriver, ownedWorkspace, workerOperation } from "./execution.js";
import type { ExecutionDependencies, WorkerEvent, WorkerGitManager } from "./execution.js";
import { HerdrAgentActionError } from "./herdr.js";
import type { HerdrOwnedWorkspace, WorkerHerdrAdapter } from "./herdr.js";
import type { WorkerRemote } from "./remote.js";
import type { WorkerStore } from "./store.js";
import type { ClaimIdentity, CleanupState, FrozenExecutionConfiguration, LocalTask, WorkerProject } from "./types.js";

export type WorkerRepositoryAssignment = { project: WorkerProject; configuration: FrozenExecutionConfiguration };
export type WorkerCoordinatorOptions = {
  store: WorkerStore;
  git: WorkerGitManager;
  herdr: WorkerHerdrAdapter;
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
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

export const createWorkerCoordinator = (options: WorkerCoordinatorOptions) => {
  const now = options.now === undefined ? Date.now : options.now;
  const deps: ExecutionDependencies = { store: options.store, git: options.git, herdr: options.herdr, platform: options.platform, buildPrompt: options.buildPrompt, emit: options.emit, now };
  const execution = createExecutionDriver(deps);
  const cleanup = createCleanupDriver(deps);
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
  const localTasks = (): LocalTask[] => options.store.listUnfinishedTasks().filter((task) => task.serverOrigin === options.serverOrigin && task.workerId === options.workerId);
  const completeTerminal = (task: LocalTask, absent: boolean): LocalTask => {
    if (task.cleanup?.kind !== "terminal" || !task.cleanup.agentStopped || !task.cleanup.workspaceClosed || !task.cleanup.worktreeDeleted || task.cleanup.result === null) return task;
    if (task.control !== null && task.control.submission !== "confirmed") {
      if (!absent) return task;
      task = options.store.confirmControlOwnershipEnded(task, { completeOwnClaimInventory: true, claimAbsent: true }, now());
    }
    return options.store.completeTask(task, now());
  };
  const publishSummary = async (task: LocalTask, remoteTask: Task): Promise<void> => {
    const worker = remoteTask.properties.worker;
    if (worker === null || worker.claimId !== task.claimId || task.cleanup !== null || task.control !== null || task.nativeExecution === null) return;
    options.store.reconcileExecutionSummary(task, { version: remoteTask.version.toString(), herdr: worker.herdr, nativeSessionId: worker.nativeSessionId, phase: worker.phase }, now());
    task = latest(task);
    const prior = task.nativeExecution!.summary;
    if (prior?.submission === "unknown") return;
    const phase: WorkerPhase = task.recovery.pauseReason !== null ? "paused" : task.nativeExecution!.promptSubmission === "submitted" ? "executing" : "preparing";
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
  const recordRecovered = async (remoteTask: Task, resources: readonly HerdrOwnedWorkspace[]): Promise<LocalTask> => {
    const worker = remoteTask.properties.worker!;
    const identity = { serverOrigin: options.serverOrigin, projectId: remoteTask.projectId, taskId: remoteTask.id, claimId: worker.claimId, workerId: worker.workerId, worktreeId: worker.worktreeId };
    const present = options.store.getTask(identity);
    if (present !== null) return present;
    const project = options.store.getProject(identity);
    if (project === null) throw new Error(`The original project binding for recovered claim ${worker.claimId} is unavailable.`);
    const attempt = options.store.getClaimAttempt(identity);
    const matchingAttempt = attempt !== null && attempt.taskId === remoteTask.id && attempt.claimId === worker.claimId && attempt.workerId === worker.workerId && attempt.worktreeId === worker.worktreeId;
    const configured = options.repositories.find(({ project: selected }) => selected.serverOrigin === identity.serverOrigin && selected.projectId === identity.projectId);
    const fixedPath = path.join(project.localPath, ".worktrees", "daynight", identity.taskId);
    let pathTrace = await exists(fixedPath);
    if (pathTrace && worker.herdr === null && worker.nativeSessionId === null && worker.phase === "preparing") {
      const previous = localTasks().find((task) => task.projectId === identity.projectId && task.taskId === identity.taskId && task.claimId !== identity.claimId && task.resources.worktree?.worktreePath === fixedPath);
      if (previous !== undefined) {
        try { pathTrace = await workerOperation((operation) => options.git.findWorktree(previous, operation), normalSignal) === null; }
        catch (error) { options.emit({ kind: "worktree-conflict", task: previous, message: "The occupied task path could not be attributed to its previous claim; the new execution remains unverified.", error }); }
      }
    }
    const trace = worker.herdr !== null || worker.nativeSessionId !== null || resources.some(({ owner }) => owner.serverOrigin === identity.serverOrigin && owner.projectId === identity.projectId && owner.taskId === identity.taskId && owner.claimId === identity.claimId) || pathTrace;
    const configuration = matchingAttempt ? attempt.configuration : configured?.configuration;
    const fresh = !trace && configuration !== undefined && configuration.agent === worker.agent && worker.phase === "preparing";
    const task = options.store.registerPending(identity, fresh ? { kind: "new", configuration } : { kind: "recovered", configuration: null }, now());
    options.emit({ kind: fresh ? "pending-recovered" : "recovery-paused", task, message: fresh ? "Recovered the actual remote claim before resource creation and froze its effective configuration." : "Recovered an existing claim without its original frozen configuration; execution is paused." });
    return task;
  };
  const reconcileTask = async (input: LocalTask, remoteTask: Task | undefined, resources: readonly HerdrOwnedWorkspace[]): Promise<void> => {
    await serializeTask(input, async () => {
      let task = latest(input);
      if (task.status === "done") return;
      if (remoteTask === undefined || task.control !== null || task.cleanup?.kind === "terminal") {
        task = await cleanup.advance(task, resources, "terminal", now() + 600_000, normalSignal);
        completeTerminal(task, remoteTask === undefined);
        return;
      }
      if (task.cleanup?.kind === "shutdown") {
        task = await cleanup.advance(task, resources, "shutdown", task.cleanup.deadline, normalSignal);
        if (!task.cleanup!.agentStopped || !task.cleanup!.workspaceClosed || task.cleanup!.result === null) return;
        task = options.store.resumeAfterShutdown(task, now());
      }
      const worker = remoteTask.properties.worker!;
      if (worker.workerId !== task.workerId || worker.worktreeId !== task.worktreeId || worker.platform !== options.platform || (task.configuration !== null && worker.agent !== task.configuration.agent)) {
        task = options.store.pauseTask(task, "The authoritative claim identity, actual platform or original frozen native kind does not match this execution.", now());
        options.emit({ kind: "paused", task, message: task.recovery.pauseReason! });
        return;
      }
      if (task.configuration === null) {
        if (task.status === "pending") task = options.store.activatePausedRecovery(task, task.recovery.pauseReason ?? "The original frozen execution configuration is missing.", now());
        options.emit({ kind: "paused", task, message: task.recovery.pauseReason ?? "The original frozen execution configuration is missing." });
        return;
      }
      if (task.status === "pending") {
        if (capacity() >= options.maxConcurrent || options.store.listUnfinishedTasks().some((other) => other.status === "active" && taskKey(other) === taskKey(task))) return;
        task = options.store.activateTask(task, now());
      }
      try { task = await execution.advance(task, resources, normalSignal); }
      catch (error) {
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
  const claimOne = async (repository: WorkerRepositoryAssignment, resources: readonly HerdrOwnedWorkspace[]): Promise<boolean> => {
    if (options.store.getClaimAttempt(repository.project) !== null) {
      options.emit({ kind: "claim-unknown", message: `Project ${repository.project.projectId} has an unresolved original claim request; no claim is replayed.` });
      return false;
    }
    for await (const candidate of options.remote.candidates(repository.project.projectId, options.platform, normalSignal)) {
      if (shuttingDown || capacity() >= options.maxConcurrent) return false;
      if (options.store.listUnfinishedTasks().some((task) => task.serverOrigin === options.serverOrigin && task.projectId === candidate.projectId && task.taskId === candidate.id)) continue;
      const descriptor = { claimId: randomUUID(), workerId: options.workerId, worktreeId: randomUUID(), machine: options.machine, platform: options.platform, agent: repository.configuration.agent };
      options.store.beginClaimAttempt(repository.project, { taskId: candidate.id, claimId: descriptor.claimId, workerId: options.workerId, worktreeId: descriptor.worktreeId, expectedVersion: candidate.version.toString(), configuration: repository.configuration });
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
      const task = options.store.registerPending({ serverOrigin: options.serverOrigin, projectId: granted.projectId, taskId: granted.id, claimId: descriptor.claimId, workerId: options.workerId, worktreeId: descriptor.worktreeId }, { kind: "new", configuration: repository.configuration }, now());
      options.emit({ kind: "pending", task, message: "Actual remote claim committed locally before activating or creating resources." });
      await reconcileTask(task, granted, resources);
      return true;
    }
    return false;
  };
  return {
    serializeTask,
    cleanupTask: async (identity: ClaimIdentity, kind: CleanupState["kind"] = "terminal"): Promise<LocalTask> => serializeTask(identity, async () => {
      await workerOperation((operation) => options.herdr.ensureInstance(operation));
      const resources = await workerOperation((operation) => options.herdr.tasks.listResources(operation));
      return cleanup.advance(latest(identity), resources, kind, now() + 600_000);
    }),
    tick: async (): Promise<void> => {
      if (shuttingDown) return;
      if (ticking) throw new Error("A worker reconciliation is already running.");
      ticking = true;
      try {
        normalSignal.throwIfAborted();
        const projects = options.store.listProjects().filter((project) => project.serverOrigin === options.serverOrigin);
        const inventory = await options.remote.ownInventory(projects, options.workerId, normalSignal);
        const byClaim = new Map(inventory.map((task) => [claimKey({ serverOrigin: options.serverOrigin, projectId: task.projectId, taskId: task.id, claimId: task.properties.worker!.claimId }), task]));
        await workerOperation((operation) => options.herdr.ensureInstance(operation), normalSignal);
        let resources = await workerOperation((operation) => options.herdr.tasks.listResources(operation), normalSignal);
        for (const task of inventory) await recordRecovered(task, resources);
        for (const workspace of resources) {
          const owner = workspace.owner;
          if (owner.serverOrigin !== options.serverOrigin || options.store.getTask(owner) !== null) continue;
          if (options.store.getProject(owner) === null) {
            options.emit({ kind: "orphan-unattributed", message: `Owned workspace ${workspace.workspaceId} has no persisted project binding; its resources were retained.` });
            continue;
          }
          options.store.registerPending({ ...owner, workerId: options.workerId }, { kind: "recovered", configuration: null }, now());
        }
        const existing = localTasks().sort((left, right) => Number(right.status === "active") - Number(left.status === "active"));
        for (const task of existing) {
          try { await reconcileTask(task, byClaim.get(claimKey(task)), resources); }
          catch (error) { options.emit({ kind: "reconciliation-error", task: latest(task), message: "The original execution remains owned locally; reconciliation will preserve its recorded progress.", error }); }
        }
        resources = await workerOperation((operation) => options.herdr.tasks.listResources(operation), normalSignal);
        let misses = 0;
        while (!shuttingDown && options.repositories.length > 0 && capacity() < options.maxConcurrent && misses < options.repositories.length) {
          normalSignal.throwIfAborted();
          const repository = options.repositories[nextRepository % options.repositories.length]!;
          nextRepository = (nextRepository + 1) % options.repositories.length;
          const claimed = await claimOne(repository, resources);
          misses = claimed ? 0 : misses + 1;
        }
      } finally { ticking = false; }
    },
    shutdown: async (): Promise<boolean> => {
      shuttingDown = true;
      await Promise.all([...tails.values()]);
      const tasks = localTasks();
      const deadline = now() + 600_000;
      for (const task of tasks) options.store.beginCleanup(task, { kind: task.control !== null || task.cleanup?.kind === "terminal" ? "terminal" : "shutdown", deadline }, now());
      let initialResources: readonly HerdrOwnedWorkspace[];
      try {
        await workerOperation((operation) => options.herdr.ensureInstance(operation));
        initialResources = await workerOperation((operation) => options.herdr.tasks.listResources(operation));
      } catch (error) {
        options.emit({ kind: "shutdown-error", message: "The private Herdr instance cannot be inspected; original stop is not confirmed.", error });
        return false;
      }
      if (initialResources.some((workspace) => !tasks.some((task) => ownedWorkspace(task, [workspace]) !== undefined))) {
        options.emit({ kind: "shutdown-error", message: "The private Herdr instance contains resources without an unfinished local execution; stop cannot be confirmed." });
        return false;
      }
      if (tasks.length === 0) return true;
      const results = await Promise.allSettled(tasks.map((input) => serializeTask(input, async () => {
        let task = latest(input);
        while (true) {
          const resources = await workerOperation((operation) => options.herdr.tasks.listResources(operation));
          task = await cleanup.advance(task, resources, task.cleanup!.kind, task.cleanup!.deadline);
          if (task.cleanup!.agentStopped && task.cleanup!.workspaceClosed) { completeTerminal(task, false); return true; }
          await sleep(Math.max(1, Math.min(250, task.cleanup!.deadline - now())));
        }
      })));
      let stopped = true;
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]!;
        if (result.status === "rejected") { stopped = false; options.emit({ kind: "shutdown-error", task: latest(tasks[index]!), message: "Original agent stop could not be confirmed; its resources were retained.", error: result.reason }); }
      }
      return stopped;
    },
  };
};
export type WorkerCoordinator = ReturnType<typeof createWorkerCoordinator>;
