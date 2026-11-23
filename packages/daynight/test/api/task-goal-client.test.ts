import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../src/api/index.js";
import type { Operation } from "../../src/api/index.js";

const project = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const parent = "33333333-3333-4333-8333-333333333333";
const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const time = "2026-11-10T01:02:03.123456Z";
const task = { id: taskId, type: "task", parentId: null, projectId: project, title: "Task", description: "", tags: [], properties: {}, status: "todo", allowAgents: false, requiredPlatform: null, assignedTo: null, version: 1n, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true };
const goal = { ...task, type: "goal", ready: false, assignedTo: user, progress: { total: 0, done: 0, cancelled: 0, unfinished: 0 } };
const operations: Operation[] = [];
const json = (body: unknown, status = 200) => new Response(stringifyApiJson(body), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": user } });
const client = (fetch: typeof globalThis.fetch) => {
  const operation = createOperation(); operations.push(operation);
  return createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
};
const body = (fetch: ReturnType<typeof vi.fn>, index: number) => parseApiJson(String(fetch.mock.calls[index]![1]!.body));
afterEach(() => operations.splice(0).forEach(operation => operation.dispose()));

describe("Goal and parent API contract", () => {
  it("preserves create presence, defaults Goal to todo and its authenticated creator, and confirms explicit null", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(goal, 201))
      .mockResolvedValueOnce(json({ ...goal, assignedTo: null }, 201))
      .mockResolvedValueOnce(json({ ...task, parentId: parent }, 201));
    const api = client(fetch);
    await expect(api.createTask(project, { title: "Goal", type: "goal" })).resolves.toMatchObject({ type: "goal", assignedTo: user, status: "todo" });
    await expect(api.createTask(project, { title: "Goal", type: "goal", parentId: null, assignedTo: null })).resolves.toMatchObject({ assignedTo: null });
    await expect(api.createTask(project, { title: "Task", status: "todo", parentId: parent.toUpperCase() })).resolves.toMatchObject({ parentId: parent });
    expect(body(fetch, 0)).toEqual({ title: "Goal", type: "goal" });
    expect(body(fetch, 1)).toEqual({ title: "Goal", type: "goal", parentId: null, assignedTo: null });
    expect(body(fetch, 2)).toEqual({ title: "Task", status: "todo", parentId: parent });
  });

  it.each(["todo", "in_progress", "done", "cancelled"] as const)("accepts and confirms Goal initial status %s", async status => {
    const result = { ...goal, status, startedAt: status === "in_progress" ? time : null, completedAt: status === "done" ? time : null, cancelledAt: status === "cancelled" ? time : null };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(result, 201));
    await expect(client(fetch).createTask(project, { title: "Goal", type: "goal", status })).resolves.toMatchObject({ status });
    expect(body(fetch, 0)).toEqual({ title: "Goal", type: "goal", status });
  });

  it("rejects invalid type, status and parent without issuing a request", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const api = client(fetch);
    expect(() => api.createTask(project, { title: "x", type: "other" } as never)).toThrow("Task type");
    expect(() => api.createTask(project, { title: "x", type: "goal", status: "proposed" })).toThrow("Initial Goal status");
    expect(() => api.createTask(project, { title: "x", status: "done" })).toThrow("Initial task status");
    expect(() => api.createTask(project, { title: "x", parentId: "bad" })).toThrow("Resource ID");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves update omission and null with the exact caller version", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ...task, parentId: parent }))
      .mockResolvedValueOnce(json({ ...task, parentId: parent }))
      .mockResolvedValueOnce(json(task));
    const api = client(fetch); const version = 9_223_372_036_854_775_807n;
    await api.updateTask(project, taskId, { version, parentId: parent.toUpperCase() });
    await api.updateTask(project, taskId, { version, title: "Task" });
    await api.updateTask(project, taskId, { version, parentId: null });
    expect(body(fetch, 0)).toEqual({ version, parentId: parent });
    expect(body(fetch, 1)).toEqual({ version, title: "Task" });
    expect(body(fetch, 2)).toEqual({ version, parentId: null });
  });

  it("rejects incorrect creation and update confirmations without replay", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ ...goal, assignedTo: null }, 201)).mockResolvedValueOnce(json(task));
    const api = client(fetch);
    await expect(api.createTask(project, { title: "Goal", type: "goal" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    await expect(api.updateTask(project, taskId, { version: 1n, parentId: parent })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("passes type, parent and cursor through list pages and parent through ready", async () => {
    const child = { ...task, parentId: parent };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ items: [child], nextCursor: "opaque cursor" }))
      .mockResolvedValueOnce(json({ items: [{ ...child, id: "44444444-4444-4444-8444-444444444444" }], nextCursor: null }))
      .mockResolvedValueOnce(json({ items: [task], nextCursor: null }))
      .mockResolvedValueOnce(json({ items: [goal], nextCursor: null }));
    const api = client(fetch);
    await api.listTasks(project, { type: "task", parentId: parent.toUpperCase() });
    await api.listReadyTasks(project, 5, { parentId: null });
    await api.listTaskPage(project, { type: "goal", parentId: null, cursor: "opaque cursor", limit: 3 });
    expect(fetch.mock.calls.map(([url]) => Object.fromEntries(new URL(String(url)).searchParams))).toEqual([
      { type: "task", parentId: parent, limit: "100" }, { type: "task", parentId: parent, limit: "100", cursor: "opaque cursor" },
      { ready: "true", limit: "5", parentId: "none" }, { type: "goal", parentId: "none", limit: "3", cursor: "opaque cursor" },
    ]);
  });

  it("sends search Parent as JSON null or UUID and retains the actual parent context", async () => {
    const match = { fields: ["title"], descriptionSnippet: null };
    const item = { id: taskId, type: "task", parentId: parent, projectId: project, title: "Task", status: "todo", cancelledAt: null, tags: [], assignedTo: null, updatedAt: time, context: { taskId: parent, title: "Parent Goal" }, match };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ projectId: project, total: 1, items: [item], nextCursor: null }))
      .mockResolvedValueOnce(json({ projectId: project, total: 0, items: [], nextCursor: null }));
    const api = client(fetch);
    await expect(api.searchTasks(project, { query: "Task", type: "task", parentId: parent })).resolves.toMatchObject([{ parentId: parent, context: { taskId: parent, title: "Parent Goal" } }]);
    await api.searchTasks(project, { query: "Goal", type: "goal", parentId: null });
    expect(body(fetch, 0)).toEqual({ query: "Task", type: "task", parentId: parent, limit: 100 });
    expect(body(fetch, 1)).toEqual({ query: "Goal", type: "goal", parentId: null, limit: 100 });
  });

  it("rejects mismatched type and parent query responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ items: [task], nextCursor: null }));
    const api = client(fetch);
    await expect(api.listTasks(project, { type: "goal" })).rejects.toMatchObject({ phase: "protocol" });
    await expect(api.listReadyTasks(project, 1, { parentId: parent })).rejects.toMatchObject({ phase: "protocol" });
  });
});
