import { expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import type { StepsResource, TaskStep } from "../../../src/api/index.js";
import { TASK_STEPS_RESPONSE_BYTES } from "../../../src/api/task-steps.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");

it("reads and renders a complete 64 MiB Steps collection with one request", async () => {
  const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
  const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
  const userId = "cccccccc-3333-4333-8333-333333333333";
  const stamp = "2026-11-03T10:11:12.123456Z";
  const steps: TaskStep[] = Array.from({ length: 128 }, (_, index) => ({ id: index.toString(16).padStart(8, "0"), title: "<中文&>\u2028\u2029", description: "", status: "todo", createdAt: stamp, updatedAt: stamp }));
  const resource: StepsResource = { projectId, taskId, version: 9_223_372_036_854_775_807n, steps };
  let remaining = TASK_STEPS_RESPONSE_BYTES - Buffer.byteLength(stringifyApiJson(resource));
  for (const step of steps) {
    const bytes = Math.min(remaining, 524_288);
    (step as { description: string }).description = "X".repeat(bytes);
    remaining -= bytes;
  }
  expect(remaining).toBe(0);
  const wire = stringifyApiJson(resource);
  expect(Buffer.byteLength(wire)).toBe(TASK_STEPS_RESPONSE_BYTES);
  const operation = createOperation();
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(wire, { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }));
  const api = createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch });
  const context = { version: "0.0.0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected config read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); }, stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_bytes: Uint8Array) => {}) } satisfies CliContext;
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>(),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
      operation.check();
      if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
    }),
  };
  try {
    await runTaskCommand(["step", "list", taskId, "--project", projectId, "--json"], context, dependencies);
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]![0])).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/steps`);
    expect(context.stderr).not.toHaveBeenCalled();
    expect(context.stdout).not.toHaveBeenCalled();
    expect(context.stdoutBytes).toHaveBeenCalledOnce();
    const output = Buffer.from(context.stdoutBytes.mock.calls[0]![0]).toString("utf8");
    const actual = parseApiJson(output) as StepsResource;
    expect(actual.projectId).toBe(projectId); expect(actual.taskId).toBe(taskId);
    expect(actual.version).toBe(resource.version); expect(actual.steps).toHaveLength(steps.length);
    for (let index = 0; index < steps.length; index++) expect(actual.steps[index]).toEqual(steps[index]);
  } finally { operation.dispose(); }
}, 120_000);

it("accepts and renders a complete 64 MiB Add receipt without replaying the POST", async () => {
  const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
  const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
  const userId = "cccccccc-3333-4333-8333-333333333333";
  const stamp = "2026-11-03T10:11:12.123456Z";
  const steps: TaskStep[] = Array.from({ length: 128 }, (_, index) => ({ id: index.toString(16).padStart(8, "0"), title: "<中文&>", description: "", status: "todo", createdAt: stamp, updatedAt: stamp }));
  steps.push({ id: "ffffffff", title: "New <&> 中文", description: "", status: "todo", createdAt: stamp, updatedAt: stamp });
  const resource: StepsResource = { projectId, taskId, version: 42n, steps };
  let remaining = TASK_STEPS_RESPONSE_BYTES - Buffer.byteLength(stringifyApiJson(resource));
  for (const step of steps.slice(0, -1)) {
    const bytes = Math.min(remaining, 524_288);
    (step as { description: string }).description = "X".repeat(bytes);
    remaining -= bytes;
  }
  expect(remaining).toBe(0);
  const wire = stringifyApiJson(resource);
  expect(Buffer.byteLength(wire)).toBe(TASK_STEPS_RESPONSE_BYTES);
  const operation = createOperation();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
    const posting = init?.method === "POST";
    return new Response(wire, { status: posting ? 201 : 200, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, ...(posting ? { "Location": `/api/v1/projects/${projectId}/tasks/${taskId}/steps/ffffffff`, "X-Request-ID": new Headers(init?.headers).get("X-Request-ID")! } : {}) } });
  });
  const api = createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch });
  const context = { version: "0.0.0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected config read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); }, stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_bytes: Uint8Array) => {}) } satisfies CliContext;
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>(),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
      operation.check();
      if (typeof output === "string") current.stdout(output); else if (output !== undefined) await current.stdoutBytes(Buffer.from(output.output), operation.signal);
    }),
  };
  try {
    await runTaskCommand(["step", "add", taskId, "--id", "ffffffff", "--title", "New <&> 中文", "--if-version", "41", "--project", projectId, "--json"], context, dependencies);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1]?.method).toBe("POST");
    expect(parseApiJson(String(fetch.mock.calls[0]![1]?.body))).toEqual({ version: 41n, id: "ffffffff", title: "New <&> 中文" });
    expect(context.stderr).not.toHaveBeenCalled(); expect(context.stdoutBytes).toHaveBeenCalledOnce();
    const actual = parseApiJson(Buffer.from(context.stdoutBytes.mock.calls[0]![0]).toString("utf8")) as StepsResource;
    expect(actual.projectId).toBe(projectId); expect(actual.taskId).toBe(taskId);
    expect(actual.version).toBe(42n); expect(actual.steps).toHaveLength(steps.length);
    for (let index = 0; index < steps.length; index++) expect(actual.steps[index]).toEqual(steps[index]);
    await runTaskCommand(["step", "list", taskId, "--project", projectId, "--json"], context, dependencies);
    expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET"]);
    expect(context.stdoutBytes).toHaveBeenCalledTimes(2);
    const reread = parseApiJson(Buffer.from(context.stdoutBytes.mock.calls[1]![0]).toString("utf8")) as StepsResource;
    expect(reread.projectId).toBe(projectId); expect(reread.taskId).toBe(taskId);
    expect(reread.version).toBe(actual.version); expect(reread.steps).toHaveLength(actual.steps.length);
    for (let index = 0; index < steps.length; index++) expect(reread.steps[index]).toEqual(actual.steps[index]);
  } finally { operation.dispose(); }
}, 120_000);
