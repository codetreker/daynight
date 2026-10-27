import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import type { Project } from "../../../src/api/types.js";
import { CliCancelledError } from "../../../src/cli/cancellation.js";
import type { CliContext } from "../../../src/cli/context.js";
import type { PromptMultipleSelection } from "../../../src/cli/prompts.js";
import { readWorkerConfiguration } from "../../../src/commands/worker/config.js";
import { ensureWorkerRepositories, runWorkerRepositoryCommand } from "../../../src/commands/worker/configuration-guide.js";
import type { WorkerRepositoryGuideDependencies } from "../../../src/commands/worker/configuration-guide.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { changeWorkerRepositories, configuredWorkerProjectIds, readWorkerProjects, readWorkerRepositorySnapshot } from "../../../src/commands/worker/repositories.js";

const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const date = "2026-10-27T00:00:00Z";
const project = (id: string, name: string, repoUrl: string): Project => ({
  id, name, repoUrl, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: date, updatedAt: date,
});
const projects = [project(firstId, "First Project", "https://github.com/example/first.git"), project(secondId, "Second Project", "https://github.com/example/second.git")];
const directories: string[] = [];
const configuredRepository = { projectId: firstId, remote: projects[0]!.repoUrl, path: path.resolve("configured", "first") };
const configurationContents = [".daynight", path.join(".daynight", "config.yml")];
const fixture = async (source: string | null = "# Keep worker settings\nworker:\n  maxConcurrent: 3\n") => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-guide-tests");
  await mkdir(temporary, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(temporary, "home-"));
  directories.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  if (source !== null) { await mkdir(paths.stateDirectory); await writeFile(paths.configFile, source); }
  const questions: unknown[] = [];
  const prompt = {
    isInteractive: true,
    ask: vi.fn(async () => { throw new Error("Free-text repository input is not supported."); }),
    select: async <Value>(): Promise<Value> => { throw new Error("Expected a multiselect."); },
    selectMany: async <Value>(question: PromptMultipleSelection<Value>): Promise<Value[]> => { questions.push(question); return question.choices.map(({ value }) => value); },
    close: vi.fn(),
  };
  const context: CliContext = {
    version: "0.0.0", packageDirectory: homeDirectory, homeDirectory: () => homeDirectory,
    workingDirectory: () => { throw new Error("Worker repository configuration must not depend on cwd."); },
    stdout: vi.fn(), stderr: vi.fn(), stdoutBytes: vi.fn(async () => {}), prompt,
  };
  const dependencies = {
    readConfiguration: vi.fn(readWorkerConfiguration),
    readSnapshot: vi.fn(readWorkerRepositorySnapshot),
    readProjects: vi.fn<WorkerRepositoryGuideDependencies["readProjects"]>(async () => projects),
    configuredProjectIds: vi.fn(configuredWorkerProjectIds),
    change: vi.fn(changeWorkerRepositories),
  };
  return { context, dependencies, homeDirectory, paths, prompt, questions, source };
};
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("worker repository startup guide", () => {
  it("selects multiple existing Projects once and saves before runtime settings are loaded", async () => {
    const f = await fixture();
    await ensureWorkerRepositories(f.context, f.dependencies);
    expect(f.dependencies.readProjects).toHaveBeenCalledOnce();
    expect(f.questions).toEqual([{
      message: "Run tasks from which existing Daynight Projects?",
      choices: projects.map(({ id, name, repoUrl }) => ({ name: `${name} · ${id} · ${repoUrl}`, value: id })),
      requiredMessage: "Select at least one Project.",
    }]);
    const saved = await readWorkerConfiguration(f.paths);
    expect(saved.maxConcurrent).toBe(3);
    expect(saved.repositories.map(({ projectId, remote, path: local }) => ({ projectId, remote, local }))).toEqual(projects.map(({ id, repoUrl }, index) => ({
      projectId: id, remote: repoUrl, local: path.join(f.homeDirectory, "daynights/github.com/example", index === 0 ? "first" : "second"),
    })));
    expect(await readFile(f.paths.configFile, "utf8")).toContain("# Keep worker settings");
    expect((await readdir(f.homeDirectory, { recursive: true })).sort()).toEqual(configurationContents);
    expect(f.prompt.ask).not.toHaveBeenCalled();
    expect(f.prompt.close).toHaveBeenCalledOnce();
  });

  it("returns directly for nonempty configuration without remote discovery or prompts", async () => {
    const source = stringify({ worker: { repositories: [configuredRepository] } });
    const f = await fixture(source);
    await ensureWorkerRepositories(f.context, f.dependencies);
    expect(f.dependencies.readSnapshot).not.toHaveBeenCalled();
    expect(f.dependencies.readProjects).not.toHaveBeenCalled();
    expect(f.dependencies.change).not.toHaveBeenCalled();
    expect(f.questions).toEqual([]);
    expect(await readFile(f.paths.configFile, "utf8")).toBe(source);
  });

  it("requires authentication before asking for Projects and creates no missing configuration", async () => {
    const f = await fixture(null);
    f.dependencies.readProjects.mockImplementation(readWorkerProjects);
    await expect(ensureWorkerRepositories(f.context, f.dependencies)).rejects.toThrow("daynight login");
    expect(f.questions).toEqual([]);
    expect(f.dependencies.change).not.toHaveBeenCalled();
    expect(await readdir(f.homeDirectory)).toEqual([]);
  });

  it.each(["empty", "api", "noninteractive", "cancel", "save"] as const)("stops without startup resources on %s", async (failureKind) => {
    const f = await fixture();
    if (failureKind === "empty") f.dependencies.readProjects.mockResolvedValueOnce([]);
    if (failureKind === "api") f.dependencies.readProjects.mockRejectedValueOnce(new Error("Project pagination failed."));
    if (failureKind === "noninteractive") f.prompt.isInteractive = false;
    if (failureKind === "cancel") f.prompt.selectMany = async () => { throw new CliCancelledError(); };
    if (failureKind === "save") f.dependencies.change.mockRejectedValueOnce(new Error("Configuration write denied."));
    await expect(ensureWorkerRepositories(f.context, f.dependencies)).rejects.toThrow();
    if (failureKind !== "save") expect(f.dependencies.change).not.toHaveBeenCalled();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
    expect((await readdir(f.homeDirectory, { recursive: true })).sort()).toEqual(configurationContents);
    expect(f.prompt.close).toHaveBeenCalledOnce();
  });

  it.each([[], ["not-in-the-inventory"], [firstId, firstId]].map((ids) => ({ ids })))("rejects an invalid multiselect result $ids before writing", async ({ ids }) => {
    const f = await fixture();
    f.prompt.selectMany = async <Value>() => ids as Value[];
    await expect(ensureWorkerRepositories(f.context, f.dependencies)).rejects.toThrow("available choices");
    expect(f.dependencies.change).not.toHaveBeenCalled();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("propagates cancellation before reading configuration", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const reason = new Error("Cancelled before startup setup.");
    controller.abort(reason);
    await expect(ensureWorkerRepositories(f.context, f.dependencies, controller.signal)).rejects.toBe(reason);
    expect(f.dependencies.readConfiguration).not.toHaveBeenCalled();
    expect(f.dependencies.readSnapshot).not.toHaveBeenCalled();
    expect(f.dependencies.change).not.toHaveBeenCalled();
  });

  it("does not persist a selection returned after caller cancellation", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const reason = new Error("Project selection cancelled.");
    f.prompt.selectMany = async <Value>() => { controller.abort(reason); return [firstId] as Value[]; };
    await expect(ensureWorkerRepositories(f.context, f.dependencies, controller.signal)).rejects.toBe(reason);
    expect(f.dependencies.change).not.toHaveBeenCalled();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });
});

describe("worker repository commands", () => {
  it.each([false, true])("lists only configured repository summaries without authentication (json: %j)", async (json) => {
    const f = await fixture(stringify({ worker: { repositories: [{ ...configuredRepository, model: "private-model", args: [] }] } }));
    await runWorkerRepositoryCommand({ kind: "list", json }, f.context, f.dependencies);
    expect(f.dependencies.readProjects).not.toHaveBeenCalled();
    expect(f.dependencies.change).not.toHaveBeenCalled();
    const output = vi.mocked(f.context.stdout).mock.calls[0]![0];
    if (json) expect(JSON.parse(output)).toEqual([{ projectId: firstId, remote: configuredRepository.remote, path: configuredRepository.path }]);
    else { expect(output).toContain(firstId); expect(output).toContain(configuredRepository.remote); }
    expect(output).not.toContain("private-model");
  });

  it.each(["add", "remove"] as const)("supports explicit Project IDs without a terminal for %s", async (kind) => {
    const f = await fixture(stringify({ worker: { repositories: kind === "remove" ? [configuredRepository] : [] } }));
    f.prompt.isInteractive = false;
    await runWorkerRepositoryCommand({ kind, projectId: firstId }, f.context, f.dependencies);
    expect(f.dependencies.readProjects).toHaveBeenCalledOnce();
    expect(f.questions).toEqual([]);
    const saved = parse(await readFile(f.paths.configFile, "utf8"));
    expect(saved.worker.repositories).toHaveLength(kind === "add" ? 1 : 0);
  });

  it.each(["add", "remove"] as const)("rejects inaccessible Project IDs for %s without writing", async (kind) => {
    const f = await fixture(stringify({ worker: { repositories: [configuredRepository] } }));
    f.dependencies.readProjects.mockResolvedValueOnce([projects[1]!]);
    await expect(runWorkerRepositoryCommand({ kind, projectId: firstId }, f.context, f.dependencies)).rejects.toThrow("does not exist or is not accessible");
    expect(f.dependencies.change).not.toHaveBeenCalled();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("offers only configured remote Projects for interactive removal", async () => {
    const f = await fixture(stringify({ worker: { repositories: [configuredRepository] } }));
    await runWorkerRepositoryCommand({ kind: "remove" }, f.context, f.dependencies);
    expect(f.questions).toEqual([expect.objectContaining({ choices: [{ name: `${projects[0]!.name} · ${firstId} · ${projects[0]!.repoUrl}`, value: firstId }] })]);
    expect((await readWorkerConfiguration(f.paths)).repositories).toEqual([]);
  });

  it("offers only unconfigured remote Projects for interactive addition", async () => {
    const f = await fixture(stringify({ worker: { repositories: [configuredRepository] } }));
    await runWorkerRepositoryCommand({ kind: "add" }, f.context, f.dependencies);
    expect(f.questions).toEqual([expect.objectContaining({ choices: [{ name: `${projects[1]!.name} · ${secondId} · ${projects[1]!.repoUrl}`, value: secondId }] })]);
    expect((await readWorkerConfiguration(f.paths)).repositories.map(({ projectId }) => projectId)).toEqual([firstId, secondId]);
  });
});
