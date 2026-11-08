import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, DEFAULT_OPERATION_LIMITS, parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import type { AddTaskStepInput, Project, StepsResource, TaskStep } from "../../../src/api/types.js";
import type { OperationLimits } from "../../../src/api/operation.js";
import type { CliContext } from "../../../src/cli/context.js";
import { UsageError } from "../../../src/cli/context.js";
import { runCli } from "../../../src/cli/application.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";
import { formatError } from "../../../src/platform/diagnostics.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333";
const time = "2026-11-03T10:11:12.123456Z";
const anchor: TaskStep = { id: "00000000", title: "Old", description: "old Markdown", status: "done", createdAt: time, updatedAt: time };
const previous: StepsResource = { projectId, taskId, version: 9_007_199_254_740_993n, steps: [anchor] };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(stringifyApiJson(value), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, ...headers } });
const resource = (input: AddTaskStepInput): StepsResource => {
  const target: TaskStep = { id: input.id, title: input.title, description: input.description === undefined ? "" : input.description, status: input.status === undefined ? "todo" : input.status, createdAt: time, updatedAt: time };
  return { projectId, taskId, version: input.version + 1n, steps: input.before === anchor.id ? [target, anchor] : [anchor, target] };
};
const fixture = (limits?: Partial<OperationLimits>) => {
  const operation = createOperation(limits === undefined ? {} : { limits }); cleanups.push(() => operation.dispose());
  const calls: { method: string; requestId: string | null; body?: AddTaskStepInput }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
    const requestId = new Headers(options?.headers).get("X-Request-ID");
    const body = options?.body === undefined ? undefined : parseApiJson(String(options.body)) as AddTaskStepInput;
    calls.push({ method: options!.method!, requestId, ...(body === undefined ? {} : { body }) });
    return options!.method === "GET" ? json(previous) : json(resource(body!), 201, { Location: `/api/v1/projects/${projectId}/tasks/${taskId}/steps/${body!.id}`, "X-Request-ID": requestId! });
  });
  const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
  const stdout = vi.fn<(text: string) => void>();
  const context = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: vi.fn<() => string>(() => { throw new Error("private-config-token"); }), workingDirectory: vi.fn(() => "/"),
    stdout, stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn<CliContext["stdoutBytes"]>(async (chunk) => { stdout(Buffer.from(chunk).toString("utf8")); }),
  } satisfies CliContext;
  const dependencies = {
    resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>().mockResolvedValue({ id: projectId } as Project),
    runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
      if (typeof output === "string") current.stdout(output);
      else if (output !== undefined) await current.stdoutBytes(Buffer.from(output.output), operation.signal);
    }),
  };
  const args = (more: readonly string[] = []) => ["step", "add", taskId.toUpperCase(), "--title=  title-secret\n\uFEFF  ", "--id=00ABCDEF", `--project=${projectId.toUpperCase()}`, ...more];
  return { operation, calls, fetch, api, context, dependencies, args };
};
const failure = async (f: ReturnType<typeof fixture>, args: readonly string[]) => runTaskCommand(args, f.context, f.dependencies).catch((cause: unknown) => cause);

describe("Step Add input and exact request budgets", () => {
  it("keeps Add help before required input/configuration/discovery/network", async () => {
    const f = fixture(); await runTaskCommand(["step", "add", "--help"], f.context, f.dependencies);
    expect(f.context.stdout.mock.calls[0]![0]).toContain("--if-version"); expect(f.context.stdout.mock.calls[0]![0]).toContain("skipped");
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled(); expect(f.context.homeDirectory).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("rejects a missing title at the application boundary before configuration or requests", async () => {
    const f = fixture(); const { taskDefinition } = await import("../../../src/commands/task/definition.js");
    const registry = [{ ...taskDefinition, load: async () => ({ run: (args: readonly string[], context: CliContext) => runTaskCommand(args, context, f.dependencies) }) }];
    expect(await runCli(["task", "step", "add", taskId], f.context, registry)).toBe(2);
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.dependencies.runServerCommand).not.toHaveBeenCalled();
    expect(f.context.homeDirectory).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["--title="], ["--title= \u0085"], ["--title=\0"], ["--title=\ud800"], ["--description=\0"], ["--description=\ud800"],
    ["--id=bad"], ["--id=000000000"], ["--before=bad"], ["--after=bad"], ["--before=00000000", "--after=00000000"],
    ...["0", "-1", "1e2", "1.5", "9223372036854775808"].map((version) => [`--if-version=${version}`]),
  ].map((extra) => ({ extra })))("rejects bad input before all business I/O %#", async ({ extra }) => {
    const f = fixture(); const args = f.args().filter((arg) => !extra.some((option) => option.split("=")[0] === arg.split("=")[0]));
    const error = await failure(f, [...args, ...extra]);
    if (error instanceof UsageError) expect(error.helpCommand).toBe("daynight task step add --help");
    else expect(error).toMatchObject({ exitCode: 2 });
    expect(formatError(error)).not.toContain("title-secret"); expect(f.dependencies.runServerCommand).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("makes one explicit POST with raw text, normalized identity/anchor, exact version and pre-dispatch UUID", async () => {
    const f = fixture(); const description = "  # body-secret\n\r\n\\  ";
    await runTaskCommand(f.args(["--if-version=9007199254740993", "--before=00000000", "--status=skipped", `--description=${description}`, "--json"]), f.context, f.dependencies);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.method).toBe("POST");
    expect(new URL(String(f.fetch.mock.calls[0]![0])).pathname).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}/steps`);
    expect(f.calls[0]!.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(f.calls[0]!.body).toMatchObject({ version: 9_007_199_254_740_993n, id: "00abcdef", title: "  title-secret\n\uFEFF  ", description, status: "skipped", before: "00000000" });
    const output = f.context.stdout.mock.calls[0]![0]; expect(parseApiJson(output)).toEqual(resource(f.calls[0]!.body!)); expect(output).not.toContain("Step added.");
    expect(f.context.workingDirectory).not.toHaveBeenCalled(); expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
  });
  it("passes separately supplied Unicode and markup arguments through to the complete receipt", async () => {
    const f = fixture(); const { taskDefinition } = await import("../../../src/commands/task/definition.js");
    const registry = [{ ...taskDefinition, load: async () => ({ run: (args: readonly string[], context: CliContext) => runTaskCommand(args, context, f.dependencies) }) }];
    const title = "  <packed&> 中文😀  ", description = "# Packed [Plan](plan.md) <&> 😀";
    expect(await runCli(["task", "step", "add", taskId.toUpperCase(), "--id=00ABCDEF", "--title", title, "--description", description, "--status=skipped", "--json", "--project", projectId.toUpperCase(), "--if-version", "9007199254740993"], f.context, registry)).toBe(0);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.method).toBe("POST");
    expect(f.calls[0]!.body).toEqual({ version: previous.version, id: "00abcdef", title, description, status: "skipped" });
    const output = f.context.stdout.mock.calls[0]![0];
    expect(parseApiJson(output)).toEqual(resource(f.calls[0]!.body!)); expect(output).toContain('"version":9007199254740994');
    expect(f.context.stderr).not.toHaveBeenCalled(); expect(f.dependencies.resolveProject).not.toHaveBeenCalled();
  });
  it("renders the confirmed Add identity, exact version and escaped title safely", async () => {
    const f = fixture();
    await runTaskCommand(["step", "add", taskId, "--id", "00abcdef", "--title", "Control\u001b[31m\nFull title", "--if-version", "9007199254740993", "--project", projectId], f.context, f.dependencies);
    const output = f.context.stdout.mock.calls[0]![0];
    expect(output).toContain("9007199254740994"); expect(output).toContain("00abcdef");
    expect(output).toContain("Control\\u001b[31m\\nFull title"); expect(output).not.toContain("\u001b");
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("uses exactly GET Steps then POST by default, generates one stable short ID, and retains server defaults", async () => {
    const f = fixture(); await runTaskCommand(f.args(["--after=00000000"]).filter((arg) => !arg.startsWith("--id=")), f.context, f.dependencies);
    expect(f.calls.map(({ method }) => method)).toEqual(["GET", "POST"]);
    expect(f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([`/api/v1/projects/${projectId}/tasks/${taskId}/steps`, `/api/v1/projects/${projectId}/tasks/${taskId}/steps`]);
    const sent = f.calls[1]!; expect(sent.body!.id).toMatch(/^[0-9a-f]{8}$/); expect(sent.body!.version).toBe(previous.version);
    expect(sent.body!.description).toBeUndefined(); expect(sent.body!.status).toBeUndefined();
    expect(f.context.stdout.mock.calls[0]![0]).toContain(`Step added. ID: ${sent.body!.id}`);
    expect(f.context.stdout.mock.calls[0]![0]).toContain("todo");
  });
  it("stops a failed default pre-read before POST and does not claim unknown mutation", async () => {
    const f = fixture(); f.fetch.mockResolvedValue(json({ error: { code: "internal_error", message: "Read failed.", requestId: "pre-read" } }, 500));
    const error = await failure(f, f.args()); expect(error).toMatchObject({ exitCode: 1 });
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.context.stdout).not.toHaveBeenCalled(); expect(formatError(error)).toContain("outcome=failed"); expect(formatError(error)).not.toContain("outcome is unknown");
  });
  it("reports a missing baseline at the CLI boundary without an Add", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(json({ error: { code: "not_found", message: "Task not found.", requestId: "missing-baseline" } }, 404));
    const { taskDefinition } = await import("../../../src/commands/task/definition.js");
    const registry = [{ ...taskDefinition, load: async () => ({ run: (args: readonly string[], context: CliContext) => runTaskCommand(args, context, f.dependencies) }) }];
    expect(await runCli(["task", ...f.args(["--json"])], f.context, registry)).toBe(1);
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
    const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
    expect(diagnostic).toContain("code=not_found"); expect(diagnostic.toLowerCase()).not.toContain("outcome is unknown");
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls[0]![1]!.method).toBe("GET");
    expect(new URL(String(f.fetch.mock.calls[0]![0])).pathname).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}/steps`);
  });
  it("keeps existing trusted project discovery recovery for Add without selecting a candidate", async () => {
    const f = fixture(); const { ProjectDiscoveryError } = await import("../../../src/repository/discovery-error.js");
    f.dependencies.resolveProject.mockRejectedValue(new ProjectDiscoveryError([projectId, taskId]));
    const error = await failure(f, f.args().filter((arg) => !arg.startsWith("--project=")));
    expect(formatError(error)).toContain(projectId); expect(formatError(error)).toContain(taskId); expect(formatError(error)).toContain("--project <id>"); expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe("Step Add refusal, unknown and factual observation", () => {
  it.each([["title", "é".repeat(512) + "x", 1025, 1024], ["description", "界".repeat(21845) + "ab", 65537, 65536]] as const)("forwards excess %s and reports the server field refusal", async (field, value, actual, max) => {
    const f = fixture();
    f.fetch.mockImplementation(async (_url, options) => {
      const body = parseApiJson(String(options!.body)) as AddTaskStepInput;
      expect(body[field]).toBe(value);
      return json({ error: { code: "invalid_input", message: `${field}: ${actual} bytes exceeds maximum ${max}`, requestId: "field-refusal" } }, 400);
    });
    const args = f.args(["--if-version=1"]).filter((arg) => field !== "title" || !arg.startsWith("--title="));
    const error = await failure(f, [...args, `--${field}=${value}`]);
    const diagnostic = formatError(error);
    expect(diagnostic).toContain("code=invalid_input"); expect(diagnostic).toContain("outcome=refused");
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.context.stdout).not.toHaveBeenCalled();
  });
  it.each([[409, "step_id_conflict"], [409, "version_conflict"], [404, "not_found"]] as const)("reports confirmed Add refusal %s/%s without retry", async (status, code) => {
    const f = fixture();
    f.fetch.mockResolvedValue(json({ error: { code, message: "Add refused.", requestId: "add-refusal" } }, status));
    const { taskDefinition } = await import("../../../src/commands/task/definition.js");
    const registry = [{ ...taskDefinition, load: async () => ({ run: (args: readonly string[], context: CliContext) => runTaskCommand(args, context, f.dependencies) }) }];
    expect(await runCli(["task", ...f.args(["--if-version=1", "--json"])], f.context, registry)).toBe(1);
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
    const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
    expect(diagnostic).toContain(`code=${code}`); expect(diagnostic).toContain("outcome=refused");
    expect(diagnostic.toLowerCase()).not.toContain("outcome is unknown");
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.fetch.mock.calls[0]![1]!.method).toBe("POST");
  });
  it("keeps known capacity refusal/details and original UUID distinct from observed IDs, with no recovery/replay", async () => {
    const f = fixture(); let original = "";
    f.fetch.mockImplementation(async (_url, options) => { original = new Headers(options?.headers).get("X-Request-ID")!; return json({ error: { code: "steps_limit_exceeded", message: "Step collection is full.", requestId: "server-body-id", details: { encodedBytes: 67_108_865, maxEncodedBytes: 67_108_864 } } }, 409, { "X-Request-ID": "server-header-id" }); });
    const error = await failure(f, f.args(["--if-version=1"])); const text = formatError(error);
    expect(text).toContain("outcome=refused"); expect(text).toContain(`requestId=${original}`); expect(text).toContain("serverRequestId=server-body-id"); expect(text).toContain("responseRequestId=server-header-id"); expect(text).toContain('"encodedBytes":67108865');
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.context.stdout).not.toHaveBeenCalled(); expect(text).not.toContain("title-secret");
  });
  it.each(["found", "absent"] as const)("keeps unknown even after a successful same-operation .r1 observing %s", async (state) => {
    const f = fixture(); let sent: AddTaskStepInput | undefined, original = "";
    f.fetch.mockImplementation(async (_url, options) => {
      const id = new Headers(options?.headers).get("X-Request-ID")!;
      if (options?.method === "POST") { sent = parseApiJson(String(options.body)) as AddTaskStepInput; original = id; throw new Error("private-network-token-url"); }
      expect(id).toBe(`${original}.r1`); expect(f.operation.signal.aborted).toBe(false);
      return json({ ...resource(sent!), version: 57n, ...(state === "absent" ? { steps: [anchor] } : {}) });
    });
    const error = await failure(f, f.args(["--if-version=1", "--json"])); const text = formatError(error);
    expect(f.fetch).toHaveBeenCalledTimes(2); expect(text).toContain("outcome=unknown"); expect(text).toContain(`version=57 target=${state}`); expect(text).toContain(`requestId=${original}`); expect(text).toContain("stepId=00abcdef"); expect(text).toContain("remains unknown");
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(text).not.toContain("private-"); expect(text).not.toContain("title-secret"); expect(text).not.toContain("Step added.");
  });
  it("does not reuse the default pre-read as an observation when .r1 fails", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json(previous)).mockRejectedValueOnce(new Error("private-post-failure")).mockRejectedValueOnce(new Error("private-read-failure"));
    const error = await failure(f, f.args()); const text = formatError(error);
    expect(f.fetch).toHaveBeenCalledTimes(3); expect(text).toContain("No current observation"); expect(text).not.toContain("Current facts only"); expect(text).not.toContain("private-"); expect(f.context.stdout).not.toHaveBeenCalled();
  });
  it("does not observe another principal after a malformed successful POST", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(new Response("{", { status: 201, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } })).mockResolvedValueOnce(json(previous, 200, { "Daynight-User-ID": taskId }));
    const error = await failure(f, f.args(["--if-version=1"])); expect(f.fetch).toHaveBeenCalledTimes(2); expect(formatError(error)).toContain("No current observation"); expect(formatError(error)).not.toContain("Current facts only");
  });
  it.each(["cancelled", "deadline", "total"] as const)("makes no detached observation after whole-operation %s", async (kind) => {
    const f = fixture(kind === "deadline" ? { totalMs: 20, requestMs: 100 } : kind === "total" ? { totalBytes: 10 } : undefined);
    f.fetch.mockImplementation(async (_url, options) => {
      if (kind === "cancelled") { f.operation.dispose(); throw new Error("private-cancel"); }
      if (kind === "total") return json(resource(parseApiJson(String(options!.body)) as AddTaskStepInput), 201, { Location: `/api/v1/projects/${projectId}/tasks/${taskId}/steps/00abcdef` });
      return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }));
    });
    const error = await failure(f, f.args(["--if-version=1"])); expect(f.fetch).toHaveBeenCalledOnce(); expect(formatError(error)).toContain("outcome=unknown"); expect(formatError(error)).toContain("No current observation"); expect(formatError(error)).not.toContain("recoveryRequestId=");
  });
  it("does not start recovery when an unconfirmed response exactly exhausts total bytes", async () => {
    const f = fixture({ totalBytes: 2 });
    f.fetch.mockResolvedValue(new Response("{}", { status: 201, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, Location: `/api/v1/projects/${projectId}/tasks/${taskId}/steps/00abcdef` } }));
    const error = await failure(f, f.args(["--if-version=1"]));
    expect(f.operation.remainingBytes()).toBe(0); expect(f.operation.signal.aborted).toBe(false);
    expect(f.fetch).toHaveBeenCalledOnce(); expect(formatError(error)).toContain("outcome=unknown");
    expect(formatError(error)).toContain("No current observation"); expect(formatError(error)).not.toContain("recoveryRequestId=");
  });
  it("accepts a complete validated Add receipt at the exact total byte budget", async () => {
    const input: AddTaskStepInput = { version: 1n, id: "00abcdef", title: "  title-secret\n\uFEFF  " };
    const expected = resource(input);
    const f = fixture({ totalBytes: Buffer.byteLength(stringifyApiJson(expected), "utf8") });
    await runTaskCommand(f.args(["--if-version=1", "--json"]), f.context, f.dependencies);
    expect(f.operation.remainingBytes()).toBe(0); expect(f.operation.signal.aborted).toBe(false);
    expect(f.fetch).toHaveBeenCalledOnce(); expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(expected);
  });

  it.each(["request-timeout", "response-cap"] as const)("permits exactly one observation after live-operation %s", async (kind) => {
    const f = fixture(kind === "request-timeout" ? { requestMs: 20, totalMs: 1000 } : { responseBytes: 512 }); let posted = false;
    f.fetch.mockImplementation(async (_url, options) => {
      if (posted) return json({ ...previous, steps: [] });
      posted = true;
      if (kind === "response-cap") return new Response("X".repeat(1024), { status: 201, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
      return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }));
    });
    const error = await failure(f, f.args(["--if-version=1"])); expect(f.fetch).toHaveBeenCalledTimes(2); expect(formatError(error)).toContain("target=absent"); expect(formatError(error)).toContain("outcome=unknown"); expect(f.context.stdout).not.toHaveBeenCalled();
  });
  it("does not regenerate a generated identity or replay a collision", async () => {
    const f = fixture(); let sent: AddTaskStepInput | undefined;
    f.fetch.mockImplementation(async (_url, options) => { sent = parseApiJson(String(options!.body)) as AddTaskStepInput; return json({ error: { code: "step_id_conflict", message: "Step ID exists.", requestId: "conflict" } }, 409); });
    const error = await failure(f, f.args(["--if-version=1"]).filter((arg) => !arg.startsWith("--id=")));
    expect(f.fetch).toHaveBeenCalledOnce(); expect(formatError(error)).toContain(`stepId=${sent!.id}`); expect(formatError(error)).toContain("outcome=refused");
  });
  it("keeps a fully validated receipt confirmed when rendering is cancelled afterward", async () => {
    const f = fixture(); const add = f.api.addTaskStep;
    vi.spyOn(f.api, "addTaskStep").mockImplementation(async (...args) => { const result = await add(...args); f.operation.dispose(); return result; });
    const error = await failure(f, f.args(["--if-version=1"])); expect(f.fetch).toHaveBeenCalledOnce(); expect(formatError(error)).toContain("outcome=confirmed"); expect(formatError(error)).toContain("Step added."); expect(formatError(error)).not.toContain("outcome is unknown");
  });
  it("keeps output failure confirmed and hides the private output cause", async () => {
    const f = fixture(); f.context.stdoutBytes.mockRejectedValue(new Error("private-output-token"));
    const error = await failure(f, f.args(["--if-version=1", "--json"])); expect(f.fetch).toHaveBeenCalledOnce(); expect(formatError(error)).toContain("outcome=confirmed"); expect(formatError(error)).not.toContain("private-"); expect(formatError(error)).not.toContain("outcome is unknown");
  });
  it("retains the unchanged production operation defaults", () => {
    expect(DEFAULT_OPERATION_LIMITS).toEqual({ totalMs: 300000, requestMs: 30000, responseBytes: 134217728, totalBytes: 268435456 });
  });
});

describe("Step Add confirmed runtime output lifecycle", () => {
  it.each(["output", "cleanup"] as const)("keeps the validated Add confirmed across real runtime %s failure", async (stage) => {
    const f = fixture();
    const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/step-add-runtime-tests");
    await mkdir(temporary, { recursive: true });
    const home = await mkdtemp(path.join(temporary, "home-")); cleanups.push(() => rm(home, { recursive: true, force: true }));
    const state = path.join(home, ".daynight"); await mkdir(state);
    await writeFile(path.join(state, "config.yml"), "serverUrl: http://localhost:8787\nserverToken: fixture-token\n");
    vi.stubEnv("DN_CONFIG_DIR", state); f.context.homeDirectory.mockReturnValue(home);
    const signals = new EventEmitter();
    const context = { ...f.context, closeStdoutBytes: vi.fn(async () => { if (stage === "cleanup") throw new Error("private-cleanup-token"); }) } satisfies CliContext;
    if (stage === "output") context.stdoutBytes.mockRejectedValue(new Error("private-output-token"));
    const dependencies: TaskCommandDependencies = { ...f.dependencies,
      runServerCommand: (current, command) => runServerCommand(current, command, { fetch: f.fetch, signalEmitter: signals }),
    };
    const error = await runTaskCommand(f.args(["--if-version=1", "--json"]), context, dependencies).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ exitCode: 1 }); const text = formatError(error);
    expect(text).toContain("Step added. ID: 00abcdef"); expect(text).toContain(`local ${stage} failed`); expect(text).toContain(`requestId=${f.calls[0]!.requestId}`);
    expect(text).not.toContain("private-"); expect(text).not.toContain("title-secret"); expect(text).not.toContain("outcome is unknown");
    expect(f.fetch).toHaveBeenCalledOnce(); expect(context.closeStdoutBytes).toHaveBeenCalledOnce();
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) expect(signals.listenerCount(signal)).toBe(0);
  });

  it("retains0/1/2 at the actual application boundary with Add defined", async () => {
    const f = fixture(); const { taskDefinition } = await import("../../../src/commands/task/definition.js");
    const registry = [{ ...taskDefinition, load: async () => ({ run: (args: readonly string[], context: CliContext) => runTaskCommand(args, context, f.dependencies) }) }];
    expect(await runCli(["task", "step", "add", "--help"], f.context, registry)).toBe(0);
    expect(await runCli(["task", "step", "add", taskId, "--title= \u0085"], f.context, registry)).toBe(2);
    expect(f.fetch).not.toHaveBeenCalled();
    f.fetch.mockResolvedValue(json({ error: { code: "version_conflict", message: "Stale version.", requestId: "refused" } }, 409));
    expect(await runCli(["task", ...f.args(["--if-version=1"])], f.context, registry)).toBe(1);
    expect(f.context.stderr.mock.calls.at(-1)![0]).toContain("outcome=refused");
  });
});
