import { bool, fields, id as parseId, malformed, text, timestamp } from "../../api/validation.js";
import { botVersion } from "./api.js";
import type { CleanupResult } from "./api.js";

export type BotDeletionBinding = { readonly sessionId: string; readonly testExecutionId: string; readonly executionGeneration: string; readonly controllerId: string; readonly controllerInstanceId: string };
export type BotDeletionDecision = { readonly operationId: string; readonly requestedVersion: string; readonly actorUserId: string; readonly reason: string; readonly acknowledgedAt: string; readonly localDisposition: "unverified" };
/** Separate recovery projection keeps the ordinary Bot deletion protocol unchanged. */
export type BotDeletionRecovery = {
  readonly schemaVersion: 1; readonly botId: string; readonly version: string; readonly deletionId: string; readonly requestedVersion: string; readonly workerId: string; readonly hostingWorkerId: string;
  readonly requiresStopProof: boolean; readonly recoveryRequired: boolean; readonly originalBinding: BotDeletionBinding | null;
  readonly workerCleanup: CleanupResult; readonly decision: BotDeletionDecision | null; readonly serverCleanup: CleanupResult;
};
export type ResolveBotDeletionInput = { readonly action: "accept_unverified"; readonly ifVersion: string; readonly deletionId: string; readonly operationId: string; readonly acknowledgeLocalUnverified: true; readonly reason: string }
  | { readonly action: "retry_cleanup"; readonly ifVersion: string; readonly deletionId: string; readonly operationId: string };
const id = (value: unknown): string => { const result = parseId(value); return result === "00000000-0000-0000-0000-000000000000" ? malformed() : result; };

export const botDeletionReason = (value: unknown): string => {
  const reason = text(value, true);
  if (reason.trim().length === 0 || [...reason].length > 1000 || reason.includes("\0")) return malformed();
  return reason;
};
const cleanup = (value: unknown): CleanupResult => {
  const data = fields(value, ["state", "code"]);
  if (data.state !== "pending" && data.state !== "completed" && data.state !== "failed") return malformed();
  const code = data.code === null ? null : text(data.code, true);
  if ((data.state === "failed") !== (code !== null)) return malformed();
  return { state: data.state, code };
};
export const parseBotDeletionRecovery = (value: unknown, expectedBotId?: string): BotDeletionRecovery => {
  const data = fields(value, ["schemaVersion", "botId", "version", "deletionId", "requestedVersion", "workerId", "hostingWorkerId", "requiresStopProof", "recoveryRequired", "originalBinding", "workerCleanup", "decision", "serverCleanup"]);
  if (data.schemaVersion !== 1) return malformed();
  let originalBinding: BotDeletionBinding | null = null;
  if (data.originalBinding !== null) {
    const binding = fields(data.originalBinding, ["sessionId", "testExecutionId", "executionGeneration", "controllerId", "controllerInstanceId"]);
    originalBinding = { sessionId: id(binding.sessionId), testExecutionId: id(binding.testExecutionId), executionGeneration: botVersion(binding.executionGeneration), controllerId: id(binding.controllerId), controllerInstanceId: id(binding.controllerInstanceId) };
  }
  let decision: BotDeletionDecision | null = null;
  if (data.decision !== null) {
    const saved = fields(data.decision, ["operationId", "requestedVersion", "actorUserId", "reason", "acknowledgedAt", "localDisposition"]);
    if (saved.localDisposition !== "unverified") return malformed();
    decision = { operationId: id(saved.operationId), requestedVersion: botVersion(saved.requestedVersion), actorUserId: id(saved.actorUserId), reason: botDeletionReason(saved.reason), acknowledgedAt: timestamp(saved.acknowledgedAt), localDisposition: "unverified" };
  }
  const result: BotDeletionRecovery = { schemaVersion: 1, botId: id(data.botId), version: botVersion(data.version), deletionId: id(data.deletionId), requestedVersion: botVersion(data.requestedVersion), workerId: id(data.workerId), hostingWorkerId: id(data.hostingWorkerId), requiresStopProof: bool(data.requiresStopProof), recoveryRequired: bool(data.recoveryRequired), originalBinding, workerCleanup: cleanup(data.workerCleanup), decision, serverCleanup: cleanup(data.serverCleanup) };
  const evidenceMissing = result.workerCleanup.state === "failed" && result.workerCleanup.code === "execution_evidence_missing";
  if (expectedBotId !== undefined && result.botId !== expectedBotId || BigInt(result.requestedVersion) >= BigInt(result.version)
    || result.requiresStopProof !== (result.originalBinding !== null)
    || result.recoveryRequired !== (evidenceMissing && decision === null && result.serverCleanup.state !== "completed")
    || decision !== null && (!evidenceMissing || BigInt(decision.requestedVersion) >= BigInt(result.version))) return malformed();
  return result;
};
export const parseResolveBotDeletionInput = (value: ResolveBotDeletionInput): ResolveBotDeletionInput => {
  const common = { ifVersion: botVersion(value.ifVersion), deletionId: id(value.deletionId), operationId: id(value.operationId) };
  if (value.action === "retry_cleanup") return { action: value.action, ...common };
  if (value.action !== "accept_unverified" || value.acknowledgeLocalUnverified !== true) return malformed();
  return { action: value.action, ...common, acknowledgeLocalUnverified: true, reason: botDeletionReason(value.reason) };
};
