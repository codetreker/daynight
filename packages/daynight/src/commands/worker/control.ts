import { requireImplementedWorkerBackend } from "./backend.js";
import type { WorkerSessionApi } from "./backends/session-api.js";
import { randomUUID } from "node:crypto";
import { ApiError } from "../../api/client.js";
import type { Task, TaskPlatform, WorkerClaimDescriptor, WorkerMachine } from "../../api/types.js";
import type { WorkerRepositoryAssignment } from "./coordinator.js";
import type { WorkerEvent } from "./execution.js";
import type { WorkerRemote } from "./remote.js";
import type { WorkerStore } from "./store.js";
import type { ClaimIdentity, LocalTask, ResourceOwner } from "./types.js";

export type WorkerControlRequest =
  | { kind: "retry"; taskId: string; projectId?: string; claimId: string }
  | { kind: "release"; taskId: string; projectId?: string; claimId: string; version: bigint }
  | { kind: "resume"; taskId: string; projectId?: string; claimId: string; version: bigint };

type ControlCoordinator = {
  advanceRetry(identity: ClaimIdentity): Promise<void>;
  cleanupSource(identity: ClaimIdentity, settings: { deleteWorktree?: boolean }): Promise<ResourceOwner>;
  completeSource(owner: ResourceOwner): Promise<void>;
};
const matchesTask = (task: Task, identity: { projectId: string; taskId: string }): boolean => task.projectId === identity.projectId && task.id === identity.taskId;
const matchesGrant = (task: Task, identity: { projectId: string; taskId: string }, descriptor: WorkerClaimDescriptor, userId: string): boolean => {
  const worker = task.properties.worker;
  return matchesTask(task, identity) && task.status === "in_progress" && worker !== null && worker.state === "active"
    && worker.claimId === descriptor.claimId && worker.workerId === descriptor.workerId && worker.worktreeId === descriptor.worktreeId
    && worker.userId === userId && worker.agent === descriptor.agent && worker.agentControlMode === (descriptor.agentControlMode ?? "herdr") && worker.platform === descriptor.platform
    && worker.machine.id === descriptor.machine.id && worker.machine.name === descriptor.machine.name;
};

export const submitWorkerControl = async (options: {
  store: WorkerStore; remote: WorkerRemote; serverOrigin: string; workerId: string; platform: TaskPlatform; machine: WorkerMachine;
  repositories: readonly WorkerRepositoryAssignment[]; request: WorkerControlRequest; signal: AbortSignal;
  verifyWebServer?: WorkerSessionApi["verifySupport"];
  coordinator: ControlCoordinator; emit: (event: WorkerEvent) => void;
}): Promise<{ task: LocalTask | null; message: string }> => {
  const { store, remote, request, signal, coordinator } = options;
  signal.throwIfAborted();
  if (remote.serverOrigin !== options.serverOrigin) throw new Error("Worker management must use the configured service origin.");
  const matches = store.listTasks().filter((task) => task.taskId === request.taskId && task.claimId === request.claimId && (request.projectId === undefined || task.projectId === request.projectId));
  if (matches.length > 1) throw new Error("The source claim is ambiguous; supply --project.");
  const source = matches[0];
  let projectId = source?.projectId ?? request.projectId;
  if (projectId === undefined && options.repositories.length === 1) projectId = options.repositories[0]!.project.projectId;
  if (projectId === undefined) throw new Error("This claim has no local execution; supply --project to resume it explicitly.");
  const identity = { projectId, taskId: request.taskId, claimId: request.claimId };
  const principal = await remote.currentUserId(signal);
  const observed = await remote.readTask(projectId, request.taskId, signal);
  if (!matchesTask(observed, identity)) throw new Error("The observed task does not match the requested project and task.");
  const worker = observed.properties.worker;
  const exactVersion = (): void => {
    if (request.kind !== "retry" && observed.version !== request.version) throw new Error("The explicit task version no longer matches; make a new decision with the observed version.");
  };
  const confirmMutation = async (submit: () => Promise<Task>, applied: (task: Task) => boolean, description: string): Promise<Task> => {
    signal.throwIfAborted();
    try {
      const result = await submit();
      if (!applied(result)) throw new Error(`The ${description} response does not confirm the requested result.`);
      return result;
    } catch (error) {
      if (error instanceof ApiError && !error.outcomeUnconfirmed) throw error;
      let actual: Task;
      try { actual = await remote.readTask(projectId, request.taskId, signal); }
      catch (readError) { throw new AggregateError([error, readError], `The ${description} result is unknown. Reconcile the remote claim before restarting worker run; the request was not replayed.`); }
      if (applied(actual)) return actual;
      throw new Error(`The ${description} result is unknown. Reconcile the remote claim before restarting worker run; the request was not replayed.`, { cause: error });
    }
  };
  if (request.kind === "resume") {
    exactVersion();
    if (worker === null || worker.state !== "released" || worker.claimId !== request.claimId) throw new Error("Resume requires the exact released previous claim.");
    const project = store.getProject(identity);
    const repository = options.repositories.find((entry) => entry.project.projectId === projectId);
    if (project === null || repository === undefined) throw new Error("Resume requires a configured repository and its current agent settings.");
    requireImplementedWorkerBackend(repository.configuration);
    if (repository.configuration.agentControlMode === "web") { if (!options.verifyWebServer) throw new Error("Web backend capabilities are unavailable."); await options.verifyWebServer(repository.configuration.agent, signal); }
    await remote.authorizeControl(projectId, worker.userId, signal);
    const descriptor: WorkerClaimDescriptor = { claimId: randomUUID(), workerId: options.workerId, worktreeId: randomUUID(), machine: options.machine, platform: options.platform, agent: repository.configuration.agent, ...(repository.configuration.agentControlMode === "web" ? { agentControlMode: "web" as const } : {}) };
    options.emit({ kind: "management-request", message: `Resume ${projectId}/${request.taskId}: previousClaimId=${request.claimId}, claimId=${descriptor.claimId}, worktreeId=${descriptor.worktreeId}.` });
    const granted = await confirmMutation(
      () => remote.resume(projectId, request.taskId, { ...descriptor, version: request.version, previousClaimId: request.claimId }, signal),
      (task) => matchesGrant(task, identity, descriptor, principal), "resume",
    );
    const task = store.registerPending({ projectId, taskId: granted.id, claimId: descriptor.claimId, agent: descriptor.agent, agentControlMode: descriptor.agentControlMode ?? "herdr" });
    return { task, message: `New resume claim ${task.claimId} committed as pending; worker run will start its new execution.` };
  }
  if (source === undefined || source.status === "done") throw new Error("Management requires the original unfinished local execution.");
  if (worker === null || observed.status !== "in_progress" || worker.state !== "active" || worker.claimId !== request.claimId || worker.workerId !== options.workerId || worker.agent !== source.agent || worker.agentControlMode !== (source.agentControlMode ?? "herdr")) throw new Error("The source claim is no longer the exact active execution on this worker.");
  await remote.authorizeControl(projectId, worker.userId, signal);
  if (request.kind === "retry") {
    if (principal !== worker.userId) throw new Error("Retry requires the original authenticated execution owner.");
    if (source.status !== "active") throw new Error("Only an active original claim may be retried; pending work is started by worker run.");
    signal.throwIfAborted();
    await coordinator.advanceRetry(identity);
    return { task: store.getTask(identity), message: `One recovery attempt completed for claim ${request.claimId}; worker run will connect its actual resources.` };
  }
  exactVersion();
  signal.throwIfAborted();
  const owner = await coordinator.cleanupSource(identity, { deleteWorktree: false });
  await confirmMutation(
    () => remote.release(projectId, request.taskId, { claimId: request.claimId, version: request.version, stoppedConfirmed: true }, signal),
    (task) => matchesTask(task, identity) && task.status === "todo" && task.properties.worker?.claimId === request.claimId && task.properties.worker.state === "released", "release",
  );
  await coordinator.completeSource(owner);
  return { task: store.getTask(identity), message: `${request.kind} completed for claim ${request.claimId}; its local resources were removed.` };
};
