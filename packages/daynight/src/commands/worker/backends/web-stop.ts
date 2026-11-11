import path from "node:path";
import type { Operation } from "../../../api/operation.js";
import { controllerExecutionDirectory, LaunchTicketIdentityError, readLaunchTicket, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import { readControllerSnapshot } from "../../controller/lifecycle-store.js";
import { confirmControllerProcessesStopped } from "../../controller/process-proof.js";
import { preservesControllerProcessProof, preservesNativeProcessPrefix } from "./orchestration.js";
import type { LocalTask } from "./web-types.js";
import { ExecutionSourceConflictError } from "../execution-stop.js";
import type { CleanupTarget, StopObservation } from "../execution-stop.js";

export const webExecutionRef = (task: LocalTask) => {
  const execution = task.webExecution;
  if (execution === null) throw new Error("The original Web execution is missing.");
  return { owner: { projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, worktreeId: task.worktreeId }, backend: "web" as const,
    runKey: JSON.stringify([execution.executionId, execution.executionGeneration, execution.controllerInstanceId]) };
};

export const assertWebTicketIdentity = (task: LocalTask, ticket: ControllerLaunchTicket): void => {
  const execution = task.webExecution;
  if (execution === null || task.configuration === null) throw new Error("The original Web execution or provider provenance is missing.");
  if (ticket.launchId !== execution.launchId || ticket.executionId !== execution.executionId || ticket.controllerId !== execution.controllerId
    || ticket.projectId !== task.projectId || ticket.taskId !== task.taskId || ticket.claimId !== task.claimId || ticket.sessionId !== execution.sessionId
    || ticket.executionGeneration !== execution.executionGeneration || ticket.controllerInstanceId !== execution.controllerInstanceId
    || ticket.worktreeId !== task.worktreeId || ticket.workerId !== task.workerId || ticket.serverOrigin !== task.serverOrigin
    || ticket.provider !== task.configuration.agent || ticket.initialOperationId !== execution.initialOperationId
    || JSON.stringify(ticket.configuration) !== JSON.stringify(task.configuration)
    || (task.resources.worktree !== null && ticket.cwd !== task.resources.worktree.worktreePath)
    || (execution.nativeHome !== null && ticket.nativeHome !== execution.nativeHome)
    || (execution.initialPrompt !== null && ticket.initialPrompt !== execution.initialPrompt)
    || (task.userId !== null && ticket.userId !== task.userId)) throw new ExecutionSourceConflictError("The launch ticket does not identify the original execution.");
};

/** Read only original execution evidence; this never performs cleanup or acquires its gate. */
export const observeWebExecutionStop = async (target: CleanupTarget, task: LocalTask | null, homeDirectory: string, operation: Operation, now: () => number): Promise<StopObservation> => {
  try {
    operation.check();
    if (task === null || target.worktreeId === undefined) throw new Error("The original Web execution owner is unavailable.");
    if (task.worktreeId !== target.worktreeId || task.projectId !== target.projectId || task.taskId !== target.taskId || task.claimId !== target.claimId) throw new ExecutionSourceConflictError("The original Web execution owner conflicts with the target.");
    const execution = task.webExecution;
    if (execution === null) throw new Error("The original Web launch provenance is missing.");
    const saved = readControllerSnapshot(path.join(controllerExecutionDirectory(homeDirectory, execution.executionId), "journal.sqlite"));
    if (execution.launchSubmission === "not-submitted") {
      if (saved === null) return { kind: "not-started", owner: webExecutionRef(task).owner, observedAt: now() };
      if (saved.executionGeneration !== execution.executionGeneration) {
        if (saved.executionId !== execution.executionId || saved.claimId !== task.claimId || saved.sessionId !== execution.sessionId || BigInt(saved.executionGeneration) + 1n !== BigInt(execution.executionGeneration) || saved.controllerProcess === null || !await confirmControllerProcessesStopped(saved.controllerProcess, saved.nativeProcesses)) throw new ExecutionSourceConflictError("The preceding controller generation is not confirmed stopped.");
        operation.check();
        return { kind: "not-started", owner: webExecutionRef(task).owner, observedAt: now() };
      }
    }
    if (saved !== null && (saved.executionId !== execution.executionId || saved.claimId !== task.claimId || saved.sessionId !== execution.sessionId || saved.executionGeneration !== execution.executionGeneration || saved.controllerInstanceId !== execution.controllerInstanceId)) throw new ExecutionSourceConflictError("The original controller journal belongs to another execution generation.");
    let ticket: Awaited<ReturnType<typeof readLaunchTicket>>;
    try { ticket = await readLaunchTicket(homeDirectory, execution.launchId); }
    catch (error) {
      if (error instanceof LaunchTicketIdentityError) throw new ExecutionSourceConflictError("The launch ticket identity changed.", { cause: error });
      throw error;
    }
    operation.check();
    assertWebTicketIdentity(task, ticket);
    if (saved?.controllerProcess != null && execution.controllerProcess !== null && !preservesControllerProcessProof(execution.controllerProcess, saved.controllerProcess, ticket.launchId)) throw new ExecutionSourceConflictError("The original controller process identity conflicts with its journal.");
    if (saved !== null && !preservesNativeProcessPrefix(execution.nativeProcesses, saved.nativeProcesses)) throw new ExecutionSourceConflictError("The original native process identities conflict with their journal.");
    const proof = saved?.controllerProcess ?? execution.controllerProcess;
    if (proof === null) throw new Error("The original controller process identity is missing.");
    const stopped = await confirmControllerProcessesStopped(proof, saved?.nativeProcesses ?? execution.nativeProcesses);
    operation.check();
    return { kind: stopped ? "stopped" : "running", execution: webExecutionRef(task), observedAt: now() };
  } catch (error) {
    operation.check();
    return { kind: "unknown", target, error, observedAt: now() };
  }
};
