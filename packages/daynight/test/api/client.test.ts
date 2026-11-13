import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, createOperation, DEFAULT_OPERATION_LIMITS, OperationError, parseApiJson, parseVersionArgument, stringifyApiJson } from "../../src/api/index.js";
import type { Operation, TaskGraph, TaskPlatform } from "../../src/api/index.js";

const projectId = "11111111-1111-1111-1111-111111111111";
const taskId = "22222222-2222-2222-2222-222222222222";
const otherId = "33333333-3333-3333-3333-333333333333";
const normalId = "44444444-4444-4444-4444-444444444444";
const time = "2026-10-20T01:02:03.123456789Z";
const project = { id: projectId, name: "Project", repoUrl: "git@github.com:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: time, updatedAt: time };
const task = { id: taskId, type: "task", parentId: null, projectId, title: "Task", description: "", tags: [], properties: { pullRequests: [] }, status: "todo", allowAgents: false, requiredPlatform: null, assignedTo: null, version: 1n, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true };
const refusal = (code = "not_found", details?: unknown) => ({ error: { code, message: "Actual server explanation.", requestId: "req-1", ...(details === undefined ? {} : { details }) } });
const jsonResponse = (value: unknown, status = 200, principal?: string) => new Response(stringifyApiJson(value), { status, headers: { "Content-Type": "application/json", ...(principal === undefined ? {} : { "Daynight-User-ID": principal }) } });
const creationReceipt = <T extends { id: string; ownership: { teamId: string; version: bigint }; createdAt: string; updatedAt: string }>(value: T, userId: string) => ({ ...value, access: { projectId: value.id, ownerTeam: { id: value.ownership.teamId, kind: "personal", name: null }, ownership: value.ownership, effectiveRole: "admin", teamRole: "admin", canTransfer: true, directGrant: { projectId: value.id, userId, role: "admin", version: 1n, createdAt: value.createdAt, updatedAt: value.updatedAt } } });
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
  it.each([undefined, "proposed", "todo"] as const)("creates initial status %s and confirms the returned status", async (status) => {
    const result = { ...task, status: status ?? "proposed", ready: status === "todo" };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(result, 201));
    await expect(client(fetch).createTask(projectId, { title: "Task", ...(status === undefined ? {} : { status }) })).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledOnce();
    expect(parseApiJson(String(fetch.mock.calls[0]![1]!.body))).toEqual({ title: "Task", ...(status === undefined ? {} : { status }) });
  });

  it.each(["in_progress", "done", "cancelled", "invalid", null])("rejects unsupported initial status %s before I/O", (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => client(fetch).createTask(projectId, { title: "Task", status } as never)).toThrow("Initial task status");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not accept an old default-todo server response for proposed creation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(task, 201));
    await expect(client(fetch).createTask(projectId, { title: "Task" })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([null, "windows", "linux", "macos"] as const)("preserves requiredPlatform=%s in create, update and graph resources", async (requiredPlatform) => {
    const value = { ...task, requiredPlatform };
    const taskGraph = { ...graph(), tasks: graph().tasks.map((item) => ({ ...item, requiredPlatform })) };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(value, 201))
      .mockResolvedValueOnce(jsonResponse(value))
      .mockResolvedValueOnce(jsonResponse(taskGraph));
    const api = client(fetch);
    await expect(api.createTask(projectId, { status: "todo", title: "Platform task", requiredPlatform })).resolves.toEqual(value);
    await expect(api.updateTask(projectId, taskId, { version: 9_223_372_036_854_775_807n, requiredPlatform })).resolves.toEqual(value);
    await expect(api.getTaskGraph(projectId, taskId)).resolves.toEqual(taskGraph);
    expect(parseApiJson(String(fetch.mock.calls[0]![1]!.body))).toEqual({ title: "Platform task", status: "todo", requiredPlatform });
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

  it.each(["me", "unassigned", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"])("preserves assignedTo=%s across every task page", async (assignedTo) => {
    const principal = assignedTo === "me" ? otherId : undefined;
    const selected = assignedTo === "unassigned" ? null : assignedTo === "me" ? otherId : assignedTo.toLowerCase();
    const first = { ...task, assignedTo: selected };
    const second = { ...first, id: otherId };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [first], nextCursor: "assigned cursor+/=" }, 200, principal))
      .mockResolvedValueOnce(jsonResponse({ items: [second], nextCursor: null }, 200, principal));
    await expect(client(fetch).listTasks(projectId, { assignedTo })).resolves.toEqual([first, second]);
    expect(fetch.mock.calls.map(([url]) => Object.fromEntries(new URL(String(url)).searchParams))).toEqual([
      { assignedTo: assignedTo.toLowerCase(), limit: "100" },
      { assignedTo: assignedTo.toLowerCase(), limit: "100", cursor: "assigned cursor+/=" },
    ]);
  });

  it.each(["", "invalid", "Me", "all", ` ${otherId}`, null, false, 1, {}, []])("rejects an invalid assignee filter %s before dispatch", (assignedTo) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = client(fetch);
    expect(() => api.listTasks(projectId, { assignedTo } as never)).toThrow("Assigned-to filter must be a hyphenated UUID, me or unassigned.");
    expect(() => api.listTaskPage(projectId, { assignedTo, limit: 1 } as never)).toThrow("Assigned-to filter must be a hyphenated UUID, me or unassigned.");
    expect(fetch).not.toHaveBeenCalled();
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
    await expect(api.getTaskGraph(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
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
    await expect(api.getTaskGraph(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, false, true])("submits exact deletion consent %s once without other reads", async (removeDepends) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const input = { version: 9_223_372_036_854_775_807n, ...(removeDepends === undefined ? {} : { removeDepends }) };
    await expect(client(fetch).deleteTask(projectId, taskId, input)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}`);
    expect(options).toMatchObject({ method: "DELETE", body: `{"version":9223372036854775807${removeDepends === undefined ? "" : `,"removeDepends":${removeDepends}`}}`, redirect: "manual", cache: "no-store" });
  });

  it.each([null, "true", "false", 0, 1, [], {}])("rejects invalid deletion consent %j before I/O", (removeDepends) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => client(fetch).deleteTask(projectId, taskId, { version: 1n, removeDepends: removeDepends as never })).toThrow("removeDepends must be a boolean");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["proposed", "todo", "in_progress", "done", "cancelled"] as const)("submits one precise %s PUT and reads the full resulting task", async (status) => {
    const version = 9_223_372_036_854_775_806n;
    const result = { ...task, status, cancelledAt: status === "cancelled" ? time : null, ready: status === "todo", description: "Full result", version: version + 1n };
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

  it("preserves capacity refusals for reads and writes without replay", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => jsonResponse(refusal("resource_limit_exceeded"), 409));
    const api = client(fetch);
    await expect(api.listTasks(projectId)).rejects.toMatchObject({ status: 409, code: "resource_limit_exceeded", confirmedRefusal: true });
    await expect(api.setTaskStatus(projectId, taskId, { version: 1n, status: "todo" })).rejects.toMatchObject({ status: 409, code: "resource_limit_exceeded", confirmedRefusal: true, outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([0n, -1n, 9_223_372_036_854_775_808n])("rejects invalid setter version %s before I/O", (version) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => client(fetch).setTaskStatus(projectId, taskId, { version, status: "todo" })).toThrow("positive int64");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unknown task status input before I/O", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = client(fetch);
    expect(() => api.listTasks(projectId, { status: "unknown" as never })).toThrow("Task status");
    expect(() => api.setTaskStatus(projectId, taskId, { version: 1n, status: "unknown" as never })).toThrow("Task status");
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

  it("reports remaining total bytes while permitting a complete response at the exact limit", () => {
    const op = operation({ limits: { totalBytes: 5 } });
    expect(op.remainingBytes()).toBe(5);
    op.consume(3); expect(op.remainingBytes()).toBe(2);
    op.consume(2); expect(op.remainingBytes()).toBe(0);
    expect(() => op.check()).not.toThrow(); expect(op.signal.aborted).toBe(false);
    op.consume(0); expect(op.remainingBytes()).toBe(0);
    expect(() => op.consume(1)).toThrow("response byte budget");
    expect(() => op.remainingBytes()).toThrow("response byte budget");
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
      .mockResolvedValueOnce(jsonResponse(creationReceipt(project, projectId), 201, projectId))
      .mockResolvedValueOnce(jsonResponse(task, 201))
      .mockResolvedValueOnce(jsonResponse(task, 201))
      .mockResolvedValueOnce(jsonResponse({ ...task, version: 9_007_199_254_740_994n }));
    const api = client(fetch);
    await api.createProject({ name: "Project", repoUrl: project.repoUrl, expectedUserId: projectId });
    await api.createTask(projectId, { status: "todo", title: "Task" });
    await api.createTask(projectId, { status: "todo", title: "Task", description: "", dependsOn: [otherId, otherId] });
    await api.updateTask(projectId, taskId, { version: 9_007_199_254_740_993n, description: "", dependsOn: [] });
    expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "POST", "POST", "PATCH"]);
    expect(fetch.mock.calls.map((call) => call[1]?.body)).toEqual([
      JSON.stringify({ name: "Project", repoUrl: project.repoUrl, expectedUserId: projectId }),
      '{"title":"Task","status":"todo"}',
      JSON.stringify({ title: "Task", status: "todo", description: "", dependsOn: [otherId, otherId] }),
      '{"version":9007199254740993,"description":"","dependsOn":[]}',
    ]);
    expect(fetch.mock.calls.every((call) => call[1]?.redirect === "manual")).toBe(true);
  });

  it("writes full PR lists unchanged and distinguishes omission from explicit clearing", async () => {
    const properties = { pullRequests: [{ url: "\0 arbitrary text\n", title: "" }, { url: "\0 arbitrary text\n", title: "" }] };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...task, properties: { ...properties } }, 201))
      .mockResolvedValueOnce(jsonResponse({ ...task, properties: { ...properties } }))
      .mockResolvedValueOnce(jsonResponse(task));
    const api = client(fetch);
    expect((await api.createTask(projectId, { status: "todo", title: "Task", properties })).properties).toEqual({ ...properties });
    await api.updateTask(projectId, taskId, { version: 9_223_372_036_854_775_807n, properties });
    await api.updateTask(projectId, taskId, { version: 1n, properties: { pullRequests: [] } });
    expect(fetch.mock.calls.map((call) => parseApiJson(String(call[1]!.body)))).toEqual([
      { title: "Task", status: "todo", properties },
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
    await expect(api.createTask(projectId, { status: "todo", title: "Task", dependsOn: [otherId], externalDependsOn: [otherId] })).resolves.toEqual(value);
    await api.updateTask(projectId, taskId, { version: 9_223_372_036_854_775_807n, externalDependsOn: [otherId] });
    await api.updateTask(projectId, taskId, { version: 1n, externalDependsOn: [] });
    await api.updateTask(projectId, taskId, { version: 1n, dependsOn: [otherId] });
    expect(fetch.mock.calls.map((call) => parseApiJson(String(call[1]!.body)))).toEqual([
      { title: "Task", status: "todo", dependsOn: [otherId], externalDependsOn: [otherId] },
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
    const tasks = [{ ...task, properties: { pullRequests: [{ url: "\0 arbitrary URL", title: "Ready\nPR" }] }, version: 9_223_372_036_854_775_807n }, { ...task, id: otherId }];
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

  it("preserves confirmed API refusals, dependency IDs and generic graph read errors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(refusal("dependency_unsatisfied", { taskIds: [otherId] }), 409))
      .mockResolvedValueOnce(jsonResponse(refusal("service_unavailable"), 503));
    const api = client(fetch);
    await expect(api.setTaskStatus(projectId, taskId, { version: 1n, status: "done" })).rejects.toMatchObject({
      operation: "task.set-status", phase: "response", projectId, taskId, status: 409, code: "dependency_unsatisfied", requestId: "req-1", details: { taskIds: [otherId] }, confirmedRefusal: true, outcomeUnconfirmed: false, cause: expect.any(Error),
    });
    await expect(api.getTaskGraph(projectId, taskId)).rejects.toMatchObject({ code: "service_unavailable", requestId: "req-1" });
  });

  it("never forwards a POST redirect to a second destination", async () => {
    const methods: string[] = [];
    const url = await server((request, response) => {
      methods.push(`${request.method} ${request.url}`);
      response.writeHead(307, { Location: "/elsewhere", "Content-Type": "application/json" });
      response.end("{}");
    });
    const api = createApiClient({ serverUrl: url, operation: operation() });
    await expect(api.createProject({ name: "Project", repoUrl: project.repoUrl, expectedUserId: projectId })).rejects.toMatchObject({ status: 307, outcomeUnconfirmed: true });
    expect(methods).toEqual(["POST /api/v1/projects"]);
  });

  it("reports an unconfirmed mutation when its response exceeds a byte limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(task, 201));
    await expect(client(fetch, operation({ limits: { responseBytes: 10 } })).createTask(projectId, { status: "todo", title: "Task" })).rejects.toMatchObject({ outcomeUnconfirmed: true, confirmedRefusal: false, cause: { kind: "response_limit" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("marks disconnected mutation results unconfirmed and does not retry", async () => {
    let mutations = 0;
    const url = await server((request) => { mutations++; request.socket.destroy(); });
    await expect(createApiClient({ serverUrl: url, operation: operation() }).createTask(projectId, { status: "todo", title: "Task" })).rejects.toMatchObject({ operation: "task.create", outcomeUnconfirmed: true, confirmedRefusal: false, cause: expect.any(Error) });
    expect(mutations).toBe(1);
  });

  it.each(["headers", "body"])("enforces the real HTTP request timeout while waiting for %s", async (waitingFor) => {
    let requests = 0;
    const url = await server((_request, response) => {
      requests++;
      if (waitingFor === "body") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"items":');
      }
    });
    const api = createApiClient({ serverUrl: url, operation: operation({ limits: { requestMs: 50 } }) });
    await expect(api.listProjects()).rejects.toMatchObject({ phase: waitingFor === "headers" ? "request" : "response", cause: { kind: "request_timeout" } });
    expect(requests).toBe(1);
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
    await expect(client(fetch).createTask(projectId, { status: "todo", title: "Task" })).rejects.toMatchObject({ cause, outcomeUnconfirmed: true });
  });

  it("rejects unsupported timer ranges before starting an operation", () => {
    expect(() => createOperation({ limits: { totalMs: 2_147_483_648 } })).toThrow("timer range");
    expect(() => createOperation({ limits: { requestMs: 2_147_483_648 } })).toThrow("timer range");
  });

  it("checks the single request deadline after synchronous parsing stalls the timer", async () => {
    const response = jsonResponse(project);
    let elapsed = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const original = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((...args: Parameters<typeof JSON.parse>) => {
      elapsed = 15;
      return original(...args);
    });
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response), operation({ limits: { requestMs: 10 } })).getProject(projectId)).rejects.toMatchObject({ phase: "protocol", cause: { kind: "request_timeout" } });
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

  it.each([false, true])("applies the decoded response limit at exact bytes and one byte over (over=%s)", async (over) => {
    const body = stringifyApiJson({ ...project, name: "Project 中文" });
    const bytes = Buffer.byteLength(body);
    const compressed = gzipSync(body + (over ? " " : ""));
    expect(compressed.length).toBeLessThan(bytes);
    let requests = 0;
    const url = await server((_request, response) => {
      requests++;
      response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": compressed.length });
      response.end(compressed);
    });
    const api = createApiClient({ serverUrl: url, operation: operation({ limits: { responseBytes: bytes } }) });
    if (over) await expect(api.getProject(projectId)).rejects.toMatchObject({ cause: { kind: "response_limit" } });
    else await expect(api.getProject(projectId)).resolves.toEqual({ ...project, name: "Project 中文" });
    expect(requests).toBe(1);
  });

  it.each([false, true])("applies the cumulative byte limit over complete pages at exact bytes and one byte over (over=%s)", async (over) => {
    const projects = [project, { ...project, id: otherId }, { ...project, id: normalId }];
    const pages = projects.map((value, index) => stringifyApiJson({ items: [value], nextCursor: index < 2 ? `cursor-${index + 1}` : null }));
    const totalBytes = pages.reduce((sum, page) => sum + Buffer.byteLength(page), 0);
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      const index = fetch.mock.calls.length - 1;
      return new Response(pages[index]! + (index === 2 && over ? " " : ""), { headers: { "Content-Type": "application/json" } });
    });
    const api = client(fetch, operation({ limits: { totalBytes, responseBytes: Math.max(...pages.map((page) => Buffer.byteLength(page))) + 1 } }));
    if (over) await expect(api.listProjects()).rejects.toMatchObject({ cause: { kind: "total_limit" } });
    else await expect(api.listProjects()).resolves.toEqual(projects);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("cursor"))).toEqual([null, "cursor-1", "cursor-2"]);
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
    let elapsed = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const cursors: (string | null)[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => {
      cursors.push(new URL(String(url)).searchParams.get("cursor"));
      if (page === 4) throw new Error("Pagination continued beyond the shared deadline");
      elapsed += 10;
      page++;
      const suffix = page.toString(16).padStart(12, "0");
      return jsonResponse({ items: [{ ...project, id: `11111111-1111-1111-1111-${suffix}` }], nextCursor: Buffer.from(`cursor-${page}`).toString("base64url") });
    });
    await expect(client(fetch, operation({ limits: { totalMs: 35, requestMs: 100 } })).listProjects()).rejects.toMatchObject({ cause: { kind: "deadline" } });
    expect(page).toBe(4);
    expect(page).toBeGreaterThan(1);
    expect(cursors).toEqual([null, ...[1, 2, 3].map((value) => Buffer.from(`cursor-${value}`).toString("base64url"))]);
    expect(new Set(cursors).size).toBe(cursors.length);
    expect(cursors.length - page).toBeLessThanOrEqual(1);
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
    await expect(client(fetch, operation({ signal: source.signal })).createProject({ name: "P", repoUrl: project.repoUrl, expectedUserId: projectId })).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, cause: { kind: "cancelled" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

const graph = (): TaskGraph => ({
  observedAt: time,
  project,
  summary: { total: 2, proposed: 0, todo: 1, inProgress: 0, done: 1, cancelled: 0, ready: 1, blocked: 0 },
  tasks: [
    { id: taskId, type: "task", parentId: null, titlePreview: "Task", titleTruncated: false, allowAgents: false, requiredPlatform: null, assignedTo: null, status: "todo", dependsOn: [otherId], externalDependsOn: [], blockedBy: [], ready: true, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time },
    { id: otherId, type: "task", parentId: null, titlePreview: "Done", titleTruncated: false, allowAgents: false, requiredPlatform: null, assignedTo: null, status: "done", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time },
  ],
});

const mixedDependencyGraph = (): TaskGraph => ({
  observedAt: time,
  project,
  summary: { total: 3, proposed: 0, todo: 2, inProgress: 0, done: 1, cancelled: 0, ready: 1, blocked: 1 },
  tasks: [
    { ...graph().tasks[0]!, allowAgents: true, dependsOn: [otherId, normalId], externalDependsOn: [otherId], blockedBy: [otherId], ready: false },
    { ...graph().tasks[1]!, status: "todo", ready: true },
    { ...graph().tasks[1]!, id: normalId },
  ],
});

const statusGraph = (): TaskGraph => {
  const ready = graph().tasks[0]!;
  const done = graph().tasks[1]!;
  const blocked = { ...ready, id: "44444444-4444-4444-4444-444444444444", ready: false, dependsOn: [ready.id], blockedBy: [ready.id] };
  const inProgress = { ...ready, id: "88888888-8888-8888-8888-888888888888", status: "in_progress" as const, ready: false };
  return { observedAt: time, project, summary: { total: 4, proposed: 0, todo: 2, inProgress: 1, done: 1, cancelled: 0, ready: 1, blocked: 1 }, tasks: [ready, blocked, inProgress, done] };
};

const joinId = "55555555-5555-5555-5555-555555555555";
const externalId = "66666666-6666-6666-6666-666666666666";
const outsideId = "77777777-7777-7777-7777-777777777777";
const externalDependencyId = "99999999-9999-9999-9999-999999999999";
const chainProjection = (): TaskGraph => {
  const node = (id: string, dependsOn: string[] = [], externalDependsOn: string[] = []) => ({
    ...graph().tasks[0]!, id, dependsOn, externalDependsOn, blockedBy: dependsOn, ready: dependsOn.length === 0,
  });
  return {
    observedAt: time, project,
    summary: { total: 5, proposed: 0, todo: 5, inProgress: 0, done: 0, cancelled: 0, ready: 1, blocked: 4 },
    tasks: [node(taskId), node(otherId, [taskId, externalId], [externalId]), node(normalId, [taskId]), node(joinId, [otherId, normalId]), node(externalId, [outsideId, externalDependencyId], [externalDependencyId])],
  };
};

describe("response DTO contract", () => {
  it.each([taskId, otherId, normalId, joinId])("reads the full fork/join chain from %s with one external prerequisite and its raw dependency references", async (seed) => {
    const value = chainProjection();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(value));
    await expect(client(fetch).getTaskGraph(projectId.toUpperCase(), seed.toUpperCase())).resolves.toEqual(value);
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe(`/api/v1/projects/${projectId}/task-graph`);
    expect(Object.fromEntries(new URL(String(fetch.mock.calls[0]![0])).searchParams)).toEqual({ taskId: seed });
  });

  it("rejects an invalid graph target before making a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => client(fetch).getTaskGraph(projectId, "invalid")).toThrow("Resource ID must be a hyphenated UUID.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["missing-root", "reverse-external", "recursive-external", "context-known-blocker"])("rejects a graph with %s", async (failure) => {
    const value = chainProjection();
    let tasks = value.tasks.map((item) => ({ ...item }));
    let seed = otherId;
    if (failure === "missing-root") seed = outsideId;
    if (failure === "reverse-external") tasks.push({ ...tasks[1]!, id: outsideId, dependsOn: [otherId], externalDependsOn: [otherId], blockedBy: [otherId] });
    if (failure === "recursive-external") tasks.push({ ...tasks[0]!, id: outsideId });
    if (failure === "context-known-blocker") tasks[4] = { ...tasks[4]!, dependsOn: [taskId, outsideId], externalDependsOn: [taskId], blockedBy: [outsideId] };
    const summary = { total: tasks.length, proposed: 0, todo: tasks.length, inProgress: 0, done: 0, cancelled: 0, ready: tasks.filter((task) => task.ready).length, blocked: tasks.filter((task) => !task.ready).length };
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...value, tasks, summary }))).getTaskGraph(projectId, seed)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
  });

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
    await expect(api.getTaskGraph(projectId, taskId)).resolves.toEqual(graphValue);
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
    await expect(api.getTaskGraph(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
  });

  it("rejects a graph that hides unfinished external blockers", async () => {
    const mixed = mixedDependencyGraph();
    const hiddenBlocker = { ...mixed, summary: { ...mixed.summary, ready: 2, blocked: 0 }, tasks: [{ ...mixed.tasks[0]!, blockedBy: [], ready: true }, ...mixed.tasks.slice(1)] };
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(hiddenBlocker))).getTaskGraph(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
  });

  it.each([1n, 9_007_199_254_740_993n, 9_223_372_036_854_775_807n])("preserves nested settings version %s through create, project, list and graph resources", async (version) => {
    const value = { ...project, settings: { version, executionWarningMinutes: 2_147_483_647 } };
    const graphValue = { ...graph(), project: value };
    const wire = stringifyApiJson(value);
    expect(wire).toContain(`"settings":{"version":${version},"executionWarningMinutes":2147483647}`);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(creationReceipt(value, projectId), 201, projectId))
      .mockResolvedValueOnce(jsonResponse(value))
      .mockResolvedValueOnce(jsonResponse({ items: [value], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse(graphValue));
    const api = client(fetch);
    await expect(api.createProject({ name: value.name, repoUrl: value.repoUrl, expectedUserId: projectId })).resolves.toEqual(value);
    await expect(api.getProject(projectId)).resolves.toEqual(value);
    await expect(api.listProjects()).resolves.toEqual([value]);
    await expect(api.getTaskGraph(projectId, taskId)).resolves.toEqual(graphValue);
  });

  it("encodes an explicit team and checks the created ownership and direct grant", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(creationReceipt(project, projectId), 201, projectId));
    const api = client(fetch);
    const teamId = project.ownership.teamId;
    await expect(api.createProject({ name: project.name, repoUrl: project.repoUrl, expectedUserId: projectId.toUpperCase(), teamId: teamId.toUpperCase() })).resolves.toEqual(project);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ name: project.name, repoUrl: project.repoUrl, expectedUserId: projectId, teamId });
    const receipt = creationReceipt(project, projectId);
    for (const mismatch of [{ name: "Different" }, { repoUrl: "https://example.test/other/repo" }]) {
      fetch.mockResolvedValueOnce(jsonResponse({ ...receipt, ...mismatch }, 201, projectId));
      await expect(api.createProject({ name: project.name, repoUrl: project.repoUrl, expectedUserId: projectId, teamId })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    }
    for (const access of [
      { ...receipt.access, ownership: { ...receipt.access.ownership, version: 2n } },
      { ...receipt.access, directGrant: null },
      { ...receipt.access, directGrant: { ...receipt.access.directGrant, userId: otherId } },
    ]) {
      fetch.mockResolvedValueOnce(jsonResponse({ ...project, access }, 201, projectId));
      await expect(api.createProject({ name: project.name, repoUrl: project.repoUrl, expectedUserId: projectId, teamId })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    }
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
    await expect(api.getTaskGraph(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
  });

  it.each(["1.0", "1e3", "9223372036854775808"])("rejects non-int64 settings version lexeme %s before rounding can be accepted", async (version) => {
    const wire = stringifyApiJson(project).replace('"version":1', `"version":${version}`);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(wire, { headers: { "Content-Type": "application/json" } }));
    await expect(client(fetch).getProject(projectId)).rejects.toMatchObject({ phase: "protocol" });
  });

  it.each([
    { startedAt: null, completedAt: null, cancelledAt: null },
    { startedAt: time, completedAt: null, cancelledAt: null },
    { startedAt: null, completedAt: time, cancelledAt: null },
    { startedAt: "2026-10-20T00:00:00Z", completedAt: time, cancelledAt: null },
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
    await expect(api.getTaskGraph(projectId, taskId)).resolves.toEqual(graphValue);
  });

  it.each(["startedAt", "completedAt", "cancelledAt"] as const)("requires an explicit null or valid UTC timestamp for %s", async (field) => {
    for (const invalid of [undefined, 0, false, "", "invalid", "2026-02-30T00:00:00Z", "2026-10-20T00:00:00+00:00"]) {
      const taskValue = { ...task, [field]: invalid };
      const taskGraph = graph();
      const graphValue = { ...taskGraph, tasks: [{ ...taskGraph.tasks[0]!, [field]: invalid }, taskGraph.tasks[1]!] };
      const fetch = vi.fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(jsonResponse(taskValue))
        .mockResolvedValueOnce(jsonResponse(graphValue));
      const api = client(fetch);
      await expect(api.getTask(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
      await expect(api.getTaskGraph(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    }
  });

  it.each([undefined, null, 0, "invalid", "2026-02-30T00:00:00Z", "2026-10-20T00:00:00+00:00"])("requires the database clock timestamp without a client fallback: %j", async (observedAt) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...graph(), observedAt })))
      .getTaskGraph(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
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

  it("reads a cancelled task with unmet prerequisites while retaining prior execution and materials", async () => {
    const value = { ...task, status: "cancelled", ready: false, startedAt: time, completedAt: time, cancelledAt: "2026-10-21T00:00:00.123456789Z", dependsOn: [otherId], blockedBy: [otherId], properties: { pullRequests: [{ url: "opaque", title: "Existing result" }] } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(jsonResponse(value)).mockResolvedValueOnce(jsonResponse({ items: [value], nextCursor: null }));
    const api = client(fetch);
    await expect(api.getTask(projectId, taskId)).resolves.toEqual(value);
    await expect(api.listTasks(projectId, { status: "cancelled" })).resolves.toEqual([value]);
  });

  it.each([
    { status: "cancelled", ready: false, cancelledAt: null },
    { status: "cancelled", ready: false, cancelledAt: undefined },
    { status: "cancelled", ready: false, cancelledAt: "2026-02-30T00:00:00Z" },
    { status: "todo", ready: true, cancelledAt: time },
    { status: "in_progress", ready: false, cancelledAt: time },
    { status: "done", ready: false, cancelledAt: time },
  ])("rejects a status/cancellation-time contradiction %#", async (changes) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...task, ...changes }));
    await expect(client(fetch).getTask(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
  });

  it("counts cancelled nodes separately and satisfies their consumers without requiring their own prerequisites", async () => {
    const value = statusGraph();
    const blocked = value.tasks[1]!;
    const cancelled = { ...value.tasks[0]!, id: "99999999-9999-4999-8999-999999999999", status: "cancelled" as const, ready: false, cancelledAt: time, dependsOn: [blocked.id], blockedBy: [blocked.id] };
    const tasks = value.tasks.map((item, index) => index === 2 ? { ...item, dependsOn: [cancelled.id], blockedBy: [] } : item);
    const graphValue = { ...value, summary: { ...value.summary, total: 5, cancelled: 1 }, tasks: [...tasks, cancelled] };
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(graphValue))).getTaskGraph(projectId, taskId)).resolves.toEqual(graphValue);
    for (const changes of [{ cancelled: undefined }, { cancelled: null }, { cancelled: -1 }, { cancelled: 0 }, { done: 2 }]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...graphValue, summary: { ...graphValue.summary, ...changes } }));
      await expect(client(fetch).getTaskGraph(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
    }
  });

  it("projects all three graph states and counts only blocked todo tasks as blocked", async () => {
    const value = statusGraph();
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(value))).getTaskGraph(projectId, taskId)).resolves.toEqual(value);
    const empty = { observedAt: time, project, summary: { total: 0, proposed: 0, todo: 0, inProgress: 0, done: 0, cancelled: 0, ready: 0, blocked: 0 }, tasks: [] };
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(empty))).getTaskGraph(projectId, taskId)).rejects.toMatchObject({ phase: "protocol" });
  });

  it("counts proposed separately and accepts a proposed prerequisite as unfinished", async () => {
    const value = statusGraph();
    const tasks = value.tasks.map((item, index) => index === 0 ? { ...item, status: "proposed", ready: false } : item);
    const expected = { ...value, tasks, summary: { ...value.summary, proposed: 1, todo: 1, ready: 0 } };
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(expected))).getTaskGraph(projectId, taskId)).resolves.toEqual(expected);
  });

  it.each([
    { proposed: undefined }, { proposed: -1 }, { proposed: 1 }, { todo: undefined }, { todo: null }, { todo: "2" }, { todo: -1 }, { todo: 1.5 },
    { total: 5 }, { todo: 5 }, { inProgress: 2 }, { done: 2 }, { ready: 2 }, { blocked: 2 },
  ])("rejects missing, malformed or inconsistent Task graph counters %#", async (changes) => {
    const value = statusGraph();
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...value, summary: { ...value.summary, ...changes } }))).getTaskGraph(projectId, taskId)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
  });

  it.each(["todo-ready", "todo-blockers", "in-progress-blocked", "done-blocked", "unknown"])("rejects invalid Task graph dependency data: %s", async (failure) => {
    const value = statusGraph();
    const tasks = value.tasks.map((item) => ({ ...item }));
    if (failure === "todo-ready") tasks[1] = { ...tasks[1]!, ready: true };
    if (failure === "todo-blockers") tasks[1] = { ...tasks[1]!, blockedBy: [] };
    if (failure === "unknown") tasks[0] = { ...tasks[0]!, status: "unknown" as never };
    if (failure === "in-progress-blocked" || failure === "done-blocked") {
      const index = failure === "in-progress-blocked" ? 2 : 3;
      tasks[index] = { ...tasks[index]!, dependsOn: [tasks[0]!.id], blockedBy: [tasks[0]!.id] };
    }
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...value, tasks }))).getTaskGraph(projectId, taskId)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
  });

  it("preserves every property key and raw nested JSON value", async () => {
    const properties = {
      pullRequests: [{ url: "", title: "\0\n\u0085\u001b[2J", metadata: { version: 1.5 } }],
      future: { version: 7, enabled: true, nested: [null, "value"] },
    };
    const expected = { ...task, properties };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(expected));
    expect(await client(fetch).getTask(projectId, taskId)).toEqual(expected);
  });

  it("retains an empty property object without injecting defaults", async () => {
    const expected = { ...task, properties: {} };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(expected));
    expect(await client(fetch).getTask(projectId, taskId)).toEqual(expected);
  });

  it.each([undefined, null, [], false, "properties"])("rejects a missing or non-object property envelope %#", async (properties) => {
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...task, properties }))).getTask(projectId, taskId)).rejects.toMatchObject({ phase: "protocol", cause: expect.any(Error) });
  });

  it("applies response byte budgets to PR content without truncating resources", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...task, properties: { pullRequests: [{ url: "T".repeat(2048), title: "Title" }] } }));
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
  it("returns a complete deep graph and ignores future additional fields", async () => {
    const original = graph();
    const ids = Array.from({ length: 10001 }, (_, index) => index === 0 ? taskId : `50000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
    const tasks = ids.map((id, index) => ({ ...original.tasks[1]!, id, dependsOn: index + 1 < ids.length ? [ids[index + 1]!] : [] }));
    const value = { ...original, tasks, summary: { ...original.summary, total: tasks.length, proposed: 0, todo: 0, done: tasks.length, ready: 0 } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...value, futureField: 42 }));
    expect(await client(fetch).getTaskGraph(projectId, taskId)).toEqual(value);
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
  it.each(["summary", "dangling", "blocked", "preview", "duplicate"])("rejects inconsistent graph %s", async (failure) => {
    const value = graph();
    const tasks = value.tasks.map((item) => ({ ...item }));
    let summary = value.summary;
    if (failure === "summary") summary = { ...summary, total: 3 };
    if (failure === "dangling") tasks[0] = { ...tasks[0]!, dependsOn: [projectId] };
    if (failure === "blocked") tasks[0] = { ...tasks[0]!, blockedBy: [otherId], ready: false };
    if (failure === "preview") tasks[0] = { ...tasks[0]!, titleTruncated: true };
    if (failure === "duplicate") tasks[1] = { ...tasks[1]!, id: taskId };
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...value, tasks, summary }))).getTaskGraph(projectId, taskId)).rejects.toBeInstanceOf(ApiError);
  });
  it("accepts a whitespace preview cut from a nonempty long title", async () => {
    const value = graph();
    const tasks = [{ ...value.tasks[0]!, titlePreview: " ".repeat(160), titleTruncated: true }, value.tasks[1]!];
    await expect(client(vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ ...value, tasks }))).getTaskGraph(projectId, taskId)).resolves.toMatchObject({ tasks });
  });
});
