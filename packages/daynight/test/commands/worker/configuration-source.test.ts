import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { WorkerCloudValue } from "../../../src/api/worker-configuration.js";
import type { Project } from "../../../src/api/types.js";
import type { CliContext } from "../../../src/cli/context.js";
import { updateConfigurationFile } from "../../../src/config/files.js";
import { parseWorkerConfiguration } from "../../../src/commands/worker/config.js";
import {
  assertWorkerConfigurationIsLocal, parseWorkerCloudBootstrap, parseWorkerLocalConfiguration,
  readWorkerLocalConfiguration, resolveCloudNative, workerLocalRepositoryForId, workerLocalRepositoryForProject,
} from "../../../src/commands/worker/configuration-source.js";
import { resolveWorkerCloudProjectNative } from "../../../src/commands/worker/configuration.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { runWorkerRepositoryCommand } from "../../../src/commands/worker/configuration-guide.js";
import { changeWorkerRepositories, prepareWorkerSetup, readWorkerRepositorySnapshot, saveWorkerSetup } from "../../../src/commands/worker/repositories.js";
import { runWorkerSetup } from "../../../src/commands/worker/setup.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const time = "2026-11-04T00:00:00Z";
const token = "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890";
const user = { id: uuid(1), email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: uuid(2), kind: "personal", name: null } };
const native = { agent: "codex" as const, model: "global", args: ["--search"] };
const value: WorkerCloudValue = { maxConcurrent: 2, pollIntervalMs: 2000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native, projects: [] };
const connection = { serverUrl: "https://service.example", serverToken: token };
const directories: string[] = [];
const fixture = async (data: Record<string, unknown> = {}) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-cloud-source-tests");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "home-"));
  directories.push(directory);
  vi.stubEnv("DN_CONFIG_DIR", path.join(directory, "configuration"));
  const paths = resolveWorkerPaths(directory);
  await mkdir(paths.stateDirectory);
  const source = stringify({ ...connection, ...data });
  await writeFile(paths.configFile, source);
  return { directory, paths, source };
};
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Daynight-User-ID": user.id, "Daynight-Worker-Configuration": "1" },
});
const cloudFetch = (desired: unknown) => vi.fn<typeof globalThis.fetch>()
  .mockResolvedValueOnce(response(user))
  .mockResolvedValueOnce(response({ desired, observationRevision: "0", observation: null }));
const project: Project = {
  id: uuid(3), name: "Project", repoUrl: "https://git.example/team/repo.git", settings: { version: 1n, executionWarningMinutes: 60 },
  ownership: { teamId: uuid(2), version: 1n }, createdAt: time, updatedAt: time,
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("Worker cloud configuration sources", () => {
  it("rejects a 129-Project bootstrap before remote lookup and leaves the source unchanged", async () => {
    const repositories = Array.from({ length: 129 }, (_, n) => ({ projectId: uuid(n + 10), remote: `https://git.example/team/repo${n}.git`, path: `../repo${n}` }));
    const f = await fixture({ worker: { repositories } });
    const resolve = vi.fn(async () => ({ id: uuid(1) }));
    await expect(parseWorkerCloudBootstrap(f.source, f.paths, resolve, new AbortController().signal)).rejects.toThrow("128");
    expect(resolve).not.toHaveBeenCalled();
    expect(() => parseWorkerConfiguration(f.source, f.paths)).toThrow("128");
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });
  it("reads only local-owned values while obsolete managed values are invalid", async () => {
    const f = await fixture({ worker: { agent: "unsupported", args: null, maxConcurrent: -1, repositories: "obsolete", repositoryRoot: "../local-repositories", agentControlMode: "web" } });
    const local = await readWorkerLocalConfiguration(f.paths);
    expect(local).toEqual({ ...connection, source: f.source, repositoryRoot: "../local-repositories", agentControlMode: "web" });
    expect(() => parseWorkerConfiguration(f.source, f.paths)).toThrow();
    expect(await workerLocalRepositoryForProject(local, f.paths, project)).toBeUndefined();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("continues validating local mode and path ownership", async () => {
    const f = await fixture();
    expect(() => parseWorkerLocalConfiguration(stringify({ worker: { agentControlMode: "unsupported" } }), f.paths)).toThrow("agentControlMode");
    expect(() => parseWorkerLocalConfiguration(stringify({ worker: { repositoryRoot: null } }), f.paths)).toThrow("repositoryRoot");
  });

  it("imports raw override intent and resolves project identities without preparing repositories", async () => {
    const f = await fixture({ worker: { ...native, repositories: [
      { projectId: uuid(3).toUpperCase(), remote: project.repoUrl, path: "../old", model: null },
      { remote: "git@git.example:team/second.git", path: "../second", agent: "claude", args: [] },
    ] } });
    const resolve = vi.fn(async (repository: { repoUrl: string; projectId?: string }) => ({ id: repository.projectId === undefined ? uuid(4) : repository.projectId }));
    const seed = await parseWorkerCloudBootstrap(f.source, f.paths, resolve, new AbortController().signal);
    expect(seed.native).toEqual(native);
    expect(seed.projects).toEqual([
      { projectId: uuid(3), nativeOverrides: { model: null } },
      { projectId: uuid(4), nativeOverrides: { agent: "claude", args: [] } },
    ]);
    expect(resolve.mock.calls.map(([repository]) => repository)).toEqual([
      { repoUrl: project.repoUrl, projectId: uuid(3) }, { repoUrl: "git@git.example:team/second.git" },
    ]);
    expect(await readdir(f.directory)).toEqual(["configuration"]);
  });

  it("permits an empty first import and leaves tool-specific failures to item application", async () => {
    const f = await fixture({ worker: { agent: "codex", args: ["--model", "controlled-by-worker"], maxConcurrent: 4 } });
    const resolve = vi.fn(async () => ({ id: project.id }));
    const seed = await parseWorkerCloudBootstrap(f.source, f.paths, resolve, new AbortController().signal);
    expect(seed).toMatchObject({ maxConcurrent: 4, native: { args: ["--model", "controlled-by-worker"] }, projects: [] });
    expect(resolve).not.toHaveBeenCalled();
    expect(() => resolveCloudNative(seed.native, "herdr", seed.recoveryLimit)).toThrow();
  });

  it("imports the optional platform preference with a false default and strict explicit booleans", async () => {
    const f = await fixture();
    const resolve = vi.fn(async () => ({ id: project.id }));
    for (const preference of [true, false]) {
      const seed = await parseWorkerCloudBootstrap(stringify({ worker: { preferPlatformSpecificTasks: preference } }), f.paths, resolve, new AbortController().signal);
      expect(seed.preferPlatformSpecificTasks).toBe(preference);
    }
    expect((await parseWorkerCloudBootstrap(f.source, f.paths, resolve, new AbortController().signal)).preferPlatformSpecificTasks).toBe(false);
    await expect(parseWorkerCloudBootstrap(stringify({ worker: { preferPlatformSpecificTasks: "true" } }), f.paths, resolve, new AbortController().signal)).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not replace invalid explicit first-import values with defaults", async () => {
    const f = await fixture({ worker: { maxConcurrent: 0 } });
    await expect(parseWorkerCloudBootstrap(f.source, f.paths, async () => ({ id: project.id }), new AbortController().signal)).rejects.toThrow();
  });

  it("reuses only the selected local path without parsing old native overrides", async () => {
    const f = await fixture({ worker: { repositories: [
      null, { projectId: uuid(9), path: null, agent: null }, { remote: "obsolete", path: null },
      { projectId: project.id, remote: project.repoUrl, path: "../retained", agent: null, args: "obsolete" },
    ] } });
    const local = await readWorkerLocalConfiguration(f.paths);
    expect(await workerLocalRepositoryForProject(local, f.paths, project)).toEqual({ projectId: project.id, remote: project.repoUrl, path: path.join(f.directory, "retained") });
    expect(await workerLocalRepositoryForId(local, f.paths, project.id)).toEqual({ projectId: project.id, remote: project.repoUrl, path: path.join(f.directory, "retained") });
    expect(await workerLocalRepositoryForId(local, f.paths, uuid(8))).toBeUndefined();
  });

  it("rejects selected mapping conflicts and physical overlaps with local state", async () => {
    const f = await fixture({ worker: { repositories: [{ projectId: project.id, remote: "https://other.example/repo", path: "../retained" }] } });
    await expect(workerLocalRepositoryForProject(await readWorkerLocalConfiguration(f.paths), f.paths, project)).rejects.toThrow("conflicts");
    const alias = path.join(f.directory, "state-link");
    await symlink(f.paths.stateDirectory, alias, process.platform === "win32" ? "junction" : "dir");
    const source = stringify({ ...connection, worker: { repositories: [{ projectId: project.id, remote: project.repoUrl, path: alias }] } });
    await expect(workerLocalRepositoryForProject(parseWorkerLocalConfiguration(source, f.paths), f.paths, project)).rejects.toThrow("physically overlaps");
  });

  it("preserves inheritance, explicit clears and native-kind changes", () => {
    expect(resolveCloudNative(resolveWorkerCloudProjectNative(native, { projectId: project.id, nativeOverrides: {} }), "herdr", 7)).toEqual({ ...native, agentControlMode: "herdr", recoveryLimit: 7 });
    expect(resolveCloudNative(resolveWorkerCloudProjectNative(native, { projectId: project.id, nativeOverrides: { model: null, args: [] } }), "herdr", 7)).toMatchObject({ agent: "codex", model: null, args: [], recoveryLimit: 7 });
    expect(resolveCloudNative(resolveWorkerCloudProjectNative(native, { projectId: project.id, nativeOverrides: { agent: "claude" } }), "web", 0)).toEqual({ agent: "claude", model: null, args: [], agentControlMode: "web", recoveryLimit: 0 });
  });

  it("checks cloud ownership despite an absent cache and preserves the local file", async () => {
    const f = await fixture({ workerId: uuid(5), worker: { agent: "invalid-managed-value" } });
    const fetch = cloudFetch({ revision: "1", updatedAt: time, value });
    await expect(assertWorkerConfigurationIsLocal(f.paths, undefined, { fetch })).rejects.toThrow("cloud-managed");
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://service.example/api/v1/me", `https://service.example/api/v1/me/workers/${uuid(5)}/configuration`,
    ]);
    expect(await readdir(f.paths.stateDirectory)).toEqual(["config.yml"]);
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("refuses setup before environment probes or prompts when cloud-managed", async () => {
    const f = await fixture({ workerId: uuid(5), worker: { agent: "invalid-managed-value" } });
    vi.stubGlobal("fetch", cloudFetch({ revision: "1", updatedAt: time, value }));
    const inspect = vi.fn(async () => []);
    const select = vi.fn(async () => { throw new Error("Prompt must not run."); });
    const context: CliContext = {
      version: "0.0.0", packageDirectory: f.directory, homeDirectory: () => f.directory, workingDirectory: () => f.directory,
      stdout: vi.fn(), stderr: vi.fn(), stdoutBytes: vi.fn(async () => {}),
      prompt: { isInteractive: true, ask: select, select, selectMany: select, close: vi.fn() },
    };
    await expect(runWorkerSetup(context, { inspectEnvironment: inspect, readSnapshot: readWorkerRepositorySnapshot, readProjects: vi.fn(async () => []), prepare: prepareWorkerSetup, save: saveWorkerSetup })).rejects.toThrow("cloud-managed");
    expect(inspect).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("does not present obsolete local selection as the cloud-managed repository list", async () => {
    const f = await fixture({ workerId: uuid(5), worker: { repositories: "obsolete-managed-value" } });
    vi.stubGlobal("fetch", cloudFetch({ revision: "1", updatedAt: time, value }));
    const context: CliContext = {
      version: "0.0.0", packageDirectory: f.directory, homeDirectory: () => f.directory, workingDirectory: () => f.directory,
      stdout: vi.fn(), stderr: vi.fn(), stdoutBytes: vi.fn(async () => {}),
    };
    await expect(runWorkerRepositoryCommand({ kind: "list", json: true }, context)).rejects.toThrow("cloud-managed");
    expect(context.stdout).not.toHaveBeenCalled();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("rechecks cloud ownership immediately before a local write after the selection snapshot", async () => {
    const f = await fixture();
    const snapshot = await readWorkerRepositorySnapshot(f.paths);
    const source = stringify({ ...connection, workerId: uuid(5) });
    await writeFile(f.paths.configFile, source);
    vi.stubGlobal("fetch", cloudFetch({ revision: "1", updatedAt: time, value }));
    await expect(changeWorkerRepositories({ paths: f.paths, homeDirectory: f.directory, snapshot, projects: [project], addProjectIds: [project.id] })).rejects.toThrow("cloud-managed");
    expect(await readFile(f.paths.configFile, "utf8")).toBe(source);
  });

  it("keeps remote ownership checks outside the local configuration lock", async () => {
    const f = await fixture({ workerId: uuid(5) });
    vi.stubGlobal("fetch", cloudFetch(null));
    const snapshot = await readWorkerRepositorySnapshot(f.paths);
    let entered!: () => void;
    let release!: () => void;
    const requested = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async url => {
      if (String(url).endsWith("/me")) { entered(); await gate; return response(user); }
      return response({ desired: null, observationRevision: "0", observation: null });
    }));
    const changing = changeWorkerRepositories({ paths: f.paths, homeDirectory: f.directory, snapshot, projects: [project], addProjectIds: [project.id] });
    await requested;
    try {
      await updateConfigurationFile(f.paths, async source => ({ kind: "write", source: `${source}# Concurrent local writer\n`, result: undefined, ownership: { fields: [] } }));
    } finally { release(); }
    await changing;
    expect(await readFile(f.paths.configFile, "utf8")).toContain("# Concurrent local writer");
  });

  it("retains the write baseline when the local Worker identity changes during selection", async () => {
    const f = await fixture();
    const snapshot = await readWorkerRepositorySnapshot(f.paths);
    const source = stringify({ ...connection, workerId: uuid(6) });
    await writeFile(f.paths.configFile, source);
    vi.stubGlobal("fetch", cloudFetch(null));
    await expect(changeWorkerRepositories({ paths: f.paths, homeDirectory: f.directory, snapshot, projects: [project], addProjectIds: [project.id] })).rejects.toThrow("changed while selecting projects");
    expect(await readFile(f.paths.configFile, "utf8")).toBe(source);
  });

  it("allows local configuration only for an uninitialized or confirmed missing Worker", async () => {
    const f = await fixture({ workerId: uuid(5) });
    await expect(assertWorkerConfigurationIsLocal(f.paths, undefined, { fetch: cloudFetch(null) })).resolves.toBeUndefined();
    const missing = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(user)).mockResolvedValueOnce(response({ error: { code: "not_found", message: "Worker not found.", requestId: "source-test" } }, 404));
    await expect(assertWorkerConfigurationIsLocal(f.paths, undefined, { fetch: missing })).resolves.toBeUndefined();
    const failed = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(user)).mockResolvedValueOnce(response({ error: { code: "internal_error", message: "Unavailable.", requestId: "source-test" } }, 500));
    await expect(assertWorkerConfigurationIsLocal(f.paths, undefined, { fetch: failed })).rejects.toThrow("internal_error");
  });
});
