import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensureCleanupSchedule } from "./cleanup-schedule.js";
import { WorkerCleanupError } from "./cleanup-error.js";
import type { WorkerAgent } from "../../api/types.js";
import { actualTaskPane, executionContext, liveAgent, settleWorkerStops, workerOperation } from "./execution.js";
import type { ExecutionDependencies } from "./execution.js";
import { workerCleanupPrompt } from "./prompts.js";
import type { LocalTask, ResourceOwner, WorkerProject } from "./types.js";

export type CleanupInput = { owner: ResourceOwner; project: WorkerProject; task?: LocalTask };

export const createCleanupDriver = (deps: Omit<ExecutionDependencies, "readTask">) => ({
  advance: async (input: CleanupInput, deleteWorktree: boolean, signal?: AbortSignal): Promise<void> => {
    const deadline = deleteWorktree ? ensureCleanupSchedule(deps.store, input.owner, deps.now()).deadline : deps.now() + 600_000;
    let stage: "agent-stop" | "worktree-removal" = "agent-stop";
    try {
      const stopContext = { ...input.owner, cwd: path.join(input.project.localPath, ".worktrees", "daynight", input.owner.taskId) };
      await settleWorkerStops(deps, input.owner, signal);
      const observe = async () => actualTaskPane(input.owner, await workerOperation(operation => deps.herdr.tasks.listResources(operation), signal));
      let pane = await observe();
      if (pane !== undefined) {
        const agent: WorkerAgent | undefined = input.task?.agent ?? pane.kind ?? pane.nativeSession?.agent;
        if (agent !== undefined && liveAgent(pane) && deps.now() < deadline) {
          const context = executionContext({ ...input, task: { agent } });
          deps.emit({ kind: "cleanup-started", ...(input.task === undefined ? {} : { task: input.task }), message: `Cleaning claim ${input.owner.claimId}; observing its resources until ${new Date(deadline).toISOString()}.` });
          // Herdr has no per-input operation lookup. The notification is advisory;
          // a restarted attempt observes resources again and may notify the surviving agent.
          try {
            await workerOperation(operation => deps.herdr.tasks.submitPrompt(context, pane!.binding, workerCleanupPrompt(input.owner, deadline), operation), signal, Math.max(1, Math.min(30_000, deadline - deps.now())));
          } catch (error) {
            signal?.throwIfAborted();
            deps.emit({ kind: "cleanup-notification-error", ...(input.task === undefined ? {} : { task: input.task }), message: "Cleanup notification failed; actual resources will still be observed and stopped.", error });
          }
          while (true) {
            if (deps.now() < deadline) await delay(Math.max(1, Math.min(1000, deadline - deps.now())), undefined, signal === undefined ? {} : { signal });
            pane = await observe();
            if (pane === undefined || !liveAgent(pane) || pane.status === "idle" || deps.now() >= deadline) break;
          }
        }
        if (pane !== undefined) {
          try { await workerOperation(operation => deps.herdr.tasks.stopAndClose(stopContext, pane!.binding, operation), signal); }
          catch (error) {
            signal?.throwIfAborted();
            if (await observe() !== undefined) throw error;
          }
        }
      }
      await settleWorkerStops(deps, input.owner, signal);
      if (await observe() !== undefined) throw new Error("The original task pane still exists after cleanup.");
      stage = "worktree-removal";
      if (deleteWorktree) {
        await workerOperation(operation => deps.git.removeWorktree(input.project, input.owner, operation), signal, 180_000);
        if (await workerOperation(operation => deps.git.findWorktree(input.project, input.owner, operation), signal) !== null) throw new Error("The original task worktree resources still exist after cleanup.");
      }
      deps.emit({ kind: deleteWorktree ? "cleaned" : "agent-stopped", ...(input.task === undefined ? {} : { task: input.task }), message: deleteWorktree ? "Confirmed task resources absent; the branch remains." : "Confirmed task execution stopped and closed; its worktree remains." });
    } catch (error) { throw new WorkerCleanupError(stage, error); }
  },
});
