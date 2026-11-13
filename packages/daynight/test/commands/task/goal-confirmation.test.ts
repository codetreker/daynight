import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import { runCli } from "../../../src/cli/application.js";
import type { CliPrompt } from "../../../src/cli/prompts.js";
import { runTaskCommand, type TaskCommandDependencies } from "../../../src/commands/task/command.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const time = "2026-10-20T00:00:00Z";
const project = { id: projectId, name: "Project", repoUrl: "git@example.test:org/repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: taskId, version: 1n }, createdAt: time, updatedAt: time };
const base = { id: taskId, projectId, type: "goal", parentId: null, title: "Goal", description: "", tags: [], properties: {}, status: "todo", allowAgents: false, assignedTo: null, requiredPlatform: null, version: 9_007_199_254_740_993n, ready: false, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, progress: { total: 0, done: 0, cancelled: 0, unfinished: 0 } };
const json = (body: unknown, status = 200) => new Response(stringifyApiJson(body), { status, headers: { "content-type": "application/json", "Daynight-User-ID": projectId } });
const operations: ReturnType<typeof createOperation>[] = [];
afterEach(() => { operations.splice(0).forEach(operation => operation.dispose()); });

const fixture = (options: { answer?: string; interactive?: boolean; task?: object; refusal?: "version_conflict" | "invalid_input"; unknown?: boolean } = {}) => {
  const operation = createOperation(); operations.push(operation);
  const ask = vi.fn(async () => options.answer ?? "n");
  const prompt = { isInteractive: options.interactive ?? false, ask, close: vi.fn(), select: vi.fn(), selectMany: vi.fn() } as unknown as CliPrompt;
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => "unused", workingDirectory: () => "unused", stdout: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_value: Uint8Array) => {}), stderr: vi.fn<(text: string) => void>(), prompt };
  const record = options.task ?? base;
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === `/api/v1/projects/${projectId}`) return json(project);
    if (init!.method === "GET") return json(record);
    if (options.unknown) throw new Error("connection lost");
    if (options.refusal) return json({ error: { code: options.refusal, message: "Refused.", requestId: "refused" } }, 409);
    if (init!.method === "DELETE") return new Response(null, { status: 204 });
    if (init!.method === "POST") {
      const request = parseApiJson(String(init!.body)) as { status: string };
      return json({ ...record, assignedTo: projectId, status: request.status, completedAt: request.status === "done" ? time : null, cancelledAt: request.status === "cancelled" ? time : null }, 201);
    }
    const request = parseApiJson(String(init!.body)) as { status: string; version: bigint };
    return json({ ...record, status: request.status, version: request.version, cancelledAt: request.status === "cancelled" ? time : null });
  });
  const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
  const dependencies = { resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>(), runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
    const output = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
    operation.check(); if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
  }) };
  const run = (args: string[]) => runCli(["task", ...args, "--project", projectId], context, [{ name: "task", description: "Manage tasks", load: async () => ({ run: (rest, current) => runTaskCommand(rest, current, dependencies) }) }]);
  return { context, fetch, ask, run };
};

describe("Goal impact confirmation", () => {
  it.each(["done", "cancelled"])("requires confirmation before creating a %s Goal", async status => {
    const f = fixture();
    expect(await f.run(["create", "--type", "goal", "--title", "Goal", "--status", status])).toBe(1);
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["GET"]);
    const warning = f.context.stderr.mock.calls.map(([text]) => text).join("");
    expect(warning).toContain("--force"); expect(warning).toContain("new automatic claims");
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each(["no", "yes"])("honors interactive creation answer %s", async answer => {
    const f = fixture({ interactive: true, answer });
    expect(await f.run(["create", "--type", "goal", "--title", "Goal", "--status", "done"])).toBe(answer === "yes" ? 0 : 1);
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(answer === "yes" ? ["GET", "POST"] : ["GET"]);
    expect(f.ask).toHaveBeenCalledOnce(); expect(f.context.prompt.close).toHaveBeenCalledOnce();
    if (answer === "yes") expect(parseApiJson(String(f.fetch.mock.calls[1]![1]!.body))).toEqual({ title: "Goal", type: "goal", status: "done" });
    else expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each(["done", "cancelled"])("force submits the %s Goal exactly once and propagates refusal", async status => {
    const f = fixture({ refusal: "invalid_input" });
    expect(await f.run(["create", "--type", "goal", "--title", "Goal", "--status", status, "--force"])).toBe(1);
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["GET", "POST"]);
    expect(parseApiJson(String(f.fetch.mock.calls[1]![1]!.body))).toEqual({ title: "Goal", type: "goal", status });
    expect(f.ask).not.toHaveBeenCalled();
    expect(f.context.stderr.mock.calls.map(([text]) => text).join("")).toContain("invalid_input");
  });

  it("force successfully creates a terminal Goal without prompting", async () => {
    const f = fixture();
    expect(await f.run(["create", "--type", "goal", "--title", "Goal", "--status", "cancelled", "--force"])).toBe(0);
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["GET", "POST"]);
    expect(f.ask).not.toHaveBeenCalled(); expect(f.context.stdout.mock.calls[0]![0]).toContain("Status: cancelled");
  });

  it.each([["set-status", taskId, "done"], ["set-status", taskId, "cancelled"], ["delete", taskId]])("refuses noninteractive %s before the write", async (...args) => {
    const f = fixture();
    expect(await f.run([...args, "--if-version", "1"])).toBe(1);
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["GET", "GET"]);
    const warning = f.context.stderr.mock.calls.map(([text]) => text).join("");
    expect(warning).toContain(`Goal ${taskId}`); expect(warning).toContain("--force");
    expect(warning).toContain(args[0] === "delete" ? "invisible" : "new automatic claims");
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each([["set-status", taskId, "done"], ["delete", taskId]])("cancels interactive %s without a mutation", async (...args) => {
    const f = fixture({ interactive: true, answer: "no" });
    expect(await f.run(args)).toBe(1);
    expect(f.ask).toHaveBeenCalledOnce(); expect(f.context.prompt.close).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["GET", "GET"]);
    expect(f.context.stderr.mock.calls.map(([text]) => text).join("")).toContain("cancelled");
  });

  it.each([["set-status", taskId, "cancelled"], ["delete", taskId]])("submits interactive %s with the original exact version", async (...args) => {
    const f = fixture({ interactive: true, answer: "yes" });
    expect(await f.run([...args, "--if-version", "9223372036854775807"])).toBe(0);
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["GET", "GET", args[0] === "delete" ? "DELETE" : "PUT"]);
    expect(String(f.fetch.mock.calls[2]![1]!.body)).toContain('"version":9223372036854775807');
    expect(f.ask).toHaveBeenCalledOnce();
  });

  it.each([["set-status", taskId, "done"], ["delete", taskId]])("force skips only the %s prompt and preserves server refusal", async (...args) => {
    const f = fixture({ refusal: "version_conflict" });
    expect(await f.run([...args, "--force", "--if-version", "1"])).toBe(1);
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["GET", "GET", args[0] === "delete" ? "DELETE" : "PUT"]);
    expect(f.ask).not.toHaveBeenCalled(); expect(f.context.stderr.mock.calls.map(([text]) => text).join("")).toContain("version_conflict");
    expect(String(f.fetch.mock.calls[2]![1]!.body)).toContain('"version":1');
  });

  it("does not bypass business refusal with force", async () => {
    const f = fixture({ refusal: "invalid_input" });
    expect(await f.run(["delete", taskId, "--remove-depends", "--force", "--if-version", "1"])).toBe(1);
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["GET", "GET", "DELETE"]);
    expect(String(f.fetch.mock.calls[2]![1]!.body)).toContain('"removeDepends":true');
    expect(f.context.stderr.mock.calls.map(([text]) => text).join("")).toContain("invalid_input");
  });

  it("uses the observed version for Goal writes and does not retry unknown outcomes", async () => {
    const f = fixture({ unknown: true });
    expect(await f.run(["delete", taskId, "--force"])).toBe(1);
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["GET", "GET", "DELETE"]);
    expect(String(f.fetch.mock.calls[2]![1]!.body)).toContain('"version":9007199254740993');
  });

  it("does not prompt for ordinary Tasks or nonterminal Goal statuses", async () => {
    const { progress: _progress, ...common } = base;
    const f = fixture({ task: { ...common, type: "task", ready: true } });
    expect(await f.run(["delete", taskId, "--if-version", "1"])).toBe(0);
    expect(f.ask).not.toHaveBeenCalled(); expect(f.context.stderr).not.toHaveBeenCalled();
    const g = fixture();
    expect(await g.run(["set-status", taskId, "in_progress", "--if-version", "1"])).toBe(0);
    expect(g.ask).not.toHaveBeenCalled(); expect(g.context.stderr).not.toHaveBeenCalled();
  });

  it("refuses a response with the wrong identity before the write even with force", async () => {
    const f = fixture({ task: { ...base, id: projectId } });
    expect(await f.run(["delete", taskId, "--force", "--if-version", "1"])).toBe(1);
    expect(f.fetch.mock.calls.map(([, init]) => init!.method)).toEqual(["GET", "GET"]);
  });
});
