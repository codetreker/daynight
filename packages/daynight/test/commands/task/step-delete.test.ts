import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import type { DeleteTaskStepInput, Project, StepsResource, TaskStep } from "../../../src/api/types.js";
import type { OperationLimits } from "../../../src/api/operation.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runCli } from "../../../src/cli/application.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { taskDefinition } from "../../../src/commands/task/definition.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";
import { formatError } from "../../../src/platform/diagnostics.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111", taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333", stepId = "00abcdef";
const time = "2026-11-03T10:11:12.123456Z";
const survivor: TaskStep = { id: "00000000", title: "Survivor", description: "[Retained](plan.md)", status: "done", createdAt: time, updatedAt: time };
const target: TaskStep = { ...survivor, id: stepId, title: "private-target-title", description: "private-target-description" };
const previous: StepsResource = { projectId, taskId, version: 9_007_199_254_740_993n, steps: [survivor, target] };
const result = (version: bigint): StepsResource => ({ projectId, taskId, version: version + 1n, steps: [survivor] });
const json = (value: unknown, status = 200) => new Response(stringifyApiJson(value), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const fixture = (limits?: Partial<OperationLimits>) => {
  const operation = createOperation(limits === undefined ? {} : { limits }); cleanups.push(() => operation.dispose());
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => options!.method === "GET" ? json(previous) : json(result((parseApiJson(String(options!.body)) as DeleteTaskStepInput).version)));
  const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
  const stdout = vi.fn<(text: string) => void>();
  const context = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: vi.fn<() => string>(() => { throw new Error("private-config-token"); }), workingDirectory: vi.fn(() => "/"),
    stdout, stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn<CliContext["stdoutBytes"]>(async (chunk) => { stdout(Buffer.from(chunk).toString("utf8")); }),
  } satisfies CliContext;
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>().mockResolvedValue({ id: projectId } as Project),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost:8787" });
      if (typeof output === "string") current.stdout(output);
      else if (output !== undefined) await current.stdoutBytes(Buffer.from(output.output), operation.signal);
    }),
  };
  const args = (more: readonly string[] = []) => ["step", "delete", taskId.toUpperCase(), stepId.toUpperCase(), `--project=${projectId.toUpperCase()}`, ...more];
  return { operation, fetch, api, context, dependencies, args };
};
const failure = async (f: ReturnType<typeof fixture>, args: readonly string[]) => runTaskCommand(args, f.context, f.dependencies).catch((cause: unknown) => cause);

describe("Step Delete command preparation and output", () => {
  it("renders help before configuration, required arguments and business I/O", async () => {
    const f = fixture(); await runTaskCommand(["step", "delete", "--help"], f.context, f.dependencies);
    const help = f.context.stdout.mock.calls[0]![0]; expect(help).toContain("<task-id> <step-id>"); expect(help).toContain("--if-version"); expect(help).toContain("--json");
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled(); expect(f.dependencies.resolveProject).not.toHaveBeenCalled(); expect(f.context.homeDirectory).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["step", "delete"], ["step", "delete", taskId], ["step", "delete", "bad", stepId], ["step", "delete", taskId, "prefix"],
    ["step", "delete", taskId, "000000000"], ["step", "delete", taskId, stepId, "--project=bad"],
    ...["0", "-1", "1e2", "1.5", "9223372036854775808"].map((version) => ["step", "delete", taskId, stepId, `--if-version=${version}`]),
  ].map((args) => ({ args })))("rejects invalid input without configuration, discovery or network %#", async ({ args }) => {
    const f = fixture(); const registry = [{ ...taskDefinition, load: async () => ({ run: (values: readonly string[], current: CliContext) => runTaskCommand(values, current, f.dependencies) }) }];
    expect(await runCli(["task", ...args], f.context, registry)).toBe(2);
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled(); expect(f.dependencies.resolveProject).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.context.stdout).not.toHaveBeenCalled();
  });
  it("normalizes input IDs with leading zeros and writes one exact-version DELETE and full JSON", async () => {
    const f = fixture(); await runTaskCommand(f.args(["--if-version=9007199254740993", "--json"]), f.context, f.dependencies);
    expect(f.fetch).toHaveBeenCalledOnce(); const [url, options] = f.fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/steps/${stepId}`);
    expect(options!.method).toBe("DELETE"); expect(parseApiJson(String(options!.body))).toEqual({ version: previous.version });
    expect(new Headers(options!.headers).get("X-Request-ID")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(result(previous.version));
    expect(f.context.stdout.mock.calls[0]![0]).not.toContain("Step deleted."); expect(f.dependencies.resolveProject).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled();
  });
  it("pre-reads exactly once by default and renders the complete confirmed collection", async () => {
    const f = fixture(); await runTaskCommand(f.args(), f.context, f.dependencies);
    expect(f.fetch.mock.calls.map(([, options]) => options!.method)).toEqual(["GET", "DELETE"]);
    expect(parseApiJson(String(f.fetch.mock.calls[1]![1]!.body))).toEqual({ version: previous.version });
    const output = f.context.stdout.mock.calls[0]![0]; expect(output).toContain(`Step deleted. ID: ${stepId}`); expect(output).toContain("00000000"); expect(output).not.toContain("private-target");
  });
  it("does not submit after default pre-read failure", async () => {
    const f = fixture(); f.fetch.mockResolvedValue(json({ error: { code: "internal_error", message: "Read failed.", requestId: "pre-read" } }, 500));
    const text = formatError(await failure(f, f.args()));
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.fetch.mock.calls[0]![1]!.method).toBe("GET"); expect(text).toContain("operation=task.step.delete"); expect(text).toContain("outcome=failed"); expect(text).not.toContain("outcome is unknown"); expect(f.context.stdout).not.toHaveBeenCalled();
  });
  it("preserves trusted discovery recovery instead of selecting among project candidates", async () => {
    const f = fixture(); const { ProjectDiscoveryError } = await import("../../../src/repository/discovery-error.js");
    f.dependencies.resolveProject.mockRejectedValue(new ProjectDiscoveryError([projectId, taskId]));
    const text = formatError(await failure(f, f.args().filter((arg) => !arg.startsWith("--project="))));
    expect(text).toContain(projectId); expect(text).toContain(taskId); expect(text).toContain("--project <id>"); expect(text).toContain("operation=task.step.delete"); expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe("Step Delete shared unknown and confirmed result handling", () => {
  it.each(["found", "absent"] as const)("reports current %s facts from one same-operation observation without attributing the deletion", async (state) => {
    const f = fixture(); let original = "";
    f.fetch.mockImplementation(async (_url, options) => {
      const requestId = new Headers(options?.headers).get("X-Request-ID")!;
      if (options?.method === "DELETE") { original = requestId; throw new Error("private-network-token"); }
      expect(requestId).toBe(`${original}.r1`); expect(f.operation.signal.aborted).toBe(false);
      return json({ ...previous, version: 57n, steps: state === "found" ? [survivor, target] : [survivor] });
    });
    const text = formatError(await failure(f, f.args(["--if-version=1", "--json"])));
    expect(f.fetch.mock.calls.map(([, options]) => options!.method)).toEqual(["DELETE", "GET"]);
    expect(text).toContain("operation=task.step.delete"); expect(text).toContain("outcome=unknown"); expect(text).toContain(`version=57 target=${state}`); expect(text).toContain(`stepId=${stepId}`); expect(text).toContain(`requestId=${original}`); expect(text).toContain(`recoveryRequestId=${original}.r1`); expect(text).toContain("remains unknown");
    expect(text).not.toContain("Step deleted."); expect(text).not.toContain("Add"); expect(text).not.toContain("private-"); expect(f.context.stdout).not.toHaveBeenCalled();
  });
  it("does not reuse a default pre-read when the current observation fails", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json(previous)).mockRejectedValueOnce(new Error("private-delete-loss")).mockRejectedValueOnce(new Error("private-observation-loss"));
    const text = formatError(await failure(f, f.args()));
    expect(f.fetch.mock.calls.map(([, options]) => options!.method)).toEqual(["GET", "DELETE", "GET"]); expect(text).toContain("No current observation"); expect(text).not.toContain("Current facts only"); expect(text).not.toContain("private-"); expect(f.context.stdout).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "total"] as const)("does not start detached observation after whole-operation %s", async (kind) => {
    const f = fixture(kind === "total" ? { totalBytes: 2 } : undefined);
    f.fetch.mockImplementation(async () => {
      if (kind === "cancelled") { f.operation.dispose(); throw new Error("private-cancellation"); }
      return new Response("{}", { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
    });
    const text = formatError(await failure(f, f.args(["--if-version=1"])));
    expect(f.fetch).toHaveBeenCalledOnce(); expect(text).toContain("outcome=unknown"); expect(text).toContain("No current observation"); expect(text).not.toContain("recoveryRequestId="); expect(f.context.stdout).not.toHaveBeenCalled();
    if (kind === "total") { expect(f.operation.remainingBytes()).toBe(0); expect(f.operation.signal.aborted).toBe(false); }
  });
  it("accepts a fully validated receipt at the exact remaining total byte budget", async () => {
    const expected = result(1n); const f = fixture({ totalBytes: Buffer.byteLength(stringifyApiJson(expected), "utf8") });
    await runTaskCommand(f.args(["--if-version=1", "--json"]), f.context, f.dependencies);
    expect(f.operation.remainingBytes()).toBe(0); expect(f.fetch).toHaveBeenCalledOnce(); expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(expected);
  });
  it("retains confirmation if rendering is cancelled after receiving the resource", async () => {
    const f = fixture(); const remove = f.api.deleteTaskStep;
    vi.spyOn(f.api, "deleteTaskStep").mockImplementation(async (...args) => { const resource = await remove(...args); f.operation.dispose(); return resource; });
    const text = formatError(await failure(f, f.args(["--if-version=1"])));
    expect(text).toContain("outcome=confirmed"); expect(text).toContain(`Step deleted. ID: ${stepId}`); expect(text).not.toContain("outcome is unknown"); expect(f.fetch).toHaveBeenCalledOnce();
  });
  it.each(["output", "cleanup"] as const)("retains confirmed deletion across actual runtime %s failure", async (stage) => {
    const f = fixture(); const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/step-delete-runtime-tests");
    await mkdir(temporary, { recursive: true }); const home = await mkdtemp(path.join(temporary, "home-")); cleanups.push(() => rm(home, { recursive: true, force: true }));
    const state = path.join(home, ".daynight"); await mkdir(state); await writeFile(path.join(state, "config.yml"), "serverUrl: http://localhost:8787\nserverToken: fixture-token\n");
    vi.stubEnv("DN_CONFIG_DIR", state); f.context.homeDirectory.mockReturnValue(home);
    const signals = new EventEmitter();
    const context = { ...f.context, closeStdoutBytes: vi.fn(async () => { if (stage === "cleanup") throw new Error("private-cleanup-token"); }) } satisfies CliContext;
    if (stage === "output") context.stdoutBytes.mockRejectedValue(new Error("private-output-token"));
    const dependencies: TaskCommandDependencies = { ...f.dependencies, runServerCommand: (current, command) => runServerCommand(current, command, { fetch: f.fetch, signalEmitter: signals }) };
    const error = await runTaskCommand(f.args(["--if-version=1", "--json"]), context, dependencies).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ exitCode: 1 }); const text = formatError(error);
    expect(text).toContain(`Step deleted. ID: ${stepId}`); expect(text).toContain(`local ${stage} failed`); expect(text).toContain(`requestId=${new Headers(f.fetch.mock.calls[0]![1]!.headers).get("X-Request-ID")}`); expect(text).not.toContain("private-"); expect(text).not.toContain("outcome is unknown");
    expect(f.fetch).toHaveBeenCalledOnce(); expect(context.closeStdoutBytes).toHaveBeenCalledOnce(); for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) expect(signals.listenerCount(signal)).toBe(0);
  });
});
