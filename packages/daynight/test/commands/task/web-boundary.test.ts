import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import type { Project, Task } from "../../../src/api/types.js";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import { withTaskObservation } from "../../fixtures/task-observation.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const dependentId = "cccccccc-3333-4333-8333-333333333333";
const time = "2026-10-20T00:00:00.123456Z";
const project: Project = { id: projectId, name: "Project", repoUrl: "git@example.test:org/repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: dependentId, version: 1n }, createdAt: time, updatedAt: time };
const task: Task = { type: "task", parentId: null, id: taskId, projectId, title: "Task", description: "", tags: [], properties: { pullRequests: [] }, status: "todo", allowAgents: false, assignedTo: null, requiredPlatform: null, version: 9_007_199_254_740_993n, ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time };
const json = (body: unknown, status = 200) => new Response(stringifyApiJson(body), { status, headers: { "Content-Type": "application/json" } });
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

const fixture = (respond: (url: string, init: RequestInit) => Response) => {
  const operation = createOperation(); cleanups.push(() => operation.dispose());
  const context = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected config read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); },
    stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_bytes: Uint8Array) => {}),
  } satisfies CliContext;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input); const options = init!;
    if (url.endsWith(`/api/v1/projects/${projectId}`)) return json(project);
    return respond(url, options);
  });
  const api = createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch });
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>(),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
      operation.check();
      if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
    }),
  };
  const run = (args: readonly string[]) => runCli(["task", ...args], context, [{ name: "task", description: "Manage tasks", load: async () => ({ run: (rest, current) => runTaskCommand(rest, current, dependencies) }) }]);
  return { context, fetch, run };
};

describe("task CLI protocol outcomes", () => {
  it.each([
    { args: ["show", taskId, "--json"], status: 401, code: "unauthenticated" },
    { args: ["attachment", "read", taskId, "shared/data.bin"], status: 401, code: "unauthenticated" },
    { args: ["attachment", "read", taskId, "shared/data.bin"], status: 404, code: "not_found" },
  ])("reports $code without output or replay for $args", async ({ args, status, code }) => {
    const f = fixture(() => json({ error: { code, message: "Resource unavailable.", requestId: "refused-request" } }, status));
    expect(await f.run([...args, "--project", projectId])).toBe(1);
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
    const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
    expect(diagnostic).toContain(code); expect(diagnostic).toContain("refused-request");
    if (status === 401) expect(diagnostic).toContain("daynight login");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of f.fetch.mock.calls) expect(new Headers(init!.headers).get("Authorization")).toBe("Bearer fixture-token");
  });

  it("reports a dependency refusal and rejects an invalid status before dispatch", async () => {
    const f = fixture((_url, init) => init.method === "GET" ? json(task) : json({ error: { code: "dependency_unsatisfied", message: "Dependent task is active.", requestId: "dependency-refused", details: { taskIds: [dependentId] } } }, 409));
    expect(await f.run(["set-status", taskId, "todo", "--if-version", "9007199254740993", "--project", projectId])).toBe(1);
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stderr.mock.calls[0]![0]).toContain("dependency_unsatisfied");
    expect(f.context.stderr.mock.calls[0]![0]).toContain(dependentId);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.fetch.mock.calls[2]![1]!.body).toBe('{"version":9007199254740993,"status":"todo"}');
    f.context.stderr.mockClear(); f.fetch.mockClear();
    expect(await f.run(["set-status", taskId, "unknown", "--project", projectId])).toBe(2);
    expect(f.context.stderr.mock.calls[0]![0]).toContain('Unknown status "unknown"');
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });

  it("writes Markdown unchanged and reads it back through JSON", async () => {
    const markdown = "# 中文\n\n  indented\r\n```ts\nconst x = '<>&';\n```\n";
    let stored = task;
    const f = fixture((url, init) => {
      if (init.method === "PATCH") {
        const body = parseApiJson(String(init.body)) as { version: bigint; description: string };
        expect(body).toEqual({ version: task.version, description: markdown });
        stored = { ...task, description: body.description, version: task.version + 1n };
      }
      return json(new URL(url).searchParams.get("include") === "session" ? withTaskObservation(stored) : stored);
    });
    expect(await f.run(["update", taskId, "--if-version", String(task.version), "--description", markdown, "--project", projectId])).toBe(0);
    expect(f.context.stderr).not.toHaveBeenCalled();
    f.context.stdout.mockClear();
    expect(await f.run(["show", taskId, "--json", "--project", projectId])).toBe(0);
    expect((parseApiJson(f.context.stdout.mock.calls[0]![0]) as Task).description).toBe(markdown);
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["GET", "PATCH", "GET", "GET"]);
  });
});
