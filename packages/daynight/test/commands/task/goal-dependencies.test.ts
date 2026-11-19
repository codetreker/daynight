import { describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation } from "../../../src/api/index.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";

const project = "11111111-1111-4111-8111-111111111111", goal = "22222222-2222-4222-8222-222222222222";
const targetProject = "33333333-3333-4333-8333-333333333333", targetGoal = "44444444-4444-4444-8444-444444444444", edge = "55555555-5555-4555-8555-555555555555";
const actor = "66666666-6666-4666-8666-666666666666", revision = "9007199254740993";
const urlPath = `/api/v1/projects/${project}/tasks/${goal}/goal-dependencies`;
const snapshot = { goalId: goal, canEdit: true, revision, completionBlocked: true, prerequisites: [{ edgeId: edge, target: null }], successors: [], nextCursor: null };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "Daynight-User-ID": actor } });
const setup = (handler: (url: URL, init: RequestInit) => Response | Promise<Response>) => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => handler(new URL(String(url)), init ?? {}));
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => "unused", workingDirectory: () => { throw new Error("unexpected cwd"); }, stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async () => {}) };
  const runServerCommand: TaskCommandDependencies["runServerCommand"] = async (ctx, callback) => {
    const operation = createOperation();
    try {
      const serverUrl = "https://server.example", api = createApiClient({ serverUrl, serverToken: "fixture-token", operation, fetch: fetcher });
      const output = await callback({ api, operation, serverUrl, serverConfiguration: { serverUrl } });
      if (typeof output === "string") ctx.stdout(output); else if (output !== undefined) ctx.stdout(output.output);
    } finally { operation.dispose(); }
  };
  const deps: TaskCommandDependencies = { runServerCommand, resolveProject: vi.fn().mockRejectedValue(new Error("unexpected project resolution")) };
  return { context, fetcher, run: (args: string[]) => runTaskCommand(["goal-dependencies", ...args, "--project", project], context, deps), calls: () => fetcher.mock.calls.map(([url, init]) => ({ url: new URL(String(url)), init: init ?? {} })) };
};

describe("Goal dependency CLI", () => {
  it("shows one page with hidden editable edge and preserves cursor", async () => {
    const f = setup(() => response({ ...snapshot, successors: [{ projectId: targetProject, projectName: "Project", goalId: targetGoal, title: "Goal", status: "todo", kind: "external" }], nextCursor: "next" }));
    await f.run(["show", goal, "--limit", "1", "--cursor", "prior", "--json"]);
    expect(f.calls()[0]!.url.pathname).toBe(urlPath);
    expect(f.calls()[0]!.url.searchParams.toString()).toBe("limit=1&cursor=prior");
    expect(JSON.parse(f.context.stdout.mock.calls[0]![0])).toMatchObject({ revision, prerequisites: [{ edgeId: edge, target: null }], nextCursor: "next" });
  });
  it("renders a read-only projection without inventing edge IDs or revision", async () => {
    const f = setup(() => response({ goalId: goal, canEdit: false, completionBlocked: true, prerequisites: [{ target: null }], successors: [], nextCursor: null }));
    await f.run(["show", goal]);
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Hidden target");
    expect(f.context.stdout.mock.calls[0]![0]).not.toContain("Revision:");
  });
  it.each([
    { args: ["add", "--target", `${targetProject}/${targetGoal}`], body: { mode: "edit", add: [{ projectId: targetProject, goalId: targetGoal }] } },
    { args: ["remove", "--edge", edge], body: { mode: "edit", remove: [edge] } },
    { args: ["replace", "--edge", edge, "--target", `${targetProject}/${targetGoal}`], body: { mode: "replace", prerequisites: [{ projectId: targetProject, goalId: targetGoal }, { edgeId: edge }] } },
    { args: ["replace", "--clear"], body: { mode: "replace", prerequisites: [] } },
  ])("sends one exact-revision write for $args", async ({ args, body }) => {
    const f = setup((_url, init) => init.method === "GET" ? response(snapshot) : response({ goalId: goal, revision, changed: false }));
    await f.run([args[0]!, goal, ...args.slice(1), "--json"]);
    expect(f.calls().map(call => call.init.method)).toEqual(["GET", "PATCH"]);
    expect(f.calls().every(call => call.url.pathname === urlPath)).toBe(true);
    expect(JSON.parse(String(f.calls()[1]!.init.body))).toEqual({ ifRevision: revision, ...body });
    expect(JSON.parse(f.context.stdout.mock.calls[0]![0])).toEqual({ goalId: goal, revision, changed: false });
  });
  it("uses an explicit precise revision without reading", async () => {
    const f = setup(() => response({ goalId: goal, revision: "9007199254740994", changed: true }));
    await f.run(["remove", goal, "--edge", edge, "--if-revision", revision]);
    expect(f.calls()).toHaveLength(1);
    expect(JSON.parse(String(f.calls()[0]!.init.body)).ifRevision).toBe(revision);
  });
  it.each([["replace", goal], ["replace", goal, "--clear", "--edge", edge], ["add", goal], ["remove", goal], ["remove", goal, "--edge", edge, "--if-revision", "01"], ["remove", goal, "--edge", edge, "--if-revision", "9223372036854775808"]])("rejects unsafe input before network: %s", async (...args) => {
    const f = setup(() => { throw new Error("unexpected request"); });
    await expect(f.run(args)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("refuses an edit after a read-only response", async () => {
    const f = setup(() => response({ goalId: goal, canEdit: false, completionBlocked: true, prerequisites: [{ target: null }], successors: [], nextCursor: null }));
    await expect(f.run(["remove", goal, "--edge", edge])).rejects.toThrow("cannot be edited");
    expect(f.calls()).toHaveLength(1);
  });
  it.each([{ status: 409, code: "goal_dependency_revision_conflict" }, { status: 503, code: "write_outcome_unknown" }, { status: 404, code: "not_found" }])("does not retry a refused, unknown, or unavailable route ($status)", async ({ status, code }) => {
    const f = setup(() => response({ error: { code, message: "unavailable", requestId: "request" } }, status));
    await expect(f.run(["remove", goal, "--edge", edge, "--if-revision", revision])).rejects.toThrow(status === 503 ? /outcome is unconfirmed/ : status === 404 ? /relationship route may be unavailable/ : /goal_dependency_revision_conflict/);
    expect(f.calls()).toHaveLength(1);
  });
  it("propagates a permission refusal without retrying", async () => {
    const f = setup(() => response({ error: { code: "forbidden", message: "Forbidden", requestId: "request" } }, 403));
    await expect(f.run(["remove", goal, "--edge", edge, "--if-revision", revision])).rejects.toThrow(/forbidden/);
    expect(f.calls()).toHaveLength(1);
  });
  it("rejects malformed or inexact relationship revisions", async () => {
    const f = setup(() => response({ ...snapshot, revision: 9007199254740993 }));
    await expect(f.run(["show", goal])).rejects.toThrow(/Invalid server response/);
    expect(f.calls()).toHaveLength(1);
  });
  it("reports an old router's plain-text 404 as unavailable without retrying", async () => {
    const f = setup(() => new Response("404 page not found", { status: 404 }));
    await expect(f.run(["show", goal])).rejects.toThrow(/relationship route may be unavailable/);
    expect(f.calls()).toHaveLength(1);
  });
});
