import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookIntentController, assertWebhookReceiptMatches, clearWebhookPending, parseWebhookPreparedMetadata, type WebhookIntentInput, type WebhookPreparedMetadata } from "../src/features/webhook-intents/controller";
import type { WebhookReceipt } from "../src/api/webhooks";
import { pauseAuthRequests } from "../src/api/client";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const user = uuid(1), endpointId = uuid(2), owner = { kind: "personal" as const, id: user }, serviceOrigin = "https://daynight.example";
const now = "2026-11-08T12:00:00Z", expiresAt = "2026-12-08T12:00:00Z";
const admission = () => ({ userId: user, onPrincipalMismatch: vi.fn() });
const controller = (signal = new AbortController().signal, storage: Storage = sessionStorage) => new WebhookIntentController({ serviceOrigin, owner, admission: admission(), signal, storage });
const patch = () => ({ kind: "endpoint.patch" as const, endpointId, ifVersion: "9007199254740993", destinationRevision: "1", body: { name: "Release 通知", enabled: false } });
const metadata = (): WebhookPreparedMetadata => ({ serviceOrigin, actorUserId: user, owner, operationId: uuid(3), issuedAt: now, requestSha256: "a".repeat(64), kind: "endpoint.patch", endpointId, deliveryId: null, ifVersion: "9007199254740993", ifGeneration: null, destinationRevision: "1" });
const receipt = (prepared = metadata()): WebhookReceipt => ({ operationId: prepared.operationId, kind: prepared.kind, issuedAt: prepared.issuedAt, requestSha256: prepared.requestSha256, actorUserId: prepared.actorUserId, owner: prepared.owner, endpointId: prepared.endpointId ?? endpointId, effect: "applied", configVersionAfter: prepared.ifVersion === null ? "1" : String(BigInt(prepared.ifVersion) + 1n), destinationRevisionAfter: prepared.destinationRevision ?? "1", deliveryId: null, generationAfter: null, keyId: prepared.kind === "signing-secret.rotate" ? uuid(4) : null, overlapUntil: null, recordedAt: now, expiresAt });
const endpoint = (version = "9007199254740994") => ({ id: endpointId, owner, lifecycle: "active", configVersion: version, deletedAt: null, name: "Release 通知", enabled: false, destinationRevision: "1", destination: { kind: "http", adapterVersion: "1", url: "https://receiver.example/path?token=private", displayUrl: "https://receiver.example/path?token=private" }, signing: { scheme: "standard-webhooks-v1", activeKeyId: uuid(4), overlapUntil: null }, subscriptions: [], capabilities: { manage: true, readSecret: true, redeliver: true }, createdAt: now, updatedAt: now });
const response = (value: unknown, status = 200, principal: string | null = user) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) } });
const failure = (status = 404, code = "not_found") => response({ error: { code, message: "Failed.", requestId: "intent-test" } }, status);
const hashBody = async (body: string) => [...new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map(value => value.toString(16).padStart(2, "0")).join("");
const submittedReceipt = async (options: RequestInit, mutation: Partial<WebhookReceipt> = {}): Promise<WebhookReceipt> => {
  const body = JSON.parse(String(options.body)) as { operationId: string; issuedAt: string; expectedUserId: string; ifVersion?: string };
  return { ...receipt(), operationId: body.operationId, issuedAt: body.issuedAt, requestSha256: await hashBody(String(options.body)), actorUserId: body.expectedUserId, configVersionAfter: body.ifVersion === undefined ? "1" : String(BigInt(body.ifVersion) + 1n), ...mutation };
};
const deliveryId = uuid(10);
const redeliveryInput = (): Extract<WebhookIntentInput, { kind: "delivery.redeliver" }> => ({ kind: "delivery.redeliver", endpointId, deliveryId, ifVersion: "9007199254740993", ifGeneration: "9007199254740993", destinationRevision: "1", body: {} });
const submittedRedeliveryReceipt = async (options: RequestInit, changed: Partial<WebhookReceipt> = {}): Promise<WebhookReceipt> => {
  const body = JSON.parse(String(options.body)) as { ifVersion: string; ifGeneration: string };
  return submittedReceipt(options, { kind: "delivery.redeliver", deliveryId, generationAfter: String(BigInt(body.ifGeneration) + 1n), configVersionAfter: body.ifVersion, ...changed });
};
const currentDelivery = (generation = "9007199254740994") => ({
  id: deliveryId, endpointId, eventId: uuid(11), owner, eventType: "task.paused", resource: { projectId: uuid(12), taskId: uuid(13), stepId: null, messageId: null, displayName: "Private task" }, occurredAt: now, resourceVersion: "9007199254740993",
  target: { destinationRevision: "1", url: "https://receiver.example/original?token=private", displayUrl: "https://receiver.example/original?token=private" }, generation, state: "pending", attemptCount: 2, automaticAttemptCount: 1, manualOperationCount: 1,
  nextAttemptAt: now, lastAttemptAt: now, expiresAt: "2026-11-15T12:00:00Z", automaticExpiresAt: "2026-11-11T12:00:00Z", payloadExpiresAt: "2026-12-08T12:00:00Z", lastAcknowledgedAt: now, lastResult: null, payloadAvailable: true, disclosure: "full",
});

beforeEach(() => { sessionStorage.clear(); vi.stubGlobal("crypto", webcrypto); });
afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); });

describe("Webhook receipt identity", () => {
  it("checks exact original scope, request hash, time, target and int64 version", () => {
    expect(() => assertWebhookReceiptMatches(receipt(), metadata())).not.toThrow();
    const variants: Partial<WebhookReceipt>[] = [{ operationId: uuid(9) }, { kind: "endpoint.delete" }, { actorUserId: uuid(9) }, { owner: { kind: "team", id: uuid(9) } }, { endpointId: uuid(9) }, { issuedAt: "2026-11-08T12:00:00.000Z" }, { requestSha256: "b".repeat(64) }, { configVersionAfter: "9007199254740993" }, { destinationRevisionAfter: "3" }];
    variants.forEach(value => expect(() => assertWebhookReceiptMatches({ ...receipt(), ...value }, metadata())).toThrow());
  });
  it("supports unchanged patch effects but never treats a same-value old version as success", () => {
    expect(() => assertWebhookReceiptMatches({ ...receipt(), effect: "unchanged", configVersionAfter: "9007199254740993" }, metadata())).not.toThrow();
    expect(() => assertWebhookReceiptMatches({ ...receipt(), effect: "unchanged", configVersionAfter: "9007199254740994" }, metadata())).toThrow();
  });
  it("requires initial version one and applied effects for creation", () => {
    const prepared = { ...metadata(), kind: "endpoint.create" as const, endpointId: null, ifVersion: null, destinationRevision: null };
    expect(() => assertWebhookReceiptMatches(receipt(prepared), prepared)).not.toThrow();
    expect(() => assertWebhookReceiptMatches({ ...receipt(prepared), configVersionAfter: "2" }, prepared)).toThrow();
    expect(() => assertWebhookReceiptMatches({ ...receipt(prepared), effect: "unchanged" }, prepared)).toThrow();
  });
  it("requires original delivery generation and constant config for future redelivery consumers", () => {
    const prepared = { ...metadata(), kind: "delivery.redeliver" as const, deliveryId: uuid(10), ifGeneration: "9007199254740993" };
    const correct = { ...receipt(prepared), configVersionAfter: prepared.ifVersion!, deliveryId: prepared.deliveryId, generationAfter: "9007199254740994" };
    expect(() => assertWebhookReceiptMatches(correct, prepared)).not.toThrow();
    expect(() => assertWebhookReceiptMatches({ ...correct, generationAfter: "9007199254740993" }, prepared)).toThrow();
  });
  it("rejects private or malformed persistent metadata without defaults", () => {
    expect(parseWebhookPreparedMetadata(metadata())).toEqual(metadata());
    for (const value of [{ ...metadata(), body: "private" }, { ...metadata(), endpointId: null }, { ...metadata(), ifVersion: "01" }, { ...metadata(), serviceOrigin: `${serviceOrigin}/` }, { ...metadata(), owner: { kind: "personal", id: uuid(9) } }]) expect(() => parseWebhookPreparedMetadata(value)).toThrow();
  });
});

describe("Webhook fixed intent controller", () => {
  it("generates identity only at first submission and hashes exactly the final UTF-8 bytes", async () => {
    const intent = controller(); expect(intent.getSnapshot().prepared).toBeNull(); expect(sessionStorage.length).toBe(0);
    const fetch = vi.fn(async (_url: string, options: RequestInit) => response({ operation: await submittedReceipt(options), endpoint: endpoint() })); vi.stubGlobal("fetch", fetch);
    const result = await intent.submit(patch());
    expect(result.phase).toBe("confirmed");
    const body = String(fetch.mock.calls[0]![1].body), parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ name: "Release 通知", enabled: false, ifVersion: "9007199254740993", expectedUserId: user });
    expect(result.prepared?.requestSha256).toBe(await hashBody(body)); expect(result.result?.operation.operationId).toBe(parsed.operationId);
    expect(sessionStorage.length).toBe(0);
  });
  it("shares one in-flight promise across button and Enter submissions", async () => {
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn(async (_url: string, options: RequestInit) => { await barrier; return response({ operation: await submittedReceipt(options), endpoint: endpoint() }); }); vi.stubGlobal("fetch", fetch);
    const intent = controller(), first = intent.submit(patch()), second = intent.submit({ ...patch(), body: { name: "Changed" } });
    expect(first).toBe(second); release(); await first; expect(fetch).toHaveBeenCalledOnce();
  });
  it("shares the same intent with a reentrant subscriber at initial preparation", async () => {
    const fetch = vi.fn(async (_url: string, options: RequestInit) => response({ operation: await submittedReceipt(options), endpoint: endpoint() })); vi.stubGlobal("fetch", fetch);
    const intent = controller(); let repeated: Promise<unknown> | undefined;
    intent.subscribe(() => { if (intent.getSnapshot().phase === "preparing") repeated = intent.submit({ ...patch(), body: { name: "Second event" } }); });
    const first = intent.submit(patch()); expect(repeated).toBe(first); await first; expect(fetch).toHaveBeenCalledOnce();
  });
  it("refuses a new decision while a confirmed operation lookup is pending instead of returning its old result", async () => {
    const generated = vi.spyOn(crypto, "randomUUID");
    let original!: WebhookReceipt, entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "PATCH") { const operation = await submittedReceipt(options); original = operation; return response({ operation, endpoint: endpoint(operation.configVersionAfter) }); }
      entered(); await barrier; return response(original);
    }); vi.stubGlobal("fetch", fetch);
    const intent = controller(), first = await intent.submit(patch()), secondInput = { ...patch(), ifVersion: "9007199254740994", body: { name: "Explicit second decision" } };
    const lookup = intent.reconcile();
    expect(() => intent.submit(secondInput)).toThrow(/operation is being checked/);
    await waiting;
    expect(() => intent.submit(secondInput)).toThrow(/operation is being checked/);
    expect(intent.getSnapshot().prepared?.operationId).toBe(first.prepared?.operationId); expect(fetch.mock.calls.filter(call => call[1].method === "PATCH")).toHaveLength(1);
    expect(generated).toHaveBeenCalledOnce();
    release(); await lookup;
    const second = await intent.submit(secondInput);
    expect(second.phase).toBe("confirmed"); expect(second.prepared?.operationId).not.toBe(first.prepared?.operationId);
    expect(second.result?.operation.operationId).toBe(second.prepared?.operationId); expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["PATCH", undefined, "PATCH"]);
    expect(generated).toHaveBeenCalledTimes(2);
  });
  it("blocks a new decision during unknown receipt lookup without returning the old lookup promise", async () => {
    let entered!: () => void, release!: () => void, lookups = 0;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "PATCH") throw new TypeError("Response lost");
      if (++lookups > 1) { entered(); await barrier; }
      return failure();
    }); vi.stubGlobal("fetch", fetch);
    const intent = controller(), unknown = await intent.submit(patch()), lookup = intent.reconcile();
    expect(() => intent.submit({ ...patch(), body: { name: "Blocked second decision" } })).toThrow(/operation is being checked/);
    await waiting; expect(intent.getSnapshot().prepared?.operationId).toBe(unknown.prepared?.operationId); release();
    expect((await lookup).phase).toBe("unknown"); expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["PATCH", undefined, undefined]);
  });
  it("blocks a new decision during automatic unknown reconciliation while retaining the original intent", async () => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "PATCH") throw new TypeError("Response lost");
      entered(); await barrier; return failure();
    }); vi.stubGlobal("fetch", fetch);
    const intent = controller(), pending = intent.submit(patch()); await waiting; const operationId = intent.getSnapshot().prepared!.operationId;
    expect(() => intent.submit({ ...patch(), body: { name: "Blocked second decision" } })).toThrow(/operation is being checked/);
    release(); const unknown = await pending; expect(unknown.phase).toBe("unknown"); expect(unknown.prepared?.operationId).toBe(operationId); expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["PATCH", undefined]);
  });
  it("freezes form values before awaiting the browser digest", async () => {
    const input = { ...patch(), body: { name: "Original", enabled: false } };
    const fetch = vi.fn(async (_url: string, options: RequestInit) => response({ operation: await submittedReceipt(options), endpoint: endpoint() })); vi.stubGlobal("fetch", fetch);
    const pending = controller().submit(input); input.body.name = "Changed"; await pending;
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body)).name).toBe("Original");
  });
  it("preserves explicit false, empty subscription arrays and omitted patch fields", async () => {
    const fetch = vi.fn(async (_url: string, options: RequestInit) => response({ operation: await submittedReceipt(options), endpoint: endpoint() })); vi.stubGlobal("fetch", fetch);
    await controller().submit({ ...patch(), body: { enabled: false, subscriptions: [] } });
    const value = JSON.parse(String(fetch.mock.calls[0]![1].body)); expect(value.enabled).toBe(false); expect(value.subscriptions).toEqual([]); expect(value).not.toHaveProperty("name"); expect(value).not.toHaveProperty("destination");
  });
  it("uses GET-only automatic reconciliation after a lost mutation response", async () => {
    let operation!: WebhookReceipt;
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "PATCH") { operation = await submittedReceipt(options); throw new TypeError("Response lost"); }
      return response(operation);
    }); vi.stubGlobal("fetch", fetch);
    const result = await controller().submit(patch()); expect(result.phase).toBe("confirmed");
    expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["PATCH", undefined]); expect(fetch.mock.calls[1]![0]).toContain(`/operations/${operation.operationId}`);
  });
  it.each([failure(404), failure(401, "unauthenticated"), failure(403, "forbidden"), failure(410, "operation_expired"), failure(503, "dependency_unavailable")])("keeps unknown outcomes unresolved after failed GET lookup %#", async lookup => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Response lost")).mockResolvedValue(lookup); vi.stubGlobal("fetch", fetch);
    const intent = controller(), result = await intent.submit(patch()); expect(result.phase).toBe("unknown"); expect(result.prepared?.operationId).toBeTruthy(); expect(sessionStorage.length).toBe(1);
    await intent.submit({ ...patch(), body: { name: "New intent" } }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([409, 400, 403, 413])("preserves definitive refusal %i without reads or auto writes", async status => {
    const fetch = vi.fn().mockResolvedValue(failure(status, status === 409 ? "version_conflict" : "invalid_input")); vi.stubGlobal("fetch", fetch);
    const result = await controller().submit(patch()); expect(result.phase).toBe("rejected"); expect(fetch).toHaveBeenCalledOnce(); expect(sessionStorage.length).toBe(0);
  });
  it("treats a mismatched success receipt as unknown and never confirms current field equality", async () => {
    const fetch = vi.fn(async (_url: string, options: RequestInit) => options.method === "PATCH" ? response({ operation: await submittedReceipt(options, { requestSha256: "0".repeat(64) }), endpoint: endpoint() }) : failure()); vi.stubGlobal("fetch", fetch);
    const result = await controller().submit(patch()); expect(result.phase).toBe("unknown"); expect(result.result).toBeNull(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("stores only opaque identity metadata and restores without the original body", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Lost")).mockResolvedValue(failure()); vi.stubGlobal("fetch", fetch);
    const first = controller(); const input: WebhookIntentInput = { ...patch(), body: { name: "Private name", destination: { kind: "http", adapterVersion: "1", configuration: { url: "https://receiver.example/path?token=private" } } } };
    await first.submit(input);
    const saved = sessionStorage.getItem(sessionStorage.key(0)!)!; expect(saved).not.toMatch(/Private name|receiver|token|secret|payload|body/);
    first.dispose(); const restored = controller(); expect(restored.getSnapshot().phase).toBe("unknown"); expect(restored.getSnapshot().prepared).toEqual(first.getSnapshot().prepared);
    await restored.reconcile(); expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(["PATCH", undefined, undefined]);
  });
  it("isolates pending state across service, actor and owner", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("Lost")).mockResolvedValue(failure()));
    const first = controller(); await first.submit(patch());
    for (const options of [{ serviceOrigin: "https://another.example", owner, admission: admission() }, { serviceOrigin, owner: { kind: "team" as const, id: uuid(9) }, admission: admission() }, { serviceOrigin, owner: { kind: "personal" as const, id: uuid(9) }, admission: { userId: uuid(9), onPrincipalMismatch: vi.fn() } }]) {
      expect(new WebhookIntentController({ ...options, signal: new AbortController().signal, storage: sessionStorage }).getSnapshot().phase).toBe("idle");
    }
    expect(clearWebhookPending(serviceOrigin, user)).toBeNull(); expect(sessionStorage.length).toBe(0);
  });
  it("retains document-local reconciliation when sessionStorage writes fail", async () => {
    const storage = { getItem: () => null, setItem: () => { throw new DOMException("Storage denied", "SecurityError"); }, removeItem: () => {}, length: 0, key: () => null, clear: () => {} } as Storage;
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Lost")).mockResolvedValue(failure()); vi.stubGlobal("fetch", fetch);
    const result = await controller(new AbortController().signal, storage).submit(patch()); expect(result.phase).toBe("unknown"); expect(result.persistenceError).toBeInstanceOf(DOMException); expect(result.prepared?.operationId).toBeTruthy();
  });
  it.each(["getter", "getItem"] as const)("supports the first document-local intent and GET recovery after denied pending %s access", async failurePoint => {
    const denied = new DOMException("Storage access denied", "SecurityError");
    let intent: WebhookIntentController;
    if (failurePoint === "getter") {
      const getter = vi.spyOn(globalThis, "sessionStorage", "get").mockImplementation(() => { throw denied; });
      try { intent = new WebhookIntentController({ serviceOrigin, owner, admission: admission(), signal: new AbortController().signal }); }
      finally { getter.mockRestore(); }
    } else {
      const storage = { getItem: () => { throw denied; }, setItem: () => { throw denied; }, removeItem: () => { throw denied; }, length: 0, key: () => null, clear: () => {} } as Storage;
      intent = controller(new AbortController().signal, storage);
    }
    expect(intent!.getSnapshot()).toMatchObject({ phase: "idle", prepared: null, error: null, persistenceError: denied });
    let operation!: WebhookReceipt, lookups = 0;
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "PATCH") { operation = await submittedReceipt(options); throw new TypeError("Response lost"); }
      return ++lookups === 1 ? failure() : response(operation);
    }); vi.stubGlobal("fetch", fetch);
    expect(fetch).not.toHaveBeenCalled();
    const unknown = await intent!.submit(patch());
    expect(unknown.phase).toBe("unknown"); expect(unknown.prepared?.operationId).toBe(operation.operationId); expect(unknown.persistenceError).toBe(denied);
    const confirmed = await intent!.reconcile();
    expect(confirmed.phase).toBe("confirmed"); expect(confirmed.result?.operation.operationId).toBe(operation.operationId); expect(confirmed.persistenceError).toBe(denied);
    expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["PATCH", undefined, undefined]);
    expect(sessionStorage.length).toBe(0);
  });
  it("exposes an invalid readable saved record without treating it as a known pending operation", async () => {
    const key = `daynight.webhook.pending:${encodeURIComponent(serviceOrigin)}:${user}:personal:${user}`, saved = '{"operationId":"invalid"}';
    sessionStorage.setItem(key, saved);
    const intent = controller();
    expect(intent.getSnapshot()).toMatchObject({ phase: "idle", prepared: null, error: null }); expect(intent.getSnapshot().persistenceError).toBeTruthy();
    expect(sessionStorage.getItem(key)).toBe(saved);
    const fetch = vi.fn(async (_url: string, options: RequestInit) => response({ operation: await submittedReceipt(options), endpoint: endpoint() })); vi.stubGlobal("fetch", fetch);
    expect(fetch).not.toHaveBeenCalled();
    const result = await intent.submit(patch()); expect(result.phase).toBe("confirmed"); expect(result.persistenceError).toBeTruthy(); expect(fetch).toHaveBeenCalledOnce();
  });
  it("preserves confirmed history when the sibling projection or later current receipt read fails", async () => {
    const fetch = vi.fn(async (_url: string, options: RequestInit) => options.method === "PATCH" ? response({ operation: await submittedReceipt(options), endpoint: { ...endpoint(), configVersion: 1 } }) : failure(403, "forbidden")); vi.stubGlobal("fetch", fetch);
    const intent = controller(); const first = await intent.submit(patch()); expect(first.phase).toBe("confirmed"); expect(first.error).toMatchObject({ kind: "protocol" }); expect(first.result?.operation).toBeTruthy();
    const later = await intent.reconcile(); expect(later.phase).toBe("confirmed"); expect(later.result?.operation).toEqual(first.result?.operation); expect(later.error).toMatchObject({ status: 403 });
  });
  it("allows a later current endpoint version to differ from the historical effect", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => response({ operation: await submittedReceipt(options), endpoint: endpoint("9007199254740999") })));
    const result = await controller().submit(patch()); expect(result.phase).toBe("confirmed"); expect(result.result?.operation.configVersionAfter).toBe("9007199254740994"); expect(result.result?.endpoint?.configVersion).toBe("9007199254740999");
  });
  it("stops publication and automatic lookup when the lifetime is canceled after dispatch", async () => {
    const lifetime = new AbortController(); let entered!: () => void, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), dispatched = new Promise<void>(resolve => { entered = resolve; });
    const fetch = vi.fn(async (_url: string, options: RequestInit) => { entered(); await barrier; return response({ operation: await submittedReceipt(options), endpoint: endpoint() }); }); vi.stubGlobal("fetch", fetch);
    const intent = controller(lifetime.signal), listener = vi.fn(); intent.subscribe(listener); const pending = intent.submit(patch()); await dispatched; listener.mockClear(); lifetime.abort(); release(); const result = await pending;
    expect(result.phase).toBe("unknown"); expect(listener).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce(); expect(sessionStorage.length).toBe(1);
  });
  it("gates new writes by the current catalog while retaining independent recovery reads", async () => {
    let available = true;
    const intent = new WebhookIntentController({ serviceOrigin, owner, admission: admission(), signal: new AbortController().signal, storage: sessionStorage, canSubmit: () => available });
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Lost")).mockResolvedValue(failure()); vi.stubGlobal("fetch", fetch);
    await intent.submit(patch()); available = false;
    await intent.reconcile(); expect(fetch.mock.calls.map(call => call[1]?.method)).toEqual(["PATCH", undefined, undefined]);
    await intent.submit(patch()); expect(fetch).toHaveBeenCalledTimes(3);
    const blocked = new WebhookIntentController({ serviceOrigin, owner: { kind: "team", id: uuid(9) }, admission: admission(), signal: new AbortController().signal, storage: sessionStorage, canSubmit: () => available });
    expect(() => blocked.submit(patch())).toThrow(); expect(blocked.getSnapshot().prepared).toBeNull();
  });
  it("rechecks the catalog after identity admission changes during preparation", async () => {
    let available = true, release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
    const intent = new WebhookIntentController({ serviceOrigin, owner, admission: { ...admission(), ready: async () => { entered(); await barrier; } }, signal: new AbortController().signal, storage: sessionStorage, canSubmit: () => available });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const pending = intent.submit(patch()); await waiting; available = false; release(); const result = await pending;
    expect(result.phase).toBe("rejected"); expect(fetch).not.toHaveBeenCalled(); expect(sessionStorage.length).toBe(0);
  });
  it("rechecks the catalog immediately before fetch after an authentication pause", async () => {
    let available = true, entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    const intent = new WebhookIntentController({ serviceOrigin, owner, admission: admission(), signal: new AbortController().signal, storage: sessionStorage, canSubmit: () => available });
    intent.subscribe(() => { if (intent.getSnapshot().phase === "submitting") entered(); });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const release = pauseAuthRequests();
    const pending = intent.submit(patch()); await waiting; await Promise.resolve(); available = false; release();
    expect((await pending).phase).toBe("rejected"); expect(fetch).not.toHaveBeenCalled(); expect(sessionStorage.length).toBe(0);
  });
  it("does not erase another controller's later pending record while clearing its own receipt", async () => {
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
    const fetch = vi.fn(async (_url: string, options: RequestInit) => { entered(); await barrier; return response({ operation: await submittedReceipt(options), endpoint: endpoint() }); }); vi.stubGlobal("fetch", fetch);
    const intent = controller(), pending = intent.submit(patch()); await waiting;
    const storageKey = sessionStorage.key(0)!; sessionStorage.setItem(storageKey, JSON.stringify({ ...metadata(), operationId: uuid(99) }));
    release(); await pending;
    expect(JSON.parse(sessionStorage.getItem(storageKey)!).operationId).toBe(uuid(99));
  });
  it("removes the private current projection when disposing a confirmed controller", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => response({ operation: await submittedReceipt(options), endpoint: endpoint() })));
    const intent = controller(); await intent.submit(patch()); expect(intent.getSnapshot().result?.endpoint).toBeTruthy();
    intent.dispose(); expect(intent.getSnapshot().result?.endpoint).toBeUndefined(); expect(intent.getSnapshot().result?.operation).toBeTruthy();
  });
  it("forgets a confirmed current endpoint without losing its historical receipt or issuing writes", async () => {
    const fetch = vi.fn(async (_url: string, options: RequestInit) => response({ operation: await submittedReceipt(options), endpoint: endpoint() })); vi.stubGlobal("fetch", fetch);
    const intent = controller(), confirmed = await intent.submit(patch()), listener = vi.fn(); intent.subscribe(listener);
    intent.forgetCurrentProjection();
    expect(intent.getSnapshot()).toMatchObject({ phase: "confirmed", prepared: confirmed.prepared, error: confirmed.error, result: { operation: confirmed.result!.operation } });
    expect(intent.getSnapshot().result?.endpoint).toBeUndefined(); expect(listener).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
    const cleared = intent.getSnapshot(); intent.forgetCurrentProjection();
    expect(intent.getSnapshot()).toBe(cleared); expect(listener).toHaveBeenCalledOnce();
  });
  it("retains the original rotation key and deadline when forgetting current projections", async () => {
    const overlapUntil = "2026-11-09T12:00:00Z";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      const operation = await submittedReceipt(options, { kind: "signing-secret.rotate", keyId: uuid(4), overlapUntil });
      return response({ operation, signing: { activeKeyId: operation.keyId, overlapUntil } });
    }));
    const intent = controller(); await intent.submit({ ...patch(), kind: "signing-secret.rotate", body: { mode: "overlap" } });
    const confirmed = intent.getSnapshot(), listener = vi.fn(); intent.subscribe(listener); intent.forgetCurrentProjection();
    expect(intent.getSnapshot()).toBe(confirmed); expect(intent.getSnapshot().result?.operation).toMatchObject({ keyId: uuid(4), overlapUntil }); expect(listener).not.toHaveBeenCalled();
  });
  it.each([
    { keyId: uuid(99) },
    { overlapUntil: "2026-11-09T13:00:00Z" },
    { recordedAt: "2026-11-08T12:00:01Z" },
    { expiresAt: "2026-12-09T12:00:00Z" },
  ])("retains the first confirmed rotation receipt when a later GET contradicts immutable facts %j", async changed => {
    let original!: WebhookReceipt;
    const overlapUntil = "2026-11-09T12:00:00Z";
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "POST") {
        original = await submittedReceipt(options, { kind: "signing-secret.rotate", keyId: uuid(4), overlapUntil });
        return response({ operation: original, signing: { activeKeyId: original.keyId, overlapUntil } });
      }
      return response({ ...original, ...changed });
    }); vi.stubGlobal("fetch", fetch);
    const intent = controller(), first = await intent.submit({ ...patch(), kind: "signing-secret.rotate", body: { mode: "overlap" } });
    intent.forgetCurrentProjection(); const later = await intent.reconcile();
    expect(later.phase).toBe("confirmed"); expect(later.error).toMatchObject({ kind: "protocol" }); expect(later.result?.operation).toBe(first.result?.operation);
    expect(later.result?.operation).toMatchObject({ keyId: uuid(4), overlapUntil }); expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["POST", undefined]);
  });
  it.each([
    { effect: "unchanged", configVersionAfter: "9007199254740993" },
    { destinationRevisionAfter: "2" },
  ] as const)("retains the first patch outcome when a different prepared-compatible outcome is observed %j", async changed => {
    let original!: WebhookReceipt;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "PATCH") { original = await submittedReceipt(options); return response({ operation: original, endpoint: endpoint() }); }
      return response({ ...original, ...changed });
    }));
    const intent = controller(), first = await intent.submit(patch()), later = await intent.reconcile();
    expect(later.phase).toBe("confirmed"); expect(later.result).toBe(first.result); expect(later.error).toMatchObject({ kind: "protocol" });
  });
  it("does not replace a confirmed creation endpoint ID with another canonical ID", async () => {
    let original!: WebhookReceipt;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "POST") { original = await submittedReceipt(options, { kind: "endpoint.create" }); return response({ operation: original, endpoint: endpoint("1") }); }
      return response({ ...original, endpointId: uuid(99) });
    }));
    const intent = controller(), first = await intent.submit({ kind: "endpoint.create", body: { name: "Created", enabled: true, destination: { kind: "http", adapterVersion: "1", configuration: { url: "https://receiver.example/hooks" } }, subscriptions: [] } });
    const later = await intent.reconcile(); expect(later.phase).toBe("confirmed"); expect(later.result?.operation.endpointId).toBe(endpointId); expect(later.result).toBe(first.result); expect(later.error).toMatchObject({ kind: "protocol" });
  });
  it("preserves the first result and independent current view on identical receipt reconciliation", async () => {
    let original!: WebhookReceipt;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "PATCH") { original = await submittedReceipt(options); return response({ operation: original, endpoint: endpoint("9007199254740999") }); }
      return response(original);
    }));
    const intent = controller(), first = await intent.submit(patch()), later = await intent.reconcile();
    expect(later.phase).toBe("confirmed"); expect(later.error).toBeNull(); expect(later.result).toBe(first.result); expect(later.result?.operation).toBe(first.result?.operation);
    expect(later.result?.endpoint?.configVersion).toBe("9007199254740999"); expect(later.result?.operation.configVersionAfter).toBe("9007199254740994");
  });
  it("keeps known confirmation and a later current view when the original receipt becomes unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => options.method === "PATCH" ? response({ operation: await submittedReceipt(options), endpoint: endpoint("9007199254740999") }) : failure()));
    const intent = controller(), first = await intent.submit(patch()), later = await intent.reconcile();
    expect(later.phase).toBe("confirmed"); expect(later.result).toBe(first.result); expect(later.error).toMatchObject({ status: 404 });
    expect(later.result?.endpoint?.configVersion).toBe("9007199254740999"); expect(later.result?.operation.configVersionAfter).toBe("9007199254740994");
  });
  it("resets known outcome only for a new explicit intent", async () => {
    const fetch = vi.fn(async (_url: string, options: RequestInit) => { const operation = await submittedReceipt(options); return response({ operation, endpoint: endpoint(operation.configVersionAfter) }); }); vi.stubGlobal("fetch", fetch);
    const intent = controller(), first = await intent.submit(patch()), second = await intent.submit({ ...patch(), ifVersion: "9007199254740994", body: { name: "Explicit new decision" } });
    expect(second.phase).toBe("confirmed"); expect(second.result?.operation.operationId).not.toBe(first.result?.operation.operationId); expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["PATCH", "PATCH"]);
  });
  it("clears an unknown in-memory request while keeping the original ID and GET-only recovery", async () => {
    let operation!: WebhookReceipt, lookups = 0;
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "PATCH") { operation = await submittedReceipt(options); throw new TypeError("Response lost"); }
      return ++lookups === 1 ? failure() : response(operation);
    }); vi.stubGlobal("fetch", fetch);
    const intent = controller(), unknown = await intent.submit(patch()), listener = vi.fn(); intent.subscribe(listener);
    intent.forgetCurrentProjection(); intent.forgetCurrentProjection();
    expect(intent.getSnapshot()).toBe(unknown); expect(intent.getSnapshot().prepared?.operationId).toBe(operation.operationId); expect(listener).not.toHaveBeenCalled();
    const confirmed = await intent.reconcile(); expect(confirmed.phase).toBe("confirmed"); expect(confirmed.result?.operation.operationId).toBe(operation.operationId);
    expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["PATCH", undefined, undefined]);
  });
  it("does not dispatch a cleared pending body after identity admission completes", async () => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const intent = new WebhookIntentController({ serviceOrigin, owner, admission: { ...admission(), ready: async () => { entered(); await barrier; } }, signal: new AbortController().signal, storage: sessionStorage });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const pending = intent.submit(patch()); await waiting; const submitted = intent.getSnapshot(); intent.forgetCurrentProjection(); intent.forgetCurrentProjection(); release();
    const stopped = await pending; expect(stopped.phase).toBe("rejected"); expect(stopped.prepared?.operationId).toBe(submitted.prepared?.operationId); expect(fetch).not.toHaveBeenCalled();
  });
  it("can idempotently strip a late postcommit projection without erasing original confirmation", async () => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn(async (_url: string, options: RequestInit) => { entered(); await barrier; return response({ operation: await submittedReceipt(options), endpoint: endpoint() }); }); vi.stubGlobal("fetch", fetch);
    const intent = controller(), pending = intent.submit(patch()); await waiting; const operationId = intent.getSnapshot().prepared!.operationId;
    intent.forgetCurrentProjection(); intent.forgetCurrentProjection(); release(); await pending;
    const listener = vi.fn(); intent.subscribe(listener); intent.forgetCurrentProjection(); const stripped = intent.getSnapshot(); intent.forgetCurrentProjection();
    expect(stripped.phase).toBe("confirmed"); expect(stripped.result?.operation.operationId).toBe(operationId); expect(stripped.result?.endpoint).toBeUndefined(); expect(listener).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
  });
  it("does not dispatch a pre-aborted lifetime", () => {
    const lifetime = new AbortController(); lifetime.abort(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => controller(lifetime.signal).submit(patch())).toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it("enforces the final serialized byte limit including identity metadata", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => controller().submit({ ...patch(), body: { name: "汉".repeat(87382) } })).toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { body: { enabled: null } }, { body: { subscriptions: null } }, { body: { operationId: uuid(7) } }, { body: { name: "\ud800" } }, { ifVersion: "01" },
    { body: { subscriptions: [{ id: null, projectId: uuid(7), eventTypes: ["task.paused", "task.paused"] }] } },
  ])("rejects malformed input or reserved metadata before dispatch %#", override => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); expect(() => controller().submit({ ...patch(), ...override } as WebhookIntentInput)).toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Webhook pending cleanup failures", () => {
  const storageKey = (origin: string, actor: string, ownerKind: "personal" | "team", ownerId: string) => `daynight.webhook.pending:${encodeURIComponent(origin)}:${actor}:${ownerKind}:${ownerId}`;
  const memoryStorage = (entries: readonly (readonly [string, string])[] = []): Storage => {
    const values = new Map(entries);
    return {
      get length() { return values.size; },
      key: index => [...values.keys()][index] ?? null,
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: key => { values.delete(key); },
      clear: () => { values.clear(); },
    };
  };

  it("removes only the requested account and service across personal and team owners", () => {
    const owned = [storageKey(serviceOrigin, user, "personal", user), storageKey(serviceOrigin, user, "team", uuid(8))];
    const retained = [storageKey(serviceOrigin, uuid(9), "personal", uuid(9)), storageKey("https://another.example", user, "personal", user), "unrelated.setting"];
    const storage = memoryStorage([...owned, ...retained].map(key => [key, "opaque-record"] as const));
    expect(clearWebhookPending(serviceOrigin, user, storage)).toBeNull();
    owned.forEach(key => expect(storage.getItem(key)).toBeNull());
    retained.forEach(key => expect(storage.getItem(key)).toBe("opaque-record"));
  });

  it("returns a denied sessionStorage getter error without throwing during identity cleanup", () => {
    const denied = new DOMException("Storage access denied", "SecurityError");
    const getter = vi.spyOn(globalThis, "sessionStorage", "get").mockImplementation(() => { throw denied; });
    try { expect(clearWebhookPending(serviceOrigin, user)).toBe(denied); }
    finally { getter.mockRestore(); }
  });

  it.each(["length", "key", "removeItem"] as const)("returns the original %s failure for an explicit cleanup retry", property => {
    const ownedKey = storageKey(serviceOrigin, user, "personal", user);
    const storage = memoryStorage([[ownedKey, "opaque-record"]]), denied = new DOMException(`${property} access denied`, "SecurityError");
    const restore = property === "length"
      ? vi.spyOn(storage, "length", "get").mockImplementation(() => { throw denied; })
      : vi.spyOn(storage, property).mockImplementation(() => { throw denied; });
    expect(clearWebhookPending(serviceOrigin, user, storage)).toBe(denied);
    expect(storage.getItem(ownedKey)).toBe("opaque-record");
    restore.mockRestore();
    expect(clearWebhookPending(serviceOrigin, user, storage)).toBeNull();
    expect(storage.getItem(ownedKey)).toBeNull();
  });

  it("keeps a partial cleanup failure explicit and allows retrying the original opaque scope", () => {
    const owned = [storageKey(serviceOrigin, user, "personal", user), storageKey(serviceOrigin, user, "team", uuid(8))];
    const unrelated = storageKey(serviceOrigin, uuid(9), "personal", uuid(9));
    const storage = memoryStorage([...owned, unrelated].map(key => [key, "opaque-record"] as const));
    const remove = storage.removeItem, denied = new Error("Temporary storage failure");
    let failed = false;
    storage.removeItem = key => { if (key === owned[1] && !failed) { failed = true; throw denied; } remove(key); };
    expect(clearWebhookPending(serviceOrigin, user, storage)).toBe(denied);
    expect(storage.getItem(owned[0]!)).toBeNull(); expect(storage.getItem(owned[1]!)).toBe("opaque-record");
    expect(clearWebhookPending(serviceOrigin, user, storage)).toBeNull();
    expect(storage.getItem(owned[1]!)).toBeNull(); expect(storage.getItem(unrelated)).toBe("opaque-record");
  });

  it("keeps the cause of a non-Error storage failure visible to the caller", () => {
    const storage = memoryStorage(); Object.defineProperty(storage, "length", { get: () => { throw "storage-unavailable"; } });
    const error = clearWebhookPending(serviceOrigin, user, storage);
    expect(error).toBeInstanceOf(Error); expect(error?.cause).toBe("storage-unavailable");
  });
});

describe("Webhook fixed redelivery intents", () => {
  it("registers exactly the observed v/g with final byte proof and distinguishes original from later generation", async () => {
    const fetch = vi.fn(async (_url: string, options: RequestInit) => response({ operation: await submittedRedeliveryReceipt(options), delivery: currentDelivery("9007199254740997") }, 202)); vi.stubGlobal("fetch", fetch);
    const intent = controller(), confirmed = await intent.submit(redeliveryInput());
    const serialized = String(fetch.mock.calls[0]![1].body), body = JSON.parse(serialized);
    expect(Object.keys(body)).toEqual(["operationId", "issuedAt", "expectedUserId", "ifVersion", "ifGeneration"]);
    expect(body).toMatchObject({ expectedUserId: user, ifVersion: "9007199254740993", ifGeneration: "9007199254740993" });
    expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/me/webhooks/${endpointId}/deliveries/${deliveryId}/redeliveries`); expect(fetch.mock.calls[0]![1].method).toBe("POST");
    expect(confirmed.phase).toBe("confirmed"); expect(confirmed.prepared?.requestSha256).toBe(await hashBody(serialized));
    expect(confirmed.result?.operation).toMatchObject({ kind: "delivery.redeliver", endpointId, deliveryId, configVersionAfter: "9007199254740993", generationAfter: "9007199254740994", destinationRevisionAfter: "1", effect: "applied" });
    expect(confirmed.result?.delivery?.generation).toBe("9007199254740997"); expect(sessionStorage.length).toBe(0);
  });
  it("deduplicates button and Enter while one redelivery POST is pending", async () => {
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn(async (_url: string, options: RequestInit) => { await barrier; return response({ operation: await submittedRedeliveryReceipt(options), delivery: currentDelivery() }, 202); }); vi.stubGlobal("fetch", fetch);
    const intent = controller(), first = intent.submit(redeliveryInput()), second = intent.submit(redeliveryInput()); expect(second).toBe(first); release(); await first; expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([[409, "generation_conflict"], [409, "version_conflict"], [409, "delivery_busy"], [409, "target_changed"], [409, "delivery_stopped"], [403, "forbidden"], [410, "payload_expired"]] as const)("keeps explicit %i %s refusal without new generation or automatic reads", async (status, code) => {
    const fetch = vi.fn().mockResolvedValue(failure(status, code)); vi.stubGlobal("fetch", fetch);
    const rejected = await controller().submit(redeliveryInput()); expect(rejected.phase).toBe("rejected"); expect(rejected.error).toMatchObject({ status, code }); expect(rejected.result).toBeNull(); expect(fetch).toHaveBeenCalledOnce(); expect(sessionStorage.length).toBe(0);
  });
  it.each(["dependency_unavailable", "write_outcome_unknown", "webhooks_unavailable"])("uses only receipt GET after an ambiguous 503 %s", async code => {
    const fetch = vi.fn().mockResolvedValueOnce(failure(503, code)).mockResolvedValue(failure()); vi.stubGlobal("fetch", fetch);
    const unknown = await controller().submit(redeliveryInput()); expect(unknown.phase).toBe("unknown"); expect(unknown.prepared?.deliveryId).toBe(deliveryId); expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["POST", undefined]);
  });
  it("confirms one lost redelivery through original receipt GET without a second POST", async () => {
    let original!: WebhookReceipt;
    const fetch = vi.fn(async (_url: string, options: RequestInit) => { if (options.method === "POST") { original = await submittedRedeliveryReceipt(options); throw new TypeError("Response lost"); } return response(original); }); vi.stubGlobal("fetch", fetch);
    const confirmed = await controller().submit(redeliveryInput()); expect(confirmed.phase).toBe("confirmed"); expect(confirmed.result?.operation).toEqual(original); expect(confirmed.result?.delivery).toBeUndefined(); expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["POST", undefined]);
  });
  it("restores opaque E/D/v/g metadata and performs GET-only recovery without a request body", async () => {
    let original!: WebhookReceipt, lookups = 0;
    const fetch = vi.fn(async (_url: string, options: RequestInit) => { if (options.method === "POST") { original = await submittedRedeliveryReceipt(options); throw new TypeError("Response lost"); } return ++lookups === 1 ? failure() : response(original); }); vi.stubGlobal("fetch", fetch);
    const first = controller(); await first.submit(redeliveryInput());
    const saved = sessionStorage.getItem(sessionStorage.key(0)!)!; expect(saved).not.toMatch(/receiver|token|Private task|secret|payload|body/); expect(JSON.parse(saved)).toMatchObject({ kind: "delivery.redeliver", endpointId, deliveryId, ifVersion: "9007199254740993", ifGeneration: "9007199254740993" });
    first.dispose(); const restored = controller(); expect(restored.getSnapshot().phase).toBe("unknown"); const confirmed = await restored.reconcile(); expect(confirmed.phase).toBe("confirmed"); expect(confirmed.result?.operation.operationId).toBe(original.operationId); expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["POST", undefined, undefined]);
  });
  it.each([
    { actorUserId: uuid(99) }, { deliveryId: uuid(99) }, { endpointId: uuid(99) }, { requestSha256: "0".repeat(64) }, { generationAfter: "9007199254740995" }, { configVersionAfter: "9007199254740994" }, { destinationRevisionAfter: "2" },
    { kind: "endpoint.patch", deliveryId: null, generationAfter: null },
  ] as const)("does not confirm a redelivery receipt with wrong fixed binding %j", async changed => {
    const fetch = vi.fn(async (_url: string, options: RequestInit) => options.method === "POST" ? response({ operation: await submittedRedeliveryReceipt(options, changed), delivery: currentDelivery() }, 202) : failure()); vi.stubGlobal("fetch", fetch);
    const unknown = await controller().submit(redeliveryInput()); expect(unknown.phase).toBe("unknown"); expect(unknown.result).toBeNull(); expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["POST", undefined]);
  });
  it.each([{ generation: "9007199254740993" }, { id: uuid(99) }, { target: { ...currentDelivery().target, destinationRevision: "2" } }])("preserves original registered generation when current delivery projection is invalid %j", async changed => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => response({ operation: await submittedRedeliveryReceipt(options), delivery: { ...currentDelivery(), ...changed } }, 202)));
    const confirmed = await controller().submit(redeliveryInput()); expect(confirmed.phase).toBe("confirmed"); expect(confirmed.result?.operation.generationAfter).toBe("9007199254740994"); expect(confirmed.result?.delivery).toBeUndefined(); expect(confirmed.error).toMatchObject({ kind: "protocol" });
  });
  it("rejects a 200 response as unconfirmed rather than treating it as a registered redelivery", async () => {
    const fetch = vi.fn(async (_url: string, options: RequestInit) => options.method === "POST" ? response({ operation: await submittedRedeliveryReceipt(options), delivery: currentDelivery() }, 200) : failure()); vi.stubGlobal("fetch", fetch);
    const unknown = await controller().submit(redeliveryInput()); expect(unknown.phase).toBe("unknown"); expect(unknown.result).toBeNull(); expect(fetch.mock.calls.map(call => call[1].method)).toEqual(["POST", undefined]);
  });
  it("keeps first confirmed generation when a later original operation GET contradicts its receipt", async () => {
    let original!: WebhookReceipt;
    const fetch = vi.fn(async (_url: string, options: RequestInit) => { if (options.method === "POST") { original = await submittedRedeliveryReceipt(options); return response({ operation: original, delivery: currentDelivery("9007199254740997") }, 202); } return response({ ...original, expiresAt: "2026-12-09T12:00:00Z" }); }); vi.stubGlobal("fetch", fetch);
    const intent = controller(), first = await intent.submit(redeliveryInput()), later = await intent.reconcile(); expect(later.phase).toBe("confirmed"); expect(later.result).toBe(first.result); expect(later.error).toMatchObject({ kind: "protocol" }); expect(later.result?.operation.generationAfter).toBe("9007199254740994"); expect(later.result?.delivery?.generation).toBe("9007199254740997");
  });
  it("forgets a private current delivery projection without losing original generation or receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => response({ operation: await submittedRedeliveryReceipt(options), delivery: currentDelivery() }, 202)));
    const intent = controller(), first = await intent.submit(redeliveryInput()), listener = vi.fn(); intent.subscribe(listener); intent.forgetCurrentProjection(); const stripped = intent.getSnapshot(); intent.forgetCurrentProjection();
    expect(stripped.phase).toBe("confirmed"); expect(stripped.result?.delivery).toBeUndefined(); expect(stripped.result?.operation).toBe(first.result?.operation); expect(stripped.prepared).toBe(first.prepared); expect(listener).toHaveBeenCalledOnce();
  });
  it("does not publish a late administrator delivery response after lifetime withdrawal", async () => {
    const lifetime = new AbortController(); let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn(async (_url: string, options: RequestInit) => { entered(); await barrier; return response({ operation: await submittedRedeliveryReceipt(options), delivery: currentDelivery() }, 202); }); vi.stubGlobal("fetch", fetch);
    const intent = controller(lifetime.signal), pending = intent.submit(redeliveryInput()); await waiting; lifetime.abort(); release(); const unknown = await pending;
    expect(unknown.phase).toBe("unknown"); expect(unknown.result?.delivery).toBeUndefined(); expect(unknown.prepared?.deliveryId).toBe(deliveryId); expect(fetch).toHaveBeenCalledOnce();
  });
  it("gates redelivery dispatch by operation kind before preparing an ID or write", () => {
    const generated = vi.spyOn(crypto, "randomUUID"), canSubmit = vi.fn(kind => kind !== "delivery.redeliver");
    const intent = new WebhookIntentController({ serviceOrigin, owner, admission: admission(), signal: new AbortController().signal, storage: sessionStorage, canSubmit }); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => intent.submit(redeliveryInput())).toThrow(); expect(canSubmit).toHaveBeenCalledWith("delivery.redeliver"); expect(generated).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(sessionStorage.length).toBe(0);
  });
  it.each([
    { ifGeneration: "01" }, { ifGeneration: "9223372036854775808" }, { ifGeneration: undefined }, { deliveryId: undefined }, { destinationRevision: undefined }, { body: { payload: "private" } },
  ])("rejects malformed redelivery descriptors without assigning a new identity %j", changed => {
    const generated = vi.spyOn(crypto, "randomUUID"), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => controller().submit({ ...redeliveryInput(), ...changed } as unknown as WebhookIntentInput)).toThrow(); expect(generated).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
