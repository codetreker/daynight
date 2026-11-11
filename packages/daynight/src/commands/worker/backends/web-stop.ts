import path from "node:path";
import type { Operation } from "../../../api/operation.js";
import { controllerExecutionDirectory, readLaunchTicket } from "../../controller/launch-ticket.js";
import { readControllerSnapshot, type ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { inspectProcessProof } from "../../controller/process-proof.js";
import { preservesControllerEvidence, preservesControllerProcessProof, preservesNativeProcessPrefix } from "./orchestration.js";
import type { WebExecutionStore } from "./web-store.js";
import type { LocalTask } from "./web-types.js";
import { ExecutionSourceConflictError, type CleanupTarget, type StopObservation } from "../execution-stop.js";

const ownerOf = (task: LocalTask) => ({ projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, worktreeId: task.worktreeId });
const matches = (task: LocalTask, saved: ControllerSnapshot): boolean => {
  const execution = task.webExecution!;
  return saved.testExecutionId === undefined && saved.executionId === execution.executionId && saved.claimId === task.claimId
    && saved.sessionId === execution.sessionId && saved.executionGeneration === execution.executionGeneration
    && saved.controllerInstanceId === execution.controllerInstanceId
    && (task.resources.nativeSession === null || saved.nativeSessionId === task.resources.nativeSession.sessionId);
};

/** Read only the original recorded process instances; this does not prove that unrecorded descendants stopped. */
export const createWebStopObserver = (options: { homeDirectory: string; store: WebExecutionStore; now: () => number }) =>
  async (target: CleanupTarget, operation: Operation): Promise<StopObservation> => {
    try {
      operation.check();
      const task = options.store.getTask(target);
      if (task === null) throw new Error("The original Web execution owner is unavailable.");
      if (target.worktreeId !== undefined && task.worktreeId !== target.worktreeId) throw new ExecutionSourceConflictError("The original Web execution owner changed.");
      const owner = ownerOf(task), execution = task.webExecution;
      const ensureCurrent = (snapshot?: ControllerSnapshot): void => {
        const latest = options.store.getTask(task);
        if (latest === null || latest.worktreeId !== task.worktreeId) throw new ExecutionSourceConflictError("The original Web owner changed during observation.");
        const next = latest.webExecution;
        if (execution === null ? next !== null : next === null || next.executionId !== execution.executionId || next.launchId !== execution.launchId
          || next.sessionId !== execution.sessionId || next.executionGeneration !== execution.executionGeneration
          || next.controllerInstanceId !== execution.controllerInstanceId || next.launchSubmission !== execution.launchSubmission)
          throw new ExecutionSourceConflictError("The original Web generation changed during observation.");
        if (next !== null && snapshot !== undefined && (next.controllerProcess === null
          || !preservesControllerProcessProof(next.controllerProcess, snapshot.controllerProcess, next.launchId)
          || !preservesNativeProcessPrefix(next.nativeProcesses, snapshot.nativeProcesses)))
          throw new ExecutionSourceConflictError("The original Web process evidence changed during observation.");
        if (next !== null && next.launchSubmission === "not-submitted" && (next.controllerProcess !== null || next.nativeProcesses.length !== 0))
          throw new ExecutionSourceConflictError("Unsubmitted Web launch gained conflicting process evidence.");
      };
      if (execution === null) {
        if (task.configuration === null) throw new Error("The original Web launch provenance is missing.");
        ensureCurrent();
        return { kind: "not-started", owner, observedAt: options.now() };
      }
      const journal = path.join(controllerExecutionDirectory(options.homeDirectory, execution.executionId), "journal.sqlite");
      const saved = readControllerSnapshot(journal);
      if (execution.launchSubmission === "not-submitted") {
        if (execution.controllerProcess !== null || execution.nativeProcesses.length !== 0) throw new ExecutionSourceConflictError("Unsubmitted Web launch has conflicting process evidence.");
        if (saved !== null) {
          if (saved.testExecutionId !== undefined || saved.executionId !== execution.executionId || saved.claimId !== task.claimId || saved.sessionId !== execution.sessionId
            || BigInt(saved.executionGeneration) + 1n !== BigInt(execution.executionGeneration) || saved.controllerInstanceId === execution.controllerInstanceId || saved.controllerProcess === null
            || saved.nativeSessionId === null || saved.nativeSessionId !== task.resources.nativeSession?.sessionId)
            throw new ExecutionSourceConflictError("Unsubmitted Web launch conflicts with its preceding generation.");
          if (await inspectProcessProof(saved.controllerProcess) === "running") throw new Error("The preceding Web controller is still running.");
          operation.check();
          const latest = readControllerSnapshot(journal);
          if (latest === null || latest.executionId !== saved.executionId || latest.claimId !== saved.claimId || latest.sessionId !== saved.sessionId
            || latest.executionGeneration !== saved.executionGeneration || latest.controllerInstanceId !== saved.controllerInstanceId
            || !preservesControllerEvidence(saved, latest, "")) throw new ExecutionSourceConflictError("The preceding Web generation changed during observation.");
          for (const proof of latest.nativeProcesses) { operation.check(); if (await inspectProcessProof(proof) === "running") throw new Error("A preceding Web provider is still running."); }
        } else if (execution.executionGeneration !== "1") throw new Error("The preceding Web generation evidence is missing.");
        operation.check();
        ensureCurrent();
        return { kind: "not-started", owner, observedAt: options.now() };
      }
      const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId);
      if (ticket.executionId !== execution.executionId || ticket.controllerId !== execution.controllerId || ticket.claimId !== task.claimId
        || ticket.projectId !== task.projectId || ticket.taskId !== task.taskId || ticket.sessionId !== execution.sessionId
        || ticket.executionGeneration !== execution.executionGeneration || ticket.controllerInstanceId !== execution.controllerInstanceId
        || ticket.worktreeId !== task.worktreeId || ticket.workerId !== task.workerId || ticket.userId !== task.userId || ticket.serverOrigin !== task.serverOrigin)
        throw new ExecutionSourceConflictError("The Web ticket does not identify the original execution owner.");
      if (saved === null || saved.controllerProcess === null || execution.controllerProcess === null) throw new Error("The original Web journal or process evidence is missing.");
      if (!matches(task, saved)
        || !preservesControllerProcessProof(execution.controllerProcess, saved.controllerProcess, execution.launchId)
        || !preservesNativeProcessPrefix(execution.nativeProcesses, saved.nativeProcesses)) throw new ExecutionSourceConflictError("The original Web journal or process evidence conflicts.");
      const ref = { owner, backend: "web" as const, runKey: JSON.stringify([execution.executionId, execution.executionGeneration, execution.controllerInstanceId]) };
      operation.check();
      if (await inspectProcessProof(saved.controllerProcess) === "running") { operation.check(); ensureCurrent(saved); return { kind: "running", execution: ref, observedAt: options.now() }; }
      operation.check();
      const latest = readControllerSnapshot(journal);
      if (latest === null) throw new Error("The original Web journal is missing after controller stop.");
      if (!matches(task, latest) || !preservesControllerEvidence(saved, latest, execution.launchId)
        || !preservesNativeProcessPrefix(execution.nativeProcesses, latest.nativeProcesses)) throw new ExecutionSourceConflictError("The original Web journal changed or conflicted after controller stop.");
      for (const proof of latest.nativeProcesses) {
        operation.check();
        if (await inspectProcessProof(proof) === "running") { operation.check(); ensureCurrent(latest); return { kind: "running", execution: ref, observedAt: options.now() }; }
      }
      operation.check();
      ensureCurrent(latest);
      return { kind: "stopped", execution: ref, observedAt: options.now() };
    } catch (error) {
      operation.check();
      return { kind: "unknown", target, error, observedAt: options.now() };
    }
  };
