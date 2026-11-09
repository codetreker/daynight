import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import type { Operation } from "../../../src/api/index.js";
import { runCli } from "../../../src/cli/application.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import { taskDefinition } from "../../../src/commands/task/definition.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { actorId, observedGraph, observation, project, projectId, sessionId, task, taskId, time, workPage } from "../../fixtures/task-observation.js";

const operations: Operation[] = [];
const fixture = (body: unknown) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stringifyApiJson(body), { headers: { "content-type": "application/json", "Daynight-User-ID": actorId } }));
  const operation = createOperation(); operations.push(operation);
  const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
  const stdout: string[] = [], stderr: string[] = [];
  const context = { version: "0.0.0", packageDirectory: "unused", homeDirectory: () => "unused", workingDirectory: () => "unused", stdout: (value: string) => { stdout.push(value); }, stderr: (value: string) => { stderr.push(value); }, stdoutBytes: async () => {} };
  const dependencies: TaskCommandDependencies = {
    resolveProject: async () => project,
    runServerCommand: async (current, command) => { const output = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } }); if (typeof output === "string") current.stdout(output); },
  };
  const run = (args: readonly string[]) => runCli(["task", ...args], context, [{ ...taskDefinition, load: async () => ({ run: (values, current) => runTaskCommand(values, current, dependencies) }) }]);
  return { run, fetch, stdout, stderr };
};
afterEach(() => { operations.splice(0).forEach(operation => operation.dispose()); });

describe("Task Session command observations", () => {
  it("keeps ordinary list JSON an array and attaches Session data without descriptions", async () => {
    const f = fixture({ items: [{ ...task, session: observation }], nextCursor: null, observedAt: time, partial: false });
    expect(await f.run(["list", "--json"])).toBe(0);
    expect(parseApiJson(f.stdout.join(""))).toEqual([{ ...task, description: undefined, session: observation }]);
    expect(f.stderr).toEqual([]);
    expect(new URL(String(f.fetch.mock.calls[0]![0])).searchParams.get("include")).toBe("session");
  });

  it("prints warning and ordinary send eligibility independently", async () => {
    const f = fixture({ ...task, session: observation });
    expect(await f.run(["show", taskId])).toBe(0);
    expect(f.stdout.join("")).toContain(`Session: ${sessionId}`);
    expect(f.stdout.join("")).toContain("warning (idle)");
    expect(f.stdout.join("")).toContain("allowed (start)");
    expect(f.stdout.join("")).toContain(observation.freshUntil);
    expect(f.stdout.join("")).toContain(`Native Session: ${observation.nativeSessionId}`);
    expect(f.stdout.join("")).toContain(`Generation: ${observation.executionGeneration}; connection epoch: ${observation.connectionEpoch}`);
    expect(f.stdout.join("")).toContain(`daynight task show ${taskId} --project ${projectId}`);
  });

  it("prints Task data before reporting an old-service partial result with exit 3", async () => {
    const f = fixture(task);
    expect(await f.run(["show", taskId, "--json"])).toBe(3);
    expect(parseApiJson(f.stdout.join(""))).toMatchObject({ id: taskId, session: { observation: "unsupported" } });
    expect(f.stderr.join("")).toMatch(/Upgrade|upgrade/);
  });

  it("reports unavailable observations as partial without dropping successful Task data", async () => {
    const f = fixture({ ...task, session: { ...observation, observation: "unavailable", error: { code: "unavailable", message: "Failed" }, send: { allowed: null, mode: null, reason: "unknown" } } });
    expect(await f.run(["show", taskId, "--json"])).toBe(3);
    expect(parseApiJson(f.stdout.join(""))).toMatchObject({ id: taskId, title: "Task", session: { observation: "unavailable" } });
  });

  it("reports an empty legacy list as unsupported with usable JSON and exit 3", async () => {
    const f = fixture({ items: [], nextCursor: null });
    expect(await f.run(["list", "--json"])).toBe(3);
    expect(parseApiJson(f.stdout.join(""))).toEqual([]);
    expect(f.stderr.join("")).toMatch(/Upgrade|upgrade/);
  });

  it("gets one grouped page with default me and prints target identities", async () => {
    const f = fixture(workPage);
    expect(await f.run(["list", "--group-by", "chain", "--status", "in_progress"])).toBe(0);
    expect(f.stdout.join("")).toContain(sessionId);
    expect(f.stdout.join("")).toContain("warning");
    const url = new URL(String(f.fetch.mock.calls[0]![0]));
    expect(url.pathname).toBe(`/api/v1/projects/${projectId}/task-work`);
    expect(url.searchParams.get("assignedTo")).toBe("me");
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("prints complete continuation commands while preserving the explicit assignee", async () => {
    const f = fixture({ ...workPage, nextCursor: "group+/=", groups: [{ ...workPage.groups[0], contributorCursor: "target+/=" }] });
    expect(await f.run(["list", "--group-by", "chain", "--status", "in_progress", "--assigned-to", actorId])).toBe(0);
    const command = `daynight task list --status in_progress --group-by chain --project ${projectId} --assigned-to ${actorId}`;
    expect(f.stdout.join("")).toContain(`${command} --cursor 'group+/='`);
    expect(f.stdout.join("")).toContain(`${command} --group-id ${workPage.groups[0].groupId} --targets-cursor 'target+/='`);
  });

  it.each([
    ["list", "--cursor", "next"], ["list", "--group-by", "unknown", "--status", "in_progress"],
    ["list", "--group-by", "chain"], ["list", "--group-by", "chain", "--status", "todo"],
    ["list", "--group-by", "chain", "--status", "in_progress", "--assigned-to", "unassigned"],
    ["list", "--group-by", "chain", "--status", "in_progress", "--group-id", taskId],
    ["list", "--group-by", "chain", "--status", "in_progress", "--limit", "51"],
  ].map(args => ({ args })))("rejects invalid grouped arguments without HTTP $args", async ({ args }) => {
    const f = fixture(workPage);
    expect(await f.run(args)).toBe(2);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.stdout).toEqual([]);
  });

  it("preserves depends-only's three-field output and never requests observations", async () => {
    const f = fixture(observedGraph);
    expect(await f.run(["graph", taskId, "--depends-only", "--json"])).toBe(0);
    expect(parseApiJson(f.stdout.join(""))).toEqual([{ id: taskId, dependsOn: [], externalDependsOn: [] }]);
    expect(new URL(String(f.fetch.mock.calls[0]![0])).searchParams.has("include")).toBe(false);
  });

  it("escapes target reasons and titles without dropping logical line breaks", async () => {
    const f = fixture({ ...task, title: "Task\u001b[31m", session: { ...observation, reason: "idle\u001b[31m" } });
    expect(await f.run(["show", taskId])).toBe(0);
    expect(f.stdout.join("")).not.toContain("\u001b");
    expect(f.stdout.join("").split("\n").length).toBeGreaterThan(10);
  });
});
