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
const dependencies = () => ({ attach: vi.fn<WorkerCommandDependencies["attach"]>(async () => {}), run: vi.fn<WorkerCommandDependencies["run"]>(async () => {}), manage: vi.fn<WorkerCommandDependencies["manage"]>(async () => {}) });

describe("worker command", () => {
  it.each([[], ["--help"], ["-h"], ...["run", "attach", "retry", "release", "resume"].flatMap((name) => [[name, "--help"], [name, "-h"]])])("prints help without loading worker runtime or reading home %j", async (...args) => {
    const { cli, output } = context();
    const run = vi.fn(async () => { throw new Error("Help must not run a worker."); });
    await runWorkerCommand(args, cli, { ...dependencies(), run });
    expect(output.join("")).toContain("Usage: daynight worker");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([["attach", "extra"], ["attach", "--session", "w"], ["attach", "--claim-id", claimId], ["run", "extra"], ["run", "--config", "elsewhere"], ["run", "--platform", "linux"], ["run", "--state-directory", "elsewhere"], ["run", "--version"], ["other"]])("rejects invalid syntax before runtime startup %j", async (...args) => {
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
    expect(definition.commands!.map(({ name }) => name)).toEqual(["run", "attach", "retry", "release", "resume"]);
    expect(renderBashCompletion(commandTree)).toContain("'worker'");
    expect(renderZshCompletion(commandTree)).toContain("worker:Run automatically claimed tasks");
    expect(renderBashCompletion(commandTree)).toContain("dn_children=('run' 'attach' 'retry' 'release' 'resume')");
    expect(renderBashCompletion(commandTree)).not.toContain("--target-agent");
    expect(renderZshCompletion(commandTree)).not.toContain("--target-agent");
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
