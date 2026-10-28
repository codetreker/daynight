import { parseSessionControls, type SessionControls } from "./controls.js";
// This wire contract is shared with the browser and must not import Node modules.
export const SESSION_PROTOCOL = "daynight.session.v1" as const;
export const SESSION_SCHEMA_VERSION = 1 as const;
export const SESSION_PROJECTION_VERSION = 1 as const;
export type SessionProvider = "codex" | "claude" | "copilot";
export type DecimalSequence = string;
export type SessionBinding = { readonly claimId: string; readonly testExecutionId?: never } | { readonly testExecutionId: string; readonly claimId?: never };
export type SessionFence = SessionBinding & {
  readonly sessionId: string;
  readonly executionGeneration: DecimalSequence;
};
export type ControllerFence = SessionFence & { readonly connectionEpoch: DecimalSequence };
export type InitialInputState = "not_required" | "not_submitted" | "dispatching" | "provider_accepted" | "confirmed" | "failed" | "unknown";
export type SessionCapabilities = { readonly send: boolean; readonly steer: boolean; readonly cancel: boolean; readonly respond: boolean };
export type SessionOperations = { readonly canSend: boolean; readonly canCancel: boolean; readonly canRespond: boolean };
export type SessionSnapshot = ControllerFence & {
  readonly controls?: SessionControls;
  readonly turnStartedAt?: string | null;
  readonly protocol: typeof SESSION_PROTOCOL;
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly projectionVersion: typeof SESSION_PROJECTION_VERSION;
  readonly identity: ({ readonly projectId: string; readonly taskId: string; readonly workerId: string; readonly worktreeId: string; readonly ownerUserId?: never } | { readonly ownerUserId: string; readonly projectId?: never; readonly taskId?: never; readonly workerId?: never; readonly worktreeId?: never }) & {
    readonly controllerId: string; readonly controllerInstanceId: string;
    readonly agentControlMode: "web"; readonly provider: SessionProvider; readonly nativeSessionId: string | null;
  };
  readonly sessionRevision: DecimalSequence;
  readonly historyEpoch: string;
  readonly lastEventSeq: DecimalSequence;
  readonly lastTimelineSeq: DecimalSequence;
  readonly initialInputState: InitialInputState;
  readonly synchronized: boolean;
  readonly lifecycle: "active" | "draining" | "archived";
  readonly connectionState: "connected" | "disconnected" | "synchronizing";
  readonly activity: "initializing" | "idle" | "working" | "waiting_input" | "stopped" | "unknown";
  readonly currentTurnId: string | null;
  readonly capabilities: SessionCapabilities;
  readonly operations: SessionOperations;
  readonly cleanupInteractionIds?: readonly string[];
};
export type TextPart = { readonly type: "text"; readonly text: string };
export type ResourcePart = { readonly type: "resource"; readonly resourceId: string; readonly label: string };
export type MessagePart = TextPart | ResourcePart;
export type ApprovalAction = "allow_once" | "allow_session" | "reject";
export type FormValue = string | number | boolean | readonly string[];
export type InteractionResponse =
  | { readonly kind: "approval"; readonly action: ApprovalAction }
  | { readonly kind: "question"; readonly answers: readonly { readonly questionId: string; readonly optionIds: readonly string[]; readonly text: string | null }[] }
  | { readonly kind: "form"; readonly values: readonly { readonly fieldId: string; readonly value: FormValue }[] }
  | { readonly kind: "dismiss" };
export type SessionCommand = SessionFence & {
  readonly protocol: typeof SESSION_PROTOCOL;
  readonly requestId: string;
  readonly operationId: string;
} & (
  | { readonly kind: "send_message"; readonly payload: { readonly content: readonly TextPart[]; readonly expectedTurnId: string | null } }
  | { readonly kind: "update_setting"; readonly payload: { readonly settingId: string; readonly value: string; readonly expectedControlsRevision: string } }
  | { readonly kind: "execute_command"; readonly payload: { readonly commandId: string; readonly arguments: string; readonly expectedControlsRevision: string; readonly expectedTurnId: string | null } }
  | { readonly kind: "refresh_controls"; readonly payload: Record<string, never> }
  | { readonly kind: "cancel"; readonly payload: { readonly expectedTurnId: string } }
  | { readonly kind: "interaction_response"; readonly payload: { readonly interactionId: string; readonly interactionRevision: DecimalSequence; readonly submissionId: string; readonly response: InteractionResponse } }
);
export type OperationState = "accepted" | "offered" | "dispatching" | "provider_accepted" | "confirmed" | "failed" | "rejected" | "expired" | "unknown";
export type SessionOperation = SessionFence & {
  readonly protocol: typeof SESSION_PROTOCOL;
  readonly operationId: string;
  readonly kind: SessionCommand["kind"];
  readonly state: OperationState;
  readonly providerResult: "started" | "queued" | "handled" | null;
  readonly error: { readonly code: string; readonly message: string } | null;
};
export type SessionResource = {
  readonly resourceId: string;
  readonly status: "pending" | "available" | "failed" | "unavailable";
  readonly name: string;
  readonly mediaType: string | null;
  readonly byteLength: DecimalSequence | null;
  readonly sha256: string | null;
  readonly error: string | null;
};
export type InteractionOption = { readonly id: string; readonly label: string };
export type FormField = {
  readonly fieldId: string; readonly label: string; readonly required: boolean;
} & (
  | { readonly type: "text"; readonly sensitive: boolean }
  | { readonly type: "number"; readonly min: number | null; readonly max: number | null }
  | { readonly type: "boolean" }
  | { readonly type: "select" | "multiselect"; readonly options: readonly InteractionOption[] }
);
export type SessionInteraction = {
  readonly interactionId: string;
  readonly revision: DecimalSequence;
  readonly state: "pending" | "resolved" | "expired";
  readonly title: string;
} & (
  | { readonly kind: "approval"; readonly detail: string; readonly actions: readonly ApprovalAction[] }
  | { readonly kind: "question"; readonly questions: readonly { readonly questionId: string; readonly label: string; readonly options: readonly InteractionOption[]; readonly multiple: boolean; readonly allowCustom: boolean; readonly required: boolean; readonly sensitive: boolean }[]; readonly canDismiss: boolean }
  | { readonly kind: "form"; readonly fields: readonly FormField[]; readonly canDismiss: boolean }
);
export type TimelineEntry = {
  readonly entryId: string; readonly entrySeq: DecimalSequence; readonly revision: DecimalSequence;
} & (
  | { readonly kind: "user_message" | "assistant_message"; readonly content: readonly MessagePart[] }
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "tool_call"; readonly callId: string; readonly name: string; readonly input: string; readonly output: readonly MessagePart[]; readonly status: "running" | "completed" | "failed"; readonly truncated: boolean }
  | { readonly kind: "interaction"; readonly interaction: SessionInteraction }
  | { readonly kind: "error"; readonly code: string; readonly message: string }
  | { readonly kind: "compaction"; readonly summary: string }
  | { readonly kind: "todo"; readonly items: readonly { readonly id: string; readonly text: string; readonly status: "pending" | "in_progress" | "completed" }[] }
);
export type SessionEvent = ControllerFence & {
  readonly protocol: typeof SESSION_PROTOCOL;
  readonly eventSeq: DecimalSequence;
  readonly historyEpoch: string;
} & (
  | { readonly kind: "timeline_upsert"; readonly payload: TimelineEntry }
  | { readonly kind: "snapshot"; readonly payload: SessionSnapshot }
  | { readonly kind: "operation"; readonly payload: SessionOperation }
  | { readonly kind: "resource"; readonly payload: SessionResource }
  | { readonly kind: "gap"; readonly payload: { readonly reason: string; readonly cursor: string | null } }
);

const invalid = (): never => { throw new Error("Invalid Daynight session protocol value."); };
const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== keys.length || keys.some((key) => !Object.hasOwn(data, key))) return invalid();
  return data;
};
const textBytes = new TextEncoder();
const text = (value: unknown, allowEmpty = false): string => {
  if (typeof value !== "string" || value.length > 1_048_576 || !value.isWellFormed() || value.includes("\0") || (!allowEmpty && !/[^\p{White_Space}]/u.test(value)) || textBytes.encode(value).byteLength > 1_048_576) return invalid();
  return value;
};
const key = (value: unknown): string => {
  const result = text(value);
  return textBytes.encode(result).byteLength <= 256 ? result : invalid();
};
const id = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return invalid();
  return value;
};
const sequence = (value: unknown, zero = false): DecimalSequence => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 19 || (!zero && value === "0") || BigInt(value) > 9_223_372_036_854_775_807n) return invalid();
  return value;
};
const bool = (value: unknown): boolean => typeof value === "boolean" ? value : invalid();
const finite = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : invalid();
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T => typeof value === "string" && values.includes(value as T) ? value as T : invalid();
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);
const list = <T>(value: unknown, parse: (value: unknown) => T): T[] => {
  if (!Array.isArray(value) || value.length > 1000) return invalid();
  return value.map(parse);
};
const unique = <T>(values: T[], identity: (item: T) => string): T[] => new Set(values.map(identity)).size === values.length ? values : invalid();
const nonempty = <T>(values: T[]): T[] => values.length > 0 ? values : invalid();
const protocol = (value: unknown): typeof SESSION_PROTOCOL => value === SESSION_PROTOCOL ? value : invalid();
export const sessionBindingKeys = (value: unknown): readonly string[] => {
  if (!value || typeof value !== "object" || Object.hasOwn(value, "claimId") === Object.hasOwn(value, "testExecutionId")) return invalid();
  return Object.hasOwn(value, "testExecutionId") ? ["testExecutionId"] : ["claimId"];
};
export const sessionBinding = (value: unknown): SessionBinding => {
  const keys = sessionBindingKeys(value), data = value as Record<string, unknown>;
  return keys[0] === "testExecutionId" ? { testExecutionId: id(data.testExecutionId) } : { claimId: id(data.claimId) };
};
const fenceKeys = (value: unknown) => ["sessionId", ...sessionBindingKeys(value), "executionGeneration"];
export const sessionFence = (data: SessionFence): SessionFence => ({ sessionId: id(data.sessionId), ...sessionBinding(data), executionGeneration: sequence(data.executionGeneration) });
const fence = (data: Record<string, unknown>): SessionFence => sessionFence(data as SessionFence);
export const sessionFenceKey = (data: SessionFence): string => JSON.stringify(sessionFence(data));

// A connection epoch fences relay traffic; it is not evidence that a native writer stopped.
export const assertSessionFence = (actual: SessionFence & { readonly connectionEpoch?: string }, expected: SessionFence & { readonly connectionEpoch?: string }): void => {
  if (actual.sessionId !== expected.sessionId || actual.claimId !== expected.claimId || actual.testExecutionId !== expected.testExecutionId || actual.executionGeneration !== expected.executionGeneration || (expected.connectionEpoch !== undefined && actual.connectionEpoch !== expected.connectionEpoch)) {
    throw new Error("Daynight session fence mismatch.");
  }
};
const approvalAction = (value: unknown): ApprovalAction => oneOf(value, ["allow_once", "allow_session", "reject"]);
const option = (value: unknown): InteractionOption => {
  const data = object(value, ["id", "label"]);
  return { id: key(data.id), label: text(data.label) };
};
const options = (value: unknown): InteractionOption[] => unique(list(value, option), (item) => item.id);
export const parseInteractionResponse = (value: unknown): InteractionResponse => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return invalid();
  if (value.kind === "dismiss") { object(value, ["kind"]); return { kind: "dismiss" }; }
  if (value.kind === "approval") { const data = object(value, ["kind", "action"]); return { kind: "approval", action: approvalAction(data.action) }; }
  if (value.kind === "question") {
    const data = object(value, ["kind", "answers"]);
    return { kind: "question", answers: nonempty(unique(list(data.answers, (answer) => {
      const item = object(answer, ["questionId", "optionIds", "text"]);
      return { questionId: key(item.questionId), optionIds: unique(list(item.optionIds, key), (entry) => entry), text: nullable(item.text, (value) => text(value, true)) };
    }), (item) => item.questionId)) };
  }
  if (value.kind === "form") {
    const data = object(value, ["kind", "values"]);
    return { kind: "form", values: unique(list(data.values, (field) => {
      const item = object(field, ["fieldId", "value"]);
      const parsed = typeof item.value === "string" ? text(item.value, true) : typeof item.value === "boolean" ? item.value : typeof item.value === "number" ? finite(item.value) : unique(list(item.value, key), (entry) => entry);
      return { fieldId: key(item.fieldId), value: parsed };
    }), (item) => item.fieldId) };
  }
  return invalid();
};
export const parseSessionCommand = (value: unknown): SessionCommand => {
  const data = object(value, ["protocol", "requestId", "operationId", ...fenceKeys(value), "kind", "payload"]);
  const requestId = key(data.requestId);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(requestId)) return invalid();
  const base = { protocol: protocol(data.protocol), requestId, operationId: id(data.operationId), ...fence(data) };
  if (data.kind === "send_message") {
    const payload = object(data.payload, ["content", "expectedTurnId"]);
    const content = nonempty(list(payload.content, (part): TextPart => {
      const item = object(part, ["type", "text"]);
      if (item.type !== "text") return invalid();
      return { type: "text", text: text(item.text) };
    }));
    return { ...base, kind: "send_message", payload: { content, expectedTurnId: nullable(payload.expectedTurnId, key) } };
  }
  if (data.kind === "update_setting") {
    const payload = object(data.payload, ["settingId", "value", "expectedControlsRevision"]);
    const value = text(payload.value); if (textBytes.encode(value).length > 4096) return invalid();
    return { ...base, kind: "update_setting", payload: { settingId: key(payload.settingId), value, expectedControlsRevision: sequence(payload.expectedControlsRevision) } };
  }
  if (data.kind === "execute_command") {
    const payload = object(data.payload, ["commandId", "arguments", "expectedControlsRevision", "expectedTurnId"]);
    return { ...base, kind: "execute_command", payload: { commandId: key(payload.commandId), arguments: text(payload.arguments, true), expectedControlsRevision: sequence(payload.expectedControlsRevision), expectedTurnId: nullable(payload.expectedTurnId, key) } };
  }
  if (data.kind === "refresh_controls") { object(data.payload, []); return { ...base, kind: "refresh_controls", payload: {} }; }
  if (data.kind === "cancel") {
    const payload = object(data.payload, ["expectedTurnId"]);
    return { ...base, kind: "cancel", payload: { expectedTurnId: key(payload.expectedTurnId) } };
  }
  if (data.kind === "interaction_response") {
    const payload = object(data.payload, ["interactionId", "interactionRevision", "submissionId", "response"]);
    return { ...base, kind: "interaction_response", payload: { interactionId: id(payload.interactionId), interactionRevision: sequence(payload.interactionRevision), submissionId: id(payload.submissionId), response: parseInteractionResponse(payload.response) } };
  }
  return invalid();
};
export const sessionControlKeys = (value: unknown): string[] => value && typeof value === "object" ? ["controls", "turnStartedAt"].filter(key => Object.hasOwn(value, key)) : [];
export const parseSessionControlFields = (data: Record<string, unknown>): Pick<SessionSnapshot, "controls" | "turnStartedAt"> => {
  const result: { controls?: SessionControls; turnStartedAt?: string | null } = {};
  if (Object.hasOwn(data, "controls")) result.controls = parseSessionControls(data.controls);
  if (Object.hasOwn(data, "turnStartedAt")) {
    const value = data.turnStartedAt;
    if (value !== null && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) return invalid();
    result.turnStartedAt = value as string | null;
  }
  return result;
};
export const parseSessionSnapshot = (value: unknown): SessionSnapshot => {
  const data = object(value, ["protocol", "schemaVersion", "projectionVersion", ...fenceKeys(value), ...sessionControlKeys(value), "connectionEpoch", "identity", "sessionRevision", "historyEpoch", "lastEventSeq", "lastTimelineSeq", "initialInputState", "synchronized", "lifecycle", "connectionState", "activity", "currentTurnId", "capabilities", "operations", ...(value && typeof value === "object" && Object.hasOwn(value, "cleanupInteractionIds") ? ["cleanupInteractionIds"] : [])]);
  if (data.schemaVersion !== SESSION_SCHEMA_VERSION || data.projectionVersion !== SESSION_PROJECTION_VERSION) return invalid();
  const test = Object.hasOwn(data, "testExecutionId");
  const identity = object(data.identity, [...(test ? ["ownerUserId"] : ["projectId", "taskId", "workerId", "worktreeId"]), "controllerId", "controllerInstanceId", "agentControlMode", "provider", "nativeSessionId"]);
  if (identity.agentControlMode !== "web") return invalid();
  const capabilities = object(data.capabilities, ["send", "steer", "cancel", "respond"]);
  const operations = object(data.operations, ["canSend", "canCancel", "canRespond"]);
  const result: SessionSnapshot = {
    ...parseSessionControlFields(data),
    ...(Object.hasOwn(data, "cleanupInteractionIds") ? { cleanupInteractionIds: unique(list(data.cleanupInteractionIds, id), item => item) } : {}),
    protocol: protocol(data.protocol), schemaVersion: SESSION_SCHEMA_VERSION, projectionVersion: SESSION_PROJECTION_VERSION, ...fence(data), connectionEpoch: sequence(data.connectionEpoch, true),
    identity: { ...(test ? { ownerUserId: id(identity.ownerUserId) } : { projectId: id(identity.projectId), taskId: id(identity.taskId), workerId: id(identity.workerId), worktreeId: id(identity.worktreeId) }), controllerId: id(identity.controllerId), controllerInstanceId: id(identity.controllerInstanceId), agentControlMode: "web", provider: oneOf(identity.provider, ["codex", "claude", "copilot"]), nativeSessionId: nullable(identity.nativeSessionId, key) },
    sessionRevision: sequence(data.sessionRevision), historyEpoch: key(data.historyEpoch), lastEventSeq: sequence(data.lastEventSeq, true), lastTimelineSeq: sequence(data.lastTimelineSeq, true),
    initialInputState: oneOf(data.initialInputState, [...(test ? ["not_required" as const] : []), "not_submitted", "dispatching", "provider_accepted", "confirmed", "failed", "unknown"]), synchronized: bool(data.synchronized),
    lifecycle: oneOf(data.lifecycle, ["active", "draining", "archived"]), connectionState: oneOf(data.connectionState, ["connected", "disconnected", "synchronizing"]), activity: oneOf(data.activity, ["initializing", "idle", "working", "waiting_input", "stopped", "unknown"]), currentTurnId: nullable(data.currentTurnId, key),
    capabilities: { send: bool(capabilities.send), steer: bool(capabilities.steer), cancel: bool(capabilities.cancel), respond: bool(capabilities.respond) },
    operations: { canSend: bool(operations.canSend), canCancel: bool(operations.canCancel), canRespond: bool(operations.canRespond) },
  };
  // Initial approval callbacks may be actionable before the managed input is accepted.
  const writable = (result.lifecycle === "active" || result.lifecycle === "draining" && !result.operations.canSend && !result.operations.canCancel) && result.connectionState === "connected" && result.synchronized;
  if (result.connectionEpoch === "0" && (result.connectionState === "connected" || result.operations.canSend || result.operations.canCancel || result.operations.canRespond)) return invalid();
  if ((result.operations.canSend || result.operations.canCancel || result.operations.canRespond) && !writable) return invalid();
  if (result.operations.canSend && (!result.capabilities.send || (result.identity.nativeSessionId === null && !(test && result.initialInputState === "not_required" && result.activity === "idle")) || !["not_required", "provider_accepted", "confirmed"].includes(result.initialInputState) || !(result.activity === "idle" || (result.activity === "working" && result.capabilities.steer && result.currentTurnId !== null)))) return invalid();
  if (result.operations.canCancel && (!result.capabilities.cancel || result.currentTurnId === null)) return invalid();
  if (result.operations.canRespond && (!result.capabilities.respond || result.lifecycle === "draining" && !result.cleanupInteractionIds?.length)) return invalid();
  return result;
};
export const parseSessionOperation = (value: unknown): SessionOperation => {
  const data = object(value, ["protocol", ...fenceKeys(value), "operationId", "kind", "state", "providerResult", "error"]);
  const error = data.error === null ? null : object(data.error, ["code", "message"]);
  return { protocol: protocol(data.protocol), ...fence(data), operationId: id(data.operationId), kind: oneOf(data.kind, ["send_message", "cancel", "interaction_response", "update_setting", "execute_command", "refresh_controls"]), state: oneOf(data.state, ["accepted", "offered", "dispatching", "provider_accepted", "confirmed", "failed", "rejected", "expired", "unknown"]), providerResult: nullable(data.providerResult, (value) => oneOf(value, ["started", "queued", "handled"])), error: error === null ? null : { code: key(error.code), message: text(error.message) } };
};
export const parseSessionResource = (value: unknown): SessionResource => {
  const data = object(value, ["resourceId", "status", "name", "mediaType", "byteLength", "sha256", "error"]);
  const result: SessionResource = { resourceId: id(data.resourceId), status: oneOf(data.status, ["pending", "available", "failed", "unavailable"]), name: key(data.name), mediaType: nullable(data.mediaType, key), byteLength: nullable(data.byteLength, (value) => sequence(value, true)), sha256: nullable(data.sha256, key), error: nullable(data.error, text) };
  if (result.sha256 !== null && !/^[a-f0-9]{64}$/.test(result.sha256)) return invalid();
  if (result.mediaType !== null && !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(result.mediaType)) return invalid();
  if (result.status === "available" && (result.sha256 === null || result.mediaType === null || result.byteLength === null || result.error !== null)) return invalid();
  return result;
};
const formField = (value: unknown): FormField => {
  if (typeof value !== "object" || value === null || !("type" in value)) return invalid();
  const extra = value.type === "text" ? ["sensitive"] : value.type === "number" ? ["min", "max"] : value.type === "boolean" ? [] : ["options"];
  const data = object(value, ["fieldId", "label", "required", "type", ...extra]);
  const base = { fieldId: key(data.fieldId), label: text(data.label), required: bool(data.required) };
  if (data.type === "text") return { ...base, type: "text", sensitive: bool(data.sensitive) };
  if (data.type === "number") {
    const min = nullable(data.min, finite), max = nullable(data.max, finite);
    if (min !== null && max !== null && min > max) return invalid();
    return { ...base, type: "number", min, max };
  }
  if (data.type === "boolean") return { ...base, type: "boolean" };
  return { ...base, type: oneOf(data.type, ["select", "multiselect"]), options: nonempty(options(data.options)) };
};
export const parseSessionInteraction = (value: unknown): SessionInteraction => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return invalid();
  const extra = value.kind === "approval" ? ["detail", "actions"] : value.kind === "question" ? ["questions", "canDismiss"] : ["fields", "canDismiss"];
  const data = object(value, ["interactionId", "revision", "state", "title", "kind", ...extra]);
  const base = { interactionId: id(data.interactionId), revision: sequence(data.revision), state: oneOf(data.state, ["pending", "resolved", "expired"]), title: text(data.title) };
  if (data.kind === "approval") return { ...base, kind: "approval", detail: text(data.detail, true), actions: nonempty(unique(list(data.actions, approvalAction), (item) => item)) };
  if (data.kind === "question") {
    return { ...base, kind: "question", canDismiss: bool(data.canDismiss), questions: nonempty(unique(list(data.questions, (value) => {
      const item = object(value, ["questionId", "label", "options", "multiple", "allowCustom", "required", "sensitive"]);
      const result = { questionId: key(item.questionId), label: text(item.label), options: options(item.options), multiple: bool(item.multiple), allowCustom: bool(item.allowCustom), required: bool(item.required), sensitive: bool(item.sensitive) };
      if (result.options.length === 0 && !result.allowCustom) return invalid();
      return result;
    }), (item) => item.questionId)) };
  }
  if (data.kind === "form") return { ...base, kind: "form", canDismiss: bool(data.canDismiss), fields: nonempty(unique(list(data.fields, formField), (item) => item.fieldId)) };
  return invalid();
};
const messagePart = (value: unknown): MessagePart => {
  if (typeof value !== "object" || value === null || !("type" in value)) return invalid();
  if (value.type === "text") { const data = object(value, ["type", "text"]); return { type: "text", text: text(data.text, true) }; }
  if (value.type === "resource") { const data = object(value, ["type", "resourceId", "label"]); return { type: "resource", resourceId: id(data.resourceId), label: text(data.label) }; }
  return invalid();
};
export const parseTimelineEntry = (value: unknown): TimelineEntry => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return invalid();
  const common = ["entryId", "entrySeq", "revision", "kind"];
  const extras: Record<string, readonly string[]> = {
    user_message: ["content"], assistant_message: ["content"], reasoning: ["text"], tool_call: ["callId", "name", "input", "output", "status", "truncated"],
    interaction: ["interaction"], error: ["code", "message"], compaction: ["summary"], todo: ["items"],
  };
  const kind = oneOf(value.kind, ["user_message", "assistant_message", "reasoning", "tool_call", "interaction", "error", "compaction", "todo"]);
  const data = object(value, [...common, ...extras[kind]!]);
  const base = { entryId: id(data.entryId), entrySeq: sequence(data.entrySeq), revision: sequence(data.revision) };
  if (kind === "user_message" || kind === "assistant_message") return { ...base, kind, content: list(data.content, messagePart) };
  if (kind === "reasoning") return { ...base, kind, text: text(data.text, true) };
  if (kind === "tool_call") return { ...base, kind, callId: key(data.callId), name: key(data.name), input: text(data.input, true), output: list(data.output, messagePart), status: oneOf(data.status, ["running", "completed", "failed"]), truncated: bool(data.truncated) };
  if (kind === "interaction") return { ...base, kind, interaction: parseSessionInteraction(data.interaction) };
  if (kind === "error") return { ...base, kind, code: key(data.code), message: text(data.message) };
  if (kind === "compaction") return { ...base, kind, summary: text(data.summary, true) };
  return { ...base, kind: "todo", items: unique(list(data.items, (value) => { const item = object(value, ["id", "text", "status"]); return { id: key(item.id), text: text(item.text), status: oneOf(item.status, ["pending", "in_progress", "completed"]) }; }), (item) => item.id) };
};
export const parseSessionEvent = (value: unknown): SessionEvent => {
  const data = object(value, ["protocol", ...fenceKeys(value), "connectionEpoch", "eventSeq", "historyEpoch", "kind", "payload"]);
  const base = { protocol: protocol(data.protocol), ...fence(data), connectionEpoch: sequence(data.connectionEpoch, data.kind === "snapshot"), eventSeq: sequence(data.eventSeq), historyEpoch: key(data.historyEpoch) };
  if (data.kind === "timeline_upsert") return { ...base, kind: "timeline_upsert", payload: parseTimelineEntry(data.payload) };
  if (data.kind === "snapshot") {
    const payload = parseSessionSnapshot(data.payload);
    assertSessionFence(payload, base);
    if (payload.historyEpoch !== base.historyEpoch) return invalid();
    return { ...base, kind: "snapshot", payload };
  }
  if (data.kind === "operation") {
    const payload = parseSessionOperation(data.payload);
    assertSessionFence(payload, fence(data));
    return { ...base, kind: "operation", payload };
  }
  if (data.kind === "resource") return { ...base, kind: "resource", payload: parseSessionResource(data.payload) };
  if (data.kind === "gap") {
    const payload = object(data.payload, ["reason", "cursor"]);
    return { ...base, kind: "gap", payload: { reason: text(payload.reason), cursor: nullable(payload.cursor, key) } };
  }
  return invalid();
};
