import { randomUUID } from "node:crypto";
import { ApiError } from "../../api/client.js";
import type { Task, TaskPlatform, WorkerMachine } from "../../api/types.js";
import type { WorkerRepositoryAssignment } from "./coordinator.js";
import type { WorkerRemote } from "./remote.js";
import type { WorkerStore } from "./store.js";
import type { ClaimIdentity, ControlIntent, LocalTask, TransferTarget } from "./types.js";

export type WorkerControlRequest =
  | { kind: "retry"; taskId: string; projectId?: string; claimId: string }
  | { kind: "release"; taskId: string; projectId?: string; claimId: string; version: bigint }
  | { kind: "resume"; taskId: string; projectId?: string; claimId: string; version: bigint }
  | { kind: "transfer"; taskId: string; projectId?: string; claimId: string; version: bigint; target: Omit<TransferTarget, "worktreeId"> };

const cleaned = (task: LocalTask): boolean => task.cleanup?.kind === "terminal" && task.cleanup.result !== null && task.cleanup.agentStopped && task.cleanup.workspaceClosed && task.cleanup.worktreeDeleted;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const sourceActive = (task: Task, claimId: string): boolean => task.properties.worker?.claimId === claimId && task.properties.worker.state === "active";
const applied = (task: Task, intent: ControlIntent): boolean => intent.kind === "release"
  ? task.properties.worker?.claimId === intent.sourceClaimId && task.properties.worker.state === "released"
  : task.properties.worker?.claimId === intent.targetClaimId && task.properties.worker.state === "active" && task.properties.worker.userId === intent.target.userId && task.properties.worker.workerId === intent.target.workerId && task.properties.worker.worktreeId === intent.target.worktreeId && task.properties.worker.agent === intent.target.agent;

export const createWorkerControlDriver = (options: { store: WorkerStore; remote: WorkerRemote; serverOrigin: string; now: () => number }) => ({
  advance: async (input: LocalTask, signal: AbortSignal, mode: { submit: boolean } = { submit: true }): Promise<LocalTask> => {
    let task = options.store.getTask(input);
    if (task === null) throw new Error("The source control execution disappeared.");
    if (task.status === "done" || task.control === null || !cleaned(task)) return task;
    if (task.serverOrigin !== options.serverOrigin) return task;
    if (task.userId === null) throw new Error("Source control requires the original authenticated claim owner.");
    if (task.control.submission === "confirmed") return task.control.outcome === "applied"
      ? options.store.completeAppliedControl(task, task.control.intent, BigInt(task.control.resultVersion!), options.now())
      : options.store.completeEndedControl(task, task.control.intent, { observedClaimId: null, observedState: null }, options.now());
    const intent = task.control.intent;
    const observed = await options.remote.readTask(task.projectId, task.taskId, signal);
    await options.remote.authorizeControl(task.projectId, task.userId, undefined, signal);
    const latest = options.store.getTask(task);
    if (latest === null) throw new Error("The source control execution disappeared.");
    if (latest.status === "done") return latest;
    if (latest.control === null || JSON.stringify(latest.control.intent) !== JSON.stringify(intent)) throw new Error("The concrete source management decision changed during remote observation.");
    task = latest;
    if (!sourceActive(observed, task.claimId)) {
      if (applied(observed, intent) && task.control!.submission === "unknown") return options.store.completeAppliedControl(task, intent, observed.version, options.now());
      return options.store.completeEndedControl(task, intent, { observedClaimId: observed.properties.worker?.claimId ?? null, observedState: observed.properties.worker?.state ?? null }, options.now());
    }
    if (!mode.submit || task.control!.submission !== "not-submitted") return task;
    try { task = options.store.markControlSubmitting(task, BigInt(intent.version), options.now()); }
    catch (error) {
      const winner = options.store.getTask(task);
      if (winner?.control !== null && winner?.control !== undefined && JSON.stringify(winner.control.intent) === JSON.stringify(intent) && (winner.control.submission === "unknown" || winner.control.submission === "confirmed")) return winner;
      throw error;
    }
    try {
      const result = intent.kind === "release"
        ? await options.remote.release(task.projectId, task.taskId, { claimId: task.claimId, version: BigInt(intent.version), stoppedConfirmed: true }, signal)
        : await options.remote.transfer(task.projectId, task.taskId, { claimId: task.claimId, version: BigInt(intent.version), newClaimId: intent.targetClaimId, target: { userId: intent.target.userId, workerId: intent.target.workerId, machine: intent.target.machine, platform: intent.target.platform, agent: intent.target.agent }, worktreeId: intent.target.worktreeId, stoppedConfirmed: true }, signal);
      return options.store.completeAppliedControl(task, intent, result.version, options.now());
    } catch (error) {
      const current = options.store.getTask(task);
      if (current?.status === "done" && current.control?.submission === "confirmed") return current;
      if (error instanceof ApiError && !error.outcomeUnconfirmed) options.store.rejectControlSubmission(task, message(error), options.now());
      throw error;
    }
  },
});

export const submitWorkerControl = async (options: {
  store: WorkerStore; remote: WorkerRemote; serverOrigin: string; workerId: string; platform: TaskPlatform; machine: WorkerMachine;
  repositories: readonly WorkerRepositoryAssignment[]; request: WorkerControlRequest; signal: AbortSignal; now?: () => number;
}): Promise<{ task: LocalTask | null; message: string }> => {
  const now = options.now ?? Date.now;
  const request = options.request;
  const local = options.store.listTasks().filter((task) => task.taskId === request.taskId && task.claimId === request.claimId && (request.projectId === undefined || task.projectId === request.projectId));
  if (local.some((task) => task.serverOrigin !== options.serverOrigin)) throw new Error("The original claim belongs to a different configured service origin; restore that service before managing it.");
  const matches = local.filter((task) => task.serverOrigin === options.serverOrigin);
  if (matches.length > 1) throw new Error("The source claim is ambiguous; supply --project.");
  let source = matches[0];
  if (source !== undefined && source.workerId !== options.workerId) throw new Error("The source execution belongs to another worker identity.");
  const projectId = source?.projectId ?? request.projectId ?? (options.repositories.length === 1 ? options.repositories[0]!.project.projectId : undefined);
  if (projectId === undefined) throw new Error("This claim has no local execution; supply --project to resume it explicitly.");
  const principal = await options.remote.currentUserId(options.signal);
  const observed = await options.remote.readTask(projectId, request.taskId, options.signal);
  const worker = observed.properties.worker;
  if (request.kind === "resume") {
    const project = options.store.getProject({ serverOrigin: options.serverOrigin, projectId });
    const repository = options.repositories.find((entry) => entry.project.serverOrigin === options.serverOrigin && entry.project.projectId === projectId);
    if (project === null || repository === undefined) throw new Error("Resume requires a configured repository and its current agent settings.");
    const pending = options.store.getClaimAttempt(project);
    if (pending !== null) {
      if (pending.taskId !== request.taskId || pending.expectedVersion !== request.version.toString() || pending.userId !== principal) throw new Error("An unresolved original claim request cannot be replaced.");
      if (worker?.state === "active" && worker.claimId === pending.claimId && worker.userId === pending.userId && worker.workerId === pending.workerId && worker.worktreeId === pending.worktreeId && worker.agent === pending.configuration.agent) {
        const task = options.store.registerPending({ ...project, taskId: observed.id, claimId: pending.claimId, workerId: pending.workerId, worktreeId: pending.worktreeId }, { kind: "new", configuration: pending.configuration }, now(), principal);
        return { task, message: `Resume grant ${pending.claimId} recovered and committed as pending.` };
      }
      throw new Error(`Resume claim ${pending.claimId} has an unknown outcome; its original request will not be replayed.`);
    }
    if (observed.version !== request.version) throw new Error("The explicit task version no longer matches; make a new decision with the observed version.");
    if (worker?.state !== "released" || worker.claimId !== request.claimId) throw new Error("Resume requires the exact released previous claim.");
    await options.remote.authorizeControl(projectId, worker.userId, undefined, options.signal);
    const descriptor = { claimId: randomUUID(), workerId: options.workerId, worktreeId: randomUUID(), machine: options.machine, platform: options.platform, agent: repository.configuration.agent };
    options.store.beginClaimAttempt(project, { taskId: request.taskId, claimId: descriptor.claimId, worktreeId: descriptor.worktreeId, workerId: options.workerId, userId: principal, expectedVersion: request.version.toString(), configuration: repository.configuration });
    let grant: Task;
    try { grant = await options.remote.resume(projectId, request.taskId, { ...descriptor, version: request.version, previousClaimId: request.claimId }, options.signal); }
    catch (error) {
      if (error instanceof ApiError && !error.outcomeUnconfirmed) options.store.rejectClaimAttempt(project, descriptor.claimId, error.confirmedRefusal ? { definiteRejection: true } : { notSubmitted: true });
      throw error;
    }
    if (grant.properties.worker?.userId !== principal) throw new Error("The resume grant belongs to a different authenticated user; the original request remains unresolved.");
    const task = options.store.registerPending({ ...project, taskId: request.taskId, claimId: descriptor.claimId, workerId: descriptor.workerId, worktreeId: descriptor.worktreeId }, { kind: "new", configuration: repository.configuration }, now(), principal);
    return { task, message: `New resume claim ${task.claimId} committed as pending; worker run will prepare its new execution.` };
  }
  if (source === undefined || source.userId === null) throw new Error("Management requires the original local execution and its authenticated owner.");
  await options.remote.authorizeControl(projectId, source.userId, undefined, options.signal);
  const existing = source.control;
  if (request.kind !== "retry" && existing !== null && existing.submission !== "rejected") {
    const intent = existing.intent;
    const sameDecision = intent.kind === request.kind && intent.version === request.version.toString() && (request.kind !== "transfer" || (intent.kind === "transfer" && intent.target.userId === request.target.userId && intent.target.workerId === request.target.workerId && intent.target.agent === request.target.agent && intent.target.platform === request.target.platform && JSON.stringify(intent.target.machine) === JSON.stringify(request.target.machine)));
    if (!sameDecision) throw new Error("A different source management decision is already persisted; an unknown write cannot be replaced.");
    return { task: source, message: `Existing ${intent.kind} intent retained for claim ${source.claimId}; submission=${existing.submission}.` };
  }
  if (source.status === "done") throw new Error("The original local execution is already complete.");
  if (!sourceActive(observed, request.claimId) || worker!.userId !== source.userId || worker!.workerId !== source.workerId || worker!.worktreeId !== source.worktreeId) throw new Error("The source claim is no longer the exact active execution; reconcile its existing management outcome first.");
  if (request.kind === "retry") {
    if (principal !== source.userId) throw new Error("Retry must retain the original authenticated execution owner.");
    const task = options.store.authorizeRecoveryRetryAtCount(source, source.recovery.count, now());
    return { task, message: `One additional recovery attempt authorized for claim ${task.claimId}; persisted count=${task.recovery.count}.` };
  }
  if (observed.version !== request.version) throw new Error("The explicit task version no longer matches; make a new decision with the observed version.");
  if (request.kind === "transfer") await options.remote.authorizeControl(projectId, source.userId, request.target.userId, options.signal);
  const intent: ControlIntent = request.kind === "release" ? { kind: "release", sourceClaimId: source.claimId, version: request.version.toString() }
    : { kind: "transfer", sourceClaimId: source.claimId, version: request.version.toString(), targetClaimId: randomUUID(), target: { ...request.target, worktreeId: randomUUID() } };
  source = existing?.submission === "rejected" ? options.store.replaceRejectedControlIntent(source, intent, { observedVersion: observed.version }, now()) : options.store.recordControlIntent(source, intent, now());
  return { task: source, message: `${intent.kind} intent persisted for claim ${source.claimId}; source cleanup must finish before the remote write.` };
};
