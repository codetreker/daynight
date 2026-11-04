import path from "node:path";
import { CLEANUP_OPERATION_MS, cleanupOperation } from "../cleanup-operation.js";
import { ensureCleanupSchedule } from "./cleanup-schedule.js";
import { WorkerCleanupError } from "./cleanup-error.js";
import type { WorkerAgent } from "../../api/types.js";
import type { HerdrOwnedWorkspace } from "./herdr.js";
import { actualTaskPane, executionContext, liveAgent, settleWorkerStops } from "./execution.js";
import type { ExecutionDependencies } from "./execution.js";
import { workerCleanupPrompt } from "./prompts.js";
import type { LocalTask, ResourceOwner, WorkerProject } from "./types.js";

export type CleanupInput = { owner: ResourceOwner; project: WorkerProject; task?: LocalTask };
type CleanupAttempt = { deadline: number; notified: boolean; submitted: boolean };
const key = (owner: ResourceOwner): string => `${owner.projectId}/${owner.taskId}/${owner.claimId}`;

export const createCleanupDriver = (deps: Omit<ExecutionDependencies, "readTask">) => {
  const attempts = new Map<string, CleanupAttempt>();
  return {
    advance: async (input: CleanupInput, resources: readonly HerdrOwnedWorkspace[], deleteWorktree: boolean, signal?: AbortSignal): Promise<boolean> => {
      const identity = key(input.owner);
      let attempt = deleteWorktree ? ensureCleanupSchedule(deps.store, input.owner, deps.now()) : attempts.get(identity);
      if (attempt === undefined) {
        attempt = { deadline: deps.now() + 600_000, notified: false, submitted: false };
        attempts.set(identity, attempt);
        deps.emit({ kind: "cleanup-started", ...(input.task === undefined ? {} : { task: input.task }), message: `Cleaning claim ${input.owner.claimId}; this attempt has a ten-minute deadline.` });
      }
      const saveAttempt = (): void => {
        if (deleteWorktree) deps.store.saveCleanupSchedule(input.owner, { ...deps.store.getCleanupSchedule(input.owner)!, deadline: attempt!.deadline, notified: attempt!.notified, submitted: attempt!.submitted });
      };
      let stage: "agent-stop" | "worktree-removal" = "agent-stop";
      try {
        const stopContext = { ...input.owner, cwd: path.join(input.project.localPath, ".worktrees", "daynight", input.owner.taskId) };
        const stopped = await settleWorkerStops(deps, input.owner, signal, cleanupOperation);
        const pane = stopped ? undefined : actualTaskPane(input.owner, resources);
        if (pane !== undefined) {
          const agent: WorkerAgent | undefined = input.task?.agent ?? pane.kind ?? pane.nativeSession?.agent;
          if (agent === undefined) {
            await cleanupOperation((operation) => deps.herdr.tasks.stopAndClose(stopContext, pane.binding, operation), signal);
          } else {
            const context = executionContext({ ...input, task: { agent } });
            if (liveAgent(pane) && !attempt.notified && deps.now() < attempt.deadline) {
              attempt.notified = true;
              saveAttempt();
              try {
                await cleanupOperation((operation) => deps.herdr.tasks.submitPrompt(context, pane.binding, workerCleanupPrompt(input.owner, attempt!.deadline), operation), signal, Math.max(1, Math.min(CLEANUP_OPERATION_MS, attempt.deadline - deps.now())));
                attempt.submitted = true;
                saveAttempt();
              } catch (error) {
                deps.emit({ kind: "cleanup-notification-error", ...(input.task === undefined ? {} : { task: input.task }), message: "Cleanup notification failed; the current bounded cleanup attempt continues.", error });
              }
              if (deps.now() < attempt.deadline) return false;
            }
            const completed = attempt.submitted && pane.status === "idle";
            if (liveAgent(pane) && !completed && deps.now() < attempt.deadline) return false;
            await cleanupOperation((operation) => deps.herdr.tasks.stopAndClose(context, pane.binding, operation), signal);
          }
        }
        stage = "worktree-removal";
        if (deleteWorktree) await cleanupOperation((operation) => deps.git.removeWorktree(input.project, input.owner, operation), signal);
        attempts.delete(identity);
        deps.emit({ kind: deleteWorktree ? "cleaned" : "agent-stopped", ...(input.task === undefined ? {} : { task: input.task }), message: deleteWorktree ? "Stopped the task resources and deleted its worktree; the branch remains." : "Stopped the task resources and preserved its worktree." });
        return true;
      } catch (error) { throw new WorkerCleanupError(stage, error); }
    },
    remaining: (owner: ResourceOwner): number => Math.max(0, (deps.store.getCleanupSchedule(owner)?.deadline ?? attempts.get(key(owner))?.deadline ?? deps.now()) - deps.now()),
  };
};
