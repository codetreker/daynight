import { ExecutionSourceConflictError } from "./execution-stop.js";
import type { CleanupAttempt, ExecutionRef, ExecutionStoppedNotice, StopObservation } from "./execution-stop.js";
import type { ResourceOwner } from "./types.js";

const ownerKey = (owner: ResourceOwner): string => JSON.stringify([owner.projectId, owner.taskId, owner.claimId, owner.worktreeId]);
const sameExecution = (a: ExecutionRef, b: ExecutionRef): boolean => ownerKey(a.owner) === ownerKey(b.owner) && a.backend === b.backend && a.runKey === b.runKey;
type Entry = { owner: ResourceOwner; sequence: number; attempt: string | null; observation: StopObservation | null };

/** In-memory observations are invalidated before a new execution can be admitted. */
export const createExecutionCapacity = (changed: (owner: ResourceOwner, stopped: boolean) => void) => {
  const entries = new Map<string, Entry>();
  const entry = (owner: ResourceOwner): Entry => {
    const key = ownerKey(owner);
    let value = entries.get(key);
    if (value === undefined) { value = { owner, sequence: 0, attempt: null, observation: null }; entries.set(key, value); }
    return value;
  };
  const isStopped = (value: StopObservation | null): boolean => value?.kind === "stopped" || value?.kind === "not-started";
  const set = (item: Entry, observation: StopObservation | null): void => {
    const before = isStopped(item.observation), after = isStopped(observation);
    item.observation = observation;
    if (before !== after) changed(item.owner, after);
  };
  return {
    invalidate(owner: ResourceOwner): void { const item = entry(owner); item.sequence++; item.attempt = null; set(item, null); },
    beginAttempt(attempt: CleanupAttempt): void { entry(attempt.owner).attempt = attempt.attemptId; },
    endAttempt(attempt: CleanupAttempt): void { const item = entry(attempt.owner); if (item.attempt === attempt.attemptId) item.attempt = null; },
    beginObservation(owner: ResourceOwner): number { return ++entry(owner).sequence; },
    observe(owner: ResourceOwner, sequence: number, observation: StopObservation): void {
      const item = entry(owner);
      if (item.sequence !== sequence) return;
      if (observation.kind === "unknown") {
        if (observation.error instanceof ExecutionSourceConflictError) item.attempt = null;
        else if (isStopped(item.observation)) return;
      } else {
        const actual = observation.kind === "not-started" ? observation.owner : observation.execution.owner;
        if (ownerKey(actual) !== ownerKey(owner)) return;
        if (item.observation?.kind === "stopped" && observation.kind === "running" && sameExecution(item.observation.execution, observation.execution)) return;
      }
      set(item, observation);
    },
    notice(notice: ExecutionStoppedNotice): void {
      const item = entry(notice.attempt.owner), observation = notice.observation;
      if (item.attempt !== notice.attempt.attemptId) return;
      const actual = observation.kind === "not-started" ? observation.owner : observation.execution.owner;
      if (ownerKey(actual) !== ownerKey(item.owner)) return;
      if (item.observation?.kind === "running" || item.observation?.kind === "stopped") {
        if (observation.kind !== "stopped" || !sameExecution(observation.execution, item.observation.execution)) return;
      } else if (item.observation?.kind === "not-started" && observation.kind !== "not-started") return;
      item.sequence++;
      set(item, observation);
    },
    stopped(owner: ResourceOwner): boolean { return isStopped(entries.get(ownerKey(owner))?.observation ?? null); },
  };
};
