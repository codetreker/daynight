import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation } from "../../src/api/index.js";
import { parseWebhookEndpoint, parseWebhookPayload, parseWebhookReceipt, parseWebhookMutation, parseWebhookSecret, parseWebhookDelivery } from "../../src/api/webhook.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const endpointId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const deliveryId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const operationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const owner = { kind: "personal" as const, id: userId };
const time = "2026-11-07T12:00:00Z";
const receipt = { operationId, kind: "endpoint.patch", issuedAt: time, requestSha256: "a".repeat(64), actorUserId: userId, owner, endpointId, effect: "applied", configVersionAfter: "9007199254740993", destinationRevisionAfter: "1", deliveryId: null, generationAfter: null, keyId: null, recordedAt: time, expiresAt: time };
const payload = Buffer.from('{"x":1}');
const envelope = { owner, endpointId, deliveryId, eventId: operationId, mediaType: "application/cloudevents+json", encoding: "base64", body: payload.toString("base64"), bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
const operations: ReturnType<typeof createOperation>[] = [];
afterEach(() => { operations.splice(0).forEach((operation) => operation.dispose()); });

describe("webhook API boundaries", () => {
  it("retains exact wire versions and rejects malformed receipts", () => {
    expect(parseWebhookReceipt(receipt, owner, operationId).configVersionAfter).toBe("9007199254740993");
    for (const patch of [{ configVersionAfter: "01" }, { configVersionAfter: "9223372036854775808" }, { kind: "endpoint.update" }, { requestSha256: "x" }, { effect: "other" }, { extra: 1 }]) expect(() => parseWebhookReceipt({ ...receipt, ...patch }, owner, operationId)).toThrow();
  });
  it("rejects malformed or noncanonical signing secrets", () => {
    const valid = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    const input = { endpointId, configVersion: "1", keyId: operationId, scheme: "standard-webhooks-v1", secret: valid };
    expect(parseWebhookSecret(input, endpointId).secret).toBe(valid);
    for (const secret of ["abc", valid.slice(0, -1), valid + "\n", `whsec_${Buffer.alloc(31).toString("base64")}`]) expect(() => parseWebhookSecret({ ...input, secret }, endpointId)).toThrow();
  });
  it("binds a rotation result to its original key receipt", () => {
    const oldKey = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const currentKey = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const response = { operation: { ...receipt, kind: "signing-secret.rotate", keyId: oldKey }, signing: { activeKeyId: oldKey, overlapUntil: null } };
    const result = parseWebhookMutation(response, owner, "signing", operationId, endpointId);
    expect(result.operation.keyId).toBe(oldKey);
    expect(() => parseWebhookMutation({ ...response, signing: { activeKeyId: currentKey, overlapUntil: null } }, owner, "signing", operationId, endpointId)).toThrow();
  });
  it("rejects inconsistent full and metadata-only disclosure", () => {
    const view = { id: deliveryId, endpointId, eventId: operationId, owner, eventType: "task.created", resource: { projectId: operationId, taskId: operationId, stepId: null, messageId: null, displayName: null }, occurredAt: time, resourceVersion: "1", target: { destinationRevision: "1", url: null, displayUrl: "https://example.test/…" }, generation: "1", state: "pending", attemptCount: 0, automaticAttemptCount: 0, manualOperationCount: 0, nextAttemptAt: null, lastAttemptAt: null, expiresAt: time, automaticExpiresAt: time, payloadExpiresAt: time, lastAcknowledgedAt: null, lastResult: null, payloadAvailable: true, disclosure: "full" };
    expect(parseWebhookDelivery(view, owner, endpointId, deliveryId).eventType).toBe("task.created");
    expect(() => parseWebhookDelivery({ ...view, eventType: null }, owner, endpointId)).toThrow();
    expect(() => parseWebhookDelivery({ ...view, lastResult: { category: "http_error", code: "HTTP", httpStatus: 999, durationMs: null } }, owner, endpointId)).toThrow();
    expect(() => parseWebhookDelivery({ ...view, disclosure: "metadata_only" }, owner, endpointId)).toThrow();
    const hidden = { ...view, disclosure: "metadata_only", eventType: null, resourceVersion: null, resource: { projectId: null, taskId: null, stepId: null, messageId: null, displayName: null }, target: { destinationRevision: "1", url: null, displayUrl: null }, payloadAvailable: false };
    expect(parseWebhookDelivery(hidden, owner, endpointId).disclosure).toBe("metadata_only");
  });
  it("preserves a tombstone without fabricating active fields", () => {
    const deleted = { id: endpointId, owner, lifecycle: "deleted", configVersion: "1", deletedAt: time };
    expect(parseWebhookEndpoint(deleted, owner, endpointId)).toEqual(deleted);
    expect(() => parseWebhookEndpoint({ ...deleted, name: "secret" }, owner, endpointId)).toThrow();
  });
  it("validates exact payload bytes and rejects forged or noncanonical wrappers", () => {
    expect(parseWebhookPayload(envelope, owner, endpointId, deliveryId)).toEqual(envelope);
    for (const patch of [{ body: envelope.body + "\n" }, { bytes: payload.length + 1 }, { sha256: "a".repeat(64) }, { mediaType: "text/html" }, { deliveryId: operationId }]) expect(() => parseWebhookPayload({ ...envelope, ...patch }, owner, endpointId, deliveryId)).toThrow();
  });
  it("checks principal on failures and protects causes containing sensitive input", async () => {
    const secret = "https://example.test/secret?token=payload";
    const operation = createOperation(); operations.push(operation);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "version_conflict", message: secret, requestId: operationId } }), { status: 409, headers: { "content-type": "application/json", "Daynight-User-ID": userId } }));
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
    let error: unknown;
    try { await api.webhookRequest({ userId, path: `/me/webhooks/${endpointId}`, method: "PATCH", body: { secret }, parse: (value) => value }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "version_conflict", confirmedRefusal: true });
    expect(inspect(error, { depth: 20, showHidden: true })).not.toContain(secret);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("preserves a matching server request ID without copying error details", async () => {
    const operation = createOperation(); operations.push(operation);
    const requestId = "FPBHGWUV6IRN3JZGF64F5W26OV";
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "payload_expired", message: "secret", requestId } }), { status: 410, headers: { "content-type": "application/json", "Daynight-User-ID": userId, "X-Request-ID": requestId } }));
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
    await expect(api.webhookRequest({ userId, path: "/me/webhooks", method: "GET", parse: (value) => value })).rejects.toMatchObject({ requestId });
  });
  it("rejects a changed principal even on an unauthorized response", async () => {
    const operation = createOperation(); operations.push(operation);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "unauthenticated", message: "denied", requestId: operationId } }), { status: 401, headers: { "content-type": "application/json", "Daynight-User-ID": operationId } }));
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
    await expect(api.webhookRequest({ userId, path: "/me/webhooks", method: "GET", parse: (value) => value })).rejects.toMatchObject({ phase: "protocol" });
  });
  it("does not treat an unauthorized response without a principal as a verified refusal", async () => {
    const operation = createOperation(); operations.push(operation);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "unauthenticated", message: "denied", requestId: operationId } }), { status: 401, headers: { "content-type": "application/json" } }));
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
    await expect(api.webhookRequest({ userId, path: "/me/webhooks", method: "PATCH", body: {}, parse: (value) => value })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
  });
  it("rejects wrong principal and duplicate JSON before accepting an operation", async () => {
    for (const [principal, body] of [[operationId, '{}'], [userId, '{"operationId":"a","operationId":"b"}']]) {
      const operation = createOperation(); operations.push(operation);
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "application/json", "Daynight-User-ID": principal! } }));
      const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
      await expect(api.webhookRequest({ userId, path: "/me/webhooks", method: "POST", body: {}, confirmedOperationId: operationId, parse: (value) => value })).rejects.toMatchObject({ outcomeUnconfirmed: true, phase: "protocol" });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
});
