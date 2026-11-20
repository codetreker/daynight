import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";
import type { Operation } from "../../src/api/index.js";
import { observedGraph, project, projectId, taskId } from "../fixtures/task-observation.js";

const operations: Operation[] = [];
const client = (fetch: typeof globalThis.fetch) => {
  const operation = createOperation();
  operations.push(operation);
  return createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
};
const response = (body: unknown, projection?: string): Response => new Response(stringifyApiJson(body), {
  headers: { "content-type": "application/json", ...(projection === undefined ? {} : { "Daynight-Projection": projection }) },
});
afterEach(() => { operations.splice(0).forEach(operation => operation.dispose()); });

describe("Task graph projection", () => {
  it.each([false, true])("requests and accepts a task-only graph (observations=%s)", async observed => {
    const graph = { ...observedGraph, project: { id: projectId } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(graph, "task-only-v1"));
    const api = client(fetch);
    const actual = observed ? await api.getObservedTaskGraph(projectId, taskId) : await api.getTaskGraph(projectId, taskId);
    expect(actual.project).toEqual({ id: projectId });
    expect(actual.tasks).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get("Daynight-Projection")).toBe("task-only-v1");
  });

  it.each([false, true])("accepts a legacy full Project without a projection response header (observations=%s)", async observed => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(observedGraph));
    const api = client(fetch);
    const actual = observed ? await api.getObservedTaskGraph(projectId, taskId) : await api.getTaskGraph(projectId, taskId);
    expect(actual.project).toEqual(project);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retains the projection request when an older service rejects observation negotiation", async () => {
    const refusal = new Response(stringifyApiJson({ error: { code: "invalid_input", message: "query contains an unknown parameter", requestId: "graph-test" } }), { status: 400, headers: { "content-type": "application/json" } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(refusal).mockResolvedValueOnce(response(observedGraph));
    const actual = await client(fetch).getObservedTaskGraph(projectId, taskId);
    expect(actual.project).toEqual(project);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, options]) => new Headers(options!.headers).get("Daynight-Projection"))).toEqual(["task-only-v1", "task-only-v1"]);
  });

  it.each([
    [{ id: projectId }, undefined],
    [{ id: taskId }, "task-only-v1"],
    [project, "task-only-v1"],
    [{ id: projectId }, "unknown"],
  ])("rejects an invalid projection or project identity %#", async (projectValue, header) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...observedGraph, project: projectValue }, header));
    await expect(client(fetch).getObservedTaskGraph(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
