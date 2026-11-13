import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient, createOperation } from "../../../src/api/index.js";
import { runCli } from "../../../src/cli/application.js";
import { runTaskCommand, type TaskCommandDependencies } from "../../../src/commands/task/command.js";

const read = (name: string): any => JSON.parse(readFileSync(new URL(`../../fixtures/task-search/${name}.json`, import.meta.url), "utf8"));
const first = read("first-page"), next = read("next-page"), projectId = first.projectId as string;
const principal = "459052e2-186f-4a52-8a58-55425ce43631";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "Daynight-User-ID": principal } });
const operations: ReturnType<typeof createOperation>[] = [];
afterEach(() => { operations.splice(0).forEach(operation => operation.dispose()); });

function fixture(fetch: typeof globalThis.fetch, signal?: AbortSignal) {
  const operation = createOperation(signal === undefined ? {} : { signal }); operations.push(operation);
  const api = createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch });
  const context = { version: "0.0.0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected config read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); }, stdout: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_bytes: Uint8Array) => {}), stderr: vi.fn<(text: string) => void>() };
  const dependencies = { resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>(), runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
    const result = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
    operation.check(); if (typeof result === "string") current.stdout(result); else if (result !== undefined) current.stdout(result.output);
  }) };
  const run = (args: string[]) => runCli(["task", "search", ...args], context, [{ name: "task", description: "Manage tasks", load: async () => ({ run: (rest, current) => runTaskCommand(rest, current, dependencies) }) }]);
  return { context, run };
}

it("prints ordered projected search JSON only after all pages, preserving the query and filters", async () => {
  const page = (value: any) => ({ ...value, items: value.items.map((item: any) => ({ ...item, status: "done", assignedTo: principal })) });
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(page(first))).mockResolvedValueOnce(response(page(next)));
  const f = fixture(fetch), query = '  title:"缓存 😀"  ';
  expect(await f.run([query, "--project", projectId, "--status", "done", "--assigned-to", "me", "--ready", "--allow-agents", "false", "--compatible-platform", "linux", "--json"])).toBe(0);
  const output = JSON.parse(f.context.stdout.mock.calls[0]![0]);
  expect(output.map((item: any) => item.id)).toEqual([first.items[0].id, next.items[0].id]);
  expect(Object.keys(output[0])).toEqual(["id", "type", "parentId", "projectId", "title", "status", "cancelledAt", "tags", "context", "match"]);
  expect(output.map(({ type, parentId }: any) => ({ type, parentId }))).toEqual([{ type: "task", parentId: first.items[0].context.taskId }, { type: "task", parentId: null }]);
  expect(f.context.stderr).not.toHaveBeenCalled();
  const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init!.body)));
  expect(bodies[0]).toEqual({ query, status: "done", assignedTo: "me", ready: true, allowAgents: false, compatiblePlatform: "linux", limit: 100 });
  expect(bodies[1]).toEqual({ ...bodies[0], cursor: first.nextCursor });
  expect(fetch.mock.calls.map(([, init]) => new Headers(init!.headers).get("authorization"))).toEqual(["Bearer fixture-token", "Bearer fixture-token"]);
});

it.each(["none", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"])("passes type and parent %s on every search page", async parent => {
  const parentId = parent === "none" ? null : parent.toLowerCase();
  const page = (value: any) => ({ ...value, items: value.items.map((item: any) => ({ ...item, type: "task", parentId, context: parentId === null ? null : { taskId: parentId, title: "Actual Goal" } })) });
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(page(first))).mockResolvedValueOnce(response(page(next)));
  const f = fixture(fetch);
  expect(await f.run(["cache", "--project", projectId, "--type", "task", "--parent", parent, "--json"])).toBe(0);
  const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init!.body)));
  expect(bodies).toEqual([
    { query: "cache", type: "task", parentId, limit: 100 },
    { query: "cache", type: "task", parentId, limit: 100, cursor: first.nextCursor },
  ]);
  const output = JSON.parse(f.context.stdout.mock.calls[0]![0]);
  expect(output.map((item: any) => item.context)).toEqual([parentId, parentId].map(id => id === null ? null : { taskId: id, title: "Actual Goal" }));
});

it("rejects malformed parent before search dispatch", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const f = fixture(fetch);
  expect(await f.run(["cache", "--project", projectId, "--parent", "invalid"])).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
});

it("escapes terminal control characters while retaining the complete JSON title", async () => {
  const title = "完整标题\u001b[31m\n尾";
  const item = { ...first.items[0], title, context: { ...first.items[0].context, title: "Goal\t标题" }, futureField: "wire-secret" };
  const page = { ...first, total: 1, items: [item], nextCursor: null };
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response(page));
  const f = fixture(fetch);
  expect(await f.run(["--project", projectId, "--", "-literal"])).toBe(0);
  const text = f.context.stdout.mock.calls[0]![0];
  expect(text).toContain("完整标题\\u001b[31m\\n尾"); expect(text).toContain("Goal\\t标题"); expect(text).not.toMatch(/wire-secret|\u001b/);
  f.context.stdout.mockClear();
  expect(await f.run(["x", "--project", projectId, "--json"])).toBe(0);
  expect(JSON.parse(f.context.stdout.mock.calls[0]![0])[0].title).toBe(title);
  expect(f.context.stdout.mock.calls[0]![0]).not.toContain("wire-secret");
});

it.each(["changed", "malformed", "disconnect"] as const)("reports a second-page %s failure without partial output or replay", async mode => {
  const second = mode === "changed" ? response(read("search-changed"), 409) : response({ ...next, projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(first));
  if (mode === "disconnect") fetch.mockRejectedValueOnce(new Error("connection lost")); else fetch.mockResolvedValueOnce(second);
  const f = fixture(fetch);
  expect(await f.run(["cache", "--project", projectId, "--json"])).toBe(1);
  expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stderr).toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(2);
});

it("reports invalid search syntax and rejects blank input before dispatch", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(read("invalid-expression"), 400));
  const f = fixture(fetch);
  expect(await f.run(["缓存 AND (", "--project", projectId, "--json"])).toBe(2);
  expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stderr.mock.calls[0]![0]).toContain("unclosed_group");
  fetch.mockClear(); f.context.stderr.mockClear();
  expect(await f.run([" \t ", "--project", projectId])).toBe(2); expect(fetch).not.toHaveBeenCalled(); expect(f.context.stdout).not.toHaveBeenCalled();
});

it("prints explicit empty results in both formats", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response(read("empty-page")));
  const f = fixture(fetch);
  expect(await f.run(["x", "--project", projectId, "--json"])).toBe(0);
  expect(f.context.stdout.mock.calls[0]![0]).toBe("[]\n");
  f.context.stdout.mockClear();
  expect(await f.run(["x", "--project", projectId])).toBe(0);
  expect(f.context.stdout.mock.calls[0]![0]).toBe(`Project: ${projectId}\nNo matching tasks.\n`);
});

it("cancels a pending second page without output or replay", async () => {
  const abort = new AbortController();
  let notify: () => void = () => {};
  const started = new Promise<void>(resolve => { notify = resolve; });
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(first)).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); notify();
  }));
  const f = fixture(fetch, abort.signal);
  const pending = f.run(["x", "--project", projectId, "--json"]);
  await started; abort.abort();
  expect(await pending).toBe(1); expect(fetch).toHaveBeenCalledTimes(2);
  expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stderr).toHaveBeenCalled();
});
