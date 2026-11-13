import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../src/api/index.js";
import type { Operation, Task, TaskGraph } from "../../src/api/index.js";

const projectId = "11111111-1111-1111-1111-111111111111";
const taskId = "22222222-2222-2222-2222-222222222222";
const otherTaskId = "33333333-3333-3333-3333-333333333333";
const thirdTaskId = "44444444-4444-4444-4444-444444444444";
const fourthTaskId = "55555555-5555-5555-5555-555555555555";
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const time = "2026-10-20T01:02:03.123456789Z";
const project = { id: projectId, name: "Project", repoUrl: "git@github.com:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: time, updatedAt: time };
const operations: Operation[] = [];
const task = (id = taskId, assignedTo: string | null = null): Task => ({ type: "task", parentId: null,
  id, projectId, assignedTo, title: "Task", description: "", tags: [], properties: {}, status: "todo", allowAgents: false, requiredPlatform: null,
  version: 1n, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true,
});
const graph = (assignedTo: string | null): TaskGraph => {
  const { projectId: _project, title, description: _description, tags: _tags, version: _version, properties: _properties, ...node } = task(taskId, assignedTo);
  return { project, observedAt: time, summary: { total: 1, proposed: 0, todo: 1, inProgress: 0, done: 0, cancelled: 0, ready: 1, blocked: 0 }, tasks: [{ ...node, type: "task", titlePreview: title, titleTruncated: false }] };
};
const response = (value: unknown, principal?: string | string[], status = 200): Response => {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (Array.isArray(principal)) principal.forEach((value) => headers.append("Daynight-User-ID", value));
  else if (principal !== undefined) headers.set("Daynight-User-ID", principal);
  return new Response(stringifyApiJson(value), { status, headers });
};
const client = (fetch: typeof globalThis.fetch, expectedUserId?: string) => {
  const operation = createOperation(); operations.push(operation);
  return createApiClient({ serverUrl: "http://localhost:8787", operation, fetch, ...(expectedUserId === undefined ? {} : { expectedUserId }) });
};
afterEach(() => {
  for (const operation of operations.splice(0)) operation.dispose();
  vi.restoreAllMocks();
});

describe("native assignment read and write protocol", () => {
  it.each([null, userId])("retains required assignedTo=%s across task, ready, status and graph reads", async (assignedTo) => {
    const value = task(taskId, assignedTo);
    const valueGraph = graph(assignedTo);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(value))
      .mockResolvedValueOnce(response({ items: [value], nextCursor: null }))
      .mockResolvedValueOnce(response(value))
      .mockResolvedValueOnce(response(valueGraph));
    const api = client(fetch);
    await expect(api.getTask(projectId, taskId)).resolves.toEqual(value);
    await expect(api.listReadyTasks(projectId, 1)).resolves.toEqual([value]);
    await expect(api.setTaskStatus(projectId, taskId, { version: 1n, status: "todo" })).resolves.toEqual(value);
    await expect(api.getTaskGraph(projectId, taskId)).resolves.toEqual(valueGraph);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.has("assignedTo")).toBe(false);
  });

  it.each([undefined, "", "invalid", userId.toUpperCase(), ` ${userId}`, true, 1, {}, []].map((assignedTo) => ({ assignedTo })))("rejects absent or malformed native assignment %#", async ({ assignedTo }) => {
    const value = { ...task(), assignedTo };
    const valueGraph = { ...graph(null), tasks: graph(null).tasks.map((item) => ({ ...item, assignedTo })) };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(value))
      .mockResolvedValueOnce(response({ items: [value], nextCursor: null }))
      .mockResolvedValueOnce(response(valueGraph))
      .mockResolvedValueOnce(response(value));
    const api = client(fetch);
    await expect(api.getTask(projectId, taskId)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    await expect(api.listReadyTasks(projectId, 1)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    await expect(api.getTaskGraph(projectId, taskId)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    await expect(api.setTaskStatus(projectId, taskId, { version: 1n, status: "todo" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([undefined, null, userId.toUpperCase()])("transmits assignedTo=%s with exact versions and no extra reads", async (assignedTo) => {
    const normalized = assignedTo === undefined || assignedTo === null ? null : userId;
    const created = { ...task(taskId, normalized), status: "proposed", ready: false };
    const changed = { ...created, version: 9_223_372_036_854_775_807n };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(created, undefined, 201))
      .mockResolvedValueOnce(response(changed));
    const api = client(fetch);
    await expect(api.createTask(projectId, { title: "Task", assignedTo } as never)).resolves.toEqual(created);
    await expect(api.updateTask(projectId, taskId, { version: 9_223_372_036_854_775_806n, assignedTo } as never)).resolves.toEqual(changed);
    expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "PATCH"]);
    expect(fetch.mock.calls.map(([, options]) => parseApiJson(String(options?.body)))).toEqual([
      { title: "Task", ...(assignedTo === undefined ? {} : { assignedTo: normalized }) },
      { version: 9_223_372_036_854_775_806n, ...(assignedTo === undefined ? {} : { assignedTo: normalized }) },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves a server assignment when input omits it and does not infer a reset from a version increase", async () => {
    const preserved = { ...task(taskId, otherUserId), title: "Renamed", allowAgents: true, version: 2n };
    const sameAssignment = { ...preserved, assignedTo: userId };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(preserved))
      .mockResolvedValueOnce(response(sameAssignment));
    const api = client(fetch);
    await expect(api.updateTask(projectId, taskId, { version: 1n, title: "Renamed" })).resolves.toEqual(preserved);
    await expect(api.updateTask(projectId, taskId, { version: 1n, title: "Renamed", assignedTo: userId, allowAgents: true })).resolves.toEqual(sameAssignment);
    expect(fetch.mock.calls.map(([, options]) => parseApiJson(String(options?.body)))).toEqual([
      { version: 1n, title: "Renamed" }, { version: 1n, assignedTo: userId, allowAgents: true, title: "Renamed" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["default create", "assigned create", "clear", "reassign"])("does not confirm a mismatched %s response or replay the write", async (operation) => {
    const returned = operation === "assigned create" ? null : otherUserId;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(task(taskId, returned), undefined, operation.includes("create") ? 201 : 200));
    const api = client(fetch);
    const action = operation === "default create" ? api.createTask(projectId, { title: "Task" })
      : operation === "assigned create" ? api.createTask(projectId, { title: "Task", assignedTo: userId })
        : api.updateTask(projectId, taskId, { version: 1n, assignedTo: operation === "clear" ? null : userId });
    await expect(action).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true, confirmedRefusal: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["me", "unassigned", "", "invalid", ` ${userId}`, true, {}, []].map((assignedTo) => ({ assignedTo })))("rejects an invalid assignment input before dispatch %#", ({ assignedTo }) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = client(fetch);
    expect(() => api.createTask(projectId, { title: "Task", assignedTo } as never)).toThrow("hyphenated UUID");
    expect(() => api.updateTask(projectId, taskId, { version: 1n, assignedTo } as never)).toThrow("hyphenated UUID");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("assignment-filtered page identity", () => {
  it.each([userId.toUpperCase(), "unassigned"])("preserves normalized assignedTo=%s and other filters on every page", async (assignedTo) => {
    const target = assignedTo === "unassigned" ? null : userId;
    const first = { ...task(taskId, target), allowAgents: true };
    const second = { ...task(otherTaskId, target), allowAgents: true };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ items: [first], nextCursor: "assigned cursor" }))
      .mockResolvedValueOnce(response({ items: [second], nextCursor: null }));
    await expect(client(fetch).listTasks(projectId, { assignedTo, status: "todo", ready: true, allowAgents: true, compatiblePlatform: "linux" })).resolves.toEqual([first, second]);
    expect(fetch.mock.calls.map(([url]) => Object.fromEntries(new URL(String(url)).searchParams))).toEqual([
      { assignedTo: target === null ? "unassigned" : target, status: "todo", ready: "true", allowAgents: "true", compatiblePlatform: "linux", limit: "100" },
      { assignedTo: target === null ? "unassigned" : target, status: "todo", ready: "true", allowAgents: "true", compatiblePlatform: "linux", limit: "100", cursor: "assigned cursor" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([userId, "unassigned", "me"])("rejects a wrong item instead of silently filtering assignedTo=%s", async (assignedTo) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ items: [task(taskId, otherUserId)], nextCursor: null }, userId));
    await expect(client(fetch).listTasks(projectId, { assignedTo })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("validates me on each page without making an identity request", async () => {
    const first = task(taskId, userId), second = task(otherTaskId, userId);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ items: [first], nextCursor: "me cursor" }, userId))
      .mockResolvedValueOnce(response({ items: [second], nextCursor: null }, userId))
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }, userId));
    const api = client(fetch);
    await expect(api.listTasks(projectId, { assignedTo: "me" })).resolves.toEqual([first, second]);
    await expect(api.listTaskPage(projectId, { assignedTo: "me", limit: 1 })).resolves.toEqual({ items: [], nextCursor: null });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([url]) => new URL(String(url)).pathname === `/api/v1/projects/${projectId}/tasks`)).toBe(true);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("assignedTo"))).toEqual(["me", "me", "me"]);
  });

  it.each([undefined, "", "invalid", userId.toUpperCase(), [userId, userId], [userId, otherUserId]].map((principal) => ({ principal })))("requires canonical singular me identity even on an empty page %#", async ({ principal }) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }, principal))
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }, principal));
    const api = client(fetch);
    await expect(api.listTasks(projectId, { assignedTo: "me" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    await expect(api.listTaskPage(projectId, { assignedTo: "me", limit: 1 })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("rejects a later principal change with empty second page=%s", async (empty) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ items: [task(taskId, userId)], nextCursor: "next" }, userId))
      .mockResolvedValueOnce(response({ items: empty ? [] : [task(otherTaskId, otherUserId)], nextCursor: null }, otherUserId));
    await expect(client(fetch).listTasks(projectId, { assignedTo: "me" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "invalid", userId.toUpperCase(), [userId, userId]].map((principal) => ({ principal })))("revalidates later empty-page provenance %#", async ({ principal }) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ items: [task(taskId, userId)], nextCursor: "next" }, userId))
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }, principal));
    await expect(client(fetch).listTasks(projectId, { assignedTo: "me" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps independent concurrent me list bindings separate on one client", async () => {
    let starts = 0;
    const a = task(taskId, userId), a2 = task(thirdTaskId, userId);
    const b = task(otherTaskId, otherUserId), b2 = task(fourthTaskId, otherUserId);
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const cursor = new URL(String(input)).searchParams.get("cursor");
      if (cursor === "a") return response({ items: [a2], nextCursor: null }, userId);
      if (cursor === "b") return response({ items: [b2], nextCursor: null }, otherUserId);
      starts++;
      return starts === 1 ? response({ items: [a], nextCursor: "a" }, userId) : response({ items: [b], nextCursor: "b" }, otherUserId);
    });
    const api = client(fetch);
    const [first, second] = await Promise.all([api.listTasks(projectId, { assignedTo: "me" }), api.listTasks(projectId, { assignedTo: "me" })]);
    expect(first).toEqual([a, a2]);
    expect(second).toEqual([b, b2]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not persist a me principal between independent calls", async () => {
    const first = task(taskId, userId), second = task(otherTaskId, otherUserId);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ items: [first], nextCursor: null }, userId))
      .mockResolvedValueOnce(response({ items: [second], nextCursor: null }, otherUserId));
    const api = client(fetch);
    await expect(api.listTasks(projectId, { assignedTo: "me" })).resolves.toEqual([first]);
    await expect(api.listTasks(projectId, { assignedTo: "me" })).resolves.toEqual([second]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps separate listTaskPage calls scoped to their own successful principal", async () => {
    const first = task(taskId, userId), second = task(otherTaskId, otherUserId);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ items: [first], nextCursor: null }, userId))
      .mockResolvedValueOnce(response({ items: [second], nextCursor: null }, otherUserId));
    const api = client(fetch);
    await expect(api.listTaskPage(projectId, { assignedTo: "me", limit: 1 })).resolves.toEqual({ items: [first], nextCursor: null });
    await expect(api.listTaskPage(projectId, { assignedTo: "me", limit: 1 })).resolves.toEqual({ items: [second], nextCursor: null });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves optional successful provenance for ordinary and non-me list callers", async () => {
    const value = task(taskId, userId);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(response({ items: [value], nextCursor: null }))
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(response({ items: [], nextCursor: null }));
    const api = client(fetch);
    await expect(api.listProjects()).resolves.toEqual([]);
    await expect(api.listTasks(projectId, { assignedTo: userId })).resolves.toEqual([value]);
    await expect(api.listTaskPage(projectId, { limit: 1 })).resolves.toEqual({ items: [], nextCursor: null });
    await expect(api.listTaskAttachments(projectId, taskId)).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([401, 404, 409])("retains a service refusal without successful me provenance at HTTP %s", async (status) => {
    const code = status === 401 ? "unauthenticated" : status === 404 ? "not_found" : "version_conflict";
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code, message: "Actual refusal.", requestId: "assignment-test" } }, undefined, status));
    await expect(client(fetch, userId).listTasks(projectId, { assignedTo: "me" })).rejects.toMatchObject({ phase: "response", code, status, outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["", "Me", "all", "invalid", ` ${userId}`, null, false, {}, []].map((assignedTo) => ({ assignedTo })))("rejects an invalid assignment filter before dispatch %#", ({ assignedTo }) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = client(fetch);
    expect(() => api.listTasks(projectId, { assignedTo } as never)).toThrow("Assigned-to filter");
    expect(() => api.listTaskPage(projectId, { limit: 1, assignedTo } as never)).toThrow("Assigned-to filter");
    expect(fetch).not.toHaveBeenCalled();
  });
});
