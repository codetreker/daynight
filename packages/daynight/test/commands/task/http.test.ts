import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import type { Task, TaskGraph, WorkerClaim } from "../../../src/api/index.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";

const projectId = "abcdefab-1111-4222-8333-123456789abc";
const taskId = "abcdefab-2222-4222-8333-123456789abc";
const otherId = "abcdefab-3333-4222-8333-123456789abc";
const claimId = "abcdefab-4444-4222-8333-123456789abc";
const time = "2026-10-20T00:00:00.123456789Z";
const project = { id: projectId, name: "Project", repoUrl: "git@git.example:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const task: Task = { id: taskId, projectId, title: "Task title", description: "Description", properties: { worker: null, pullRequests: [] }, status: "todo", allowAgents: false, requiredPlatform: null, version: 9_007_199_254_740_993n, ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, createdAt: time, updatedAt: time };
const worker: WorkerClaim = { claimId, state: "active", userId: projectId, workerId: otherId, machine: { id: otherId, name: "Build machine" }, platform: "linux", agent: "codex", agentControlMode: "herdr", worktreeId: otherId, phase: "executing", herdr: { session: "w", workspaceId: "task-workspace", paneId: "task-pane" }, nativeSessionId: "original-native-session", signaling: "", claimedAt: time };
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
  await writeFile(path.join(home, ".daynight/config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
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
  it("round-trips an opaque future properties resource and reads only version metadata for updates", async () => {
    const source = '{ "version":"9223372036854775807", "properties":{"worker":{"future":900719925474099312345,"version":1e999},"other":[null,true]} }\n';
    const f = await fixture((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(source); });
    await f.run(["get-properties", taskId]);
    expect(f.context.stdout).toHaveBeenLastCalledWith(source);
    await f.run(["set-property", taskId, "future /?#%字段", "  {invalid JSON  "]);
    expect(f.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET /api/v1/projects/${projectId}`, `GET /api/v1/projects/${projectId}/tasks/${taskId}/properties`,
      `GET /api/v1/projects/${projectId}`, `GET /api/v1/projects/${projectId}/tasks/${taskId}/properties`,
      `PUT /api/v1/projects/${projectId}/tasks/${taskId}/properties`,
    ]);
    expect(f.requests.at(-1)!.body).toBe('{"version":9223372036854775807,"property":"future /?#%字段","value":"  {invalid JSON  "}');
    expect(f.context.stdout).toHaveBeenLastCalledWith(source);
  });

  it.each([400, 409])("lets the service reject invalid property values with HTTP %s", async (status) => {
    const f = await fixture((_request, response) => respond(response, { error: { code: status === 400 ? "invalid_input" : "version_conflict", message: "Property was refused.", requestId: "property-refusal" } }, status));
    await expect(f.run(["set-property", taskId, "", "", "--if-version", "9223372036854775807"])).rejects.toMatchObject({ status, confirmedRefusal: true });
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "PUT"]);
    expect(f.requests.at(-1)!.body).toBe('{"version":9223372036854775807,"property":"","value":""}');
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("does not retry or report success after an unconfirmed property mutation", async () => {
    const f = await fixture((_request, _response, raw) => { raw.socket.destroy(); });
    await expect(f.run(["set-property", taskId, "future", "value", "--if-version", "1"])).rejects.toMatchObject({ operation: "task.set-property", outcomeUnconfirmed: true });
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "PUT"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each([undefined, "9223372036854775807"])("removes a property over HTTP with version %s and prints the opaque result", async (version) => {
    const source = '{"version":"9223372036854775807","properties":{"future":900719925474099312345}}';
    const f = await fixture((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(source); });
    await f.run(["remove-property", taskId, "unknown /?#%字段", ...(version === undefined ? [] : ["--if-version", version])]);
    expect(f.requests.map(({ method }) => method)).toEqual(version === undefined ? ["GET", "GET", "DELETE"] : ["GET", "DELETE"]);
    expect(f.requests.at(-1)!.body).toBe('{"version":9223372036854775807,"property":"unknown /?#%字段"}');
    expect(f.requests.at(-1)!.path).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}/properties`);
    expect(f.context.stdout).toHaveBeenCalledExactlyOnceWith(source);
  });
  it.each([false, true].flatMap((removeDepends) => [undefined, "9223372036854775807"].map((version) => ({ removeDepends, version }))))("deletes once with exact version $version and removal consent $removeDepends", async ({ version, removeDepends }) => {
    const f = await fixture((request, response) => {
      if (request.method === "DELETE") { response.writeHead(204); response.end(); }
      else respond(response, task);
    });
    await f.run(["delete", taskId.toUpperCase(), ...(removeDepends ? ["--remove-depends"] : []), ...(version === undefined ? [] : ["--if-version", version])]);
    expect(f.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET /api/v1/projects/${projectId}`,
      ...(version === undefined ? [`GET /api/v1/projects/${projectId}/tasks/${taskId}`] : []),
      `DELETE /api/v1/projects/${projectId}/tasks/${taskId}`,
    ]);
    expect(f.requests.at(-1)!.body).toBe(`{"version":${version === undefined ? task.version : version}${removeDepends ? ",\"removeDepends\":true" : ""}}`);
    expect(f.context.stdout).toHaveBeenCalledExactlyOnceWith(`Task deleted. Stored data and attachments are retained.\nID: ${taskId}\nProject: ${projectId}\n`);
  });

  it("leaves dependency refusal authoritative to the server until removal is explicitly authorized", async () => {
    const f = await fixture((request, response) => {
      const body = parseApiJson(request.body) as { version: bigint; removeDepends?: boolean };
      if (body.removeDepends === true) { response.writeHead(204); response.end(); }
      else respond(response, { error: { code: "dependency_unsatisfied", message: "Other tasks depend on this task.", requestId: "incoming-dependencies", details: { taskIds: [otherId] } } }, 409);
    });
    await expect(f.run(["delete", taskId, "--if-version", "9007199254740993"])).rejects.toMatchObject({ code: "dependency_unsatisfied", details: { taskIds: [otherId] }, confirmedRefusal: true });
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "DELETE"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
    await f.run(["delete", taskId, "--remove-depends", "--if-version", "9007199254740993"]);
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "DELETE", "GET", "DELETE"]);
    expect(f.requests.at(-1)!.body).toBe('{"version":9007199254740993,"removeDepends":true}');
    expect(f.context.stdout).toHaveBeenCalledOnce();
  });

  it.each([
    { code: "version_conflict", status: 409 },
    { code: "dependency_unsatisfied", status: 409 },
    { code: "invalid_transition", status: 409 },
    { code: "task_deleted", status: 410 },
  ])("preserves deletion refusal $code without replay", async ({ code, status }) => {
    const f = await fixture((_request, response) => respond(response, { error: { code, message: "Deletion refused", requestId: "delete-refused", details: { taskIds: [otherId] } } }, status));
    await expect(f.run(["delete", taskId, "--if-version", "1"])).rejects.toMatchObject({ operation: "task.delete", projectId, taskId, code, status, requestId: "delete-refused", details: { taskIds: [otherId] }, confirmedRefusal: true });
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "DELETE"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports a lost deletion response with consent %s as unconfirmed without resubmitting", async (removeDepends) => {
    const f = await fixture((_request, _response, raw) => { raw.socket.destroy(); });
    await expect(f.run(["delete", taskId, ...(removeDepends ? ["--remove-depends"] : []), "--if-version", "9007199254740993"])).rejects.toMatchObject({ operation: "task.delete", projectId, taskId, outcomeUnconfirmed: true });
    expect(parseApiJson(f.requests.at(-1)!.body)).toEqual({ version: task.version, ...(removeDepends ? { removeDepends: true } : {}) });
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "DELETE"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("does not submit deletion when its version read fails", async () => {
    const f = await fixture((_request, response) => respond(response, { error: { code: "task_deleted", message: "Task was deleted.", requestId: "already-deleted" } }, 410));
    await expect(f.run(["delete", taskId])).rejects.toMatchObject({ operation: "task.show", code: "task_deleted" });
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

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

  it.each([undefined, "9223372036854775807"])("completes an explicit claim once with version %s and retained execution history", async (versionArgument) => {
    const active = { ...task, status: "in_progress", ready: false, startedAt: time, properties: { worker, pullRequests: [{ url: "opaque\0url", title: "Delivery" }] } } as const;
    const f = await fixture((request, response) => {
      if (request.method === "GET") { respond(response, active); return; }
      const input = parseApiJson(request.body) as { version: bigint; status: string; claimId: string };
      const version = versionArgument === undefined ? input.version + 1n : input.version;
      respond(response, { ...active, version, status: "done", completedAt: time, properties: { ...active.properties, worker: { ...worker, state: "completed" } } });
    });

    await f.run(["set-status", taskId.toUpperCase(), "done", `--claim-id=${claimId.toUpperCase()}`, ...(versionArgument === undefined ? [] : ["--if-version", versionArgument])]);

    expect(f.requests.map(({ method }) => method)).toEqual(["GET", ...(versionArgument === undefined ? ["GET"] : []), "PUT"]);
    expect(f.requests.at(-1)!.path).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}/status`);
    expect(parseApiJson(f.requests.at(-1)!.body)).toEqual({ version: versionArgument === undefined ? task.version : 9_223_372_036_854_775_807n, status: "done", claimId });
    expect(f.context.stdout).toHaveBeenCalledOnce();
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Status: done");
    expect(f.context.stdout.mock.calls[0]![0]).toContain("opaque\\u0000url");
  });

  it.each([
    { code: "claim_conflict", status: 409 },
    { code: "version_conflict", status: 409 },
    { code: "forbidden", status: 403 },
    { code: "dependency_unsatisfied", status: 409 },
  ])("preserves worker completion refusal $code without fallback or replay", async ({ code, status }) => {
    const f = await fixture((_request, response) => respond(response, { error: { code, message: "Completion refused.", requestId: "claim-completion-refused" } }, status));

    await expect(f.run(["set-status", taskId, "done", "--claim-id", claimId, "--if-version", "9007199254740993"])).rejects.toMatchObject({ operation: "worker.complete", projectId, taskId, status, code, confirmedRefusal: true, outcomeUnconfirmed: false });

    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "PUT"]);
    expect(parseApiJson(f.requests.at(-1)!.body)).toEqual({ version: task.version, status: "done", claimId });
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "server failure"])("keeps worker completion %s unconfirmed without a retry", async (failure) => {
    const f = await fixture((_request, response, raw) => {
      if (failure === "disconnect") raw.socket.destroy();
      else respond(response, { error: { code: "internal_error", message: "Completion outcome unavailable.", requestId: "claim-completion-unknown" } }, 500);
    });

    await expect(f.run(["set-status", taskId, "done", "--claim-id", claimId, "--if-version", "1"])).rejects.toMatchObject({ operation: "worker.complete", projectId, taskId, outcomeUnconfirmed: true });

    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "PUT"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("rejects a completion response for a different claim as an unknown outcome", async () => {
    const f = await fixture((_request, response) => respond(response, { ...task, version: 2n, status: "done", ready: false, completedAt: time, properties: { worker: { ...worker, claimId: otherId, state: "completed" }, pullRequests: [] } }));

    await expect(f.run(["set-status", taskId, "done", "--claim-id", claimId, "--if-version", "1"])).rejects.toMatchObject({ operation: "worker.complete", phase: "protocol", outcomeUnconfirmed: true });

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
      { id: taskId, titlePreview: "T".repeat(160), workerNeedsAttention: false, titleTruncated: true, allowAgents: false, requiredPlatform: null, status: "todo", ready: false, dependsOn: [otherId], externalDependsOn: [], blockedBy: [otherId], startedAt: null, completedAt: null, createdAt: time, updatedAt: time },
      { id: otherId, titlePreview: "Dependency", workerNeedsAttention: false, titleTruncated: false, allowAgents: false, requiredPlatform: null, status: "todo", ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, createdAt: time, updatedAt: time },
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
