import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import type { CliContext } from "../../../src/cli/context.js";
import { CliCancelledError } from "../../../src/cli/cancellation.js";
import { runCli } from "../../../src/cli/application.js";
import { MissingConfigurationFileError, MissingConfigurationFieldError } from "../../../src/config/errors.js";
import { resolveConfigurationPaths } from "../../../src/config/paths.js";
import { loadConfiguration } from "../../../src/commands/review/config.js";
import { resolveReviewPaths } from "../../../src/commands/review/paths.js";
import { configureReview, guideReviewConfiguration } from "../../../src/commands/review/configuration-guide.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const fixture = async (source?: string) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/review-configuration-tests");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "review 用户-"));
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

describe("review configuration guide", () => {
  it("asks only for a review repository and its clone path", async () => {
    const { context, paths, directory } = await fixture();
    const ask = answers(context, ["https://github.com/Owner/Repo.git", ""]);
    await configureReview(context);
    expect(ask.mock.calls.map(([question]) => question)).toEqual(["Review repository (HTTPS or SSH GitHub address): ", "Review clone path (blank for configured default): "]);
    expect(parse(await readFile(paths.configFile, "utf8"))).toEqual({ review: { repositoryRoot: "~/daynights", repositories: [{ remote: "https://github.com/Owner/Repo.git", path: path.join(directory, "daynights", "github.com", "owner", "repo") }] } });
    expect(context.stdout).not.toHaveBeenCalled();
  });

  it("leaves original configuration intact on cancellation", async () => {
    const source = "# connection\nserverUrl: http://original:8787 # retained\n";
    const { context, paths } = await fixture(source);
    answers(context, ["https://github.com/owner/repo"]);
    await expect(configureReview(context)).rejects.toBeInstanceOf(CliCancelledError);
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("preserves invalid server fields while configuring review", async () => {
    const { context, paths } = await fixture("serverUrl: null\nserverToken: false\n");
    answers(context, ["https://github.com/o/r", ""]);
    await configureReview(context);
    expect(parse(await readFile(paths.configFile, "utf8"))).toMatchObject({ serverUrl: null, serverToken: false, review: { repositories: [{ remote: "https://github.com/o/r" }] } });
  });

  it.each(["copilotModel", "copilotReasoningEffort"])("rejects invalid selected review settings before prompting: %s", async (field) => {
    const { context, paths } = await fixture(`review:\n  ${field}: null\n`);
    const ask = answers(context, []);
    await expect(configureReview(context)).rejects.toThrow(`${field} must be`);
    expect(ask).not.toHaveBeenCalled();
    expect(await readFile(paths.configFile, "utf8")).toBe(`review:\n  ${field}: null\n`);
  });

  it("preserves concurrent credentials during review setup", async () => {
    const { context, paths } = await fixture("serverToken: original-secret\n");
    answers(context, [""]);
    context.prompt!.ask = vi.fn().mockImplementationOnce(async () => {
      await writeFile(paths.configFile, "# concurrent credential update\nserverToken: concurrent-secret\n");
      return "https://github.com/owner/repo.git";
    }).mockResolvedValueOnce("");
    await configureReview(context);
    const source = await readFile(paths.configFile, "utf8");
    expect(source).toContain("# concurrent credential update");
    expect(parse(source)).toMatchObject({ serverToken: "concurrent-secret", review: { repositories: [{ remote: "https://github.com/owner/repo.git" }] } });
  });

  it("preserves concurrent worker and unselected review settings", async () => {
    const { context, paths } = await fixture("review: { pollIntervalMs: 60000 }\nworker: { repositories: [] }\n");
    answers(context, []);
    context.prompt!.ask = vi.fn().mockImplementationOnce(async () => {
      await writeFile(paths.configFile, "review: { pollIntervalMs: 2000, copilotModel: auto }\nworker: { repositories: [], maxConcurrent: 4 }\n");
      return "https://github.com/owner/repo.git";
    }).mockResolvedValueOnce("");
    await configureReview(context);
    expect(parse(await readFile(paths.configFile, "utf8"))).toMatchObject({
      review: { pollIntervalMs: 2000, copilotModel: "auto", repositories: [{ remote: "https://github.com/owner/repo.git" }] },
      worker: { repositories: [], maxConcurrent: 4 },
    });
  });

  it.each(["review: null", "review: []", "review: false", "review: { unexpected: true }"])("rejects malformed review configuration without prompting: %s", async (source) => {
    const { context, paths } = await fixture(source);
    const ask = answers(context, []);
    await expect(guideReviewConfiguration(context, () => loadConfiguration(resolveReviewPaths(context.homeDirectory())))).rejects.toThrow();
    expect(ask).not.toHaveBeenCalled();
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
  });

  it("rejects concurrent selected review changes", async () => {
    const { context, paths } = await fixture("review:\n  repositoryRoot: ~/original\n");
    answers(context, []);
    context.prompt!.ask = vi.fn().mockImplementationOnce(async () => {
      await writeFile(paths.configFile, "review:\n  repositoryRoot: ~/concurrent\n");
      return "https://github.com/owner/repo.git";
    }).mockResolvedValueOnce("");
    await expect(configureReview(context)).rejects.toThrow("Review configuration changed while prompting");
    expect(await readFile(paths.configFile, "utf8")).toBe("review:\n  repositoryRoot: ~/concurrent\n");
  });

  it.each([["setup"], ["setup", "--help"], ["setup", "--server-url", "http://localhost:8787"]])("rejects the removed top-level command without accessing configuration %j", async (...args) => {
    const { context, paths } = await fixture();
    const ask = answers(context, []);
    expect(await runCli(args, context)).toBe(2);
    expect(context.stderr).toHaveBeenCalledExactlyOnceWith('Unknown command "setup". Run daynight --help for usage.\n');
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

describe("review guide persistence", () => {
  it("retries invalid repository and clone-path answers without locking the configuration", async () => {
    const { context, paths } = await fixture();
    const ask = answers(context, ["invalid", "https://github.com/o/r", "~invalid", ""]);
    context.prompt!.ask = async (question, signal) => {
      await expect(lstat(`${paths.configFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      return ask(question, signal);
    };
    await configureReview(context);
    expect(ask).toHaveBeenCalledTimes(4);
    expect(context.stderr).toHaveBeenCalledWith(expect.stringContaining("remote"));
    expect(context.stderr).toHaveBeenCalledWith(expect.stringContaining("path"));
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it.skipIf(process.platform === "win32")("restricts token-bearing files and rejects symlink writes without changing their targets", async () => {
    const { context, paths, directory } = await fixture("serverToken: retained-secret\n");
    await chmod(paths.configFile, 0o640);
    answers(context, ["https://github.com/o/r", ""]);
    await configureReview(context);
    expect((await lstat(paths.configFile)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(vi.mocked(context.stderr).mock.calls)).not.toContain("retained-secret");
    const target = path.join(directory, "target.yml");
    await writeFile(target, "serverToken: retained-secret\n");
    await rm(paths.configFile);
    await symlink(target, paths.configFile);
    answers(context, ["https://github.com/o/other", ""]);
    await expect(configureReview(context)).rejects.toThrow("symbolic-link");
    expect(await readFile(target, "utf8")).toBe("serverToken: retained-secret\n");
  });

  it("rejects an existing configuration lock without changing the configuration", async () => {
    const source = "serverToken: retained-secret\n";
    const { context, paths } = await fixture(source);
    await writeFile(`${paths.configFile}.lock`, "another writer");
    answers(context, ["https://github.com/o/r", ""]);
    await expect(configureReview(context)).rejects.toThrow("locked by another writer");
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
    expect(await readFile(`${paths.configFile}.lock`, "utf8")).toBe("another writer");
  });

  it("cancels before configuration reads without creating state", async () => {
    const { context, paths } = await fixture();
    const ask = answers(context, []);
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(configureReview(context, cancellation.signal)).rejects.toMatchObject({ name: "CliCancelledError", message: "Review configuration cancelled." });
    expect(ask).not.toHaveBeenCalled();
    expect(context.prompt!.close).toHaveBeenCalledOnce();
    await expect(lstat(paths.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the original prompt failure", async () => {
    const { context, paths } = await fixture("serverToken: retained-secret\n");
    const failure = new Error("Terminal input failed");
    answers(context, []);
    context.prompt!.ask = vi.fn(async () => { throw failure; });
    await expect(configureReview(context)).rejects.toBe(failure);
    expect(await readFile(paths.configFile, "utf8")).toBe("serverToken: retained-secret\n");
  });
});

describe("missing review configuration", () => {
  it("returns an existing configuration without prompting", async () => {
    const { context, paths } = await fixture();
    const ask = answers(context, []);
    const existing = { repositories: ["already configured"] };
    const load = vi.fn(async () => existing);
    expect(await guideReviewConfiguration(context, load)).toBe(existing);
    expect(load).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled();
    await expect(lstat(paths.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["file", "field"])("guides a missing %s and reloads once", async (kind) => {
    const { context, paths } = await fixture();
    answers(context, ["https://github.com/o/r", ""]);
    const failure = kind === "file" ? new MissingConfigurationFileError(paths.configFile, new Error("missing")) : new MissingConfigurationFieldError("review.repositories", "missing repositories");
    const load = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce("loaded");
    expect(await guideReviewConfiguration(context, load)).toBe("loaded");
    expect(load).toHaveBeenCalledTimes(2);
    expect(parse(await readFile(paths.configFile, "utf8"))).toMatchObject({ review: { repositories: [{ remote: "https://github.com/o/r" }] } });
  });

  it("points noninteractive callers to review add-repo without creating configuration", async () => {
    const { context, paths } = await fixture();
    const failure = new MissingConfigurationFileError(paths.configFile, new Error("missing"));
    const load = vi.fn(async () => { throw failure; });
    await expect(guideReviewConfiguration(context, load)).rejects.toThrow("daynight review add-repo <remote>");
    expect(load).toHaveBeenCalledOnce();
    await expect(lstat(paths.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not convert unrelated failures into configuration prompts", async () => {
    const { context, paths } = await fixture();
    const ask = answers(context, []);
    const failure = new Error("Malformed configuration");
    await expect(guideReviewConfiguration(context, async () => { throw failure; })).rejects.toBe(failure);
    expect(ask).not.toHaveBeenCalled();
    await expect(lstat(paths.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates a failed reload without prompting a second time", async () => {
    const { context } = await fixture();
    const ask = answers(context, ["https://github.com/o/r", ""]);
    const failure = new MissingConfigurationFieldError("review.repositories", "still missing");
    const load = vi.fn(async () => { throw failure; });
    await expect(guideReviewConfiguration(context, load)).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
