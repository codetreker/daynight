import { ExecutionSourceConflictError } from "./execution-stop.js";
import type { CleanupAttempt, ExecutionRef, ExecutionStoppedNotice, StopObservation } from "./execution-stop.js";
import type { ResourceOwner } from "./types.js";

type ObservationTicket = { owner: ResourceOwner; sequence: bigint };
type Entry = {
  attempt: CleanupAttempt;
  sequence: bigint;
  observation: StopObservation | null;
  diagnostic: Extract<StopObservation, { kind: "unknown" }> | null;
  conflict: boolean;
};

const ownerKey = (owner: ResourceOwner): string => JSON.stringify([owner.projectId, owner.taskId, owner.claimId, owner.worktreeId]);
const sameOwner = (a: ResourceOwner, b: ResourceOwner): boolean => ownerKey(a) === ownerKey(b);
const sameExecution = (a: ExecutionRef, b: ExecutionRef): boolean =>
  sameOwner(a.owner, b.owner) && a.backend === b.backend && a.runKey === b.runKey;
const ownerOf = (observation: Exclude<StopObservation, { kind: "unknown" }>): ResourceOwner =>
  observation.kind === "not-started" ? observation.owner : observation.execution.owner;
const matchesTarget = (owner: ResourceOwner, target: Extract<StopObservation, { kind: "unknown" }>["target"]): boolean =>
  target.projectId === owner.projectId && target.taskId === owner.taskId && target.claimId === owner.claimId
  && (target.worktreeId === undefined || target.worktreeId === owner.worktreeId);
const stopped = (entry: Entry): boolean => !entry.conflict && (entry.observation?.kind === "stopped" || entry.observation?.kind === "not-started");
const copyObservation = (observation: StopObservation): StopObservation => {
  if (observation.kind === "unknown") return { ...observation, target: { ...observation.target } };
  if (observation.kind === "not-started") return { ...observation, owner: { ...observation.owner } };
  return { ...observation, execution: { ...observation.execution, owner: { ...observation.execution.owner } } };
};

/** Runtime-only execution facts. The coordinator establishes terminal intent before observing. */
export const createExecutionCapacity = (onChange: () => void) => {
  const entries = new Map<string, Entry>();
  let sequence = 0n;
  const next = () => ++sequence;

  const beginAttempt = (attempt: CleanupAttempt): void => {
    const owner = { ...attempt.owner };
    const key = ownerKey(owner), current = entries.get(key);
    if (current) {
      current.attempt = { attemptId: attempt.attemptId, owner };
      current.sequence = next();
    } else {
      entries.set(key, { attempt: { attemptId: attempt.attemptId, owner }, sequence: next(), observation: null, diagnostic: null, conflict: false });
    }
  };

  const beginObservation = (owner: ResourceOwner): ObservationTicket | null => {
    const entry = entries.get(ownerKey(owner));
    if (!entry) return null;
    entry.sequence = next();
    return { owner: { ...owner }, sequence: entry.sequence };
  };

  const apply = (entry: Entry, owner: ResourceOwner, observation: StopObservation): boolean => {
    if (observation.kind === "unknown" ? !matchesTarget(owner, observation.target) : !sameOwner(owner, ownerOf(observation))) return false;
    const wasStopped = stopped(entry);
    if (observation.kind === "unknown") {
      entry.diagnostic = copyObservation(observation) as typeof observation;
      if (observation.error instanceof ExecutionSourceConflictError) entry.conflict = true;
      if (entry.observation === null && !entry.conflict) entry.observation = copyObservation(observation);
    } else if (!entry.conflict) {
      const previous = entry.observation;
      const hasPreviousExecution = previous?.kind === "running" || previous?.kind === "stopped";
      const hasNextExecution = observation.kind === "running" || observation.kind === "stopped";
      const sourcesConflict = (hasPreviousExecution && hasNextExecution && !sameExecution(previous.execution, observation.execution))
        || (hasPreviousExecution && observation.kind === "not-started")
        || (previous?.kind === "not-started" && hasNextExecution)
        || (previous?.kind === "stopped" && observation.kind === "running");
      if (sourcesConflict) {
        entry.conflict = true;
        entry.diagnostic = { kind: "unknown", target: { ...owner }, error: new Error("Conflicting original execution observations."), observedAt: observation.observedAt };
      } else {
        entry.observation = copyObservation(observation);
        entry.diagnostic = null;
      }
    }
    if (wasStopped !== stopped(entry)) onChange();
    return true;
  };

  const commitObservation = (ticket: ObservationTicket, observation: StopObservation): boolean => {
    const entry = entries.get(ownerKey(ticket.owner));
    if (!entry || entry.sequence !== ticket.sequence) return false;
    return apply(entry, ticket.owner, observation);
  };

  const notify = (notice: ExecutionStoppedNotice): boolean => {
    const owner = notice.attempt.owner, entry = entries.get(ownerKey(owner));
    if (!entry || entry.attempt.attemptId !== notice.attempt.attemptId || !sameOwner(entry.attempt.owner, owner)
      || !sameOwner(owner, ownerOf(notice.observation))) return false;
    entry.sequence = next();
    return apply(entry, owner, notice.observation);
  };

  const invalidate = (owner: ResourceOwner): void => {
    const key = ownerKey(owner), entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    next();
    if (stopped(entry)) onChange();
  };

  return {
    beginAttempt, beginObservation, commitObservation, notify, invalidate,
    isStopped: (owner: ResourceOwner): boolean => { const entry = entries.get(ownerKey(owner)); return entry !== undefined && stopped(entry); },
    getObservation: (owner: ResourceOwner): StopObservation | null => {
      const entry = entries.get(ownerKey(owner));
      return entry ? (entry.conflict || !stopped(entry) && entry.diagnostic ? entry.diagnostic : entry.observation) : null;
    },
    getDiagnostic: (owner: ResourceOwner): Extract<StopObservation, { kind: "unknown" }> | null => entries.get(ownerKey(owner))?.diagnostic ?? null,
  };
};
