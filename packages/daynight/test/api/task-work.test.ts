import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../src/api/index.js";
import type { Operation } from "../../src/api/index.js";
import { actorId, observedGraph, projectId, taskId, time, workGroup, workPage } from "../fixtures/task-observation.js";

const operations: Operation[] = [];
const response = (body: unknown, principal = actorId) => new Response(stringifyApiJson(body), { headers: { "content-type": "application/json", "Daynight-User-ID": principal } });
const client = (fetch: typeof globalThis.fetch) => { const operation = createOperation(); operations.push(operation); return createApiClient({ serverUrl: "http://localhost:8787", operation, fetch }); };
afterEach(() => { operations.splice(0).forEach(operation => operation.dispose()); });

describe("work overview and graph observation client", () => {
  it("preserves group and target cursors without fetching a second page", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...workPage, nextCursor: "next-group", groups: [{ ...workGroup, contributorCursor: "next-target" }] }));
    const result = await client(fetch).listTaskWork(projectId, { assignedTo: "me", limit: 20, cursor: "previous-group" });
    expect(result.nextCursor).toBe("next-group");
    expect(result.groups[0]!.contributorCursor).toBe("next-target");
    expect(result.groups[0]!.targets[0]!.send.allowed).toBe(true);
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.pathname).toBe(`/api/v1/projects/${projectId}/task-work`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ assignedTo: "me", limit: "20", cursor: "previous-group" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("requests only the selected group's target continuation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(workPage));
    await client(fetch).listTaskWork(projectId, { assignedTo: actorId, groupId: taskId, targetsCursor: "targets" });
    expect(Object.fromEntries(new URL(String(fetch.mock.calls[0]![0])).searchParams)).toEqual({ assignedTo: actorId, groupId: taskId, targetsCursor: "targets" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { groupId: taskId }, { targetsCursor: "targets" }, { assignedTo: "unassigned" }, { limit: 0 }, { limit: 51 }, { cursor: "" },
    { groupId: taskId, targetsCursor: "targets", cursor: "groups" },
  ])("rejects invalid work queries before HTTP %#", async query => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(client(fetch).listTaskWork(projectId, query)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { groups: [{ ...workGroup, groupId: "bad" }] }, { groups: [{ ...workGroup, sessionId: taskId }] },
    { groups: [{ ...workGroup, targets: [{ ...workGroup.targets[0], matchesAssignee: "true" }] }] },
    { partial: "false" }, { nextCursor: "" }, { groups: [workGroup, workGroup] }, { observedAt: null },
  ])("rejects malformed or duplicate group output %#", async changes => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...workPage, ...changes }));
    await expect(client(fetch).listTaskWork(projectId)).rejects.toMatchObject({ phase: "protocol" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves independent graph and session observation clocks", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...observedGraph, sessionSummary: { ...observedGraph.sessionSummary, observedAt: "2026-11-10T01:02:10Z" } }));
    const graph = await client(fetch).getObservedTaskGraph(projectId, taskId);
    expect(graph.observedAt).toBe(time);
    expect(graph.sessionSummary.observedAt).toBe("2026-11-10T01:02:10Z");
    expect(graph.tasks[0]!.relation).toBe("member");
    expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.get("include")).toBe("session");
  });
  it.each(["sessionSummary", "partial"])("does not label a malformed observed graph missing %s as a legacy result", async field => {
    const data = { ...observedGraph } as Record<string, unknown>;
    delete data[field];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(data));
    await expect(client(fetch).getObservedTaskGraph(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects an oversized work response before producing a page", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...workPage, extra: "x".repeat(256 * 1024) }));
    await expect(client(fetch).listTaskWork(projectId)).rejects.toMatchObject({ phase: "response", cause: { kind: "response_limit" } });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
