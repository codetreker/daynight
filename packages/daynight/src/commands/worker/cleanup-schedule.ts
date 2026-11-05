import type { WorkerStore } from "./store.js";
import type { CleanupScheduleRecord, ResourceOwner } from "./types.js";

// Retain resource ownership and the original policy deadline across retries.
export const ensureCleanupSchedule = (store: WorkerStore, owner: ResourceOwner, now: number): CleanupScheduleRecord => {
  const previous = store.getCleanupSchedule(owner);
  if (previous !== null) {
    if (previous.worktreeId !== owner.worktreeId) throw new Error("The cleanup claim has conflicting worktree identities.");
    return previous;
  }
  return store.saveCleanupSchedule(owner, { deadline: now + 600_000, failures: 0, nextAttemptAt: now, stage: "observation", lastError: null });
};
