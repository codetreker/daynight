import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import { runCli as runApplication } from "../../src/cli/application.js";
import { formatError } from "../../src/platform/diagnostics.js";
import type { CliContext } from "../../src/cli/context.js";
import { runReviewCommand } from "../../src/commands/review/command.js";
import type { ReviewCommandDependencies } from "../../src/commands/review/command.js";
import { runUpdateCommand } from "../../src/commands/update/command.js";
import type { UpdateCommandDependencies } from "../../src/commands/update/command.js";
import { parseConfiguration } from "../../src/commands/review/config.js";
import { resolveReviewPaths } from "../../src/commands/review/paths.js";
import Database from "better-sqlite3";

type TestDependencies = CliContext & ReviewCommandDependencies & UpdateCommandDependencies & { output: string[]; errors: string[] };
const runCli = (args: readonly string[], deps: TestDependencies): Promise<number> => runApplication(args, deps, [
  { name: "review", description: "Review GitHub pull requests", load: async () => ({ run: (args, context) => runReviewCommand(args, context, deps) }) },
  { name: "update", description: "Update this installation", load: async () => ({ run: (args, context) => runUpdateCommand(args, context, deps) }) },
]);

const dependencies = (): TestDependencies => {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    version: "1.2.3",
    packageDirectory: path.resolve("package root"),
    update: async () => { throw new Error("Installation must not be updated for informational commands."); },
    homeDirectory: () => { throw new Error("Home must not be read for informational commands."); },
    workingDirectory: () => { throw new Error("Working directory must not be read for informational commands."); },
    addRepository: async () => { throw new Error("Repositories must not be added for informational commands."); },
    listReviews: async () => { throw new Error("Review state must not be read for informational commands."); },
    loadConfiguration: async () => { throw new Error("Configuration must not be loaded for informational commands."); },
    runReview: async () => { throw new Error("Review must not run for informational commands."); },
    stdout: (text) => { output.push(text); },
    stdoutBytes: async () => { throw new Error("Informational commands must not write binary output."); },
    stderr: (text) => { errors.push(text); },
    output,
    errors,
  };
};

describe("CLI argument handling", () => {
  it.each([[], ["review"]])("prints help for the command group %j without inspecting user state", async (...args) => {
    const deps = dependencies();
    expect(await runCli(args, deps)).toBe(0);
    expect(deps.output.join("")).toContain(args.length === 0 ? "Usage: daynight <command>" : "Usage: daynight review <command>");
    expect(deps.errors).toEqual([]);
  });

  it.each([[], ["--help"], ["--version"], ["unknown"]])("does not load command implementations for root arguments %j", async (...args) => {
    const deps = dependencies();
    const load = vi.fn(async () => { throw new Error("Command module must remain unloaded."); });
    expect(await runApplication(args, deps, [{ name: "future", description: "A future command", load }])).toBe(args[0] === "unknown" ? 2 : 0);
    expect(load).not.toHaveBeenCalled();
  });

  it("loads only the selected command and passes its remaining arguments and client context", async () => {
    const deps = dependencies();
    const run = vi.fn(async () => {});
    const load = vi.fn(async () => ({ run }));
    const other = vi.fn(async () => { throw new Error("Unselected command must remain unloaded."); });
    expect(await runApplication(["future", "action", "--option"], deps, [
      { name: "future", description: "A future command", load },
      { name: "other", description: "Another command", load: other },
    ])).toBe(0);
    expect(load).toHaveBeenCalledExactlyOnceWith();
    expect(run).toHaveBeenCalledExactlyOnceWith(["action", "--option"], deps);
    expect(other).not.toHaveBeenCalled();
  });

  it("uses the injected registry for root help and command selection", async () => {
    const deps = dependencies();
    const load = vi.fn(async () => { throw new Error("Unselected command must remain unloaded."); });
    const registry = [{ name: "future", description: "A future command", load }];
    expect(await runApplication(["--help"], deps, registry)).toBe(0);
    expect(deps.output.join("")).toContain("future");
    expect(deps.output.join("")).toContain("A future command");
    expect(deps.output.join("")).not.toContain("Review GitHub pull requests");
    expect(await runApplication(["review"], deps, registry)).toBe(2);
    expect(deps.errors).toEqual(['Unknown command "review". Run daynight --help for usage.\n']);
    expect(load).not.toHaveBeenCalled();
  });

  it("reports command load failures as execution errors with their cause", async () => {
    const deps = dependencies();
    expect(await runApplication(["future"], deps, [{
      name: "future", description: "A future command",
      load: async () => { throw new Error("Cannot load command", { cause: new Error("Missing dependency") }); },
    }])).toBe(1);
    expect(deps.errors).toEqual(["Cannot load command\nCaused by: Missing dependency\n"]);
    expect(deps.output).toEqual([]);
  });

  it.each(["--help", "-h"])("prints %s without touching configuration or user state", async (argument) => {
    const deps = dependencies();
    expect(await runCli([argument], deps)).toBe(0);
    expect(deps.output.join("")).toContain("Usage: daynight <command>");
    expect(deps.errors).toEqual([]);
  });

  it.each(["--version", "-v"])("prints %s without touching configuration", async (argument) => {
    const deps = dependencies();
    expect(await runCli([argument], deps)).toBe(0);
    expect(deps.output).toEqual(["1.2.3\n"]);
  });

  it.each(["--help", "-h"])("prints update %s without inspecting configuration or installation", async (argument) => {
    const deps = dependencies();
    expect(await runCli(["update", argument], deps)).toBe(0);
    expect(deps.output.join("")).toContain("Usage: daynight update");
    expect(deps.errors).toEqual([]);
  });

  it.each([
    ["update", "extra"], ["update", "--version"], ["update", "--help", "extra"],
  ])("rejects invalid update syntax %j before inspecting state", async (...args) => {
    const deps = dependencies();
    expect(await runCli(args, deps)).toBe(2);
    expect(deps.errors.join("")).toContain("daynight update");
    expect(deps.errors.join("")).not.toContain("informational commands");
    expect(deps.output).toEqual([]);
  });

  it.each([
    { status: "updated", previousVersion: "1.2.3", targetVersion: "1.2.4", output: "Updated daynight from 1.2.3 to 1.2.4.\nRestart any running reviewer to use the new version.\n" },
    { status: "current", previousVersion: "1.2.3", targetVersion: "1.2.3", output: "daynight 1.2.3 is already up to date.\n" },
    { status: "ahead", previousVersion: "1.2.3", targetVersion: "1.2.2", output: "daynight 1.2.3 is newer than latest 1.2.2.\n" },
  ] as const)("reports an $status update independently of configuration and review startup", async ({ status, previousVersion, targetVersion, output }) => {
    const deps = dependencies();
    deps.update = vi.fn(async () => ({ status, previousVersion, targetVersion }));
    expect(await runCli(["update"], deps)).toBe(0);
    expect(deps.update).toHaveBeenCalledExactlyOnceWith(deps.packageDirectory);
    expect(deps.output).toEqual([output]);
    expect(deps.errors).toEqual([]);
  });

  it("reports update failure with its original cause and no success message", async () => {
    const deps = dependencies();
    deps.update = async () => { throw new Error("Cannot update installation", { cause: new Error("npm permission denied") }); };
    expect(await runCli(["update"], deps)).toBe(1);
    expect(deps.output).toEqual([]);
    expect(deps.errors.join("")).toContain("Cannot update installation\nCaused by: npm permission denied");
  });

  it.each(["--help", "-h"])("prints add-repo %s without inspecting user directories", async (argument) => {
    const deps = dependencies();
    expect(await runCli(["review", "add-repo", argument], deps)).toBe(0);
    expect(deps.output.join("")).toContain("Usage: daynight review add-repo <remote> [--path <path>]");
    expect(deps.output.join("")).toContain("~/daynights");
    expect(deps.errors).toEqual([]);
  });

  it.each([
    ["review", "--help"], ["review", "-h"],
    ["review", "list", "--help"], ["review", "list", "-h"],
    ["review", "ls", "--help"], ["review", "ls", "-h"],
  ])("prints review command help for %j without inspecting state", async (...args) => {
    const deps = dependencies();
    expect(await runCli(args, deps)).toBe(0);
    expect(deps.output.join("")).toContain(args.length === 2 ? "Usage: daynight review <command>" : "Usage: daynight review list");
    expect(deps.errors).toEqual([]);
  });

  it.each(["--help", "-h"])("prints review run %s without acquiring review resources", async (argument) => {
    const deps = dependencies();
    expect(await runCli(["review", "run", argument], deps)).toBe(0);
    expect(deps.output.join("")).toContain("Usage: daynight review run");
    expect(deps.errors).toEqual([]);
  });

  it.each([
    ["review", "unknown"], ["review", "list", "extra"], ["review", "run", "extra"],
    ["review", "ls", "--daemon-review"], ["review", "--help", "list"],
    ["review", "list", "--help", "extra"],
  ])("rejects invalid review syntax %j without accessing state", async (...args) => {
    const deps = dependencies();
    expect(await runCli(args, deps)).toBe(2);
    expect(deps.errors.join("")).toContain("daynight review");
    expect(deps.errors.join("")).not.toContain("informational commands");
    expect(deps.output).toEqual([]);
  });

  it.each(["list", "ls"])("dispatches review %s independently of review startup and configuration mutation", async (alias) => {
    const deps = dependencies();
    const home = fileURLToPath(new URL("../../../../.tmp/CLI User 用户/", import.meta.url));
    deps.homeDirectory = () => home;
    const listing = "Local persisted snapshot\n\ngithub.com/o/r\nNot initialized.\n";
    deps.listReviews = vi.fn(async () => listing);
    expect(await runCli(["review", alias], deps)).toBe(0);
    expect(deps.listReviews).toHaveBeenCalledExactlyOnceWith(resolveReviewPaths(home));
    expect(deps.output).toEqual([listing]);
    expect(deps.errors).toEqual([]);
  });

  it("reports listing errors with their original cause and no partial table", async () => {
    const deps = dependencies();
    deps.homeDirectory = () => path.resolve(".tmp", "listing failure");
    deps.listReviews = async () => { throw new Error("Cannot read review snapshot", { cause: new Error("Invalid SQLite schema") }); };
    expect(await runCli(["review", "list"], deps)).toBe(1);
    expect(deps.output).toEqual([]);
    expect(deps.errors.join("")).toContain("Cannot read review snapshot\nCaused by: Invalid SQLite schema");
  });

  it.each([{ args: ["--daemon-review"] }, { args: ["add-repo", "https://github.com/o/r"] }, { args: ["--deamon-review"] }, { args: ["--config", "custom.yml"] }, { args: ["--help", "--daemon-review"] }])("rejects legacy, unknown or conflicting arguments", async ({ args }) => {
    const deps = dependencies();
    expect(await runCli(args, deps)).toBe(2);
    expect(deps.errors.join("")).toContain("daynight --help");
    expect(deps.output).toEqual([]);
  });

  it.each([
    ["review", "add-repo"],
    ["review", "add-repo", ""],
    ["review", "add-repo", " "],
    ["review", "add-repo", "\n"],
    ["review", "add-repo", "\ufeff"],
    ["review", "add-repo", "https://github.com/o/r", "other"],
    ["review", "add-repo", "https://github.com/o/r", "--path"],
    ["review", "add-repo", "https://github.com/o/r", "--path", ""],
    ["review", "add-repo", "https://github.com/o/r", "--path", "--help"],
    ["review", "add-repo", "https://github.com/o/r", "--path", "a", "--path", "b"],
    ["review", "add-repo", "https://github.com/o/r", "--daemon-review"],
    ["review", "add-repo", "https://github.com/o/r", "--path=directory"],
    ["review", "add-repo", "--", "https://github.com/o/r"],
    ["review", "add-repo", "https://github.com/o/r", "--help"],
    ["review", "add-repo", "--help", "https://github.com/o/r"],
    ["review", "add-repo", "--unknown"],
  ])("rejects invalid add-repo syntax %j before touching user state", async (...args) => {
    const deps = dependencies();
    expect(await runCli(args, deps)).toBe(2);
    const help = args.length === 3 && args[2] !== "" && args[2]!.trim() === "" ? "daynight review --help" : "daynight review add-repo --help";
    expect(deps.errors.join("")).toContain(help);
    expect(deps.errors.join("")).not.toContain("informational commands");
    expect(deps.output).toEqual([]);
  });

  it.each([
    { args: ["review", "add-repo", "https://github.com/o/r"], input: { remote: "https://github.com/o/r" }, added: true },
    { args: ["review", "add-repo", "https://github.com/o/r", "--path", "./review"], input: { remote: "https://github.com/o/r", path: "./review" }, added: true },
    { args: ["review", "add-repo", "--path", "./review", "https://github.com/o/r"], input: { remote: "https://github.com/o/r", path: "./review" }, added: false },
  ])("dispatches configuration-only additions with caller directories: $args", async ({ args, input, added }) => {
    const deps = dependencies();
    const home = fileURLToPath(new URL("../../../../.tmp/CLI User 用户/", import.meta.url));
    const cwd = path.join(home, "caller");
    const repository = parseConfiguration("review:\n  repositories: [{remote: https://github.com/o/r, path: ../review}]", resolveReviewPaths(home)).repositories[0]!;
    deps.homeDirectory = () => home;
    deps.workingDirectory = () => cwd;
    deps.addRepository = vi.fn(async () => ({ repository, added }));
    expect(await runCli(args, deps)).toBe(0);
    expect(deps.addRepository).toHaveBeenCalledExactlyOnceWith(input, resolveReviewPaths(home), { homeDirectory: home, workingDirectory: cwd });
    expect(deps.output.join("")).toContain(added ? "Repository github.com/o/r added." : "Repository github.com/o/r is already configured.");
    expect(deps.output.join("")).toContain(`Path: ${repository.path}`);
    expect(deps.output.join("")).toContain("next time daynight review run starts");
    expect(deps.errors).toEqual([]);
  });

  it("retains configuration-write failure context and reports no successful addition", async () => {
    const deps = dependencies();
    deps.homeDirectory = () => path.resolve(".tmp", "write failure");
    deps.workingDirectory = () => path.resolve(".tmp");
    deps.addRepository = async () => { throw new Error("Cannot save configuration", { cause: new Error("Disk full") }); };
    expect(await runCli(["review", "add-repo", "https://github.com/o/r"], deps)).toBe(1);
    expect(deps.errors.join("")).toContain("Cannot save configuration\nCaused by: Disk full");
    expect(deps.output).toEqual([]);
  });

  it("runs the foreground coordinator using the resolved current-user configuration", async () => {
    const deps = dependencies();
    deps.homeDirectory = () => fileURLToPath(new URL("../../../../.tmp/CLI User 用户/", import.meta.url));
    deps.loadConfiguration = vi.fn(async (paths) => parseConfiguration("review:\n  repositories: [{remote: https://github.com/o/r, path: ../repo}]", paths));
    deps.runReview = vi.fn(async () => {});
    expect(await runCli(["review", "run"], deps)).toBe(0);
    expect(deps.loadConfiguration).toHaveBeenCalledOnce();
    expect(deps.runReview).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrentWorker: 1 }), expect.objectContaining({ configFile: expect.stringContaining("config.yml") }));
    expect(deps.errors).toEqual([]);
    expect(deps.output).toEqual([]);
  });

  it("reports original configuration failure context and never prints a success diagnostic", async () => {
    const deps = dependencies();
    deps.homeDirectory = () => fileURLToPath(new URL("../../../../.tmp/CLI User 用户/", import.meta.url));
    deps.loadConfiguration = async () => { throw new Error("Cannot read configuration", { cause: new Error("ENOENT: missing config.yml") }); };
    expect(await runCli(["review", "run"], deps)).toBe(1);
    expect(deps.errors.join("")).toContain("Caused by: ENOENT");
    expect(deps.errors.join("")).not.toContain("Configuration is valid");
  });

  it("reports a foreground runtime failure with its original cause", async () => {
    const deps = dependencies();
    deps.homeDirectory = () => fileURLToPath(new URL("../../../../.tmp/CLI User 用户/", import.meta.url));
    deps.loadConfiguration = async (paths) => parseConfiguration("review:\n  repositories: [{remote: https://github.com/o/r, path: ../repo}]", paths);
    deps.runReview = async () => { throw new Error("Cannot start reviews", { cause: new Error("Instance lock is held") }); };
    expect(await runCli(["review", "run"], deps)).toBe(1);
    expect(deps.errors.join("")).toContain("Cannot start reviews\nCaused by: Instance lock is held");
  });

  it("preserves nested and aggregate error diagnostics", () => {
    expect(formatError(new Error("outer", { cause: new AggregateError([new Error("first"), new Error("second")], "invalid YAML") }))).toBe("outer\nCaused by: invalid YAML\nfirst\nsecond");
  });
});

describe("built executable", () => {
  const executable = fileURLToPath(new URL("../../dist/main.js", import.meta.url));

  it("loads command and operation modules only when their behavior is selected", async () => {
    const temporary = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "command-loading 中文-"));
    const home = path.join(directory, "home");
    const hook = path.join(directory, "imports.mjs");
    await writeFile(hook, `import { registerHooks } from 'node:module';
const blocked = JSON.parse(process.env.DAYNIGHT_TEST_BLOCK_IMPORTS);
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  const commandMetadata = /\\/commands\\/[^/]+\\/definition\\.js$/.test(resolved.url);
  if (!commandMetadata && blocked.some(value => specifier.includes(value) || resolved.url.includes(value))) throw new Error('Unexpected module import: ' + specifier);
  return resolved;
} });
`);
    const reviewRuntime = ["better-sqlite3", "/commands/review/store.js", "/commands/review/runtime.js", "/commands/review/instance-lock.js", "/commands/review/listing.js"];
    const cases = [
      { args: [], blocked: ["/commands/"] },
      { args: ["--help"], blocked: ["/commands/"] },
      { args: ["--version"], blocked: ["/commands/"] },
      { args: ["update", "--help"], blocked: ["/commands/review/", "/commands/update/updater.js", "semver", "read-cmd-shim"] },
      ...[[], ["--help"], ["bash"], ["zsh"], ["bash", "--help"], ["zsh", "--help"], ["setup", "--help"]].map((args) => ({
        args: ["completion", ...args], blocked: ["/commands/completion/setup.js", "/commands/review/", "/commands/update/", "better-sqlite3", "semver", "read-cmd-shim"],
      })),
      ...[[], ["--help"], ["install", "--help"]].map((args) => ({
        args: ["skill", ...args], blocked: ["@inquirer/", "which", "/commands/skill/agents.js", "/commands/skill/install.js", "/commands/skill/targets.js", "/commands/review/", "/config/", "/repository/", "/api/"],
      })),
      ...[[], ["--help"], ["run", "--help"], ["list", "--help"], ["add-repo", "--help"]].map((args) => ({
        args: ["review", ...args], blocked: [...reviewRuntime, "/commands/review/config.js", "/commands/review/repositories.js"],
      })),
    ];
    const invoke = (args: string[], blocked: string[]) => spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, executable, ...args], {
      cwd: directory, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, DAYNIGHT_TEST_BLOCK_IMPORTS: JSON.stringify(blocked) },
    });
    try {
      for (const { args, blocked } of cases) {
        const result = invoke(args, blocked);
        expect(result.error, args.join(" ")).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
      }
      await expect(readdir(home)).rejects.toMatchObject({ code: "ENOENT" });
      const added = invoke(["review", "add-repo", "https://github.com/o/r"], reviewRuntime);
      expect(added.error).toBeUndefined();
      expect(added.status, added.stderr).toBe(0);
      expect(added.stderr).toBe("");
      expect(await readdir(resolveReviewPaths(home).stateDirectory)).toEqual(["config.yml"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it("retains the Node shebang and produces help from an unrelated working directory", async () => {
    expect((await readFile(executable, "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(true);
    const result = spawnSync(process.execPath, [executable, "--help"], {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: daynight <command>");
    expect(result.stderr).toBe("");
  });

  it("prints the package version from the installed manifest", async () => {
    const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    const result = spawnSync(process.execPath, [executable, "--version"], { encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${manifest.version}\n`);
    expect(result.stderr).toBe("");
  });

  it("rejects the misspelled review option and points to root help", () => {
    const result = spawnSync(process.execPath, [executable, "--deamon-review"], { encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("daynight --help");
  });

  it("lists recorded state through the compiled CLI while exposing missing configuration and invalid databases", async () => {
    const temporary = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "review-list CLI 中文-"));
    const home = path.join(directory, "home");
    const cwd = path.join(directory, "caller");
    const emptyPath = path.join(directory, "empty-path");
    await mkdir(home); await mkdir(cwd); await mkdir(emptyPath);
    const paths = resolveReviewPaths(home);
    const invoke = (alias: string) => spawnSync(process.execPath, [executable, "review", alias], {
      cwd, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: emptyPath, Path: emptyPath },
    });
    try {
      const missing = invoke("list");
      expect(missing.error).toBeUndefined();
      expect(missing.status).toBe(1);
      expect(missing.stdout).toBe("");
      expect(missing.stderr).toContain(paths.configFile);
      expect(await readdir(home)).toEqual([]);

      await mkdir(paths.stateDirectory);
      await writeFile(path.join(home, "unavailable-clone"), "not a directory");
      const configuration = "review:\n  repositories: [{remote: https://github.com/o/r, path: ../unavailable-clone/repo}]\n";
      await writeFile(paths.configFile, configuration);
      await writeFile(paths.lockFile, "existing review instance\n");
      const list = invoke("list");
      const ls = invoke("ls");
      expect(list.status, list.stderr).toBe(0);
      expect(ls.status, ls.stderr).toBe(0);
      expect(list.stdout).toBe(ls.stdout);
      expect(list.stdout).toContain("github.com/o/r");
      expect(list.stdout).toContain("Not initialized.");
      expect(list.stderr).toBe("");
      expect((await readdir(paths.stateDirectory)).sort()).toEqual(["config.yml", "instance.lock"]);

      const corrupt = "not a SQLite database";
      await writeFile(paths.databaseFile, corrupt);
      const invalid = invoke("ls");
      expect(invalid.status).toBe(1);
      expect(invalid.stdout).toBe("");
      expect(invalid.stderr).toContain("not a database");
      expect(await readFile(paths.databaseFile, "utf8")).toBe(corrupt);
      await rm(paths.databaseFile);
      const database = new Database(paths.databaseFile);
      database.pragma("user_version = 3");
      database.close();
      const original = await readFile(paths.databaseFile);
      const future = invoke("list");
      expect(future.status).toBe(1);
      expect(future.stdout).toBe("");
      expect(future.stderr).toContain("found version 3");
      expect(await readFile(paths.databaseFile)).toEqual(original);
      expect(await readFile(paths.configFile, "utf8")).toBe(configuration);
      expect(await readFile(paths.lockFile, "utf8")).toBe("existing review instance\n");
      expect(await readdir(cwd)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it.each([
    { server: "http://127.0.0.1:8787", yaml: "http://127.0.0.1:8787" },
    { server: ["not an origin"], yaml: "[not an origin]" },
  ])("registers review repositories in server-only configuration without validating server settings: $yaml", async ({ server, yaml }) => {
    const temporary = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "shared-configuration CLI 中文-"));
    const home = path.join(directory, "home 中文");
    const emptyPath = path.join(directory, "empty-path");
    const paths = resolveReviewPaths(home);
    await mkdir(paths.stateDirectory, { recursive: true });
    await mkdir(emptyPath);
    await writeFile(paths.configFile, `# server connection\nserverUrl: ${yaml} # retained server value\n`);
    const invoke = (args: string[]) => spawnSync(process.execPath, [executable, ...args], {
      cwd: directory, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: emptyPath, Path: emptyPath },
    });
    try {
      const missingReview = invoke(["review", "list"]);
      expect(missingReview.error).toBeUndefined();
      expect(missingReview.status).toBe(1);
      expect(missingReview.stdout).toBe("");
      expect(missingReview.stderr).toContain("repositories");

      const registered = invoke(["review", "add-repo", "https://github.com/owner/repo.git"]);
      expect(registered.error).toBeUndefined();
      expect(registered.status, registered.stderr).toBe(0);
      expect(registered.stderr).toBe("");
      const source = await readFile(paths.configFile, "utf8");
      expect(source).toContain("# server connection");
      expect(source).toContain("# retained server value");
      const configuration = parseDocument(source).toJS();
      expect(configuration.serverUrl).toEqual(server);
      expect(configuration.review.repositories).toEqual([{
        remote: "https://github.com/owner/repo.git",
        path: path.join(home, "daynights", "github.com", "owner", "repo"),
      }]);

      const listed = invoke(["review", "list"]);
      expect(listed.error).toBeUndefined();
      expect(listed.status, listed.stderr).toBe(0);
      expect(listed.stderr).toBe("");
      expect(listed.stdout).toContain("github.com/owner/repo");
      expect(listed.stdout).toContain("Not initialized.");
      expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
      expect(await readFile(paths.configFile, "utf8")).toBe(source);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it("adds repositories through the compiled CLI without review dependencies or runtime state", async () => {
    const temporary = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "add-repo CLI 中文-"));
    const home = path.join(directory, "home 中文");
    const cwd = path.join(directory, "caller 中文");
    const emptyPath = path.join(directory, "empty-path");
    await mkdir(home); await mkdir(cwd); await mkdir(emptyPath);
    const paths = resolveReviewPaths(home);
    const invoke = (args: string[]) => spawnSync(process.execPath, [executable, ...args], {
      cwd, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: emptyPath, Path: emptyPath },
    });
    try {
      const first = invoke(["review", "add-repo", "https://github.com/Owner/Repo.git"]);
      expect(first.error).toBeUndefined();
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain("Repository github.com/owner/repo added.");
      expect(first.stderr).toBe("");
      const initial = parseDocument(await readFile(paths.configFile, "utf8"));
      expect(initial.getIn(["review", "repositoryRoot"])).toBe("~/daynights");
      const firstPath = path.join(home, "daynights", "github.com", "owner", "repo");
      expect(initial.toJS().review.repositories).toEqual([{ remote: "https://github.com/Owner/Repo.git", path: firstPath }]);
      expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
      expect(await readdir(home)).toEqual([".daynight"]);

      initial.setIn(["review", "repositoryRoot"], "../new root 中文");
      await writeFile(paths.configFile, initial.toString());
      await writeFile(paths.lockFile, "existing review instance\n");
      const second = invoke(["review", "add-repo", "git@github.com:Owner/Other.git"]);
      expect(second.status, second.stderr).toBe(0);
      const third = invoke(["review", "add-repo", "https://github.com/owner/explicit", "--path", "./explicit review 中文"]);
      expect(third.status, third.stderr).toBe(0);
      const after = parseDocument(await readFile(paths.configFile, "utf8")).toJS();
      expect(after.review.repositories.map((repository: { path: string }) => repository.path)).toEqual([
        firstPath,
        path.join(home, "new root 中文", "github.com", "owner", "other"),
        path.join(cwd, "explicit review 中文"),
      ]);
      const source = await readFile(paths.configFile, "utf8");
      const repeated = invoke(["review", "add-repo", "https://GITHUB.COM/owner/repo", "--path", firstPath]);
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(repeated.stdout).toContain("is already configured");
      expect(await readFile(paths.configFile, "utf8")).toBe(source);
      const repeatedDefault = invoke(["review", "add-repo", "git@github.com:OWNER/REPO.git"]);
      expect(repeatedDefault.status, repeatedDefault.stderr).toBe(0);
      expect(repeatedDefault.stdout).toContain(`Path: ${firstPath}`);
      expect(await readFile(paths.configFile, "utf8")).toBe(source);
      const conflict = invoke(["review", "add-repo", "https://github.com/owner/repo", "--path", "./wrong"]);
      expect(conflict.status).toBe(1);
      expect(conflict.stdout).toBe("");
      expect(await readFile(paths.configFile, "utf8")).toBe(source);
      const invalid = invoke(["review", "add-repo", "https://github.com/owner/invalid", "--path"]);
      expect(invalid.status).toBe(2);
      expect(await readFile(paths.configFile, "utf8")).toBe(source);
      expect(await readFile(paths.lockFile, "utf8")).toBe("existing review instance\n");
      expect((await readdir(paths.stateDirectory)).sort()).toEqual(["config.yml", "instance.lock"]);
      expect(await readdir(cwd)).toEqual([]);
      expect(await readdir(home)).toEqual([".daynight"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it("runs the compiled foreground entry with fixed home paths until a shutdown signal", async () => {
    const temporary = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "compiled-cli 用户-"));
    const state = path.join(directory, ".daynight");
    const emptyPath = path.join(directory, "empty-path");
    await mkdir(state); await mkdir(emptyPath);
    await writeFile(path.join(state, "config.yml"), "review:\n  pollIntervalMs: 50\n  repositories: [{remote: https://github.com/o/r, path: ../repository}]\n");
    const harness = path.join(directory, "shutdown.mjs");
    await writeFile(harness, `import { existsSync } from 'node:fs';
const timeout = setTimeout(() => { throw new Error('Foreground startup timed out'); }, 10000);
const probe = setInterval(() => {
  if (!existsSync(${JSON.stringify(path.join(state, "state.sqlite"))})) return;
  clearInterval(probe); clearTimeout(timeout);
  setTimeout(() => process.emit('SIGINT'), 100);
}, 10);
`);
    try {
      const result = spawnSync(process.execPath, ["--import", pathToFileURL(harness).href, executable, "review", "run"], {
        cwd: directory, encoding: "utf8", timeout: 15_000,
        env: { ...process.env, HOME: directory, USERPROFILE: directory, PATH: emptyPath, Path: emptyPath },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Foreground review started");
      expect(result.stderr).toContain(state);
      await expect(readFile(path.join(state, "instance.lock"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readFile(path.join(state, "state.sqlite"))).length).toBeGreaterThan(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);
});
