import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, createOperation, OperationError, parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import type { Project, StepsResource, TaskStep } from "../../../src/api/types.js";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { renderTaskStep, renderTaskSteps, renderTaskStepsJson, stepText } from "../../../src/commands/task/step-rendering.js";
import { StepReadCommandError } from "../../../src/commands/task/step-diagnostics.js";
import { formatError, PublicDiagnosticError } from "../../../src/platform/diagnostics.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333";
const step: TaskStep = { id: "00abcdef", title: "  <中文&> title  ", description: " # Markdown\n\t```\nraw \\\n```  ", status: "skipped", createdAt: "2026-11-03T10:20:30.123456Z", updatedAt: "2026-11-03T11:22:33.654321Z" };
const resource: StepsResource = { projectId, taskId, version: 9_007_199_254_740_993n, steps: [step, { ...step, id: "00000000", status: "in_progress" }] };
const json = (value: unknown, status = 200) => new Response(stringifyApiJson(value), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });
const fixture = () => {
  const operation = createOperation(); cleanups.push(() => operation.dispose());
  const stdout = vi.fn<(text: string) => void>();
  const context = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: vi.fn(() => { throw new Error("Unexpected config read"); }), workingDirectory: vi.fn(() => "/"),
    stdout, stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (chunk: Uint8Array) => { stdout(Buffer.from(chunk).toString("utf8")); }),
  } satisfies CliContext;
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(resource));
  const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>().mockResolvedValue({ id: projectId } as Project),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
      if (typeof output === "string") current.stdout(output);
    }),
  };
  return { context, dependencies, fetch, operation };
};

describe("Steps read command", () => {
  it.each([["step"], ["step", "--help"], ["step", "list", "--help"], ["step", "show", "--help"]].map((args) => ({ args })))("renders $args before all I/O", async ({ args }) => {
    const f = fixture();
    await runTaskCommand(args, f.context, f.dependencies);
    expect(f.context.stdout).toHaveBeenCalledOnce();
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Usage: daynight task step");
    if (args[1] === "list" || args[1] === "show") expect(f.context.stdout.mock.calls[0]![0]).not.toContain("--if-version");
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled(); expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
    expect(f.context.homeDirectory).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["list", "bad"], ["list", taskId, "--project=bad"], ["show", taskId, "bad"], ["show", taskId, taskId], ["show", taskId, "0000000g"], ["show", taskId, "000000000"],
  ].map((args) => ({ args })))("rejects bad identity before configuration or discovery %#", async ({ args }) => {
    const f = fixture();
    await expect(runTaskCommand(["step", ...args], f.context, f.dependencies)).rejects.toMatchObject({ exitCode: 2 });
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled(); expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
    expect(f.context.homeDirectory).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each([
    ["add"], ["update"], ["set-status"], ["move"], ["delete"], ["list", taskId, "--if-version=1"], ["list", taskId, "--all"], ["list", taskId, "--title=private-title"], ["show", taskId], ["list", taskId, "private-extra"],
  ].map((args) => ({ args })))("rejects unsupported arguments at actual CLI exit without I/O %#", async ({ args }) => {
    const f = fixture();
    expect(await runCli(["task", "step", ...args], f.context)).toBe(2);
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.homeDirectory).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled();
    expect(f.context.stderr.mock.calls[0]![0]).toMatch(/^Invalid Step command arguments\./);
    expect(f.context.stderr.mock.calls[0]![0]).not.toContain("private");
  });

  it.each([
    { args: ["list", "bad"], diagnostic: "task-id must be a hyphenated UUID" },
    { args: ["show", taskId, "abc"], diagnostic: "step-id must contain exactly eight hexadecimal characters" },
    { args: ["list", taskId, "--project", "bad"], diagnostic: "project-id must be a hyphenated UUID" },
  ])("rejects malformed read identity at the CLI boundary without I/O: $args", async ({ args, diagnostic }) => {
    const f = fixture();
    expect(await runCli(["task", "step", ...args], f.context)).toBe(2);
    expect(f.context.stderr.mock.calls[0]![0]).toContain(diagnostic);
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
    expect(f.context.homeDirectory).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled();
  });

  it("reads one complete explicit-project collection outside a repository without parent pre-reads", async () => {
    const f = fixture(); f.context.workingDirectory.mockImplementation(() => { throw new Error("Git must not run"); });
    await runTaskCommand(["step", "list", taskId.toUpperCase(), `--project=${projectId.toUpperCase()}`], f.context, f.dependencies);
    expect(f.fetch).toHaveBeenCalledOnce(); expect(String(f.fetch.mock.calls[0]![0])).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/steps`);
    expect(f.fetch.mock.calls[0]![1]!.method).toBe("GET"); expect(f.dependencies.resolveProject).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled();
    expect(f.context.stdout).toHaveBeenCalledExactlyOnceWith(renderTaskSteps(resource));
    expect(f.context.stdout.mock.calls[0]![0]).toContain("Steps: 2\n1. 00abcdef  skipped");
  });

  it("reads only the canonical show identity and preserves the full item JSON", async () => {
    const f = fixture(); const item = { projectId, taskId, version: resource.version, step }; f.fetch.mockResolvedValue(json(item));
    await runTaskCommand(["step", "show", taskId, "00ABCDEF", `--project=${projectId}`, "--json"], f.context, f.dependencies);
    expect(f.fetch).toHaveBeenCalledOnce(); expect(String(f.fetch.mock.calls[0]![0])).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/steps/00abcdef`);
    const output = f.context.stdout.mock.calls[0]![0];
    expect(parseApiJson(output)).toEqual(item); expect(output).toContain('"version":9007199254740993'); expect(output).not.toContain("Task:");
    expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
  });

  it("uses repository discovery only for omitted project and keeps full list JSON", async () => {
    const f = fixture();
    await runTaskCommand(["step", "list", taskId, "--json"], f.context, f.dependencies);
    expect(f.dependencies.resolveProject).toHaveBeenCalledOnce(); expect(f.context.workingDirectory).toHaveBeenCalledOnce(); expect(f.fetch).toHaveBeenCalledOnce();
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(resource);
  });

  it("prints the complete empty Steps resource as JSON", async () => {
    const f = fixture();
    const empty = { ...resource, steps: [] };
    f.fetch.mockResolvedValue(json(empty));
    await runTaskCommand(["step", "list", taskId, "--project", projectId, "--json"], f.context, f.dependencies);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(empty);
  });

  it("prints complete list and show details with escaped terminal controls", async () => {
    const f = fixture();
    const title = `${"long-title-".repeat(40)}\u001b[31m\nInjected label`;
    const description = `完整 Markdown\n${"Markdown-line-中文-".repeat(256)}end-of-markdown\u001b[32m\r\u2028\u2029`;
    const detailed = { ...step, title, description };
    f.fetch.mockResolvedValueOnce(json({ ...resource, steps: [detailed, resource.steps[1]!] })).mockResolvedValueOnce(json({ projectId, taskId, version: resource.version, step: detailed }));
    await runTaskCommand(["step", "list", taskId, "--project", projectId], f.context, f.dependencies);
    await runTaskCommand(["step", "show", taskId, detailed.id, "--project", projectId], f.context, f.dependencies);
    const [list, show] = f.context.stdout.mock.calls.map(([output]) => output);
    for (const field of [taskId, "9007199254740993", "Steps: 2", "1. 00abcdef", "2. 00000000", "long-title-".repeat(40), "\\u001b[31m", "\\nInjected label"]) expect(list).toContain(field);
    for (const field of [taskId, "9007199254740993", "00abcdef", "long-title-".repeat(40), "完整 Markdown", "Markdown-line-中文-".repeat(256), "end-of-markdown", "\\u001b[32m", detailed.createdAt, detailed.updatedAt]) expect(show).toContain(field);
    for (const text of [list!, show!]) expect(text).not.toMatch(/[\u001b\r\u2028\u2029]/);
    expect(f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([`/api/v1/projects/${projectId}/tasks/${taskId}/steps`, `/api/v1/projects/${projectId}/tasks/${taskId}/steps/${detailed.id}`]);
  });

  it("preserves escaped public service diagnostics and login guidance without dumping internal causes", async () => {
    const f = fixture(); f.fetch.mockResolvedValue(json({ error: { code: "unauthenticated", message: "Sign in\nwith a fresh credential\u001b[31m\u202e", requestId: "steps-read-401", details: { taskIds: [taskId] } } }, 401));
    const error = await runTaskCommand(["step", "show", taskId, "00abcdef", `--project=${projectId}`], f.context, f.dependencies).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PublicDiagnosticError); const diagnostic = formatError(error);
    expect(diagnostic).toContain("unauthenticated: Sign in\\nwith a fresh credential\\u001b[31m\\u202e"); expect(diagnostic).toContain("daynight login");
    expect(diagnostic).toContain("requestId=steps-read-401"); expect(diagnostic).toContain("stepId=00abcdef"); expect(diagnostic).toContain(taskId); expect(diagnostic).not.toContain("\u001b");
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each([401, 404, 405, 410, 500, 501])("never replaces HTTP%s with an empty resource or a replay", async (status) => {
    const f = fixture(); const code = status === 410 ? "task_deleted" : status === 501 ? "not_implemented" : "not_found";
    f.fetch.mockResolvedValue(json({ error: { code, message: "Resource is unavailable.", requestId: "steps-error" } }, status));
    const error = await runTaskCommand(["step", "list", taskId, `--project=${projectId}`, "--json"], f.context, f.dependencies).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ exitCode: 1 }); expect(formatError(error)).toContain(code); expect(formatError(error)).toContain("steps-error");
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { action: ["show", taskId, "22222222"], status: 404, code: "not_found" },
    { action: ["list", taskId], status: 404, code: "not_found" },
    { action: ["list", taskId], status: 410, code: "task_deleted" },
    { action: ["list", taskId], status: 401, code: "unauthenticated" },
  ])("exposes $code for a read at the CLI boundary without output or replay", async ({ action, status, code }) => {
    const f = fixture();
    f.fetch.mockResolvedValue(json({ error: { code, message: "Resource unavailable.", requestId: "read-refusal" } }, status));
    const { taskDefinition } = await import("../../../src/commands/task/definition.js");
    const registry = [{ ...taskDefinition, load: async () => ({ run: (args: readonly string[], context: CliContext) => runTaskCommand(args, context, f.dependencies) }) }];
    expect(await runCli(["task", "step", ...action, "--project", projectId, "--json"], f.context, registry)).toBe(1);
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
    const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
    expect(diagnostic).toContain(`code=${code}`); expect(diagnostic).not.toContain("Caused by:");
    if (status === 401) { expect(diagnostic).toContain("daynight login"); expect(diagnostic).toContain("status=401"); }
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.fetch.mock.calls[0]![1]!.method).toBe("GET");
  });

  it.each([{ ...resource, projectId: taskId }, { ...resource, version: "1" }])("reports an invalid collection as a protocol failure without output or replay %#", async (value) => {
    const f = fixture(); f.fetch.mockResolvedValue(json(value));
    const error = await runTaskCommand(["step", "list", taskId, `--project=${projectId}`, "--json"], f.context, f.dependencies).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ exitCode: 1 }); expect(formatError(error)).toContain("phase=protocol");
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("shields configuration, output and cleanup text while preserving original causes", async () => {
    for (const phase of ["configuration", "output", "cleanup"] as const) {
      const f = fixture(), secret = new Error(`private-${phase}-token-url`);
      if (phase === "configuration") f.dependencies.runServerCommand.mockRejectedValue(secret);
      else if (phase === "output") f.context.stdoutBytes.mockRejectedValue(secret);
      else f.dependencies.runServerCommand.mockImplementation(async () => { throw new AggregateError([new ApiError({ operation: "task.step.list", projectId, taskId }, "request", { cause: new Error("private-network-token") }), secret], "private-aggregate"); });
      const error = await runTaskCommand(["step", "list", taskId, `--project=${projectId}`], f.context, f.dependencies).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(StepReadCommandError); expect(formatError(error)).not.toContain("private-");
      if (phase !== "cleanup") expect((error as Error).cause).toBe(secret);
    }
  });

  it("retains fixed cancellation and budget reasons without exposing arbitrary transport text", () => {
    for (const kind of ["cancelled", "deadline", "request_timeout", "response_limit", "total_limit"] as const) {
      const reason = new OperationError(kind);
      const api = new ApiError({ operation: "task.step.list", projectId, taskId }, "request", { cause: reason });
      const error = new StepReadCommandError(api, "list", "request", projectId, taskId);
      expect(formatError(error)).toContain(reason.message);
      expect(error.cause).toBe(api);
    }
  });

  it("stops before dispatch when discovery is cancelled", async () => {
    const f = fixture(); f.dependencies.resolveProject.mockImplementation(async () => { f.operation.dispose(); return { id: projectId } as Project; });
    await expect(runTaskCommand(["step", "list", taskId], f.context, f.dependencies)).rejects.toMatchObject({ exitCode: 1 });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.context.stdout).not.toHaveBeenCalled();
  });
});

describe("Steps full output", () => {
  it("retains all row titles/order and full show Markdown while escaping terminal and bidi controls", () => {
    const long = "Long".repeat(10_000), title = `${long}\u001b[31m\n\t\u202e`, description = `${step.description}\u009b\u2029\u2066`;
    const first = { ...step, title, description }; const list = { ...resource, steps: [first, resource.steps[1]!] };
    const output = renderTaskSteps(list);
    expect(output).toContain(long); expect(output.indexOf("00abcdef")).toBeLessThan(output.indexOf("00000000")); expect(output).not.toContain(description);
    const item = renderTaskStep({ projectId, taskId, version: resource.version, step: first });
    expect(item).toContain(`Title: ${stepText(title)}`); expect(item).toContain(`Description: ${stepText(description)}`); expect(item).toContain(step.createdAt); expect(item).toContain(step.updatedAt);
    expect(item).not.toContain("\u001b"); expect(item).not.toContain("\u202e");
    expect(parseApiJson(renderTaskStepsJson({ projectId, taskId, version: resource.version, step: first }))).toEqual({ projectId, taskId, version: resource.version, step: first });
  });

  it("keeps empty identity/version/count and checks cancellation during output preparation", () => {
    expect(renderTaskSteps({ ...resource, steps: [] })).toContain("Version: 9007199254740993\nSteps: 0\n");
    let checks = 0;
    expect(() => renderTaskSteps(resource, () => { if (++checks === 2) throw new Error("cancel render"); })).toThrow("cancel render");
    expect(() => renderTaskStepsJson(resource, () => { throw new Error("cancel JSON"); })).toThrow("cancel JSON");
  });
});
