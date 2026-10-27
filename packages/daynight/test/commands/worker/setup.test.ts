import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import type { Project, WorkerAgent } from "../../../src/api/types.js";
import { CliCancelledError } from "../../../src/cli/cancellation.js";
import type { CliContext } from "../../../src/cli/context.js";
import type { PromptMultipleSelection, PromptSelection } from "../../../src/cli/prompts.js";
import { readWorkerConfiguration } from "../../../src/commands/worker/config.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import {
  prepareWorkerSetup, readWorkerRepositorySnapshot, saveWorkerSetup,
} from "../../../src/commands/worker/repositories.js";
import { runWorkerSetup } from "../../../src/commands/worker/setup.js";
import type { WorkerSetupDependencies } from "../../../src/commands/worker/setup.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const projects: Project[] = [1, 2, 3].map((number) => ({
  id: uuid(number), name: `Project ${number}`, repoUrl: `https://github.com/example/repo-${number}.git`,
  settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z",
}));
const connection = "serverUrl: https://service.example\nserverToken: test-credential\n";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const fixture = async (source = connection) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-setup-tests");
  await mkdir(temporary, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(temporary, "home-"));
  directories.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(paths.stateDirectory);
  await writeFile(paths.configFile, source);
  const snapshot = await readWorkerRepositorySnapshot(paths);
  const output: string[] = [];
  const questions: unknown[] = [];
  const answers = { agent: "codex" as WorkerAgent, projectIds: [uuid(1), uuid(2)], save: true };
  const prompt = {
    isInteractive: true,
    ask: vi.fn(async () => { throw new Error("Setup uses structured selections."); }),
    select: async <Value>(question: PromptSelection<Value>, _signal: AbortSignal): Promise<Value> => {
      questions.push(question);
      return (question.message.startsWith("Which agent") ? answers.agent : answers.save) as Value;
    },
    selectMany: async <Value>(question: PromptMultipleSelection<Value>): Promise<Value[]> => { questions.push(question); return answers.projectIds as Value[]; },
    close: vi.fn(),
  };
  const context: CliContext = {
    version: "0.0.0", packageDirectory: homeDirectory, homeDirectory: () => homeDirectory, workingDirectory: () => homeDirectory,
    stdout: vi.fn(), stderr: (message) => { output.push(message); }, stdoutBytes: vi.fn(async () => {}), prompt,
  };
  const dependencies = {
    inspectEnvironment: vi.fn<WorkerSetupDependencies["inspectEnvironment"]>(async () => [{ label: "Git", status: "passed", detail: "Available" }]),
    readSnapshot: vi.fn(readWorkerRepositorySnapshot),
    readProjects: vi.fn<WorkerSetupDependencies["readProjects"]>(async () => projects),
    prepare: vi.fn(prepareWorkerSetup),
    save: vi.fn(saveWorkerSetup),
  };
  const options = { paths, homeDirectory, snapshot, projects, projectIds: answers.projectIds, agent: answers.agent };
  return { paths, homeDirectory, snapshot, output, questions, answers, context, prompt, dependencies, options, source };
};

describe("worker setup configuration transaction", () => {
  it("prepares without writing, then saves one agent and multiple server Projects while retaining unrelated settings", async () => {
    const f = await fixture(`${connection}# Keep review configuration\nmaxAttempts: 7\nworker:\n  maxConcurrent: 3\n`);
    const plan = await prepareWorkerSetup(f.options);
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
    expect(plan.configuration.repositories).toHaveLength(2);
    const saved = await saveWorkerSetup(f.options);
    expect(saved).toEqual(plan.configuration);
    expect(saved.agent).toBe("codex");
    expect(saved.maxConcurrent).toBe(3);
    expect(saved.repositories.map(({ projectId, agent, path: local }) => ({ projectId, agent, local }))).toEqual([1, 2].map((number) => ({
      projectId: uuid(number), agent: "codex", local: path.join(f.homeDirectory, `daynights/github.com/example/repo-${number}`),
    })));
    const source = await readFile(f.paths.configFile, "utf8");
    expect(source).toContain("# Keep review configuration");
    expect(parse(source)).toMatchObject({ serverToken: "test-credential", maxAttempts: 7 });
    expect(await readdir(f.paths.stateDirectory)).toEqual(["config.yml"]);
    if (process.platform !== "win32") expect((await stat(f.paths.configFile)).mode & 0o777).toBe(0o600);
  });

  it("replaces the full selection while retaining matched paths, comments and compatible native settings", async () => {
    const f = await fixture(`${connection}worker:\n  agent: codex\n  model: global-model\n  args: [--search]\n  repositories:\n    # Retain this path\n    - projectId: ${uuid(1)}\n      remote: ${projects[0]!.repoUrl}\n      path: ../original\n      agent: codex\n      model: custom-model\n    - projectId: ${uuid(3)}\n      remote: ${projects[2]!.repoUrl}\n      path: ../removed\n`);
    const plan = await prepareWorkerSetup(f.options);
    expect(plan.removedRepositories.map(({ projectId }) => projectId)).toEqual([uuid(3)]);
    expect(plan.resetRepositories).toEqual([]);
    expect(plan.configuration.repositories[0]).toMatchObject({ path: path.join(f.homeDirectory, "original"), agent: "codex", model: "custom-model", args: ["--search"] });
    await saveWorkerSetup(f.options);
    const source = await readFile(f.paths.configFile, "utf8");
    expect(source).toContain("# Retain this path");
    expect(source).toContain("path: ../original");
    expect(parse(source).worker.repositories.map(({ projectId }: { projectId: string }) => projectId)).toEqual([uuid(1), uuid(2)]);
  });

  it("switches every selected repository to the chosen agent and clears incompatible native settings", async () => {
    const f = await fixture(`${connection}worker:\n  agent: copilot\n  model: copilot-model\n  args: [--allow-all-tools]\n  repositories:\n    - projectId: ${uuid(1)}\n      remote: ${projects[0]!.repoUrl}\n      path: ../first\n      model: copilot-project-model\n      args: [--allow-all-tools]\n    - projectId: ${uuid(2)}\n      remote: ${projects[1]!.repoUrl}\n      path: ../second\n      agent: codex\n      model: retained-codex-model\n      args: [--search]\n`);
    const plan = await prepareWorkerSetup(f.options);
    expect(plan.resetGlobalNativeSettings).toBe(true);
    expect(plan.resetRepositories.map(({ projectId }) => projectId)).toEqual([uuid(1)]);
    const result = await saveWorkerSetup(f.options);
    expect(result).toMatchObject({ agent: "codex", model: null, args: [] });
    expect(result.repositories[0]).toMatchObject({ agent: "codex", model: null, args: [] });
    expect(result.repositories[1]).toMatchObject({ agent: "codex", model: "retained-codex-model", args: ["--search"] });
    expect(parse(await readFile(f.paths.configFile, "utf8")).worker.repositories.every((repository: Record<string, unknown>) => !Object.hasOwn(repository, "agent"))).toBe(true);
  });

  it.each([
    "worker:\n  agent: codex\n", "worker:\n  model: changed\n", "worker:\n  args: [--allow-all-tools]\n",
    "repositoryRoot: ../changed\n", "serverUrl: https://changed.example\n", "serverToken: changed-credential\n",
    `worker:\n  repositories:\n    - remote: ${projects[0]!.repoUrl}\n      path: ../concurrent\n`,
  ])("rejects a stale setup after a relevant concurrent edit: %s", async (changed) => {
    const f = await fixture();
    const concurrent = stringify({ ...parse(connection), ...parse(changed) });
    await writeFile(f.paths.configFile, concurrent);
    await expect(saveWorkerSetup(f.options)).rejects.toThrow("changed during setup");
    expect(await readFile(f.paths.configFile, "utf8")).toBe(concurrent);
  });

  it("merges unrelated concurrent review and scheduling changes into the final save", async () => {
    const f = await fixture();
    await writeFile(f.paths.configFile, `${connection}# Concurrent review edit\npollIntervalMs: 1800\nworker:\n  maxConcurrent: 9\n`);
    await saveWorkerSetup(f.options);
    const source = await readFile(f.paths.configFile, "utf8");
    expect(source).toContain("# Concurrent review edit");
    expect(parse(source)).toMatchObject({ pollIntervalMs: 1800, worker: { agent: "codex", maxConcurrent: 9 } });
  });

  it("refuses invalid Project sets and physical path collisions before any write", async () => {
    const f = await fixture(`${connection}repositoryRoot: .\n`);
    await expect(saveWorkerSetup({ ...f.options, projectIds: [] })).rejects.toThrow("at least one");
    await expect(saveWorkerSetup({ ...f.options, projectIds: [uuid(1), uuid(1)] })).rejects.toThrow("distinct");
    await expect(saveWorkerSetup({ ...f.options, projectIds: [uuid(99)] })).rejects.toThrow("not an accessible");
    await expect(saveWorkerSetup(f.options)).rejects.toThrow("overlaps the Daynight state directory");
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });
});

describe("interactive worker setup", () => {
  it("checks first, preselects existing Projects, checks effective agent settings and confirms one atomic save", async () => {
    const f = await fixture(`${connection}worker:\n  agent: codex\n  repositories:\n    - projectId: ${uuid(1)}\n      remote: ${projects[0]!.repoUrl}\n      path: ../retained\n`);
    await runWorkerSetup(f.context, f.dependencies);
    expect(f.dependencies.inspectEnvironment.mock.invocationCallOrder[0]).toBeLessThan(f.dependencies.readProjects.mock.invocationCallOrder[0]!);
    expect(f.questions).toEqual([
      expect.objectContaining({ message: "Which agent should execute tasks?", default: "codex" }),
      expect.objectContaining({ choices: projects.map(({ id, name, repoUrl }) => ({ name: `${name} · ${id} · ${repoUrl}`, value: id, checked: id === uuid(1) })) }),
      expect.objectContaining({ message: "Save this worker configuration?", default: true }),
    ]);
    expect(f.dependencies.inspectEnvironment).toHaveBeenCalledTimes(2);
    expect(f.dependencies.inspectEnvironment.mock.calls[1]![0]).toMatchObject({ configuration: { agent: "codex", model: null, args: [] } });
    expect(f.dependencies.save).toHaveBeenCalledOnce();
    expect((await readWorkerConfiguration(f.paths)).repositories).toHaveLength(2);
    expect(f.output.join("")).toContain("worker run");
    expect(f.context.stdout).not.toHaveBeenCalled();
    expect(f.prompt.close).toHaveBeenCalledOnce();
  });

  it("inspects each distinct effective repository configuration", async () => {
    const f = await fixture(`${connection}worker:\n  agent: codex\n  repositories:\n    - projectId: ${uuid(1)}\n      remote: ${projects[0]!.repoUrl}\n      path: ../first\n      model: custom\n`);
    await runWorkerSetup(f.context, f.dependencies);
    expect(f.dependencies.inspectEnvironment.mock.calls.slice(1).map(([options]) => options.configuration)).toEqual([
      { agent: "codex", model: "custom", args: [] }, { agent: "codex", model: null, args: [] },
    ]);
  });

  it("reports missing prerequisites and saves configuration with an explicit repair instruction", async () => {
    const f = await fixture();
    f.dependencies.inspectEnvironment.mockResolvedValue([{ label: "Herdr", status: "missing", detail: "Not installed", remedy: "Install Herdr." }]);
    await runWorkerSetup(f.context, f.dependencies);
    expect(f.dependencies.save).toHaveBeenCalledOnce();
    expect(f.output.join("")).toContain("[missing] Herdr: Not installed");
    expect(f.output.join("")).toContain("Install Herdr.");
    expect(f.output.join("")).toContain("Repair the missing prerequisites above");
  });

  it("does not require the unselected native agent to be installed", async () => {
    const f = await fixture();
    f.dependencies.inspectEnvironment.mockResolvedValueOnce([{ label: "Copilot", agent: "copilot", status: "missing", detail: "Not installed" }]);
    await runWorkerSetup(f.context, f.dependencies);
    expect(f.output.join("")).not.toContain("Repair the missing prerequisites above");
  });

  it.each(["noninteractive", "login", "projects", "empty", "agent-cancel", "project-cancel", "confirmation", "selected-check", "save"] as const)("keeps configuration intact after %s", async (failure) => {
    const f = await fixture(failure === "login" ? "{}\n" : connection);
    if (failure === "noninteractive") f.prompt.isInteractive = false;
    if (failure === "projects") f.dependencies.readProjects.mockRejectedValueOnce(new Error("Project request denied."));
    if (failure === "empty") f.dependencies.readProjects.mockResolvedValueOnce([]);
    if (failure === "agent-cancel") f.prompt.select = async () => { throw new CliCancelledError(); };
    if (failure === "project-cancel") f.prompt.selectMany = async () => { throw new CliCancelledError(); };
    if (failure === "confirmation") f.answers.save = false;
    if (failure === "selected-check") f.dependencies.inspectEnvironment.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("Interrupted prerequisite check."));
    if (failure === "save") f.dependencies.save.mockRejectedValueOnce(new Error("Configuration write denied."));
    await expect(runWorkerSetup(f.context, f.dependencies)).rejects.toThrow();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
    if (failure !== "save") expect(f.dependencies.save).not.toHaveBeenCalled();
    expect(await readdir(f.paths.stateDirectory)).toEqual(["config.yml"]);
    expect(f.prompt.close).toHaveBeenCalledOnce();
  });

  it.each([[], [uuid(1), uuid(1)], [uuid(99)]])("refuses an invalid project selection %j", async (...ids) => {
    const f = await fixture();
    f.answers.projectIds = ids;
    await expect(runWorkerSetup(f.context, f.dependencies)).rejects.toThrow("available choices");
    expect(f.dependencies.save).not.toHaveBeenCalled();
  });

  it("propagates cancellation after confirmation before saving", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const reason = new Error("Cancelled after confirmation.");
    const select = f.prompt.select;
    f.prompt.select = async (question, signal) => {
      const answer = await select(question, signal);
      if (question.message.startsWith("Save")) controller.abort(reason);
      return answer;
    };
    await expect(runWorkerSetup(f.context, f.dependencies, controller.signal)).rejects.toBe(reason);
    expect(f.dependencies.save).not.toHaveBeenCalled();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });
});
