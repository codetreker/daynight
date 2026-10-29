import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../src/api/index.js";
import type { Operation } from "../../src/api/index.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const prefix = `/api/v1/projects/${projectId}/tasks/${taskId}/properties`;
const source = '{ "version":"9223372036854775807", "properties":{"future":{"version":-0,"count":900719925474099312345,"exponent":1e999},"worker":{"newField":true}} }\n';
const response = (body = source) => new Response(body, { headers: { "Content-Type": "application/json" } });
const operations: Operation[] = [];
const operation = (options: Parameters<typeof createOperation>[0] = {}) => {
  const current = createOperation(options); operations.push(current); return current;
};
const client = (fetch: typeof globalThis.fetch, current = operation()) => createApiClient({ serverUrl: "http://localhost", fetch, operation: current });
afterEach(() => { operations.splice(0).forEach((current) => current.dispose()); vi.restoreAllMocks(); });

describe("opaque task properties transport", () => {
  it("delegates ordinary properties validation to the service for creates and updates", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(stringifyApiJson({ error: { code: "invalid_input", message: "Property was refused.", requestId: "ordinary-property-refusal" } }), { status: 400, headers: { "Content-Type": "application/json" } }));
    const api = client(fetch);
    const properties = { worker: { anyFutureField: false }, unknown: [1, null] };
    await expect(api.createTask(projectId, { title: "Task", properties })).rejects.toMatchObject({ status: 400 });
    await expect(api.updateTask(projectId, taskId, { version: 1n, properties })).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, options]) => (parseApiJson(String(options!.body)) as { properties: unknown }).properties)).toEqual([properties, properties]);
  });
  it("returns the original resource text without projecting unknown fields or parsing numbers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    await expect(client(fetch).getTaskProperties(projectId, taskId)).resolves.toBe(source);
    expect(String(fetch.mock.calls[0]![0])).toBe(`http://localhost${prefix}`);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET", cache: "no-store" });
  });

  it.each([
    { property: "worker.signaling", value: "请确认" },
    { property: "worker.signaling", value: '"请确认"' },
    { property: "worker.signaling", value: "" },
    { property: "pullRequests", value: '[{"url":"x","title":"y"}]' },
    { property: "future.nested.field", value: ' {"large":900719925474099312345,"version":1e999} ' },
    { property: "new /?#%字段", value: "invalid JSON {" },
    { property: "", value: "" },
    { property: ".", value: "not JSON" },
    { property: "..", value: "not JSON" },
  ])("sends opaque property/value text unchanged: $property/$value", async ({ property, value }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    await expect(client(fetch).setTaskProperty(projectId, taskId, property, { version: 9_223_372_036_854_775_807n, value })).resolves.toBe(source);
    expect(String(fetch.mock.calls[0]![0])).toBe(`http://localhost${prefix}`);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "PUT", cache: "no-store", headers: { "Content-Type": "application/json" } });
    const body = String(fetch.mock.calls[0]![1]!.body);
    expect(body).toBe(`{"version":9223372036854775807,"property":${JSON.stringify(property)},"value":${JSON.stringify(value)}}`);
    expect(parseApiJson(body)).toEqual({ version: 9_223_372_036_854_775_807n, property, value });
  });

  it.each([400, 409])("preserves server-owned property validation HTTP %s without retrying", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stringifyApiJson({ error: { code: status === 400 ? "invalid_input" : "version_conflict", message: "Property was refused.", requestId: "property-refusal" } }), { status, headers: { "Content-Type": "application/json" } }));
    await expect(client(fetch).setTaskProperty(projectId, taskId, "unknown", { version: 1n, value: "{" })).rejects.toMatchObject({ phase: "response", status, confirmedRefusal: true, outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["worker.signaling", "pullRequests", "future /?#%字段", "", ".", ".."])("removes a property without interpreting its name or default: %j", async (property) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    await expect(client(fetch).removeTaskProperty(projectId, taskId, property, { version: 9_223_372_036_854_775_807n })).resolves.toBe(source);
    expect(String(fetch.mock.calls[0]![0])).toBe(`http://localhost${prefix}`);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "DELETE", body: `{"version":9223372036854775807,"property":${JSON.stringify(property)}}`, cache: "no-store" });
  });

  it("keeps property removal failures authoritative and does not retry unknown outcomes", async () => {
    const refusal = new Response(stringifyApiJson({ error: { code: "version_conflict", message: "Property was refused.", requestId: "remove-refusal" } }), { status: 409, headers: { "Content-Type": "application/json" } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(refusal).mockRejectedValueOnce(new Error("Connection reset"));
    const api = client(fetch);
    await expect(api.removeTaskProperty(projectId, taskId, "future", { version: 1n })).rejects.toMatchObject({ confirmedRefusal: true, outcomeUnconfirmed: false });
    await expect(api.removeTaskProperty(projectId, taskId, "future", { version: 1n })).rejects.toMatchObject({ operation: "task.remove-property", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a lost mutation response as unconfirmed without retrying", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Connection reset"));
    await expect(client(fetch).setTaskProperty(projectId, taskId, "future", { version: 1n, value: "value" })).rejects.toMatchObject({ outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["get", "set"] as const)("keeps JSON MIME validation for %s", async (method) => {
    const api = client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(source, { headers: { "Content-Type": "text/plain" } })));
    await expect(method === "get" ? api.getTaskProperties(projectId, taskId) : api.setTaskProperty(projectId, taskId, "x", { version: 1n, value: "x" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: method === "set" });
  });

  it("retains UTF-8 validation and response limits for opaque resources", async () => {
    const invalid = client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json" } })));
    await expect(invalid.getTaskProperties(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    const limited = client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response()), operation({ limits: { responseBytes: 16 } }));
    await expect(limited.getTaskProperties(projectId, taskId)).rejects.toMatchObject({ cause: { kind: "response_limit" } });
  });

  it("retains cancellation while reading an opaque resource", async () => {
    const cancellation = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"version":')); } });
    const api = client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stream, { headers: { "Content-Type": "application/json" } })), operation({ signal: cancellation.signal }));
    const pending = api.getTaskProperties(projectId, taskId);
    cancellation.abort(new Error("Cancelled by caller"));
    await expect(pending).rejects.toMatchObject({ outcomeUnconfirmed: false, cause: { kind: "cancelled" } });
  });
});
