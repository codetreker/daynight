import { afterEach, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import { runCli } from "../../../src/cli/application.js";
import { runTaskCommand, type TaskCommandDependencies } from "../../../src/commands/task/command.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const time = "2026-11-03T10:11:12Z";
const project = { id: projectId, name: "Project", repoUrl: "git@example.test:org/repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "cccccccc-3333-4333-8333-333333333333", version: 1n }, createdAt: time, updatedAt: time };
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
  const run = (args: string[]) => runCli(["task", ...args, "--project", projectId], context, [{ name: "task", description: "Manage tasks", load: async () => ({ run: (rest, current) => runTaskCommand(rest, current, dependencies) }) }]);
  return { context, run };
};
const json = (body: unknown) => new Response(stringifyApiJson(body), { headers: { "content-type": "application/json" } });

it("keeps malformed task JSON out of stdout at the CLI boundary", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(project)).mockResolvedValueOnce(new Response("{", { headers: { "content-type": "application/json" } }));
  const f = fixture(fetch);
  expect(await f.run(["show", taskId, "--json"])).toBe(1);
  expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
  expect(f.context.stderr.mock.calls.map(([text]) => text).join("")).toContain("protocol");
  expect(fetch.mock.calls.map(([, options]) => options!.method)).toEqual(["GET", "GET"]);
});

it("forwards multiline property input byte for byte and prints the confirmed value", async () => {
  const entries = [{ url: " arbitrary\r\nURL ", title: " 标题\n\r\u001b[2J " }, { url: "", title: "" }];
  const valueText = `${JSON.stringify(entries, null, 2)}\r\n`;
  const resource = { projectId, taskId, version: 2n, properties: { pullRequests: entries } };
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(resource));
  const f = fixture(fetch);
  expect(await f.run(["set-property", taskId, "pullRequests", valueText, "--if-version", "1"])).toBe(0);
  expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]![1]!.method).toBe("PUT");
  expect(parseApiJson(String(fetch.mock.calls[0]![1]!.body))).toEqual({ version: 1n, valueText });
  const output = f.context.stdout.mock.calls[0]![0];
  expect(output).toContain('"url":" arbitrary\\r\\nURL ","title":" 标题\\n\\r\\u001b[2J "');
  expect(output).not.toContain("\u001b"); expect(f.context.stderr).not.toHaveBeenCalled();
});

it("keeps completed claim history on a maximum-version completion no-op", async () => {
  const claimId = "dddddddd-4444-4444-8444-444444444444", workerId = "eeeeeeee-5555-4555-8555-555555555555";
  const maximum = 9_223_372_036_854_775_807n;
  const worker = { claimId, state: "completed", userId: projectId, workerId, machine: { id: workerId, name: "Build machine" }, platform: "linux", agent: "codex", agentControlMode: "herdr", worktreeId: workerId, phase: "executing", herdr: { session: "w", workspaceId: "task-workspace", paneId: "task-pane" }, nativeSessionId: "original-native-session", claimedAt: time };
  const completed = { type: "task", parentId: null, id: taskId, projectId, title: "Task", description: "Preserved", tags: [], properties: { worker, pullRequests: [{ url: "opaque\0delivery", title: "Worker evidence" }] }, status: "done", allowAgents: false, assignedTo: null, requiredPlatform: null, version: maximum, ready: false, dependsOn: [], externalDependsOn: [], blockedBy: [], startedAt: time, completedAt: time, cancelledAt: null, createdAt: time, updatedAt: time };
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => new URL(String(url)).pathname === `/api/v1/projects/${projectId}` ? json(project) : json(completed));
  const f = fixture(fetch);
  expect(await f.run(["set-status", taskId, "done", "--claim-id", claimId, "--if-version", String(maximum)])).toBe(0);
  const output = f.context.stdout.mock.calls[0]![0];
  for (const value of [`Status: done\n`, `Version: ${maximum}\n`, claimId, workerId, "original-native-session", '"state":"completed"', "opaque\\u0000delivery"]) expect(output).toContain(value);
  expect(fetch.mock.calls.map(([, options]) => options!.method)).toEqual(["GET", "GET", "PUT"]);
  expect(parseApiJson(String(fetch.mock.calls[2]![1]!.body))).toEqual({ version: maximum, status: "done", claimId });
  expect(f.context.stderr).not.toHaveBeenCalled();
});
