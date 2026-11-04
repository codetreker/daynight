import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import type { MoveTaskStepInput, Project, StepsResource, TaskStep } from "../../../src/api/types.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { formatError } from "../../../src/platform/diagnostics.js";
import { commandTree } from "../../../src/cli/commands.js";
import { renderBashCompletion } from "../../../src/commands/completion/bash.js";
import { renderZshCompletion } from "../../../src/commands/completion/zsh.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111", taskId = "bbbbbbbb-2222-4222-8222-222222222222", userId = "cccccccc-3333-4333-8333-333333333333";
const stamp = "2026-11-04T10:11:12.123456Z";
const step = (id: string): TaskStep => ({ id, title: "same\u001b[31m", description: "# retained", status: "done", createdAt: stamp, updatedAt: stamp });
const previous: StepsResource = { projectId, taskId, version: 9_007_199_254_740_993n, steps: [step("00000000"), step("00abcdef"), step("fedcba98")] };
const moved: StepsResource = { ...previous, version: previous.version + 1n, steps: [previous.steps[1]!, previous.steps[0]!, previous.steps[2]!] };
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach((dispose) => dispose()); });
const json = (value: unknown, status = 200, principal = userId) => new Response(stringifyApiJson(value), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": principal } });
const fixture = () => {
  const operation = createOperation(); disposals.push(() => operation.dispose());
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => options?.method === "GET" ? json(previous) : json(moved));
  const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
  const stdout = vi.fn<(text: string) => void>();
  const context = { version: "0.0.0", packageDirectory: "unused", homeDirectory: vi.fn(() => { throw new Error("private-config"); }), workingDirectory: vi.fn(() => "/"), stdout, stderr: vi.fn(), stdoutBytes: vi.fn<CliContext["stdoutBytes"]>(async (chunk) => { stdout(Buffer.from(chunk).toString("utf8")); }) } satisfies CliContext;
  const dependencies = { resolveProject: vi.fn<TaskCommandDependencies["resolveProject"]>().mockResolvedValue({ id: projectId } as Project), runServerCommand: vi.fn<TaskCommandDependencies["runServerCommand"]>(async (current, command) => { const output = await command({ api, operation, serverUrl: "http://localhost:8787" }); if (typeof output === "string") current.stdout(output); else if (output !== undefined) await current.stdoutBytes(Buffer.from(output.output), operation.signal); }) };
  const args = (more: readonly string[] = []) => ["step", "move", taskId.toUpperCase(), "00ABCDEF", `--project=${projectId.toUpperCase()}`, ...more];
  return { operation, fetch, api, context, dependencies, args };
};
const failure = (f: ReturnType<typeof fixture>, args: readonly string[]) => runTaskCommand(args, f.context, f.dependencies).catch((cause: unknown) => cause);

describe("Step Move arguments, discovery and budgets", () => {
  it("keeps help before inputs and configuration, and exposes all four positions in completion", async () => {
    const f = fixture(); await runTaskCommand(["step", "move", "--help"], f.context, f.dependencies);
    for (const option of ["--before", "--after", "--first", "--last", "--if-version"]) {
      expect(f.context.stdout.mock.calls[0]![0]).toContain(option);
      expect(renderBashCompletion(commandTree)).toContain(option); expect(renderZshCompletion(commandTree)).toContain(option);
    }
    expect(f.dependencies.runServerCommand).not.toHaveBeenCalled(); expect(f.context.homeDirectory).not.toHaveBeenCalled();
  });
  it.each([[], ["--first", "--last"], ["--before=00000000", "--after=fedcba98"], ["--first", "--before=00000000"], ["--before=00aBcDeF"], ["--after=00ABCDEF"], ["--before=bad"], ["--after=000000000"], ...["0", "-1", "1.5", "1e2", "9223372036854775808"].map((version) => ["--first", `--if-version=${version}`])].map((options) => ({ options })))("rejects illegal placement/version before business I/O %#", async ({ options }) => {
    const f = fixture(); const error = await failure(f, f.args(options));
    expect(error).toMatchObject({ exitCode: 2 }); expect(f.dependencies.runServerCommand).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(["bad", "000000000", projectId])("rejects illegal Step identity %s", async (id) => {
    const f = fixture(); const args = f.args(["--first"]); args[3] = id;
    expect(await failure(f, args)).toMatchObject({ exitCode: 2 }); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([["--first", { position: "first" }], ["--before=00000000", { before: "00000000" }], ["--after=FEDCBA98", { after: "fedcba98" }], ["--last", { position: "last" }]] as const)("sends exactly one explicit PUT for %s with canonical identity and exact version", async (option, placement) => {
    const f = fixture(); const steps = option === "--last" || option.startsWith("--after") ? [previous.steps[0]!, previous.steps[2]!, previous.steps[1]!] : moved.steps;
    f.fetch.mockResolvedValue(json({ ...moved, steps }));
    await runTaskCommand(f.args([option, "--if-version=9007199254740993", "--json"]), f.context, f.dependencies);
    expect(f.fetch).toHaveBeenCalledOnce(); const [url, options] = f.fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/steps/00abcdef/position`);
    expect(options!.method).toBe("PUT"); expect(parseApiJson(String(options!.body))).toEqual({ version: previous.version, ...placement });
    expect(new Headers(options!.headers).get("X-Request-ID")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseApiJson(f.context.stdout.mock.calls[0]![0])).toEqual({ ...moved, steps }); expect(f.dependencies.resolveProject).not.toHaveBeenCalled(); expect(f.context.workingDirectory).not.toHaveBeenCalled();
  });
  it("uses one GET Steps then one PUT and safe readable order by default", async () => {
    const f = fixture(); await runTaskCommand(f.args(["--first"]), f.context, f.dependencies);
    expect(f.fetch.mock.calls.map((call) => call[1]!.method)).toEqual(["GET", "PUT"]);
    expect(parseApiJson(String(f.fetch.mock.calls[1]![1]!.body))).toEqual({ version: previous.version, position: "first" });
    const output = f.context.stdout.mock.calls[0]![0]; expect(output).toContain("Step moved. ID: 00abcdef"); expect(output.indexOf("1. 00abcdef")).toBeLessThan(output.indexOf("2. 00000000")); expect(output).not.toContain("\u001b");
  });
  it("does not submit after failed pre-read and retains project discovery diagnostics", async () => {
    const f = fixture(); f.fetch.mockResolvedValue(json({ error: { code: "internal_error", message: "Read failed", requestId: "read" } }, 500));
    expect(formatError(await failure(f, f.args(["--first"])))).toContain("outcome=failed"); expect(f.fetch).toHaveBeenCalledOnce();
    const g = fixture(); const { ProjectDiscoveryError } = await import("../../../src/repository/discovery-error.js"); g.dependencies.resolveProject.mockRejectedValue(new ProjectDiscoveryError([projectId, taskId]));
    expect(formatError(await failure(g, g.args(["--first"]).filter((arg) => !arg.startsWith("--project="))))).toContain("--project <id>"); expect(g.fetch).not.toHaveBeenCalled();
  });
});

describe("Step Move unknown and confirmed result handling", () => {
  it.each([401, 404, 409, 410])("preserves known refusal %i without recovery or replay", async (status) => {
    const f = fixture(); f.fetch.mockResolvedValue(json({ error: { code: "version_conflict", message: "Refused\u001b", requestId: "observed" } }, status));
    const text = formatError(await failure(f, f.args(["--first", "--if-version=1"])));
    expect(text).toContain("outcome=refused"); expect(text).toContain("operation=task.step.move"); expect(text).toContain("stepId=00abcdef"); expect(text).not.toContain("\u001b");
    if (status === 401) expect(text).toContain("daynight login"); expect(f.fetch).toHaveBeenCalledOnce(); expect(f.context.stdout).not.toHaveBeenCalled();
  });
  it.each(["network", "protocol", "500", "missing"])("keeps %s unknown with one correlated current-state observation", async (kind) => {
    const f = fixture();
    f.fetch.mockImplementation(async (_url, options) => {
      if (options?.method === "GET") return json(kind === "missing" ? { ...previous, steps: [] } : moved);
      if (kind === "network" || kind === "missing") throw new Error("private-network");
      return kind === "500" ? json({ error: { code: "internal_error", message: "Failed", requestId: "server" } }, 500) : json({ ...moved, version: previous.version + 2n });
    });
    const text = formatError(await failure(f, f.args(["--first", "--if-version=9007199254740993", "--json"])));
    expect(f.fetch.mock.calls.map((call) => call[1]!.method)).toEqual(["PUT", "GET"]);
    const original = new Headers(f.fetch.mock.calls[0]![1]!.headers).get("X-Request-ID"); expect(new Headers(f.fetch.mock.calls[1]![1]!.headers).get("X-Request-ID")).toBe(`${original}.r1`);
    expect(text).toContain("The Step Move outcome is unknown."); expect(text).toContain(`target=${kind === "missing" ? "absent" : "found"}`); expect(text).toContain("The Move outcome remains unknown."); expect(text).not.toContain("private-"); expect(text).not.toContain("Step moved."); expect(f.context.stdout).not.toHaveBeenCalled();
  });
  it("does not replace a failed recovery with the old pre-read", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json(previous)).mockRejectedValueOnce(new Error("private-write")).mockRejectedValueOnce(new Error("private-read"));
    const text = formatError(await failure(f, f.args(["--first"]))); expect(f.fetch).toHaveBeenCalledTimes(3); expect(text).toContain("No current observation"); expect(text).not.toContain("private-");
  });
  it("never detaches recovery after operation cancellation", async () => {
    const f = fixture(); f.fetch.mockImplementation(async () => { f.operation.dispose(); throw new Error("private-cancel"); });
    const text = formatError(await failure(f, f.args(["--first", "--if-version=1"]))); expect(text).toContain("outcome=unknown"); expect(text).toContain("No current observation"); expect(f.fetch).toHaveBeenCalledOnce();
  });
  it.each(["render", "output"])("retains confirmed receipt after local %s failure", async (stage) => {
    const f = fixture();
    if (stage === "output") f.context.stdoutBytes.mockRejectedValue(new Error("private-output"));
    else { const move = f.api.moveTaskStep; vi.spyOn(f.api, "moveTaskStep").mockImplementation(async (...args) => { const result = await move(...args); f.operation.dispose(); return result; }); }
    const text = formatError(await failure(f, f.args(["--first", "--if-version=9007199254740993", "--json"]))); expect(text).toContain("outcome=confirmed"); expect(text).toContain("Step moved."); expect(text).not.toContain("unknown"); expect(text).not.toContain("private-"); expect(f.fetch).toHaveBeenCalledOnce();
  });
});
