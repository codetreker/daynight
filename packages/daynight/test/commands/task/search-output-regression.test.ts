import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient, createOperation } from "../../../src/api/index.js";
import { runCli } from "../../../src/cli/application.js";
import { runTaskCommand, type TaskCommandDependencies } from "../../../src/commands/task/command.js";

const read = (name: string): any => JSON.parse(readFileSync(new URL(`../../fixtures/task-search/${name}.json`, import.meta.url), "utf8"));
const first = read("first-page"), projectId = first.projectId as string;
const principal = "459052e2-186f-4a52-8a58-55425ce43631";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "Daynight-User-ID": principal } });
const operations: ReturnType<typeof createOperation>[] = [];
afterEach(() => { operations.splice(0).forEach(operation => operation.dispose()); });
const fixture = (fetch: typeof globalThis.fetch) => {
  const operation = createOperation(); operations.push(operation);
  const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected config read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); }, stdout: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_value: Uint8Array) => {}), stderr: vi.fn<(text: string) => void>() };
  const dependencies = { resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>(), runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
    const output = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
    operation.check(); if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
  }) };
  const run = (args: string[]) => runCli(["task", "search", "--project", projectId, ...args], context, [{ name: "task", description: "Manage tasks", load: async () => ({ run: (rest, current) => runTaskCommand(rest, current, dependencies) }) }]);
  return { context, run };
};

it("keeps a long search title and negative match while excluding private nested fields", async () => {
  const title = `${"完整标题".repeat(80)}\u001b[31m\n尾`;
  const item = { ...first.items[0], title, futureField: "wire-secret", context: { ...first.items[0].context, title: "Goal\t标题", privateField: "context-secret" }, match: { fields: [], descriptionSnippet: null, privateField: "match-secret" } };
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response({ ...first, total: 1, items: [item], nextCursor: null }));
  const f = fixture(fetch);
  expect(await f.run(["--", "-literal"])).toBe(0);
  expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ query: "-literal", limit: 100 });
  const text = f.context.stdout.mock.calls[0]![0];
  expect(text).toContain(`${"完整标题".repeat(80)}\\u001b[31m\\n尾`);
  expect(text).toContain("Goal\\t标题"); expect(text).toContain("Match: negative condition");
  expect(text).not.toMatch(/Assigned to|Updated|wire-secret|context-secret|match-secret|\u001b/);
  f.context.stdout.mockClear();
  expect(await f.run(["x", "--json"])).toBe(0);
  const json = f.context.stdout.mock.calls[0]![0];
  expect(JSON.parse(json)[0].title).toBe(title);
  expect(json).not.toMatch(/assignedTo|updatedAt|wire-secret|context-secret|match-secret/);
});

it("prints the exact Unicode syntax position and rejects malformed error details", async () => {
  const malformed = read("invalid-expression"); delete malformed.error.details.length;
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(read("invalid-expression"), 400)).mockResolvedValueOnce(response(malformed, 400));
  const f = fixture(fetch);
  expect(await f.run(["缓存 AND (Worker", "--json"])).toBe(2);
  expect(f.context.stdout).not.toHaveBeenCalled();
  const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
  expect(diagnostic).toContain("unclosed_group"); expect(diagnostic).toContain("8");
  f.context.stderr.mockClear();
  expect(await f.run(["x", "--json"])).toBe(1);
  expect(f.context.stdout).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(2);
});

it("preserves search_changed on a failed second page without publishing the first", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(read("search-changed"), 409));
  const f = fixture(fetch);
  expect(await f.run(["x", "--json"])).toBe(1);
  expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
  expect(f.context.stderr.mock.calls.map(([text]) => text).join("")).toContain("search_changed");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual({ query: "x", limit: 100, cursor: first.nextCursor });
});

it("renders ID-only and mixed evidence, keeping JSON projection and server order", async () => {
  const idOnly = { ...first.items[0], match: { fields: ["id"], descriptionSnippet: null } };
  const mixed = { ...idOnly, id: "05d609a8-50e2-4aaf-a31d-82466dca2a36", match: { fields: ["id", "title", "description"], descriptionSnippet: "match\u001b[31m" } };
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response({ ...first, total: 2, items: [idOnly, mixed], nextCursor: null }));
  const f = fixture(fetch);
  expect(await f.run(["id:05d609a8"])).toBe(0);
  const text = f.context.stdout.mock.calls[0]![0];
  expect(text).toContain("Match: id\n");
  expect(text).toContain("Match: id, title, description\nSnippet: match\\u001b[31m");
  expect(text.match(/Snippet:/g)).toHaveLength(1);
  f.context.stdout.mockClear();
  expect(await f.run(["id:05d609a8", "--json"])).toBe(0);
  const output = f.context.stdout.mock.calls[0]![0];
  expect(output.endsWith("\n")).toBe(true);
  expect(JSON.parse(output)).toEqual([idOnly, mixed].map(({ id, type, parentId, projectId, title, status, cancelledAt, tags, context, match }) => ({ id, type, parentId, projectId, title, status, cancelledAt, tags, context, match })));
});
