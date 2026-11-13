import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../../src/api/index.js";
import { commandTree } from "../../../src/cli/commands.js";
import { runCli } from "../../../src/cli/application.js";
import { renderBashCompletion } from "../../../src/commands/completion/bash.js";
import { renderZshCompletion } from "../../../src/commands/completion/zsh.js";
import { runTaskCommand, type TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { actorId, project, projectId, task, taskId, time, withTaskObservation } from "../../fixtures/task-observation.js";

const tagA = "aaaaaaaa-1111-4111-8111-111111111111";
const tagB = "bbbbbbbb-1111-4111-8111-111111111111";
const goalId = "cccccccc-1111-4111-8111-111111111111";
const secondId = "dddddddd-1111-4111-8111-111111111111";
const headers = { "content-type": "application/json", "Daynight-User-ID": actorId };
const response = (value: unknown, status = 200, principal = actorId) => new Response(stringifyApiJson(value), { status, headers: { ...headers, "Daynight-User-ID": principal } });
const searchFixture = (name: string): any => JSON.parse(readFileSync(new URL(`../../fixtures/task-search/${name}.json`, import.meta.url), "utf8"));

function fixture(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    return url.pathname === `/api/v1/projects/${projectId}` ? response(project) : handler(url, init ?? {});
  });
  const context = { version: "0.0.0", packageDirectory: "unused", homeDirectory: () => "unused",
    workingDirectory: () => { throw new Error("Explicit project must not query cwd"); },
    stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async () => {}) };
  const dependencies: TaskCommandDependencies = {
    resolveProject: vi.fn().mockRejectedValue(new Error("Unexpected project discovery")),
    runServerCommand: async (current, command) => {
      const operation = createOperation();
      try {
        const serverUrl = "https://server.example";
        const api = createApiClient({ serverUrl, serverToken: "fixture-token", operation, fetch: fetcher });
        const output = await command({ api, operation, serverUrl, serverConfiguration: { serverUrl } });
        operation.check();
        if (typeof output === "string") current.stdout(output);
        else if (output !== undefined) current.stdout(output.output);
      } finally { operation.dispose(); }
    },
  };
  const run = (args: string[]) => runCli(["task", ...args, "--project", projectId], context, [{ name: "task", description: "Manage tasks", load: async () => ({ run: (args, current) => runTaskCommand(args, current, dependencies) }) }]);
  const calls = () => fetcher.mock.calls.map(([url, init]) => ({ url: new URL(String(url)), init: init ?? {} })).filter(({ url }) => url.pathname !== `/api/v1/projects/${projectId}`);
  return { context, dependencies, fetcher, run, calls };
}

const readyTask = { ...task, status: "todo", ready: true, startedAt: null, parentId: goalId, tags: [{ id: tagA, name: "A" }, { id: tagB, name: "B" }] };
const page = (items: unknown[], nextCursor: string | null) => ({ items: items.map(withTaskObservation), nextCursor, observedAt: time, partial: false });
const searchPage = (name: string) => {
  const value = searchFixture(name);
  return { ...value, projectId, items: value.items.map((item: any) => ({ ...item, projectId, parentId: goalId, context: { taskId: goalId, title: "Goal" }, assignedTo: actorId, tags: [{ id: tagA, name: "A" }, { id: tagB, name: "B" }] })) };
};

describe("Task tag filter commands", () => {
  it("preserves canonical all filters and other conditions across list pages", async () => {
    const f = fixture(url => response(url.searchParams.has("cursor") ? page([{ ...readyTask, id: secondId }], null) : page([readyTask], "next+/=")));
    expect(await f.run(["list", "--type", "task", "--parent", goalId.toUpperCase(), "--status", "todo", "--assigned-to", "me", "--tag", tagB.toUpperCase(), "--tag", tagA, "--tag", tagA.toUpperCase(), "--json"])).toBe(0);
    expect(f.calls().map(({ url }) => Object.fromEntries(url.searchParams))).toEqual([
      { type: "task", parentId: goalId, assignedTo: "me", status: "todo", tagIds: `${tagA},${tagB}`, tagMatch: "all", limit: "100", include: "session" },
      { type: "task", parentId: goalId, assignedTo: "me", status: "todo", tagIds: `${tagA},${tagB}`, tagMatch: "all", limit: "100", include: "session", cursor: "next+/=" },
    ]);
    expect(JSON.parse(f.context.stdout.mock.calls[0]![0]).map((item: any) => item.id)).toEqual([taskId, secondId]);
    expect(f.calls().every(({ init }) => new Headers(init.headers).get("authorization") === "Bearer fixture-token")).toBe(true);
  });

  it("sends any filter and other ready conditions before the capped single page", async () => {
    const f = fixture(() => response({ items: [readyTask], nextCursor: "not requested" }));
    expect(await f.run(["ready", "--parent", goalId, "--allow-agents", "true", "--limit", "1", "--tag", tagB, "--tag", tagA, "--tag-match", "any", "--json"])).toBe(0);
    expect(f.calls()).toHaveLength(1);
    expect(Object.fromEntries(f.calls()[0]!.url.searchParams)).toEqual({ parentId: goalId, allowAgents: "true", ready: "true", limit: "1", tagIds: `${tagA},${tagB}`, tagMatch: "any" });
    expect(JSON.parse(f.context.stdout.mock.calls[0]![0]).map((item: any) => item.id)).toEqual([taskId]);
  });

  it("sends canonical tag arrays and all other filters across search pages", async () => {
    const first = searchPage("first-page"), next = searchPage("next-page");
    const f = fixture((_url, init) => response(JSON.parse(String(init.body)).cursor ? next : first));
    expect(await f.run(["search", "cache", "--type", "task", "--parent", goalId, "--status", "todo", "--assigned-to", "me", "--tag", tagB.toUpperCase(), "--tag", tagA, "--tag", tagB, "--tag-match", "any", "--json"])).toBe(0);
    const bodies = f.calls().map(({ init }) => JSON.parse(String(init.body)));
    expect(bodies).toEqual([
      { query: "cache", type: "task", parentId: goalId, assignedTo: "me", status: "todo", tagIds: [tagA, tagB], tagMatch: "any", limit: 100 },
      { query: "cache", type: "task", parentId: goalId, assignedTo: "me", status: "todo", tagIds: [tagA, tagB], tagMatch: "any", limit: 100, cursor: first.nextCursor },
    ]);
    expect(JSON.parse(f.context.stdout.mock.calls[0]![0]).map((item: any) => item.id)).toEqual([first.items[0].id, next.items[0].id]);
  });

  it.each(["list", "ready", "search"])('%s sends untagged and preserves omitted tag conditions', async name => {
    const f = fixture(() => response(name === "search" ? { projectId, total: 0, items: [], nextCursor: null } : page([], null)));
    const base = name === "search" ? [name, "text"] : [name];
    expect(await f.run([...base, "--untagged", "--json"])).toBe(0);
    const first = f.calls()[0]!;
    if (name === "search") expect(JSON.parse(String(first.init.body))).toMatchObject({ query: "text", untagged: true });
    else expect(first.url.searchParams.get("untagged")).toBe("true");
    f.fetcher.mockClear(); f.context.stdout.mockClear();
    expect(await f.run([...base, "--json"])).toBe(0);
    const second = f.calls()[0]!;
    const fields = name === "search" ? JSON.parse(String(second.init.body)) : Object.fromEntries(second.url.searchParams);
    expect(fields).not.toHaveProperty("tagIds"); expect(fields).not.toHaveProperty("tagMatch"); expect(fields).not.toHaveProperty("untagged");
  });

  it.each(["list", "ready", "search"])('%s accepts an explicit match mode without tag IDs', async name => {
    const f = fixture(() => response(name === "search" ? { projectId, total: 0, items: [], nextCursor: null } : page([], null)));
    expect(await f.run([...(name === "search" ? [name, "text"] : [name]), "--tag-match", "any", "--json"])).toBe(0);
    const call = f.calls()[0]!;
    const fields = name === "search" ? JSON.parse(String(call.init.body)) : Object.fromEntries(call.url.searchParams);
    expect(fields).toHaveProperty("tagMatch", "any");
    expect(fields).not.toHaveProperty("tagIds"); expect(fields).not.toHaveProperty("untagged");
  });

  it.each(["list", "search"])('%s with tag filters rejects principal drift between pages', async name => {
    const first = name === "search" ? searchPage("first-page") : page([readyTask], "next");
    const second = name === "search" ? searchPage("next-page") : page([{ ...readyTask, id: secondId }], null);
    let calls = 0;
    const f = fixture(() => response(++calls === 1 ? first : second, 200, calls === 1 ? actorId : goalId));
    expect(await f.run([...(name === "search" ? [name, "text"] : [name]), "--assigned-to", "me", "--tag", tagA, "--json"])).toBe(1);
    expect(f.calls()).toHaveLength(2); expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stderr).toHaveBeenCalled();
  });

  it.each(["list", "ready", "search"])('%s rejects invalid and conflicting options before dispatch', async name => {
    const base = name === "search" ? [name, "text"] : [name];
    for (const flags of [["--tag", "invalid"], ["--tag", tagA, "--untagged"], ["--tag-match", "none"]]) {
      const f = fixture(() => { throw new Error("Unexpected request"); });
      expect(await f.run([...base, ...flags])).toBe(2);
      expect(f.fetcher).not.toHaveBeenCalled(); expect(f.context.stdout).not.toHaveBeenCalled();
    }
  });

  it.each([["--tag", tagA], ["--tag-match", "any"], ["--untagged"]])("rejects grouped chains with tag flags %s", async (...flags) => {
    const f = fixture(() => { throw new Error("Unexpected request"); });
    expect(await f.run(["list", "--status", "in_progress", "--group-by", "chain", ...flags])).toBe(2);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(["list", "ready", "search"])('%s reports invalid_tag_filter without output or replay', async name => {
    const f = fixture(() => response({ error: { code: "invalid_tag_filter", message: "unknown or cross-project tag", requestId: "bad-filter" } }, 400));
    expect(await f.run([...(name === "search" ? [name, "text"] : [name]), "--tag", tagA, "--json"])).toBe(1);
    expect(f.calls()).toHaveLength(1); expect(f.context.stdout).not.toHaveBeenCalled();
    expect(f.context.stderr.mock.calls[0]![0]).toContain("invalid_tag_filter");
  });

  it.each(["list", "search"])('%s with tag filters suppresses a failed later page', async name => {
    const first = name === "search" ? searchPage("first-page") : page([{ ...task, tags: [{ id: tagA, name: "A" }] }], "next");
    let calls = 0;
    const f = fixture(() => ++calls === 1 ? response(first) : response({ error: { code: name === "search" ? "search_changed" : "forbidden", message: "later page failed", requestId: "later" } }, name === "search" ? 409 : 403));
    expect(await f.run([...(name === "search" ? [name, "text"] : [name]), "--tag", tagA, "--json"])).toBe(1);
    expect(f.calls()).toHaveLength(2); expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stderr.mock.calls[0]![0]).toContain(name === "search" ? "search_changed" : "forbidden");
  });

  it("exposes each filter in help and shell completion", async () => {
    const f = fixture(() => { throw new Error("Unexpected request"); });
    const taskCommand = commandTree.commands!.find(({ name }) => name === "task")!;
    for (const name of ["list", "ready", "search"]) {
      await runTaskCommand([name, "--help"], f.context, f.dependencies);
      const command = taskCommand.commands!.find(item => item.name === name)!;
      for (const flag of ["--tag", "--tag-match", "--untagged"]) {
        expect(f.context.stdout.mock.lastCall![0]).toContain(flag);
        expect(renderBashCompletion(command)).toContain(flag);
        expect(renderZshCompletion(command)).toContain(flag);
      }
    }
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
