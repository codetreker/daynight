import { readWorkerClaim } from "../../api/task-properties.js";
import type { Task } from "../../api/types.js";
import type { WorkerInputWait } from "./coordinator.js";
import type { WorkerRemote } from "./remote.js";
import type { WorkerStore } from "./store.js";
import type { ClaimIdentity, LocalTask, ResourceOwner } from "./types.js";

const inputWaitingDescription: Record<WorkerInputWait["reason"], string> = {
  storage_maintenance: "Controller storage maintenance",
  configuration_pending: "Worker configuration readiness",
  prompt_unknown: "prompt synchronization",
  prompt_too_large: "a prompt within the native input limit",
};

export type WorkerControlRequest =
  | { kind: "retry"; taskId: string; projectId?: string; claimId: string }
  | { kind: "release"; taskId: string; projectId?: string; claimId: string; version: bigint };

type ControlCoordinator = {
  advanceRetry(identity: ClaimIdentity): Promise<WorkerInputWait | void>;
  cleanupSource(identity: ClaimIdentity, settings: { deleteWorktree?: boolean }): Promise<ResourceOwner>;
  completeSource(owner: ResourceOwner): Promise<void>;
};
const matchesTask = (task: Task, identity: { projectId: string; taskId: string }): boolean => task.projectId === identity.projectId && task.id === identity.taskId;
export const submitWorkerControl = async (options: {
  store: WorkerStore; remote: WorkerRemote; serverOrigin: string; workerId: string;
  request: WorkerControlRequest; signal: AbortSignal;
  coordinator: ControlCoordinator;
}): Promise<{ task: LocalTask | null; message: string }> => {
  const { store, remote, request, signal, coordinator } = options;
  signal.throwIfAborted();
  if (remote.serverOrigin !== options.serverOrigin) throw new Error("Worker management must use the configured service origin.");
  const matches = store.listTasks().filter((task) => task.taskId === request.taskId && task.claimId === request.claimId && (request.projectId === undefined || task.projectId === request.projectId));
  if (matches.length > 1) throw new Error("The source claim is ambiguous; supply --project.");
  const source = matches[0];
  if (source === undefined || source.status === "done") throw new Error("Management requires the original unfinished local execution.");
  const projectId = source.projectId;
  const identity = { projectId, taskId: request.taskId, claimId: request.claimId };
  const principal = await remote.currentUserId(signal);
  const observed = await remote.readTask(projectId, request.taskId, signal);
  if (!matchesTask(observed, identity)) throw new Error("The observed task does not match the requested project and task.");
  const worker = readWorkerClaim(observed.properties);
  const exactVersion = (): void => {
    if (request.kind !== "retry" && observed.version !== request.version) throw new Error("The explicit task version no longer matches; make a new decision with the observed version.");
  };
  if (worker === undefined || observed.status !== "in_progress" || worker.state !== "active" || worker.claimId !== request.claimId || worker.workerId !== options.workerId || worker.agent !== source.agent || worker.agentControlMode !== (source.agentControlMode ?? "herdr")) throw new Error("The source claim is no longer the exact active execution on this worker.");
  await remote.authorizeControl(projectId, worker.userId, signal);
  if (request.kind === "retry") {
    if (principal !== worker.userId) throw new Error("Retry requires the original authenticated execution owner.");
    if (source.status !== "active") throw new Error("Only an active original claim may be retried; pending work is started by worker run.");
    signal.throwIfAborted();
    const result = await coordinator.advanceRetry(identity);
    if (result?.kind === "waiting_input") return { task: store.getTask(identity), message: `Recovery input was not submitted for claim ${request.claimId}; waiting for ${inputWaitingDescription[result.reason]}.` };
    return { task: store.getTask(identity), message: `One recovery attempt completed for claim ${request.claimId}; worker run will connect its actual resources.` };
  }
  exactVersion();
  signal.throwIfAborted();
  const owner = await coordinator.cleanupSource(identity, { deleteWorktree: false });
  signal.throwIfAborted();
  await remote.release(projectId, request.taskId, { claimId: request.claimId, version: request.version, stoppedConfirmed: true }, signal);
  try { await coordinator.completeSource(owner); }
  catch (cause) { throw new Error("Release was confirmed, but source cleanup remains incomplete.", { cause }); }
  return { task: store.getTask(identity), message: `${request.kind} completed for claim ${request.claimId}; its original execution stopped, and local cleanup follows the backend archive requirements.` };
};
