import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Operation } from "../../../api/operation.js";
import { controllerExecutionDirectory, LaunchTicketIdentityError, readLaunchTicket, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import { readControllerSnapshot } from "../../controller/lifecycle-store.js";
import { confirmControllerProcessesStopped, type ProcessProof } from "../../controller/process-proof.js";
import { isControllerStopIdentityConflict, openControllerStop, recoverWindowsControllerProof } from "../../controller/controller-stop.js";
import { withControllerStop } from "../../controller/controller-stop-scope.js";
import type { ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { preservesControllerProcessProof, preservesNativeProcessPrefix } from "./orchestration.js";
import type { LocalTask } from "./web-types.js";
import { ExecutionSourceConflictError } from "../execution-stop.js";
import type { CleanupTarget, StopObservation } from "../execution-stop.js";

/** Recover the ticket bound to a previous Windows generation from its stored proof. */
export const previousWebTicket = async (home: string, snapshot: ControllerSnapshot): Promise<ControllerLaunchTicket> => {
  const match = /^Local\\Daynight-([0-9a-f-]{36})$/.exec(snapshot.controllerProcess?.jobObjectName ?? "");
  if (!match) throw new Error("The original Windows generation has no recoverable launch ticket.");
  return readLaunchTicket(home, match[1]!);
};

export const confirmWebStop = async (file: string, ticket: ControllerLaunchTicket, snapshot: ControllerSnapshot, fallback?: ProcessProof): Promise<boolean> => {
  const controller = snapshot.controllerProcess ?? fallback ?? recoverWindowsControllerProof(file, ticket);
  if (!controller) throw new Error("The original Controller identity is missing.");
  const stop = await openControllerStop({ journalPath: file, ticket, controller, native: snapshot.nativeProcesses });
  const stopped = await withControllerStop(stop, () => stop.confirm());
  if (stopped) stop.recheck();
  return stopped;
};

export const settleWebStop = async (file: string, ticket: ControllerLaunchTicket, snapshot: ControllerSnapshot): Promise<ControllerSnapshot> => {
  const controller = snapshot.controllerProcess ?? recoverWindowsControllerProof(file, ticket);
  if (!controller) throw new Error("The original Controller identity is missing.");
  const stop = await openControllerStop({ journalPath: file, ticket, controller, native: snapshot.nativeProcesses });
  const stopped = await withControllerStop(stop, async () => {
    if (!await stop.confirm()) throw new Error("The original Controller or its descendants are still running.");
    return stop.commit();
  });
  stop.recheck();
  return stopped;
};

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
        if (saved.executionId !== execution.executionId || saved.claimId !== task.claimId || saved.sessionId !== execution.sessionId || BigInt(saved.executionGeneration) + 1n !== BigInt(execution.executionGeneration) || saved.controllerProcess === null || !(process.platform === "win32" || saved.controllerProcess.processGroupId === null || saved.controllerProcess.jobObjectName !== undefined ? await confirmWebStop(path.join(controllerExecutionDirectory(homeDirectory, execution.executionId), "journal.sqlite"), await previousWebTicket(homeDirectory, saved), saved) : await confirmControllerProcessesStopped(saved.controllerProcess, saved.nativeProcesses))) throw new ExecutionSourceConflictError("The preceding controller generation is not confirmed stopped.");
        if (!isDeepStrictEqual(readControllerSnapshot(path.join(controllerExecutionDirectory(homeDirectory, execution.executionId), "journal.sqlite")), saved)) throw new ExecutionSourceConflictError("The preceding controller generation changed during stop observation.");
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
    const proof = saved?.controllerProcess ?? execution.controllerProcess ?? (process.platform === "win32" && saved !== null ? recoverWindowsControllerProof(path.join(controllerExecutionDirectory(homeDirectory, execution.executionId), "journal.sqlite"), ticket) : null);
    if (proof === null) throw new Error("The original controller process identity is missing.");
    if (saved !== null && saved.controllerProcess === null && process.platform === "win32") {
      const recovered = recoverWindowsControllerProof(path.join(controllerExecutionDirectory(homeDirectory, execution.executionId), "journal.sqlite"), ticket);
      if (recovered !== null && !preservesControllerProcessProof(proof, recovered, ticket.launchId)) throw new ExecutionSourceConflictError("The original controller process identity conflicts with the Job source.");
    }
    if (saved === null) throw new Error("The original controller journal is unavailable; complete native evidence is unknown.");
    const stopped = await confirmWebStop(path.join(controllerExecutionDirectory(homeDirectory, execution.executionId), "journal.sqlite"), ticket, saved, proof);
    operation.check();
    return { kind: stopped ? "stopped" : "running", execution: webExecutionRef(task), observedAt: now() };
  } catch (error) {
    operation.check();
    return { kind: "unknown", target, error: isControllerStopIdentityConflict(error) ? new ExecutionSourceConflictError("The original Windows stop evidence conflicts with its recorded source.", { cause: error }) : error, observedAt: now() };
  }
};
