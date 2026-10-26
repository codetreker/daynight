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

describe("worker command", () => {
  it.each([[], ["--help"], ["-h"], ["run", "--help"], ["run", "-h"]])("prints help without loading worker runtime or reading home %j", async (...args) => {
    const { cli, output } = context();
    const run = vi.fn(async () => { throw new Error("Help must not run a worker."); });
    await runWorkerCommand(args, cli, { run });
    expect(output.join("")).toContain("Usage: daynight worker");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([["run", "extra"], ["run", "--config", "elsewhere"], ["run", "--platform", "linux"], ["run", "--state-directory", "elsewhere"], ["run", "--version"], ["other"]])("rejects invalid syntax before runtime startup %j", async (...args) => {
    const { cli } = context();
    const run = vi.fn(async () => {});
    await expect(runWorkerCommand(args, cli, { run })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("passes startup home, installed package and frontend output to the foreground runtime", async () => {
    const { cli, errors } = context();
    cli.homeDirectory = () => path.resolve("worker-home");
    const run = vi.fn<WorkerCommandDependencies["run"]>(async (options) => { options.log?.("worker started\n"); });
    await runWorkerCommand(["run"], cli, { run });
    expect(run).toHaveBeenCalledExactlyOnceWith({ homeDirectory: cli.homeDirectory(), packageDirectory: cli.packageDirectory, log: expect.any(Function) });
    expect(errors).toEqual(["worker started\n"]);
  });

  it("registers public help and both shell completions through the shared command tree", async () => {
    const { cli, output } = context();
    expect(await runCli(["--help"], cli)).toBe(0);
    expect(output.join("")).toContain("worker");
    const definition = commandTree.commands!.find(({ name }) => name === "worker")!;
    expect(definition.commands!.map(({ name }) => name)).toEqual(["run"]);
    expect(renderBashCompletion(commandTree)).toContain("'worker'");
    expect(renderZshCompletion(commandTree)).toContain("worker:Run automatically claimed tasks");
  });
});
