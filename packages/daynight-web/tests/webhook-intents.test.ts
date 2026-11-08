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
const patch = (): WebhookIntentInput => ({ kind: "endpoint.patch", endpointId, ifVersion: "9007199254740993", destinationRevision: "1", body: { name: "Release 通知", enabled: false } });
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
