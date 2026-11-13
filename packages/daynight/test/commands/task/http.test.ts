import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import type { Task, TaskGraph, WorkerClaim } from "../../../src/api/index.js";
import { runCli } from "../../../src/cli/application.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";
import { observedFixtureResponse, withTaskObservation, withGraphObservations } from "../../fixtures/task-observation.js";

const projectId = "abcdefab-1111-4222-8333-123456789abc";
const taskId = "abcdefab-2222-4222-8333-123456789abc";
const otherId = "abcdefab-3333-4222-8333-123456789abc";
const claimId = "abcdefab-4444-4222-8333-123456789abc";
const accountId = "abcdefab-5555-4222-8333-123456789abc";
const time = "2026-10-20T00:00:00.123456789Z";
const project = { id: projectId, name: "Project", repoUrl: "git@git.example:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: time, updatedAt: time };
const task: Task = { type: "task", parentId: null, id: taskId, projectId, title: "Task title", description: "Description", tags: [], properties: { pullRequests: [] }, status: "todo", allowAgents: false, assignedTo: null, requiredPlatform: null, version: 9_007_199_254_740_993n, ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time };
const worker: WorkerClaim = { claimId, state: "active", userId: projectId, workerId: otherId, machine: { id: otherId, name: "Build machine" }, platform: "linux", agent: "codex", agentControlMode: "herdr", worktreeId: otherId, phase: "executing", herdr: { session: "w", workspaceId: "task-workspace", paneId: "task-pane" }, nativeSessionId: "original-native-session", claimedAt: time };
type Request = { readonly method: string; readonly path: string; readonly query: URLSearchParams; readonly body: string };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const respond = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(stringifyApiJson(status === 200 ? observedFixtureResponse(value, response.req.url!) : value)); };
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
      else if (current.path === "/api/v1/me") respond(response, { id: accountId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "personal" as const, name: null } });
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
  it.each([
    { args: ["--type", "goal"], input: { type: "goal" }, parentId: null, assignedTo: accountId, type: "goal" },
    { args: ["--type", "goal", "--parent", "none", "--clear-assigned-to"], input: { type: "goal", parentId: null, assignedTo: null }, parentId: null, assignedTo: null, type: "goal" },
    { args: ["--type", "goal", "--assigned-to", otherId.toUpperCase(), "--status", "in_progress"], input: { type: "goal", assignedTo: otherId, status: "in_progress" }, parentId: null, assignedTo: otherId, type: "goal" },
    { args: ["--parent", otherId.toUpperCase()], input: { parentId: otherId, assignedTo: accountId }, parentId: otherId, assignedTo: accountId, type: "task" },
    { args: ["--parent", "none"], input: { parentId: null, assignedTo: accountId }, parentId: null, assignedTo: accountId, type: "task" },
  ])("sends create presence fields and renders the returned $type", async ({ args, input, parentId, assignedTo, type }) => {
    const goal = type === "goal";
    const status = input.status ?? (goal ? "todo" : "proposed");
    const created = { ...task, type, parentId, assignedTo, status, ready: false,
      startedAt: status === "in_progress" ? time : null,
      ...(goal ? { progress: { total: 0, done: 0, cancelled: 0, unfinished: 0 } } : {}) };
    const f = await fixture((_request, response) => { response.setHeader("Daynight-User-ID", accountId); respond(response, created, 201); });
    await f.run(["create", "--title", "Title", ...args]);
    const writes = f.requests.filter(({ method }) => method === "POST");
    expect(writes).toHaveLength(1);
    expect(parseApiJson(writes[0]!.body)).toEqual({ title: "Title", ...input });
    expect(f.requests.some(({ path }) => path === "/api/v1/me")).toBe(!goal);
    expect(f.context.stdout.mock.calls[0]![0]).toContain(`Type: ${type}`);
  });

  it.each([
    ["--type", "goal", "--parent", otherId],
    ["--type", "goal", "--status", "proposed"],
    ["--status", "done"],
    ["--parent", "invalid"],
    ["--assigned-to", otherId, "--clear-assigned-to"],
  ])("rejects invalid create options before sending a request: %s", async (...args) => {
    const f = await fixture(() => { throw new Error("Unexpected request"); });
    await expect(f.run(["create", "--title", "Title", ...args])).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });

  it.each([
    { args: ["--parent", otherId.toUpperCase()], parent: otherId },
    { args: ["--parent", "none"], parent: null },
  ])("sends parent-only update with the caller's exact version: $parent", async ({ args, parent }) => {
    const f = await fixture((_request, response) => respond(response, { ...task, parentId: parent }));
    await f.run(["update", taskId, ...args, "--if-version", "9223372036854775807"]);
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "PATCH"]);
    expect(parseApiJson(f.requests[1]!.body)).toEqual({ version: 9_223_372_036_854_775_807n, parentId: parent });
  });

  it("preserves parent and dependency classifications when parent is omitted from an update", async () => {
    const current = { ...task, parentId: otherId, dependsOn: [claimId], externalDependsOn: [claimId], ready: false, blockedBy: [claimId] };
    const f = await fixture((request, response) => respond(response, request.method === "GET" ? current : { ...current, title: "Changed" }));
    await f.run(["update", taskId, "--title", "Changed"]);
    expect(parseApiJson(f.requests.at(-1)!.body)).toEqual({ version: task.version, title: "Changed" });
  });

  it.each(["none", otherId.toUpperCase()])("carries type and parent %s across list pages and the ready request", async parent => {
    const cursor = "next page+/=?";
    const parentId = parent === "none" ? null : otherId;
    const f = await fixture((request, response) => respond(response, request.query.has("ready") ? { items: [], nextCursor: null } : request.query.has("cursor") ? { items: [{ ...task, id: claimId, parentId }], nextCursor: null } : { items: [{ ...task, parentId }], nextCursor: cursor }));
    await f.run(["list", "--type", "task", "--parent", parent, "--json"]);
    const selection = parent === "none" ? "none" : otherId;
    expect(f.requests.slice(1).map(({ query }) => Object.fromEntries(query))).toEqual([
      { type: "task", parentId: selection, limit: "100", include: "session" },
      { type: "task", parentId: selection, limit: "100", include: "session", cursor },
    ]);
    f.requests.length = 0;
    await f.run(["ready", "--parent", parent, "--allow-agents", "true", "--limit", "1", "--json"]);
    expect(Object.fromEntries(f.requests[1]!.query)).toEqual({ parentId: selection, ready: "true", allowAgents: "true", limit: "1" });
  });

  it("sends an explicit Goal list filter", async () => {
    const f = await fixture((_request, response) => respond(response, { items: [], nextCursor: null }));
    await f.run(["list", "--type", "goal", "--json"]);
    expect(Object.fromEntries(f.requests[1]!.query)).toEqual({ type: "goal", limit: "100", include: "session" });
  });

  it("keeps assigned responsibility and complete active worker ownership through a same-assignee update", async () => {
    const active = { ...task, status: "in_progress", ready: false, startedAt: time, allowAgents: true, assignedTo: accountId, properties: { worker: { ...worker, userId: accountId }, pullRequests: [] } } as const;
    const f = await fixture((_request, response) => respond(response, active));
    await f.run(["show", taskId, "--json"]);
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(withTaskObservation(active));
    await f.run(["update", taskId, "--assigned-to", accountId.toUpperCase(), "--if-version", String(active.version)]);
    expect(parseApiJson(f.requests.at(-1)!.body)).toEqual({ version: active.version, assignedTo: accountId });
    expect(f.context.stdout.mock.calls[1]![0]).toContain(`Assigned to: ${accountId}\n`);
    await f.run(["show", taskId, "--json"]);
    expect(parseApiJson(f.context.stdout.mock.calls[2]![0])).toEqual(withTaskObservation(active));
    expect(f.requests.map(({ method, path: pathname }) => `${method} ${pathname}`)).toEqual([
      `GET /api/v1/projects/${projectId}`, `GET /api/v1/projects/${projectId}/tasks/${taskId}`,
      `GET /api/v1/projects/${projectId}`, `PATCH /api/v1/projects/${projectId}/tasks/${taskId}`,
      `GET /api/v1/projects/${projectId}`, `GET /api/v1/projects/${projectId}/tasks/${taskId}`,
    ]);
  });
  it("reports a stale property removal without retrying or printing success", async () => {
    const f = await fixture((_request, response) => respond(response, { error: { code: "version_conflict", message: "Property version changed", requestId: "stale-property" } }, 409));
    const exit = await runCli(["task", "remove-property", taskId, "pullRequests", "--if-version", "9007199254740993", "--project", projectId], f.context, [{ name: "task", description: "Manage tasks", load: async () => ({ run: (args, current) => runTaskCommand(args, current, f.dependencies) }) }]);
    expect(exit).toBe(1);
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
    expect(f.context.stderr.mock.calls[0]![0]).toContain("version_conflict");
    expect(f.context.stderr.mock.calls[0]![0]).toContain("stale-property");
    expect(f.requests.map(({ method, path: pathname }) => `${method} ${pathname}`)).toEqual([`DELETE /api/v1/projects/${projectId}/tasks/${taskId}/properties/pullRequests`]);
    expect(parseApiJson(f.requests[0]!.body)).toEqual({ version: task.version });
  });

  it.each([undefined, "9007199254740993"].flatMap(version => [
    { name: "assignment", args: ["--assigned-to", otherId.toUpperCase()], patch: { assignedTo: otherId }, assignedTo: otherId },
    { name: "clear", args: ["--clear-assigned-to"], patch: { assignedTo: null }, assignedTo: null },
    { name: "permission", args: ["--allow-agents", "true"], patch: { allowAgents: true }, assignedTo: accountId },
    { name: "assignment and permission", args: ["--assigned-to", otherId, "--allow-agents", "true"], patch: { assignedTo: otherId, allowAgents: true }, assignedTo: otherId },
    { name: "omitted assignment", args: ["--description", "Assignment omitted"], patch: { description: "Assignment omitted" }, assignedTo: accountId },
  ].map(item => ({ ...item, version }))))("uses the complete $name update request budget with explicit version $version", async ({ version, args, patch, assignedTo }) => {
    const current = { ...task, assignedTo: accountId, allowAgents: true };
    const updated = { ...current, assignedTo, allowAgents: assignedTo === accountId, ...("description" in patch ? { description: patch.description } : {}), version: task.version + 1n };
    const f = await fixture((request, response) => respond(response, request.method === "GET" ? current : updated));
    await f.run(["update", taskId, ...args, ...(version === undefined ? [] : ["--if-version", version])]);
    expect(f.requests.map(({ method, path: pathname }) => `${method} ${pathname}`)).toEqual([
      `GET /api/v1/projects/${projectId}`,
      ...(version === undefined ? [`GET /api/v1/projects/${projectId}/tasks/${taskId}`] : []),
      `PATCH /api/v1/projects/${projectId}/tasks/${taskId}`,
    ]);
    expect(parseApiJson(f.requests.at(-1)!.body)).toEqual({ version: task.version, ...patch });
    const output = f.context.stdout.mock.calls[0]![0];
    expect(output).toContain(`Assigned to: ${assignedTo ?? "unassigned"}\n`);
    expect(output).toContain("Version: 9007199254740994\n");
    expect(f.context.stdout).toHaveBeenCalledOnce(); expect(f.context.stderr).not.toHaveBeenCalled();
    expect(f.context.workingDirectory).not.toHaveBeenCalled(); expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
  });

  it.each([otherId.toUpperCase(), "me", "unassigned"])("uses only project and ordered filtered page requests for assigned-to %s", async selection => {
    const assignedTo = selection === "me" ? accountId : selection === "unassigned" ? null : otherId;
    const first = { ...task, assignedTo, allowAgents: true, requiredPlatform: "linux" as const };
    const second = { ...first, id: otherId, title: "Second" };
    const cursor = "next cursor +/=";
    const f = await fixture((request, response) => {
      response.setHeader("Daynight-User-ID", accountId);
      respond(response, request.query.has("cursor") ? { items: [second], nextCursor: null } : { items: [first], nextCursor: cursor });
    });
    await f.run(["list", "--assigned-to", selection, "--status", "todo", "--ready", "--allow-agents", "true", "--compatible-platform", "linux", "--json"]);
    expect(f.requests.map(({ method, path: pathname }) => `${method} ${pathname}`)).toEqual([
      `GET /api/v1/projects/${projectId}`, `GET /api/v1/projects/${projectId}/tasks`, `GET /api/v1/projects/${projectId}/tasks`,
    ]);
    const filters = { assignedTo: selection === "me" ? "me" : selection === "unassigned" ? "unassigned" : otherId, status: "todo", ready: "true", allowAgents: "true", compatiblePlatform: "linux", limit: "100", include: "session" };
    expect(f.requests.slice(1).map(({ query }) => Object.fromEntries(query))).toEqual([filters, { ...filters, cursor }]);
    const { description: _firstDescription, ...firstItem } = first;
    const { description: _secondDescription, ...secondItem } = second;
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual([firstItem, secondItem].map(withTaskObservation));
    expect(f.context.stdout).toHaveBeenCalledOnce(); expect(f.context.stderr).not.toHaveBeenCalled();
    expect(f.context.workingDirectory).not.toHaveBeenCalled(); expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
  });

  it("uses one project request and one page for an empty me-assigned result", async () => {
    const f = await fixture((_request, response) => { response.setHeader("Daynight-User-ID", accountId); respond(response, { items: [], nextCursor: null }); });
    await f.run(["list", "--assigned-to", "me", "--status", "in_progress", "--json"]);
    expect(f.requests.map(({ method, path: pathname }) => `${method} ${pathname}`)).toEqual([`GET /api/v1/projects/${projectId}`, `GET /api/v1/projects/${projectId}/tasks`]);
    expect(Object.fromEntries(f.requests[1]!.query)).toEqual({ assignedTo: "me", status: "in_progress", limit: "100", include: "session" });
    expect(f.context.stdout).toHaveBeenCalledExactlyOnceWith("[]\n"); expect(f.context.stderr).not.toHaveBeenCalled();
  });

  it("preserves paused, blocked and not-ready facts in show and the two-task inventory", async () => {
    const blocked = { ...task, properties: { paused: true }, ready: false, dependsOn: [otherId], blockedBy: [otherId] };
    const prerequisite = { ...task, id: otherId, title: "Prerequisite" };
    const { description: _blockedDescription, ...blockedListItem } = blocked;
    const { description: _prerequisiteDescription, ...prerequisiteListItem } = prerequisite;
    const f = await fixture((request, response) => respond(response, request.path.endsWith(taskId) ? blocked : { items: [prerequisite, blocked], nextCursor: null }));
    await f.run(["show", taskId, "--json"]);
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(withTaskObservation(blocked));
    await f.run(["list", "--json"]);
    expect(parseApiJson(f.context.stdout.mock.calls[1]![0])).toEqual([prerequisiteListItem, blockedListItem].map(withTaskObservation));
    expect(f.context.stderr).not.toHaveBeenCalled();
  });
  it.each([false, true].flatMap((removeDepends) => [undefined, "9223372036854775807"].map((version) => ({ removeDepends, version }))))("deletes once with exact version $version and removal consent $removeDepends", async ({ version, removeDepends }) => {
    const f = await fixture((request, response) => {
      if (request.method === "DELETE") { response.writeHead(204); response.end(); }
      else respond(response, task);
    });
    await f.run(["delete", taskId.toUpperCase(), ...(removeDepends ? ["--remove-depends"] : []), ...(version === undefined ? [] : ["--if-version", version])]);
    expect(f.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET /api/v1/projects/${projectId}`,
      `GET /api/v1/projects/${projectId}/tasks/${taskId}`,
      `DELETE /api/v1/projects/${projectId}/tasks/${taskId}`,
    ]);
    expect(f.requests.at(-1)!.body).toBe(`{"version":${version === undefined ? task.version : version}${removeDepends ? ",\"removeDepends\":true" : ""}}`);
    expect(f.context.stdout).toHaveBeenCalledExactlyOnceWith(`Task deleted. Stored data and attachments are retained.\nID: ${taskId}\nProject: ${projectId}\n`);
  });

  it("leaves dependency refusal authoritative to the server until removal is explicitly authorized", async () => {
    const f = await fixture((request, response) => {
      if (request.method === "GET") { respond(response, task); return; }
      const body = parseApiJson(request.body) as { version: bigint; removeDepends?: boolean };
      if (body.removeDepends === true) { response.writeHead(204); response.end(); }
      else respond(response, { error: { code: "dependency_unsatisfied", message: "Other tasks depend on this task.", requestId: "incoming-dependencies", details: { taskIds: [otherId] } } }, 409);
    });
    await expect(f.run(["delete", taskId, "--if-version", "9007199254740993"])).rejects.toMatchObject({ code: "dependency_unsatisfied", details: { taskIds: [otherId] }, confirmedRefusal: true });
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET", "DELETE"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
    await f.run(["delete", taskId, "--remove-depends", "--if-version", "9007199254740993"]);
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET", "DELETE", "GET", "GET", "DELETE"]);
    expect(f.requests.at(-1)!.body).toBe('{"version":9007199254740993,"removeDepends":true}');
    expect(f.context.stdout).toHaveBeenCalledOnce();
  });

  it.each([
    { code: "version_conflict", status: 409 },
    { code: "dependency_unsatisfied", status: 409 },
    { code: "invalid_transition", status: 409 },
    { code: "task_deleted", status: 410 },
  ])("preserves deletion refusal $code without replay", async ({ code, status }) => {
    const f = await fixture((request, response) => request.method === "GET" ? respond(response, task) : respond(response, { error: { code, message: "Deletion refused", requestId: "delete-refused", details: { taskIds: [otherId] } } }, status));
    await expect(f.run(["delete", taskId, "--if-version", "1"])).rejects.toMatchObject({ operation: "task.delete", projectId, taskId, code, status, requestId: "delete-refused", details: { taskIds: [otherId] }, confirmedRefusal: true });
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET", "DELETE"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports a lost deletion response with consent %s as unconfirmed without resubmitting", async (removeDepends) => {
    const f = await fixture((request, response, raw) => { if (request.method === "GET") respond(response, task); else raw.socket.destroy(); });
    await expect(f.run(["delete", taskId, ...(removeDepends ? ["--remove-depends"] : []), "--if-version", "9007199254740993"])).rejects.toMatchObject({ operation: "task.delete", projectId, taskId, outcomeUnconfirmed: true });
    expect(parseApiJson(f.requests.at(-1)!.body)).toEqual({ version: task.version, ...(removeDepends ? { removeDepends: true } : {}) });
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET", "DELETE"]);
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
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET", "PUT"]);
    expect(f.requests.at(-1)!.body).toBe(`{"version":9223372036854775807,"status":"${status}"}`);
  });

  it("reports an unconfirmed status write after dispatch without retrying", async () => {
    const f = await fixture((request, response, raw) => { if (request.method === "GET") respond(response, task); else raw.socket.destroy(); });
    await expect(f.run(["set-status", taskId, "done", "--if-version", "1"])).rejects.toMatchObject({ operation: "task.set-status", projectId, taskId, outcomeUnconfirmed: true });
    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET", "PUT"]);
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

    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET", "PUT"]);
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
    const f = await fixture((request, response) => request.method === "GET" ? respond(response, task) : respond(response, { error: { code, message: "Completion refused.", requestId: "claim-completion-refused" } }, status));

    await expect(f.run(["set-status", taskId, "done", "--claim-id", claimId, "--if-version", "9007199254740993"])).rejects.toMatchObject({ operation: "worker.complete", projectId, taskId, status, code, confirmedRefusal: true, outcomeUnconfirmed: false });

    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET", "PUT"]);
    expect(parseApiJson(f.requests.at(-1)!.body)).toEqual({ version: task.version, status: "done", claimId });
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "server failure"])("keeps worker completion %s unconfirmed without a retry", async (failure) => {
    const f = await fixture((request, response, raw) => {
      if (request.method === "GET") { respond(response, task); return; }
      if (failure === "disconnect") raw.socket.destroy();
      else respond(response, { error: { code: "internal_error", message: "Completion outcome unavailable.", requestId: "claim-completion-unknown" } }, 500);
    });

    await expect(f.run(["set-status", taskId, "done", "--claim-id", claimId, "--if-version", "1"])).rejects.toMatchObject({ operation: "worker.complete", projectId, taskId, outcomeUnconfirmed: true });

    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET", "PUT"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("rejects a completion response for a different claim as an unknown outcome", async () => {
    const f = await fixture((request, response) => respond(response, request.method === "GET" ? task : { ...task, version: 2n, status: "done", ready: false, completedAt: time, properties: { worker: { ...worker, claimId: otherId, state: "completed" }, pullRequests: [] } }));

    await expect(f.run(["set-status", taskId, "done", "--claim-id", claimId, "--if-version", "1"])).rejects.toMatchObject({ operation: "worker.complete", phase: "protocol", outcomeUnconfirmed: true });

    expect(f.requests.map(({ method }) => method)).toEqual(["GET", "GET", "PUT"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("submits optional create fields exactly once and prints the confirmed result", async () => {
    const title = "-Original=title\n\u001b[2J";
    const f = await fixture((request, response) => {
      const body = parseApiJson(request.body) as { title: string; description: string; dependsOn: string[] };
      respond(response, { ...task, ...body, status: "proposed", blockedBy: body.dependsOn, ready: false }, 201);
    });
    await f.run(["create", `--title=${title}`, "--description=", "--depends-on", otherId]);
    const writes = f.requests.filter(({ method }) => method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe(`/api/v1/projects/${projectId}/tasks`);
    expect(parseApiJson(writes[0]!.body)).toEqual({ title, description: "", assignedTo: accountId, dependsOn: [otherId], externalDependsOn: [] });
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
    expect(parsed).toEqual([task, next].map(({ description: _description, ...item }) => withTaskObservation(item)));
    for (const index of [0, 1]) expect(parsed).not.toHaveProperty(`${index}.description`);
    expect(f.context.stdout.mock.calls[0]![0]).toMatch(/\n$/);
    const pages = f.requests.filter(({ path }) => path.endsWith("/tasks"));
    expect(pages.map(({ query }) => Object.fromEntries(query))).toEqual([{ status: "todo", ready: "true", limit: "100", include: "session" }, { status: "todo", ready: "true", limit: "100", include: "session", cursor: "next page+/=?" }]);
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

  it("renders complete graph data and exposes generic read failures", async () => {
    let failed = false;
    const graph: TaskGraph = { observedAt: time, project, summary: { total: 2, proposed: 0, todo: 2, inProgress: 0, done: 0, cancelled: 0, ready: 1, blocked: 1 }, tasks: [
      { type: "task", parentId: null, id: taskId, titlePreview: "T".repeat(160), titleTruncated: true, allowAgents: false, assignedTo: null, requiredPlatform: null, status: "todo", ready: false, dependsOn: [otherId], externalDependsOn: [], blockedBy: [otherId], startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time },
      { type: "task", parentId: null, id: otherId, titlePreview: "Dependency", titleTruncated: false, allowAgents: false, assignedTo: null, requiredPlatform: null, status: "todo", ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time },
    ] };
    const f = await fixture((_request, response) => {
      if (failed) respond(response, { error: { code: "internal_error", message: "Read failed", requestId: "graph-read" } }, 500);
      else respond(response, graph);
    });
    await f.run(["graph", taskId, "--json"]);
    expect(f.context.stdout).toHaveBeenCalledOnce();
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(withGraphObservations(graph, taskId));
    f.context.stdout.mockClear(); failed = true;
    await expect(f.run(["graph", taskId])).rejects.toMatchObject({ code: "internal_error", requestId: "graph-read" });
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
