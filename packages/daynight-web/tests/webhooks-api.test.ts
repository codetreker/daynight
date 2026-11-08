import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeWebhookJson, getWebhook, getWebhookCatalog, getWebhookOperation, getWebhookSecret, listWebhooks,
  parseWebhookCatalog, parseWebhookEndpoint, parseWebhookEndpointPage, parseWebhookReceipt, parseWebhookSecret, submitWebhookMutation, webhookVersion,
} from "../src/api/webhooks";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const user = uuid(1), endpointId = uuid(2), operationId = uuid(3), keyId = uuid(4), owner = { kind: "personal" as const, id: user };
const now = "2026-11-08T12:00:00Z";
const admission = () => ({ userId: user, onPrincipalMismatch: vi.fn() });
const signal = () => new AbortController().signal;
const destination = () => ({ kind: "http", adapterVersion: "1", url: "https://receiver.example/hooks?token=private", displayUrl: "https://receiver.example/hooks?token=private" });
const endpoint = () => ({
  id: endpointId, owner, lifecycle: "active", configVersion: "9007199254740993", deletedAt: null, name: "Release", enabled: true,
  destinationRevision: "1", destination: destination(), signing: { scheme: "standard-webhooks-v1", activeKeyId: keyId, overlapUntil: null },
  subscriptions: [{ id: uuid(5), projectId: uuid(6), projectName: "Project", eventTypes: ["task.paused"], eligibility: "eligible" }],
  capabilities: { manage: true, readSecret: true, redeliver: true }, createdAt: now, updatedAt: now,
});
const summary = () => ({ id: endpointId, owner, name: "Release", enabled: true, configVersion: "9007199254740993", destination: destination(), projectCount: 1, eventTypeCount: 1, lastAttemptAt: null, lastResult: null });
const receipt = () => ({ operationId, kind: "endpoint.patch", issuedAt: now, requestSha256: "a".repeat(64), actorUserId: user, owner, endpointId, effect: "applied", configVersionAfter: "9007199254740994", destinationRevisionAfter: "1", deliveryId: null, generationAfter: null, keyId: null, overlapUntil: null, recordedAt: now, expiresAt: "2026-12-08T12:00:00Z" });
const catalog = () => ({
  items: ["task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"].map(key => ({ key, wireType: `cc.daynight.${key}.v1`, schemaVersion: 1, resourceKind: "project" })),
  service: { configurationExpansionAvailable: true, dispatchEnabled: false },
  limits: { policyVersion: "1", requestBytes: 262144, payloadBytes: 65536, maxAutomaticAttempts: 8, automaticWindowSeconds: 86400, maxManualOperations: 3, payloadRetentionSeconds: 2592000, operationMaxAgeSeconds: 300, operationFutureSkewSeconds: 60 },
});
const response = (value: unknown, status = 200, principal: string | null = user, media = "application/json") => new Response(JSON.stringify(value), { status, headers: { "Content-Type": media, ...(principal === null ? {} : { "Daynight-User-ID": principal }) } });
const failure = (status: number, code: string, principal: string | null = user) => response({ error: { code, message: "Request failed.", requestId: "test-request" } }, status, principal);

afterEach(() => vi.unstubAllGlobals());

describe("Webhook wire contracts", () => {
  it("preserves canonical int64 strings beyond the Number precision boundary", () => {
    expect(webhookVersion("9007199254740993")).toBe("9007199254740993");
    expect(webhookVersion("9223372036854775807")).toBe("9223372036854775807");
    expect(parseWebhookEndpoint(endpoint(), owner).configVersion).toBe("9007199254740993");
  });
  it.each([0, 1, "0", "01", "-1", "1e3", "9223372036854775808", "1".repeat(300)])("rejects malformed versions %j", value => {
    expect(() => webhookVersion(value)).toThrow();
  });
  it("accepts a stopped dispatch catalog without inventing quota or health fields", () => {
    expect(parseWebhookCatalog(catalog()).service).toEqual({ configurationExpansionAvailable: true, dispatchEnabled: false });
    const invalid = catalog(); Object.assign(invalid.limits, { endpointQuota: 10 });
    expect(() => parseWebhookCatalog(invalid)).toThrow();
  });
  it.each([
    () => ({ ...catalog(), items: catalog().items.slice(0, 5) }),
    () => ({ ...catalog(), items: [...catalog().items.slice(0, 5), catalog().items[0]] }),
    () => ({ ...catalog(), items: catalog().items.map(item => ({ ...item, wireType: "cc.other.task.paused.v1" })) }),
    () => ({ ...catalog(), service: { dispatchEnabled: false } }),
  ])("rejects incomplete and mismatched catalog metadata %#", value => expect(() => parseWebhookCatalog(value())).toThrow());
  it("preserves revoked disclosure and minimum tombstones without fallback", () => {
    const revoked = { ...endpoint(), destination: { ...destination(), url: null, displayUrl: "https://receiver.example/…" }, capabilities: { manage: false, readSecret: false, redeliver: false }, subscriptions: [{ ...endpoint().subscriptions[0], projectName: null, eligibility: "access_revoked" }] };
    expect(parseWebhookEndpoint(revoked, owner)).toEqual(revoked);
    const deleted = { id: endpointId, owner, lifecycle: "deleted", configVersion: "8", deletedAt: now };
    expect(parseWebhookEndpoint(deleted, owner)).toEqual(deleted);
    expect(() => parseWebhookEndpoint({ ...deleted, name: "Old private name" }, owner)).toThrow();
  });
  it("rejects foreign owners and duplicate subscription or page identities", () => {
    expect(() => parseWebhookEndpoint({ ...endpoint(), owner: { kind: "team", id: uuid(8) } }, owner)).toThrow();
    expect(() => parseWebhookEndpoint({ ...endpoint(), subscriptions: [endpoint().subscriptions[0], endpoint().subscriptions[0]] }, owner)).toThrow();
    expect(() => parseWebhookEndpointPage({ items: [summary(), summary()], nextCursor: null }, owner)).toThrow();
  });
  it("parses nullable real last-result wire shapes", () => {
    const value = { items: [{ ...summary(), lastAttemptAt: now, lastResult: { category: "http_error", code: null, httpStatus: 503, durationMs: 20 } }], nextCursor: null };
    expect(parseWebhookEndpointPage(value, owner)).toEqual(value);
  });
  it("requires the original nullable rotation deadline on every receipt", () => {
    expect(parseWebhookReceipt(receipt(), owner)).toEqual(receipt());
    const { overlapUntil: _deadline, ...missing } = receipt();
    expect(() => parseWebhookReceipt(missing, owner)).toThrow();
    expect(() => parseWebhookReceipt({ ...receipt(), overlapUntil: now }, owner)).toThrow();
    expect(parseWebhookReceipt({ ...receipt(), kind: "signing-secret.rotate", keyId, overlapUntil: now }, owner).overlapUntil).toBe(now);
  });
  it("preserves original issued-at fractional precision and accepts only UTC", () => {
    const issuedAt = "2026-11-08T12:00:00.123456789123+00:00";
    expect(parseWebhookReceipt({ ...receipt(), issuedAt }, owner).issuedAt).toBe(issuedAt);
    expect(() => parseWebhookReceipt({ ...receipt(), issuedAt: "2026-11-08T12:00:00+08:00" }, owner)).toThrow();
  });
  it("decodes exactly canonical 32-byte signing secrets in the browser", () => {
    const encoded = btoa("a".repeat(32)), value = { endpointId, configVersion: "2", keyId, scheme: "standard-webhooks-v1", secret: `whsec_${encoded}` };
    expect(parseWebhookSecret(value, endpointId)).toEqual(value);
    for (const secret of [encoded, `whsec_${btoa("a".repeat(31))}`, `whsec_${encoded.slice(0, -1)}`, `whsec_${encoded}\n`, `whsec_${encoded.slice(0, -2)}F=`]) {
      expect(() => parseWebhookSecret({ ...value, secret }, endpointId)).toThrow();
    }
  });
  it.each([
    '{"a":1,"a":2}', '{"a":{"b":1,"b":2}}', '{"a":[{"b":1,"b":2}]}', '{"a":{"b":1,"\\u0062":2}}', '{"a":"\\ud800"}', '{"\\ud800":0}',
  ])("rejects hidden duplicates and malformed Unicode in original JSON %s", source => expect(() => decodeWebhookJson(source)).toThrow());
  it("decodes nested JSON without confusing escaped delimiters or primitive values", () => {
    const value = { a: [{ quoted: '"},]', yes: true, no: false, nil: null, number: 9, unicode: "通知" }], b: {} };
    expect(decodeWebhookJson(JSON.stringify(value))).toEqual(value);
  });
});

describe("Webhook authenticated requests", () => {
  it("reads the fixed API catalog and exact endpoint owner routes", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(catalog())).mockResolvedValueOnce(response(endpoint())).mockResolvedValueOnce(response(receipt()));
    vi.stubGlobal("fetch", fetch);
    await getWebhookCatalog(signal(), admission()); await getWebhook(owner, endpointId, signal(), admission()); await getWebhookOperation(owner, operationId, signal(), admission());
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["/api/v1/webhook-event-types", `/api/v1/me/webhooks/${endpointId}`, `/api/v1/me/webhooks/operations/${operationId}`]);
    expect(fetch.mock.calls.every(call => call[1].credentials === "same-origin" && call[1].cache === "no-store")).toBe(true);
  });
  it("delegates search and pagination filters to the owner route", async () => {
    const teamOwner = { kind: "team" as const, id: uuid(7) };
    const fetch = vi.fn().mockResolvedValue(response({ items: [{ ...summary(), owner: teamOwner, enabled: false }], nextCursor: "next-two" })); vi.stubGlobal("fetch", fetch);
    await listWebhooks(teamOwner, { q: "Release 通知", enabled: false, limit: 50, cursor: "next/+ token" }, signal(), admission());
    expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/teams/${teamOwner.id}/webhooks?q=Release+%E9%80%9A%E7%9F%A5&enabled=false&limit=50&cursor=next%2F%2B+token`);
  });
  it("omits the empty default and cleared search while retaining genuine server filters", async () => {
    const page = { items: [summary()], nextCursor: null };
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(response(page))); vi.stubGlobal("fetch", fetch);
    expect(await listWebhooks(owner, { q: "", limit: 50 }, signal(), admission())).toEqual(page);
    expect(await listWebhooks(owner, { q: "Release", limit: 50 }, signal(), admission())).toEqual(page);
    expect(await listWebhooks(owner, { q: "", limit: 50 }, signal(), admission())).toEqual(page);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["/api/v1/me/webhooks?limit=50", "/api/v1/me/webhooks?q=Release&limit=50", "/api/v1/me/webhooks?limit=50"]);
  });
  it("does not dispatch foreign personal ownership or invalid pagination", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => listWebhooks({ kind: "personal", id: uuid(8) }, {}, signal(), admission())).toThrow();
    for (const query of [{ limit: 0 }, { limit: 101 }, { cursor: "" }, { q: "a".repeat(201) }]) expect(() => listWebhooks(owner, query, signal(), admission())).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([null, uuid(9)])("rejects missing or mismatched principals even on failure %j", async principal => {
    const gate = admission(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failure(403, "forbidden", principal)));
    await expect(getWebhook(owner, endpointId, signal(), gate)).rejects.toMatchObject({ kind: "protocol" });
    expect(gate.onPrincipalMismatch).toHaveBeenCalledTimes(principal === null ? 0 : 1);
  });
  it("uses global unauthorized handling without requiring the non-401 principal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failure(401, "unauthenticated", null)));
    await expect(getWebhook(owner, endpointId, signal(), admission())).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
  });
  it.each(["text/plain", "text/html", "application/problem+json", "application/json; charset=utf-16", "application/json; version=2"])('rejects non-contract media %s', async media => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(endpoint(), 200, user, media)));
    await expect(getWebhook(owner, endpointId, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
  });
  it("keeps 404 as an error and rejects an expanded error shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(failure(404, "not_found")).mockResolvedValueOnce(response({ error: { code: "not_found", requestId: "test", message: "Missing", endpoint: endpoint() } }, 404)));
    await expect(listWebhooks(owner, {}, signal(), admission())).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(getWebhook(owner, endpointId, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
  });
  it("rejects a repeated cursor and an enabled-filter mismatch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ items: [summary()], nextCursor: "same" })).mockResolvedValueOnce(response({ items: [summary()], nextCursor: null })));
    await expect(listWebhooks(owner, { cursor: "same" }, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
    await expect(listWebhooks(owner, { enabled: false }, signal(), admission())).rejects.toMatchObject({ kind: "protocol" });
  });
  it("reads secrets only through the independent signing-secret route", async () => {
    const value = { endpointId, configVersion: "2", keyId, scheme: "standard-webhooks-v1", secret: `whsec_${btoa("a".repeat(32))}` };
    const fetch = vi.fn().mockResolvedValue(response(value)); vi.stubGlobal("fetch", fetch);
    expect(await getWebhookSecret(owner, endpointId, signal(), admission())).toEqual(value);
    expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/me/webhooks/${endpointId}/signing-secret`);
  });
  it("preserves a validated historical receipt when the current endpoint projection is invalid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ operation: receipt(), endpoint: { ...endpoint(), configVersion: 2 } })));
    const observed = vi.fn();
    const result = await submitWebhookMutation(owner, "endpoint.patch", endpointId, operationId, "{}", signal(), admission(), observed);
    expect(observed).toHaveBeenCalledWith(receipt()); expect(result.operation).toEqual(receipt()); expect(result.currentError).toMatchObject({ kind: "protocol" });
  });
  it("waits for the existing identity admission before dispatching reads", async () => {
    let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn().mockResolvedValue(response(catalog())); vi.stubGlobal("fetch", fetch);
    const pending = getWebhookCatalog(signal(), { ...admission(), ready: () => ready });
    expect(fetch).not.toHaveBeenCalled(); release(); await pending; expect(fetch).toHaveBeenCalledOnce();
  });
  it("keeps the original expected principal while admission is awaiting identity", async () => {
    let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
    const gate = { ...admission(), ready: () => ready };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(catalog(), 200, uuid(9))));
    const pending = getWebhookCatalog(signal(), gate); gate.userId = uuid(9); release();
    await expect(pending).rejects.toMatchObject({ code: "principal_mismatch" }); expect(gate.onPrincipalMismatch).toHaveBeenCalledOnce();
  });
  it("keeps original rotation key and deadline distinct from subsequent current state", async () => {
    const operation = { ...receipt(), kind: "signing-secret.rotate", keyId, overlapUntil: "2026-11-09T12:00:00Z" };
    const signing = { activeKeyId: keyId, overlapUntil: operation.overlapUntil };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ operation, signing })).mockResolvedValueOnce(response({ operation, signing: { ...signing, overlapUntil: now } })));
    expect(await submitWebhookMutation(owner, "signing-secret.rotate", endpointId, operationId, "{}", signal(), admission(), vi.fn())).toEqual({ operation, signing });
    expect((await submitWebhookMutation(owner, "signing-secret.rotate", endpointId, operationId, "{}", signal(), admission(), vi.fn())).currentError).toMatchObject({ kind: "protocol" });
  });
});
