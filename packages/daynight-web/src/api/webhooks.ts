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
export type WebhookOperationKind = WebhookReceipt["kind"];
export type WebhookAdmission = { readonly userId: string; readonly onPrincipalMismatch: () => void; readonly ready?: (signal: AbortSignal) => Promise<void> };
export type WebhookListQuery = { readonly q?: string; readonly enabled?: boolean; readonly limit?: number; readonly cursor?: string };
export type WebhookSubscriptionInput = { readonly id: string | null; readonly projectId: string; readonly eventTypes: readonly WebhookEventType[] };
export type WebhookDestinationInput = { readonly kind: "http"; readonly adapterVersion: "1"; readonly configuration: { readonly url: string } };
export type WebhookConfigurationInput = { readonly name?: string; readonly enabled?: boolean; readonly destination?: WebhookDestinationInput; readonly subscriptions?: readonly WebhookSubscriptionInput[]; readonly confirmProjectIds?: readonly string[] };
export type WebhookMutationResult = {
  readonly operation: WebhookReceipt;
  readonly endpoint?: WebhookEndpoint;
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

export const submitWebhookMutation = (
  owner: WebhookOwner, kind: Exclude<WebhookOperationKind, "delivery.redeliver">, endpointId: string | null, operationId: string,
  serializedBody: string, signal: AbortSignal, admission: WebhookAdmission, onReceipt: (receipt: WebhookReceipt) => void, onDispatch?: () => void,
): Promise<WebhookMutationResult> => {
  const base = webhookBase(owner, admission.userId);
  if (!["endpoint.create", "endpoint.patch", "endpoint.delete", "signing-secret.rotate"].includes(kind) || new TextEncoder().encode(serializedBody).length > 262_144) throw new ApiError("protocol");
  const create = kind === "endpoint.create", rotate = kind === "signing-secret.rotate";
  if (create !== (endpointId === null)) throw new ApiError("protocol");
  const resource = create ? base : `${base}/${requestId(endpointId!)}`;
  const url = rotate ? `${resource}/signing-secret/rotations` : resource;
  const method = create || rotate ? "POST" : kind === "endpoint.patch" ? "PATCH" : "DELETE";
  return exchange(url, signal, admission, value => {
    const data = fields(value, ["operation", rotate ? "signing" : "endpoint"]);
    const operation = parseWebhookReceipt(data.operation, owner, operationId);
    if (operation.kind !== kind || endpointId !== null && operation.endpointId !== endpointId) return malformed();
    onReceipt(operation);
    try {
      if (!rotate) return { operation, endpoint: parseWebhookEndpoint(data.endpoint, owner, operation.endpointId) };
      const signing = fields(data.signing, ["activeKeyId", "overlapUntil"]);
      const activeKeyId = id(signing.activeKeyId), overlapUntil = nullableTimestamp(signing.overlapUntil);
      if (activeKeyId !== operation.keyId || overlapUntil !== operation.overlapUntil) return malformed();
      return { operation, signing: { activeKeyId, overlapUntil } };
    } catch (cause) {
      return { operation, currentError: new ApiError("protocol", null, "protocol", null, undefined, cause) };
    }
  }, { method, headers: { "Content-Type": "application/json" }, body: serializedBody }, create ? [200, 201] : [200], onDispatch);
};
