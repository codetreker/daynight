import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../src/api/index.js";
import type { Operation, TaskPropertyResource } from "../../src/api/index.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const version = 9_007_199_254_740_993n;
const resource: TaskPropertyResource = { projectId, taskId, version, properties: { future: { version: 7 }, pullRequests: [] } };
const json = (value: unknown, status = 200) => new Response(stringifyApiJson(value), { status, headers: { "Content-Type": "application/json" } });
const cleanups: (() => void | Promise<void>)[] = [];
const client = (fetch: typeof globalThis.fetch, serverUrl = "http://localhost:8787") => {
  const operation: Operation = createOperation(); cleanups.push(() => operation.dispose());
  return createApiClient({ serverUrl, operation, fetch });
};
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("generic property API resources", () => {
  it("loads server definitions without project or task requests and preserves schema keywords", async () => {
    const schema = { properties: { future: { description: "Future property", readOnly: false, schema: { type: "string", custom: { version: 7 } } }, worker: { description: "Protected ownership", readOnly: true, schema: { type: "object" } } } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(schema));
    expect(await client(fetch).getTaskPropertySchema()).toEqual(schema);
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]![0])).toBe("http://localhost:8787/api/v1/task-properties/schema");
    expect(fetch.mock.calls[0]![1]!.method).toBe("GET");
  });

  it("reads full current properties with exact resource version and nested JSON version intact", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(resource));
    expect(await client(fetch).getTaskProperties(projectId.toUpperCase(), taskId.toUpperCase())).toEqual(resource);
    expect(String(fetch.mock.calls[0]![0])).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/properties`);
    expect(fetch.mock.calls[0]![1]!.method).toBe("GET");
  });

  it.each(["", "hello", "true", "null", "-123", '"quoted"', ' {"duplicate":1,"duplicate":2,"version":9223372036854775807} '])("sends raw valueText without parsing or fetching definitions: %#", async (valueText) => {
    const result = { ...resource, version: version + 1n, properties: { ...resource.properties, "future.name": "server value" } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(result));
    expect(await client(fetch).setTaskProperty(projectId, taskId, "future.name", { version, valueText })).toEqual(result);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/properties/future.name`);
    expect(options!.method).toBe("PUT");
    expect(parseApiJson(String(options!.body))).toEqual({ version, valueText });
  });

  it("accepts a same-version no-op and distinguishes removal from an explicit empty array", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(resource)).mockResolvedValueOnce(json({ ...resource, version: version + 1n, properties: { future: { version: 7 } } }));
    const api = client(fetch);
    expect(await api.setTaskProperty(projectId, taskId, "pullRequests", { version, valueText: "[]" })).toEqual(resource);
    const removed = await api.removeTaskProperty(projectId, taskId, "pullRequests", { version });
    expect(removed.properties).toEqual({ future: { version: 7 } });
    expect(Object.hasOwn(removed.properties, "pullRequests")).toBe(false);
    expect(fetch.mock.calls[1]![1]!.method).toBe("DELETE");
    expect(String(fetch.mock.calls[1]![1]!.body)).toBe('{"version":9007199254740993}');
  });

  it.each([
    { projectId: otherId }, { taskId: otherId }, { version: 1.5 }, { version: 0 },
    { properties: null }, { properties: [] }, { properties: undefined },
  ])("rejects malformed or mismatched property resource envelopes: %#", async (changes) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...resource, ...changes }));
    await expect(client(fetch).getTaskProperties(projectId, taskId)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
  });

  it.each([version - 1n, version + 2n])("does not confirm a mutation with unrelated version %s", async (returnedVersion) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ...resource, version: returnedVersion }));
    await expect(client(fetch).removeTaskProperty(projectId, taskId, "future", { version })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([{ status: 400, code: "invalid_input", confirmed: true }, { status: 409, code: "version_conflict", confirmed: true }, { status: 500, code: "internal_error", confirmed: false }])("preserves server $status/$code and never replays", async ({ status, code, confirmed }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code, message: "Property was refused", requestId: "property-request" } }, status));
    await expect(client(fetch).setTaskProperty(projectId, taskId, "worker", { version, valueText: "invalid JSON" })).rejects.toMatchObject({ status, code, requestId: "property-request", confirmedRefusal: confirmed, outcomeUnconfirmed: !confirmed });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([".", ".."])("does not dispatch a normalized dot segment %s as any resource operation", async (name) => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const api = client(fetch);
    await expect(Promise.resolve().then(() => api.removeTaskProperty(projectId, taskId, name, { version }))).rejects.toThrow("Property name cannot be represented without changing the request route.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["worker.phase", "a/b", "%2e%2e", "a/../b", "name?query#fragment", "属性"])("encodes one literal name %s and leaves rejection to the server", async (name) => {
    const seen: { method: string; path: string }[] = [];
    const server = createServer((request, response) => {
      seen.push({ method: request.method!, path: request.url! });
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(stringifyApiJson({ error: { code: "invalid_input", message: "Unknown property", requestId: "unknown-property" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); }));
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing test listener");
    const api = client(globalThis.fetch, `http://127.0.0.1:${address.port}`);
    await expect(api.removeTaskProperty(projectId, taskId, name, { version })).rejects.toMatchObject({ code: "invalid_input", status: 400, confirmedRefusal: true });
    expect(seen).toEqual([{ method: "DELETE", path: `/api/v1/projects/${projectId}/tasks/${taskId}/properties/${encodeURIComponent(name)}` }]);
  });
});
