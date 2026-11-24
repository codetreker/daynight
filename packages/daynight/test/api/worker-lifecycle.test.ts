import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createWorkerLifecycleClient } from "../../src/api/worker-lifecycle-client.js";
import { lifecycleRequestHash, parseLifecycleObservationEnvelope, parseLifecycleOperationResult, parseLifecycleIntentRequest, type LifecycleObservationEnvelope, type LifecycleIntentRequest, type LifecycleActivationRequest } from "../../src/api/worker-lifecycle.js";

const workerId = "11111111-1111-4111-8111-111111111111", userId = "22222222-2222-4222-8222-222222222222", operationId = "33333333-3333-4333-8333-333333333333", instanceId = "44444444-4444-4444-8444-444444444444";
const observedAt = "2026-11-21T01:00:00.000Z";
const resource = { protocolVersion: 1, workerId, intentVersion: "9007199254740993", desired: "disabled", admission: "closed", operationId, instance: { instanceId }, capability: "supported", observation: null, observedAt };
const intent: LifecycleIntentRequest = { protocolVersion: 1, operationId, action: "disable", expectedVersion: "9007199254740993", source: "local", localEpoch: "4", originOperationId: workerId };
const intentReceipt = { protocolVersion: 1, workerId, operationId, action: "disable", intentVersion: "9007199254740994", desired: "disabled", admission: "closed", state: "accepted", errorCode: null, observedAt };
const activation: LifecycleActivationRequest = { protocolVersion: 1, operationId, instanceId, intentVersion: "4", localEpoch: "4", scopeGeneration: "2", reportSequence: "3" };
const activationReceipt = { protocolVersion: 1, workerId, operationId, action: "resume", instanceId, intentVersion: "4", localEpoch: "4", scopeGeneration: "2", admission: "open", observedAt };
const report: LifecycleObservationEnvelope = { protocolVersion: 1, instanceId, intentVersion: "4", operationId, localEpoch: "4", scopeGeneration: "2", reportSequence: "3", observation: { phase: "disabled", stop: "confirmed", save: "durable", sync: "complete", inventoryComplete: true, detailsComplete: true, inventoryRevision: "1", inventoryDigest: "a".repeat(64), resourceCount: 0, stoppedCount: 0, pendingCount: 0, blockedCount: 0, resources: [], recovery: [], errorCode: null } };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, "X-Daynight-Worker-Lifecycle": "1", ...headers } });
const client = (fetch: typeof globalThis.fetch) => createWorkerLifecycleClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", userId, workerId, fetch });

describe("Worker lifecycle protocol and original identities", () => {
  it("reads the exact resource with lossless versions and negotiated owner identity", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(resource));
    expect(await client(fetch).read()).toEqual(resource);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:8787/api/v1/me/workers/${workerId}/lifecycle`);
    expect(request).toMatchObject({ method: "GET", redirect: "manual", cache: "no-store", headers: { Authorization: "Bearer fixture-token", "X-Daynight-Worker-Lifecycle": "1" } });
  });

  it("persists no new identity and sends one exact disable request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(intentReceipt, 202));
    expect(await client(fetch).intent(intent)).toEqual(intentReceipt);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual(intent);
  });

  it.each([{ source: "web" }, { localEpoch: null }, { originOperationId: null }, { instanceId }, { expectedVersion: "01" }, { expectedVersion: "9223372036854775808" }, { operationId: "00000000-0000-0000-0000-000000000000" }])("refuses invalid local intent before HTTP: %j", changes => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => client(fetch).intent({ ...intent, ...changes } as LifecycleIntentRequest)).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains the explicit required null fields in a web disable", () => {
    expect(parseLifecycleIntentRequest({ ...intent, source: "web", localEpoch: null, originOperationId: null })).toMatchObject({ localEpoch: null, originOperationId: null });
    const { localEpoch: _, ...missing } = intent;
    expect(() => parseLifecycleIntentRequest(missing)).toThrow();
  });

  it.each([{ workerId: instanceId }, { operationId: workerId }, { intentVersion: "9007199254740995" }, { action: "resume" }, { desired: "enabled" }, { admission: "open" }, { extra: true }])("does not confirm a mismatching mutation receipt: %j", async changes => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...intentReceipt, ...changes }, 202));
    await expect(client(fetch).intent(intent)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([{ "Daynight-User-ID": instanceId }, { "Daynight-User-ID": "" }, { "X-Daynight-Worker-Lifecycle": "" }, { "X-Daynight-Worker-Lifecycle": "2" }])("requires owner and protocol negotiation: %j", async headers => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(intentReceipt, 202, headers as Record<string, string>));
    await expect(client(fetch).intent(intent)).rejects.toMatchObject({ outcomeUnconfirmed: true });
  });

  it("accepts instance registration only for the submitted instance", async () => {
    const input = { protocolVersion: 1 as const, operationId, instanceId, capabilities: { disable: true as const, resume: true as const, inventory: 1 as const, dispatchFence: 1 as const }, platform: "macos" as const };
    const receipt = { protocolVersion: 1, workerId, operationId, instanceId, intentVersion: "4", desired: "disabled", admission: "closed", reconnectAllowed: false, observedAt };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(receipt)).mockResolvedValueOnce(json({ ...receipt, instanceId: userId }));
    expect(await client(fetch).register(input)).toEqual(receipt);
    await expect(client(fetch).register(input)).rejects.toMatchObject({ outcomeUnconfirmed: true });
  });

  it("matches the activation identity, intent and local scope before confirming the open receipt", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(activationReceipt)).mockResolvedValueOnce(json({ ...activationReceipt, localEpoch: "5" }));
    expect(await client(fetch).activate(activation)).toEqual(activationReceipt);
    await expect(client(fetch).activate(activation)).rejects.toMatchObject({ outcomeUnconfirmed: true });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).not.toHaveProperty("action");
  });

  it("validates the observation receipt's exact instance, intent and report sequence", async () => {
    const receipt = { protocolVersion: 1, accepted: true, instanceId, intentVersion: "4", reportSequence: "3", receivedAt: observedAt };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(receipt)).mockResolvedValueOnce(json({ ...receipt, reportSequence: "2" }));
    expect(await client(fetch).report(report)).toEqual(receipt);
    await expect(client(fetch).report(report)).rejects.toMatchObject({ outcomeUnconfirmed: true });
  });

  it("hashes canonical complete requests with the server's phase domain", () => {
    const canonical = `{"action":"disable","expectedVersion":"9007199254740993","localEpoch":"4","operationId":"${operationId}","originOperationId":"${workerId}","protocolVersion":1,"source":"local"}`;
    expect(lifecycleRequestHash("intent", intent)).toBe(createHash("sha256").update(`daynight.lifecycle.v1/intent\n${canonical}`).digest("hex"));
    expect(lifecycleRequestHash("intent", Object.fromEntries(Object.entries(intent).reverse()))).toBe(lifecycleRequestHash("intent", intent));
  });

  it("resolves the same original request without resending the intent", async () => {
    const receipt = { protocolVersion: 1, workerId, operationId, requestKind: "intent", requestHash: lifecycleRequestHash("intent", intent), outcome: "not_committed", observedAt };
    const result = { kind: "not_committed", receipt };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(result)).mockResolvedValueOnce(json({ ...result, receipt: { ...receipt, requestHash: "f".repeat(64) } }));
    expect(await client(fetch).resolve({ protocolVersion: 1, requestKind: "intent", request: intent })).toEqual(result);
    expect(String(fetch.mock.calls[0]![0]).endsWith(`/operations/${operationId}/resolve`)).toBe(true);
    await expect(client(fetch).resolve({ protocolVersion: 1, requestKind: "intent", request: intent })).rejects.toMatchObject({ outcomeUnconfirmed: true });
  });

  it("keeps intent and activation outcomes independent", () => {
    const receipt = { ...intentReceipt, action: "resume", desired: "enabled", intentVersion: "4" };
    expect(parseLifecycleOperationResult({ kind: "intent", receipt, activation: null, activationOutcome: "not_committed" })).toMatchObject({ receipt, activation: null });
    expect(() => parseLifecycleOperationResult({ kind: "intent", receipt, activation: null, activationOutcome: "committed" })).toThrow();
    expect(() => parseLifecycleOperationResult({ kind: "intent", receipt, activation: activationReceipt, activationOutcome: "not_started" })).toThrow();
    expect(parseLifecycleOperationResult({ kind: "intent", receipt, activation: activationReceipt, activationOutcome: "committed" })).toMatchObject({ activation: activationReceipt });
  });
});

describe("Worker lifecycle observation safety and HTTP failures", () => {
  it("accepts complete aggregate evidence with a bounded detail prefix", () => {
    const input = { ...report, observation: { ...report.observation, detailsComplete: false, resourceCount: 10000, stoppedCount: 10000 } };
    expect(parseLifecycleObservationEnvelope(input)).toEqual(input);
  });
  it.each([{ inventoryComplete: false }, { pendingCount: 1 }, { stoppedCount: null }, { resourceCount: 1 }, { save: "pending" }, { resourceCount: 9007199254740992 }, { inventoryRevision: "0" }])("rejects contradictory stop/save aggregate: %j", changes => {
    expect(() => parseLifecycleObservationEnvelope({ ...report, observation: { ...report.observation, ...changes } })).toThrow();
  });
  it("does not retry unknown transport or server failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error("Connection reset")).mockResolvedValueOnce(json({ error: { code: "lifecycle_unavailable", message: "Unavailable", requestId: "original" } }, 503));
    await expect(client(fetch).intent(intent)).rejects.toMatchObject({ phase: "request", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(client(fetch).intent(intent)).rejects.toMatchObject({ phase: "response", outcomeUnconfirmed: true, code: "lifecycle_unavailable", confirmedRefusal: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("recognizes a definite version conflict without retrying or changing its operation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code: "version_conflict", message: "Changed", requestId: "original" } }, 409));
    await expect(client(fetch).intent(intent)).rejects.toMatchObject({ phase: "response", outcomeUnconfirmed: false, confirmedRefusal: true, code: "version_conflict" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("does not dispatch a pre-cancelled request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(), cancellation = new AbortController(); cancellation.abort();
    await expect(client(fetch).intent(intent, cancellation.signal)).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("cancels an in-flight request while retaining its unknown outcome", async () => {
    const cancellation = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => { cancellation.abort(); return new Promise<Response>(() => {}); });
    await expect(client(fetch).intent(intent, cancellation.signal)).rejects.toMatchObject({ outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("bounds an unanswered exchange at ten seconds without a second submission", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Promise<Response>(() => {}));
      const failure = expect(client(fetch).intent(intent)).rejects.toMatchObject({ phase: "request", outcomeUnconfirmed: true });
      await vi.advanceTimersByTimeAsync(10_000);
      await failure;
      expect(fetch).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("rejects duplicate response fields and oversized bodies", async () => {
    const headers = { "Content-Type": "application/json", "Daynight-User-ID": userId, "X-Daynight-Worker-Lifecycle": "1" };
    const duplicate = JSON.stringify(intentReceipt).replace('"protocolVersion":1', '"protocolVersion":1,"protocolVersion":1');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(duplicate, { status: 202, headers })).mockResolvedValueOnce(new Response(" ".repeat(512 * 1024 + 1), { status: 202, headers }));
    await expect(client(fetch).intent(intent)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    await expect(client(fetch).intent(intent)).rejects.toMatchObject({ phase: "response", outcomeUnconfirmed: true });
  });
});
