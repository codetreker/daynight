import { ProtocolError } from "../../../api/parse.js";
import { normalizeServerUrl } from "../../../config/server.js";
import { isNonemptyText } from "../../../platform/text.js";
import { SESSION_PROTOCOL } from "../../../session/protocol.js";
import { botUUID, botVersion } from "./types.js";

export type BotRecoveryIdentity = { botRecoveryVersion: 1; serviceOrigin: string; recoveryIdentity: string };
export type BotRecoveryBinding = { sessionId: string; testExecutionId: string; nativeSessionId: string | null };
export type BotRecoveryRegistration = BotRecoveryIdentity & BotRecoveryBinding & { operationId: string; botVersion: string };
export type BotRecoveryControllerGrant = {
  protocol: typeof SESSION_PROTOCOL; testExecutionId: string; controllerId: string; controllerInstanceId: string;
  executionGeneration: string; kind: "bootstrap" | "reconnect"; previousGeneration: string | null;
  stopProof: { recordId: string; previousControllerInstanceId: string; stoppedAt: string } | null;
};
export type BotRecoveryGrant = BotRecoveryIdentity & BotRecoveryBinding & {
  operationId: string; expectedHostingGeneration: string; controllerToken: string; grant: BotRecoveryControllerGrant;
};
export type BotRecoveryReport = BotRecoveryIdentity & {
  hostingGeneration: string;
  report: {
    botVersion: string; fence: { sessionId: string; testExecutionId: string; executionGeneration: string; connectionEpoch: string } | null;
    controllerId: string; controllerInstanceId: string; nativeSessionId: string | null;
    result: { state: "ready" | "failed"; code: string | null };
  };
};
export type BotRecoveryReceipt = BotRecoveryBinding & {
  botRecoveryVersion: 1; operationId: string; kind: "register" | "takeover" | "grant"; workerId: string;
  hostingGeneration: string; botVersion: string; executionGeneration: string; controllerId: string; controllerInstanceId: string;
  grantExpiresAt: string | null; controllerTokenHash: string | null;
};
export type BotRecoveryResult = { receipt: BotRecoveryReceipt; current: boolean };

const identityKeys = ["botRecoveryVersion", "serviceOrigin", "recoveryIdentity"];
const bindingKeys = ["sessionId", "testExecutionId", "nativeSessionId"];
const fail = (): never => { throw new ProtocolError("Invalid Bot recovery protocol value."); };
const object = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return fail();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return fail();
  return value;
};
const text = (value: unknown): string => isNonemptyText(value) && value.trim() !== "" ? value : fail();
const id = (value: unknown): string => {
  const parsed = botUUID(value, "Bot recovery identity");
  return parsed !== "00000000-0000-0000-0000-000000000000" ? parsed : fail();
};
const nullableText = (value: unknown): string | null => value === null ? null : text(value);
const version = (value: unknown): 1 => value === 1 ? 1 : fail();
const secret = (value: unknown, prefix = ""): string => {
  if (typeof value !== "string" || !value.startsWith(prefix)) return fail();
  const raw = value.slice(prefix.length), decoded = Buffer.from(raw, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === raw ? value : fail();
};
const timestamp = (value: unknown): string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : fail();
const identity = (value: Record<string, unknown>): BotRecoveryIdentity => {
  const serviceOrigin = text(value.serviceOrigin);
  if (normalizeServerUrl(serviceOrigin) !== serviceOrigin) return fail();
  return { botRecoveryVersion: version(value.botRecoveryVersion), serviceOrigin, recoveryIdentity: secret(value.recoveryIdentity) };
};
const binding = (value: Record<string, unknown>): BotRecoveryBinding => ({ sessionId: id(value.sessionId), testExecutionId: id(value.testExecutionId), nativeSessionId: nullableText(value.nativeSessionId) });

export const parseBotRecoveryIdentity = (input: unknown): BotRecoveryIdentity => identity(object(input, identityKeys));
export const parseBotRecoveryRegistration = (input: unknown): BotRecoveryRegistration => {
  const value = object(input, [...identityKeys, ...bindingKeys, "operationId", "botVersion"]);
  return { ...identity(value), ...binding(value), operationId: id(value.operationId), botVersion: botVersion(value.botVersion) };
};
export const parseBotRecoveryGrant = (input: unknown): BotRecoveryGrant => {
  const value = object(input, [...identityKeys, ...bindingKeys, "operationId", "expectedHostingGeneration", "grant", "controllerToken"]);
  const grant = object(value.grant, ["protocol", "testExecutionId", "controllerId", "controllerInstanceId", "executionGeneration", "kind", "previousGeneration", "stopProof"]);
  if (grant.protocol !== SESSION_PROTOCOL || grant.kind !== "bootstrap" && grant.kind !== "reconnect") return fail();
  const previousGeneration = grant.previousGeneration === null ? null : botVersion(grant.previousGeneration);
  let stopProof: BotRecoveryControllerGrant["stopProof"] = null;
  if (grant.stopProof !== null) {
    const proof = object(grant.stopProof, ["recordId", "previousControllerInstanceId", "stoppedAt"]);
    stopProof = { recordId: id(proof.recordId), previousControllerInstanceId: id(proof.previousControllerInstanceId), stoppedAt: timestamp(proof.stoppedAt) };
  }
  if ((previousGeneration === null) !== (stopProof === null)) return fail();
  return { ...identity(value), ...binding(value), operationId: id(value.operationId), expectedHostingGeneration: botVersion(value.expectedHostingGeneration), controllerToken: secret(value.controllerToken, "dncontroller_"),
    grant: { protocol: SESSION_PROTOCOL, testExecutionId: id(grant.testExecutionId), controllerId: id(grant.controllerId), controllerInstanceId: id(grant.controllerInstanceId), executionGeneration: botVersion(grant.executionGeneration), kind: grant.kind, previousGeneration, stopProof } };
};
export const parseBotRecoveryReport = (input: unknown): BotRecoveryReport => {
  const value = object(input, [...identityKeys, "hostingGeneration", "report"]);
  const report = object(value.report, ["botVersion", "fence", "controllerId", "controllerInstanceId", "nativeSessionId", "result"]);
  let fence: BotRecoveryReport["report"]["fence"] = null;
  if (report.fence !== null) {
    const f = object(report.fence, ["sessionId", "testExecutionId", "executionGeneration", "connectionEpoch"]);
    fence = { sessionId: id(f.sessionId), testExecutionId: id(f.testExecutionId), executionGeneration: botVersion(f.executionGeneration), connectionEpoch: f.connectionEpoch === "0" ? "0" : botVersion(f.connectionEpoch) };
  }
  const result = object(report.result, ["state", "code"]);
  if (result.state !== "ready" && result.state !== "failed" || result.state === "ready" && result.code !== null || result.state === "failed" && result.code === null) return fail();
  if (typeof report.controllerId !== "string" || typeof report.controllerInstanceId !== "string") return fail();
  return { ...identity(value), hostingGeneration: botVersion(value.hostingGeneration), report: { botVersion: botVersion(report.botVersion), fence, controllerId: report.controllerId, controllerInstanceId: report.controllerInstanceId, nativeSessionId: nullableText(report.nativeSessionId), result: { state: result.state, code: nullableText(result.code) } } };
};

/** A historical receipt is distinct from its presently usable authorization. */
export const parseBotRecoveryResult = (input: unknown): BotRecoveryResult => {
  const value = object(input, ["receipt", "current"]);
  if (typeof value.current !== "boolean") return fail();
  const r = object(value.receipt, ["botRecoveryVersion", "operationId", "kind", "workerId", "hostingGeneration", "botVersion", ...bindingKeys, "executionGeneration", "controllerId", "controllerInstanceId", "grantExpiresAt", "controllerTokenHash"]);
  if (r.kind !== "register" && r.kind !== "takeover" && r.kind !== "grant") return fail();
  const grantExpiresAt = r.grantExpiresAt === null ? null : timestamp(r.grantExpiresAt);
  const controllerTokenHash = r.controllerTokenHash === null ? null : typeof r.controllerTokenHash === "string" && /^[0-9a-f]{64}$/.test(r.controllerTokenHash) ? r.controllerTokenHash : fail();
  if ((r.kind === "register") !== (grantExpiresAt === null) || (grantExpiresAt === null) !== (controllerTokenHash === null)) return fail();
  return { current: value.current, receipt: { botRecoveryVersion: version(r.botRecoveryVersion), operationId: id(r.operationId), kind: r.kind, workerId: id(r.workerId), hostingGeneration: botVersion(r.hostingGeneration), botVersion: botVersion(r.botVersion), ...binding(r), executionGeneration: botVersion(r.executionGeneration), controllerId: id(r.controllerId), controllerInstanceId: id(r.controllerInstanceId), grantExpiresAt, controllerTokenHash } };
};
