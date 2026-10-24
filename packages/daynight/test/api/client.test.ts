import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, createOperation, DEFAULT_OPERATION_LIMITS, OperationError, parseApiJson, parseVersionArgument, stringifyApiJson } from "../../src/api/index.js";
import type { Operation, TaskGraph, TaskPlatform } from "../../src/api/index.js";

const projectId = "11111111-1111-1111-1111-111111111111";
const taskId = "22222222-2222-2222-2222-222222222222";
const otherId = "33333333-3333-3333-3333-333333333333";
const normalId = "44444444-4444-4444-4444-444444444444";
const time = "2026-10-20T01:02:03.123456789Z";
const project = { id: projectId, name: "Project", repoUrl: "git@github.com:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const task = { id: taskId, projectId, title: "Task", description: "", properties: { worker: null, pullRequests: [] }, status: "todo", allowAgents: false, requiredPlatform: null, version: 1n, startedAt: null, completedAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true };
const refusal = (code = "not_found", details?: unknown) => ({ error: { code, message: "Actual server explanation.", requestId: "req-1", ...(details === undefined ? {} : { details }) } });
const jsonResponse = (value: unknown, status = 200) => new Response(stringifyApiJson(value), { status, headers: { "Content-Type": "application/json" } });
const cleanups: (() => void | Promise<void>)[] = [];
const operation = (limits: Parameters<typeof createOperation>[0] = {}): Operation => {
  const created = createOperation(limits);
  cleanups.push(() => created.dispose());
  return created;
};
const client = (fetch: typeof globalThis.fetch, op = operation()) => createApiClient({ serverUrl: "http://localhost:8787/", operation: op, fetch });
const server = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const created = createServer(handler);
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    created.close((error) => error === undefined ? resolve() : reject(error));
    created.closeAllConnections();
  }));
  const address = created.address();
  if (typeof address !== "object" || address === null) throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
};
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("operation-scoped API access", () => {
  it.each([null, "windows", "linux", "macos"] as const)("preserves requiredPlatform=%s in create, update and graph resources", async (requiredPlatform) => {
    const value = { ...task, requiredPlatform };
    const taskGraph = { ...graph(), tasks: graph().tasks.map((item) => ({ ...item, requiredPlatform })) };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(value, 201))
      .mockResolvedValueOnce(jsonResponse(value))
      .mockResolvedValueOnce(jsonResponse(taskGraph));
    const api = client(fetch);
    await expect(api.createTask(projectId, { title: "Platform task", requiredPlatform })).resolves.toEqual(value);
    await expect(api.updateTask(projectId, taskId, { version: 9_223_372_036_854_775_807n, requiredPlatform })).resolves.toEqual(value);
    await expect(api.getTaskGraph(projectId)).resolves.toEqual(taskGraph);
    expect(parseApiJson(String(fetch.mock.calls[0]![1]!.body))).toEqual({ title: "Platform task", requiredPlatform });
    expect(parseApiJson(String(fetch.mock.calls[1]![1]!.body))).toEqual({ version: 9_223_372_036_854_775_807n, requiredPlatform });
  });

  it.each([null, "windows", "linux", "macos"] as const)("retains requiredPlatform=%s in changed and unchanged status responses", async (requiredPlatform) => {
    const unchanged = { ...task, requiredPlatform };
    const changed = { ...unchanged, status: "in_progress", ready: false, version: 2n };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(unchanged))
      .mockResolvedValueOnce(jsonResponse(changed));
    const api = client(fetch);
    await expect(api.setTaskStatus(projectId, taskId, { version: 1n, status: "todo" })).resolves.toEqual(unchanged);
    await expect(api.setTaskStatus(projectId, taskId, { version: 1n, status: "in_progress" })).resolves.toEqual(changed);
    expect(fetch.mock.calls.map(([, options]) => parseApiJson(String(options!.body)))).toEqual([
      { version: 1n, status: "todo" }, { version: 1n, status: "in_progress" },
    ]);
  });

  it("omits unspecified platform changes while preserving the server requirement", async () => {
    const value = { ...task, requiredPlatform: "windows" };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => jsonResponse(value));
    const api = client(fetch);
    await expect(api.updateTask(projectId, taskId, { version: 1n, allowAgents: true })).resolves.toEqual(value);
    expect(parseApiJson(String(fetch.mock.calls[0]![1]!.body))).toEqual({ version: 1n, allowAgents: true });
  });

  it.each(["windows", "linux", "macos"] as const)("binds compatiblePlatform=%s with permission and readiness across every page", async (compatiblePlatform) => {
    const first = { ...task, allowAgents: true };
    const second = { ...first, id: otherId, requiredPlatform: compatiblePlatform };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [first], nextCursor: "platform cursor" }))
      .mockResolvedValueOnce(jsonResponse({ items: [second], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse({ items: [second], nextCursor: "not followed" }));
    const api = client(fetch);
    await expect(api.listTasks(projectId, { ready: true, allowAgents: true, compatiblePlatform })).resolves.toEqual([first, second]);
    await expect(api.listReadyTasks(projectId, 1, { allowAgents: true, compatiblePlatform })).resolves.toEqual([second]);
    expect(fetch.mock.calls.map(([url]) => Object.fromEntries(new URL(String(url)).searchParams))).toEqual([
      { ready: "true", allowAgents: "true", compatiblePlatform, limit: "100" },
      { ready: "true", allowAgents: "true", compatiblePlatform, limit: "100", cursor: "platform cursor" },
      { ready: "true", limit: "1", allowAgents: "true", compatiblePlatform },
    ]);
  });

  it.each(["windows", "linux", "macos"] as const)("rejects a server candidate outside compatiblePlatform=%s", async (compatiblePlatform) => {
    const requiredPlatform: TaskPlatform = compatiblePlatform === "windows" ? "linux" : "windows";
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => jsonResponse({ items: [{ ...task, requiredPlatform }], nextCursor: null }));
    const api = client(fetch);
    await expect(api.listTasks(projectId, { compatiblePlatform })).rejects.toMatchObject({ operation: "task.list", phase: "protocol" });
    await expect(api.listReadyTasks(projectId, 1, { compatiblePlatform })).rejects.toMatchObject({ operation: "task.ready", phase: "protocol" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "", "darwin", "win32", "Linux", true, 1, {}, []])("requires a nullable public platform in task and graph resources: %s", async (requiredPlatform) => {
    const value = { ...task, requiredPlatform };
    const taskGraph = graph();
    const invalidGraph = { ...taskGraph, tasks: taskGraph.tasks.map((item, index) => index === 0 ? { ...item, requiredPlatform } : item) };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(value))
      .mockResolvedValueOnce(jsonResponse({ items: [value], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse(invalidGraph));
    const api = client(fetch);
    await expect(api.getTask(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    await expect(api.listReadyTasks(projectId, 1)).rejects.toMatchObject({ phase: "protocol" });
    await expect(api.getTaskGraph(projectId)).rejects.toMatchObject({ phase: "protocol" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([true, false])("preserves explicit allowAgents=%s while keeping permission independent of ready", async (allowAgents) => {
    const value = { ...task, allowAgents };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(value));
    const result = await client(fetch).updateTask(projectId, taskId, { version: 9_223_372_036_854_775_807n, allowAgents });
    expect(result).toEqual(value);
    expect(result.ready).toBe(true);
    expect(parseApiJson(String(fetch.mock.calls[0]![1]!.body))).toEqual({ version: 9_223_372_036_854_775_807n, allowAgents });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([true, false])("binds allowAgents=%s to every list page and bounded ready request", async (allowAgents) => {
    const first = { ...task, allowAgents };
    const second = { ...first, id: otherId };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [first], nextCursor: "cursor" }))
      .mockResolvedValueOnce(jsonResponse({ items: [second], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse({ items: [first], nextCursor: "not followed" }));
    const api = client(fetch);
    await expect(api.listTasks(projectId, { ready: true, allowAgents })).resolves.toEqual([first, second]);
    await expect(api.listReadyTasks(projectId, 1, { allowAgents })).resolves.toEqual([first]);
    expect(fetch.mock.calls.map(([url]) => Object.fromEntries(new URL(String(url)).searchParams))).toEqual([
      { ready: "true", allowAgents: String(allowAgents), limit: "100" },
      { ready: "true", allowAgents: String(allowAgents), limit: "100", cursor: "cursor" },
      { ready: "true", limit: "1", allowAgents: String(allowAgents) },
    ]);
  });

  it.each([true, false])("rejects responses outside the requested allowAgents=%s scope", async (allowAgents) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => jsonResponse({ items: [{ ...task, allowAgents: !allowAgents }], nextCursor: null }));
    const api = client(fetch);
    await expect(api.listTasks(projectId, { allowAgents })).rejects.toMatchObject({ operation: "task.list", phase: "protocol" });
    await expect(api.listReadyTasks(projectId, 1, { allowAgents })).rejects.toMatchObject({ operation: "task.ready", phase: "protocol" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, "true", 1, {}, []])("requires an actual boolean permission in task and graph resources: %s", async (allowAgents) => {
    const value = { ...task, allowAgents };
    const taskGraph = graph();
    const invalidGraph = { ...taskGraph, tasks: taskGraph.tasks.map((item, index) => index === 0 ? { ...item, allowAgents } : item) };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(value))
      .mockResolvedValueOnce(jsonResponse({ items: [value], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse(invalidGraph));
    const api = client(fetch);
    await expect(api.getTask(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    await expect(api.listReadyTasks(projectId, 1)).rejects.toMatchObject({ phase: "protocol" });
    await expect(api.getTaskGraph(projectId)).rejects.toMatchObject({ phase: "protocol" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["todo", "in_progress", "done"] as const)("submits one precise %s PUT and reads the full resulting task", async (status) => {
    const version = 9_223_372_036_854_775_806n;
    const result = { ...task, status, ready: status === "todo", description: "Full result", version: version + 1n };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(result));
    await expect(client(fetch).setTaskStatus(projectId.toUpperCase(), taskId.toUpperCase(), { version, status })).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}/status`);
    expect(options).toMatchObject({ method: "PUT", body: `{"version":9223372036854775806,"status":"${status}"}`, redirect: "manual", cache: "no-store" });
  });

  it("retains conflicts and unknown outcomes without retrying", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(refusal("version_conflict"), 409))
      .mockResolvedValueOnce(jsonResponse({ ...task, id: otherId }));
    const api = client(fetch);
    await expect(api.setTaskStatus(projectId, taskId, { version: 1n, status: "todo" })).rejects.toMatchObject({ operation: "task.set-status", status: 409, code: "version_conflict", confirmedRefusal: true, outcomeUnconfirmed: false });
    await expect(api.setTaskStatus(projectId, taskId, { version: 9_223_372_036_854_775_807n, status: "todo" })).rejects.toMatchObject({ operation: "task.set-status", phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![1]?.body).toBe('{"version":9223372036854775807,"status":"todo"}');
  });

  it.each([0n, -1n, 9_223_372_036_854_775_808n])("rejects invalid setter version %s before I/O", (version) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => client(fetch).setTaskStatus(projectId, taskId, { version, status: "todo" })).toThrow("positive int64");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects removed proposed input before I/O", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = client(fetch);
    expect(() => api.listTasks(projectId, { status: "proposed" as never })).toThrow("Task status");
    expect(() => api.setTaskStatus(projectId, taskId, { version: 1n, status: "proposed" as never })).toThrow("Task status");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([1n, 2n])("accepts status response version %s for input version 1", async (version) => {
    const result = { ...task, version };
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(result))).setTaskStatus(projectId, taskId, { version: 1n, status: "todo" })).resolves.toEqual(result);
  });

  it.each([{ version: 3n }, { status: "done", ready: false }, { status: "proposed", ready: false }])("refuses a mismatching status result %s", async (changes) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...task, ...changes }))).setTaskStatus(projectId, taskId, { version: 1n, status: "todo" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
  });

  it("uses the approved production budgets and checks synchronous work against the shared deadline", () => {
    expect(DEFAULT_OPERATION_LIMITS).toEqual({ totalMs: 300_000, requestMs: 30_000, responseBytes: 128 * 1_048_576, totalBytes: 256 * 1_048_576 });
    const op = operation({ limits: { totalMs: 5 } });
    const until = performance.now() + 10;
    while (performance.now() < until) { /* Advance without yielding to the deadline timer. */ }
    expect(() => op.check()).toThrow("Operation deadline exceeded");
  });

  it("shares cumulative bytes, retains caller cancellation, and disposes idempotently", async () => {
    const source = new AbortController();
    const op = operation({ signal: source.signal, limits: { totalBytes: 5 } });
    op.consume(3);
    expect(() => op.consume(3)).toThrow("response byte budget");
    expect(op.signal.aborted).toBe(true);
    const cancelled = operation({ signal: source.signal });
    source.abort(new Error("caller details"));
    expect(() => cancelled.check()).toThrow("Operation cancelled");
    const disposed = operation();
    disposed.dispose();
    disposed.dispose();
    expect(() => disposed.check()).toThrow("disposed");
  });

  it("reads nanosecond timestamps and full Go int64 versions without changing numeric JSON wire shape", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...task, version: 9_223_372_036_854_775_807n }));
    const api = client(fetch);
    const result = await api.getTask(projectId.toUpperCase(), taskId);
    expect(result.version).toBe(9_223_372_036_854_775_807n);
    expect(result.createdAt).toBe(time);
    expect(stringifyApiJson(result)).toContain('"version":9223372036854775807');
    expect(parseVersionArgument("0009007199254740993")).toBe(9_007_199_254_740_993n);
    for (const value of ["0", "-1", "1.5", "1e3", "9223372036854775808"]) expect(() => parseVersionArgument(value)).toThrow();
    expect(parseApiJson('{"version":9223372036854775807}')).toEqual({ version: 9_223_372_036_854_775_807n });
  });

  it("uses exact mutation methods and preserves optional fields, empty values and duplicate dependency input", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(project, 201))
      .mockResolvedValueOnce(jsonResponse(task, 201))
      .mockResolvedValueOnce(jsonResponse(task, 201))
      .mockResolvedValueOnce(jsonResponse({ ...task, version: 9_007_199_254_740_994n }));
    const api = client(fetch);
    await api.createProject({ name: "Project", repoUrl: project.repoUrl });
    await api.createTask(projectId, { title: "Task" });
    await api.createTask(projectId, { title: "Task", description: "", dependsOn: [otherId, otherId] });
    await api.updateTask(projectId, taskId, { version: 9_007_199_254_740_993n, description: "", dependsOn: [] });
    expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "POST", "POST", "PATCH"]);
    expect(fetch.mock.calls.map((call) => call[1]?.body)).toEqual([
      JSON.stringify({ name: "Project", repoUrl: project.repoUrl }),
      '{"title":"Task"}',
      JSON.stringify({ title: "Task", description: "", dependsOn: [otherId, otherId] }),
      '{"version":9007199254740993,"description":"","dependsOn":[]}',
    ]);
    expect(fetch.mock.calls.every((call) => call[1]?.redirect === "manual")).toBe(true);
  });

  it("writes full PR lists unchanged and distinguishes omission from explicit clearing", async () => {
    const properties = { pullRequests: [{ url: "\0 arbitrary text\n", title: "" }, { url: "\0 arbitrary text\n", title: "" }] };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...task, properties: { ...properties, worker: null } }, 201))
      .mockResolvedValueOnce(jsonResponse({ ...task, properties: { ...properties, worker: null } }))
      .mockResolvedValueOnce(jsonResponse(task));
    const api = client(fetch);
    expect((await api.createTask(projectId, { title: "Task", properties })).properties).toEqual({ ...properties, worker: null });
    await api.updateTask(projectId, taskId, { version: 9_223_372_036_854_775_807n, properties });
    await api.updateTask(projectId, taskId, { version: 1n, properties: { pullRequests: [] } });
    expect(fetch.mock.calls.map((call) => parseApiJson(String(call[1]!.body)))).toEqual([
      { title: "Task", properties },
      { version: 9_223_372_036_854_775_807n, properties },
      { version: 1n, properties: { pullRequests: [] } },
    ]);
  });

  it("preserves independent external dependency fields for create and partial API updates", async () => {
    const value = { ...task, dependsOn: [otherId], externalDependsOn: [otherId] };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(value, 201))
      .mockResolvedValueOnce(jsonResponse(value))
      .mockResolvedValueOnce(jsonResponse({ ...value, externalDependsOn: [] }))
      .mockResolvedValueOnce(jsonResponse(value));
    const api = client(fetch);
    await expect(api.createTask(projectId, { title: "Task", dependsOn: [otherId], externalDependsOn: [otherId] })).resolves.toEqual(value);
    await api.updateTask(projectId, taskId, { version: 9_223_372_036_854_775_807n, externalDependsOn: [otherId] });
    await api.updateTask(projectId, taskId, { version: 1n, externalDependsOn: [] });
    await api.updateTask(projectId, taskId, { version: 1n, dependsOn: [otherId] });
    expect(fetch.mock.calls.map((call) => parseApiJson(String(call[1]!.body)))).toEqual([
      { title: "Task", dependsOn: [otherId], externalDependsOn: [otherId] },
      { version: 9_223_372_036_854_775_807n, externalDependsOn: [otherId] },
      { version: 1n, externalDependsOn: [] },
      { version: 1n, dependsOn: [otherId] },
    ]);
  });

  it("lists complete pages with stable filters and encoded opaque cursors", async () => {
    const cursor = "next page+/=?";
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [task], nextCursor: cursor }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ ...task, id: otherId }], nextCursor: null }));
    const result = await client(fetch).listTasks(projectId, { status: "todo", ready: true });
    expect(result.map((item) => item.id)).toEqual([taskId, otherId]);
    expect(fetch.mock.calls.map((call) => new URL(String(call[0])).searchParams.toString())).toEqual([
      "status=todo&ready=true&limit=100", `status=todo&ready=true&limit=100&cursor=${encodeURIComponent(cursor).replaceAll("%20", "+")}`,
    ]);
  });

  it("returns one bounded ready page without following its valid cursor", async () => {
    const tasks = [{ ...task, properties: { worker: null, pullRequests: [{ url: "\0 arbitrary URL", title: "Ready\nPR" }] }, version: 9_223_372_036_854_775_807n }, { ...task, id: otherId }];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ items: tasks, nextCursor: "next page+/=?" }));
    const result = await client(fetch).listReadyTasks(projectId, 2);
    expect(result).toEqual(tasks);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(`/api/v1/projects/${projectId}/tasks`);
    expect(Object.fromEntries(new URL(String(url)).searchParams)).toEqual({ ready: "true", limit: "2" });
    expect(options?.method).toBe("GET");
    expect(options?.redirect).toBe("manual");
  });

  it.each([{ items: [] }, { items: [task] }])("accepts a ready page below its bound: $items", async ({ items }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ items, nextCursor: null }));
    await expect(client(fetch).listReadyTasks(projectId, 10)).resolves.toEqual(items);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { items: [task, { ...task, id: otherId }], nextCursor: null },
    { items: [{ ...task, status: "in_progress", ready: false }], nextCursor: null },
    { items: [{ ...task, status: "proposed", ready: false }], nextCursor: null },
    { items: [{ ...task, projectId: otherId }], nextCursor: null },
    { items: [task, task], nextCursor: null },
    { items: [task], nextCursor: "" },
    { items: [task] },
    { items: [], nextCursor: "next" },
  ])("rejects an invalid or overflowing ready page %# without another request", async (page) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(page));
    await expect(client(fetch).listReadyTasks(projectId, 1)).rejects.toMatchObject({ operation: "task.ready", phase: "protocol", projectId, outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([0, 101, -1, 1.5, NaN, Infinity])("rejects an invalid ready limit %s before fetching", (limit) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => client(fetch).listReadyTasks(projectId, limit)).toThrow("Ready task limit must be an integer from 1 to 100.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["cursor", "duplicate", "later failure"])("rejects %s without returning a partial list", async (failure) => {
    const cursor = Buffer.from("cursor").toString("base64url");
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [project], nextCursor: cursor }))
      .mockResolvedValueOnce(failure === "later failure" ? jsonResponse(refusal("internal_error"), 500) : jsonResponse({ items: [{ ...project, id: failure === "duplicate" ? projectId : otherId }], nextCursor: failure === "cursor" ? cursor : null }));
    await expect(client(fetch).listProjects()).rejects.toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves confirmed API refusals, dependency IDs and graph size details", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(refusal("dependency_unsatisfied", { taskIds: [otherId] }), 409))
      .mockResolvedValueOnce(jsonResponse(refusal("graph_limit_exceeded", { nodeCount: 1001, edgeCount: 0, maxNodes: 1000, maxEdges: 5000 }), 409));
    const api = client(fetch);
    await expect(api.setTaskStatus(projectId, taskId, { version: 1n, status: "done" })).rejects.toMatchObject({
      operation: "task.set-status", phase: "response", projectId, taskId, status: 409, code: "dependency_unsatisfied", requestId: "req-1", details: { taskIds: [otherId] }, confirmedRefusal: true, outcomeUnconfirmed: false, cause: expect.any(Error),
    });
    await expect(api.getTaskGraph(projectId)).rejects.toMatchObject({ code: "graph_limit_exceeded", details: { nodeCount: 1001, edgeCount: 0, maxNodes: 1000, maxEdges: 5000 } });
  });

  it("never forwards a POST redirect to a second destination", async () => {
    const methods: string[] = [];
    const url = await server((request, response) => {
      methods.push(`${request.method} ${request.url}`);
      response.writeHead(307, { Location: "/elsewhere", "Content-Type": "application/json" });
      response.end("{}");
    });
    const api = createApiClient({ serverUrl: url, operation: operation() });
    await expect(api.createProject({ name: "Project", repoUrl: project.repoUrl })).rejects.toMatchObject({ status: 307, outcomeUnconfirmed: true });
    expect(methods).toEqual(["POST /api/v1/projects"]);
  });

  it("reports an unconfirmed mutation when its response exceeds a byte limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(task, 201));
    await expect(client(fetch, operation({ limits: { responseBytes: 10 } })).createTask(projectId, { title: "Task" })).rejects.toMatchObject({ outcomeUnconfirmed: true, confirmedRefusal: false, cause: { kind: "response_limit" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("marks disconnected mutation results unconfirmed and does not retry", async () => {
    let mutations = 0;
    const url = await server((request) => { mutations++; request.socket.destroy(); });
    await expect(createApiClient({ serverUrl: url, operation: operation() }).createTask(projectId, { title: "Task" })).rejects.toMatchObject({ operation: "task.create", outcomeUnconfirmed: true, confirmedRefusal: false, cause: expect.any(Error) });
    expect(mutations).toBe(1);
  });

  it.each(["headers", "body"])("enforces the real HTTP request timeout while waiting for %s", async (waitingFor) => {
    const url = await server((_request, response) => {
      if (waitingFor === "body") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"items":');
      }
    });
    const api = createApiClient({ serverUrl: url, operation: operation({ limits: { requestMs: 50 } }) });
    await expect(api.listProjects()).rejects.toMatchObject({ phase: waitingFor === "headers" ? "request" : "response", cause: { kind: "request_timeout" } });
  });

  it("cancels a custom response stream even when fetch ignores its signal", async () => {
    const source = new AbortController();
    const cancel = vi.fn();
    let notifyStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      return new Response(new ReadableStream<Uint8Array>({ pull: notifyStarted, cancel }, { highWaterMark: 0 }), { headers: { "Content-Type": "application/json" } });
    });
    const pending = client(fetch, operation({ signal: source.signal })).listProjects();
    await started;
    source.abort();
    await expect(pending).rejects.toMatchObject({ cause: { kind: "cancelled" } });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["rejects", "stalls"])("preserves bounded cleanup failure when stream cancellation %s", async (behavior) => {
    const source = new AbortController();
    const cleanupError = new Error("Underlying stream cancellation failed");
    let startedReading: () => void = () => {};
    const started = new Promise<void>((resolve) => { startedReading = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      pull: startedReading,
      cancel: () => behavior === "rejects" ? Promise.reject(cleanupError) : new Promise<void>(() => {}),
    }, { highWaterMark: 0 }), { headers: { "Content-Type": "application/json" } }));
    const pending = client(fetch, operation({ signal: source.signal })).listProjects();
    await started;
    source.abort();
    const error = await pending.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiError);
    const cause = (error as ApiError).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors[0]).toMatchObject({ kind: "cancelled" });
    if (behavior === "rejects") expect((cause as AggregateError).errors[1]).toBe(cleanupError);
    else expect((cause as AggregateError).errors[1]).toMatchObject({ message: expect.stringContaining("cleanup deadline") });
  });

  it("retains synchronous injected fetch failures without unhandled cancellation rejections", async () => {
    const cause = new Error("Synchronous network boundary failure");
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => { throw cause; });
    await expect(client(fetch).createTask(projectId, { title: "Task" })).rejects.toMatchObject({ cause, outcomeUnconfirmed: true });
  });

  it("rejects unsupported timer ranges before starting an operation", () => {
    expect(() => createOperation({ limits: { totalMs: 2_147_483_648 } })).toThrow("timer range");
    expect(() => createOperation({ limits: { requestMs: 2_147_483_648 } })).toThrow("timer range");
  });

  it("checks the single request deadline after synchronous parsing stalls the timer", async () => {
    const original = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((...args: Parameters<typeof JSON.parse>) => {
      const until = performance.now() + 15;
      while (performance.now() < until) { /* Keep the deadline timer from running during parsing. */ }
      return original(...args);
    });
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(project)), operation({ limits: { requestMs: 10 } })).getProject(projectId)).rejects.toMatchObject({ cause: { kind: "request_timeout" } });
    expect(spy).toHaveBeenCalled();
  });

  it("counts decoded gzip bytes rather than Content-Length", async () => {
    const body = gzipSync(stringifyApiJson(project));
    const url = await server((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": body.length });
      response.end(body);
    });
    const api = createApiClient({ serverUrl: url, operation: operation({ limits: { responseBytes: body.length + 1 } }) });
    await expect(api.getProject(projectId)).rejects.toMatchObject({ cause: { kind: "response_limit" } });
  });

  it("accumulates success and error bodies within a shared operation", async () => {
    const first = stringifyApiJson(project);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(project))
      .mockResolvedValueOnce(jsonResponse(refusal(), 404));
    const api = client(fetch, operation({ limits: { totalBytes: Buffer.byteLength(first) + 1 } }));
    await api.getProject(projectId);
    await expect(api.getProject(projectId)).rejects.toMatchObject({ cause: { kind: "total_limit" } });
  });

  it("exhausts one total deadline across continuously advancing cursors", async () => {
    let page = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      page++;
      const suffix = page.toString(16).padStart(12, "0");
      return jsonResponse({ items: [{ ...project, id: `11111111-1111-1111-1111-${suffix}` }], nextCursor: Buffer.from(`cursor-${page}`).toString("base64url") });
    });
    await expect(client(fetch, operation({ limits: { totalMs: 35, requestMs: 100 } })).listProjects()).rejects.toMatchObject({ cause: { kind: "deadline" } });
    expect(page).toBeGreaterThan(1);
  });

  it.each([
    ["wrong content type", new Response("{}", { headers: { "Content-Type": "text/plain" } })],
    ["non-UTF8 charset", new Response("{}", { headers: { "Content-Type": "application/json; charset=latin1" } })],
    ["malformed JSON", new Response("{", { headers: { "Content-Type": "application/json" } })],
    ["invalid UTF8", new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json" } })],
    ["incomplete error", jsonResponse({ error: { code: "not_found", requestId: "req-1" } }, 404)],
    ["wrong success status", jsonResponse(project, 201)],
  ])("rejects %s as protocol failure while retaining its cause", async (_name, response) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)).getProject(projectId)).rejects.toMatchObject({ phase: "protocol", cause: expect.any(Error) });
  });

  it("rejects an already cancelled operation without calling fetch", async () => {
    const source = new AbortController(); source.abort();
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(client(fetch, operation({ signal: source.signal })).createProject({ name: "P", repoUrl: project.repoUrl })).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, cause: { kind: "cancelled" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

const graph = (): TaskGraph => ({
  observedAt: time,
  project,
  summary: { total: 2, todo: 1, inProgress: 0, done: 1, ready: 1, blocked: 0 },
  tasks: [
    { id: taskId, titlePreview: "Task", titleTruncated: false, allowAgents: false, requiredPlatform: null, status: "todo", dependsOn: [otherId], externalDependsOn: [], blockedBy: [], ready: true, startedAt: null, completedAt: null, createdAt: time, updatedAt: time },
    { id: otherId, titlePreview: "Done", titleTruncated: false, allowAgents: false, requiredPlatform: null, status: "done", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false, startedAt: null, completedAt: null, createdAt: time, updatedAt: time },
  ],
});

const mixedDependencyGraph = (): TaskGraph => ({
  observedAt: time,
  project,
  summary: { total: 3, todo: 2, inProgress: 0, done: 1, ready: 1, blocked: 1 },
  tasks: [
    { ...graph().tasks[0]!, allowAgents: true, dependsOn: [otherId, normalId], externalDependsOn: [otherId], blockedBy: [otherId], ready: false },
    { ...graph().tasks[1]!, status: "todo", ready: true },
    { ...graph().tasks[1]!, id: normalId },
  ],
});

const threeStateGraph = (): TaskGraph => {
  const ready = graph().tasks[0]!;
  const done = graph().tasks[1]!;
  const blocked = { ...ready, id: "44444444-4444-4444-4444-444444444444", ready: false, dependsOn: [ready.id], blockedBy: [ready.id] };
  const inProgress = { ...ready, id: "88888888-8888-8888-8888-888888888888", status: "in_progress" as const, ready: false };
  return { observedAt: time, project, summary: { total: 4, todo: 2, inProgress: 1, done: 1, ready: 1, blocked: 1 }, tasks: [ready, blocked, inProgress, done] };
};

describe("response DTO contract", () => {
  it("preserves mixed external subsets, blocking, precise versions and timestamps across task reads and metadata results", async () => {
    const value = { ...task, allowAgents: true, description: "Complete Markdown\n\n```text\nexternal\n```", version: 9_223_372_036_854_775_807n, dependsOn: [otherId, normalId], externalDependsOn: [otherId], blockedBy: [otherId], ready: false };
    const graphValue = mixedDependencyGraph();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(value))
      .mockResolvedValueOnce(jsonResponse({ items: [value], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse(value))
      .mockResolvedValueOnce(jsonResponse(graphValue));
    const api = client(fetch);
    await expect(api.getTask(projectId, taskId)).resolves.toEqual(value);
    await expect(api.listTasks(projectId)).resolves.toEqual([value]);
    await expect(api.updateTask(projectId, taskId, { version: 9_007_199_254_740_993n, title: "Metadata edit" })).resolves.toEqual(value);
    expect(parseApiJson(String(fetch.mock.calls[2]![1]!.body))).toEqual({ version: 9_007_199_254_740_993n, title: "Metadata edit" });
    await expect(api.getTaskGraph(projectId)).resolves.toEqual(graphValue);
  });

  it("retains completed external prerequisites on ready task resources", async () => {
    const value = { ...task, dependsOn: [otherId], externalDependsOn: [otherId] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ items: [value], nextCursor: null }));
    await expect(client(fetch).listReadyTasks(projectId, 1)).resolves.toEqual([value]);
  });

  it.each([
    { name: "missing", changes: { externalDependsOn: undefined } },
    { name: "null", changes: { externalDependsOn: null } },
    { name: "non-array", changes: { externalDependsOn: {} } },
    { name: "malformed UUID", changes: { externalDependsOn: ["not-a-uuid"] } },
    { name: "noncanonical UUID", changes: { externalDependsOn: ["ABCDEFAB-1111-4222-8333-123456789ABC"] } },
    { name: "duplicate", changes: { externalDependsOn: [otherId, otherId] } },
    { name: "outside dependency set", changes: { externalDependsOn: [projectId] } },
    { name: "unordered external set", changes: { externalDependsOn: [normalId, otherId] } },
    { name: "unordered complete set", changes: { dependsOn: [normalId, otherId] } },
  ])("rejects $name dependency classification in full and graph task resources", async ({ changes }) => {
    const value = { ...task, dependsOn: [otherId, normalId], externalDependsOn: [otherId], blockedBy: [otherId], ready: false, ...changes };
    const graphValue = mixedDependencyGraph();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(value))
      .mockResolvedValueOnce(jsonResponse({ ...graphValue, tasks: [{ ...graphValue.tasks[0]!, ...changes }, ...graphValue.tasks.slice(1)] }));
    const api = client(fetch);
    await expect(api.getTask(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    await expect(api.getTaskGraph(projectId)).rejects.toMatchObject({ phase: "protocol" });
  });

  it("rejects an all-external cycle and a graph that hides unfinished external blockers", async () => {
    const value = graph();
    const cyclic = {
      ...value,
      summary: { total: 2, todo: 2, inProgress: 0, done: 0, ready: 0, blocked: 2 },
      tasks: [
        { ...value.tasks[0]!, externalDependsOn: [otherId], blockedBy: [otherId], ready: false },
        { ...value.tasks[1]!, status: "todo", dependsOn: [taskId], externalDependsOn: [taskId], blockedBy: [taskId] },
      ],
    };
    const mixed = mixedDependencyGraph();
    const hiddenBlocker = { ...mixed, summary: { ...mixed.summary, ready: 2, blocked: 0 }, tasks: [{ ...mixed.tasks[0]!, blockedBy: [], ready: true }, ...mixed.tasks.slice(1)] };
    for (const response of [cyclic, hiddenBlocker]) {
      await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(response))).getTaskGraph(projectId)).rejects.toMatchObject({ phase: "protocol" });
    }
  });

  it.each([1n, 9_007_199_254_740_993n, 9_223_372_036_854_775_807n])("preserves nested settings version %s through create, project, list and graph resources", async (version) => {
    const value = { ...project, settings: { version, executionWarningMinutes: 2_147_483_647 } };
    const graphValue = { ...graph(), project: value };
    const wire = stringifyApiJson(value);
    expect(wire).toContain(`"settings":{"version":${version},"executionWarningMinutes":2147483647}`);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(value, 201))
      .mockResolvedValueOnce(jsonResponse(value))
      .mockResolvedValueOnce(jsonResponse({ items: [value], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse(graphValue));
    const api = client(fetch);
    await expect(api.createProject({ name: value.name, repoUrl: value.repoUrl })).resolves.toEqual(value);
    await expect(api.getProject(projectId)).resolves.toEqual(value);
    await expect(api.listProjects()).resolves.toEqual([value]);
    await expect(api.getTaskGraph(projectId)).resolves.toEqual(graphValue);
  });

  it.each([
    undefined, null, [], {},
    { version: 1n }, { executionWarningMinutes: 60 },
    ...[null, "1", 0, -1, 1.5].map((version) => ({ version, executionWarningMinutes: 60 })),
    ...[undefined, null, "60", true, 0, -1, 1.5, 2_147_483_648].map((executionWarningMinutes) => ({ version: 1n, executionWarningMinutes })),
  ])("rejects absent or malformed project settings across project, list and graph responses %#", async (settings) => {
    const value = { ...project, settings };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(value))
      .mockResolvedValueOnce(jsonResponse({ items: [value], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse({ ...graph(), project: value }));
    const api = client(fetch);
    await expect(api.getProject(projectId)).rejects.toMatchObject({ phase: "protocol" });
    await expect(api.listProjects()).rejects.toMatchObject({ phase: "protocol" });
    await expect(api.getTaskGraph(projectId)).rejects.toMatchObject({ phase: "protocol" });
  });

  it.each(["1.0", "1e3", "9223372036854775808"])("rejects non-int64 settings version lexeme %s before rounding can be accepted", async (version) => {
    const wire = stringifyApiJson(project).replace('"version":1', `"version":${version}`);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(wire, { headers: { "Content-Type": "application/json" } }));
    await expect(client(fetch).getProject(projectId)).rejects.toMatchObject({ phase: "protocol" });
  });

  it.each([
    { startedAt: null, completedAt: null },
    { startedAt: time, completedAt: null },
    { startedAt: null, completedAt: time },
    { startedAt: "2026-10-20T00:00:00Z", completedAt: time },
  ])("preserves known and unknown execution timestamps across task, list and graph resources: %j", async (timing) => {
    const value = { ...task, status: "done", ready: false, ...timing };
    const taskGraph = graph();
    const graphValue = { ...taskGraph, tasks: taskGraph.tasks.map((item) => item.status === "done" ? { ...item, ...timing } : item) };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(value))
      .mockResolvedValueOnce(jsonResponse({ items: [value], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse(graphValue));
    const api = client(fetch);
    await expect(api.getTask(projectId, taskId)).resolves.toEqual(value);
    await expect(api.listTasks(projectId)).resolves.toEqual([value]);
    await expect(api.getTaskGraph(projectId)).resolves.toEqual(graphValue);
  });

  it.each(["startedAt", "completedAt"] as const)("requires an explicit null or valid UTC timestamp for %s", async (field) => {
    for (const invalid of [undefined, 0, false, "", "invalid", "2026-02-30T00:00:00Z", "2026-10-20T00:00:00+00:00"]) {
      const taskValue = { ...task, [field]: invalid };
      const taskGraph = graph();
      const graphValue = { ...taskGraph, tasks: [{ ...taskGraph.tasks[0]!, [field]: invalid }, taskGraph.tasks[1]!] };
      const fetch = vi.fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(jsonResponse(taskValue))
        .mockResolvedValueOnce(jsonResponse(graphValue));
      const api = client(fetch);
      await expect(api.getTask(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
      await expect(api.getTaskGraph(projectId)).rejects.toMatchObject({ phase: "protocol" });
    }
  });

  it.each([undefined, null, 0, "invalid", "2026-02-30T00:00:00Z", "2026-10-20T00:00:00+00:00"])("requires the database clock timestamp without a client fallback: %j", async (observedAt) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...graph(), observedAt })))
      .getTaskGraph(projectId)).rejects.toMatchObject({ phase: "protocol" });
  });

  it.each(["todo", "in_progress", "done"])("reads %s tasks and paginated inventories with lossless versions and complete descriptions", async (status) => {
    const value = { ...task, status, ready: status === "todo", description: "Complete\nTask description", version: 9_223_372_036_854_775_807n };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(value))
      .mockResolvedValueOnce(jsonResponse({ items: [value], nextCursor: "second-page" }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ ...value, id: otherId }], nextCursor: null }));
    const api = client(fetch);
    expect(await api.getTask(projectId, taskId)).toEqual(value);
    expect(await api.listTasks(projectId)).toEqual([value, { ...value, id: otherId }]);
  });

  it("retains unfinished prerequisites on todo tasks while keeping them unready", async () => {
    const value = { ...task, status: "todo", ready: false, dependsOn: [otherId], externalDependsOn: [], blockedBy: [otherId] };
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(value))).getTask(projectId, taskId)).resolves.toEqual(value);
  });

  it("projects all three graph states and counts only blocked todo tasks as blocked", async () => {
    const value = threeStateGraph();
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(value))).getTaskGraph(projectId)).resolves.toEqual(value);
    const empty = { observedAt: time, project, summary: { total: 0, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 }, tasks: [] };
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(empty))).getTaskGraph(projectId)).resolves.toEqual(empty);
  });

  it.each([
    { todo: undefined }, { todo: null }, { todo: "2" }, { todo: -1 }, { todo: 1.5 },
    { total: 5 }, { todo: 5 }, { inProgress: 2 }, { done: 2 }, { ready: 2 }, { blocked: 2 },
  ])("rejects missing, malformed or inconsistent three-state graph counters %#", async (changes) => {
    const value = threeStateGraph();
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...value, summary: { ...value.summary, ...changes } }))).getTaskGraph(projectId)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
  });

  it.each(["todo-ready", "todo-blockers", "in-progress-blocked", "done-blocked", "proposed"])("rejects invalid three-state graph dependency data: %s", async (failure) => {
    const value = threeStateGraph();
    const tasks = value.tasks.map((item) => ({ ...item }));
    if (failure === "todo-ready") tasks[1] = { ...tasks[1]!, ready: true };
    if (failure === "todo-blockers") tasks[1] = { ...tasks[1]!, blockedBy: [] };
    if (failure === "proposed") tasks[0] = { ...tasks[0]!, status: "proposed" as never };
    if (failure === "in-progress-blocked" || failure === "done-blocked") {
      const index = failure === "in-progress-blocked" ? 2 : 3;
      tasks[index] = { ...tasks[index]!, dependsOn: [tasks[0]!.id], blockedBy: [tasks[0]!.id] };
    }
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...value, tasks }))).getTaskGraph(projectId)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
  });

  it("projects complete raw PR properties without interpreting their content or future fields", async () => {
    const pullRequests = [{ url: "", title: "\0\n\u0085\u001b[2J" }, { url: "  任意文本  ", title: "" }, { url: "  任意文本  ", title: "" }];
    const expected = { ...task, properties: { worker: null, pullRequests } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...expected, properties: { worker: null, future: null, pullRequests: pullRequests.map((item) => ({ ...item, metadata: { version: 1.5 } })) } }));
    expect(await client(fetch).getTask(projectId, taskId)).toEqual(expected);
  });

  it.each([
    undefined, null, [], {}, { pullRequests: null }, { pullRequests: {} },
    { pullRequests: [null] }, { pullRequests: [[]] }, { pullRequests: [{}] },
    { pullRequests: [{ url: "" }] }, { pullRequests: [{ title: "" }] },
    { pullRequests: [{ url: 42, title: "" }] }, { pullRequests: [{ url: "", title: false }] },
  ])("rejects missing or malformed required properties %#", async (properties) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...task, properties: { ...properties, worker: null } }))).getTask(projectId, taskId)).rejects.toMatchObject({ phase: "protocol", cause: expect.any(Error) });
  });

  it("applies response byte budgets to PR content without truncating resources", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...task, properties: { worker: null, pullRequests: [{ url: "T".repeat(2048), title: "Title" }] } }));
    await expect(client(fetch, operation({ limits: { responseBytes: 1024 } })).getTask(projectId, taskId)).rejects.toMatchObject({ phase: "response", cause: { kind: "response_limit" } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves Go-valid FEFF-only names and titles without treating them as whitespace", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...project, name: "\uFEFF" }))
      .mockResolvedValueOnce(jsonResponse({ ...task, title: "\uFEFF", description: "\u0001\u0085" }));
    const api = client(fetch);
    expect((await api.getProject(projectId)).name).toBe("\uFEFF");
    expect(await api.getTask(projectId, taskId)).toMatchObject({ title: "\uFEFF", description: "\u0001\u0085" });
  });
  it.each(["project", "task"])("rejects Go-whitespace-only NEL in %s text", async (resource) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(resource === "project" ? { ...project, name: "\u0085" } : { ...task, title: "\u0085" }));
    const api = client(fetch);
    await expect(resource === "project" ? api.getProject(projectId) : api.getTask(projectId, taskId)).rejects.toBeInstanceOf(ApiError);
  });
  it.each(["project", "task"])("rejects unpaired surrogates in %s text", async (resource) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(resource === "project" ? { ...project, name: "\uD800" } : { ...task, description: "\uD800" }));
    const api = client(fetch);
    await expect(resource === "project" ? api.getProject(projectId) : api.getTask(projectId, taskId)).rejects.toBeInstanceOf(ApiError);
  });
  it("ignores unknown numeric version fields while validating known Task versions losslessly", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...project, version: 0, metadata: { version: 1.5 } }));
    expect(await client(fetch).getProject(projectId)).toEqual(project);
    for (const version of ["1.0", "1e3", "9223372036854775808"]) {
      const serialized = stringifyApiJson(task).replace('"version":1', `"version":${version}`);
      await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(serialized, { headers: { "Content-Type": "application/json" } }))).getTask(projectId, taskId)).rejects.toBeInstanceOf(ApiError);
    }
  });
  it("returns a complete graph and ignores future additional fields", async () => {
    const value = graph();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...value, futureField: 42 }));
    expect(await client(fetch).getTaskGraph(projectId)).toEqual(value);
  });
  it.each([
    { ...task, version: "1" }, { ...task, version: 0 }, { ...task, version: 1.5 }, { ...task, status: "invalid" },
    { ...task, status: "proposed" },
    { ...task, status: "in_progress", ready: false, dependsOn: [otherId], externalDependsOn: [], blockedBy: [otherId] },
    { ...task, status: "done", ready: false, dependsOn: [otherId], externalDependsOn: [], blockedBy: [otherId] },
    { ...task, description: "bad\0text" }, { ...task, ready: false },
    { ...task, dependsOn: [otherId, otherId] }, { ...task, blockedBy: [otherId] },
    { ...task, createdAt: "2026-02-30T01:02:03Z" }, { ...task, updatedAt: "2026-10-20T01:02:03+00:00" },
    { ...task, id: otherId }, { ...task, projectId: otherId }, { ...task, title: " " },
  ])("rejects malformed or mismatched task DTO %#", async (value) => {
    // Use ordinary stringify so deliberately invalid zero versions reach the response parser.
    const serialized = JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? Number(item) : item);
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(serialized, { headers: { "Content-Type": "application/json" } }))).getTask(projectId, taskId)).rejects.toBeInstanceOf(ApiError);
  });
  it.each(["summary", "dangling", "cycle", "blocked", "preview", "duplicate"])("rejects inconsistent graph %s", async (failure) => {
    const value = graph();
    const tasks = value.tasks.map((item) => ({ ...item }));
    let summary = value.summary;
    if (failure === "summary") summary = { ...summary, total: 3 };
    if (failure === "dangling") tasks[0] = { ...tasks[0]!, dependsOn: [projectId] };
    if (failure === "cycle") tasks[1] = { ...tasks[1]!, dependsOn: [taskId], blockedBy: [taskId] };
    if (failure === "blocked") tasks[0] = { ...tasks[0]!, blockedBy: [otherId], ready: false };
    if (failure === "preview") tasks[0] = { ...tasks[0]!, titleTruncated: true };
    if (failure === "duplicate") tasks[1] = { ...tasks[1]!, id: taskId };
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...value, tasks, summary }))).getTaskGraph(projectId)).rejects.toBeInstanceOf(ApiError);
  });
  it("accepts a whitespace preview cut from a nonempty long title", async () => {
    const value = graph();
    const tasks = [{ ...value.tasks[0]!, titlePreview: " ".repeat(160), titleTruncated: true }, value.tasks[1]!];
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...value, tasks }))).getTaskGraph(projectId)).resolves.toMatchObject({ tasks });
  });
});
