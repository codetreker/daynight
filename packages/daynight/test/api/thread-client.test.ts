import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation } from "../../src/api/index.js";
import type { Operation, ThreadMessage } from "../../src/api/index.js";

const projectId = "abcdefab-1111-4111-8111-111111111111";
const taskId = "abcdefab-2222-4222-8222-222222222222";
const userId = "abcdefab-3333-4333-8333-333333333333";
const otherUserId = "abcdefab-4444-4444-8444-444444444444";
const messageId = "abcdefab-5555-4555-8555-555555555555";
const replyId = "abcdefab-6666-4666-8666-666666666666";
const claimId = "abcdefab-7777-4777-8777-777777777777";
const body = "  Complete <body>\n\tsecond line  \n";
const message: ThreadMessage = { id: messageId, author: { userId, displayName: null, Agent: false }, body, createdAt: "2026-11-03T10:20:30.000Z" };
const page = { items: [message], hasMoreBefore: true, hasMoreAfter: false };
const operations: Operation[] = [];
const json = (value: unknown, status = 200, principal: string | null = userId): Response => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) },
});
const errorResponse = (status: number, code: string): Response => json({ error: { code, message: "The request failed.", requestId: "thread-request" } }, status, null);
const client = (fetch: typeof globalThis.fetch, options: { signal?: AbortSignal; expectedUserId?: string; requestMs?: number } = {}) => {
  const operation = createOperation({ ...(options.signal === undefined ? {} : { signal: options.signal }), ...(options.requestMs === undefined ? {} : { limits: { requestMs: options.requestMs } }) });
  operations.push(operation);
  return createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch, ...(options.expectedUserId === undefined ? {} : { expectedUserId: options.expectedUserId }) });
};
afterEach(() => { operations.splice(0).forEach((operation) => operation.dispose()); });

describe("Thread client transport and identity", () => {
  it("performs one scoped no-store GET with the explicit page query and never follows flags", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(page));
    const result = await client(fetch).readTaskThread(projectId.toUpperCase(), taskId.toUpperCase(), { count: 20, details: false, beforeId: replyId.toUpperCase() });
    expect(result).toEqual(page);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/thread/messages?count=20&details=false&beforeId=${replyId}`);
    expect(options).toMatchObject({ method: "GET", cache: "no-store", redirect: "manual" });
    expect(options!.headers).toMatchObject({ Authorization: "Bearer fixture-token" });
  });

  it("preserves body whitespace and sends only the supplied reply and claim fields once", async () => {
    const result = { ...message, replyTo: replyId, author: { ...message.author, Agent: true } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(result, 201));
    expect(await client(fetch).postTaskThreadMessage(projectId, taskId, { body, replyTo: replyId.toUpperCase(), claimId: claimId.toUpperCase() })).toEqual(result);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/thread/messages`);
    expect(options).toMatchObject({ method: "POST", cache: "no-store" });
    expect(JSON.parse(String(options!.body))).toEqual({ body, replyTo: replyId, claimId });
  });

  it("omits optional post fields and accepts ordinary account provenance", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(message, 201));
    expect(await client(fetch).postTaskThreadMessage(projectId, taskId, { body })).toEqual(message);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ body });
  });

  it("admits historical GET authors independently of the response reader", async () => {
    const historical = { ...message, author: { ...message.author, userId: otherUserId } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...page, items: [historical] }));
    expect((await client(fetch, { expectedUserId: userId }).readTaskThread(projectId, taskId, { count: 20, details: false })).items[0]!.author.userId).toBe(otherUserId);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([null, "invalid", userId.toUpperCase()])("rejects a noncanonical success principal header: %s", async (principal) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(page, 200, principal));
    await expect(client(fetch).readTaskThread(projectId, taskId, { count: 20, details: false })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a response principal that differs from an already known account without querying /me", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(message, 201));
    await expect(client(fetch, { expectedUserId: otherUserId }).postTaskThreadMessage(projectId, taskId, { body })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { author: { ...message.author, userId: otherUserId } },
    { author: { ...message.author, Agent: true } },
    { body: body.trim() },
    { replyTo: replyId },
  ])("does not confirm a resource inconsistent with the submitted content or author: %#", async (changes) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...message, ...changes }, 201));
    await expect(client(fetch).postTaskThreadMessage(projectId, taskId, { body })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not confirm Agent=false when a claim was explicitly supplied", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(message, 201));
    await expect(client(fetch).postTaskThreadMessage(projectId, taskId, { body, claimId })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
  });
});

describe("Thread posting outcome classification", () => {
  it.each([
    { status: 400, code: "invalid_input", confirmed: true },
    { status: 401, code: "unauthenticated", confirmed: true },
    { status: 403, code: "forbidden", confirmed: true },
    { status: 404, code: "message_not_found", confirmed: true },
    { status: 409, code: "claim_conflict", confirmed: true },
    { status: 410, code: "task_deleted", confirmed: true },
    { status: 413, code: "payload_too_large", confirmed: true },
    { status: 503, code: "clock_not_advanced", confirmed: true },
    { status: 503, code: "message_outcome_unknown", confirmed: false },
    { status: 500, code: "internal_error", confirmed: false },
    { status: 502, code: "upstream_failure", confirmed: false },
  ])("classifies a complete $status/$code response without replay or requiring a success principal", async ({ status, code, confirmed }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(errorResponse(status, code));
    await expect(client(fetch).postTaskThreadMessage(projectId, taskId, { body })).rejects.toMatchObject({ status, code, requestId: "thread-request", confirmedRefusal: confirmed, outcomeUnconfirmed: !confirmed });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 201, source: '{"id":' },
    { status: 201, source: JSON.stringify({ ...message, createdAt: "2026-11-03T10:20:30Z" }) },
    { status: 503, source: '{"error":{"code":"clock_not_advanced","code":"clock_not_advanced","message":"failed","requestId":"request"}}' },
    { status: 400, source: '{"error":{"code":"invalid_input"}}' },
  ])("keeps malformed dispatched responses unknown: $status/$source", async ({ status, source }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(source, { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }));
    await expect(client(fetch).postTaskThreadMessage(projectId, taskId, { body })).rejects.toMatchObject({ outcomeUnconfirmed: true, confirmedRefusal: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not confirm HTTP 201 without the canonical response principal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(message, 201, null));
    await expect(client(fetch).postTaskThreadMessage(projectId, taskId, { body })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
  });

  it("keeps dispatched transport failure unknown with its original cause", async () => {
    const cause = new TypeError("Connection lost after request dispatch");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(cause);
    await expect(client(fetch).postTaskThreadMessage(projectId, taskId, { body })).rejects.toMatchObject({ phase: "request", outcomeUnconfirmed: true, cause });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps an interrupted response body unknown", async () => {
    const cause = new Error("Response stream interrupted");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(cause); } }), { status: 201, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }));
    await expect(client(fetch).postTaskThreadMessage(projectId, taskId, { body })).rejects.toMatchObject({ phase: "response", outcomeUnconfirmed: true, cause });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps cancellation after dispatch unknown and never replays", async () => {
    const controller = new AbortController();
    let dispatched: () => void = () => {};
    const ready = new Promise<void>((resolve) => { dispatched = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>((_url, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
      dispatched();
    }));
    const pending = client(fetch, { signal: controller.signal }).postTaskThreadMessage(projectId, taskId, { body });
    await ready;
    controller.abort(new Error("Caller stopped"));
    await expect(pending).rejects.toMatchObject({ outcomeUnconfirmed: true, cause: { kind: "cancelled" } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reports cancellation before dispatch as not submitted", async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(client(fetch, { signal: controller.signal }).postTaskThreadMessage(projectId, taskId, { body })).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a dispatched request deadline unknown and cancels its single fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_url, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    }));
    await expect(client(fetch, { requestMs: 20 }).postTaskThreadMessage(projectId, taskId, { body })).rejects.toMatchObject({ outcomeUnconfirmed: true, cause: { kind: "request_timeout" } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it("enforces the Thread success response bound before accepting a message", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...message, body: "x".repeat(65536) }, 201));
    await expect(client(fetch).postTaskThreadMessage(projectId, taskId, { body })).rejects.toMatchObject({ outcomeUnconfirmed: true, cause: { kind: "response_limit" } });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
