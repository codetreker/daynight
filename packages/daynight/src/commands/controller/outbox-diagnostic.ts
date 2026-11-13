import { serializeSqliteError, SqliteAccessError, type SafeSqliteError } from "../../platform/sqlite-error.js";
import type { ControllerLaunchTicket } from "./launch-ticket.js";

const phases = new Set(["outbox-read", "outbox-append", "outbox-ack", "outbox-clear"]);

// Cleanup and transaction wrappers may retain the invariant failure as a cause
// or an AggregateError member. Never replace the original error or its outcome.
const findOutboxFailure = (error: unknown): SqliteAccessError | undefined => {
  const pending = [error], seen = new Set<unknown>();
  while (pending.length) {
    const value = pending.pop();
    if (!(value instanceof Error) || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof SqliteAccessError && phases.has(value.context.phase)) return value;
    if (value.cause !== undefined) pending.push(value.cause);
    if (value instanceof AggregateError) pending.push(...value.errors);
  }
  return undefined;
};

// Generic error names can be supplied by a provider. The SQLite serializer
// deliberately excludes raw messages; restrict names as well for this log.
const safeNames = (value: SafeSqliteError): void => {
  if (!new Set(["SqliteAccessError", "Error", "AggregateError", "TypeError", "RangeError", "SyntaxError"]).has(value.name)) value.name = "Error";
  if (value.cause) safeNames(value.cause);
  value.errors?.forEach(safeNames);
};

export const isOutboxFailure = (error: unknown): boolean => findOutboxFailure(error) !== undefined;

export const formatOutboxDiagnostic = (error: unknown, ticket: ControllerLaunchTicket): string | undefined => {
  const outbox = findOutboxFailure(error);
  if (!outbox) return undefined;
  const identity = { kind: "controller-sqlite-error", component: "outbox", phase: outbox.context.phase, executionId: ticket.executionId, sessionId: ticket.sessionId, ...(ticket.claimId === undefined ? { testExecutionId: ticket.testExecutionId } : { claimId: ticket.claimId }), generation: ticket.executionGeneration };
  const serialized = serializeSqliteError(error);
  safeNames(serialized);
  let result = JSON.stringify({ ...identity, error: serialized });
  if (result.length <= 4070) return result;
  // Retain the outer transaction outcome when present and the invariant's own
  // classification. Dropping optional details keeps the JSON complete.
  result = JSON.stringify({ ...identity, error: { name: "SqliteAccessError", kind: outbox.kind, outcome: error instanceof SqliteAccessError ? error.outcome : outbox.outcome }, truncated: true });
  return result;
};
