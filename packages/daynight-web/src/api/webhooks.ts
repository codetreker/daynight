import { ApiError, assertResponsePrincipal, json, request, requestId } from "./client";
import { array, boolean, count, malformed, nonemptyString, nullableTimestamp, record, string, timestamp } from "./validation";

const fields = (value: unknown, required: readonly string[]) => {
  const data = record(value);
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key))) return malformed();
  return data;
};
const id = (value: unknown): string => {
  const parsed = string(value);
  if (requestId(parsed) !== parsed || parsed === "00000000-0000-0000-0000-000000000000") return malformed();
  return parsed;
};

export type WebhookOwner = { readonly kind: "personal" | "team"; readonly id: string };

// The service preserves the original UTC timestamp lexeme, including all
// fractional digits. Check the calendar without normalizing the returned string.
export const isWebhookIssuedAt = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
};
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): T => {
  const s = string(value);
  return choices.includes(s as T) ? s as T : malformed();
};
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);
export const webhookVersion = (value: unknown): string => {
  const s = string(value);
  if (!/^[1-9][0-9]{0,18}$/.test(s) || BigInt(s) > 9_223_372_036_854_775_807n) return malformed();
  return s;
};
const nonempty = (value: unknown): string => nonemptyString(value);
const positive = (value: unknown): number => { const n = count(value); return n > 0 ? n : malformed(); };
const httpStatus = (value: unknown): number => { const n = count(value); return n >= 100 && n <= 599 ? n : malformed(); };
export const parseWebhookEventType = (value: unknown) => oneOf(value, ["task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"] as const);
export const parseWebhookOwner = (value: unknown, expected?: WebhookOwner): WebhookOwner => {
  const o = fields(value, ["kind", "id"]);
  const result = { kind: oneOf(o.kind, ["personal", "team"] as const), id: id(o.id) };
  if (expected !== undefined && (result.kind !== expected.kind || result.id !== expected.id)) return malformed();
  return result;
};
const destination = (value: unknown) => {
  const d = fields(value, ["kind", "adapterVersion", "url", "displayUrl"]);
  return { kind: oneOf(d.kind, ["http"] as const), adapterVersion: oneOf(d.adapterVersion, ["1"] as const), url: nullable(d.url, nonempty), displayUrl: nonempty(d.displayUrl) };
};
const signing = (value: unknown) => {
  const d = fields(value, ["scheme", "activeKeyId", "overlapUntil"]);
  return { scheme: oneOf(d.scheme, ["standard-webhooks-v1"] as const), activeKeyId: id(d.activeKeyId), overlapUntil: nullableTimestamp(d.overlapUntil) };
};
export const parseWebhookSubscription = (value: unknown) => {
  const d = fields(value, ["id", "projectId", "projectName", "eventTypes", "eligibility"]);
  const events = array(d.eventTypes, parseWebhookEventType);
  if (events.length === 0 || new Set(events).size !== events.length) return malformed();
  return { id: id(d.id), projectId: id(d.projectId), projectName: nullable(d.projectName, string), eventTypes: events, eligibility: oneOf(d.eligibility, ["eligible", "access_revoked", "owner_scope_changed", "resource_unavailable", "confirmation_required"] as const) };
};
const outcome = (value: unknown) => oneOf(value, ["acknowledged", "http_error", "receiver_error", "transport_error", "unknown", "cancelled", "policy_denied", "render_error"] as const);
const result = (value: unknown) => {
  const d = fields(value, ["category", "code", "httpStatus", "durationMs"]);
  return { category: outcome(d.category), code: nullable(d.code, nonempty), httpStatus: nullable(d.httpStatus, httpStatus), durationMs: nullable(d.durationMs, count) };
};
export const parseWebhookCatalog = (value: unknown) => {
  const d = fields(value, ["items", "service", "limits"]);
  const items = array(d.items, (item) => {
    const e = fields(item, ["key", "wireType", "schemaVersion", "resourceKind"]);
    const key = parseWebhookEventType(e.key), wireType = nonempty(e.wireType);
    if (wireType !== `cc.daynight.${key}.v1` || e.schemaVersion !== 1 || e.resourceKind !== "project") return malformed();
    return { key, wireType, schemaVersion: 1, resourceKind: "project" as const };
  });
  if (items.length !== 6 || new Set(items.map((item) => item.key)).size !== 6) return malformed();
  const s = fields(d.service, ["configurationExpansionAvailable", "dispatchEnabled"]);
  const l = fields(d.limits, ["policyVersion", "requestBytes", "payloadBytes", "maxAutomaticAttempts", "automaticWindowSeconds", "maxManualOperations", "payloadRetentionSeconds", "operationMaxAgeSeconds", "operationFutureSkewSeconds"]);
  return { items, service: { configurationExpansionAvailable: boolean(s.configurationExpansionAvailable), dispatchEnabled: boolean(s.dispatchEnabled) }, limits: { policyVersion: webhookVersion(l.policyVersion), requestBytes: positive(l.requestBytes), payloadBytes: positive(l.payloadBytes), maxAutomaticAttempts: count(l.maxAutomaticAttempts), automaticWindowSeconds: positive(l.automaticWindowSeconds), maxManualOperations: count(l.maxManualOperations), payloadRetentionSeconds: positive(l.payloadRetentionSeconds), operationMaxAgeSeconds: positive(l.operationMaxAgeSeconds), operationFutureSkewSeconds: count(l.operationFutureSkewSeconds) } };
};
export const parseWebhookEndpoint = (value: unknown, owner: WebhookOwner, expectedId?: string) => {
  const d = record(value);
  const endpointId = id(d.id); if (expectedId !== undefined && endpointId !== expectedId) return malformed();
  const base = { id: endpointId, owner: parseWebhookOwner(d.owner, owner), configVersion: webhookVersion(d.configVersion) };
  if (d.lifecycle === "deleted") {
    fields(value, ["id", "owner", "lifecycle", "configVersion", "deletedAt"]);
    return { ...base, lifecycle: "deleted" as const, deletedAt: timestamp(d.deletedAt) };
  }
  fields(value, ["id", "owner", "lifecycle", "configVersion", "deletedAt", "name", "enabled", "destinationRevision", "destination", "signing", "subscriptions", "capabilities", "createdAt", "updatedAt"]);
  if (d.lifecycle !== "active" || d.deletedAt !== null) return malformed();
  const caps = fields(d.capabilities, ["manage", "readSecret", "redeliver"]);
  const subscriptions = array(d.subscriptions, parseWebhookSubscription);
  if (new Set(subscriptions.map((s) => s.id)).size !== subscriptions.length) return malformed();
  return { ...base, lifecycle: "active" as const, name: nonempty(d.name), enabled: boolean(d.enabled), destinationRevision: webhookVersion(d.destinationRevision), destination: destination(d.destination), signing: signing(d.signing), subscriptions, capabilities: { manage: boolean(caps.manage), readSecret: boolean(caps.readSecret), redeliver: boolean(caps.redeliver) }, createdAt: timestamp(d.createdAt), updatedAt: timestamp(d.updatedAt), deletedAt: null };
};
export const parseWebhookEndpointPage = (value: unknown, owner: WebhookOwner) => {
  const d = fields(value, ["items", "nextCursor"]);
  const items = array(d.items, (item) => {
    const s = fields(item, ["id", "owner", "name", "enabled", "configVersion", "destination", "projectCount", "eventTypeCount", "lastAttemptAt", "lastResult"]);
    return { id: id(s.id), owner: parseWebhookOwner(s.owner, owner), name: nonempty(s.name), enabled: boolean(s.enabled), configVersion: webhookVersion(s.configVersion), destination: destination(s.destination), projectCount: count(s.projectCount), eventTypeCount: count(s.eventTypeCount), lastAttemptAt: nullableTimestamp(s.lastAttemptAt), lastResult: nullable(s.lastResult, result) };
  });
  if (new Set(items.map((s) => s.id)).size !== items.length) return malformed();
  return { items, nextCursor: nullable(d.nextCursor, nonempty) };
};
export const parseWebhookReceipt = (value: unknown, owner: WebhookOwner, expectedId?: string) => {
  const d = fields(value, ["operationId", "kind", "issuedAt", "requestSha256", "actorUserId", "owner", "endpointId", "effect", "configVersionAfter", "destinationRevisionAfter", "deliveryId", "generationAfter", "keyId", "overlapUntil", "recordedAt", "expiresAt"]);
  const operationId = id(d.operationId); if (expectedId !== undefined && operationId !== expectedId) return malformed();
  const requestSha256 = string(d.requestSha256); if (!/^[a-f0-9]{64}$/.test(requestSha256)) return malformed();
  const kind = oneOf(d.kind, ["endpoint.create", "endpoint.patch", "endpoint.delete", "signing-secret.rotate", "delivery.redeliver"] as const);
  const deliveryId = nullable(d.deliveryId, id), generationAfter = nullable(d.generationAfter, webhookVersion), keyId = nullable(d.keyId, id), overlapUntil = nullableTimestamp(d.overlapUntil);
  if (kind === "delivery.redeliver" ? deliveryId === null || generationAfter === null : deliveryId !== null || generationAfter !== null) return malformed();
  if ((kind === "signing-secret.rotate") !== (keyId !== null) || kind !== "signing-secret.rotate" && overlapUntil !== null) return malformed();
  const issuedAt = string(d.issuedAt); if (!isWebhookIssuedAt(issuedAt)) return malformed();
  return { operationId, kind, issuedAt, requestSha256, actorUserId: id(d.actorUserId), owner: parseWebhookOwner(d.owner, owner), endpointId: id(d.endpointId), effect: oneOf(d.effect, ["applied", "unchanged"] as const), configVersionAfter: webhookVersion(d.configVersionAfter), destinationRevisionAfter: webhookVersion(d.destinationRevisionAfter), deliveryId, generationAfter, keyId, overlapUntil, recordedAt: timestamp(d.recordedAt), expiresAt: timestamp(d.expiresAt) };
};
export const parseWebhookSecret = (value: unknown, endpointId: string) => {
  const d = fields(value, ["endpointId", "configVersion", "keyId", "scheme", "secret"]);
  if (id(d.endpointId) !== endpointId) return malformed();
  const secret = nonempty(d.secret);
  if (!secret.startsWith("whsec_")) return malformed();
  const encoded = secret.slice(6);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return malformed();
  const decoded = atob(encoded);
  if (decoded.length !== 32 || btoa(decoded) !== encoded) return malformed();
  return { endpointId, configVersion: webhookVersion(d.configVersion), keyId: id(d.keyId), scheme: oneOf(d.scheme, ["standard-webhooks-v1"] as const), secret };
};

const retention = (value: unknown) => { const d = fields(value, ["payloadRetentionSeconds", "metadataRetentionSeconds"]); return { payloadRetentionSeconds: positive(d.payloadRetentionSeconds), metadataRetentionSeconds: positive(d.metadataRetentionSeconds) }; };
export const parseWebhookDelivery = (value: unknown, owner: WebhookOwner, endpointId: string, expectedId?: string) => {
  const d = fields(value, ["id", "endpointId", "eventId", "owner", "eventType", "resource", "occurredAt", "resourceVersion", "target", "generation", "state", "attemptCount", "automaticAttemptCount", "manualOperationCount", "nextAttemptAt", "lastAttemptAt", "expiresAt", "automaticExpiresAt", "payloadExpiresAt", "lastAcknowledgedAt", "lastResult", "payloadAvailable", "disclosure"]);
  const deliveryId = id(d.id); if (id(d.endpointId) !== endpointId || (expectedId !== undefined && deliveryId !== expectedId)) return malformed();
  const r = fields(d.resource, ["projectId", "taskId", "stepId", "messageId", "displayName"]), t = fields(d.target, ["destinationRevision", "url", "displayUrl"]);
  const step = nullable(r.stepId, string); if (step !== null && !/^[0-9a-f]{8}$/.test(step)) return malformed();
  if (d.disclosure === "metadata_only" && (d.eventType !== null || d.resourceVersion !== null || Object.values(r).some((item) => item !== null) || t.url !== null || t.displayUrl !== null || d.payloadAvailable !== false)) return malformed();
  if (d.disclosure === "full" && (d.eventType === null || r.projectId === null || r.taskId === null || t.displayUrl === null)) return malformed();
  return { id: deliveryId, endpointId, eventId: id(d.eventId), owner: parseWebhookOwner(d.owner, owner), eventType: nullable(d.eventType, parseWebhookEventType), resource: { projectId: nullable(r.projectId, id), taskId: nullable(r.taskId, id), stepId: step, messageId: nullable(r.messageId, id), displayName: nullable(r.displayName, string) }, occurredAt: timestamp(d.occurredAt), resourceVersion: nullable(d.resourceVersion, webhookVersion), target: { destinationRevision: webhookVersion(t.destinationRevision), url: nullable(t.url, nonempty), displayUrl: nullable(t.displayUrl, nonempty) }, generation: webhookVersion(d.generation), state: oneOf(d.state, ["pending", "leased", "delivered", "failed", "suppressed"] as const), attemptCount: count(d.attemptCount), automaticAttemptCount: count(d.automaticAttemptCount), manualOperationCount: count(d.manualOperationCount), nextAttemptAt: nullableTimestamp(d.nextAttemptAt), lastAttemptAt: nullableTimestamp(d.lastAttemptAt), expiresAt: timestamp(d.expiresAt), automaticExpiresAt: timestamp(d.automaticExpiresAt), payloadExpiresAt: timestamp(d.payloadExpiresAt), lastAcknowledgedAt: nullableTimestamp(d.lastAcknowledgedAt), lastResult: nullable(d.lastResult, result), payloadAvailable: boolean(d.payloadAvailable), disclosure: oneOf(d.disclosure, ["full", "metadata_only"] as const) };
};
export const parseWebhookAttempt = (value: unknown, endpointId: string, deliveryId: string) => {
  const d = fields(value, ["id", "endpointId", "deliveryId", "generation", "number", "claimedAt", "admittedAt", "dispatchedAt", "finishedAt", "outcome", "httpStatus", "durationMs", "error", "recoveredUnknownAt", "lateResult"]);
  if (id(d.endpointId) !== endpointId || id(d.deliveryId) !== deliveryId) return malformed();
  const error = nullable(d.error, (v) => { const e = fields(v, ["category", "code", "message"]); return { category: outcome(e.category), code: nonempty(e.code), message: string(e.message) }; });
  const lateResult = nullable(d.lateResult, (v) => { const e = fields(v, ["observedAt", "outcome", "httpStatus", "durationMs", "error"]); return { observedAt: timestamp(e.observedAt), outcome: outcome(e.outcome), httpStatus: nullable(e.httpStatus, httpStatus), durationMs: nullable(e.durationMs, count), error: nullable(e.error, nonempty) }; });
  return { id: id(d.id), endpointId, deliveryId, generation: webhookVersion(d.generation), number: positive(d.number), claimedAt: timestamp(d.claimedAt), admittedAt: nullableTimestamp(d.admittedAt), dispatchedAt: nullableTimestamp(d.dispatchedAt), finishedAt: nullableTimestamp(d.finishedAt), outcome: nullable(d.outcome, outcome), httpStatus: nullable(d.httpStatus, httpStatus), durationMs: nullable(d.durationMs, count), error, recoveredUnknownAt: nullableTimestamp(d.recoveredUnknownAt), lateResult };
};
export const parseWebhookHistoryPage = <T>(value: unknown, parse: (value: unknown) => T) => {
  const d = fields(value, ["items", "nextCursor", "historyMayBeIncomplete", "retention"]);
  if (d.historyMayBeIncomplete !== true) return malformed();
  return { items: array(d.items, parse), nextCursor: nullable(d.nextCursor, nonempty), historyMayBeIncomplete: true as const, retention: retention(d.retention) };
};

export type WebhookCatalog = ReturnType<typeof parseWebhookCatalog>;
export type WebhookEndpoint = ReturnType<typeof parseWebhookEndpoint>;
export type WebhookActiveEndpoint = Extract<WebhookEndpoint, { lifecycle: "active" }>;
export type WebhookDeletedEndpoint = Extract<WebhookEndpoint, { lifecycle: "deleted" }>;
export type WebhookEndpointPage = ReturnType<typeof parseWebhookEndpointPage>;
export type WebhookEndpointSummary = WebhookEndpointPage["items"][number];
export type WebhookSubscription = ReturnType<typeof parseWebhookSubscription>;
export type WebhookEventType = ReturnType<typeof parseWebhookEventType>;
export type WebhookReceipt = ReturnType<typeof parseWebhookReceipt>;
export type WebhookSecret = ReturnType<typeof parseWebhookSecret>;
export type WebhookDelivery = ReturnType<typeof parseWebhookDelivery>;
export type WebhookAttempt = ReturnType<typeof parseWebhookAttempt>;
export type WebhookHistoryPage<T> = { readonly items: readonly T[]; readonly nextCursor: string | null; readonly historyMayBeIncomplete: true; readonly retention: ReturnType<typeof retention> };
export type WebhookDeliveryPage = WebhookHistoryPage<WebhookDelivery>;
export type WebhookAttemptPage = WebhookHistoryPage<WebhookAttempt>;
export type WebhookDeliveryQuery = { readonly eventType?: WebhookEventType; readonly state?: WebhookDelivery["state"]; readonly projectId?: string; readonly from?: string; readonly to?: string; readonly limit?: number; readonly cursor?: string };
export type WebhookAttemptQuery = { readonly generation?: string; readonly limit?: number; readonly cursor?: string };
export type WebhookPayload = { readonly owner: WebhookOwner; readonly endpointId: string; readonly deliveryId: string; readonly eventId: string; readonly mediaType: "application/cloudevents+json"; readonly encoding: "base64"; readonly body: string; readonly bytes: number; readonly sha256: string; readonly rawBytes: Uint8Array<ArrayBuffer>; readonly text: string };
export type WebhookOperationKind = WebhookReceipt["kind"];
export type WebhookAdmission = { readonly userId: string; readonly onPrincipalMismatch: () => void; readonly ready?: (signal: AbortSignal) => Promise<void> };
export type WebhookListQuery = { readonly q?: string; readonly enabled?: boolean; readonly limit?: number; readonly cursor?: string };
export type WebhookSubscriptionInput = { readonly id: string | null; readonly projectId: string; readonly eventTypes: readonly WebhookEventType[] };
export type WebhookDestinationInput = { readonly kind: "http"; readonly adapterVersion: "1"; readonly configuration: { readonly url: string } };
export type WebhookConfigurationInput = { readonly name?: string; readonly enabled?: boolean; readonly destination?: WebhookDestinationInput; readonly subscriptions?: readonly WebhookSubscriptionInput[]; readonly confirmProjectIds?: readonly string[] };
export type WebhookMutationResult = {
  readonly operation: WebhookReceipt;
  readonly endpoint?: WebhookEndpoint;
  readonly delivery?: WebhookDelivery;
  readonly signing?: { readonly activeKeyId: string; readonly overlapUntil: string | null };
  readonly currentError?: ApiError;
};

// Native JSON parsing validates syntax first. We then inspect each object at its
// original source offset so duplicate keys cannot disappear during decoding.
export const decodeWebhookJson = (source: string): unknown => {
  const parsed: unknown = JSON.parse(source);
  let offset = 0;
  const space = () => { while (/\s/.test(source[offset] ?? "") && offset < source.length) offset++; };
  const quoted = (): string => {
    const start = offset++;
    while (source[offset] !== '"') { offset += source[offset] === "\\" ? 2 : 1; }
    offset++;
    const value = JSON.parse(source.slice(start, offset)) as string;
    if (!value.isWellFormed()) return malformed();
    return value;
  };
  const visit = (depth: number): void => {
    if (depth > 32) return malformed();
    space();
    const token = source[offset];
    if (token === '"') { quoted(); return; }
    if (token === "{" || token === "[") {
      const object = token === "{", end = object ? "}" : "]", keys = new Set<string>();
      offset++; space();
      while (source[offset] !== end) {
        if (object) {
          const key = quoted();
          if (keys.has(key)) return malformed();
          keys.add(key); space(); offset++;
        }
        visit(depth + 1); space();
        if (source[offset] === ",") { offset++; space(); } else break;
      }
      offset++;
      return;
    }
    while (offset < source.length && !/[\s,\]}]/.test(source[offset]!)) offset++;
  };
  visit(0);
  return parsed;
};

export const webhookBase = (owner: WebhookOwner, userId: string): string => {
  const parsed = parseWebhookOwner(owner);
  if (parsed.kind === "personal" && parsed.id !== requestId(userId)) throw new ApiError("protocol");
  return parsed.kind === "personal" ? "/api/v1/me/webhooks" : `/api/v1/teams/${parsed.id}/webhooks`;
};

const decodeResponse = async (response: Response): Promise<unknown> => {
  const media = response.headers.get("Content-Type");
  if (media === null || !/^application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i.test(media)) return malformed();
  const value = decodeWebhookJson(await response.text());
  if (!response.ok) {
    const error = fields(value, ["error"]);
    fields(error.error, ["code", "message", "requestId"]);
  }
  return value;
};
const exchange = async <T>(url: string, signal: AbortSignal, admission: WebhookAdmission, parse: (value: unknown) => T, init: RequestInit = {}, statuses: readonly number[] = [200], onDispatch?: () => void): Promise<T> => {
  const userId = requestId(admission.userId), onPrincipalMismatch = admission.onPrincipalMismatch;
  await admission.ready?.(signal);
  signal.throwIfAborted();
  const response = await request(url, signal, { ...init, headers: { Accept: "application/json", ...init.headers } }, onDispatch);
  assertResponsePrincipal(response, userId, onPrincipalMismatch);
  return json(response, signal, value => {
    if (!statuses.includes(response.status)) throw new ApiError("protocol", response.status);
    return parse(value);
  }, decodeResponse);
};

export const getWebhookCatalog = (signal: AbortSignal, admission: WebhookAdmission): Promise<WebhookCatalog> =>
  exchange("/api/v1/webhook-event-types", signal, admission, parseWebhookCatalog);

export const listWebhooks = (owner: WebhookOwner, query: WebhookListQuery, signal: AbortSignal, admission: WebhookAdmission): Promise<WebhookEndpointPage> => {
  const parameters = new URLSearchParams();
  if (query.q !== undefined) {
    if (!query.q.isWellFormed() || [...query.q].length > 200) throw new ApiError("protocol");
    if (query.q !== "") parameters.set("q", query.q);
  }
  if (query.enabled !== undefined) { if (typeof query.enabled !== "boolean") throw new ApiError("protocol"); parameters.set("enabled", String(query.enabled)); }
  if (query.limit !== undefined) { if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new ApiError("protocol"); parameters.set("limit", String(query.limit)); }
  if (query.cursor !== undefined) { if (query.cursor === "" || !query.cursor.isWellFormed()) throw new ApiError("protocol"); parameters.set("cursor", query.cursor); }
  const base = webhookBase(owner, admission.userId);
  return exchange(`${base}${parameters.size === 0 ? "" : `?${parameters}`}`, signal, admission, value => {
    const page = parseWebhookEndpointPage(value, owner);
    if (page.nextCursor !== null && page.nextCursor === query.cursor) return malformed();
    if (query.enabled !== undefined && page.items.some(item => item.enabled !== query.enabled)) return malformed();
    return page;
  });
};

export const getWebhook = (owner: WebhookOwner, endpointId: string, signal: AbortSignal, admission: WebhookAdmission): Promise<WebhookEndpoint> =>
  exchange(`${webhookBase(owner, admission.userId)}/${requestId(endpointId)}`, signal, admission, value => parseWebhookEndpoint(value, owner, requestId(endpointId)));
export const getWebhookSecret = (owner: WebhookOwner, endpointId: string, signal: AbortSignal, admission: WebhookAdmission): Promise<WebhookSecret> =>
  exchange(`${webhookBase(owner, admission.userId)}/${requestId(endpointId)}/signing-secret`, signal, admission, value => parseWebhookSecret(value, requestId(endpointId)));
export const getWebhookOperation = (owner: WebhookOwner, operationId: string, signal: AbortSignal, admission: WebhookAdmission): Promise<WebhookReceipt> =>
  exchange(`${webhookBase(owner, admission.userId)}/operations/${requestId(operationId)}`, signal, admission, value => parseWebhookReceipt(value, owner, requestId(operationId)));

const historyQuery = (query: WebhookDeliveryQuery | WebhookAttemptQuery, kind: "deliveries" | "attempts"): URLSearchParams => {
  const allowed = kind === "deliveries" ? ["eventType", "state", "projectId", "from", "to", "limit", "cursor"] : ["generation", "limit", "cursor"];
  if (Object.keys(query).some(field => !allowed.includes(field))) throw new ApiError("protocol");
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) { if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new ApiError("protocol"); parameters.set("limit", String(query.limit)); }
  if (query.cursor !== undefined) { if (query.cursor === "" || !query.cursor.isWellFormed()) throw new ApiError("protocol"); parameters.set("cursor", query.cursor); }
  if (kind === "attempts") {
    const attempts = query as WebhookAttemptQuery;
    if (attempts.generation !== undefined) parameters.set("generation", webhookVersion(attempts.generation));
  } else {
    const deliveries = query as WebhookDeliveryQuery;
    if (deliveries.eventType !== undefined) parameters.set("eventType", parseWebhookEventType(deliveries.eventType));
    if (deliveries.state !== undefined) parameters.set("state", oneOf(deliveries.state, ["pending", "leased", "delivered", "failed", "suppressed"] as const));
    if (deliveries.projectId !== undefined) parameters.set("projectId", id(deliveries.projectId));
    for (const field of ["from", "to"] as const) {
      const value = deliveries[field];
      if (value !== undefined) { if (!value.endsWith("Z") || !isWebhookIssuedAt(value)) throw new ApiError("protocol"); parameters.set(field, value); }
    }
    if (deliveries.from !== undefined && deliveries.to !== undefined && timeKey(deliveries.from) > timeKey(deliveries.to)) throw new ApiError("protocol");
  }
  return parameters;
};
const timeKey = (value: string): string => `${value.slice(0, 19)}${(value.match(/\.(\d+)Z$/)?.[1] ?? "").slice(0, 9).padEnd(9, "0")}`;
const historyPath = (owner: WebhookOwner, endpointId: string, userId: string): string => `${webhookBase(owner, userId)}/${requestId(endpointId)}/deliveries`;
const validateHistoryPage = <T extends { readonly id: string }>(page: WebhookHistoryPage<T>, cursor: string | undefined, compare: (left: T, right: T) => number): WebhookHistoryPage<T> => {
  if (new Set(page.items.map(item => item.id)).size !== page.items.length || cursor !== undefined && page.nextCursor === cursor || page.items.some((item, index) => index > 0 && compare(page.items[index - 1]!, item) >= 0)) return malformed();
  return page;
};
const lexical = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export const listWebhookDeliveries = (owner: WebhookOwner, endpointId: string, query: WebhookDeliveryQuery, signal: AbortSignal, admission: WebhookAdmission): Promise<WebhookDeliveryPage> => {
  const parameters = historyQuery(query, "deliveries"), path = historyPath(owner, endpointId, admission.userId);
  return exchange(`${path}${parameters.size === 0 ? "" : `?${parameters}`}`, signal, admission, value => validateHistoryPage(parseWebhookHistoryPage(value, item => parseWebhookDelivery(item, owner, requestId(endpointId))), query.cursor, (left, right) => lexical(timeKey(left.occurredAt), timeKey(right.occurredAt)) || lexical(left.id, right.id)));
};
export const getWebhookDelivery = (owner: WebhookOwner, endpointId: string, deliveryId: string, signal: AbortSignal, admission: WebhookAdmission): Promise<WebhookDelivery> =>
  exchange(`${historyPath(owner, endpointId, admission.userId)}/${requestId(deliveryId)}`, signal, admission, value => parseWebhookDelivery(value, owner, requestId(endpointId), requestId(deliveryId)));
export const listWebhookAttempts = (owner: WebhookOwner, endpointId: string, deliveryId: string, query: WebhookAttemptQuery, signal: AbortSignal, admission: WebhookAdmission): Promise<WebhookAttemptPage> => {
  const parameters = historyQuery(query, "attempts"), path = `${historyPath(owner, endpointId, admission.userId)}/${requestId(deliveryId)}/attempts`;
  return exchange(`${path}${parameters.size === 0 ? "" : `?${parameters}`}`, signal, admission, value => {
    const page = parseWebhookHistoryPage(value, item => parseWebhookAttempt(item, requestId(endpointId), requestId(deliveryId)));
    if (query.generation !== undefined && page.items.some(item => item.generation !== query.generation)) return malformed();
    return validateHistoryPage(page, query.cursor, (left, right) => BigInt(left.generation) < BigInt(right.generation) ? -1 : BigInt(left.generation) > BigInt(right.generation) ? 1 : left.number - right.number || lexical(left.id, right.id));
  });
};

const parsePayloadEnvelope = (value: unknown, owner: WebhookOwner, endpointId: string, deliveryId: string, eventId: string) => {
  const data = fields(value, ["owner", "endpointId", "deliveryId", "eventId", "mediaType", "encoding", "body", "bytes", "sha256"]);
  parseWebhookOwner(data.owner, owner);
  if (id(data.endpointId) !== endpointId || id(data.deliveryId) !== deliveryId || id(data.eventId) !== eventId || data.mediaType !== "application/cloudevents+json" || data.encoding !== "base64") return malformed();
  const body = string(data.body), sha256 = string(data.sha256);
  if (body.length > 87_384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body) || !/^[a-f0-9]{64}$/.test(sha256)) return malformed();
  const decoded = atob(body), rawBytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  if (btoa(decoded) !== body || rawBytes.length > 65_536 || count(data.bytes) !== rawBytes.length) return malformed();
  return { owner, endpointId, deliveryId, eventId, mediaType: "application/cloudevents+json" as const, encoding: "base64" as const, body, bytes: rawBytes.length, sha256, rawBytes };
};
const verifyPayload = async (payload: ReturnType<typeof parsePayloadEnvelope>, signal: AbortSignal): Promise<WebhookPayload> => {
  try {
    signal.throwIfAborted();
    const digest = await crypto.subtle.digest("SHA-256", payload.rawBytes);
    signal.throwIfAborted();
    const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (sha256 !== payload.sha256) return malformed();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload.rawBytes);
    return { ...payload, text };
  } catch (cause) {
    signal.throwIfAborted();
    throw new ApiError("protocol", 200, "protocol", null, undefined, cause);
  }
};
export const parseWebhookPayload = async (value: unknown, owner: WebhookOwner, endpointId: string, deliveryId: string, eventId: string, signal: AbortSignal): Promise<WebhookPayload> =>
  verifyPayload(parsePayloadEnvelope(value, owner, endpointId, deliveryId, eventId), signal);
export const getWebhookPayload = async (owner: WebhookOwner, endpointId: string, deliveryId: string, eventId: string, signal: AbortSignal, admission: WebhookAdmission): Promise<WebhookPayload> => {
  const expectedEventId = requestId(eventId);
  const path = `${historyPath(owner, endpointId, admission.userId)}/${requestId(deliveryId)}/payload`;
  const payload = await exchange(path, signal, admission, value => parsePayloadEnvelope(value, owner, requestId(endpointId), requestId(deliveryId), expectedEventId));
  return verifyPayload(payload, signal);
};

export const submitWebhookMutation = (
  owner: WebhookOwner, kind: WebhookOperationKind, endpointId: string | null, operationId: string,
  serializedBody: string, signal: AbortSignal, admission: WebhookAdmission, onReceipt: (receipt: WebhookReceipt) => void, onDispatch?: () => void,
  deliveryId: string | null = null,
): Promise<WebhookMutationResult> => {
  const base = webhookBase(owner, admission.userId);
  if (!["endpoint.create", "endpoint.patch", "endpoint.delete", "signing-secret.rotate", "delivery.redeliver"].includes(kind) || new TextEncoder().encode(serializedBody).length > 262_144) throw new ApiError("protocol");
  const create = kind === "endpoint.create", rotate = kind === "signing-secret.rotate", redeliver = kind === "delivery.redeliver";
  if (create !== (endpointId === null)) throw new ApiError("protocol");
  if (redeliver !== (deliveryId !== null)) throw new ApiError("protocol");
  const resource = create ? base : `${base}/${requestId(endpointId!)}`;
  const url = redeliver ? `${resource}/deliveries/${requestId(deliveryId!)}/redeliveries` : rotate ? `${resource}/signing-secret/rotations` : resource;
  const method = create || rotate || redeliver ? "POST" : kind === "endpoint.patch" ? "PATCH" : "DELETE";
  return exchange(url, signal, admission, value => {
    const data = fields(value, ["operation", redeliver ? "delivery" : rotate ? "signing" : "endpoint"]);
    const operation = parseWebhookReceipt(data.operation, owner, operationId);
    if (operation.kind !== kind || endpointId !== null && operation.endpointId !== endpointId || operation.deliveryId !== deliveryId) return malformed();
    onReceipt(operation);
    try {
      if (redeliver) {
        const delivery = parseWebhookDelivery(data.delivery, owner, operation.endpointId, deliveryId!);
        if (BigInt(delivery.generation) < BigInt(operation.generationAfter!) || delivery.target.destinationRevision !== operation.destinationRevisionAfter) return malformed();
        return { operation, delivery };
      }
      if (!rotate) return { operation, endpoint: parseWebhookEndpoint(data.endpoint, owner, operation.endpointId) };
      const signing = fields(data.signing, ["activeKeyId", "overlapUntil"]);
      const activeKeyId = id(signing.activeKeyId), overlapUntil = nullableTimestamp(signing.overlapUntil);
      if (activeKeyId !== operation.keyId || overlapUntil !== operation.overlapUntil) return malformed();
      return { operation, signing: { activeKeyId, overlapUntil } };
    } catch (cause) {
      return { operation, currentError: new ApiError("protocol", null, "protocol", null, undefined, cause) };
    }
  }, { method, headers: { "Content-Type": "application/json" }, body: serializedBody }, redeliver ? [202] : create ? [200, 201] : [200], onDispatch);
};
