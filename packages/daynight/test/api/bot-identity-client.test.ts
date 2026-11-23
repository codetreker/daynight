import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation } from "../../src/api/index.js";
import type { ApiClient, Operation } from "../../src/api/index.js";

const projectId = "abcdefab-1111-4111-8111-111111111111";
const taskId = "abcdefab-2222-4222-8222-222222222222";
const claimId = "abcdefab-3333-4333-8333-333333333333";
const botId = "abcdefab-4444-4444-8444-444444444444";
const operations: Operation[] = [];
afterEach(() => { operations.splice(0).forEach((operation) => operation.dispose()); });

// A confirmed refusal ends every operation after its first request, so each
// case observes exactly the headers of the request it issued.
const refusal = (): Response => new Response(JSON.stringify({ error: { code: "conflict", message: "The request failed.", requestId: "bot-request" } }), { status: 409, headers: { "Content-Type": "application/json" } });
const client = (fetch: typeof globalThis.fetch, bot?: string): ApiClient => {
  const operation = createOperation({});
  operations.push(operation);
  return createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch, ...(bot === undefined ? {} : { botId: bot }) });
};
const sentHeaders = async (call: (api: ApiClient) => Promise<unknown>, bot: string | null = botId): Promise<Record<string, string>[]> => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => refusal());
  await expect(call(client(fetch, bot ?? undefined))).rejects.toThrow();
  expect(fetch).toHaveBeenCalled();
  return fetch.mock.calls.map(([, init]) => init!.headers as Record<string, string>);
};

const writes: readonly [string, (api: ApiClient) => Promise<unknown>][] = [
  ["create Task", (api) => api.createTask(projectId, { title: "Title", assignedTo: null })],
  ["update Task", (api) => api.updateTask(projectId, taskId, { version: 1n, title: "Title" })],
  ["delete Task", (api) => api.deleteTask(projectId, taskId, { version: 1n })],
  ["set Task status", (api) => api.setTaskStatus(projectId, taskId, { version: 1n, status: "todo" })],
  ["complete claimed Task", (api) => api.completeWorkerTask(projectId, taskId, { version: 1n, claimId })],
  ["set Task property", (api) => api.setTaskProperty(projectId, taskId, "pullRequests", { version: 1n, valueText: "[]" })],
  ["remove Task property", (api) => api.removeTaskProperty(projectId, taskId, "pullRequests", { version: 1n })],
  ["post Thread message", (api) => api.postTaskThreadMessage(projectId, taskId, { body: "Body" })],
];
const others: readonly [string, (api: ApiClient) => Promise<unknown>][] = [
  ["show Task", (api) => api.getTask(projectId, taskId)],
  ["read Thread", (api) => api.readTaskThread(projectId, taskId, { count: 20, details: false })],
  ["remove attachment", (api) => api.removeTaskAttachment(projectId, taskId, "notes.txt")],
];

describe("Bot identity on Task and Thread requests", () => {
  it.each(writes)("declares the Bot when it is configured: %s", async (_name, call) => {
    const headers = await sentHeaders(call);
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatchObject({ "X-Daynight-Bot-Id": botId, Authorization: "Bearer fixture-token" });
  });

  it.each(writes)("sends no Bot declaration without a configured Bot: %s", async (_name, call) => {
    for (const headers of await sentHeaders(call, null)) expect(headers).not.toHaveProperty("X-Daynight-Bot-Id");
  });

  it.each(others)("never declares the Bot on reads or other resources: %s", async (_name, call) => {
    for (const headers of await sentHeaders(call)) expect(headers).not.toHaveProperty("X-Daynight-Bot-Id");
  });

  it.each([botId.toUpperCase(), `{${botId}}`, "00000000-0000-0000-0000-000000000000", "", "not-a-uuid"])("rejects the noncanonical Bot identity %j before any request", (value) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => client(fetch, value)).toThrow("Expected a nonzero canonical lowercase UUID.");
    expect(fetch).not.toHaveBeenCalled();
  });
});
