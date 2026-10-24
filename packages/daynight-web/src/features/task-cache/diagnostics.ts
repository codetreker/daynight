import { ApiError } from "../../api/client";
import { GraphDataError } from "../task-graph/model";
import { TaskCacheError } from "./database";

const apiCodes = new Set(["network", "protocol", "principal_mismatch", "not_found", "unauthenticated", "forbidden", "version_conflict", "last_admin", "invitation_unavailable", "graph_limit_exceeded", "invalid_input"]);
const domNames = new Set(["AbortError", "ConstraintError", "DataError", "InvalidAccessError", "InvalidStateError", "NotFoundError", "QuotaExceededError", "ReadOnlyError", "SecurityError", "TransactionInactiveError", "UnknownError", "VersionError"]);
type SafeCause = {
  readonly name: string;
  readonly category?: TaskCacheError["category"];
  readonly kind?: ApiError["kind"];
  readonly code?: string;
  readonly cause?: SafeCause;
};
const safeCause = (error: unknown, depth = 0): SafeCause => {
  const nested = error instanceof Error && error.cause !== undefined && depth < 3 ? { cause: safeCause(error.cause, depth + 1) } : {};
  if (error instanceof TaskCacheError) return { name: "TaskCacheError", category: error.category, ...nested };
  if (error instanceof ApiError) return { name: "ApiError", kind: error.kind, ...(apiCodes.has(error.code) ? { code: error.code } : {}), ...nested };
  if (error instanceof DOMException) return { name: domNames.has(error.name) ? error.name : "DOMException" };
  if (error instanceof GraphDataError) return { name: "GraphDataError" };
  return { name: "Error", ...nested };
};

export const taskCacheFailureDiagnostic = (error: unknown): { readonly error_category: string; readonly cause: SafeCause } => ({
  error_category: error instanceof TaskCacheError ? error.category : error instanceof ApiError ? error.kind : "storage",
  cause: safeCause(error),
});
