import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CliContext } from "../../../src/cli/context.js";
import { runCli } from "../../../src/cli/application.js";
import { commandTree } from "../../../src/cli/commands.js";
import { renderBashCompletion } from "../../../src/commands/completion/bash.js";
import { renderZshCompletion } from "../../../src/commands/completion/zsh.js";
import { runWorkerCommand } from "../../../src/commands/worker/index.js";
import type { WorkerCommandDependencies } from "../../../src/commands/worker/index.js";

const context = () => {
  const output: string[] = [];
  const errors: string[] = [];
  const cli: CliContext = {
    version: "1.0.0", packageDirectory: path.resolve("package"),
    homeDirectory: () => { throw new Error("Informational commands must not inspect home."); },
    workingDirectory: () => { throw new Error("Worker commands must not inspect cwd."); },
    stdout: (text) => { output.push(text); }, stderr: (text) => { errors.push(text); },
    stdoutBytes: async () => { throw new Error("Worker commands must not use binary output."); },
  };
  return { cli, output, errors };
};
const taskId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const claimId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const projectId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const dependencies = () => ({
  setup: vi.fn<WorkerCommandDependencies["setup"]>(async () => {}),
  attach: vi.fn<WorkerCommandDependencies["attach"]>(async () => {}),
  prepareRepositories: vi.fn<WorkerCommandDependencies["prepareRepositories"]>(async () => {}),
  repository: vi.fn<WorkerCommandDependencies["repository"]>(async () => {}),
  run: vi.fn<WorkerCommandDependencies["run"]>(async () => {}),
  manage: vi.fn<WorkerCommandDependencies["manage"]>(async () => {}),
});

describe("worker command", () => {
  it.each([[], ["--help"], ["-h"], ...["setup", "run", "attach", "repo", "retry", "release", "resume"].flatMap((name) => [[name, "--help"], [name, "-h"]]),
    ...["list", "add", "remove"].flatMap((name) => [["repo", name, "--help"], ["repo", name, "-h"]])])("prints help without loading worker runtime or reading home %j", async (...args) => {
    const { cli, output } = context();
    const deps = dependencies();
    await runWorkerCommand(args, cli, deps);
    expect(output.join("")).toContain("Usage: daynight worker");
    for (const action of Object.values(deps)) expect(action).not.toHaveBeenCalled();
  });

  it.each([["setup", "extra"], ["setup", "--agent", "codex"], ["attach", "extra"], ["attach", "--session", "w"], ["attach", "--claim-id", claimId], ["run", "extra"], ["run", "--config", "elsewhere"], ["run", "--platform", "linux"], ["run", "--state-directory", "elsewhere"], ["run", "--version"], ["other"]])("rejects invalid syntax before runtime startup %j", async (...args) => {
    const { cli } = context();
    const run = vi.fn(async () => {});
    await expect(runWorkerCommand(args, cli, { ...dependencies(), run })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("passes startup context and defers repository preparation to the foreground runtime's signal", async () => {
    const { cli, errors } = context();
    cli.homeDirectory = () => path.resolve("worker-home");
    cli.workingDirectory = vi.fn(() => path.resolve("startup-directory"));
    const run = vi.fn<WorkerCommandDependencies["run"]>(async (options) => { options.log?.("worker started\n"); });
    const deps = { ...dependencies(), run };
    await runWorkerCommand(["run"], cli, deps);
    expect(deps.prepareRepositories).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledExactlyOnceWith({ homeDirectory: cli.homeDirectory(), packageDirectory: cli.packageDirectory, version: cli.version, workingDirectory: path.resolve("startup-directory"), log: expect.any(Function), prepareRepositories: expect.any(Function) });
    expect(cli.workingDirectory).toHaveBeenCalledOnce();
    expect(errors).toEqual(["worker started\n"]);
    const signal = new AbortController().signal;
    await run.mock.calls[0]![0].prepareRepositories!(signal);
    expect(deps.prepareRepositories).toHaveBeenCalledExactlyOnceWith(cli, signal);
  });

  it("routes setup without inspecting home or loading a worker controller", async () => {
    const { cli } = context();
    const deps = dependencies();
    await runWorkerCommand(["setup"], cli, deps);
    expect(deps.setup).toHaveBeenCalledExactlyOnceWith(cli);
    for (const [name, action] of Object.entries(deps)) if (name !== "setup") expect(action).not.toHaveBeenCalled();
  });

  it("attaches using only the current home without loading the task controller", async () => {
    const { cli } = context();
    cli.homeDirectory = () => path.resolve("worker-home");
    const deps = dependencies();
    await runWorkerCommand(["attach"], cli, deps);
    expect(deps.attach).toHaveBeenCalledExactlyOnceWith({ homeDirectory: cli.homeDirectory() });
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.manage).not.toHaveBeenCalled();
  });

  it("registers public help and both shell completions through the shared command tree", async () => {
    const { cli, output } = context();
    expect(await runCli(["--help"], cli)).toBe(0);
    expect(output.join("")).toContain("worker");
    const definition = commandTree.commands!.find(({ name }) => name === "worker")!;
    expect(definition.commands!.map(({ name }) => name)).toEqual(["setup", "run", "attach", "repo", "retry", "release", "resume"]);
    expect(renderBashCompletion(commandTree)).toContain("'worker'");
    expect(renderZshCompletion(commandTree)).toContain("worker:Run automatically claimed tasks");
    expect(renderBashCompletion(commandTree)).toContain("dn_children=('setup' 'run' 'attach' 'repo' 'retry' 'release' 'resume')");
    expect(renderBashCompletion(commandTree)).toContain("dn_children=('list' 'add' 'remove')");
    expect(renderZshCompletion(commandTree)).toContain("repo:Manage repositories selected from existing Daynight Projects");
    expect(renderBashCompletion(commandTree)).not.toContain("--target-agent");
    expect(renderZshCompletion(commandTree)).not.toContain("--target-agent");
    expect(renderBashCompletion(commandTree)).not.toContain("migrate-workspaces");
    expect(renderZshCompletion(commandTree)).not.toContain("migrate-workspaces");
  });

  it.each([["migrate-workspaces"], ["migrate-workspaces", "--rollback"]])("rejects the removed workspace command without accessing state %j", async (...args) => {
    const { cli } = context();
    const deps = dependencies();
    await expect(runWorkerCommand(args, cli, deps)).rejects.toThrow();
    for (const action of Object.values(deps)) expect(action).not.toHaveBeenCalled();
  });

  it("preserves a repository preparation failure returned through the runtime callback", async () => {
    const { cli } = context();
    cli.homeDirectory = () => path.resolve("worker-home");
    const deps = dependencies();
    cli.workingDirectory = () => path.resolve("startup-directory");
    const failure = new Error("Project selection cancelled.");
    const signal = new AbortController().signal;
    deps.prepareRepositories.mockRejectedValueOnce(failure);
    deps.run.mockImplementation(async ({ prepareRepositories }) => { await prepareRepositories!(signal); });
    await expect(runWorkerCommand(["run"], cli, deps)).rejects.toBe(failure);
    expect(deps.run).toHaveBeenCalledOnce();
    expect(deps.prepareRepositories).toHaveBeenCalledExactlyOnceWith(cli, signal);
    expect(deps.manage).not.toHaveBeenCalled();
  });

  it.each([
    { args: ["repo", "list"], request: { kind: "list", json: false } },
    { args: ["repo", "list", "--json"], request: { kind: "list", json: true } },
    { args: ["repo", "add"], request: { kind: "add" } },
    { args: ["repo", "remove"], request: { kind: "remove" } },
    { args: ["repo", "add", "--project", projectId.toUpperCase()], request: { kind: "add", projectId } },
    { args: ["repo", "remove", `--project=${projectId.toUpperCase()}`], request: { kind: "remove", projectId } },
  ])("routes worker repository commands without loading execution: $args", async ({ args, request }) => {
    const { cli } = context();
    const deps = dependencies();
    await runWorkerCommand(args, cli, deps);
    expect(deps.repository).toHaveBeenCalledExactlyOnceWith(request, cli);
    expect(deps.prepareRepositories).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.manage).not.toHaveBeenCalled();
  });

  it.each([
    ["repo", "add", "https://github.com/example/repo"],
    ["repo", "remove", "https://github.com/example/repo"],
    ["repo", "add", "--project", "invalid"],
    ["repo", "remove", "--project", "invalid"],
    ["repo", "list", "--project", projectId],
    ["repo", "add", "--project", projectId, "--path", "/arbitrary"],
  ])("rejects unsafe repository command syntax before accessing configuration %j", async (...args) => {
    const { cli } = context();
    const deps = dependencies();
    await expect(runWorkerCommand(args, cli, deps)).rejects.toThrow();
    for (const action of Object.values(deps)) expect(action).not.toHaveBeenCalled();
  });

  it.each(["retry", "release", "resume"] as const)("passes canonical %s identity and exact int64 version to the shared controller", async (kind) => {
    const { cli, errors } = context();
    cli.homeDirectory = () => path.resolve("worker-home");
    const deps = dependencies();
    deps.manage.mockImplementation(async ({ log }) => { log?.(`claim=${claimId} waiting\n`); });
    await runWorkerCommand([kind, taskId.toUpperCase(), `--claim-id=${claimId.toUpperCase()}`, "--project", projectId.toUpperCase(), ...(kind === "retry" ? [] : ["--if-version", "9223372036854775807"])], cli, deps);
    expect(deps.manage).toHaveBeenCalledExactlyOnceWith({ homeDirectory: cli.homeDirectory(), packageDirectory: cli.packageDirectory, log: expect.any(Function), request: { kind, taskId, claimId, projectId, ...(kind === "retry" ? {} : { version: 9_223_372_036_854_775_807n }) } });
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.prepareRepositories).not.toHaveBeenCalled();
    expect(errors).toEqual([`claim=${claimId} waiting\n`]);
  });


  it.each([
    ["retry", taskId], ["retry", "invalid", "--claim-id", claimId], ["retry", taskId, "--claim-id", "invalid"],
    ["retry", taskId, "--claim-id", claimId, "--project", "invalid"],
    ["retry", taskId, "--claim-id", claimId, "--if-version", "1"],
    ["release", taskId, "--claim-id", claimId], ["resume", taskId, "--claim-id", claimId, "--if-version", "0"],
    ["release", taskId, "--claim-id", claimId, "--if-version", "9223372036854775808"],
    ["resume", taskId, "--claim-id", claimId, "--if-version", "1", "--continuity-confirmed"],
    ["transfer", taskId, "--claim-id", claimId, "--if-version", "1"],
  ])("rejects unsafe management syntax before inspecting home or loading a controller %j", async (...args) => {
    const { cli } = context();
    const deps = dependencies();
    await expect(runWorkerCommand(args, cli, deps)).rejects.toThrow();
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.manage).not.toHaveBeenCalled();
  });
});
