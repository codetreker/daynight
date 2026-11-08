import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import type { Project, SetTaskStepStatusInput, StepsResource, TaskStep, UpdateTaskStepInput } from "../../../src/api/types.js";
import type { OperationLimits } from "../../../src/api/operation.js";
import { runCli } from "../../../src/cli/application.js";
import { UsageError } from "../../../src/cli/context.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";
import { formatError } from "../../../src/platform/diagnostics.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333";
const time = "2026-11-03T10:11:12.123456Z";
const changedTime = "2026-11-04T10:11:12.123456Z";
const target: TaskStep = { id: "00abcdef", title: "Existing", description: "# Retained Markdown", status: "todo", createdAt: time, updatedAt: time };
const other: TaskStep = { ...target, id: "00000000", title: "Other", status: "in_progress" };
const previous: StepsResource = { projectId, taskId, version: 9_007_199_254_740_993n, steps: [other, target] };
type Name = "update" | "set-status";
type Input = UpdateTaskStepInput | SetTaskStepStatusInput;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(stringifyApiJson(value), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, ...headers } });
const resource = (input: Input): StepsResource => {
  const fields = "status" in input ? { status: input.status } : { ...(input.title === undefined ? {} : { title: input.title }), ...(input.description === undefined ? {} : { description: input.description }) };
  const next = { ...target, ...fields };
  const changed = next.title !== target.title || next.description !== target.description || next.status !== target.status;
  return { projectId, taskId, version: input.version + (changed ? 1n : 0n), steps: [other, { ...next, updatedAt: changed ? changedTime : time }] };
};
const fixture = (limits?: Partial<OperationLimits>) => {
  const operation = createOperation(limits === undefined ? {} : { limits }); cleanups.push(() => operation.dispose());
  const calls: { method: string; path: string; requestId: string | null; body?: Input }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
    const requestId = new Headers(options?.headers).get("X-Request-ID");
    const body = options?.body === undefined ? undefined : parseApiJson(String(options.body)) as Input;
    calls.push({ method: options!.method!, path: new URL(String(url)).pathname, requestId, ...(body === undefined ? {} : { body }) });
    return options!.method === "GET" ? json(previous) : json(resource(body!), 200, { "X-Request-ID": requestId! });
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
  const args = (name: Name, more: readonly string[] = []) => ["step", name, taskId.toUpperCase(), "00ABCDEF", ...(name === "update" ? ["--title=  title-secret\n\uFEFF  "] : ["skipped"]), `--project=${projectId.toUpperCase()}`, ...more];
  return { operation, calls, fetch, api, context, dependencies, args };
};
const failure = (f: ReturnType<typeof fixture>, args: readonly string[]) => runTaskCommand(args, f.context, f.dependencies).catch((cause: unknown) => cause);
const method = (name: Name) => name === "update" ? "PATCH" : "PUT";
const label = (name: Name) => name === "update" ? "Update" : "Set-status";

describe("Step update and status input", () => {
  it.each(["update", "set-status"] as const)("keeps %s help before every I/O", async (name) => {
    const f = fixture(); await runTaskCommand(["step", name, "--help"], f.context, f.dependencies);
    expect(f.context.stdout.mock.calls[0]![0]).toContain("--if-version");
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled(); expect(f.context.homeDirectory).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["update", taskId, target.id], ["update", "bad", target.id, "--title=valid"], ["update", taskId, "prefix", "--title=valid"],
    ["update", taskId, target.id, "--project=bad", "--title=valid"],
    ...["", " \u0085", "\0", "\ud800"].map((title) => ["update", taskId, target.id, `--title=${title}`]),
    ...["\0", "\ud800"].map((description) => ["update", taskId, target.id, `--description=${description}`]),
    ["update", taskId, target.id, "--title=valid", "--status=done"], ["set-status", taskId, target.id, "DONE"],
    ["set-status", taskId, target.id, "done", "--title=private-title"],
    ...["0", "-1", "1e2", "1.5", "9223372036854775808"].map((version) => ["update", taskId, target.id, "--title=valid", `--if-version=${version}`]),
  ].map((args) => ({ args })))("rejects illegal input before configuration or network %#", async ({ args }) => {
    const f = fixture(); const error = await failure(f, ["step", ...args]);
    if (error instanceof UsageError) expect(error.helpCommand).toMatch(/^daynight task step (?:update|set-status) --help$/);
    else { expect(error).toMatchObject({ exitCode: 2 }); expect(formatError(error)).not.toContain("private-"); }
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("preserves simultaneous raw fields and exact int64 in one canonical PATCH", async () => {
    const f = fixture(); const description = "  # body-secret\n\r\n\\  ";
    await runTaskCommand(f.args("update", ["--if-version=9007199254740993", `--description=${description}`, "--json"]), f.context, f.dependencies);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]).toMatchObject({ method: "PATCH", path: `/api/v1/projects/${projectId}/tasks/${taskId}/steps/00abcdef`, body: { version: previous.version, title: "  title-secret\n\uFEFF  ", description } });
    expect(f.calls[0]!.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(resource(f.calls[0]!.body!));
    expect(f.dependencies.resolveProject).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled();
  });
  it("sends explicit empty description without a title and preserves the omitted field", async () => {
    const f = fixture();
    await runTaskCommand(["step", "update", taskId, target.id, "--description=", `--project=${projectId}`, "--json"], f.context, f.dependencies);
    expect(f.calls.map(({ method }) => method)).toEqual(["GET", "PATCH"]); expect(f.calls[1]!.body).toEqual({ version: previous.version, description: "" });
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toMatchObject({ steps: [other, { ...target, description: "", updatedAt: changedTime }] });
  });
  it.each(["todo", "in_progress", "done", "skipped"])("sends only status and version for %s", async (status) => {
    const f = fixture(); await runTaskCommand(["step", "set-status", taskId, "00ABCDEF", status, `--project=${projectId}`, `--if-version=${previous.version}`, "--json"], f.context, f.dependencies);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]).toMatchObject({ method: "PUT", path: `/api/v1/projects/${projectId}/tasks/${taskId}/steps/00abcdef/status`, body: { version: previous.version, status } });
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(resource(f.calls[0]!.body!));
  });
  it.each(["update", "set-status"] as const)("uses one GET then %s write and keeps confirmed no-op times", async (name) => {
    const f = fixture();
    const args = name === "update" ? ["step", name, taskId, target.id, `--title=${target.title}`] : ["step", name, taskId, target.id, target.status];
    await runTaskCommand([...args, `--project=${projectId}`, "--json"], f.context, f.dependencies);
    expect(f.calls.map(({ method }) => method)).toEqual(["GET", method(name)]); expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual(previous);
  });
  it.each(["update", "set-status"] as const)("stops %s after failed pre-read", async (name) => {
    const f = fixture(); f.fetch.mockResolvedValue(json({ error: { code: "internal_error", message: "Read failed.", requestId: "pre-read" } }, 500));
    const error = await failure(f, f.args(name)); expect(f.fetch).toHaveBeenCalledOnce(); expect(f.context.stdout).not.toHaveBeenCalled(); expect(formatError(error)).toContain("outcome=failed"); expect(formatError(error)).not.toContain("outcome is unknown");
  });
});

describe("Step update and status write outcomes", () => {
  it.each([["title", "é".repeat(512) + "x", 1025, 1024], ["description", "界".repeat(21845) + "ab", 65537, 65536]] as const)("forwards excess %s and reports the server field refusal", async (field, value, actual, max) => {
    const f = fixture();
    f.fetch.mockImplementation(async (_url, options) => {
      const body = parseApiJson(String(options!.body)) as UpdateTaskStepInput;
      expect(body[field]).toBe(value);
      return json({ error: { code: "invalid_input", message: `${field}: ${actual} bytes exceeds maximum ${max}`, requestId: "field-refusal" } }, 400);
    });
    const args = f.args("update", ["--if-version=1"]).filter((arg) => field !== "title" || !arg.startsWith("--title="));
    const error = await failure(f, [...args, `--${field}=${value}`]);
    const diagnostic = formatError(error);
    expect(diagnostic).toContain("code=invalid_input"); expect(diagnostic).toContain("outcome=refused");
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.context.stdout).not.toHaveBeenCalled();
  });
  it.each(["update", "set-status"] as const)("keeps %s refusal metadata without recovery or replay", async (name) => {
    const f = fixture(); let original = "";
    f.fetch.mockImplementation(async (_url, options) => { original = new Headers(options?.headers).get("X-Request-ID")!; return json({ error: { code: "steps_limit_exceeded", message: "Collection is full.", requestId: "server-body-id", details: { encodedBytes: 67_108_865, maxEncodedBytes: 67_108_864 } } }, 409, { "X-Request-ID": "server-header-id" }); });
    const error = await failure(f, f.args(name, ["--if-version=1", "--json"])); const text = formatError(error);
    expect(text).toContain("outcome=refused"); expect(text).toContain(`operation=task.step.${name}`); expect(text).toContain(`requestId=${original}`); expect(text).toContain("serverRequestId=server-body-id"); expect(text).toContain("responseRequestId=server-header-id"); expect(text).toContain('"encodedBytes":67108865'); expect(text).toContain('"maxEncodedBytes":67108864');
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.context.stdout).not.toHaveBeenCalled(); expect(text).not.toContain("title-secret");
  });
  it.each(["update", "set-status"] as const)("reports %s stale-version refusal without retry", async (name) => {
    const f = fixture(); f.fetch.mockResolvedValue(json({ error: { code: "version_conflict", message: "Stale version.", requestId: "conflict" } }, 409));
    const error = await failure(f, f.args(name, ["--if-version=1"])); expect(f.fetch).toHaveBeenCalledOnce(); expect(formatError(error)).toContain("outcome=refused"); expect(formatError(error)).toContain("version_conflict");
  });
  it.each(["update", "set-status"] as const)("reports %s missing, stale or exhausted refusal near maximum version without retry", async (name) => {
    const { taskDefinition } = await import("../../../src/commands/task/definition.js");
    for (const [status, code, version] of [[404, "not_found", "9223372036854775807"], [409, "version_exhausted", "9223372036854775807"], [409, "version_conflict", "9223372036854775806"]] as const) {
      const f = fixture();
      f.fetch.mockResolvedValue(json({ error: { code, message: "Write refused.", requestId: "maximum-refusal" } }, status));
      const registry = [{ ...taskDefinition, load: async () => ({ run: (args: readonly string[], context: CliContext) => runTaskCommand(args, context, f.dependencies) }) }];
      const exit = await runCli(["task", ...f.args(name, [`--if-version=${version}`, "--json"])], f.context, registry);
      expect(exit).toBe(1);
      expect(f.context.stdout).not.toHaveBeenCalled(); expect(f.context.stdoutBytes).not.toHaveBeenCalled();
      const diagnostic = f.context.stderr.mock.calls.map(([text]) => text).join("");
      expect(diagnostic).toContain(`code=${code}`); expect(diagnostic).toContain("outcome=refused");
      expect(diagnostic.toLowerCase()).not.toContain("outcome is unknown");
      expect(f.fetch).toHaveBeenCalledOnce();
      const [url, options] = f.fetch.mock.calls[0]!;
      expect(options!.method).toBe(method(name));
      expect(new URL(String(url)).pathname).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}/steps/${target.id}${name === "set-status" ? "/status" : ""}`);
      expect(parseApiJson(String(options!.body))).toMatchObject({ version: BigInt(version) });
    }
  });
  it.each(["update", "set-status"] as const)("keeps %s authentication guidance", async (name) => {
    const f = fixture(); f.fetch.mockResolvedValue(json({ error: { code: "unauthenticated", message: "Sign in.", requestId: "auth" } }, 401));
    const error = await failure(f, f.args(name, ["--if-version=1"])); expect(f.fetch).toHaveBeenCalledOnce(); expect(formatError(error)).toContain("daynight login"); expect(formatError(error)).toContain("outcome=refused");
  });
  it.each(["update", "set-status"] as const)("keeps unknown %s after its one correlated current-state observation", async (name) => {
    const f = fixture(); let original = "";
    f.fetch.mockImplementation(async (_url, options) => {
      const requestId = new Headers(options?.headers).get("X-Request-ID")!;
      if (options?.method !== "GET") { original = requestId; throw new Error("private-network-token-url"); }
      expect(requestId).toBe(`${original}.r1`); return json({ ...previous, version: 57n });
    });
    const error = await failure(f, f.args(name, ["--if-version=1", "--json"])); const text = formatError(error);
    expect(f.fetch).toHaveBeenCalledTimes(2); expect(text).toContain(`The Step ${label(name)} outcome is unknown.`); expect(text).toContain("version=57 target=found"); expect(text).toContain(`requestId=${original}`); expect(text).toContain(`recoveryRequestId=${original}.r1`); expect(text).toContain("stepId=00abcdef"); expect(text).toContain("remains unknown");
    expect(f.context.stdout).not.toHaveBeenCalled(); expect(text).not.toContain("private-"); expect(text).not.toContain("title-secret");
  });
  it("does not claim that a current absence caused the unknown update", async () => {
    const f = fixture(); f.fetch.mockRejectedValueOnce(new Error("private-network")).mockResolvedValueOnce(json({ ...previous, steps: [] }));
    const error = await failure(f, f.args("update", ["--if-version=1"])); const text = formatError(error);
    expect(text).toContain("target=absent"); expect(text).toContain("remains unknown"); expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("does not use a previous resource when unknown-result observation fails", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json(previous)).mockRejectedValueOnce(new Error("private-write")).mockRejectedValueOnce(new Error("private-read"));
    const error = await failure(f, f.args("update")); expect(f.fetch).toHaveBeenCalledTimes(3); expect(formatError(error)).toContain("No current observation"); expect(formatError(error)).not.toContain("Current facts only");
  });
  it.each(["update", "set-status"] as const)("observes malformed successful %s receipt without confirming it", async (name) => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({ ...resource({ version: 1n, status: "skipped" }), version: 8n })).mockResolvedValueOnce(json(previous));
    const error = await failure(f, f.args(name, ["--if-version=1", "--json"])); expect(f.fetch).toHaveBeenCalledTimes(2); expect(formatError(error)).toContain("outcome=unknown"); expect(f.context.stdout).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "deadline", "total"] as const)("does not detach a recovery after whole-operation %s", async (kind) => {
    const f = fixture(kind === "deadline" ? { totalMs: 20, requestMs: 100 } : kind === "total" ? { totalBytes: 2 } : undefined);
    f.fetch.mockImplementation(async (_url, options) => {
      if (kind === "cancelled") { f.operation.dispose(); throw new Error("private-cancel"); }
      if (kind === "total") return new Response("{}", { status: 200, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
      return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }));
    });
    const error = await failure(f, f.args("set-status", ["--if-version=1"])); expect(f.fetch).toHaveBeenCalledOnce(); expect(formatError(error)).toContain("outcome=unknown"); expect(formatError(error)).not.toContain("recoveryRequestId="); expect(formatError(error)).toContain("No current observation");
  });
  it.each(["update", "set-status"] as const)("keeps %s confirmed after render cancellation or output failure", async (name) => {
    for (const phase of ["render", "output"] as const) {
      const f = fixture();
      if (phase === "render") {
        if (name === "update") { const write = f.api.updateTaskStep; vi.spyOn(f.api, "updateTaskStep").mockImplementation(async (...args) => { const result = await write(...args); f.operation.dispose(); return result; }); }
        else { const write = f.api.setTaskStepStatus; vi.spyOn(f.api, "setTaskStepStatus").mockImplementation(async (...args) => { const result = await write(...args); f.operation.dispose(); return result; }); }
      } else f.context.stdoutBytes.mockRejectedValue(new Error("private-output"));
      const error = await failure(f, f.args(name, ["--if-version=1", "--json"])); expect(f.fetch).toHaveBeenCalledOnce(); expect(formatError(error)).toContain("outcome=confirmed"); expect(formatError(error)).not.toContain("outcome is unknown"); expect(formatError(error)).not.toContain("private-");
    }
  });
});

describe("Step update runtime and CLI boundary", () => {
  it.each(["update", "set-status"] as const)("keeps %s confirmed through actual runtime cleanup failure", async (name) => {
    const f = fixture(); const base = path.resolve(import.meta.dirname, "../../../../../.tmp/step-update-runtime-tests");
    await mkdir(base, { recursive: true }); const home = await mkdtemp(path.join(base, "home-")); cleanups.push(() => rm(home, { recursive: true, force: true }));
    const state = path.join(home, ".daynight"); await mkdir(state); await writeFile(path.join(state, "config.yml"), "serverUrl: http://localhost:8787\nserverToken: fixture-token\n");
    vi.stubEnv("DN_CONFIG_DIR", state); f.context.homeDirectory.mockReturnValue(home); const signals = new EventEmitter();
    const context = { ...f.context, closeStdoutBytes: vi.fn(async () => { throw new Error("private-cleanup"); }) } satisfies CliContext;
    const dependencies: TaskCommandDependencies = { ...f.dependencies, runServerCommand: (current, command) => runServerCommand(current, command, { fetch: f.fetch, signalEmitter: signals }) };
    const error = await runTaskCommand(f.args(name, ["--if-version=1", "--json"]), context, dependencies).catch((cause: unknown) => cause); const text = formatError(error);
    expect(error).toMatchObject({ exitCode: 1 }); expect(text).toContain(name === "update" ? "Step updated. ID: 00abcdef" : "Step status set. ID: 00abcdef"); expect(text).toContain("local cleanup failed"); expect(text).not.toContain("private-"); expect(text).not.toContain("outcome is unknown"); expect(f.fetch).toHaveBeenCalledOnce(); expect(context.closeStdoutBytes).toHaveBeenCalledOnce();
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) expect(signals.listenerCount(signal)).toBe(0);
  });
  it("retains success0, failure1 and usage2 at the application boundary", async () => {
    const f = fixture(); const { taskDefinition } = await import("../../../src/commands/task/definition.js");
    const registry = [{ ...taskDefinition, load: async () => ({ run: (args: readonly string[], context: CliContext) => runTaskCommand(args, context, f.dependencies) }) }];
    expect(await runCli(["task", "step", "update", "--help"], f.context, registry)).toBe(0);
    expect(await runCli(["task", "step", "update", taskId, target.id], f.context, registry)).toBe(2); expect(f.fetch).not.toHaveBeenCalled();
    expect(await runCli(["task", ...f.args("update", ["--if-version=1", "--json"])], f.context, registry)).toBe(0);
    f.fetch.mockResolvedValue(json({ error: { code: "version_conflict", message: "Stale.", requestId: "conflict" } }, 409));
    expect(await runCli(["task", ...f.args("set-status", ["--if-version=1"])], f.context, registry)).toBe(1);
  });
});
