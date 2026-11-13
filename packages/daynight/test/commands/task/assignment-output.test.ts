import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createApiClient } from "../../../src/api/client.js";
import { parseApiJson, stringifyApiJson } from "../../../src/api/json.js";
import type { ApiClient, Project, Task, TaskGraph, TaskPropertyResource } from "../../../src/api/index.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runCli } from "../../../src/cli/application.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { withTaskObservation, withGraphObservations } from "../../fixtures/task-observation.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333";
const time = "2026-10-20T00:00:00.123456Z";
const project: Project = { id: projectId, name: "Project", repoUrl: "git@example.test:org/repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: userId, version: 1n }, createdAt: time, updatedAt: time };
const task: Task = { type: "task", parentId: null, id: taskId, projectId, title: "Task", description: "", tags: [], properties: { pullRequests: [] }, status: "todo", allowAgents: false, assignedTo: userId, requiredPlatform: null, version: 1n, ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time };
const operations: ReturnType<typeof createOperation>[] = [];
afterEach(() => { operations.splice(0).forEach(operation => operation.dispose()); });
const fixture = () => {
  const operation = createOperation(); operations.push(operation);
  const api = {
    getProject: vi.fn(async () => project),
    getTask: vi.fn<ApiClient["getTask"]>(async () => ({ ...task, version: 9_007_199_254_740_994n })),
    createTask: vi.fn(async () => task),
    updateTask: vi.fn(async () => ({ ...task, version: 9_007_199_254_740_994n })),
    listTasks: vi.fn(async () => [] as Task[]),
    listReadyTasks: vi.fn(async () => [] as Task[]),
    getTaskGraph: vi.fn<ApiClient["getTaskGraph"]>(),
    setTaskProperty: vi.fn<ApiClient["setTaskProperty"]>(),
    removeTaskProperty: vi.fn<ApiClient["removeTaskProperty"]>(),
    getTaskPropertySchema: vi.fn<ApiClient["getTaskPropertySchema"]>(),
  };
  const context = { version: "0.0.0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected home read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); }, stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async () => {}) } satisfies CliContext;
  const observedApi = { ...api,
    getObservedTask: async (...args: Parameters<ApiClient["getObservedTask"]>) => withTaskObservation(await api.getTask(...args)),
    listObservedTasks: async (...args: Parameters<ApiClient["listObservedTasks"]>) => ({ items: (await (api.listTasks as ApiClient["listTasks"])(...args)).map(withTaskObservation), partial: false, unsupported: false }),
    getObservedTaskGraph: async (...args: Parameters<ApiClient["getObservedTaskGraph"]>) => withGraphObservations(await api.getTaskGraph(...args), args[1]),
  };
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>(),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api: observedApi as unknown as ApiClient, operation, serverUrl: "http://localhost", serverConfiguration: { serverUrl: "http://localhost" } });
      operation.check();
      if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
    }),
  };
  return { api, context, dependencies };
};

it.each(["create", "update"] as const)("prints the returned assignee and exact version after %s", async command => {
  const f = fixture();
  const args = command === "create" ? ["create", "--title", "Task", "--assigned-to", userId] : ["update", taskId, "--assigned-to", userId, "--if-version", "9007199254740993"];
  await runTaskCommand([...args, "--project", projectId], f.context, f.dependencies);
  const output = f.context.stdout.mock.calls[0]![0];
  expect(output).toContain(`Assigned to: ${userId}\n`);
  expect(output).toContain(`Version: ${command === "create" ? "1" : "9007199254740994"}\n`);
  expect(command === "create" ? f.api.createTask : f.api.updateTask).toHaveBeenCalledOnce();
});

it("prints both writable PR and read-only worker schemas without project discovery", async () => {
  const f = fixture();
  const schema = { properties: { pullRequests: { description: "PRs", readOnly: false, schema: { type: "array" } }, worker: { description: "Worker ownership", readOnly: true, schema: { type: "object" } } } };
  f.api.getTaskPropertySchema.mockResolvedValue(schema);
  await runTaskCommand(["properties", "--schema", "--json"], f.context, f.dependencies);
  expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(schema);
  expect(f.api.getTaskPropertySchema).toHaveBeenCalledOnce();
  expect(f.api.getProject).not.toHaveBeenCalled(); expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
});

it("prints returned PR properties with duplicates and escaped controls after set-property", async () => {
  const f = fixture();
  const entry = { url: "-arbitrary=地址, text", title: "  标题\n\u001b[2J  " };
  const pullRequests = [{ url: "", title: "" }, entry, entry];
  const resource: TaskPropertyResource = { projectId, taskId, version: 2n, properties: { pullRequests } };
  f.api.setTaskProperty.mockResolvedValue(resource);
  const value = JSON.stringify(pullRequests);
  await runTaskCommand(["set-property", taskId, "pullRequests", value, "--if-version", "1", "--project", projectId], f.context, f.dependencies);
  expect(f.api.setTaskProperty).toHaveBeenCalledExactlyOnceWith(projectId, taskId, "pullRequests", { version: 1n, valueText: value });
  const output = f.context.stdout.mock.calls[0]![0];
  expect(output).toContain("Properties (1):\n  pullRequests: ");
  expect(output).toContain('{"url":"","title":""}');
  expect(output.split('{"url":"-arbitrary=地址, text","title":"  标题\\n\\u001b[2J  "}')).toHaveLength(3);
  expect(output).not.toContain("\u001b");
});

it("prints an absent property as an empty resource after removal", async () => {
  const f = fixture();
  f.api.removeTaskProperty.mockResolvedValue({ projectId, taskId, version: 2n, properties: {} });
  await runTaskCommand(["remove-property", taskId, "pullRequests", "--if-version", "1", "--project", projectId], f.context, f.dependencies);
  expect(f.api.removeTaskProperty).toHaveBeenCalledExactlyOnceWith(projectId, taskId, "pullRequests", { version: 1n });
  expect(f.context.stdout).toHaveBeenCalledExactlyOnceWith(`Task property removed.\nTask: ${taskId}\nProject: ${projectId}\nVersion: 2\nProperties (0): {}\n`);
});

it("keeps empty properties and the exact version in task show JSON", async () => {
  const f = fixture();
  const returned: Task = { ...task, properties: {}, version: 1n };
  f.api.getTask.mockResolvedValue(returned);
  await runTaskCommand(["show", taskId, "--json", "--project", projectId], f.context, f.dependencies);
  expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(withTaskObservation(returned));
});

it("renders only returned graph nodes and their summary", async () => {
  const f = fixture();
  const otherId = "dddddddd-4444-4444-8444-444444444444";
  const node = { type: "task", parentId: null, id: taskId, titlePreview: "First", titleTruncated: false, status: "todo", ready: false, allowAgents: false, assignedTo: userId, requiredPlatform: null, dependsOn: [otherId], externalDependsOn: [], blockedBy: [otherId], startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time } as const;
  const graph: TaskGraph = { observedAt: time, project: { ...project, settings: { ...project.settings, version: 9_007_199_254_740_993n } }, summary: { total: 2, proposed: 0, todo: 2, inProgress: 0, done: 0, cancelled: 0, ready: 1, blocked: 1 }, tasks: [node, { ...node, id: otherId, titlePreview: "Second", ready: true, dependsOn: [], blockedBy: [] }] };
  f.api.getTaskGraph.mockResolvedValue(graph);
  await runTaskCommand(["graph", taskId, "--project", projectId], f.context, f.dependencies);
  const output = f.context.stdout.mock.calls[0]![0];
  expect(output).toContain("Todo: 2\n");
  expect(output).toContain(`ID: ${taskId}\n`); expect(output).toContain(`ID: ${otherId}\n`);
  expect(output).toContain("Proposed: 0\n");
  expect(output.match(/^ID: /gm)).toHaveLength(2);
  await runTaskCommand(["graph", taskId, "--json", "--project", projectId], f.context, f.dependencies);
  expect(parseApiJson(f.context.stdout.mock.calls[1]![0])).toEqual(withGraphObservations(graph, taskId));
  expect(f.context.stdout.mock.calls[1]![0]).toContain('"version":9007199254740993');
});

it.each([
  ["todo", null, false, 18n], ["todo", "windows", true, 19n],
  ["in_progress", "linux", false, 20n], ["done", "macos", true, 21n],
] as const)("preserves returned %s resource with platform %s and exact version in JSON", async (status, requiredPlatform, allowAgents, version) => {
  const f = fixture();
  const returned: Task = { ...task, status, requiredPlatform, allowAgents, version, properties: { pullRequests: [{ url: "历史", title: "Preserved" }] } };
  f.api.getTask.mockResolvedValue(returned);
  await runTaskCommand(["show", taskId, "--json", "--project", projectId], f.context, f.dependencies);
  expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(withTaskObservation(returned));
  expect(f.api.getTask).toHaveBeenCalledExactlyOnceWith(projectId, taskId);
});

it("preserves ready and blocked todo details from the returned resources", async () => {
  const f = fixture();
  const prerequisite = "dddddddd-4444-4444-8444-444444444444";
  const ready: Task = { ...task, description: "Persistent todo description", version: 17n };
  const blocked: Task = { ...task, version: 19n, ready: false, dependsOn: [prerequisite], blockedBy: [prerequisite] };
  f.api.getTask.mockResolvedValueOnce(ready).mockResolvedValueOnce(blocked).mockResolvedValueOnce(ready);
  await runTaskCommand(["show", taskId, "--json", "--project", projectId], f.context, f.dependencies);
  await runTaskCommand(["show", taskId, "--json", "--project", projectId], f.context, f.dependencies);
  expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(withTaskObservation(ready));
  expect(parseApiJson(f.context.stdout.mock.calls[1]![0])).toEqual(withTaskObservation(blocked));
  await runTaskCommand(["show", taskId, "--project", projectId], f.context, f.dependencies);
  const text = f.context.stdout.mock.calls[2]![0];
  for (const field of ["Status: todo\n", "Ready: true\n", "Description: Persistent todo description\n", "Version: 17\n"]) expect(text).toContain(field);
});

it("keeps external dependency classification in ready text and JSON", async () => {
  const f = fixture();
  const prerequisite = "dddddddd-4444-4444-8444-444444444444";
  const ready: Task = { ...task, dependsOn: [prerequisite], externalDependsOn: [prerequisite], blockedBy: [], ready: true };
  f.api.listReadyTasks.mockResolvedValue([ready]);
  await runTaskCommand(["ready", "--project", projectId], f.context, f.dependencies);
  expect(f.context.stdout.mock.calls[0]![0]).toContain(`External dependencies (1): ${prerequisite}\n`);
  await runTaskCommand(["ready", "--json", "--project", projectId], f.context, f.dependencies);
  expect(parseApiJson(f.context.stdout.mock.calls[1]![0])).toEqual([ready]);
  expect(f.api.listReadyTasks).toHaveBeenCalledTimes(2);
});

it("keeps external dependency classification across show, list and graph text", async () => {
  const f = fixture();
  const prerequisite = "dddddddd-4444-4444-8444-444444444444";
  const classified: Task = { ...task, dependsOn: [prerequisite], externalDependsOn: [prerequisite], blockedBy: [prerequisite], ready: false };
  const node = { type: "task", parentId: null, id: taskId, titlePreview: task.title, titleTruncated: false, status: "todo", ready: false, allowAgents: false, assignedTo: userId, requiredPlatform: null, dependsOn: [prerequisite], externalDependsOn: [prerequisite], blockedBy: [prerequisite], startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time } as const;
  const graph: TaskGraph = { observedAt: time, project, summary: { total: 2, proposed: 0, todo: 2, inProgress: 0, done: 0, cancelled: 0, ready: 1, blocked: 1 }, tasks: [{ ...node, id: prerequisite, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true }, node] };
  f.api.getTask.mockResolvedValue(classified); f.api.listTasks.mockResolvedValue([classified]); f.api.getTaskGraph.mockResolvedValue(graph);
  for (const args of [["show", taskId], ["list"], ["graph", taskId]]) await runTaskCommand([...args, "--project", projectId], f.context, f.dependencies);
  for (const [output] of f.context.stdout.mock.calls) expect(output).toContain(`External dependencies (1): ${prerequisite}\n`);
  await runTaskCommand(["graph", taskId, "--json", "--project", projectId], f.context, f.dependencies);
  expect(parseApiJson(f.context.stdout.mock.calls[3]![0])).toEqual(withGraphObservations(graph, taskId));
});

it("keeps completed graph members and summary in JSON", async () => {
  const f = fixture();
  const prerequisite = "dddddddd-4444-4444-8444-444444444444";
  const node = { type: "task", parentId: null, id: taskId, titlePreview: task.title, titleTruncated: false, status: "done", ready: false, allowAgents: false, assignedTo: userId, requiredPlatform: null, dependsOn: [prerequisite], externalDependsOn: [], blockedBy: [], startedAt: time, completedAt: time, cancelledAt: null, createdAt: time, updatedAt: time } as const;
  const graph: TaskGraph = { observedAt: time, project, summary: { total: 2, proposed: 0, todo: 0, inProgress: 0, done: 2, cancelled: 0, ready: 0, blocked: 0 }, tasks: [{ ...node, id: prerequisite, dependsOn: [] }, node] };
  f.api.getTaskGraph.mockResolvedValue(graph);
  await runTaskCommand(["graph", taskId, "--json", "--project", projectId], f.context, f.dependencies);
  expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(withGraphObservations(graph, taskId));
});

it("prints an explicit empty JSON array for an empty me-assigned list", async () => {
  const f = fixture();
  await runTaskCommand(["list", "--assigned-to", "me", "--json", "--project", projectId], f.context, f.dependencies);
  expect(f.api.listTasks).toHaveBeenCalledExactlyOnceWith(projectId, { assignedTo: "me" });
  expect(f.context.stdout).toHaveBeenCalledExactlyOnceWith("[]\n");
});

it("keeps the assigned account and exact version in task JSON", async () => {
  const f = fixture();
  await runTaskCommand(["show", taskId, "--json", "--project", projectId], f.context, f.dependencies);
  const output = f.context.stdout.mock.calls[0]![0];
  expect(parseApiJson(output)).toMatchObject({ assignedTo: userId, version: 9_007_199_254_740_994n });
  expect(output).toContain('"version":9007199254740994');
});

it("shows unassigned in each compact result without full-resource fields", async () => {
  const f = fixture();
  f.api.listTasks.mockResolvedValue([{ ...task, assignedTo: null }, { ...task, id: "dddddddd-4444-4444-8444-444444444444", assignedTo: null }]);
  await runTaskCommand(["list", "--assigned-to", "unassigned", "--project", projectId], f.context, f.dependencies);
  const output = f.context.stdout.mock.calls[0]![0];
  expect(output.match(/Assigned to: unassigned\n/g)).toHaveLength(2);
  expect(output).not.toContain("Description:"); expect(output).not.toContain("Version:");
});

it("keeps compact list order, status, dependencies and escaped PR values", async () => {
  const f = fixture();
  const doneId = "dddddddd-4444-4444-8444-444444444444";
  const done: Task = { ...task, id: doneId, title: "Done", status: "done", ready: false, dependsOn: [taskId], properties: { pullRequests: [{ url: "link\u0000\u001b[2J", title: "title" }] } };
  f.api.listTasks.mockResolvedValue([{ ...task, properties: {} }, done]);
  await runTaskCommand(["list", "--all", "--project", projectId], f.context, f.dependencies);
  const output = f.context.stdout.mock.calls[0]![0];
  expect(output.indexOf(`ID: ${taskId}\n`)).toBeLessThan(output.indexOf(`ID: ${doneId}\n`));
  expect(output).toContain(`ID: ${doneId}\nProject: ${projectId}\nType: task\nParent: none\nTitle: Done\n`);
  expect(output).toContain("Status: todo\n"); expect(output).toContain("Status: done\n");
  expect(output).toContain("Properties: 0\n");
  expect(output).toContain("Ready: true\nDepends on: none\nExternal dependencies (0): none\nBlocked by: none\n");
  expect(output).toContain(`Depends on: ${taskId}\n`);
  expect(output).toContain('"url":"link\\u0000\\u001b[2J"');
  for (const field of ["Description:", "Version:", "Created:", "Updated:"]) expect(output).not.toContain(field);
  expect(output).not.toMatch(/[\u0000\u001b]/);
});

it("reports a version conflict with the task and server request identity without retrying", async () => {
  const f = fixture();
  const operation = createOperation(); operations.push(operation);
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith(`/api/v1/projects/${projectId}`)) return new Response(stringifyApiJson(project), { headers: { "Content-Type": "application/json" } });
    if (init?.method === "GET" && String(url).endsWith(`/api/v1/projects/${projectId}/tasks/${taskId}`)) return new Response(stringifyApiJson({ ...task, version: 2n }), { headers: { "Content-Type": "application/json" } });
    expect(init?.method).toBe("PUT");
    return new Response(stringifyApiJson({ error: { code: "version_conflict", message: "Task changed.", requestId: "fixture-version-conflict" } }), { status: 409, headers: { "Content-Type": "application/json" } });
  });
  const api = createApiClient({ serverUrl: "http://localhost", operation, fetch });
  const dependencies = { ...f.dependencies, runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
    const output = await command({ api, operation, serverUrl: "http://localhost", serverConfiguration: { serverUrl: "http://localhost" } });
    if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
  }) };
  const registry = [{ name: "task", description: "Manage tasks", load: async () => ({ run: (args: readonly string[], current: CliContext) => runTaskCommand(args, current, dependencies) }) }];
  expect(await runCli(["task", "set-status", taskId, "done", "--if-version", "1", "--project", projectId], f.context, registry)).toBe(1);
  expect(f.context.stdout).not.toHaveBeenCalled();
  const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
  expect(diagnostic).toContain("version_conflict"); expect(diagnostic).toContain(taskId); expect(diagnostic).toContain("fixture-version-conflict");
  expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "GET", "PUT"]);
});

it("keeps concurrent same-version updates independent and does not retry the refused write", async () => {
  let release!: () => void;
  const bothSubmitted = new Promise<void>(resolve => { release = resolve; });
  const mutations: { title: string; version: bigint }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith(`/api/v1/projects/${projectId}`)) return new Response(stringifyApiJson(project), { headers: { "Content-Type": "application/json" } });
    expect(init?.method).toBe("PATCH");
    const body = parseApiJson(String(init!.body)) as { title: string; version: bigint };
    mutations.push(body); if (mutations.length === 2) release();
    await bothSubmitted;
    const response = body.title === "left" ? { ...task, title: "left", version: 2n } : { error: { code: "version_conflict", message: "Task changed.", requestId: "right-conflict" } };
    return new Response(stringifyApiJson(response), { status: body.title === "left" ? 200 : 409, headers: { "Content-Type": "application/json" } });
  });
  const run = (title: string) => {
    const f = fixture(); const operation = createOperation(); operations.push(operation);
    const api = createApiClient({ serverUrl: "http://localhost", operation, fetch });
    const dependencies = { ...f.dependencies, runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost", serverConfiguration: { serverUrl: "http://localhost" } });
      if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
    }) };
    const registry = [{ name: "task", description: "Manage tasks", load: async () => ({ run: (args: readonly string[], current: CliContext) => runTaskCommand(args, current, dependencies) }) }];
    return { ...f, running: runCli(["task", "update", taskId, "--title", title, "--if-version", "1", "--project", projectId], f.context, registry) };
  };
  const left = run("left"), right = run("right");
  expect(await Promise.all([left.running, right.running])).toEqual([0, 1]);
  expect(mutations).toEqual(expect.arrayContaining([{ title: "left", version: 1n }, { title: "right", version: 1n }]));
  expect(mutations).toHaveLength(2);
  expect(left.context.stdout.mock.calls[0]![0]).toContain("Title: left\n");
  expect(right.context.stdout).not.toHaveBeenCalled();
  expect(right.context.stderr.mock.calls.map(([text]) => text).join("")).toContain("right-conflict");
});

it("keeps concurrent same-version status outcomes separate without retrying either write", async () => {
  let release!: () => void;
  const bothSubmitted = new Promise<void>(resolve => { release = resolve; });
  const writes: { status: string; version: bigint }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith(`/api/v1/projects/${projectId}`)) return new Response(stringifyApiJson(project), { headers: { "Content-Type": "application/json" } });
    if (init?.method === "GET" && String(url).endsWith(`/api/v1/projects/${projectId}/tasks/${taskId}`)) return new Response(stringifyApiJson({ ...task, version: 2n }), { headers: { "Content-Type": "application/json" } });
    expect(init?.method).toBe("PUT");
    expect(String(url)).toContain(`/api/v1/projects/${projectId}/tasks/${taskId}/status`);
    const body = parseApiJson(String(init!.body)) as { status: string; version: bigint };
    writes.push(body); if (writes.length === 2) release();
    await bothSubmitted;
    const response = body.status === "in_progress" ? { ...task, status: "in_progress", ready: false, startedAt: time, version: 2n } : { error: { code: "version_conflict", message: "Task changed.", requestId: "status-conflict" } };
    return new Response(stringifyApiJson(response), { status: body.status === "in_progress" ? 200 : 409, headers: { "Content-Type": "application/json" } });
  });
  const run = (status: string) => {
    const f = fixture(); const operation = createOperation(); operations.push(operation);
    const api = createApiClient({ serverUrl: "http://localhost", operation, fetch });
    const dependencies = { ...f.dependencies, runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost", serverConfiguration: { serverUrl: "http://localhost" } });
      if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
    }) };
    const registry = [{ name: "task", description: "Manage tasks", load: async () => ({ run: (args: readonly string[], current: CliContext) => runTaskCommand(args, current, dependencies) }) }];
    return { ...f, running: runCli(["task", "set-status", taskId, status, "--if-version", "1", "--project", projectId], f.context, registry) };
  };
  const start = run("in_progress"), complete = run("done");
  expect(await Promise.all([start.running, complete.running]), start.context.stderr.mock.calls.map(([text]) => text).join("")).toEqual([0, 1]);
  expect(writes).toEqual(expect.arrayContaining([{ status: "in_progress", version: 1n }, { status: "done", version: 1n }]));
  expect(writes).toHaveLength(2);
  expect(start.context.stdout.mock.calls[0]![0]).toContain("Status: in_progress\n");
  expect(complete.context.stdout).not.toHaveBeenCalled();
  expect(complete.context.stderr.mock.calls.map(([text]) => text).join("")).toContain("status-conflict");
});
