import { existsSync } from "node:fs";
import path from "node:path";
import { canonicalId } from "../../api/parse.js";
import { openWebExecutionStore } from "./backends/web-store.js";
import type { ResourceOwner } from "./types.js";

/** A schedule is active only when its original Web journal proves the same owner. */
export const createWebCleanupOwners = (workerDirectory: string, serverOrigin: string, workerId: string, userId: string) => {
  const file = path.join(workerDirectory, "web-executions.sqlite");
  let journal: ReturnType<typeof openWebExecutionStore> | undefined;
  return {
    contains: (owner: ResourceOwner): boolean => {
      if ([owner.projectId, owner.taskId, owner.claimId, owner.worktreeId].some(id => canonicalId(id) !== id)) return false;
      if (journal === undefined && !existsSync(file)) return false;
      journal ??= openWebExecutionStore(file);
      const task = journal.getTask(owner);
      return task !== null && task.worktreeId === owner.worktreeId && task.serverOrigin === serverOrigin && task.workerId === workerId && task.userId === userId;
    },
    close: (): void => { journal?.close(); },
  };
};
