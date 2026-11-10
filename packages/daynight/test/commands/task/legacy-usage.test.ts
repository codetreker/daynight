import { expect, it, vi } from "vitest";
import { createApiClient, createOperation } from "../../../src/api/index.js";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runTaskCommand, type TaskCommandDependencies } from "../../../src/commands/task/command.js";

const taskId = "bbbbbbbb-2222-4222-8222-222222222222";

it.each([
  ...["approve", "unapprove", "claim", "complete"].map(action => [action, taskId]),
  ["set-status", taskId, "unknown"], ["list", "--status", "unknown"],
  ["create", "--title", "Rejected property flags", "--pull-request-url=https://example.test/retired"],
  ["update", taskId, "--pull-request-title", "Retired property title"],
  ["update", taskId, "--clear-pull-requests"], ["update", taskId, "--status", "done"],
  ["update", taskId, "--depends-on", "cccccccc-3333-4333-8333-333333333333", "--external-depends-on", "cccccccc-3333-4333-8333-333333333333"],
  ["update", taskId, "--clear-dependencies", "--external-depends-on", "cccccccc-3333-4333-8333-333333333333"],
])("rejects invalid and retired task syntax before any server work: %s", async (...args) => {
  const context = { version: "0", packageDirectory: "unused", homeDirectory: vi.fn(() => "unused"), workingDirectory: vi.fn(() => "unused"), stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_value: Uint8Array) => {}) } satisfies CliContext;
  const dependencies = { runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(), resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>() };
  const exit = await runCli(["task", ...args], context, [{ name: "task", description: "Manage tasks", load: async () => ({ run: (rest, current) => runTaskCommand(rest, current, dependencies) }) }]);
  expect(exit).toBe(2);
  expect(context.stdout).not.toHaveBeenCalled(); expect(context.stdoutBytes).not.toHaveBeenCalled();
  expect(context.stderr.mock.calls[0]?.[0]).toBeTruthy();
  if (args.includes("--status") && args[0] === "update") expect(context.stderr.mock.calls[0]![0]).toContain("--status");
  expect(dependencies.runServerCommand).not.toHaveBeenCalled(); expect(dependencies.resolveProject).not.toHaveBeenCalled();
  expect(context.homeDirectory).not.toHaveBeenCalled(); expect(context.workingDirectory).not.toHaveBeenCalled();
});

it.each([".", ".."])("rejects the dot-only property name %s without sending a mutation", async name => {
  const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
  const operation = createOperation();
  const fetch = vi.fn<typeof globalThis.fetch>();
  const api = createApiClient({ serverUrl: "http://localhost", operation, fetch });
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => "unused", workingDirectory: () => "unused", stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_value: Uint8Array) => {}) } satisfies CliContext;
  const dependencies = { resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>(), runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
    const output = await command({ api, operation, serverUrl: "http://localhost", serverConfiguration: { serverUrl: "http://localhost" } });
    if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
  }) };
  try {
    const exit = await runCli(["task", "remove-property", taskId, name, "--project", projectId, "--if-version", "1"], context, [{ name: "task", description: "Manage tasks", load: async () => ({ run: (rest, current) => runTaskCommand(rest, current, dependencies) }) }]);
    expect(exit).toBe(1);
    expect(context.stderr.mock.calls[0]![0]).toContain("Property name cannot be represented without changing the request route.");
    expect(context.stdout).not.toHaveBeenCalled(); expect(context.stdoutBytes).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally { operation.dispose(); }
});

it.each([
  ...["worker", "worker.claimId", "unknown/value", "unknown%2fvalue"].map(name => ({ name, valueText: undefined })),
  { name: "pullRequests", valueText: '[{"url":"first","url":"second","title":"Duplicate field"}]' },
])("preserves the server refusal for literal property input $name", async ({ name, valueText }) => {
  const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
  const operation = createOperation();
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "invalid_input", message: "Unknown property", requestId: "fixture-refusal" } }), { status: 400, headers: { "content-type": "application/json" } }));
  const api = createApiClient({ serverUrl: "http://localhost", operation, fetch });
  const context = { version: "0", packageDirectory: "unused", homeDirectory: () => "unused", workingDirectory: () => "unused", stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_value: Uint8Array) => {}) } satisfies CliContext;
  const dependencies = { resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>(), runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
    const output = await command({ api, operation, serverUrl: "http://localhost", serverConfiguration: { serverUrl: "http://localhost" } });
    if (typeof output === "string") current.stdout(output); else if (output !== undefined) current.stdout(output.output);
  }) };
  try {
    const args = valueText === undefined ? ["remove-property", taskId, name] : ["set-property", taskId, name, valueText];
    const exit = await runCli(["task", ...args, "--project", projectId, "--if-version", "1"], context, [{ name: "task", description: "Manage tasks", load: async () => ({ run: (rest, current) => runTaskCommand(rest, current, dependencies) }) }]);
    expect(exit).toBe(1);
    expect(context.stderr.mock.calls[0]![0]).toContain("invalid_input");
    expect(context.stdout).not.toHaveBeenCalled(); expect(context.stdoutBytes).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}/properties/${encodeURIComponent(name)}`);
    expect(fetch.mock.calls[0]![1]!.method).toBe(valueText === undefined ? "DELETE" : "PUT");
    if (valueText !== undefined) expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ version: 1, valueText });
  } finally { operation.dispose(); }
});
