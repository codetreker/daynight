import { validWorktreePath } from "../commands/worker/monitoring/worktree.js";
import { array, bool, count, fields, id, malformed, nullableTimestamp, record, text, timestamp } from "./validation.js";
import type { Observation } from "../commands/worker/monitoring/types.js";

export type MonitoringReceipt = { readonly revision: string; readonly runId: string; readonly sequence: string; readonly receivedAt: string; readonly expiresAt: string };
export type MonitoringRead = { readonly state: "absent" } | { readonly state: "available"; readonly revision: string; readonly runId: string; readonly sequence: string };
const sequence = (value: unknown): string => {
  const s = text(value);
  if (!/^[1-9][0-9]{0,18}$/.test(s) || BigInt(s) > 9_223_372_036_854_775_807n) return malformed();
  return s;
};
const exact = (value: unknown, names: readonly string[]): Record<string, unknown> => {
  const v = fields(value, names);
  if (Object.keys(v).length !== names.length) return malformed();
  return v;
};
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T => typeof value === "string" && values.includes(value as T) ? value as T : malformed();
const list = (value: unknown, max: number, parse: (value: unknown) => void): void => { const items = array(value, (item) => item); if (items.length > max) malformed(); items.forEach(parse); };
const nullable = (value: unknown, parse: (value: unknown) => unknown): void => { if (value !== null) parse(value); };
const boundedText = (value: unknown, bytes: number): void => { const s = text(value, true); if (Buffer.byteLength(s, "utf8") > bytes) malformed(); };
const scheduler = ["initializing", "configuration", "inventory", "project-preparation", "resource-observation", "reconciliation", "claim-search", "claim-request", "archive-backfill", "waiting-poll", "stopping", "stopped"] as const;
const execution = ["observation", "worktree-preparation", "agent-start", "agent-observation", "input-submission", "preparing", "executing", "verifying", "completing", "waiting", "paused"] as const;
const cleanup = ["observation", "agent-stop", "backend-close", "archive", "worktree-removal"] as const;
const reasons = ["configuration-unavailable", "configuration-incomplete", "inventory-unavailable", "project-unavailable", "project-preparation-failed", "resource-observation-unavailable", "capacity-full", "cleanup-capacity-blocked", "no-projects-selected", "no-ready-tasks", "claim-unconfirmed", "retained-resource-conflict", "stopping"] as const;
const deliveryPhases = ["read", "write", "reconcile", "shutdown"] as const;
const coverage = (v: unknown): void => { oneOf(v, ["unknown", "complete", "partial"]); };
const detail = (v: unknown): void => { oneOf(v, ["complete", "partial"]); };
const scope = (v: unknown): string => { const r = record(v); const kind = oneOf(r.kind, ["worker", "project", "claim"]); const obj = exact(v, kind === "worker" ? ["kind"] : kind === "project" ? ["kind", "projectId"] : ["kind", "projectId", "taskId", "claimId"]); if (kind !== "worker") id(obj.projectId); if (kind === "claim") { id(obj.taskId); id(obj.claimId); } return kind; };
const association = (v: unknown): void => { if (v === null) return; const r = record(v); const kind = oneOf(r.kind, ["project", "task", "labels-omitted"]); const obj = exact(v, kind === "project" ? ["kind", "projectName"] : kind === "task" ? ["kind", "projectName", "title"] : ["kind"]); if (kind !== "labels-omitted") boundedText(obj.projectName, 1024); if (kind === "task") boundedText(obj.title, 1024); };
const causes: Record<string, string> = {
  cancelled: "The operation was cancelled.", timeout: "The operation timed out.", "authentication-required": "Authentication is required.", "limit-exceeded": "An operation limit was exceeded.", "rate-limited": "The operation was rate limited.", "permission-denied": "Permission was denied.", "not-found-or-inaccessible": "A required resource was not found or is inaccessible.", "not-found": "A required resource was not found.", conflict: "The operation encountered a conflict.", unavailable: "A required service or resource is unavailable.", "invalid-response": "The response was invalid.", "resource-exhausted": "A required resource was exhausted.", "configuration-missing": "Required configuration is missing.", "configuration-invalid": "The configuration is invalid.", "command-failed": "A required command failed.", "io-error": "A required I/O operation failed.", "invalid-output": "A required operation produced invalid output.", "recovery-limit": "The recovery limit was reached.", "native-identity-missing": "The original native execution identity is missing.", "worktree-validation-failed": "The worktree failed ownership validation.", "branch-mismatch": "The worktree branch does not match the recorded owner.", "recovery-blocked": "Recovery is blocked and needs attention.", "outcome-unknown": "The operation outcome is unknown.", unknown: "The operation failed; inspect local Worker diagnostics for details.",
};
const structured = (v: unknown): void => { const r = exact(v, ["type", "code", "cause", "causeTruncated"]); if (r.type !== "operation" || typeof r.code !== "string" || !Object.hasOwn(causes, r.code) || r.cause !== causes[r.code] || r.causeTruncated !== false) malformed(); };
const projected = (v: unknown, names: string[]): Record<string, unknown> => {
  const r = exact(v, [...names, "association"]), kind = scope(r.scope);
  association(r.association);
  if (kind === "worker" ? r.association !== null : r.association === null || ![kind === "claim" ? "task" : "project", "labels-omitted"].includes(String(record(r.association).kind))) malformed();
  return r;
};
const parseData = (v: unknown, runId: string, seq: string): void => {
  const o = exact(v, ["runId", "sequence", "capturedAt", "lifecycle", "scheduler", "capacity", "admission", "reservations", "activities", "currentFailures", "lastRecovery", "detailCoverage", "delivery"]);
  if (id(o.runId) !== runId || sequence(o.sequence) !== seq) malformed(); timestamp(o.capturedAt); oneOf(o.lifecycle, ["starting", "running", "stopping", "stopped"]); detail(o.detailCoverage);
  const s = exact(o.scheduler, ["phase", "coverage", "cycleId", "lastCompletedAt", "lastSuccessfulAt", "lastOutcome", "nextPollAt"]); oneOf(s.phase, scheduler); coverage(s.coverage); nullable(s.cycleId, id); nullableTimestamp(s.lastCompletedAt); nullableTimestamp(s.lastSuccessfulAt); nullable(s.lastOutcome, v => oneOf(v, ["completed", "failed", "cancelled"])); nullableTimestamp(s.nextPollAt);
  if (o.capacity !== null) { const c = exact(o.capacity, ["observedAt", "quality", "limit", "occupied", "available", "detailCoverage"]); timestamp(c.observedAt); oneOf(c.quality, ["current", "stale"]); const limit = count(c.limit), occupied = count(c.occupied), available = count(c.available); if (limit < 1 || limit > 64 || available !== Math.max(0, limit - occupied)) malformed(); detail(c.detailCoverage); }
  const a = exact(o.admission, ["observedAt", "coverage", "reasons"]); timestamp(a.observedAt); coverage(a.coverage);
  list(a.reasons, 16, v => { const r = projected(v, ["code", "scope", "observedAt", "nextAttemptAt"]); oneOf(r.code, reasons); timestamp(r.observedAt); nullableTimestamp(r.nextAttemptAt); });
  list(o.reservations, 128, v => { const r = projected(v, ["reservationId", "scope", "roles", "occupied", "observedAt"]); id(r.reservationId); const roles = array(r.roles, x => oneOf(x, ["active-task", "resource-owner", "unresolved", "cleanup", "pending-stop"])); if (!roles.length || roles.length > 5 || new Set(roles).size !== roles.length) malformed(); bool(r.occupied); timestamp(r.observedAt); });
  list(o.activities, 128, v => { const r = projected(v, ["kind", "phase", "operationId", "status", "scope", "startedAt", "lastProgressAt", "elapsedMs", "deadlineAt", "waitReason", "nextAttemptAt"]); const kind = oneOf(r.kind, ["execution", "cleanup", "maintenance"]); oneOf(r.phase, kind === "execution" ? execution : kind === "cleanup" ? cleanup : scheduler); id(r.operationId); oneOf(r.status, ["queued", "running", "waiting", "paused"]); timestamp(r.startedAt); nullableTimestamp(r.lastProgressAt); count(r.elapsedMs); nullableTimestamp(r.deadlineAt); nullable(r.waitReason, x => oneOf(x, ["native-input", "retry-backoff", "task-paused", "resource-stop", "operation-lock", "recovery-blocked", "initializing", "unknown"])); nullableTimestamp(r.nextAttemptAt); });
  list(o.currentFailures, 32, v => { const hasWorktree = Object.hasOwn(record(v), "worktree"); const r = projected(v, ["operationId", "component", "phase", "scope", "error", "firstObservedAt", "lastObservedAt", "occurrencesInRun", "retryState", "nextAttemptAt", ...(hasWorktree ? ["worktree"] : [])]); if (hasWorktree) { if (scope(r.scope) !== "claim") malformed(); const item = record(r.worktree); const kind = oneOf(item.kind, ["project-relative", "unavailable"]); const w = exact(item, kind === "project-relative" ? ["kind", "path"] : ["kind", "reason"]); if (kind === "project-relative") { if (typeof w.path !== "string" || !validWorktreePath(w.path)) malformed(); } else oneOf(w.reason, ["different-volume", "invalid-path", "limit-exceeded"]); } id(r.operationId); const component = oneOf(r.component, ["runtime", "scheduler", "configuration", "inventory", "project", "resources", "execution", "cleanup", "archive", "monitoring"]); oneOf(r.phase, component === "execution" ? execution : component === "cleanup" ? cleanup : component === "monitoring" ? deliveryPhases : scheduler); structured(r.error); timestamp(r.firstObservedAt); timestamp(r.lastObservedAt); count(r.occurrencesInRun); const state = oneOf(r.retryState, ["none", "scheduled", "running", "manual"]); nullableTimestamp(r.nextAttemptAt); if ((state === "scheduled") !== (r.nextAttemptAt !== null)) malformed(); });
  if (o.lastRecovery !== null) { const r = projected(o.lastRecovery, ["operationId", "component", "scope", "observedAt", "explanation", "explanationTruncated"]); id(r.operationId); oneOf(r.component, ["runtime", "scheduler", "configuration", "inventory", "project", "resources", "execution", "cleanup", "archive", "monitoring"]); timestamp(r.observedAt); if (r.explanation !== "The operation recovered." || r.explanationTruncated !== false) malformed(); }
  const d = exact(o.delivery, ["lastSucceededAt", "lastFailure"]); nullableTimestamp(d.lastSucceededAt); if (d.lastFailure !== null) { const f = exact(d.lastFailure, ["observedAt", "phase", "error", "requestId"]); timestamp(f.observedAt); oneOf(f.phase, deliveryPhases); structured(f.error); nullable(f.requestId, id); }
};
export const parseMonitoringReceipt = (value: unknown, observation: Observation): MonitoringReceipt => {
  const r = exact(value, ["revision", "runId", "sequence", "receivedAt", "expiresAt"]); const result = { revision: id(r.revision), runId: id(r.runId), sequence: sequence(r.sequence), receivedAt: timestamp(r.receivedAt), expiresAt: timestamp(r.expiresAt) };
  if (result.runId !== observation.runId || result.sequence !== observation.sequence || Date.parse(result.expiresAt) - Date.parse(result.receivedAt) !== 3_600_000) malformed(); return result;
};
export const parseMonitoringRead = (value: unknown): MonitoringRead => {
  const r = exact(value, ["observedAt", "state", "revision", "runId", "sequence", "receivedAt", "expiresAt", "data", "detailCoverage", "permissionProjection"]); timestamp(r.observedAt); const state = oneOf(r.state, ["absent", "available"]); detail(r.detailCoverage); oneOf(r.permissionProjection, ["current", "restricted"]);
  if (state === "absent") { if (r.revision !== null || r.runId !== null || r.sequence !== null || r.receivedAt !== null || r.expiresAt !== null || r.data !== null || r.detailCoverage !== "complete" || r.permissionProjection !== "current") malformed(); return { state }; }
  const revision = id(r.revision), runId = id(r.runId), seq = sequence(r.sequence); const received = timestamp(r.receivedAt), expires = timestamp(r.expiresAt); if (Date.parse(expires) - Date.parse(received) !== 3_600_000) malformed(); parseData(r.data, runId, seq); return { state, revision, runId, sequence: seq };
};
