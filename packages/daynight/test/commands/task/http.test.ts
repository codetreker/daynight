import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import type { Task, TaskGraph } from "../../../src/api/index.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";

const projectId = "abcdefab-1111-4222-8333-123456789abc";
const taskId = "abcdefab-2222-4222-8333-123456789abc";
const otherId = "abcdefab-3333-4222-8333-123456789abc";
const time = "2026-10-20T00:00:00.123456789Z";
const project = { id: projectId, name: "Project", repoUrl: "git@git.example:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const task: Task = { id: taskId, projectId, title: "Task title", description: "Description", properties: { worker: null, pullRequests: [] }, status: "todo", allowAgents: false, requiredPlatform: null, version: 9_007_199_254_740_993n, ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, createdAt: time, updatedAt: time };
type Request = { readonly method: string; readonly path: string; readonly query: URLSearchParams; readonly body: string };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const respond = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(stringifyApiJson(value)); };
const fixture = async (handler: (request: Request, response: ServerResponse, raw: IncomingMessage) => void) => {
  const requests: Request[] = [];
  const server = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8");
    request.on("data", (value: string) => { body += value; });
    request.on("end", () => {
      const url = new URL(request.url!, "http://localhost");
      const current = { method: request.method!, path: url.pathname, query: url.searchParams, body };
      requests.push(current);
      if (current.path === `/api/v1/projects/${projectId}`) respond(response, project);
      else handler(current, response, request);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); }));
  const address = server.address(); if (typeof address !== "object" || address === null) throw new Error("Missing HTTP listener");
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/task-command-tests");
  await mkdir(temporary, { recursive: true });
  const home = await mkdtemp(path.join(temporary, "home 用户 ")); cleanups.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".daynight"));
  await writeFile(path.join(home, ".daynight/config.yml"), `serverUrl: http://127.0.0.1:${address.port}\n`);
  const signals = new EventEmitter();
  const context = { version: "0.0.0", packageDirectory: "unused", homeDirectory: () => home,
    workingDirectory: vi.fn<() => string>(() => { throw new Error("Explicit project must not query cwd"); }), stdout: vi.fn<(value: string) => void>(), stdoutBytes: vi.fn(async () => {}), stderr: vi.fn<(value: string) => void>() };
  const dependencies = {
    runServerCommand: (current: Parameters<typeof runServerCommand>[0], command: Parameters<typeof runServerCommand>[1]) => runServerCommand(current, command, { signalEmitter: signals }),
    resolveProject: vi.fn(async (): Promise<never> => { throw new Error("Explicit project must not resolve repository"); }),
  };
  const run = (args: readonly string[]) => runTaskCommand([...args, "--project", projectId], context, dependencies);
  return { requests, context, dependencies, signals, run };
};

describe("task commands over HTTP", () => {
  it.each(["todo", "in_progress", "done"] as const)("sends one %s status PUT after reading or with an exact supplied version", async (status) => {
    const f = await fixture((request, response) => {
      const version = request.method === "GET" ? task.version : (parseApiJson(request.body) as { version: bigint }).version;
      respond(response, request.method === "GET" ? task : { ...task, version, status, ready: status === "todo" });
    });
    await f.run(["set-status", taskId.toUpperCase(), status]);
    expect(f.requests.map(({ method, path: pathname }) => `${method} ${pathname}`)).toEqual([`GET /api/v1/projects/${projectId}`, `GET /api/v1/projects/${projectId}/tasks/${taskId}`, `PUT /api/v1/projects/${projectId}/tasks/${taskId}/status`]);
    expect(f.requests.at(-1)!.body).toBe(`{"version":9007199254740993,"status":"${status}"}`);
    f.requests.length = 0;
    await f.run(["set-status", taskId, status, "--if-version", "9223372036854775807"]);
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "PUT"]);
    expect(f.requests.at(-1)!.body).toBe(`{"version":9223372036854775807,"status":"${status}"}`);
  });

  it("reports an unconfirmed status write after dispatch without retrying", async () => {
    const f = await fixture((_request, _response, raw) => { raw.socket.destroy(); });
    await expect(f.run(["set-status", taskId, "done", "--if-version", "1"])).rejects.toMatchObject({ operation: "task.set-status", projectId, taskId, outcomeUnconfirmed: true });
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "PUT"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("submits optional create fields exactly once and prints the confirmed result", async () => {
    const title = "-Original=title\n\u001b[2J";
    const f = await fixture((request, response) => {
      const body = parseApiJson(request.body) as { title: string; description: string; dependsOn: string[] };
      respond(response, { ...task, ...body, blockedBy: body.dependsOn, ready: false }, 201);
    });
    await f.run(["create", `--title=${title}`, "--description=", "--depends-on", otherId]);
    const writes = f.requests.filter(({ method }) => method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe(`/api/v1/projects/${projectId}/tasks`);
    expect(parseApiJson(writes[0]!.body)).toEqual({ title, description: "", dependsOn: [otherId], externalDependsOn: [] });
    expect(f.context.stdout).toHaveBeenCalledOnce();
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Task created.");
    expect(f.context.stdout.mock.calls[0]![0]).toContain("-Original=title\\n\\u001b[2J");
    expect(f.context.workingDirectory).not.toHaveBeenCalled(); expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
  });

  it("reads the exact current int64 version then sends one PATCH with an empty description", async () => {
    const f = await fixture((request, response) => respond(response, request.method === "GET" ? task : { ...task, description: "", version: task.version + 1n }));
    await f.run(["update", taskId.toUpperCase(), "--description", ""]);
    expect(f.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([`GET /api/v1/projects/${projectId}`, `GET /api/v1/projects/${projectId}/tasks/${taskId}`, `PATCH /api/v1/projects/${projectId}/tasks/${taskId}`]);
    const patch = f.requests.at(-1)!;
    expect(patch.body).toBe('{"version":9007199254740993,"description":""}');
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Version: 9007199254740994");
  });

  it("uses an explicit maximum int64 version without issuing a task GET", async () => {
    const f = await fixture((_request, response) => respond(response, task));
    await f.run(["update", taskId, "--clear-dependencies", "--if-version", "9223372036854775807"]);
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "PATCH"]);
    expect(f.requests.at(-1)!.body).toBe('{"version":9223372036854775807,"dependsOn":[],"externalDependsOn":[]}');
  });

  it("keeps filters and cursor across all pages and publishes one complete JSON array", async () => {
    const next = { ...task, id: otherId };
    const f = await fixture((request, response) => respond(response, request.query.has("cursor") ? { items: [next], nextCursor: null } : { items: [task], nextCursor: "next page+/=?" }));
    await f.run(["list", "--status", "todo", "--ready", "--json"]);
    expect(f.context.stdout).toHaveBeenCalledOnce();
    const parsed = parseApiJson(f.context.stdout.mock.calls[0]![0]);
    expect(parsed).toEqual([task, next].map(({ description: _description, ...item }) => item));
    for (const index of [0, 1]) expect(parsed).not.toHaveProperty(`${index}.description`);
    expect(f.context.stdout.mock.calls[0]![0]).toMatch(/\n$/);
    const pages = f.requests.filter(({ path }) => path.endsWith("/tasks"));
    expect(pages.map(({ query }) => Object.fromEntries(query))).toEqual([{ status: "todo", ready: "true", limit: "100" }, { status: "todo", ready: "true", limit: "100", cursor: "next page+/=?" }]);
  });

  it("does not publish a partial list when a later page fails", async () => {
    const f = await fixture((request, response) => {
      if (request.query.has("cursor")) respond(response, { error: { code: "internal_error", message: "Page unavailable", requestId: "task-page-failure" } }, 500);
      else respond(response, { items: [task], nextCursor: "next" });
    });
    await expect(f.run(["list", "--json"])).rejects.toMatchObject({ operation: "task.list", projectId, code: "internal_error", requestId: "task-page-failure" });
    expect(f.context.stdout).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(3);
  });

  it("publishes only the first ready page even when a later page would fail", async () => {
    const f = await fixture((request, response) => {
      if (request.query.has("cursor")) respond(response, { error: { code: "internal_error", message: "Not a bounded request", requestId: "unexpected-later-page" } }, 500);
      else respond(response, { items: [task], nextCursor: "next" });
    });
    await f.run(["ready", "--limit", "1", "--json"]);
    expect(f.context.stdout).toHaveBeenCalledOnce();
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual([task]);
    expect(f.requests).toHaveLength(2);
    expect(Object.fromEntries(f.requests[1]!.query)).toEqual({ ready: "true", limit: "1" });
  });

  it.each([
    { items: [task, { ...task, id: otherId }], nextCursor: null },
    { items: [{ ...task, status: "in_progress", ready: false }], nextCursor: null },
  ])("keeps an invalid ready page out of stdout %#", async (page) => {
    const f = await fixture((_request, response) => respond(response, page));
    await expect(f.run(["ready", "--limit", "1", "--json"])).rejects.toMatchObject({ operation: "task.ready", projectId, phase: "protocol" });
    expect(f.context.stdout).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(2);
  });

  it("preserves version conflicts and related task IDs without rereading or retrying", async () => {
    const f = await fixture((request, response) => {
      if (request.method === "GET") respond(response, task);
      else respond(response, { error: { code: "version_conflict", message: "Concurrent update", requestId: "task-conflict", details: { taskIds: [taskId] } } }, 409);
    });
    await expect(f.run(["set-status", taskId, "done"])).rejects.toMatchObject({ operation: "task.set-status", taskId, code: "version_conflict", requestId: "task-conflict", details: { taskIds: [taskId] }, confirmedRefusal: true });
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET", "PUT"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("renders complete graph data and exposes graph limit refusal details", async () => {
    let limit = false;
    const graph: TaskGraph = { observedAt: time, project, summary: { total: 2, todo: 2, inProgress: 0, done: 0, ready: 1, blocked: 1 }, tasks: [
      { id: taskId, titlePreview: "T".repeat(160), titleTruncated: true, allowAgents: false, requiredPlatform: null, status: "todo", ready: false, dependsOn: [otherId], externalDependsOn: [], blockedBy: [otherId], startedAt: null, completedAt: null, createdAt: time, updatedAt: time },
      { id: otherId, titlePreview: "Dependency", titleTruncated: false, allowAgents: false, requiredPlatform: null, status: "todo", ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, createdAt: time, updatedAt: time },
    ] };
    const f = await fixture((_request, response) => {
      if (limit) respond(response, { error: { code: "graph_limit_exceeded", message: "Graph is too large", requestId: "graph-limit", details: { nodeCount: 1001, edgeCount: 1, maxNodes: 1000, maxEdges: 5000 } } }, 422);
      else respond(response, graph);
    });
    await f.run(["graph", "--json"]);
    expect(f.context.stdout).toHaveBeenCalledOnce();
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(graph);
    f.context.stdout.mockClear(); limit = true;
    await expect(f.run(["graph"])).rejects.toMatchObject({ code: "graph_limit_exceeded", requestId: "graph-limit", details: { nodeCount: 1001, edgeCount: 1, maxNodes: 1000, maxEdges: 5000 } });
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed mutation after the connection is lost without resubmitting", async () => {
    const f = await fixture((_request, _response, raw) => { raw.socket.destroy(); });
    await expect(f.run(["create", "--title", "Title"])).rejects.toMatchObject({ operation: "task.create", projectId, outcomeUnconfirmed: true });
    expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(1);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("cancels during the version response and never submits the action", async () => {
    let entered: () => void = () => {};
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const f = await fixture((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.write("{"); entered(); });
    const pending = f.run(["set-status", taskId, "done"]);
    await ready; f.signals.emit("SIGINT");
    await expect(pending).rejects.toMatchObject({ operation: "task.show", projectId, taskId, cause: { kind: "cancelled" } });
    expect(f.requests.some(({ method }) => method === "POST")).toBe(false);
    expect(f.context.stdout).not.toHaveBeenCalled();
    expect(f.signals.listenerCount("SIGINT")).toBe(0);
  });
});
