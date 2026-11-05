import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation } from "../../src/api/index.js";
import type { Operation, OperationLimits } from "../../src/api/index.js";
import { parseServerError } from "../../src/api/parse.js";

// Captured from the server's real HTTP contract test, including its cursor and errors.
const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`../../../daynight-server/testdata/task-search/${name}.json`, import.meta.url), "utf8"));
const first = fixture("first-page"), next = fixture("next-page"), empty = fixture("empty-page");
const projectId = first.projectId as string;
const userId = "459052e2-186f-4a52-8a58-55425ce43631";
const otherUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operations: Operation[] = [];
const json = (body: unknown, status = 200, principal: string | null = userId): Response => source(JSON.stringify(body), status, principal);
const source = (body: string, status = 200, principal: string | null = userId): Response => new Response(body, { status, headers: { "Content-Type": "application/json", ...(principal === null ? {} : { "Daynight-User-ID": principal }) } });
const api = (fetch: typeof globalThis.fetch, options: { limits?: Partial<OperationLimits>; signal?: AbortSignal; expectedUserId?: string } = {}) => {
  const operation = createOperation({ ...(options.limits === undefined ? {} : { limits: options.limits }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
  operations.push(operation);
  return createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch, ...(options.expectedUserId === undefined ? {} : { expectedUserId: options.expectedUserId }) });
};
afterEach(() => { operations.splice(0).forEach((operation) => operation.dispose()); });

describe("task search HTTP contract", () => {
  it("consumes captured pages in server order with an unchanged expression and all filters", async () => {
    const query = '  title:"缓存 😀 \\"x\\"" OR description:"a\\\\b"  ';
    const page = (value: any) => ({ ...value, items: value.items.map((item: any) => ({ ...item, status: "done", assignedTo: userId, futureField: "not projected" })) });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(page(first))).mockResolvedValueOnce(json(page(next)));
    const result = await api(fetch).searchTasks(projectId.toUpperCase(), { query, status: "done", assignedTo: "me", ready: true, allowAgents: false, compatiblePlatform: "linux" });
    expect(result).toEqual([first.items[0], next.items[0]].map(({ id, projectId, title, context, match }: any) => ({ id, projectId, title, status: "done", context, match })));
    const requests = fetch.mock.calls.map(([url, init]) => ({ url: String(url), method: init!.method, cache: init!.cache, body: JSON.parse(String(init!.body)) }));
    expect(requests).toEqual([first, next].map((_, index) => ({ url: `http://localhost:8787/api/v1/projects/${projectId}/tasks/search`, method: "POST", cache: "no-store", body: { query, assignedTo: "me", status: "done", ready: true, allowAgents: false, compatiblePlatform: "linux", limit: 100, ...(index === 0 ? {} : { cursor: first.nextCursor }) } })));
  });
  it("returns the captured empty page and keeps ordinary search default status unfiltered", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(empty));
    expect(await api(fetch).searchTasks(projectId, { query: "absent" })).toEqual([]);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ query: "absent", limit: 100 });
  });
  const syntaxCases = [
    ["expected_operand", "中文 AND"], ["unexpected_token", 'x"y"'], ["unexpected_closing_group", "中文 )"],
    ["unclosed_group", "中文 (x"], ["unclosed_quote", '中文 "x'], ["empty_phrase", '中文 ""'],
    ["invalid_escape", '中文 "a\\qb"'], ["unknown_field", "中文 status:done"], ["missing_field_value", "title:"],
    ["field_group_not_supported", "title:(x)"], ["query_too_large", "a".repeat(8193)],
    ["too_many_terms", "a ".repeat(128) + "b"], ["nesting_too_deep", "(".repeat(33) + "x" + ")".repeat(33)],
  ] as const;
  it.each(syntaxCases)("retains the captured %s reason and Unicode position", async (reason, query) => {
    const error = fixture(`syntax-${reason}`);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(error, 400));
    await expect(api(fetch).searchTasks(projectId, { query })).rejects.toMatchObject({ status: 400, code: "invalid_search_expression", details: error.error.details, outcomeUnconfirmed: false });
  });
  it("decodes the captured empty-query error even though this client rejects blank input locally", () => {
    expect(parseServerError(fixture("syntax-empty_query")).details).toEqual({ reason: "empty_query", position: 1, length: 0 });
  });
  it.each([["search-changed", 409, "search_changed"], ["context-limit", 400, "search_context_limit_exceeded"], ["timeout", 504, "search_timeout"], ["invalid-input", 400, "invalid_input"]] as const)("exposes captured %s as a read failure", async (name, status, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(fixture(name), status));
    await expect(api(fetch).searchTasks(projectId, { query: "cache" })).rejects.toMatchObject({ status, code, outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { ...first, projectId: otherUserId }, { ...first, items: [{ ...first.items[0], projectId: otherUserId }] },
    { ...first, total: "2" }, { ...first, total: -1 }, { ...first, items: null }, { ...first, nextCursor: 3 },
    { ...first, items: [{ ...first.items[0], context: {} }] }, { ...first, items: [{ ...first.items[0], match: { fields: ["description"], descriptionSnippet: null } }] },
    { ...first, items: [{ ...first.items[0], match: { fields: ["description", "title"], descriptionSnippet: "match" } }] },
    { ...first, items: [{ ...first.items[0], match: { fields: ["title", "title"], descriptionSnippet: null } }] },
    { ...first, items: [{ ...first.items[0], assignedTo: undefined }] }, { ...first, items: [{ ...first.items[0], updatedAt: "invalid" }] },
  ])("rejects malformed or mismatched search page %#", async (page) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(page));
    await expect(api(fetch).searchTasks(projectId, { query: "cache" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
  });
  it.each([
    JSON.stringify(first).replace('"total":2', '"total":2.0'),
    JSON.stringify(first).replace('"total":2', '"total":2e0'),
    JSON.stringify(first).replace('"total":2', '"total":2,"total":2'),
  ])("rejects non-integral-source or duplicate total %#", async (body) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(source(body));
    await expect(api(fetch).searchTasks(projectId, { query: "cache" })).rejects.toMatchObject({ phase: "protocol" });
  });
  it.each([
    { reason: "unclosed_group", position: 8 }, { reason: "unknown", position: 8, length: 1 },
    { reason: "unclosed_group", position: 0, length: 1 }, { reason: "unclosed_group", position: 100, length: 1 },
    { reason: "unclosed_group", position: 8, length: 1, extra: true },
  ])("rejects malformed syntax details %#", async (details) => {
    const bad = fixture("invalid-expression"); bad.error.details = details;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(bad, 400));
    await expect(api(fetch).searchTasks(projectId, { query: "缓存 AND (" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
  });
  it("rejects extra capacity details and non-integer syntax positions", async () => {
    const limit = fixture("context-limit"); limit.error.details.extra = 1;
    const badPosition = JSON.stringify(fixture("invalid-expression")).replace('"position":8', '"position":8.0');
    for (const response of [json(limit, 400), source(badPosition, 400)]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      await expect(api(fetch).searchTasks(projectId, { query: "缓存 AND (" })).rejects.toMatchObject({ phase: "protocol" });
    }
  });
  it.each([
    { ...next, items: [{ ...next.items[0], id: first.items[0].id }] },
    { ...next, total: 3 }, { ...next, items: [], nextCursor: null },
    { ...next, total: 3, nextCursor: first.nextCursor },
  ])("rejects duplicate or inconsistent continuation %#", async (second) => {
    const initial = second.nextCursor === first.nextCursor ? { ...first, total: 3 } : first;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(initial)).mockResolvedValueOnce(json(second));
    await expect(api(fetch).searchTasks(projectId, { query: "cache" })).rejects.toMatchObject({ phase: "pagination" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([null, otherUserId, userId.toUpperCase()])("rejects missing or changed continuation principal %s", async (principal) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(first)).mockResolvedValueOnce(json(next, 200, principal));
    await expect(api(fetch).searchTasks(projectId, { query: "cache" })).rejects.toMatchObject({ phase: "protocol" });
  });
  it("rejects a changed principal on a continuation error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(first)).mockResolvedValueOnce(json(fixture("search-changed"), 409, otherUserId));
    await expect(api(fetch).searchTasks(projectId, { query: "cache" })).rejects.toMatchObject({ phase: "protocol" });
  });
  it("preserves authentication failures without a principal while requiring one for search errors", async () => {
    for (const [status, code] of [[500, "internal_error"], [401, "unauthenticated"], [403, "forbidden"]] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code, message: "Authentication failed.", requestId: "auth" } }, status, null));
      await expect(api(fetch).searchTasks(projectId, { query: "cache" })).rejects.toMatchObject({ phase: "response", code, status, outcomeUnconfirmed: false });
    }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(first)).mockResolvedValueOnce(json(fixture("search-changed"), 409, null));
    await expect(api(fetch).searchTasks(projectId, { query: "cache" })).rejects.toMatchObject({ phase: "protocol" });
  });
  it("propagates a middle-page failure without replaying the POST", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(first)).mockRejectedValueOnce(new Error("network down"));
    await expect(api(fetch).searchTasks(projectId, { query: "cache" })).rejects.toMatchObject({ phase: "request", outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("cancels the second page and does not retry", async () => {
    const cancellation = new AbortController();
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(first)).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); started();
    }));
    const pending = api(fetch, { signal: cancellation.signal }).searchTasks(projectId, { query: "cache" });
    await ready; cancellation.abort();
    await expect(pending).rejects.toMatchObject({ outcomeUnconfirmed: false, cause: { kind: "cancelled" } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("bounds a stalled request without retrying the read-only POST", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    await expect(api(fetch, { limits: { requestMs: 20 } }).searchTasks(projectId, { query: "cache" })).rejects.toMatchObject({ outcomeUnconfirmed: false, cause: { kind: "request_timeout" } });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("enforces single response and shared total byte budgets", async () => {
    const firstBytes = Buffer.byteLength(JSON.stringify(first)), nextBytes = Buffer.byteLength(JSON.stringify(next));
    const responseLimit = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(first));
    await expect(api(responseLimit, { limits: { responseBytes: firstBytes - 1 } }).searchTasks(projectId, { query: "cache" })).rejects.toMatchObject({ cause: { kind: "response_limit" } });
    const totalLimit = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(first)).mockResolvedValueOnce(json(next));
    await expect(api(totalLimit, { limits: { totalBytes: firstBytes + nextBytes - 1 } }).searchTasks(projectId, { query: "cache" })).rejects.toMatchObject({ cause: { kind: "total_limit" } });
    expect(totalLimit).toHaveBeenCalledTimes(2);
  });
});
