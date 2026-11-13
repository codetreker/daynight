import { describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import { commandTree } from "../../../src/cli/commands.js";
import { renderBashCompletion } from "../../../src/commands/completion/bash.js";
import { renderZshCompletion } from "../../../src/commands/completion/zsh.js";
import { runCli } from "../../../src/cli/application.js";
import { UsageError } from "../../../src/cli/context.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { actorId, project, projectId, task, taskId, time } from "../../fixtures/task-observation.js";

const tagA = "aaaaaaaa-1111-4111-8111-111111111111";
const tagB = "bbbbbbbb-1111-4111-8111-111111111111";
const refA = { id: tagA, name: "Backend" };
const refB = { id: tagB, name: "Urgent" };
const endpoint = `/api/v1/projects/${projectId}/tasks/${taskId}`;
const response = (value: unknown, status = 200) => new Response(stringifyApiJson(value), { status, headers: { "content-type": "application/json", "Daynight-User-ID": actorId } });

const fixture = (handler: (url: URL, init: RequestInit) => Response | Promise<Response>) => {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const request = init ?? {};
    if (url.pathname === `/api/v1/projects/${projectId}`) return response(project);
    return handler(url, request);
  });
  const context = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: () => "unused",
    workingDirectory: () => { throw new Error("Explicit project must not query cwd"); },
    stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async () => {}),
  };
  const runServerCommand: TaskCommandDependencies["runServerCommand"] = async (current, command) => {
    const operation = createOperation();
    try {
      const serverUrl = "https://server.example";
      const api = createApiClient({ serverUrl, serverToken: "fixture-token", operation, fetch: fetcher });
      const output = await command({ api, operation, serverUrl, serverConfiguration: { serverUrl } });
      operation.check();
      if (typeof output === "string") current.stdout(output);
      else if (output !== undefined) current.stdout(output.output);
    } finally { operation.dispose(); }
  };
  const dependencies: TaskCommandDependencies = { runServerCommand, resolveProject: vi.fn().mockRejectedValue(new Error("Unexpected project discovery")) };
  const run = (args: string[]) => runTaskCommand([...args, "--project", projectId], context, dependencies);
  const cli = (args: string[]) => runCli(["task", ...args, "--project", projectId], context, [{ name: "task", description: "Manage tasks", load: async () => ({ run: (args, current) => runTaskCommand(args, current, dependencies) }) }]);
  const calls = () => fetcher.mock.calls.map(([url, init]) => ({ url: new URL(String(url)), init: init ?? {} })).filter(({ url }) => url.pathname !== `/api/v1/projects/${projectId}`);
  return { context, dependencies, fetcher, run, cli, calls };
};

const parseBody = (init: RequestInit) => parseApiJson(String(init.body));

describe("Task tag association commands", () => {
  it.each(["task", "goal"] as const)("creates a %s with one canonical tag set in the creation request", async type => {
    const created = { ...task, type, status: type === "task" ? "proposed" : "todo", ready: false, assignedTo: null, allowAgents: false, startedAt: null, tags: [refA, refB], ...(type === "goal" ? { progress: { total: 0, done: 0, cancelled: 0, unfinished: 0 } } : {}) };
    const f = fixture((url, init) => {
      expect(url.pathname).toBe(`/api/v1/projects/${projectId}/tasks`);
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-token");
      return response(created, 201);
    });
    await f.run(["create", "--title", "Task", "--type", type, "--clear-assigned-to", "--tag", tagB.toUpperCase(), "--tag", tagA, "--tag", tagB]);
    expect(f.calls()).toHaveLength(1);
    expect(parseBody(f.calls()[0]!.init)).toEqual({ title: "Task", type, assignedTo: null, tagIds: [tagA, tagB] });
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Backend");
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Urgent");
  });

  it("creates without a tag field and checks an empty receipt", async () => {
    const created = { ...task, status: "proposed", startedAt: null, ready: false, assignedTo: null, allowAgents: false, tags: [] };
    const f = fixture(() => response(created, 201));
    await f.run(["create", "--title", "Task", "--clear-assigned-to"]);
    expect(parseBody(f.calls()[0]!.init)).toEqual({ title: "Task", assignedTo: null });
  });

  it.each([
    { args: ["--tag", tagB, "--tag", tagA.toUpperCase(), "--tag", tagA], tags: [refA, refB], ids: [tagA, tagB] },
    { args: ["--clear-tags"], tags: [], ids: [] },
  ])("replaces or clears tags in one conditional metadata PATCH", async ({ args, tags, ids }) => {
    const f = fixture((_url, init) => response({ ...task, title: "Renamed", tags, version: task.version + 1n }));
    await f.run(["update", taskId, "--title", "Renamed", ...args, "--if-version", String(task.version)]);
    expect(f.calls()).toHaveLength(1);
    expect(f.calls()[0]!.url.pathname).toBe(endpoint);
    expect(f.calls()[0]!.init.method).toBe("PATCH");
    expect(parseBody(f.calls()[0]!.init)).toEqual({ version: task.version, title: "Renamed", tagIds: ids });
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Renamed");
  });

  it.each([
    { action: "add", current: [refA], target: tagB, ids: [tagA, tagB], result: [refA, refB] },
    { action: "remove", current: [refA, refB], target: tagA, ids: [tagB], result: [refB] },
    { action: "add", current: [refA], target: tagA, ids: [tagA], result: [refA] },
    { action: "remove", current: [refA], target: tagB, ids: [tagA], result: [refA] },
  ])("$action reads current tags and submits one exact-version PATCH, including no-op", async ({ action, current, target, ids, result }) => {
    const f = fixture((url, init) => {
      expect(url.pathname).toBe(endpoint);
      return response({ ...task, tags: init.method === "GET" ? current : result, version: init.method === "GET" || current.length === result.length && current.every((tag, index) => tag.id === result[index]?.id) ? task.version : task.version + 1n });
    });
    await f.run(["tag", action, taskId.toUpperCase(), target.toUpperCase(), "--if-version", String(task.version)]);
    const calls = f.calls();
    expect(calls.map(({ init }) => init.method)).toEqual(["GET", "PATCH"]);
    expect(parseBody(calls[1]!.init)).toEqual({ version: task.version, tagIds: ids });
    expect(f.context.stdout).toHaveBeenCalledOnce();
  });

  it.each(["task", "goal"].flatMap(type => (type === "task" ? ["proposed", "todo", "in_progress", "done", "cancelled"] : ["todo", "in_progress", "done", "cancelled"]).map(status => ({ type, status }))))("submits only tags for $type in $status", async ({ type, status }) => {
    const current = { ...task, type, status, ready: type === "task" && status === "todo", allowAgents: type === "task", tags: [refA], startedAt: status === "in_progress" ? time : null,
      completedAt: status === "done" ? time : null, cancelledAt: status === "cancelled" ? time : null,
      ...(type === "goal" ? { progress: { total: 0, done: 0, cancelled: 0, unfinished: 0 } } : {}) };
    const f = fixture((_url, init) => response({ ...current, tags: init.method === "GET" ? [refA] : [refA, refB], version: init.method === "GET" ? task.version : task.version + 1n }));
    await f.run(["tag", "add", taskId, tagB]);
    expect(f.calls().map(({ init }) => init.method)).toEqual(["GET", "PATCH"]);
    expect(parseBody(f.calls()[1]!.init)).toEqual({ version: task.version, tagIds: [tagA, tagB] });
    expect(f.context.stdout.mock.calls[0]![0]).toContain(`Status: ${status}`);
  });

  it("leaves tags out of an update when neither tag option is supplied", async () => {
    const f = fixture(() => response({ ...task, title: "Changed", tags: [refA] }));
    await f.run(["update", taskId, "--title", "Changed", "--if-version", String(task.version)]);
    expect(parseBody(f.calls()[0]!.init)).toEqual({ version: task.version, title: "Changed" });
  });

  it("exposes tag options and association commands in help and completion", async () => {
    const f = fixture(() => { throw new Error("Unexpected request"); });
    for (const [args, expected] of [
      [["create", "--help"], "--tag"], [["update", "--help"], "--clear-tags"],
      [["tag", "add", "--help"], "--if-version"], [["tag", "remove", "--help"], "--if-version"],
    ] as const) {
      await runTaskCommand([...args], f.context, f.dependencies);
      expect(f.context.stdout.mock.lastCall![0]).toContain(expected);
    }
    expect(f.fetcher).not.toHaveBeenCalled();
    const taskCommand = commandTree.commands!.find(({ name }) => name === "task")!;
    const tagCommand = taskCommand.commands!.find(({ name }) => name === "tag")!;
    expect(renderBashCompletion(tagCommand)).toContain("dn_children=('add' 'remove')");
    expect(renderZshCompletion(tagCommand)).toContain("add");
    expect(renderZshCompletion(tagCommand)).toContain("remove");
    for (const name of ["create", "update"]) {
      const command = taskCommand.commands!.find(item => item.name === name)!;
      expect(renderBashCompletion(command)).toContain("--tag");
      expect(renderZshCompletion(command)).toContain("--tag");
    }
  });

  it("uses the observed version when add omits --if-version", async () => {
    const f = fixture((_url, init) => response({ ...task, tags: init.method === "GET" ? [refA] : [refA, refB], version: init.method === "GET" ? task.version : task.version + 1n }));
    await f.run(["tag", "add", taskId, tagB]);
    expect(f.calls().map(({ init }) => init.method)).toEqual(["GET", "PATCH"]);
    expect(parseBody(f.calls()[1]!.init)).toEqual({ version: task.version, tagIds: [tagA, tagB] });
  });

  it("does not replace a stale explicit version with the read version", async () => {
    const f = fixture((_url, init) => init.method === "GET" ? response({ ...task, tags: [refA] }) : response({ error: { code: "version_conflict", message: "stale", requestId: "stale-request" } }, 409));
    const exit = await f.cli(["tag", "add", taskId, tagB, "--if-version", String(task.version - 1n)]);
    expect(exit).toBe(1);
    expect(f.calls().map(({ init }) => init.method)).toEqual(["GET"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each([
    ["create", "--title", "Task", "--tag", "invalid"],
    ["update", taskId, "--tag", tagA, "--clear-tags"],
    ["update", taskId, "--tag", "invalid"],
    ["tag", "add", taskId, "invalid"],
    ["tag", "remove", "invalid", tagA],
    ["tag", "add", taskId, tagA, "--if-version", "0"],
  ])("rejects malformed or contradictory input before requests: %s", async (...args) => {
    const f = fixture(() => { throw new Error("Unexpected request"); });
    await expect(f.run(args)).rejects.toBeInstanceOf(UsageError);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(["invalid_tag", "forbidden", "version_conflict", "payload_too_large"])("reports %s and does not retry the write", async code => {
    const f = fixture((_url, init) => init.method === "GET" ? response({ ...task, tags: [refA] }) : response({ error: { code, message: "refused", requestId: "refusal-id" } }, code === "forbidden" ? 403 : 409));
    const exit = await f.cli(["tag", "add", taskId, tagB]);
    expect(exit).toBe(1);
    expect(f.calls().map(({ init }) => init.method)).toEqual(["GET", "PATCH"]);
    expect(f.context.stderr.mock.calls[0]![0]).toContain(code);
    expect(f.context.stderr.mock.calls[0]![0]).toContain("refusal-id");
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("does not replay an unknown PATCH outcome", async () => {
    const f = fixture((_url, init) => {
      if (init.method === "GET") return response({ ...task, tags: [refA] });
      throw new Error("connection lost after request");
    });
    const exit = await f.cli(["tag", "add", taskId, tagB]);
    expect(exit).toBe(1);
    expect(f.calls().map(({ init }) => init.method)).toEqual(["GET", "PATCH"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
    expect(f.context.stderr.mock.calls[0]![0]).toMatch(/unknown|unconfirmed/i);
  });

  it("rejects an untagged create receipt that unexpectedly contains tags", async () => {
    const created = { ...task, status: "proposed", startedAt: null, ready: false, assignedTo: null, allowAgents: false, tags: [refA] };
    const f = fixture(() => response(created, 201));
    await expect(f.run(["create", "--title", "Task", "--clear-assigned-to"])).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(f.calls()).toHaveLength(1);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each([
    { target: tagB, tags: [refA, refB], version: task.version },
    { target: tagA, tags: [refA], version: task.version + 1n },
  ])("rejects a receipt version inconsistent with whether the set changed", async ({ target, tags, version }) => {
    const f = fixture((_url, init) => response({ ...task, tags: init.method === "GET" ? [refA] : tags, version: init.method === "GET" ? task.version : version }));
    await expect(f.run(["tag", "add", taskId, target])).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(f.calls().map(({ init }) => init.method)).toEqual(["GET", "PATCH"]);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("rejects a matching tag receipt with an impossible version", async () => {
    const f = fixture(() => response({ ...task, tags: [refA], version: task.version + 2n }));
    await expect(f.run(["update", taskId, "--tag", tagA, "--if-version", String(task.version)])).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(f.calls()).toHaveLength(1);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each(["create", "update"])("rejects a successful %s receipt with the wrong tag IDs", async action => {
    const created = { ...task, status: "proposed", startedAt: null, ready: false, assignedTo: null, allowAgents: false, tags: [refB] };
    const f = fixture((_url, init) => response(init.method === "POST" ? created : { ...task, tags: [refB] }, init.method === "POST" ? 201 : 200));
    const args = action === "create" ? ["create", "--title", "Task", "--clear-assigned-to", "--tag", tagA] : ["update", taskId, "--tag", tagA, "--if-version", String(task.version)];
    await expect(f.run(args)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(f.calls()).toHaveLength(1);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });
});
