import { parseSessionSnapshot } from "../protocol.js";
import { SESSION_V2_PROTOCOL, SESSION_V2_LIMITS, bool, byteLength, canonicalSessionJson, choice, decodeStrictSessionJson, errorCode, exact, fail, hash, hashSessionBytes, integer, list, literal, nativeText, nullable, origin, seq, text, timestamp, unique, utf8 } from "./values.js";
import type { SessionV2Action, SessionV2Envelope, SessionV2Key, SessionV2Lease, SessionV2Message, SessionV2Owner, SessionV2Payloads, SessionV2Receipt, SessionV2Run, SessionV2StopProof, SessionV2UnavailableEvidence, SessionV2UnavailableReason, TerminalBinding, TerminalFrame } from "./types.js";
export type * from "./types.js";

export const assertNativeSessionIdProgression = (previous: string | null, next: string | null): void => {
  nullable(previous, nativeText); nullable(next, nativeText);
  if (previous !== null && previous !== next) fail("target_changed");
};
export const parseTerminalBinding = (value: unknown): TerminalBinding => {
  const o = exact(value, ["instanceId", "sessionId", "workspaceId", "paneId", "terminalId", "nativeSessionId"]);
  return { instanceId: nativeText(o.instanceId), sessionId: nativeText(o.sessionId), workspaceId: nativeText(o.workspaceId), paneId: typeof o.paneId === "number" ? integer(o.paneId, 0, 4294967295) : nativeText(o.paneId), terminalId: nativeText(o.terminalId), nativeSessionId: nullable(o.nativeSessionId, nativeText) };
};
export const assertTerminalBinding = (original: TerminalBinding, current: TerminalBinding): void => {
  const { nativeSessionId: before, ...a } = original, { nativeSessionId: after, ...b } = current;
  if (canonicalSessionJson(a) !== canonicalSessionJson(b)) fail("target_changed");
  assertNativeSessionIdProgression(before, after);
};
export const parseSessionV2Owner = (value: unknown): SessionV2Owner => {
  const o = exact(value, ["projectId", "taskId", "workerId", "worktreeId", "ownerUserId", "serverOrigin", "provider"]);
  return { projectId: uuidValue(o.projectId), taskId: uuidValue(o.taskId), workerId: uuidValue(o.workerId), worktreeId: uuidValue(o.worktreeId), ownerUserId: uuidValue(o.ownerUserId), serverOrigin: origin(o.serverOrigin), provider: choice(o.provider, ["codex", "claude", "copilot"]) };
};
import { uuid as uuidValue } from "./values.js";
const color = (value: unknown): string => typeof value === "string" && /^#[0-9a-f]{6}$/.test(value) ? value : fail();
export const parseTerminalFrame = (value: unknown): TerminalFrame => {
  const o = exact(value, ["frameSeq", "capturedAt", "elapsedMs", "width", "height", "full", "rows"]);
  const rows = list(o.rows, row => {
    const runs = list(row, run => {
      const p = exact(run, ["text", "foreground", "background", "bold", "italic", "underline", "inverse"]);
      const content = text(p.text, SESSION_V2_LIMITS.maxRowBytes, true); if (/\p{Cc}/u.test(content)) return fail();
      return { text: content, foreground: nullable(p.foreground, color), background: nullable(p.background, color), bold: bool(p.bold), italic: bool(p.italic), underline: bool(p.underline), inverse: bool(p.inverse) };
    }, SESSION_V2_LIMITS.maxTextRuns);
    if (runs.reduce((sum, run) => sum + utf8.encode(run.text).length, 0) > SESSION_V2_LIMITS.maxRowBytes) return fail();
    return runs;
  });
  const result: TerminalFrame = { frameSeq: seq(o.frameSeq), capturedAt: timestamp(o.capturedAt), elapsedMs: seq(o.elapsedMs, true), width: integer(o.width, 1, 1000), height: integer(o.height, 1, 1000), full: literal(o.full, true), rows };
  if (rows.length !== result.height || utf8.encode(canonicalSessionJson(result)).length > SESSION_V2_LIMITS.frameMaxBytes) return fail("recording_limit");
  return result;
};
const parseStopProof = (value: unknown): SessionV2StopProof => {
  const o = exact(value, ["recordId", "executionGeneration", "binding", "bootId", "stoppedAt", "method", "terminalStopped", "processes"]);
  const processes = unique(list(o.processes, raw => {
    const p = exact(raw, ["role", "pid", "birthToken", "bootId"]);
    return { role: choice(p.role, ["shell", "agent"]), pid: integer(p.pid, 1, 2147483647), birthToken: nativeText(p.birthToken), bootId: nativeText(p.bootId) };
  }, 1000, 2), p => canonicalSessionJson([p.bootId, p.pid, p.birthToken]));
  const bootId = nativeText(o.bootId);
  if (!processes.some(p => p.role === "shell") || !processes.some(p => p.role === "agent") || processes.some(p => p.bootId !== bootId)) return fail("stop_unknown");
  return { recordId: uuidValue(o.recordId), executionGeneration: seq(o.executionGeneration), binding: parseTerminalBinding(o.binding), bootId, stoppedAt: timestamp(o.stoppedAt), method: choice(o.method, ["instances_exited", "boot_changed"]), terminalStopped: literal(o.terminalStopped, true), processes };
};
const parseRun = (value: unknown): SessionV2Run => {
  const o = exact(value, ["executionGeneration", "owner", "binding", "startedAt", "stoppedAt", "stopProof", "segmentIds"]);
  const run: SessionV2Run = { executionGeneration: seq(o.executionGeneration), owner: parseSessionV2Owner(o.owner), binding: parseTerminalBinding(o.binding), startedAt: timestamp(o.startedAt), stoppedAt: nullable(o.stoppedAt, timestamp), stopProof: nullable(o.stopProof, parseStopProof), segmentIds: unique(list(o.segmentIds, uuidValue), v => v) };
  if ((run.stoppedAt === null) !== (run.stopProof === null)) return fail("stop_unknown");
  if (run.stopProof !== null) {
    if (run.stopProof.executionGeneration !== run.executionGeneration || run.stopProof.stoppedAt !== run.stoppedAt || Date.parse(run.stoppedAt!) < Date.parse(run.startedAt)) return fail("stop_unknown");
    assertTerminalBinding(run.binding, run.stopProof.binding);
  }
  return run;
};
export const parseSessionV2Runs = (value: unknown, finalGeneration: string, allStopped: boolean): SessionV2Run[] => {
  const runs = list(value, parseRun, SESSION_V2_LIMITS.maxRuns, 1), seen = new Set<string>(); let nativeSession: string | null = null;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    if (run.executionGeneration !== String(i + 1) || canonicalSessionJson(run.owner) !== canonicalSessionJson(runs[0]!.owner) || ((i < runs.length - 1 || allStopped) && run.stopProof === null)) return fail("stale_fence");
    assertNativeSessionIdProgression(nativeSession, run.binding.nativeSessionId); nativeSession = run.binding.nativeSessionId;
    if (run.stopProof) { assertNativeSessionIdProgression(nativeSession, run.stopProof.binding.nativeSessionId); nativeSession = run.stopProof.binding.nativeSessionId; }
    for (const id of run.segmentIds) { if (seen.has(id)) return fail("stale_fence"); seen.add(id); }
  }
  if (runs.at(-1)!.executionGeneration !== finalGeneration) return fail("stale_fence");
  return runs;
};
const parseLease = (value: unknown): SessionV2Lease => {
  const o = exact(value, ["leaseId", "holderUserId", "browserClientId", "controlEpoch", "expiresAt"]);
  return { leaseId: uuidValue(o.leaseId), holderUserId: uuidValue(o.holderUserId), browserClientId: uuidValue(o.browserClientId), controlEpoch: seq(o.controlEpoch), expiresAt: timestamp(o.expiresAt) };
};
const actions: readonly SessionV2Action[] = ["acquire_control", "release_control", "resume_automation", "paste", "keys"];
export const SESSION_V2_KEYS: readonly SessionV2Key[] = ["Enter", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "Ctrl+C", "Ctrl+D", "Ctrl+U"];
const completeness = (value: unknown) => choice(value, ["complete", "partial"]);
const unavailableReason = (value: unknown) => choice(value, ["recording_not_enabled", "ended_before_first_sample"]);
export const parseSessionV2UnavailableEvidence = (value: unknown, reason: SessionV2UnavailableReason): SessionV2UnavailableEvidence => {
  const p = exact(value, ["recordingEnabled", "selectedFrameCount", "registeredFrameCount", "captureError"]);
  const evidence = { recordingEnabled: bool(p.recordingEnabled), selectedFrameCount: seq(p.selectedFrameCount, true), registeredFrameCount: seq(p.registeredFrameCount, true), captureError: nullable(p.captureError, errorCode) };
  if (evidence.selectedFrameCount !== "0" || evidence.registeredFrameCount !== "0" || evidence.captureError !== null || evidence.recordingEnabled !== (reason === "ended_before_first_sample")) return fail();
  return evidence;
};
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
      case "registration_ack": { const o = exact(value, ["registrationId", "connectionEpoch"]); return { registrationId: uuidValue(o.registrationId), connectionEpoch: seq(o.connectionEpoch) }; }
      case "snapshot": { const o = exact(value, ["connectionEpoch", "segmentId", "segmentOrdinal", "binding", "frame", "recorded"]); return { connectionEpoch: seq(o.connectionEpoch), segmentId: uuidValue(o.segmentId), segmentOrdinal: seq(o.segmentOrdinal), binding: parseTerminalBinding(o.binding), frame: parseTerminalFrame(o.frame), recorded: bool(o.recorded) }; }
      case "control_state": {
        const o = exact(value, ["connectionEpoch", "controlEpoch", "state", "lease", "initialAssignment", "availableActions", "unavailableReason"]);
        const parsed: SessionV2Payloads["control_state"] = { connectionEpoch: seq(o.connectionEpoch), controlEpoch: seq(o.controlEpoch), state: choice(o.state, ["automation", "manual", "suspended", "closing", "closed"]), lease: nullable(o.lease, parseLease), initialAssignment: choice(o.initialAssignment, ["pending", "dispatching", "transport_completed", "unknown", "unconfirmed"]), availableActions: unique(list(o.availableActions, v => choice(v, actions), 5), v => v), unavailableReason: nullable(o.unavailableReason, errorCode) };
        if ((parsed.state === "manual") !== (parsed.lease !== null) || parsed.lease && parsed.lease.controlEpoch !== parsed.controlEpoch || ["closing", "closed"].includes(parsed.state) && parsed.availableActions.length || parsed.state !== "manual" && parsed.availableActions.some(a => a === "paste" || a === "keys") || parsed.state === "automation" && ["unknown", "unconfirmed"].includes(parsed.initialAssignment) || parsed.state === "manual" && parsed.initialAssignment === "dispatching") return fail();
        return parsed;
      }
      case "control_request": {
        const o = exact(value, ["operationId", "connectionEpoch", "controlEpoch", "action", "browserClientId", "leaseId", "draftHandled", "initialUnknownDisposition"]);
        const p: SessionV2Payloads["control_request"] = { operationId: uuidValue(o.operationId), connectionEpoch: seq(o.connectionEpoch), controlEpoch: seq(o.controlEpoch), action: choice(o.action, ["acquire_control", "release_control", "resume_automation"]), browserClientId: uuidValue(o.browserClientId), leaseId: nullable(o.leaseId, uuidValue), draftHandled: bool(o.draftHandled), initialUnknownDisposition: nullable(o.initialUnknownDisposition, v => literal(v, "delivered_continue")) };
        if (p.action === "resume_automation" ? !p.draftHandled : p.draftHandled || p.initialUnknownDisposition !== null || (p.action === "acquire_control") !== (p.leaseId === null)) return fail();
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
  const kind = choice(o.type, ["registration", "registration_ack", "snapshot", "control_state", "control_request", "operation", "operation_result", "generation_ledger", "finalization", "archive_status", "receipt", "native_snapshot"]);
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
  return result;
};
