import { describe, expect, it, vi } from "vitest";
import { reconcileLifecycleRequest, classifyLifecycleSessionOperation } from "../../../src/commands/worker/lifecycle-request-recovery.js";
import { SESSION_PROTOCOL, type SessionOperation } from "../../../src/session/protocol.js";
import type { LifecycleResource } from "../../../src/commands/worker/lifecycle-store.js";

const userId = "11111111-1111-4111-8111-111111111111", workerId = "22222222-2222-4222-8222-222222222222", operationId = "33333333-3333-4333-8333-333333333333", botId = "44444444-4444-4444-8444-444444444444", assistantTaskId = "55555555-5555-4555-8555-555555555555", sessionId = "66666666-6666-4666-8666-666666666666", executionId = "77777777-7777-4777-8777-777777777777";
const identity = { serverOrigin: "http://localhost:8787", userId, workerId }, now = "2026-11-21T00:00:00Z", until = "2026-11-21T00:05:00Z", requestFingerprint = "a".repeat(64);
const resource = (source: LifecycleResource["identity"]): LifecycleResource => ({ resourceId: userId, ownerKind: "assistant", operationId, identity: source, instanceId: workerId, scopeGeneration: "3", stage: "unknown", processProof: null, stopProof: null, saveState: "durable", error: "Unknown original response" });
const response = (value: unknown, status = 200, principal = userId) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": principal } });
const run = (source: LifecycleResource["identity"], fetch: typeof globalThis.fetch) => reconcileLifecycleRequest({ resource: resource(source), identity, serverToken: "fixture-token", signal: new AbortController().signal, fetch });
const input = { kind: "assistant_input", botId, sessionId, executionId, executionGeneration: "9" };
const sessionOperation: SessionOperation = { protocol: SESSION_PROTOCOL, sessionId, testExecutionId: executionId, executionGeneration: "9", operationId, kind: "send_message", state: "confirmed", providerResult: "handled", error: null };
const claimOperation = { operationId, kind: "renew", taskId: assistantTaskId, actorBotId: botId, requestFingerprint, admittedAt: now, resultingVersion: "8", resultingGeneration: "2", holderBotId: botId, credentialOperationId: executionId, leaseUntil: until };
const currentClaim = { holderBotId: botId, credentialOperationId: executionId, claimGeneration: "2", claimState: "active", claimedAt: now, renewedAt: now, leaseUntil: until, observedAt: now };

describe("read-only lifecycle request reconciliation", () => {
  it("uses the frozen assistant claim fingerprint and never renews or reacquires a claim", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ operation: claimOperation, currentClaim }));
    const result = await run({ kind: "assistant_api", method: "claim", assistantTaskId, botId, claimKind: "renew", requestFingerprint }, fetch);
    expect(result).toMatchObject({ kind: "settled", stage: "confirmed", receipt: { operation: claimOperation } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]![0])).toBe(`${identity.serverOrigin}/api/v1/assistant-tasks/${assistantTaskId}/claim-operations/${operationId}`);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET" });
  });
  it("does not use a changed holder's receipt for the original request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ operation: { ...claimOperation, requestFingerprint: "b".repeat(64) }, currentClaim }));
    expect(await run({ kind: "assistant_api", method: "claim", assistantTaskId, botId, claimKind: "renew", requestFingerprint }, fetch)).toMatchObject({ kind: "pending" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["addEvent", "addRecord", "saveItem", "clearAttention", "answer"])("retains %s without a result protocol rather than treating resource equality as a receipt", async method => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await run({ kind: "assistant_api", method, assistantTaskId, botId }, fetch)).toEqual({ kind: "pending", reasonCode: "no_result_protocol" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires a complete original Session fence before any read", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { executionGeneration: _, ...legacy } = input;
    expect(await run(legacy, fetch)).toEqual({ kind: "pending", reasonCode: "missing_identity" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["accepted", "offered", "dispatching", "unknown"] as const)("retains an original %s input without resending", async state => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ operation: { ...sessionOperation, state, providerResult: null } }));
    expect(await run(input, fetch)).toMatchObject({ kind: "pending", reasonCode: "operation_pending", receipt: { state } });
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "manual", cache: "no-store" });
  });
  it.each(["confirmed", "failed", "provider_accepted"] as const)("records the exact %s dispatch result without claiming native stopping", async state => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ operation: { ...sessionOperation, state } }));
    const result = await run(input, fetch);
    expect(result).toMatchObject({ kind: "settled", stage: "confirmed", receipt: { kind: "session_operation", state, executionGeneration: "9", testExecutionId: executionId } });
    expect(result).not.toHaveProperty("stop");
  });
  it.each(["rejected", "expired"] as const)("records a definite %s disposition as not dispatched", state => {
    expect(classifyLifecycleSessionOperation({ ...sessionOperation, state })).toMatchObject({ stage: "not_dispatched", receipt: { state } });
  });
  it.each([{ executionGeneration: "10" }, { testExecutionId: workerId }, { operationId: botId }])("does not apply another Session fence or operation: %j", async changes => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ operation: { ...sessionOperation, ...changes } }));
    expect(await run(input, fetch)).toMatchObject({ kind: "pending" });
  });
  it("reads the original Task Session operation even when its current binding changed", async () => {
    const { testExecutionId: _, ...rest } = sessionOperation;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ operation: { ...rest, claimId: executionId }, currentBinding: false }));
    expect(await run({ kind: "watchdog_input", projectId: userId, taskId: assistantTaskId, sessionId, claimId: executionId, executionGeneration: "9" }, fetch)).toMatchObject({ kind: "settled", receipt: { claimId: executionId } });
    expect(String(fetch.mock.calls[0]![0])).toBe(`${identity.serverOrigin}/api/v1/projects/${userId}/tasks/${assistantTaskId}/sessions/${sessionId}/operations/${operationId}`);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET" });
  });
  it("matches ackOperationId on the original event across read pages", async () => {
    const event = { id: executionId, taskId: assistantTaskId, targetBotId: botId, type: "trigger", payload: { text: "Not a receipt" }, state: "delivered", attention: false, createdAt: now, deliveredAt: now, seenAt: null, ackOperationId: operationId };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ items: [], nextCursor: "next", observedAt: now })).mockResolvedValueOnce(response({ items: [event], nextCursor: null, observedAt: now }));
    expect(await run({ kind: "assistant_api", method: "ackEvent", assistantTaskId, botId, eventId: executionId, eventState: "delivered" }, fetch)).toMatchObject({ kind: "settled", receipt: { kind: "assistant_event_ack", operationId, eventId: executionId } });
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
  });
  it("retains a matching event with another ack operation", async () => {
    const event = { id: executionId, taskId: assistantTaskId, targetBotId: botId, type: "trigger", payload: {}, state: "delivered", attention: false, createdAt: now, deliveredAt: now, seenAt: null, ackOperationId: workerId };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ items: [event], nextCursor: null, observedAt: now }));
    expect(await run({ kind: "assistant_api", method: "ackEvent", assistantTaskId, botId, eventId: executionId, eventState: "delivered" }, fetch)).toEqual({ kind: "pending", reasonCode: "receipt_conflict" });
  });
  it("matches the original inbox operation fingerprint without enabling or rotating it", async () => {
    const operation = { operationId, kind: "inbox_disable", taskId: assistantTaskId, requestFingerprint, admittedAt: now, resultingVersion: "9" };
    const inbox = { inboxId: null, enabled: false, createdAt: null, rotatedAt: null, overlapUntil: null, suppressedCount: "0" };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ operation, inbox }));
    expect(await run({ kind: "assistant_api", method: "disableInbox", assistantTaskId, botId: null, inboxKind: "inbox_disable", requestFingerprint }, fetch)).toMatchObject({ kind: "settled", receipt: { operation } });
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET" });
  });
  it("returns pending after cancellation without another result query", async () => {
    const cancellation = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => { cancellation.abort(); return new Promise<Response>(() => {}); });
    expect(await reconcileLifecycleRequest({ resource: resource(input), identity, serverToken: "fixture-token", signal: cancellation.signal, fetch })).toEqual({ kind: "pending", reasonCode: "receipt_unavailable" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("does not infer non-submission from a missing original operation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code: "not_found", message: "Absent", requestId: operationId } }, 404));
    expect(await run(input, fetch)).toEqual({ kind: "pending", reasonCode: "receipt_unavailable" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
