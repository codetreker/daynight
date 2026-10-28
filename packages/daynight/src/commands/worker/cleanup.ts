import { requireImplementedWorkerBackend } from "./backend.js";
import type { WorkerAgent } from "../../api/types.js";
import { HerdrAgentActionError } from "./herdr.js";
import { workerCleanupPrompt } from "./prompts.js";
import type { HerdrOwnedWorkspace, HerdrTaskBinding } from "./herdr.js";
import type { CleanupState, LocalTask } from "./types.js";
import { actualTaskPane, executionContext, ownedWorkspace, taskBinding, workerOperation } from "./execution.js";
import type { ExecutionDependencies } from "./execution.js";

const sameBinding = (left: HerdrTaskBinding, right: HerdrTaskBinding): boolean => left.session === right.session && left.workspaceId === right.workspaceId && left.paneId === right.paneId && left.terminalId === right.terminalId;


export const createCleanupDriver = (deps: ExecutionDependencies) => {
  const refresh = (task: LocalTask): LocalTask => {
    const current = deps.store.getTask(task);
    if (current === null) throw new Error("The local cleanup record disappeared.");
    return current;
  };
  const confirmChangedStop = (context: ReturnType<typeof executionContext>, original: HerdrTaskBinding, actual: HerdrTaskBinding, evidence: NonNullable<LocalTask["nativeExecution"]>["stopObservation"], signal?: AbortSignal) => {
    if (evidence === null) throw new Error("The original native stop observation is unavailable.");
    return original.workspaceId !== actual.workspaceId || original.paneId !== actual.paneId
      ? workerOperation((operation) => deps.herdr.tasks.confirmReplacedStop(context, original, actual, evidence, operation), signal)
      : workerOperation((operation) => deps.herdr.tasks.confirmRestoredStop(context, original, actual, evidence, operation), signal);
  };
  return {
    advance: async (input: LocalTask, resources: readonly HerdrOwnedWorkspace[], kind: CleanupState["kind"], deadline: number, signal?: AbortSignal): Promise<LocalTask> => {
      requireImplementedWorkerBackend(refresh(input).configuration);
      let task = deps.store.beginCleanup(input, { kind, deadline }, deps.now());
      try {
        let pane = actualTaskPane(task, resources);
        const workspace = ownedWorkspace(task, resources);
        // Stopped confirmation cannot precede observation of an unresolved create. Once
        // persisted, it lets a later empty snapshot reconcile a lost close acknowledgement.
        if (task.nativeExecution?.workspaceSubmission === "unknown" && workspace === undefined && !task.cleanup!.agentStopped && !task.cleanup!.workspaceClosed) throw new HerdrAgentActionError("The original workspace creation is unresolved; an absent snapshot does not prove workspace closure.", "workspace.create", "unknown");
        if (task.resources.worktree === null) {
          const worktree = await workerOperation((operation) => deps.git.findWorktree(task, operation), signal);
          if (worktree !== null) task = deps.store.bindWorktree(task, worktree, deps.now());
        }
        if (task.resources.herdr === null && pane !== undefined) {
          if (task.resources.worktree === null) throw new Error("An original Herdr workspace exists without its attributable task worktree; cleanup retained it.");
          task = deps.store.bindHerdrExecution(task, pane.binding, null, deps.now());
        } else if (task.resources.herdr !== null && taskBinding(task) === null && pane !== undefined) {
          task = deps.store.bindHerdrExecution(task, pane.binding, null, deps.now());
        }
        if (task.resources.herdr !== null && task.resources.nativeSession === null && pane?.nativeSession !== undefined && pane.nativeSession !== null) task = deps.store.bindNativeSession(task, { source: "herdr", sessionId: pane.nativeSession.sessionId }, deps.now());
        const binding = taskBinding(task);
        const agent = task.configuration?.agent ?? task.nativeExecution?.stopObservation?.agent ?? pane?.kind ?? pane?.nativeSession?.agent;
        if (!task.cleanup!.agentStopped) {
          if (binding === null) {
            if (workspace !== undefined || task.nativeExecution?.launchSubmission !== "never-submitted") throw new Error("The original native launch or resource identity is unknown; agent stop cannot be inferred from missing bindings.");
            task = deps.store.recordCleanupInputOutcome(task, "unavailable", deps.now());
            task = deps.store.recordCleanupResult(task, "unavailable", "No native launch was submitted for this execution.", deps.now());
            task = deps.store.confirmAgentStopped(task, { agentStopped: true }, deps.now());
          } else {
            if (agent === undefined || agent === null) throw new Error("The original native agent kind is unavailable; cleanup retained its resources.");
            const context = executionContext(task, agent as WorkerAgent);
            const actual = pane?.binding ?? binding;
            if (task.nativeExecution?.launchSubmission === "never-submitted") {
              if (workspace !== undefined) await workerOperation((operation) => deps.herdr.tasks.confirmEmptyPane(context, actual, operation), signal);
              task = deps.store.recordCleanupInputOutcome(task, "unavailable", deps.now());
              task = deps.store.recordCleanupResult(task, "unavailable", "The original owned pane has no native launch submission or foreground work.", deps.now());
              task = deps.store.confirmAgentStopped(task, { agentStopped: true }, deps.now());
            } else {
              let evidence = task.nativeExecution?.stopObservation;
              if (evidence === null || evidence === undefined) {
                if (!sameBinding(binding, actual)) throw new Error("The original terminal changed before its native process identities were persisted; cleanup cannot infer stopped confirmation.");
                evidence = await workerOperation((operation) => deps.herdr.tasks.captureStop(context, binding, operation), signal);
                task = deps.store.recordStopObservation(task, evidence, deps.now());
              }
              if (sameBinding(binding, actual) && pane !== undefined && pane.kind === null && !pane.launchPending && !pane.interactiveReady && task.cleanup!.result === null) {
                await workerOperation((operation) => deps.herdr.tasks.confirmStopped(context, binding, evidence!, operation), signal);
                if (task.cleanup!.input === "not-submitted") task = deps.store.recordCleanupInputOutcome(task, "unavailable", deps.now());
                task = deps.store.recordCleanupResult(task, "unavailable", "The original native processes exited before cleanup completion was established.", deps.now());
                task = deps.store.confirmAgentStopped(task, { agentStopped: true }, deps.now());
              }
              if (task.cleanup!.input === "not-submitted" && task.cleanup!.result === null && deps.now() < task.cleanup!.deadline) {
                if (workspace === undefined || !sameBinding(binding, actual)) {
                  task = deps.store.recordCleanupInputOutcome(task, "unavailable", deps.now());
                  task = deps.store.recordCleanupResult(task, "unavailable", "The original native session is unavailable for cleanup input.", deps.now());
                } else {
                  deps.store.markCleanupInputSubmitting(task, deps.now());
                  try {
                    const receipt = await workerOperation((operation) => deps.herdr.tasks.submitPrompt(context, binding, workerCleanupPrompt(task), operation), signal, Math.max(1, Math.min(30_000, task.cleanup!.deadline - deps.now())));
                    task = deps.store.recordCleanupInputOutcome(task, "submitted", deps.now());
                    if (receipt.observation.status === "idle" && receipt.observation.interactiveReady && receipt.observation.stateChangeSeq !== null && receipt.observation.completionSeq !== null) {
                      task = deps.store.recordCleanupInputEvidence(task, { stateChangeSeq: receipt.observation.stateChangeSeq, completionSeq: receipt.observation.completionSeq }, deps.now());
                    }
                  } catch (error) {
                    if (error instanceof HerdrAgentActionError && error.submission !== "unknown") {
                      task = deps.store.recordCleanupInputOutcome(task, "rejected", deps.now());
                      task = deps.store.recordCleanupResult(task, "failed", error.message, deps.now());
                    } else {
                      deps.store.recordCleanupError(task, error instanceof Error ? error.message : String(error), deps.now());
                      deps.emit({ kind: "cleanup-input-unknown", task: refresh(task), message: "Cleanup input may have been submitted; it will not be replayed.", error });
                    }
                  }
                }
              }
              task = refresh(task);
              if (task.cleanup!.result === null) {
                if (workspace === undefined) {
                  await workerOperation((operation) => deps.herdr.tasks.confirmMissingWorkspaceStopped(context, binding, evidence!, operation), signal);
                  task = deps.store.recordCleanupResult(task, "unavailable", "The original workspace is absent and its original processes have stopped.", deps.now());
                  task = deps.store.confirmAgentStopped(task, { agentStopped: true }, deps.now());
                } else if (!sameBinding(binding, actual)) {
                  await confirmChangedStop(context, binding, actual, evidence!, signal);
                  task = deps.store.recordCleanupResult(task, "unavailable", "The original processes stopped before Herdr restored its inactive shell.", deps.now());
                  task = deps.store.confirmAgentStopped(task, { agentStopped: true }, deps.now());
                } else if (deps.now() >= task.cleanup!.deadline) {
                  task = deps.store.recordCleanupResult(task, "timed-out", "The original cleanup deadline elapsed; temporary resource cleanup is not proven complete.", deps.now());
                } else {
                  pane = actualTaskPane(task, await workerOperation((operation) => deps.herdr.tasks.listResources(operation), signal));
                  const baseline = task.cleanup!.baseline;
                  if (pane !== undefined && pane.kind === null && !pane.launchPending && !pane.interactiveReady) {
                    await workerOperation((operation) => deps.herdr.tasks.confirmStopped(context, binding, evidence!, operation), signal);
                    task = deps.store.recordCleanupResult(task, "unavailable", "The original native processes exited before cleanup completion was established.", deps.now());
                    task = deps.store.confirmAgentStopped(task, { agentStopped: true }, deps.now());
                  } else if (baseline !== null && pane !== undefined && (pane.status === "idle" || pane.status === "done") && pane.stateChangeSeq !== null && pane.stateChangeSeq > baseline.stateChangeSeq && pane.completionSeq !== null && pane.completionSeq > baseline.completionSeq) {
                    task = deps.store.recordCleanupResult(task, "completed", null, deps.now());
                  } else {
                    deps.emit({ kind: "cleanup-waiting", task, message: "Waiting for the original cleanup turn or its fixed deadline; the execution still occupies capacity." });
                    return task;
                  }
                }
              }
              if (!task.cleanup!.agentStopped) {
                if (workspace === undefined) await workerOperation((operation) => deps.herdr.tasks.confirmMissingWorkspaceStopped(context, binding, evidence!, operation), signal);
                else if (!sameBinding(binding, actual)) await confirmChangedStop(context, binding, actual, evidence!, signal);
                else await workerOperation((operation) => deps.herdr.tasks.forceStop(context, binding, evidence!, operation), signal);
                task = deps.store.confirmAgentStopped(task, { agentStopped: true }, deps.now());
              }
            }
          }
        }
        if (!task.cleanup!.workspaceClosed) {
          if (binding !== null) {
            if (agent === undefined || agent === null) throw new Error("The original native agent kind is unavailable for workspace identity verification.");
            await workerOperation((operation) => deps.herdr.tasks.closeWorkspace(executionContext(task, agent as WorkerAgent), pane?.binding ?? binding, { agentStopped: true }, operation), signal);
          }
          task = deps.store.confirmWorkspaceClosed(task, { workspaceClosed: true }, deps.now());
        }
        if (task.cleanup!.kind === "terminal" && !task.cleanup!.worktreeDeleted) {
          await workerOperation((operation) => deps.git.removeWorktree(task, { terminal: true, agentStopped: true, workspaceClosed: true }, operation), signal);
          task = deps.store.confirmWorktreeDeleted(task, { worktreeDeleted: true }, deps.now());
        }
        deps.emit({ kind: task.cleanup!.kind === "terminal" ? "cleaned" : "shutdown-stopped", task, message: task.cleanup!.kind === "terminal" ? "Original native agent and workspace stopped; the original worktree was deleted." : "Original agent and workspace stopped; the unfinished worktree, claim and native history were preserved." });
        return task;
      } catch (error) {
        deps.store.recordCleanupError(task, error instanceof Error ? error.message : String(error), deps.now());
        throw error;
      }
    },
  };
};
