import { sessionControlKeys, parseSessionControlFields } from "./protocol.js";
import { assertSessionFence, sessionBinding, sessionBindingKeys, sessionFence, SESSION_PROTOCOL, parseSessionSnapshot, parseSessionCommand, parseSessionEvent, parseSessionOperation, parseSessionResource, parseTimelineEntry,
  type SessionBinding, type SessionFence, type ControllerFence, type DecimalSequence, type SessionCapabilities, type SessionCommand, type SessionEvent, type SessionOperation, type SessionProvider, type SessionResource, type SessionSnapshot, type TimelineEntry } from "./protocol.js";

export const RELAY_LIMITS = { maxFrameBytes: 2_097_152, maxBatchEvents: 100, maxResourceBytes: 8_388_608, pollIntervalMs: 250 } as const;
type Wire = { readonly protocol: typeof SESSION_PROTOCOL };
export type RegistrationRequest = Wire & { readonly registrationId: string; readonly claimId: string; readonly workerId: string; readonly worktreeId: string; readonly provider: SessionProvider; readonly controllerId: string; readonly controllerInstanceId: string };
export type RegistrationResponse = { readonly session: SessionSnapshot };
export type ControllerGrantRequest = Wire & SessionBinding & { readonly controllerId: string; readonly controllerInstanceId: string; readonly executionGeneration: DecimalSequence; readonly kind: "bootstrap" | "reconnect"; readonly previousGeneration: DecimalSequence | null; readonly stopProof: { readonly recordId: string; readonly previousControllerInstanceId: string; readonly stoppedAt: string } | null };
export type ControllerGrantResponse = SessionFence & { readonly token: string; readonly expiresAt: string; readonly controllerId: string; readonly controllerInstanceId: string };
export type CurrentSessionResponse = { readonly status: "not_applicable"; readonly claimId: string | null; readonly agentControlMode: "herdr" | null } | { readonly status: "not_registered"; readonly claimId: string; readonly agentControlMode: "web" } | { readonly status: "registered"; readonly session: SessionSnapshot };
export type TimelinePage = { readonly sessionId: string; readonly historyEpoch: string; readonly items: readonly TimelineEntry[]; readonly resources: readonly SessionResource[]; readonly beforeCursor: string | null; readonly afterCursor: string | null; readonly hasMoreBefore: boolean; readonly hasMoreAfter: boolean; readonly lastEventSeq: DecimalSequence };
export type OperationResponse = { readonly operation: SessionOperation };
export type CommandResponse = OperationResponse & { readonly operationUrl: string };
export type ControllerState = Pick<SessionSnapshot, "controls" | "turnStartedAt"> & { readonly cleanupInteractionIds?: readonly string[]; readonly nativeSessionId: string | null; readonly initialInputState: SessionSnapshot["initialInputState"]; readonly synchronized: boolean; readonly activity: SessionSnapshot["activity"]; readonly currentTurnId: string | null; readonly capabilities: SessionCapabilities };
type WithoutEntrySeq<T> = T extends unknown ? Omit<T, "entrySeq"> : never;
export type SourceTimelineEntry = WithoutEntrySeq<TimelineEntry>;
export type SourceEvent = { readonly sourceSeq: DecimalSequence } & (
  | { readonly kind: "state"; readonly payload: ControllerState }
  | { readonly kind: "timeline_upsert"; readonly payload: SourceTimelineEntry }
  | { readonly kind: "resource"; readonly payload: SessionResource }
  | { readonly kind: "gap"; readonly payload: { readonly reason: string } });
export type Reconciliation = { readonly operationId: string; readonly state: "not_submitted" | "dispatching" | "provider_accepted" | "confirmed" | "failed" | "rejected" | "expired" | "unknown"; readonly providerResult: SessionOperation["providerResult"]; readonly error: SessionOperation["error"] };
export type ControllerHello = Wire & SessionFence & { readonly type: "hello"; readonly schemaVersion: 1; readonly projectionVersion: 1; readonly controllerId: string; readonly controllerInstanceId: string; readonly provider: SessionProvider; readonly sourceEpoch: string; readonly lastAckedSourceSeq: DecimalSequence };
export type ControllerMessage = ControllerHello | (Wire & ControllerFence & (
  | { readonly type: "events"; readonly batchId: string; readonly sourceEpoch: string; readonly events: readonly SourceEvent[] }
  | { readonly type: "source_reset"; readonly previousSourceEpoch: string; readonly newSourceEpoch: string; readonly reason: string }
  | { readonly type: "operation_begin"; readonly operationId: string }
  | { readonly type: "operation_receipt"; readonly operation: SessionOperation }
  | { readonly type: "reconcile"; readonly final: boolean; readonly operations: readonly Reconciliation[] }
  | { readonly type: "heartbeat" }));
export type RelayMessage = (Wire & { readonly type: "welcome"; readonly connectionEpoch: DecimalSequence; readonly session: SessionSnapshot; readonly lastAckedSourceSeq: DecimalSequence; readonly limits: typeof RELAY_LIMITS }) | (Wire & ControllerFence & (
  | { readonly type: "events_ack"; readonly batchId: string; readonly sourceEpoch: string; readonly lastAckedSourceSeq: DecimalSequence; readonly lastEventSeq: DecimalSequence }
  | { readonly type: "source_reset_ack"; readonly sourceEpoch: string; readonly lastEventSeq: DecimalSequence }
  | { readonly type: "operation_offer"; readonly operationSeq: DecimalSequence; readonly command: SessionCommand }
  | { readonly type: "operation_authorized"; readonly operationId: string }
  | { readonly type: "receipt_ack"; readonly operation: SessionOperation }
  | { readonly type: "reconcile_result"; readonly operations: readonly SessionOperation[] }
  | { readonly type: "heartbeat_ack" }
  | { readonly type: "error"; readonly code: string; readonly message: string }));
export type BrowserMessage = Wire & (
  | { readonly type: "snapshot"; readonly userId: string; readonly snapshot: SessionSnapshot; readonly cursor: string }
  | { readonly type: "event"; readonly event: SessionEvent; readonly cursor: string }
  | { readonly type: "reset_required"; readonly reason: string });

const fail = (): never => { throw new Error("Invalid Daynight relay protocol value."); };
const obj = (x: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return fail();
  const o = x as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o, k))) return fail();
  return o;
};
const str = (x: unknown, max = 256): string => typeof x === "string" && x.length > 0 && /[^\p{White_Space}]/u.test(x) && x.isWellFormed() && !x.includes("\0") && new TextEncoder().encode(x).length <= max ? x : fail();
const id = (x: unknown): string => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(str(x)) ? x as string : fail();
const seq = (x: unknown, zero = false): string => { const s = str(x); return /^(0|[1-9][0-9]*)$/.test(s) && s.length <= 19 && BigInt(s) <= 9223372036854775807n && (zero || s !== "0") ? s : fail(); };
const bool = (x: unknown): boolean => typeof x === "boolean" ? x : fail();
const nullable = <T>(x: unknown, f: (x: unknown) => T): T | null => x === null ? null : f(x);
const choice = <T extends string>(x: unknown, choices: readonly T[]): T => typeof x === "string" && choices.includes(x as T) ? x as T : fail();
const protocol = (x: unknown): typeof SESSION_PROTOCOL => x === SESSION_PROTOCOL ? x : fail();
const list = <T>(x: unknown, f: (x: unknown) => T, max = 100): T[] => Array.isArray(x) && x.length <= max ? x.map(f) : fail();
const fenceKeys = (value: unknown) => ["sessionId", ...sessionBindingKeys(value), "executionGeneration", "connectionEpoch"];
const fence = (o: Record<string, unknown>): ControllerFence => ({ sessionId: id(o.sessionId), ...sessionBinding(o), executionGeneration: seq(o.executionGeneration), connectionEpoch: seq(o.connectionEpoch) });
const timestamp = (x: unknown): string => { const s = str(x); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s)) ? s : fail(); };
export const parseRegistrationRequest = (x: unknown): RegistrationRequest => {
  const o = obj(x, ["protocol", "registrationId", "claimId", "workerId", "worktreeId", "provider", "controllerId", "controllerInstanceId"]);
  return { protocol: protocol(o.protocol), registrationId: id(o.registrationId), claimId: id(o.claimId), workerId: id(o.workerId), worktreeId: id(o.worktreeId), provider: choice(o.provider, ["codex", "claude", "copilot"]), controllerId: id(o.controllerId), controllerInstanceId: id(o.controllerInstanceId) };
};
export const parseRegistrationResponse = (x: unknown): RegistrationResponse => ({ session: parseSessionSnapshot(obj(x, ["session"]).session) });
export const parseControllerGrantRequest = (x: unknown): ControllerGrantRequest => {
  const o = obj(x, ["protocol", ...sessionBindingKeys(x), "controllerId", "controllerInstanceId", "executionGeneration", "kind", "previousGeneration", "stopProof"]);
  const proof = nullable(o.stopProof, x => { const p = obj(x, ["recordId", "previousControllerInstanceId", "stoppedAt"]); return { recordId: id(p.recordId), previousControllerInstanceId: id(p.previousControllerInstanceId), stoppedAt: timestamp(p.stoppedAt) }; });
  const previousGeneration = nullable(o.previousGeneration, seq);
  if ((proof === null) !== (previousGeneration === null) || Object.hasOwn(o, "testExecutionId") && previousGeneration !== null) return fail();
  return { protocol: protocol(o.protocol), ...sessionBinding(o), controllerId: id(o.controllerId), controllerInstanceId: id(o.controllerInstanceId), executionGeneration: seq(o.executionGeneration), kind: choice(o.kind, ["bootstrap", "reconnect"]), previousGeneration, stopProof: proof };
};
export const parseControllerGrantResponse = (x: unknown): ControllerGrantResponse => {
  const o = obj(x, ["token", "expiresAt", "sessionId", ...sessionBindingKeys(x), "executionGeneration", "controllerId", "controllerInstanceId"]);
  return { token: str(o.token), expiresAt: timestamp(o.expiresAt), sessionId: id(o.sessionId), ...sessionBinding(o), executionGeneration: seq(o.executionGeneration), controllerId: id(o.controllerId), controllerInstanceId: id(o.controllerInstanceId) };
};
export const parseCurrentSessionResponse = (x: unknown): CurrentSessionResponse => {
  if (!x || typeof x !== "object" || !("status" in x)) return fail();
  if (x.status === "registered") { const session = parseSessionSnapshot(obj(x, ["status", "session"]).session); if (session.claimId === undefined) return fail(); return { status: "registered", session }; }
  const o = obj(x, ["status", "claimId", "agentControlMode"]);
  if (o.status === "not_registered" && o.agentControlMode === "web") return { status: "not_registered", claimId: id(o.claimId), agentControlMode: "web" };
  if (o.status !== "not_applicable" || !(o.agentControlMode === null || o.agentControlMode === "herdr")) return fail();
  return { status: "not_applicable", claimId: nullable(o.claimId, id), agentControlMode: o.agentControlMode };
};
export const parseTimelinePage = (x: unknown): TimelinePage => {
  const o = obj(x, ["sessionId", "historyEpoch", "items", "resources", "beforeCursor", "afterCursor", "hasMoreBefore", "hasMoreAfter", "lastEventSeq"]);
  return { sessionId: id(o.sessionId), historyEpoch: str(o.historyEpoch), items: list(o.items, parseTimelineEntry, 200), resources: list(o.resources, parseSessionResource, 1000), beforeCursor: nullable(o.beforeCursor, str), afterCursor: nullable(o.afterCursor, str), hasMoreBefore: bool(o.hasMoreBefore), hasMoreAfter: bool(o.hasMoreAfter), lastEventSeq: seq(o.lastEventSeq, true) };
};
export const parseOperationResponse = (x: unknown): OperationResponse => ({ operation: parseSessionOperation(obj(x, ["operation"]).operation) });
export const parseCommandResponse = (x: unknown): CommandResponse => { const o = obj(x, ["operation", "operationUrl"]); return { operation: parseSessionOperation(o.operation), operationUrl: str(o.operationUrl, 2048) }; };
export const parseControllerState = (x: unknown): ControllerState => {
  const o = obj(x, [...sessionControlKeys(x), "nativeSessionId", "initialInputState", "synchronized", "activity", "currentTurnId", "capabilities", ...(x && typeof x === "object" && Object.hasOwn(x, "cleanupInteractionIds") ? ["cleanupInteractionIds"] : [])]);
  const c = obj(o.capabilities, ["send", "steer", "cancel", "respond"]);
  const cleanup = Object.hasOwn(o, "cleanupInteractionIds") ? list(o.cleanupInteractionIds, id, 1000) : undefined;
  if (cleanup && new Set(cleanup).size !== cleanup.length) return fail();
  return { ...parseSessionControlFields(o), ...(cleanup ? { cleanupInteractionIds: cleanup } : {}), nativeSessionId: nullable(o.nativeSessionId, str), initialInputState: choice(o.initialInputState, ["not_required", "not_submitted", "dispatching", "provider_accepted", "confirmed", "failed", "unknown"]), synchronized: bool(o.synchronized), activity: choice(o.activity, ["initializing", "idle", "working", "waiting_input", "stopped", "unknown"]), currentTurnId: nullable(o.currentTurnId, str), capabilities: { send: bool(c.send), steer: bool(c.steer), cancel: bool(c.cancel), respond: bool(c.respond) } };
};
export const parseSourceEvent = (x: unknown): SourceEvent => {
  const o = obj(x, ["sourceSeq", "kind", "payload"]), sourceSeq = seq(o.sourceSeq);
  if (o.kind === "state") return { sourceSeq, kind: "state", payload: parseControllerState(o.payload) };
  if (o.kind === "resource") return { sourceSeq, kind: "resource", payload: parseSessionResource(o.payload) };
  if (o.kind === "gap") return { sourceSeq, kind: "gap", payload: { reason: str(obj(o.payload, ["reason"]).reason, 1_048_576) } };
  if (o.kind !== "timeline_upsert" || !o.payload || typeof o.payload !== "object" || "entrySeq" in o.payload) return fail();
  const { entrySeq: ignored, ...payload } = parseTimelineEntry({ ...o.payload, entrySeq: "1" });
  void ignored;
  return { sourceSeq, kind: "timeline_upsert", payload };
};
export const parseControllerMessage = (x: unknown): ControllerMessage => {
  if (!x || typeof x !== "object" || !("type" in x)) return fail();
  if (x.type === "hello") {
    const o = obj(x, ["type", "protocol", "schemaVersion", "projectionVersion", "sessionId", ...sessionBindingKeys(x), "executionGeneration", "controllerId", "controllerInstanceId", "provider", "sourceEpoch", "lastAckedSourceSeq"]);
    if (o.schemaVersion !== 1 || o.projectionVersion !== 1) return fail();
    return { type: "hello", protocol: protocol(o.protocol), schemaVersion: 1, projectionVersion: 1, sessionId: id(o.sessionId), ...sessionBinding(o), executionGeneration: seq(o.executionGeneration), controllerId: id(o.controllerId), controllerInstanceId: id(o.controllerInstanceId), provider: choice(o.provider, ["codex", "claude", "copilot"]), sourceEpoch: id(o.sourceEpoch), lastAckedSourceSeq: seq(o.lastAckedSourceSeq, true) };
  }
  const extras: Record<string, readonly string[]> = { events: ["batchId", "sourceEpoch", "events"], source_reset: ["previousSourceEpoch", "newSourceEpoch", "reason"], operation_begin: ["operationId"], operation_receipt: ["operation"], reconcile: ["operations", "final"], heartbeat: [] };
  if (typeof x.type !== "string" || !Object.hasOwn(extras, x.type)) return fail();
  const o = obj(x, ["type", "protocol", ...fenceKeys(x), ...extras[x.type]!]), base = { protocol: protocol(o.protocol), ...fence(o) };
  switch (x.type) {
    case "events": { const events = list(o.events, parseSourceEvent); if (!events.length || base.claimId !== undefined && events.some(event => event.kind === "state" && event.payload.initialInputState === "not_required")) return fail(); return { ...base, type: "events", batchId: id(o.batchId), sourceEpoch: id(o.sourceEpoch), events }; }
    case "source_reset": return { ...base, type: "source_reset", previousSourceEpoch: id(o.previousSourceEpoch), newSourceEpoch: id(o.newSourceEpoch), reason: str(o.reason, 1_048_576) };
    case "operation_begin": return { ...base, type: "operation_begin", operationId: id(o.operationId) };
    case "operation_receipt": { const operation = parseSessionOperation(o.operation); assertSessionFence(operation, sessionFence(base)); return { ...base, type: "operation_receipt", operation }; }
    case "heartbeat": return { ...base, type: "heartbeat" };
    case "reconcile": return { ...base, type: "reconcile", final: bool(o.final), operations: list(o.operations, x => { const p = obj(x, ["operationId", "state", "providerResult", "error"]); const state = choice(p.state, ["not_submitted", "dispatching", "provider_accepted", "confirmed", "failed", "rejected", "expired", "unknown"]); const parsed = parseSessionOperation({ protocol: SESSION_PROTOCOL, ...sessionFence(base), operationId: p.operationId, kind: "send_message", state: state === "not_submitted" ? "accepted" : state, providerResult: p.providerResult, error: p.error }); return { operationId: parsed.operationId, state, providerResult: parsed.providerResult, error: parsed.error }; }) };
  }
  return fail();
};
export const parseRelayMessage = (x: unknown): RelayMessage => {
  if (!x || typeof x !== "object" || !("type" in x)) return fail();
  if (x.type === "welcome") {
    const o = obj(x, ["type", "protocol", "connectionEpoch", "session", "lastAckedSourceSeq", "limits"]);
    const limits = obj(o.limits, Object.keys(RELAY_LIMITS));
    for (const [k, v] of Object.entries(RELAY_LIMITS)) if (limits[k] !== v) return fail();
    return { type: "welcome", protocol: protocol(o.protocol), connectionEpoch: seq(o.connectionEpoch), session: parseSessionSnapshot(o.session), lastAckedSourceSeq: seq(o.lastAckedSourceSeq, true), limits: RELAY_LIMITS };
  }
  const extras: Record<string, readonly string[]> = { events_ack: ["batchId", "sourceEpoch", "lastAckedSourceSeq", "lastEventSeq"], source_reset_ack: ["sourceEpoch", "lastEventSeq"], operation_offer: ["operationSeq", "command"], operation_authorized: ["operationId"], receipt_ack: ["operation"], reconcile_result: ["operations"], heartbeat_ack: [], error: ["code", "message"] };
  if (typeof x.type !== "string" || !Object.hasOwn(extras, x.type)) return fail();
  const o = obj(x, ["type", "protocol", ...fenceKeys(x), ...extras[x.type]!]), base = { protocol: protocol(o.protocol), ...fence(o) };
  switch (x.type) {
    case "events_ack": return { ...base, type: "events_ack", batchId: id(o.batchId), sourceEpoch: id(o.sourceEpoch), lastAckedSourceSeq: seq(o.lastAckedSourceSeq, true), lastEventSeq: seq(o.lastEventSeq, true) };
    case "source_reset_ack": return { ...base, type: "source_reset_ack", sourceEpoch: id(o.sourceEpoch), lastEventSeq: seq(o.lastEventSeq, true) };
    case "operation_offer": { const command = parseSessionCommand(o.command); assertSessionFence(command, sessionFence(base)); return { ...base, type: "operation_offer", operationSeq: seq(o.operationSeq), command }; }
    case "operation_authorized": return { ...base, type: "operation_authorized", operationId: id(o.operationId) };
    case "receipt_ack": { const operation = parseSessionOperation(o.operation); assertSessionFence(operation, sessionFence(base)); return { ...base, type: "receipt_ack", operation }; }
    case "reconcile_result": { const operations = list(o.operations, parseSessionOperation, 200); for (const operation of operations) assertSessionFence(operation, sessionFence(base)); return { ...base, type: "reconcile_result", operations }; }
    case "heartbeat_ack": return { ...base, type: "heartbeat_ack" };
    case "error": return { ...base, type: "error", code: str(o.code), message: str(o.message, 1_048_576) };
  }
  return fail();
};
export const parseBrowserMessage = (x: unknown): BrowserMessage => {
  if (!x || typeof x !== "object" || !("type" in x)) return fail();
  if (x.type === "snapshot") { const o = obj(x, ["type", "protocol", "userId", "snapshot", "cursor"]); return { type: "snapshot", protocol: protocol(o.protocol), userId: id(o.userId), snapshot: parseSessionSnapshot(o.snapshot), cursor: str(o.cursor) }; }
  if (x.type === "event") { const o = obj(x, ["type", "protocol", "event", "cursor"]); return { type: "event", protocol: protocol(o.protocol), event: parseSessionEvent(o.event), cursor: str(o.cursor) }; }
  const o = obj(x, ["type", "protocol", "reason"]);
  if (o.type !== "reset_required") return fail();
  return { type: "reset_required", protocol: protocol(o.protocol), reason: str(o.reason, 1_048_576) };
};
