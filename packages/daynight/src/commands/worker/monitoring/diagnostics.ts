import { ApiError } from "../../../api/client.js";
import { OperationError } from "../../../api/operation.js";
import { ProtocolError } from "../../../api/parse.js";
import { WorkerCleanupError } from "../cleanup-error.js";
import { WorktreePreconditionError } from "../worktrees.js";
import { NativeVersionOutputError } from "../herdr/version-probe.js";
import { HerdrCommandDeadlineError, HerdrCommandError } from "../herdr/command.js";
import type { DiagnosticCode, StructuredCause } from "./types.js";

const messages: Record<DiagnosticCode, string> = {
  cancelled: "The operation was cancelled.", timeout: "The operation timed out.",
  "authentication-required": "Authentication is required.", "limit-exceeded": "An operation limit was exceeded.",
  "rate-limited": "The operation was rate limited.", "permission-denied": "Permission was denied.",
  "not-found-or-inaccessible": "A required resource was not found or is inaccessible.", "not-found": "A required resource was not found.",
  conflict: "The operation encountered a conflict.", unavailable: "A required service or resource is unavailable.",
  "invalid-response": "The response was invalid.", "resource-exhausted": "A required resource was exhausted.",
  "configuration-missing": "Required configuration is missing.", "configuration-invalid": "The configuration is invalid.",
  "command-failed": "A required command failed.", "io-error": "A required I/O operation failed.",
  "invalid-output": "A required operation produced invalid output.", "recovery-limit": "The recovery limit was reached.",
  "native-identity-missing": "The original native execution identity is missing.",
  "worktree-validation-failed": "The worktree failed ownership validation.", "branch-mismatch": "The worktree branch does not match the recorded owner.",
  "recovery-blocked": "Recovery is blocked and needs attention.", "outcome-unknown": "The operation outcome is unknown.",
  unknown: "The operation failed; inspect local Worker diagnostics for details.",
};

// Only a caller that has read the typed Web recovery state may construct this evidence.
export class MonitoringRecoveryEvidence extends Error {
  constructor(readonly reasonCode: "native_identity_missing" | "recovery_limit" | "recovery_blocked") { super("Worker recovery is blocked."); }
}

/** Construct a fixed summary only from a fact established by the caller's operation boundary. */
export const diagnostic = (code: DiagnosticCode): StructuredCause => ({ type: "operation", code, cause: messages[code], causeTruncated: false });

export const classifyFailure = (input: unknown, outcomeUnconfirmed = false): StructuredCause => {
  if (outcomeUnconfirmed) return diagnostic("outcome-unknown");
  // Only these wrappers have a known cause relationship; never inspect arbitrary error chains.
  const error = input instanceof WorkerCleanupError ? input.cause : input;
  if (error instanceof ApiError && error.outcomeUnconfirmed) return diagnostic("outcome-unknown");
  const operation = error instanceof ApiError && error.cause instanceof OperationError ? error.cause : error;
  if (operation instanceof OperationError) {
    switch (operation.kind) {
      case "cancelled": return diagnostic("cancelled");
      case "deadline": case "request_timeout": return diagnostic("timeout");
      case "request_limit": case "response_limit": case "total_limit": return diagnostic("limit-exceeded");
      case "disposed": return diagnostic("unknown");
    }
  }
  if (error instanceof ApiError) {
    if (error.phase === "response") {
      switch (error.status) {
        case 401: return diagnostic("authentication-required"); case 403: return diagnostic("permission-denied");
        case 404: return diagnostic("not-found-or-inaccessible"); case 409: return diagnostic("conflict");
        case 413: return diagnostic("limit-exceeded"); case 429: return diagnostic("rate-limited"); case 503: return diagnostic("unavailable");
      }
    }
    if (error.phase === "protocol" || error.phase === "pagination") return diagnostic("invalid-response");
    return diagnostic("unknown");
  }
  if (error instanceof MonitoringRecoveryEvidence) {
    switch (error.reasonCode) {
      case "native_identity_missing": return diagnostic("native-identity-missing");
      case "recovery_limit": return diagnostic("recovery-limit");
      case "recovery_blocked": return diagnostic("recovery-blocked");
    }
  }
  if (error instanceof ProtocolError) return diagnostic("invalid-response");
  if (error instanceof WorktreePreconditionError) return diagnostic(error.code === "branch_mismatch" ? "branch-mismatch" : "worktree-validation-failed");
  if (error instanceof NativeVersionOutputError) return diagnostic("invalid-output");
  if (error instanceof HerdrCommandDeadlineError) return diagnostic("timeout");
  if (error instanceof HerdrCommandError && Number.isSafeInteger(error.exitCode) && error.exitCode !== 0) return diagnostic("command-failed");
  return diagnostic("unknown");
};
