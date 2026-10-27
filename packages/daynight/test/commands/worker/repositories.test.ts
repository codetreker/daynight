import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringifyApiJson } from "../../../src/api/json.js";
import type { Project } from "../../../src/api/types.js";
import { parseConfigurationDocument } from "../../../src/config/document.js";
import { readWorkerConfiguration } from "../../../src/commands/worker/config.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { changeWorkerRepositories, configuredWorkerProjectIds, readWorkerProjects, readWorkerRepositorySnapshot } from "../../../src/commands/worker/repositories.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const token = "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890";
const connection = `serverUrl: https://service.example\nserverToken: ${token}\n`;
const project = (number = 1, repoUrl = "https://github.com/owner/repository.git"): Project => ({
  id: uuid(number), name: `Project ${number}`, repoUrl,
  settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z",
});
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const fixture = async (source: string | undefined = connection) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-repository-tests");
  await mkdir(temporary, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(temporary, "home-"));
  directories.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  if (source !== undefined) {
    await mkdir(paths.stateDirectory);
    await writeFile(paths.configFile, source);
  }
  const snapshot = await readWorkerRepositorySnapshot(paths);
  return { paths, homeDirectory, snapshot };
};
const response = (value: unknown, status = 200): Response => new Response(stringifyApiJson(value), { status, headers: { "Content-Type": "application/json" } });

describe("worker Project registration", () => {
  it("registers selected existing Projects in one write using exact server addresses and absolute default paths", async () => {
    const f = await fixture();
    const projects = [project(), project(2, "ssh://builder@git.example:2222/group/nested/repository.git")];
    const registered = await changeWorkerRepositories({ ...f, projects, addProjectIds: [projects[0]!.id.toUpperCase(), projects[0]!.id, projects[1]!.id] });
    expect(registered).toHaveLength(2);
    expect(registered[0]).toMatchObject({ projectId: projects[0]!.id, remote: projects[0]!.repoUrl, path: path.join(f.homeDirectory, "daynights/github.com/owner/repository") });
    expect(registered[1]).toMatchObject({ projectId: projects[1]!.id, remote: projects[1]!.repoUrl });
    expect(path.isAbsolute(registered[1]!.path)).toBe(true);
    expect(registered[1]!.path).not.toBe(registered[0]!.path);
    const { mapping } = parseConfigurationDocument(await readFile(f.paths.configFile, "utf8"), f.paths);
    expect((mapping.worker as { repositories: unknown[] }).repositories).toEqual(registered.map(({ projectId, remote, path: localPath }) => ({ projectId, remote, path: localPath })));
    expect(await readdir(f.homeDirectory)).toEqual([".daynight"]);
    expect(await readdir(f.paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("preserves comments, aliases, review settings, credentials and existing execution overrides", async () => {
    const old = project(3, "https://github.com/owner/old.git");
    const source = `${connection}# Shared defaults\nreview:\n  pollIntervalMs: 120000 # review-owned\nworker:\n  repositoryRoot: &root ../clones # keep root\n  agent: codex # default\n  model: global-model\n  args: [--search]\n  repositories:\n    # Keep this repository\n    - projectId: ${old.id}\n      remote: ${old.repoUrl}\n      path: &oldPath ../old\n      agent: copilot\n      model: custom-model\n      args: [] # native defaults\n`;
    const f = await fixture(source);
    if (process.platform !== "win32") await chmod(f.paths.configFile, 0o640);
    const registered = await changeWorkerRepositories({ ...f, projects: [old, project()], addProjectIds: [uuid(1)] });
    expect(registered[0]).toEqual(f.snapshot.configuration.repositories[0]);
    expect(registered[1]).toMatchObject({ agent: "codex", model: "global-model", args: ["--search"], path: path.join(f.homeDirectory, "clones/github.com/owner/repository") });
    const saved = await readFile(f.paths.configFile, "utf8");
    for (const fragment of ["# Shared defaults", "repositoryRoot: &root ../clones # keep root", "pollIntervalMs: 120000 # review-owned", "# Keep this repository", "path: &oldPath ../old", "args: [] # native defaults", token]) expect(saved).toContain(fragment);
    if (process.platform !== "win32") expect((await stat(f.paths.configFile)).mode & 0o777).toBe(0o600);
  });

  it.each(["associate", "append", "remove"] as const)("refuses %s when a worker repository anchor is shared with the review list", async (kind) => {
    const source = `${connection}worker:\n  repositories: &sharedRepositories\n    - remote: ${project().repoUrl}\n      path: ../shared-checkout\nreview:\n  repositories: *sharedRepositories\n`;
    const f = await fixture(source);
    const selected = kind === "append" ? project(2, "https://github.com/owner/second.git") : project();
    const options = kind === "remove" ? { removeProjectIds: [selected.id] } : { addProjectIds: [selected.id] };
    await expect(changeWorkerRepositories({ ...f, projects: [selected], ...options })).rejects.toThrow("shared YAML aliases that would change unrelated settings");
    expect(await readFile(f.paths.configFile, "utf8")).toBe(source);
    expect(await readdir(f.paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("refuses an alias mutation that changes worker native arguments outside repository-command ownership", async () => {
    const source = `${connection}worker:\n  repositories: &shared []\n  args: *shared\n`;
    const f = await fixture(source);
    await expect(changeWorkerRepositories({ ...f, projects: [project()], addProjectIds: [uuid(1)] })).rejects.toThrow("shared YAML aliases that would change unrelated settings");
    expect(await readFile(f.paths.configFile, "utf8")).toBe(source);
  });

  it("keeps native arguments intact when repositories refers to their sequence anchor", async () => {
    const source = `${connection}worker:\n  args: &shared []\n  repositories: *shared\n`;
    const f = await fixture(source);
    await expect(changeWorkerRepositories({ ...f, projects: [project()], addProjectIds: [uuid(1)] })).rejects.toThrow();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(source);
  });

  it("retains aliases whose values stay outside the repository mutation", async () => {
    const source = `${connection}worker:\n  model: &sharedModel shared-model\n  repositories: []\nreview:\n  copilotModel: *sharedModel\n`;
    const f = await fixture(source);
    await changeWorkerRepositories({ ...f, projects: [project()], addProjectIds: [uuid(1)] });
    const saved = await readFile(f.paths.configFile, "utf8");
    expect(saved).toContain("model: &sharedModel shared-model");
    expect(saved).toContain("copilotModel: *sharedModel");
    const { mapping } = parseConfigurationDocument(saved, f.paths);
    expect((mapping.review as Record<string, unknown>).copilotModel).toBe("shared-model");
    expect((mapping.worker as Record<string, unknown>).model).toBe("shared-model");
  });

  it("retains native argument sequence aliases while adding a different Project", async () => {
    const old = project(3, "https://github.com/owner/old.git");
    const source = `${connection}worker:\n  args: &sharedArgs [--allow-all-tools]\n  repositories:\n    - projectId: ${old.id}\n      remote: ${old.repoUrl}\n      path: ../old\n      args: *sharedArgs\n`;
    const f = await fixture(source);
    await changeWorkerRepositories({ ...f, projects: [project()], addProjectIds: [uuid(1)] });
    const saved = await readFile(f.paths.configFile, "utf8");
    expect(saved).toMatch(/args: &sharedArgs \[\s*--allow-all-tools\s*\]/);
    expect(saved).toContain("args: *sharedArgs");
    expect((await readWorkerConfiguration(f.paths)).repositories.every(({ args }) => args.length === 1 && args[0] === "--allow-all-tools")).toBe(true);
  });

  it("uses the worker clone root independently of review configuration", async () => {
    const source = `${connection}review:\n  repositoryRoot: ../review-clones\nworker:\n  repositoryRoot: ../worker-clones\n`;
    const f = await fixture(source);
    const registered = await changeWorkerRepositories({ ...f, projects: [project()], addProjectIds: [uuid(1)] });
    expect(registered[0]!.path).toBe(path.join(f.homeDirectory, "worker-clones/github.com/owner/repository"));
    const { mapping } = parseConfigurationDocument(await readFile(f.paths.configFile, "utf8"), f.paths);
    expect((mapping.review as Record<string, unknown>).repositoryRoot).toBe("../review-clones");
    expect((mapping.worker as Record<string, unknown>).repositoryRoot).toBe("../worker-clones");
  });

  it("preserves a concurrent review clone-root change without changing the worker destination", async () => {
    const source = `${connection}review:\n  repositoryRoot: ../review-clones\nworker:\n  repositoryRoot: ../worker-clones\n`;
    const f = await fixture(source);
    await writeFile(f.paths.configFile, source.replace("../review-clones", "../updated-review-clones"));
    const registered = await changeWorkerRepositories({ ...f, projects: [project()], addProjectIds: [uuid(1)] });
    expect(registered[0]!.path).toBe(path.join(f.homeDirectory, "worker-clones/github.com/owner/repository"));
    expect(await readFile(f.paths.configFile, "utf8")).toContain("repositoryRoot: ../updated-review-clones");
  });

  it("keeps an existing destination and writes nothing when the same Project is added after a root change", async () => {
    const f = await fixture();
    await changeWorkerRepositories({ ...f, projects: [project()], addProjectIds: [uuid(1)] });
    const first = await readWorkerRepositorySnapshot(f.paths);
    await writeFile(f.paths.configFile, `${first.source!.replace("worker:\n", "worker:\n  repositoryRoot: ../different-root\n")}`);
    const snapshot = await readWorkerRepositorySnapshot(f.paths);
    const before = await readFile(f.paths.configFile, "utf8");
    const registered = await changeWorkerRepositories({ ...f, snapshot, projects: [project()], addProjectIds: [uuid(1)] });
    expect(registered).toEqual(first.configuration.repositories);
    expect(await readFile(f.paths.configFile, "utf8")).toBe(before);
  });

  it("associates a remote-only registration while retaining its transport, path and overrides", async () => {
    const source = `${connection}worker:\n  repositories:\n    - remote: git@github.com:owner/repository.git\n      path: ../original\n      agent: codex\n      model: original-model\n`;
    const f = await fixture(source);
    const registered = await changeWorkerRepositories({ ...f, projects: [project()], addProjectIds: [uuid(1)] });
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ projectId: uuid(1), remote: "git@github.com:owner/repository.git", path: path.join(f.homeDirectory, "original"), agent: "codex", model: "original-model" });
    expect(await readFile(f.paths.configFile, "utf8")).toContain("path: ../original");
  });

  it.each([
    { explicitProject: true, retained: "task" }, { explicitProject: true, retained: "claimAttempt" },
    { explicitProject: false, retained: "task" }, { explicitProject: false, retained: "claimAttempt" },
  ] as const)("retains the original transport across restart with explicitProject=$explicitProject and $retained", async ({ explicitProject, retained }) => {
    const remote = "git@github.com:owner/repository.git";
    const source = `${connection}worker:\n  repositories:\n    - remote: ${remote} # Keep SSH transport\n      path: ../original\n      agent: codex\n      model: original-model\n${explicitProject ? `      projectId: ${uuid(1)}\n` : ""}`;
    const f = await fixture(source);
    const binding = { serverOrigin: f.snapshot.serverUrl, projectId: uuid(1), repoUrl: remote, localPath: f.snapshot.configuration.repositories[0]!.path };
    const claim = { serverOrigin: binding.serverOrigin, projectId: binding.projectId, taskId: uuid(2), claimId: uuid(3), workerId: uuid(4), worktreeId: uuid(5) };
    const configuration = { agent: "codex" as const, model: "original-model", args: [], recoveryLimit: 3 };
    const attempt = { taskId: claim.taskId, claimId: claim.claimId, worktreeId: claim.worktreeId, workerId: claim.workerId, userId: uuid(6), expectedVersion: "1", configuration };
    await mkdir(f.paths.workerDirectory);
    const original = openWorkerStore(f.paths.databaseFile);
    let originalTask: ReturnType<typeof original.getTask>;
    try {
      original.registerProject(binding);
      if (retained === "task") {
        original.registerPending(claim, { kind: "new", configuration }, 10, uuid(6));
        original.activateTask(claim, 20);
      } else original.beginClaimAttempt(binding, attempt);
      originalTask = original.getTask(claim);
    } finally { original.close(); }
    await changeWorkerRepositories({ ...f, projects: [project()], addProjectIds: [uuid(1)] });
    const savedSource = await readFile(f.paths.configFile, "utf8");
    if (explicitProject) expect(savedSource).toBe(source);
    else expect(savedSource).toContain(`projectId: ${uuid(1)}`);
    expect(savedSource).toContain(`remote: ${remote} # Keep SSH transport`);
    const saved = (await readWorkerConfiguration(f.paths)).repositories[0]!;
    const reopened = openWorkerStore(f.paths.databaseFile);
    try {
      expect(reopened.registerProject({ serverOrigin: binding.serverOrigin, projectId: saved.projectId!, repoUrl: saved.remote, localPath: saved.path }))
        .toEqual({ ...binding, claimAttempt: retained === "claimAttempt" ? attempt : null });
      expect(reopened.getTask(claim)).toEqual(originalTask);
      expect(reopened.getClaimAttempt(binding)).toEqual(retained === "claimAttempt" ? attempt : null);
      expect(saved).toMatchObject({ remote, path: binding.localPath, agent: "codex", model: "original-model" });
    } finally { reopened.close(); }
  });

  it.each(["add", "remove"] as const)("refuses %s for a Project absent from the accessible remote inventory", async (kind) => {
    const f = await fixture();
    await expect(changeWorkerRepositories({ ...f, projects: [project(2)], ...(kind === "add" ? { addProjectIds: [uuid(1)] } : { removeProjectIds: [uuid(1)] }) })).rejects.toThrow("not an accessible existing remote project");
    expect(await readFile(f.paths.configFile, "utf8")).toBe(connection);
  });

  it("rejects a conflicting remote identity without committing the other selected registrations", async () => {
    const f = await fixture();
    await expect(changeWorkerRepositories({ ...f, projects: [project(), project(2)], addProjectIds: [uuid(1), uuid(2)] })).rejects.toThrow("conflicts with an existing worker repository registration");
    expect(await readFile(f.paths.configFile, "utf8")).toBe(connection);
  });

  it("removes only selected registrations and leaves physical repositories and retained worker state untouched", async () => {
    const first = project(), second = project(2, "https://github.com/owner/second.git");
    const f = await fixture(`${connection}worker:\n  repositories:\n    - projectId: ${first.id}\n      remote: ${first.repoUrl}\n      path: ../repository\n    # Keep second\n    - projectId: ${second.id}\n      remote: ${second.repoUrl}\n      path: ../second\n      agent: codex\n`);
    const localPath = path.join(f.homeDirectory, "repository");
    await mkdir(localPath);
    await writeFile(path.join(localPath, "work.txt"), "uncommitted work");
    await mkdir(f.paths.workerDirectory);
    await writeFile(f.paths.databaseFile, "retained execution evidence");
    const remaining = await changeWorkerRepositories({ ...f, projects: [first, second], removeProjectIds: [first.id] });
    expect(remaining).toEqual([f.snapshot.configuration.repositories[1]]);
    expect(await readFile(path.join(localPath, "work.txt"), "utf8")).toBe("uncommitted work");
    expect(await readFile(f.paths.databaseFile, "utf8")).toBe("retained execution evidence");
    expect(await readFile(f.paths.configFile, "utf8")).toContain("# Keep second");
    expect((await readWorkerConfiguration(f.paths)).repositories).toEqual(remaining);
    const snapshot = await readWorkerRepositorySnapshot(f.paths);
    const before = snapshot.source;
    await changeWorkerRepositories({ ...f, snapshot, projects: [first, second], removeProjectIds: [first.id] });
    expect(await readFile(f.paths.configFile, "utf8")).toBe(before);
  });

  it("removes a remote-only registration using its selected existing Project", async () => {
    const f = await fixture(`${connection}worker:\n  repositories:\n    - remote: git@github.com:owner/repository.git\n      path: ../repository\n`);
    expect(await changeWorkerRepositories({ ...f, projects: [project()], removeProjectIds: [uuid(1)] })).toEqual([]);
    expect((await readWorkerRepositorySnapshot(f.paths)).configuration.repositories).toEqual([]);
  });

  it.each([
    "worker:\n  repositoryRoot: ../changed\n",
    "worker:\n  repositories: []\n",
    "serverUrl: https://changed.example\n",
    `serverToken: ${token}changed\n`,
  ])("rejects a relevant concurrent configuration edit: %s", async (changed) => {
    const f = await fixture();
    const source = changed.startsWith("serverUrl") ? connection.replace("serverUrl: https://service.example\n", changed)
      : changed.startsWith("serverToken") ? connection.replace(`serverToken: ${token}\n`, changed) : `${connection}${changed}`;
    await writeFile(f.paths.configFile, source);
    await expect(changeWorkerRepositories({ ...f, projects: [project()], addProjectIds: [uuid(1)] })).rejects.toThrow("changed while selecting projects");
    expect(await readFile(f.paths.configFile, "utf8")).toBe(source);
  });

  it("preserves unrelated edits made while the remote inventory or selection is pending", async () => {
    const f = await fixture();
    const source = `${connection}# Concurrent settings\nworker:\n  maxConcurrent: 3\n  agent: codex\n  args: [--search]\nreview:\n  pollIntervalMs: 90000 # review\n`;
    await writeFile(f.paths.configFile, source);
    const registered = await changeWorkerRepositories({ ...f, projects: [project()], addProjectIds: [uuid(1)] });
    expect(registered[0]).toMatchObject({ agent: "codex", args: ["--search"] });
    const saved = await readFile(f.paths.configFile, "utf8");
    expect(saved).toContain("# Concurrent settings");
    expect(saved).toContain("maxConcurrent: 3");
    expect(saved).toContain("pollIntervalMs: 90000 # review");
  });

  it("rejects physical aliases into an existing registered path without creating a clone", async () => {
    const f = await fixture(`${connection}worker:\n  repositoryRoot: ../clones\n  repositories:\n    - projectId: ${uuid(2)}\n      remote: https://github.com/other/second.git\n      path: ../existing\n`);
    await mkdir(path.join(f.homeDirectory, "existing"));
    await mkdir(path.join(f.homeDirectory, "clones/github.com/owner"), { recursive: true });
    await symlink(path.join(f.homeDirectory, "existing"), path.join(f.homeDirectory, "clones/github.com/owner/repository"), process.platform === "win32" ? "junction" : "dir");
    await expect(changeWorkerRepositories({ ...f, projects: [project()], addProjectIds: [uuid(1)] })).rejects.toThrow("physically overlaps another worker repository");
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.snapshot.source);
    expect(await readdir(path.join(f.homeDirectory, "existing"))).toEqual([]);
  });

  it("does not write when cancelled before registration", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const reason = new Error("selection cancelled");
    controller.abort(reason);
    await expect(changeWorkerRepositories({ ...f, projects: [project()], addProjectIds: [uuid(1)], signal: controller.signal })).rejects.toBe(reason);
    expect(await readFile(f.paths.configFile, "utf8")).toBe(connection);
    expect(await readdir(f.paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("resolves configured Project IDs without conflating ambiguous remote-only registrations", async () => {
    const f = await fixture(`${connection}worker:\n  repositories:\n    - remote: git@github.com:owner/repository.git\n      path: ../repository\n`);
    expect(configuredWorkerProjectIds(f.snapshot, [project()])).toEqual([uuid(1)]);
    expect(configuredWorkerProjectIds(f.snapshot, [])).toEqual([]);
    expect(() => configuredWorkerProjectIds(f.snapshot, [project(), project(2)])).toThrow("matches multiple remote projects");
  });
});

describe("worker existing Project queries", () => {
  it("reads the complete accessible Project inventory and returns before any configuration mutation", async () => {
    const f = await fixture();
    const requests: { url: string; authorization: string | null }[] = [];
    const fetchProjects: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url: url.href, authorization: new Headers(init?.headers).get("Authorization") });
      return response({ items: [url.searchParams.has("cursor") ? project(2, "https://github.com/owner/second.git") : project()], nextCursor: url.searchParams.has("cursor") ? null : "second-page" });
    };
    expect(await readWorkerProjects(f.snapshot, undefined, { fetch: fetchProjects })).toEqual([project(), project(2, "https://github.com/owner/second.git")]);
    expect(requests).toHaveLength(2);
    expect(requests.every(({ authorization }) => authorization === `Bearer ${token}`)).toBe(true);
    expect(requests[1]!.url).toContain("cursor=second-page");
    expect(await readFile(f.paths.configFile, "utf8")).toBe(connection);
    expect(await readdir(f.paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("requires login without making a request", async () => {
    const f = await fixture("{}\n");
    const request = vi.fn<typeof globalThis.fetch>();
    await expect(readWorkerProjects(f.snapshot, undefined, { fetch: request })).rejects.toThrow("Run daynight login");
    expect(request).not.toHaveBeenCalled();
  });

  it("retains cancellation before querying remote projects", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const reason = new Error("project selection cancelled");
    controller.abort(reason);
    const request = vi.fn<typeof globalThis.fetch>();
    await expect(readWorkerProjects(f.snapshot, controller.signal, { fetch: request })).rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
  });

  it("propagates unavailable remote inventory without changing local registrations", async () => {
    const f = await fixture();
    const unavailable: typeof globalThis.fetch = async () => response({ code: "forbidden", message: "Access denied.", requestId: "request-1" }, 403);
    await expect(readWorkerProjects(f.snapshot, undefined, { fetch: unavailable })).rejects.toThrow();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(connection);
  });

  it("bounds a stalled request independently of later user interaction", async () => {
    const f = await fixture();
    const stalled: typeof globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener("abort", () => { reject(signal.reason); }, { once: true });
      if (signal.aborted) reject(signal.reason);
    });
    await expect(readWorkerProjects(f.snapshot, undefined, { fetch: stalled, operationLimits: { requestMs: 25, totalMs: 1_000 } })).rejects.toThrow();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(connection);
  });
});
