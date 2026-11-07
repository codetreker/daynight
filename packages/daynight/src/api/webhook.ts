import { createHash } from "node:crypto";
import { array, bool, count, fields, id, malformed, nullableTimestamp, text, timestamp } from "./validation.js";

export type WebhookOwner = { readonly kind: "personal" | "team"; readonly id: string };
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): T => {
  const s = text(value);
  return choices.includes(s as T) ? s as T : malformed();
};
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);
const version = (value: unknown): string => {
  const s = text(value);
  if (!/^[1-9][0-9]*$/.test(s) || BigInt(s) > 9_223_372_036_854_775_807n) return malformed();
  return s;
};
const nonempty = (value: unknown): string => text(value, true);
const positive = (value: unknown): number => { const n = count(value); return n > 0 ? n : malformed(); };
const httpStatus = (value: unknown): number => { const n = count(value); return n >= 100 && n <= 599 ? n : malformed(); };
const eventType = (value: unknown) => oneOf(value, ["task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"] as const);
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
const subscription = (value: unknown) => {
  const d = fields(value, ["id", "projectId", "projectName", "eventTypes", "eligibility"]);
  const events = array(d.eventTypes, eventType);
  if (events.length === 0 || new Set(events).size !== events.length) return malformed();
  return { id: id(d.id), projectId: id(d.projectId), projectName: nullable(d.projectName, text), eventTypes: events, eligibility: oneOf(d.eligibility, ["eligible", "access_revoked", "owner_scope_changed", "resource_unavailable", "confirmation_required"] as const) };
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
    const key = eventType(e.key), wireType = nonempty(e.wireType);
    if (wireType !== `cc.daynight.${key}.v1` || e.schemaVersion !== 1 || e.resourceKind !== "project") return malformed();
    return { key, wireType, schemaVersion: 1, resourceKind: "project" as const };
  });
  if (items.length !== 6 || new Set(items.map((item) => item.key)).size !== 6) return malformed();
  const s = fields(d.service, ["configurationExpansionAvailable", "dispatchEnabled"]);
  const l = fields(d.limits, ["policyVersion", "requestBytes", "payloadBytes", "maxAutomaticAttempts", "automaticWindowSeconds", "maxManualOperations", "payloadRetentionSeconds", "operationMaxAgeSeconds", "operationFutureSkewSeconds"]);
  return { items, service: { configurationExpansionAvailable: bool(s.configurationExpansionAvailable), dispatchEnabled: bool(s.dispatchEnabled) }, limits: { policyVersion: version(l.policyVersion), requestBytes: positive(l.requestBytes), payloadBytes: positive(l.payloadBytes), maxAutomaticAttempts: count(l.maxAutomaticAttempts), automaticWindowSeconds: positive(l.automaticWindowSeconds), maxManualOperations: count(l.maxManualOperations), payloadRetentionSeconds: positive(l.payloadRetentionSeconds), operationMaxAgeSeconds: positive(l.operationMaxAgeSeconds), operationFutureSkewSeconds: count(l.operationFutureSkewSeconds) } };
};
export const parseWebhookEndpoint = (value: unknown, owner: WebhookOwner, expectedId?: string) => {
  const d = fields(value, ["id", "owner", "lifecycle", "configVersion", "deletedAt", "name", "enabled", "destinationRevision", "destination", "signing", "subscriptions", "capabilities", "createdAt", "updatedAt"]);
  const endpointId = id(d.id); if (expectedId !== undefined && endpointId !== expectedId) return malformed();
  const base = { id: endpointId, owner: parseWebhookOwner(d.owner, owner), configVersion: version(d.configVersion) };
  if (d.lifecycle === "deleted") {
    fields(value, ["id", "owner", "lifecycle", "configVersion", "deletedAt"]);
    return { ...base, lifecycle: "deleted" as const, deletedAt: timestamp(d.deletedAt) };
  }
  if (d.lifecycle !== "active" || d.deletedAt !== null) return malformed();
  const caps = fields(d.capabilities, ["manage", "readSecret", "redeliver"]);
  const subscriptions = array(d.subscriptions, subscription);
  if (new Set(subscriptions.map((s) => s.id)).size !== subscriptions.length) return malformed();
  return { ...base, lifecycle: "active" as const, name: nonempty(d.name), enabled: bool(d.enabled), destinationRevision: version(d.destinationRevision), destination: destination(d.destination), signing: signing(d.signing), subscriptions, capabilities: { manage: bool(caps.manage), readSecret: bool(caps.readSecret), redeliver: bool(caps.redeliver) }, createdAt: timestamp(d.createdAt), updatedAt: timestamp(d.updatedAt), deletedAt: null };
};
export const parseWebhookEndpointPage = (value: unknown, owner: WebhookOwner) => {
  const d = fields(value, ["items", "nextCursor"]);
  const items = array(d.items, (item) => {
    const s = fields(item, ["id", "owner", "name", "enabled", "configVersion", "destination", "projectCount", "eventTypeCount", "lastAttemptAt", "lastResult"]);
    return { id: id(s.id), owner: parseWebhookOwner(s.owner, owner), name: nonempty(s.name), enabled: bool(s.enabled), configVersion: version(s.configVersion), destination: destination(s.destination), projectCount: count(s.projectCount), eventTypeCount: count(s.eventTypeCount), lastAttemptAt: nullableTimestamp(s.lastAttemptAt), lastResult: nullable(s.lastResult, result) };
  });
  if (new Set(items.map((s) => s.id)).size !== items.length) return malformed();
  return { items, nextCursor: nullable(d.nextCursor, nonempty) };
};
export const parseWebhookReceipt = (value: unknown, owner: WebhookOwner, expectedId?: string) => {
  const d = fields(value, ["operationId", "kind", "issuedAt", "requestSha256", "actorUserId", "owner", "endpointId", "effect", "configVersionAfter", "destinationRevisionAfter", "deliveryId", "generationAfter", "keyId", "recordedAt", "expiresAt"]);
  const operationId = id(d.operationId); if (expectedId !== undefined && operationId !== expectedId) return malformed();
  const requestSha256 = text(d.requestSha256); if (!/^[a-f0-9]{64}$/.test(requestSha256)) return malformed();
  const kind = oneOf(d.kind, ["endpoint.create", "endpoint.patch", "endpoint.delete", "signing-secret.rotate", "delivery.redeliver"] as const);
  const deliveryId = nullable(d.deliveryId, id), generationAfter = nullable(d.generationAfter, version), keyId = nullable(d.keyId, id);
  if (kind === "delivery.redeliver" ? deliveryId === null || generationAfter === null : deliveryId !== null || generationAfter !== null) return malformed();
  if ((kind === "signing-secret.rotate") !== (keyId !== null)) return malformed();
  return { operationId, kind, issuedAt: timestamp(d.issuedAt), requestSha256, actorUserId: id(d.actorUserId), owner: parseWebhookOwner(d.owner, owner), endpointId: id(d.endpointId), effect: oneOf(d.effect, ["applied", "unchanged"] as const), configVersionAfter: version(d.configVersionAfter), destinationRevisionAfter: version(d.destinationRevisionAfter), deliveryId, generationAfter, keyId, recordedAt: timestamp(d.recordedAt), expiresAt: timestamp(d.expiresAt) };
};
export const parseWebhookSecret = (value: unknown, endpointId: string) => {
  const d = fields(value, ["endpointId", "configVersion", "keyId", "scheme", "secret"]);
  if (id(d.endpointId) !== endpointId) return malformed();
  const secret = nonempty(d.secret);
  if (!secret.startsWith("whsec_")) return malformed();
  const encoded = secret.slice(6), decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== encoded) return malformed();
  return { endpointId, configVersion: version(d.configVersion), keyId: id(d.keyId), scheme: oneOf(d.scheme, ["standard-webhooks-v1"] as const), secret };
};
const retention = (value: unknown) => { const d = fields(value, ["payloadRetentionSeconds", "metadataRetentionSeconds"]); return { payloadRetentionSeconds: positive(d.payloadRetentionSeconds), metadataRetentionSeconds: positive(d.metadataRetentionSeconds) }; };
export const parseWebhookDelivery = (value: unknown, owner: WebhookOwner, endpointId: string, expectedId?: string) => {
  const d = fields(value, ["id", "endpointId", "eventId", "owner", "eventType", "resource", "occurredAt", "resourceVersion", "target", "generation", "state", "attemptCount", "automaticAttemptCount", "manualOperationCount", "nextAttemptAt", "lastAttemptAt", "expiresAt", "automaticExpiresAt", "payloadExpiresAt", "lastAcknowledgedAt", "lastResult", "payloadAvailable", "disclosure"]);
  const deliveryId = id(d.id); if (id(d.endpointId) !== endpointId || (expectedId !== undefined && deliveryId !== expectedId)) return malformed();
  const r = fields(d.resource, ["projectId", "taskId", "stepId", "messageId", "displayName"]), t = fields(d.target, ["destinationRevision", "url", "displayUrl"]);
  const step = nullable(r.stepId, text); if (step !== null && !/^[0-9a-f]{8}$/.test(step)) return malformed();
  if (d.disclosure === "metadata_only" && (d.eventType !== null || d.resourceVersion !== null || Object.values(r).some((item) => item !== null) || t.url !== null || t.displayUrl !== null || d.payloadAvailable !== false)) return malformed();
  if (d.disclosure === "full" && (d.eventType === null || r.projectId === null || r.taskId === null || t.displayUrl === null)) return malformed();
  return { id: deliveryId, endpointId, eventId: id(d.eventId), owner: parseWebhookOwner(d.owner, owner), eventType: nullable(d.eventType, eventType), resource: { projectId: nullable(r.projectId, id), taskId: nullable(r.taskId, id), stepId: step, messageId: nullable(r.messageId, id), displayName: nullable(r.displayName, text) }, occurredAt: timestamp(d.occurredAt), resourceVersion: nullable(d.resourceVersion, version), target: { destinationRevision: version(t.destinationRevision), url: nullable(t.url, nonempty), displayUrl: nullable(t.displayUrl, nonempty) }, generation: version(d.generation), state: oneOf(d.state, ["pending", "leased", "delivered", "failed", "suppressed"] as const), attemptCount: count(d.attemptCount), automaticAttemptCount: count(d.automaticAttemptCount), manualOperationCount: count(d.manualOperationCount), nextAttemptAt: nullableTimestamp(d.nextAttemptAt), lastAttemptAt: nullableTimestamp(d.lastAttemptAt), expiresAt: timestamp(d.expiresAt), automaticExpiresAt: timestamp(d.automaticExpiresAt), payloadExpiresAt: timestamp(d.payloadExpiresAt), lastAcknowledgedAt: nullableTimestamp(d.lastAcknowledgedAt), lastResult: nullable(d.lastResult, result), payloadAvailable: bool(d.payloadAvailable), disclosure: oneOf(d.disclosure, ["full", "metadata_only"] as const) };
};
export const parseWebhookAttempt = (value: unknown, endpointId: string, deliveryId: string) => {
  const d = fields(value, ["id", "endpointId", "deliveryId", "generation", "number", "claimedAt", "admittedAt", "dispatchedAt", "finishedAt", "outcome", "httpStatus", "durationMs", "error", "recoveredUnknownAt", "lateResult"]);
  if (id(d.endpointId) !== endpointId || id(d.deliveryId) !== deliveryId) return malformed();
  const error = nullable(d.error, (v) => { const e = fields(v, ["category", "code", "message"]); return { category: outcome(e.category), code: nonempty(e.code), message: text(e.message) }; });
  const lateResult = nullable(d.lateResult, (v) => { const e = fields(v, ["observedAt", "outcome", "httpStatus", "durationMs", "error"]); return { observedAt: timestamp(e.observedAt), outcome: outcome(e.outcome), httpStatus: nullable(e.httpStatus, httpStatus), durationMs: nullable(e.durationMs, count), error: nullable(e.error, nonempty) }; });
  return { id: id(d.id), endpointId, deliveryId, generation: version(d.generation), number: positive(d.number), claimedAt: timestamp(d.claimedAt), admittedAt: nullableTimestamp(d.admittedAt), dispatchedAt: nullableTimestamp(d.dispatchedAt), finishedAt: nullableTimestamp(d.finishedAt), outcome: nullable(d.outcome, outcome), httpStatus: nullable(d.httpStatus, httpStatus), durationMs: nullable(d.durationMs, count), error, recoveredUnknownAt: nullableTimestamp(d.recoveredUnknownAt), lateResult };
};
export const parseWebhookHistoryPage = <T>(value: unknown, parse: (value: unknown) => T) => {
  const d = fields(value, ["items", "nextCursor", "historyMayBeIncomplete", "retention"]);
  if (d.historyMayBeIncomplete !== true) return malformed();
  return { items: array(d.items, parse), nextCursor: nullable(d.nextCursor, nonempty), historyMayBeIncomplete: true as const, retention: retention(d.retention) };
};
export const parseWebhookPayload = (value: unknown, owner: WebhookOwner, endpointId: string, deliveryId: string) => {
  const d = fields(value, ["owner", "endpointId", "deliveryId", "eventId", "mediaType", "encoding", "body", "bytes", "sha256"]);
  parseWebhookOwner(d.owner, owner); if (id(d.endpointId) !== endpointId || id(d.deliveryId) !== deliveryId || d.mediaType !== "application/cloudevents+json" || d.encoding !== "base64") return malformed();
  const body = text(d.body); if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) return malformed();
  const bytes = Buffer.from(body, "base64"), hash = text(d.sha256);
  if (bytes.toString("base64") !== body || bytes.length > 65_536 || count(d.bytes) !== bytes.length || !/^[a-f0-9]{64}$/.test(hash) || createHash("sha256").update(bytes).digest("hex") !== hash) return malformed();
  return { owner, endpointId, deliveryId, eventId: id(d.eventId), mediaType: "application/cloudevents+json" as const, encoding: "base64" as const, body, bytes: bytes.length, sha256: hash };
};
export const parseWebhookMutation = (value: unknown, owner: WebhookOwner, kind: "endpoint" | "signing" | "delivery", expectedOperationId: string, endpointId?: string, deliveryId?: string) => {
  const d = fields(value, ["operation", kind]);
  const operation = parseWebhookReceipt(d.operation, owner, expectedOperationId);
  if (endpointId !== undefined && operation.endpointId !== endpointId || deliveryId !== undefined && operation.deliveryId !== deliveryId) return malformed();
  if (kind === "endpoint") return { operation, endpoint: parseWebhookEndpoint(d.endpoint, owner, operation.endpointId) };
  if (kind === "delivery") return { operation, delivery: parseWebhookDelivery(d.delivery, owner, operation.endpointId, operation.deliveryId ?? undefined) };
  const s = fields(d.signing, ["activeKeyId", "overlapUntil"]);
  const activeKeyId = id(s.activeKeyId); if (operation.keyId !== activeKeyId) return malformed();
  return { operation, signing: { activeKeyId, overlapUntil: nullableTimestamp(s.overlapUntil) } };
};
