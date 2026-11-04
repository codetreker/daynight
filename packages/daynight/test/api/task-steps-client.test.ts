import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";
import type { OperationLimits, StepResource, StepsResource } from "../../src/api/index.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333";
const otherId = "dddddddd-4444-4444-8444-444444444444";
const step = { id: "00abcdef", title: "  Full title😀  ", description: "# Markdown\n\"\\\u2028", status: "skipped" as const, createdAt: "2026-11-03T10:11:12.123456Z", updatedAt: "2026-11-03T10:12:13Z" };
const collection: StepsResource = { projectId, taskId, version: 9_007_199_254_740_993n, steps: [step] };
const item: StepResource = { projectId, taskId, version: collection.version, step };
const disposals: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });
const json = (value: unknown, status = 200, principal = userId) => new Response(`${stringifyApiJson(value)}\n`, { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": principal } });
const fixture = (fetch: typeof globalThis.fetch, limits?: Partial<OperationLimits>) => {
  const operation = createOperation(limits === undefined ? {} : { limits }); disposals.push(() => operation.dispose());
  return { operation, api: createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch }) };
};

describe("typed Task Steps HTTP reads", () => {
  it("performs one authenticated no-store collection GET without scope pre-reads or queries", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(collection));
    expect(await fixture(fetch).api.listTaskSteps(projectId.toUpperCase(), taskId.toUpperCase())).toEqual(collection);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/steps`);
    expect(options).toMatchObject({ method: "GET", cache: "no-store", redirect: "manual", headers: { Authorization: "Bearer fixture-token", Accept: "application/json" } });
    expect(options!.body).toBeUndefined();
  });
  it("reads only the canonical requested eight-hex item and preserves complete Markdown and int64", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(item));
    expect(await fixture(fetch).api.getTaskStep(projectId, taskId, "00ABCDEF")).toEqual(item);
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]![0])).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/steps/00abcdef`);
  });
  it("accepts actual explicit empty arrays and the maximum parent int64", async () => {
    const expected = { ...collection, version: 9_223_372_036_854_775_807n, steps: [] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(expected));
    expect(await fixture(fetch).api.listTaskSteps(projectId, taskId)).toEqual(expected);
  });
  it.each(["", "abc", "000000000", "0000000g", taskId])("does not dispatch invalid short input identity %s", (stepId) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => fixture(fetch).api.getTaskStep(projectId, taskId, stepId)).toThrow("Step ID must contain exactly eight hexadecimal characters.");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([undefined, "", userId.toUpperCase(), otherId + "x"])("requires a canonical authenticated success principal %#", async (principal) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" }; if (principal !== undefined) headers["Daynight-User-ID"] = principal;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stringifyApiJson(collection), { headers }));
    await expect(fixture(fetch).api.listTaskSteps(projectId, taskId)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects a mismatched expected principal", async () => {
    const operation = createOperation(); disposals.push(() => operation.dispose());
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(collection));
    const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch, expectedUserId: otherId });
    await expect(api.listTaskSteps(projectId, taskId)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
  });
  it.each([
    { ...collection, projectId: otherId }, { ...collection, taskId: otherId }, { ...collection, steps: null }, { ...collection, steps: [step, step] },
    { ...collection, steps: [{ ...step, id: "00ABCDEF" }] }, { ...collection, steps: [{ ...step, description: undefined }] },
    { ...collection, version: 1.5 }, { ...collection, steps: [{ ...step, createdAt: "2026-11-03T10:11:12.1234567Z" }] },
  ])("rejects a broken whole resource rather than returning an empty array %#", async (value) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(value));
    await expect(fixture(fetch).api.listTaskSteps(projectId, taskId)).rejects.toMatchObject({ operation: "task.step.list", phase: "protocol", outcomeUnconfirmed: false });
  });
  it("rejects a different Task-local item without losing the requested show identity", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...item, step: { ...step, id: "00000000" } }));
    await expect(fixture(fetch).api.getTaskStep(projectId, taskId, "00ABCDEF")).rejects.toMatchObject({ operation: "task.step.show", stepId: "00abcdef", phase: "protocol", outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects invalid Project and Task UUIDs before any read dispatch", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const { api } = fixture(fetch);
    expect(() => api.listTaskSteps("bad", taskId)).toThrow("Resource ID must be a hyphenated UUID.");
    expect(() => api.getTaskStep(projectId, "bad", step.id)).toThrow("Resource ID must be a hyphenated UUID.");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains show identity and response code/message/requestId/details separately from arbitrary causes", async () => {
    const message = "The Step is unavailable.\nUse the selected task.";
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code: "not_found", message, requestId: "steps-show-refusal", details: { taskIds: [taskId] } } }, 404));
    const error = await fixture(fetch).api.getTaskStep(projectId, taskId, "00ABCDEF").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ operation: "task.step.show", projectId, taskId, stepId: "00abcdef", serverMessage: message, status: 404, code: "not_found", requestId: "steps-show-refusal", details: { taskIds: [taskId] }, outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([{ status: 401, code: "unauthenticated" }, { status: 404, code: "not_found" }, { status: 410, code: "task_deleted" }, { status: 501, code: "not_implemented" }, { status: 500, code: "internal_error" }])("retains public HTTP $status/$code and never replays", async ({ status, code }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code, message: "Read was refused", requestId: "steps-refusal" } }, status));
    await expect(fixture(fetch).api.listTaskSteps(projectId, taskId)).rejects.toMatchObject({ status, code, requestId: "steps-refusal", serverMessage: "Read was refused", outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    new Response("<html>Unavailable</html>", { status: 404, headers: { "Content-Type": "text/html" } }),
    new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }),
    new Response(stringifyApiJson(collection).replace('"steps":', '"steps":[],"steps":'), { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }),
    new Response(stringifyApiJson(collection).replace('"id":"00abcdef"', '"id":"00abcdef","\\u0069d":"00000000"'), { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }),
  ])("uses the existing fatal bounded decoder and rejects invalid wire source %#", async (response) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    await expect(fixture(fetch).api.listTaskSteps(projectId, taskId)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
  });
  it.each(["list", "show"] as const)("accepts exact existing budgets and rejects one-byte-short response/total limits for %s", async (kind) => {
    const resource = kind === "list" ? collection : item;
    const bytes = Buffer.byteLength(`${stringifyApiJson(resource)}\n`, "utf8");
    const read = (api: ReturnType<typeof fixture>["api"]) => kind === "list" ? api.listTaskSteps(projectId, taskId) : api.getTaskStep(projectId, taskId, step.id);
    const exactFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(resource));
    expect(await read(fixture(exactFetch, { responseBytes: bytes, totalBytes: bytes }).api)).toEqual(resource);
    expect(exactFetch).toHaveBeenCalledOnce();
    for (const [limits, error] of [
      [{ responseBytes: bytes - 1, totalBytes: bytes }, "response_limit"],
      [{ responseBytes: bytes, totalBytes: bytes - 1 }, "total_limit"],
    ] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(resource));
      await expect(read(fixture(fetch, limits).api)).rejects.toMatchObject({ outcomeUnconfirmed: false, cause: expect.objectContaining({ kind: error }) });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
  it("does not dispatch after operation cancellation and retains read classification", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const { api, operation } = fixture(fetch); operation.dispose();
    await expect(api.listTaskSteps(projectId, taskId)).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("cancels a real delayed body within the unchanged request budget", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json", "Daynight-User-ID": userId }); response.write('{"projectId":');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    disposals.push(() => new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); }));
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing test listener");
    const operation = createOperation({ limits: { requestMs: 40 } }); disposals.push(() => operation.dispose());
    const api = createApiClient({ serverUrl: `http://127.0.0.1:${address.port}`, operation });
    await expect(api.listTaskSteps(projectId, taskId)).rejects.toMatchObject({ outcomeUnconfirmed: false, cause: expect.objectContaining({ kind: "request_timeout" }) });
  });
});
