import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation, type Operation } from "../../src/api/operation.js";
import { AssistantTaskApiError, createAssistantTaskClient, parseAssistantTaskInbox, parseAssistantTaskInboxResult } from "../../src/api/assistant-task.js";
import { ProtocolError } from "../../src/api/validation.js";

const owner = "11111111-1111-4111-8111-111111111111", taskId = "22222222-2222-4222-8222-222222222222", operationId = "33333333-3333-4333-8333-333333333333", inboxId = "44444444-4444-4444-8444-444444444444";
const now = "2026-11-19T10:00:00.123456Z";
const token = `dnib_${Buffer.alloc(32, 7).toString("base64url")}`;
const fingerprint = "a".repeat(64);
const inbox = { inboxId, enabled: true, createdAt: now, rotatedAt: null, overlapUntil: null, suppressedCount: "9007199254740993" };
const disabled = { inboxId: null, enabled: false, createdAt: null, rotatedAt: null, overlapUntil: null, suppressedCount: "0" };
const operation = (kind: string) => ({ operationId, kind, taskId, requestFingerprint: fingerprint, admittedAt: now, resultingVersion: "8" });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": owner } });
const operations: Operation[] = [];
afterEach(() => { operations.splice(0).forEach(o => o.dispose()); vi.restoreAllMocks(); });
const setup = (fetch: typeof globalThis.fetch) => {
  const op = createOperation(); operations.push(op);
  return createAssistantTaskClient({ serverUrl: "http://localhost:3000", serverToken: "dnpat_fixture", expectedUserId: owner, operation: op, fetch });
};

describe("assistant task inbox contracts", () => {
  it("accepts enabled and disabled states and rejects inconsistent or secret-bearing ones", () => {
    expect(parseAssistantTaskInbox(inbox)).toEqual(inbox);
    expect(parseAssistantTaskInbox(disabled)).toEqual(disabled);
    for (const value of [{ ...inbox, inboxId: null }, { ...inbox, createdAt: null }, { ...disabled, inboxId }, { ...disabled, suppressedCount: "1" }, { ...inbox, suppressedCount: 1 }, { ...inbox, token }, { ...inbox, enabled: "true" }]) {
      expect(() => parseAssistantTaskInbox(value)).toThrow(ProtocolError);
    }
  });
  it("binds receipts to the submitted action and allows a token only where generated", () => {
    expect(parseAssistantTaskInboxResult({ operation: operation("inbox_rotate_overlap"), inbox, token }, taskId, operationId, "rotate", true).token).toBe(token);
    expect(parseAssistantTaskInboxResult({ operation: operation("inbox_enable"), inbox, token: null }, taskId, operationId, "enable", true).token).toBeNull();
    expect(parseAssistantTaskInboxResult({ operation: operation("inbox_disable"), inbox: disabled }, taskId, operationId).operation.kind).toBe("inbox_disable");
    for (const [value, expected, withToken] of [
      [{ operation: operation("inbox_enable"), inbox }, "enable", true],
      [{ operation: operation("inbox_enable"), inbox, token: "plain" }, "enable", true],
      [{ operation: operation("inbox_disable"), inbox: disabled, token: null }, "disable", false],
      [{ operation: operation("inbox_disable"), inbox: disabled }, "enable", false],
      [{ operation: operation("claim"), inbox: disabled }, undefined, false],
      [{ operation: { ...operation("inbox_enable"), taskId: inboxId }, inbox }, undefined, false],
      [{ operation: { ...operation("inbox_enable"), requestFingerprint: "x" }, inbox }, undefined, false],
    ] as const) expect(() => parseAssistantTaskInboxResult(value, taskId, operationId, expected, withToken)).toThrow(ProtocolError);
  });
});

describe("assistant task inbox HTTP client", () => {
  it("sends exact management requests to the inbox routes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(inbox))
      .mockResolvedValueOnce(response({ operation: operation("inbox_enable"), inbox, token }))
      .mockResolvedValueOnce(response({ operation: operation("inbox_rotate_immediate"), inbox, token }))
      .mockResolvedValueOnce(response({ operation: operation("inbox_disable"), inbox: disabled }))
      .mockResolvedValueOnce(response({ operation: operation("inbox_enable"), inbox }));
    const client = setup(fetch);
    expect(await client.getInbox(taskId)).toEqual(inbox);
    expect((await client.enableInbox(taskId, { operationId, ifVersion: "7" })).token).toBe(token);
    expect((await client.rotateInbox(taskId, { operationId, ifVersion: "8", mode: "immediate" })).operation.kind).toBe("inbox_rotate_immediate");
    expect(await client.disableInbox(taskId, { operationId, ifVersion: "9" })).toEqual({ operation: operation("inbox_disable"), inbox: disabled });
    expect(await client.getInboxOperation(taskId, operationId)).not.toHaveProperty("token");
    const calls = fetch.mock.calls.map(([url, init]) => [String(url).replace("http://localhost:3000/api/v1/assistant-tasks/" + taskId, ""), init?.method, init?.body === undefined ? undefined : JSON.parse(init.body as string)]);
    expect(calls).toEqual([
      ["/inbox", "GET", undefined],
      ["/inbox/enable", "POST", { operationId, ifVersion: "7" }],
      ["/inbox/rotate", "POST", { operationId, ifVersion: "8", mode: "immediate" }],
      ["/inbox/disable", "POST", { operationId, ifVersion: "9" }],
      [`/inbox-operations/${operationId}`, "GET", undefined],
    ]);
  });
  it("reports refused management with its fixed code", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code: "invalid_transition", message: "already enabled", requestId: operationId } }, 409));
    const error = await setup(fetch).enableInbox(taskId, { operationId, ifVersion: "7" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AssistantTaskApiError);
    expect(error).toMatchObject({ code: "invalid_transition", status: 409, outcomeUnconfirmed: false, confirmedRefusal: true });
  });
});
