import { SESSION_V2_PROTOCOL, byteLength, choice, errorCode, exact, fail, hash, nullable, seq, uuid } from "./values.js";
import type { SessionV2Message } from "./types.js";

// The only remaining v2 message is the status of an uploaded terminal archive.
export const parseSessionV2Message = (value: unknown): SessionV2Message => {
  const o = exact(value, ["protocol", "schemaVersion", "projectionVersion", "type", "sessionId", "claimId", "executionGeneration", "agentControlMode", "contentKind", "payload"]);
  if (o.protocol !== SESSION_V2_PROTOCOL || o.schemaVersion !== 2 || o.projectionVersion !== 1) return fail("unsupported_protocol");
  if (o.agentControlMode !== "herdr" || o.contentKind !== "terminal_recording") return fail("unsupported_content_kind");
  if (o.type !== "archive_status") return fail();
  const p = exact(o.payload, ["state", "sha256", "byteLength", "completeness", "errorCode", "finalizationId"]);
  const payload = { state: choice(p.state, ["pending", "ready", "failed", "unavailable"]), sha256: nullable(p.sha256, hash), byteLength: nullable(p.byteLength, byteLength), completeness: nullable(p.completeness, v => choice(v, ["complete", "partial"] as const)), errorCode: nullable(p.errorCode, errorCode), finalizationId: nullable(p.finalizationId, uuid) };
  if (payload.state === "ready") { if (payload.sha256 === null || payload.byteLength === null || payload.completeness === null || payload.finalizationId === null || payload.errorCode !== null) return fail(); }
  else if (payload.sha256 !== null || payload.byteLength !== null || payload.completeness !== null || payload.state === "failed" && payload.errorCode === null || payload.state === "unavailable" && (payload.finalizationId === null || !["recording_not_enabled", "ended_before_first_sample"].includes(payload.errorCode ?? ""))) return fail();
  return { protocol: SESSION_V2_PROTOCOL, schemaVersion: 2, projectionVersion: 1, type: "archive_status", sessionId: uuid(o.sessionId), claimId: uuid(o.claimId), executionGeneration: seq(o.executionGeneration), agentControlMode: "herdr", contentKind: "terminal_recording", payload };
};
