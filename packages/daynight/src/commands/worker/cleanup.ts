import path from "node:path";
import type { WorkerAgent } from "../../api/types.js";
import type { HerdrOwnedWorkspace } from "./herdr.js";
import { actualTaskPane, executionContext, liveAgent, settleWorkerStops, workerOperation } from "./execution.js";
import type { ExecutionDependencies } from "./execution.js";
import { workerCleanupPrompt } from "./prompts.js";
import type { LocalTask, ResourceOwner, WorkerProject } from "./types.js";

export type CleanupInput = { owner: ResourceOwner; project: WorkerProject; task?: LocalTask };
type CleanupAttempt = { deadline: number; notified: boolean; submitted: boolean };
const key = (owner: ResourceOwner): string => `${owner.projectId}/${owner.taskId}/${owner.claimId}`;

export const createCleanupDriver = (deps: ExecutionDependencies) => {
  const attempts = new Map<string, CleanupAttempt>();
  return {
    advance: async (input: CleanupInput, resources: readonly HerdrOwnedWorkspace[], deleteWorktree: boolean, signal?: AbortSignal): Promise<boolean> => {
      const identity = key(input.owner);
      let attempt = attempts.get(identity);
      if (attempt === undefined) {
        attempt = { deadline: deps.now() + 600_000, notified: false, submitted: false };
        attempts.set(identity, attempt);
        deps.emit({ kind: "cleanup-started", ...(input.task === undefined ? {} : { task: input.task }), message: `Cleaning claim ${input.owner.claimId}; this attempt has a ten-minute deadline.` });
      }
      const stopContext = { ...input.owner, cwd: path.join(input.project.localPath, ".worktrees", "daynight", input.owner.taskId) };
      const stopped = await settleWorkerStops(deps, input.owner, signal);
      const pane = stopped ? undefined : actualTaskPane(input.owner, resources);
      if (pane !== undefined) {
        const agent: WorkerAgent | undefined = input.task?.agent ?? pane.kind ?? pane.nativeSession?.agent;
        if (agent === undefined) {
          await workerOperation((operation) => deps.herdr.tasks.stopAndClose(stopContext, pane.binding, operation), signal);
        } else {
          const context = executionContext({ ...input, task: { agent } });
          if (liveAgent(pane) && !attempt.notified && deps.now() < attempt.deadline) {
            attempt.notified = true;
            try {
              await workerOperation((operation) => deps.herdr.tasks.submitPrompt(context, pane.binding, workerCleanupPrompt(input.owner, attempt!.deadline), operation), signal, Math.max(1, Math.min(30_000, attempt.deadline - deps.now())));
              attempt.submitted = true;
            } catch (error) {
              deps.emit({ kind: "cleanup-notification-error", ...(input.task === undefined ? {} : { task: input.task }), message: "Cleanup notification failed; the current bounded cleanup attempt continues.", error });
            }
            if (deps.now() < attempt.deadline) return false;
          }
          const completed = attempt.submitted && pane.status === "idle";
          if (liveAgent(pane) && !completed && deps.now() < attempt.deadline) return false;
          await workerOperation((operation) => deps.herdr.tasks.stopAndClose(context, pane.binding, operation), signal);
        }
      }
      if (deleteWorktree) await workerOperation((operation) => deps.git.removeWorktree(input.project, input.owner, operation), signal, 180_000);
      attempts.delete(identity);
      deps.emit({ kind: deleteWorktree ? "cleaned" : "agent-stopped", ...(input.task === undefined ? {} : { task: input.task }), message: deleteWorktree ? "Stopped the task resources and deleted its worktree; the branch remains." : "Stopped the task resources and preserved its worktree." });
      return true;
    },
    remaining: (owner: ResourceOwner): number => Math.max(0, (attempts.get(key(owner))?.deadline ?? deps.now()) - deps.now()),
  };
};
