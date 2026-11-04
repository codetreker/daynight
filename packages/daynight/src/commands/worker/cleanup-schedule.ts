import type { WorkerStore } from "./store.js";
import type { CleanupScheduleRecord, ResourceOwner } from "./types.js";

// Persist responsibility before any cleanup side effect; a restart must not replay input.
export const ensureCleanupSchedule = (store: WorkerStore, owner: ResourceOwner, now: number): CleanupScheduleRecord => {
  const previous = store.getCleanupSchedule(owner);
  if (previous !== null) {
    if (previous.worktreeId !== owner.worktreeId) throw new Error("The cleanup claim has conflicting worktree identities.");
    return previous;
  }
  return store.saveCleanupSchedule(owner, { deadline: now + 600_000, notified: false, submitted: false, failures: 0, nextAttemptAt: now, stage: "observation", lastError: null });
};
