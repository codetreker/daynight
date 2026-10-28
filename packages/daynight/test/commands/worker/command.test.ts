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
const dependencies = () => ({ run: vi.fn<WorkerCommandDependencies["run"]>(async () => {}), manage: vi.fn<WorkerCommandDependencies["manage"]>(async () => {}) });

describe("worker command", () => {
  it.each([[], ["--help"], ["-h"], ...["run", "retry", "release", "transfer", "resume"].flatMap((name) => [[name, "--help"], [name, "-h"]])])("prints help without loading worker runtime or reading home %j", async (...args) => {
    const { cli, output } = context();
    const run = vi.fn(async () => { throw new Error("Help must not run a worker."); });
    await runWorkerCommand(args, cli, { ...dependencies(), run });
    expect(output.join("")).toContain("Usage: daynight worker");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([["run", "extra"], ["run", "--config", "elsewhere"], ["run", "--platform", "linux"], ["run", "--state-directory", "elsewhere"], ["run", "--version"], ["other"]])("rejects invalid syntax before runtime startup %j", async (...args) => {
    const { cli } = context();
    const run = vi.fn(async () => {});
    await expect(runWorkerCommand(args, cli, { ...dependencies(), run })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("passes startup home, installed package and frontend output to the foreground runtime", async () => {
    const { cli, errors } = context();
    cli.homeDirectory = () => path.resolve("worker-home");
    const run = vi.fn<WorkerCommandDependencies["run"]>(async (options) => { options.log?.("worker started\n"); });
    await runWorkerCommand(["run"], cli, { ...dependencies(), run });
    expect(run).toHaveBeenCalledExactlyOnceWith({ homeDirectory: cli.homeDirectory(), packageDirectory: cli.packageDirectory, log: expect.any(Function) });
    expect(errors).toEqual(["worker started\n"]);
  });

  it("registers public help and both shell completions through the shared command tree", async () => {
    const { cli, output } = context();
    expect(await runCli(["--help"], cli)).toBe(0);
    expect(output.join("")).toContain("worker");
    const definition = commandTree.commands!.find(({ name }) => name === "worker")!;
    expect(definition.commands!.map(({ name }) => name)).toEqual(["run", "retry", "release", "transfer", "resume"]);
    expect(renderBashCompletion(commandTree)).toContain("'worker'");
    expect(renderZshCompletion(commandTree)).toContain("worker:Run automatically claimed tasks");
    expect(renderBashCompletion(commandTree)).toContain("dn_children=('run' 'retry' 'release' 'transfer' 'resume')");
    expect(renderZshCompletion(commandTree)).toContain("--target-agent");
    const transfer = definition.commands!.find(({ name }) => name === "transfer")!;
    expect(renderBashCompletion(transfer)).toContain("dn_value_choices=('codex' 'copilot' 'claude')");
    expect(renderBashCompletion(transfer)).toContain("dn_value_choices=('windows' 'linux' 'macos')");
    expect(renderZshCompletion(transfer)).toContain("('\\''codex'\\'' '\\''copilot'\\'' '\\''claude'\\'')");
  });

  it.each(["retry", "release", "resume"] as const)("passes canonical %s identity and exact int64 version to the shared controller", async (kind) => {
    const { cli, errors } = context();
    cli.homeDirectory = () => path.resolve("worker-home");
    const deps = dependencies();
    deps.manage.mockImplementation(async ({ log }) => { log?.(`claim=${claimId} waiting\n`); });
    await runWorkerCommand([kind, taskId.toUpperCase(), `--claim-id=${claimId.toUpperCase()}`, "--project", projectId.toUpperCase(), ...(kind === "retry" ? [] : ["--if-version", "9223372036854775807"])], cli, deps);
    expect(deps.manage).toHaveBeenCalledExactlyOnceWith({ homeDirectory: cli.homeDirectory(), packageDirectory: cli.packageDirectory, log: expect.any(Function), request: { kind, taskId, claimId, projectId, ...(kind === "retry" ? {} : { version: 9_223_372_036_854_775_807n }) } });
    expect(deps.run).not.toHaveBeenCalled();
    expect(errors).toEqual([`claim=${claimId} waiting\n`]);
  });

  it("passes a separately identified fresh transfer target without inventing target resources", async () => {
    const { cli } = context();
    cli.homeDirectory = () => path.resolve("worker-home");
    const deps = dependencies();
    await runWorkerCommand(["transfer", taskId, "--claim-id", claimId, "--if-version", "9007199254740993", "--target-user-id", projectId.toUpperCase(), "--target-worker-id", taskId, "--target-machine-id", claimId, "--target-machine-name", "Target machine", "--target-platform", "windows", "--target-agent", "copilot"], cli, deps);
    expect(deps.manage.mock.calls[0]![0].request).toEqual({ kind: "transfer", taskId, claimId, version: 9_007_199_254_740_993n, target: { userId: projectId, workerId: taskId, machine: { id: claimId, name: "Target machine" }, platform: "windows", agent: "copilot", agentControlMode: "herdr" } });
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


it.each(["codex", "claude"])("passes a %s web transfer target", async (agent) => {
  const { cli } = context(); cli.homeDirectory = () => path.resolve("worker-home");
  const deps = dependencies();
  await runWorkerCommand(["transfer", taskId, "--claim-id", claimId, "--if-version", "1", "--target-user-id", projectId, "--target-worker-id", taskId, "--target-machine-id", claimId, "--target-machine-name", "Target", "--target-platform", "linux", "--target-agent", agent, "--target-agent-control-mode", "web"], cli, deps);
  expect(deps.manage.mock.calls[0]![0].request).toMatchObject({ kind: "transfer", target: { agent, agentControlMode: "web" } });
});
