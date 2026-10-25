import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import type { CliContext } from "../../src/cli/context.js";
import { CliCancelledError } from "../../src/cli/cancellation.js";
import { runCli } from "../../src/cli/application.js";
import { MissingConfigurationFileError, isMissingConfiguration } from "../../src/config/errors.js";
import { readConfigurationSource } from "../../src/config/files.js";
import { resolveConfigurationPaths } from "../../src/config/paths.js";
import { configure } from "../../src/config/setup.js";
import { runServerCommand } from "../../src/commands/server/runtime.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const fixture = async (source?: string) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../.tmp/setup-tests");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "setup 用户-"));
  directories.push(directory);
  const paths = resolveConfigurationPaths(directory);
  if (source !== undefined) { await mkdir(paths.stateDirectory); await writeFile(paths.configFile, source); }
  const context: CliContext = { version: "0.0.0", packageDirectory: directory, homeDirectory: () => directory, workingDirectory: () => directory, stdoutBytes: vi.fn(async () => {}), stdout: vi.fn(), stderr: vi.fn() };
  return { context, paths, directory };
};
const answers = (context: CliContext, values: readonly string[]) => {
  let index = 0;
  const ask = vi.fn(async (_question: string, _signal: AbortSignal) => {
    if (index >= values.length) throw new CliCancelledError();
    return values[index++]!;
  });
  context.prompt = { isInteractive: true, select: async () => { throw new Error("Unexpected select"); }, selectMany: async () => { throw new Error("Unexpected selectMany"); }, ask, close: vi.fn() };
  return ask;
};

describe("review configuration and explicit server overrides", () => {
  it("interactive setup asks only for a review repository and its clone path", async () => {
    const { context, paths, directory } = await fixture();
    const ask = answers(context, ["https://github.com/Owner/Repo.git", ""]);
    await configure(context);
    expect(ask.mock.calls.map(([question]) => question)).toEqual(["Review repository (HTTPS or SSH GitHub address): ", "Review clone path (blank for configured default): "]);
    expect(parse(await readFile(paths.configFile, "utf8"))).toEqual({ repositoryRoot: "~/daynights", repositories: [{ remote: "https://github.com/Owner/Repo.git", path: path.join(directory, "daynights", "github.com", "owner", "repo") }] });
    expect(context.stdout).not.toHaveBeenCalled();
  });

  it("leaves original configuration intact on cancellation", async () => {
    const source = "# connection\nserverUrl: http://original:8787 # retained\n";
    const { context, paths } = await fixture(source);
    answers(context, ["https://github.com/owner/repo"]);
    await expect(configure(context)).rejects.toBeInstanceOf(CliCancelledError);
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("preserves invalid server fields while configuring review", async () => {
    const { context, paths } = await fixture("serverUrl: null\nserverToken: false\n");
    await configure(context, { reviewRepository: { remote: "https://github.com/o/r" } });
    expect(parse(await readFile(paths.configFile, "utf8"))).toMatchObject({ serverUrl: null, serverToken: false, repositories: [{ remote: "https://github.com/o/r" }] });
  });

  it.each(["copilotModel", "copilotReasoningEffort"])("rejects invalid selected review settings before prompting: %s", async (field) => {
    const { context, paths } = await fixture(`${field}: null\n`);
    const ask = answers(context, []);
    await expect(configure(context)).rejects.toThrow(`${field} must be`);
    expect(ask).not.toHaveBeenCalled();
    expect(await readFile(paths.configFile, "utf8")).toBe(`${field}: null\n`);
  });

  it("preserves concurrent credentials during review setup", async () => {
    const { context, paths } = await fixture("serverToken: original-secret\n");
    answers(context, [""]);
    context.prompt!.ask = vi.fn().mockImplementationOnce(async () => {
      await writeFile(paths.configFile, "# concurrent credential update\nserverToken: concurrent-secret\n");
      return "https://github.com/owner/repo.git";
    }).mockResolvedValueOnce("");
    await configure(context);
    const source = await readFile(paths.configFile, "utf8");
    expect(source).toContain("# concurrent credential update");
    expect(parse(source)).toMatchObject({ serverToken: "concurrent-secret", repositories: [{ remote: "https://github.com/owner/repo.git" }] });
  });

  it("rejects concurrent selected review changes", async () => {
    const { context, paths } = await fixture("repositoryRoot: ~/original\n");
    answers(context, []);
    context.prompt!.ask = vi.fn().mockImplementationOnce(async () => {
      await writeFile(paths.configFile, "repositoryRoot: ~/concurrent\n");
      return "https://github.com/owner/repo.git";
    }).mockResolvedValueOnce("");
    await expect(configure(context)).rejects.toThrow("Configuration changed during setup");
    expect(await readFile(paths.configFile, "utf8")).toBe("repositoryRoot: ~/concurrent\n");
  });

  it("explicit flags save selected capabilities without prompts", async () => {
    const { context, paths } = await fixture("# Review model\ncopilotModel: future/model # preserved\n");
    const ask = answers(context, []);
    expect(await runCli(["setup", "--server-url", "http://localhost:8787", "--review-repo", "git@github.com:o/r.git"], context)).toBe(0);
    expect(ask).not.toHaveBeenCalled();
    const source = await readFile(paths.configFile, "utf8");
    expect(source).toContain("# preserved");
    expect(parse(source)).toMatchObject({ serverUrl: "http://localhost:8787", copilotModel: "future/model", repositories: [{ remote: "git@github.com:o/r.git" }] });
    expect(context.stderr).toHaveBeenCalledExactlyOnceWith(`Configuration saved to ${paths.configFile}.\n`);
  });

  it.each([["setup", "--help"], ["setup", "--review-path", "somewhere"], ["project", "show", "invalid-id"]])("does not prompt for informational or invalid commands %j", async (...args) => {
    const { context, paths } = await fixture();
    const ask = answers(context, []);
    expect(await runCli(args, context)).toBe(args[1] === "--help" ? 0 : 2);
    expect(ask).not.toHaveBeenCalled();
    await expect(lstat(paths.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("missing credentials fail before the business callback without setup or browser interaction", async () => {
    const { context, paths } = await fixture();
    const ask = answers(context, []);
    const command = vi.fn(async () => "unreachable");
    await expect(runServerCommand(context, command)).rejects.toThrow("daynight login");
    expect(command).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    await expect(lstat(paths.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["[invalid YAML", "serverUrl: []\n", "serverUrl: null\n"])("preserves malformed existing configuration: %s", async (source) => {
    const { context, paths } = await fixture(source);
    const ask = answers(context, []);
    const command = vi.fn(async () => "unexpected");
    await expect(runServerCommand(context, command)).rejects.toThrow();
    expect(ask).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
  });
});

describe("explicit automation token transactions", () => {
  it.each([["--server-token=argv-secret"], ["--server-token", "argv-secret"], ["--server-token-stdin=argv-secret"], ["--server-token-stdin", "argv-secret"]])("rejects token values in argv without revealing them: %j", async (...arguments_) => {
    const { context, paths } = await fixture();
    context.readStdin = vi.fn(async () => "unread-secret");
    expect(await runCli(["setup", ...arguments_], context)).toBe(2);
    expect(JSON.stringify(vi.mocked(context.stderr).mock.calls)).not.toContain("argv-secret");
    expect(context.readStdin).not.toHaveBeenCalled();
    await expect(lstat(paths.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["stdin-secret", "stdin-secret\n", "stdin-secret\r\n"])("saves a token for the default server without requiring an explicit URL: %j", async (input) => {
    const { context, paths } = await fixture();
    const ask = answers(context, []);
    context.readStdin = vi.fn(async () => input);
    expect(await runCli(["setup", "--server-token-stdin"], context)).toBe(0);
    expect(parse(await readFile(paths.configFile, "utf8"))).toEqual({ serverToken: "stdin-secret" });
    expect(ask).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(context.stderr).mock.calls)).not.toContain("stdin-secret");
    if (process.platform !== "win32") expect((await lstat(paths.configFile)).mode & 0o777).toBe(0o600);
  });

  it.each(["", "\n", "secret\nsecond", "secret\n\n", "secret\r", "secret\tvalue", "secret value", "secret\u0000value", "secret\u007fvalue", "secret\u0080value"])("rejects invalid stdin atomically without leaking it: %j", async (input) => {
    const original = "serverUrl: https://service.example\nserverToken: old-secret\n";
    const { context, paths } = await fixture(original);
    context.readStdin = vi.fn(async () => input);
    expect(await runCli(["setup", "--server-token-stdin"], context)).toBe(1);
    expect(await readFile(paths.configFile, "utf8")).toBe(original);
    expect(JSON.stringify(vi.mocked(context.stderr).mock.calls)).not.toContain("old-secret");
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("rejects insecure transport before consuming the token", async () => {
    const { context, paths } = await fixture();
    context.readStdin = vi.fn(async () => "transport-secret");
    expect(await runCli(["setup", "--server-url", "http://service.example", "--server-token-stdin"], context)).toBe(1);
    expect(context.readStdin).not.toHaveBeenCalled();
    await expect(lstat(paths.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves normalized same-origin credentials and clears them on origin change", async () => {
    const { context, paths } = await fixture("serverToken: retained-secret\n");
    await configure(context, { serverUrl: "HTTPS://DAYNIGHT.CC:443/" });
    expect(parse(await readFile(paths.configFile, "utf8"))).toEqual({ serverUrl: "https://daynight.cc", serverToken: "retained-secret" });
    await configure(context, { serverUrl: "https://replacement.example" });
    expect(parse(await readFile(paths.configFile, "utf8"))).toEqual({ serverUrl: "https://replacement.example" });
  });

  it("rejects concurrent credential changes and preserves unrelated concurrent settings", async () => {
    const { context, paths } = await fixture("serverToken: original-secret\n");
    context.readStdin = vi.fn(async () => { await writeFile(paths.configFile, "serverToken: concurrent-secret\n"); return "requested-secret"; });
    await expect(configure(context, { serverTokenStdin: true })).rejects.toThrow("Configuration changed during setup");
    expect(await readFile(paths.configFile, "utf8")).toBe("serverToken: concurrent-secret\n");
    context.readStdin = vi.fn(async () => { await writeFile(paths.configFile, "# concurrent review\nserverToken: concurrent-secret\npollIntervalMs: 2000\n"); return "requested-secret"; });
    await configure(context, { serverTokenStdin: true });
    expect(parse(await readFile(paths.configFile, "utf8"))).toEqual({ serverToken: "requested-secret", pollIntervalMs: 2000 });
    expect(await readFile(paths.configFile, "utf8")).toContain("# concurrent review");
  });

  it("preserves original configuration if stdin fails", async () => {
    const { context, paths } = await fixture("serverToken: original-secret\n");
    const failure = new Error("Input failed");
    context.readStdin = vi.fn(async () => { throw failure; });
    await expect(configure(context, { serverTokenStdin: true })).rejects.toBe(failure);
    expect(await readFile(paths.configFile, "utf8")).toBe("serverToken: original-secret\n");
  });

  it.skipIf(process.platform === "win32")("restricts token-bearing files during unrelated writes and rejects symlink writes", async () => {
    const { context, paths, directory } = await fixture("serverToken: retained-secret\n");
    await chmod(paths.configFile, 0o640);
    await configure(context, { reviewRepository: { remote: "https://github.com/o/r" } });
    expect((await lstat(paths.configFile)).mode & 0o777).toBe(0o600);
    const target = path.join(directory, "target.yml");
    await writeFile(target, "serverToken: retained-secret\n");
    await rm(paths.configFile);
    await symlink(target, paths.configFile);
    context.readStdin = vi.fn(async () => "replacement-secret");
    await expect(configure(context, { serverTokenStdin: true })).rejects.toThrow("symbolic-link");
    expect(await readFile(target, "utf8")).toBe("serverToken: retained-secret\n");
  });
});

describe("missing configuration classification", () => {
  it("classifies missing files while preserving invalid ancestors and dangling symlinks", async () => {
    const { paths, directory } = await fixture();
    await expect(readConfigurationSource(paths)).rejects.toBeInstanceOf(MissingConfigurationFileError);
    await writeFile(paths.stateDirectory, "not a directory");
    expect(isMissingConfiguration(await readConfigurationSource(paths).catch((cause: unknown) => cause), "repositories")).toBe(false);
    if (process.platform !== "win32") {
      await rm(paths.stateDirectory);
      await symlink(path.join(directory, "missing-state"), paths.stateDirectory);
      expect(isMissingConfiguration(await readConfigurationSource(paths).catch((cause: unknown) => cause), "repositories")).toBe(false);
    }
  });
});
