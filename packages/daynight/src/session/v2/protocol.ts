import { parseSessionSnapshot } from "../protocol.js";
import { assertNativeSessionIdProgression, assertTerminalBinding, isPreparedSessionV2StopProof, parseSessionV2Owner, parseSessionV2Runs, parseSessionV2UnavailableEvidence, parseTerminalBinding, parseTerminalFrame } from "./recording.js";
export { assertNativeSessionIdProgression, assertTerminalBinding, isPreparedSessionV2StopProof, parseSessionV2Owner, parseSessionV2Runs, parseSessionV2UnavailableEvidence, parseTerminalBinding, parseTerminalFrame } from "./recording.js";
import { SESSION_V2_PROTOCOL, SESSION_V2_LIMITS, bool, byteLength, canonicalSessionJson, choice, decodeStrictSessionJson, errorCode, exact, fail, hash, hashSessionBytes, integer, list, literal, nativeText, nullable, origin, seq, text, timestamp, unique, utf8, uuid as uuidValue } from "./values.js";
import type { SessionV2Action, SessionV2Envelope, SessionV2Key, SessionV2Lease, SessionV2Message, SessionV2Owner, SessionV2Payloads, SessionV2PreparedStopProof, SessionV2Receipt, SessionV2Run, SessionV2StopProof, SessionV2UnavailableEvidence, SessionV2UnavailableReason, TerminalBinding, TerminalFrame } from "./types.js";
export type * from "./types.js";

const parseLease = (value: unknown): SessionV2Lease => {
  const o = exact(value, ["leaseId", "holderUserId", "browserClientId", "controlEpoch", "expiresAt"]);
  return { leaseId: uuidValue(o.leaseId), holderUserId: uuidValue(o.holderUserId), browserClientId: uuidValue(o.browserClientId), controlEpoch: seq(o.controlEpoch), expiresAt: timestamp(o.expiresAt) };
};
const actions: readonly SessionV2Action[] = ["acquire_control", "renew_control", "release_control", "resolve_initial_assignment", "resume_automation", "paste", "keys"];
export const SESSION_V2_KEYS: readonly SessionV2Key[] = ["Enter", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "Ctrl+C", "Ctrl+D", "Ctrl+U"];
const completeness = (value: unknown) => choice(value, ["complete", "partial"]);
const unavailableReason = (value: unknown) => choice(value, ["recording_not_enabled", "ended_before_first_sample"]);
const parseReceipt = (value: unknown): SessionV2Receipt => {
  const o = exact(value, ["finalizationId", "disposition", "dispositionDigest", "reason", "sha256", "byteLength", "completeness", "evidence"]);
  const result: SessionV2Receipt = { finalizationId: uuidValue(o.finalizationId), disposition: choice(o.disposition, ["ready", "unavailable"]), dispositionDigest: hash(o.dispositionDigest), reason: nullable(o.reason, unavailableReason), sha256: nullable(o.sha256, hash), byteLength: nullable(o.byteLength, byteLength), completeness: nullable(o.completeness, completeness), evidence: o.evidence === null ? null : parseSessionV2UnavailableEvidence(o.evidence, unavailableReason(o.reason)) };
  if (result.disposition === "ready") {
    if (result.reason !== null || result.sha256 === null || result.byteLength === null || result.completeness === null || result.evidence !== null) return fail();
  } else {
    const e = result.evidence;
    if (result.reason === null || result.sha256 !== null || result.byteLength !== null || result.completeness !== null || e === null || e.selectedFrameCount !== "0" || e.registeredFrameCount !== "0" || e.captureError !== null || e.recordingEnabled !== (result.reason === "ended_before_first_sample")) return fail("source_corrupt");
  }
  return result;
};
const parsePayload = <K extends keyof SessionV2Payloads>(kind: K, value: unknown, base: SessionV2Envelope): SessionV2Payloads[K] => {
  // Each discriminant constructs only its exact typed payload; this local cast
  // preserves the mapping without exposing an unvalidated generic wire object.
  const result = (): SessionV2Payloads[keyof SessionV2Payloads] => {
    switch (kind) {
      case "registration": {
        const o = exact(value, ["registrationId", "mode", "owner", "binding", "connectionEpoch", "capabilities"]), c = exact(o.capabilities, ["observe", "control", "archive"]);
        const capabilities = { observe: bool(c.observe), control: bool(c.control), archive: bool(c.archive) }, mode = choice(o.mode, ["register", "reconnect"]), connectionEpoch = nullable(o.connectionEpoch, seq);
        if ((mode === "register") !== (connectionEpoch === null) || (capabilities.control && !capabilities.observe)) return fail();
        return { registrationId: uuidValue(o.registrationId), mode, owner: parseSessionV2Owner(o.owner), binding: parseTerminalBinding(o.binding), connectionEpoch, capabilities };
      }
      case "automation_recovery_prepare": {
        const o = exact(value, ["recoveryId", "connectionEpoch", "controlEpoch", "closingControlEpoch", "stopOperationId", "binding", "initialAssignment"]);
        const binding = parseTerminalBinding(o.binding), controlEpoch = seq(o.controlEpoch), closingControlEpoch = seq(o.closingControlEpoch);
        if (binding.nativeSessionId === null || BigInt(closingControlEpoch) <= BigInt(controlEpoch)) return fail();
        return { recoveryId: uuidValue(o.recoveryId), connectionEpoch: seq(o.connectionEpoch), controlEpoch, closingControlEpoch, stopOperationId: uuidValue(o.stopOperationId), binding, initialAssignment: literal(o.initialAssignment, "transport_completed") };
      }
      case "automation_recovery": {
        const o = exact(value, ["recoveryId", "connectionEpoch", "controlEpoch", "previousGeneration", "stopOperationId", "binding"]);
        const previousGeneration = seq(o.previousGeneration), binding = parseTerminalBinding(o.binding);
        if (binding.nativeSessionId === null || BigInt(previousGeneration) + 1n !== BigInt(base.executionGeneration)) return fail();
        return { recoveryId: uuidValue(o.recoveryId), connectionEpoch: seq(o.connectionEpoch), controlEpoch: seq(o.controlEpoch), previousGeneration, stopOperationId: uuidValue(o.stopOperationId), binding };
      }
      case "automation_recovery_state": {
        const o = exact(value, ["recoveryId", "prepareDigest", "sourceGeneration", "sourceConnectionEpoch", "sourceControlEpoch", "closingControlEpoch", "stopOperationId", "nativeSessionId", "consumed"]);
        const sourceConnectionEpoch = seq(o.sourceConnectionEpoch), sourceGeneration = seq(o.sourceGeneration), sourceControlEpoch = seq(o.sourceControlEpoch), closingControlEpoch = seq(o.closingControlEpoch);
        const consumed = nullable(o.consumed, raw => { const c = exact(raw, ["executionGeneration", "connectionEpoch", "controlEpoch", "requestDigest"]); return { executionGeneration: seq(c.executionGeneration), connectionEpoch: seq(c.connectionEpoch), controlEpoch: seq(c.controlEpoch), requestDigest: hash(c.requestDigest) }; });
        if (BigInt(closingControlEpoch) <= BigInt(sourceControlEpoch) || (consumed ? BigInt(consumed.executionGeneration) !== BigInt(sourceGeneration) + 1n || consumed.executionGeneration !== base.executionGeneration || BigInt(consumed.connectionEpoch) <= BigInt(sourceConnectionEpoch) || BigInt(consumed.controlEpoch) <= BigInt(closingControlEpoch) : sourceGeneration !== base.executionGeneration)) return fail();
        return { recoveryId: uuidValue(o.recoveryId), prepareDigest: hash(o.prepareDigest), sourceGeneration, sourceConnectionEpoch, sourceControlEpoch, closingControlEpoch, stopOperationId: uuidValue(o.stopOperationId), nativeSessionId: nativeText(o.nativeSessionId), consumed };
      }
      case "registration_ack": { const o = exact(value, ["registrationId", "connectionEpoch"]); return { registrationId: uuidValue(o.registrationId), connectionEpoch: seq(o.connectionEpoch) }; }
      case "snapshot": { const o = exact(value, ["connectionEpoch", "segmentId", "segmentOrdinal", "binding", "frame", "recorded"]); return { connectionEpoch: seq(o.connectionEpoch), segmentId: uuidValue(o.segmentId), segmentOrdinal: seq(o.segmentOrdinal), binding: parseTerminalBinding(o.binding), frame: parseTerminalFrame(o.frame), recorded: bool(o.recorded) }; }
      case "control_state": {
        const o = exact(value, ["connectionEpoch", "controlEpoch", "state", "lease", "initialAssignment", "availableActions", "unavailableReason"]);
        const parsed: SessionV2Payloads["control_state"] = { connectionEpoch: seq(o.connectionEpoch), controlEpoch: seq(o.controlEpoch), state: choice(o.state, ["automation", "manual", "suspended", "closing", "closed"]), lease: nullable(o.lease, parseLease), initialAssignment: choice(o.initialAssignment, ["pending", "dispatching", "transport_completed", "unknown", "unconfirmed"]), availableActions: unique(list(o.availableActions, v => choice(v, actions), actions.length), v => v), unavailableReason: nullable(o.unavailableReason, errorCode) };
        if ((parsed.state === "manual") !== (parsed.lease !== null) || parsed.lease && parsed.lease.controlEpoch !== parsed.controlEpoch || ["closing", "closed"].includes(parsed.state) && parsed.availableActions.length || parsed.state !== "manual" && parsed.availableActions.some(a => a === "paste" || a === "keys") || parsed.state === "automation" && ["unknown", "unconfirmed"].includes(parsed.initialAssignment) || parsed.state === "manual" && parsed.initialAssignment === "dispatching") return fail();
        return parsed;
      }
      case "control_request": {
        const o = exact(value, ["operationId", "connectionEpoch", "controlEpoch", "action", "browserClientId", "leaseId", "draftHandled", "initialUnknownDisposition"]);
        const p: SessionV2Payloads["control_request"] = { operationId: uuidValue(o.operationId), connectionEpoch: seq(o.connectionEpoch), controlEpoch: seq(o.controlEpoch), action: choice(o.action, ["acquire_control", "renew_control", "release_control", "resolve_initial_assignment", "resume_automation"]), browserClientId: uuidValue(o.browserClientId), leaseId: nullable(o.leaseId, uuidValue), draftHandled: bool(o.draftHandled), initialUnknownDisposition: nullable(o.initialUnknownDisposition, v => literal(v, "delivered_continue")) };
        if (p.action === "resolve_initial_assignment") {
          if (p.leaseId !== null || p.draftHandled || p.initialUnknownDisposition !== "delivered_continue") return fail();
        } else if (p.action === "resume_automation") {
          if (p.leaseId !== null || !p.draftHandled || p.initialUnknownDisposition !== null) return fail();
        } else if (p.draftHandled || p.initialUnknownDisposition !== null || (p.action === "acquire_control") !== (p.leaseId === null)) return fail();
        return p;
      }
      case "control_dispatch": {
        const o = exact(value, ["actorUserId", "requestDigest", "request"]);
        return { actorUserId: uuidValue(o.actorUserId), requestDigest: hash(o.requestDigest), request: parsePayload("control_request", o.request, base) };
      }
      case "control_ack": {
        const o = exact(value, ["requestDigest", "durable", "controlState", "result"]), result = parsePayload("operation_result", o.result, base);
        if (result.state === "queued" || result.state === "dispatching") return fail();
        return { requestDigest: hash(o.requestDigest), durable: literal(o.durable, true), controlState: parsePayload("control_state", o.controlState, base), result };
      }
      case "recording_responsibility": {
        const o = exact(value, ["responsibilityId", "recordingEnabled"]);
        return { responsibilityId: uuidValue(o.responsibilityId), recordingEnabled: bool(o.recordingEnabled) };
      }
      case "recording_evidence": {
        const o = exact(value, ["responsibilityId", "evidenceId", "revision", "selectedFrameCount", "registeredFrameCount", "captureError", "closed", "journalSha256", "sourceSha256"]);
        const p = { responsibilityId: uuidValue(o.responsibilityId), evidenceId: uuidValue(o.evidenceId), revision: seq(o.revision), selectedFrameCount: seq(o.selectedFrameCount, true), registeredFrameCount: seq(o.registeredFrameCount, true), captureError: nullable(o.captureError, errorCode), closed: bool(o.closed), journalSha256: hash(o.journalSha256), sourceSha256: hash(o.sourceSha256) };
        if (BigInt(p.registeredFrameCount) > BigInt(p.selectedFrameCount)) return fail();
        return p;
      }
      case "operation": {
        const o = exact(value, ["operationId", "connectionEpoch", "segmentId", "binding", "controlEpoch", "leaseId", "leaseSeq", "kind", "payload"]);
        const common = { operationId: uuidValue(o.operationId), connectionEpoch: seq(o.connectionEpoch), segmentId: uuidValue(o.segmentId), binding: parseTerminalBinding(o.binding), controlEpoch: seq(o.controlEpoch), leaseId: uuidValue(o.leaseId), leaseSeq: seq(o.leaseSeq) };
        if (o.kind === "paste") { const p = exact(o.payload, ["text"]), content = text(p.text, SESSION_V2_LIMITS.inputMaxBytes); if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(content)) return fail(); return { ...common, kind: "paste", payload: { text: content } }; }
        if (o.kind === "keys") { const p = exact(o.payload, ["key"]); return { ...common, kind: "keys", payload: { key: choice(p.key, SESSION_V2_KEYS) } }; }
        return fail();
      }
      case "operation_result": {
        const o = exact(value, ["operationId", "state", "errorCode"]), state = choice(o.state, ["queued", "dispatching", "transport_completed", "rejected", "unknown"]), error = nullable(o.errorCode, errorCode);
        if (state === "unknown" ? error !== "input_unknown" : state === "rejected" ? error === null : error !== null) return fail();
        return { operationId: uuidValue(o.operationId), state, errorCode: error };
      }
      case "generation_ledger": { const o = exact(value, ["runs", "finalizationId"]), finalizationId = nullable(o.finalizationId, uuidValue); return { runs: parseSessionV2Runs(o.runs, base.executionGeneration, finalizationId !== null), finalizationId }; }
      case "finalization": { const o = exact(value, ["finalizationId", "claimTerminal", "runs"]); return { finalizationId: uuidValue(o.finalizationId), claimTerminal: literal(o.claimTerminal, true), runs: parseSessionV2Runs(o.runs, base.executionGeneration, true) }; }
      case "archive_status": {
        const o = exact(value, ["state", "sha256", "byteLength", "completeness", "errorCode", "finalizationId"]);
        const p: SessionV2Payloads["archive_status"] = { state: choice(o.state, ["pending", "ready", "failed", "unavailable"]), sha256: nullable(o.sha256, hash), byteLength: nullable(o.byteLength, byteLength), completeness: nullable(o.completeness, completeness), errorCode: nullable(o.errorCode, errorCode), finalizationId: nullable(o.finalizationId, uuidValue) };
        if (p.state === "ready") { if (p.sha256 === null || p.byteLength === null || p.completeness === null || p.finalizationId === null || p.errorCode !== null) return fail(); }
        else if (p.sha256 !== null || p.byteLength !== null || p.completeness !== null || p.state === "failed" && p.errorCode === null || p.state === "unavailable" && (p.finalizationId === null || !["recording_not_enabled", "ended_before_first_sample"].includes(p.errorCode ?? ""))) return fail();
        return p;
      }
      case "receipt": return parseReceipt(value);
      case "native_snapshot": { const snapshot = parseSessionSnapshot(value); if (snapshot.sessionId !== base.sessionId || snapshot.claimId !== base.claimId || snapshot.executionGeneration !== base.executionGeneration) return fail("stale_fence"); return snapshot; }
    }
    return fail();
  };
  return result() as SessionV2Payloads[K];
};
export const parseSessionV2Message = (value: unknown): SessionV2Message => {
  const o = exact(value, ["protocol", "schemaVersion", "projectionVersion", "type", "sessionId", "claimId", "executionGeneration", "agentControlMode", "contentKind", "payload"]);
  if (o.protocol !== SESSION_V2_PROTOCOL || o.schemaVersion !== 2 || o.projectionVersion !== 1) return fail("unsupported_protocol");
  const base: SessionV2Envelope = { protocol: SESSION_V2_PROTOCOL, schemaVersion: 2, projectionVersion: 1, sessionId: uuidValue(o.sessionId), claimId: uuidValue(o.claimId), executionGeneration: seq(o.executionGeneration) };
  const kind = choice(o.type, ["registration", "registration_ack", "automation_recovery_prepare", "automation_recovery", "automation_recovery_state", "snapshot", "control_state", "control_request", "control_dispatch", "control_ack", "recording_responsibility", "recording_evidence", "operation", "operation_result", "generation_ledger", "finalization", "archive_status", "receipt", "native_snapshot"]);
  if (kind === "native_snapshot") {
    if (o.agentControlMode !== "web" || o.contentKind !== "native_timeline") return fail("unsupported_content_kind");
    return { ...base, agentControlMode: "web", contentKind: "native_timeline", type: kind, payload: parsePayload(kind, o.payload, base) };
  }
  if (o.agentControlMode !== "herdr" || o.contentKind !== "terminal_recording") return fail("unsupported_content_kind");
  return { ...base, agentControlMode: "herdr", contentKind: "terminal_recording", type: kind, payload: parsePayload(kind, o.payload, base) } as SessionV2Message;
};
export const sessionV2ReceiptDigest = async (message: Extract<SessionV2Message, { type: "receipt" }>): Promise<string> => {
  const { dispositionDigest: _, ...payload } = message.payload;
  return hashSessionBytes(canonicalSessionJson({ ...message, payload }));
};
export const verifySessionV2Receipt = async (message: Extract<SessionV2Message, { type: "receipt" }>): Promise<void> => {
  if (await sessionV2ReceiptDigest(message) !== message.payload.dispositionDigest) return fail("source_corrupt");
};
export const decodeSessionV2Message = async (input: string | Uint8Array): Promise<SessionV2Message> => {
  const result = parseSessionV2Message(decodeStrictSessionJson(input, SESSION_V2_LIMITS.metadataMaxBytes));
  if (result.type === "receipt") await verifySessionV2Receipt(result);
  if (result.type === "control_dispatch" && result.payload.requestDigest !== await controlRequestDigest(result.payload.actorUserId, result.payload.request)) return fail("source_corrupt");
  return result;
};

// The enclosing message carries the fence; the digest binds the authenticated
// actor to the exact control intent within that execution.
export const controlRequestDigest = async (actorUserId: string, request: SessionV2Payloads["control_request"]): Promise<string> => hashSessionBytes(canonicalSessionJson({ actorUserId, request }));
