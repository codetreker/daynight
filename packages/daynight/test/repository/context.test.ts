import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createOperation } from "../../src/api/index.js";
import type { Operation, Project } from "../../src/api/index.js";
import { resolveProject } from "../../src/repository/context.js";
import { ProjectDiscoveryError } from "../../src/repository/discovery-error.js";
import type { ProjectApi, ProjectBinding } from "../../src/repository/binding.js";
import { formatError } from "../../src/platform/diagnostics.js";

const id = "11111111-1111-1111-1111-111111111111";
const otherId = "22222222-2222-2222-2222-222222222222";
const serverUrl = "http://localhost:8787";
const project: Project = { id, name: "Project", repoUrl: "https://git.example/Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z" };
const directories: string[] = [];
const operations: Operation[] = [];
afterEach(async () => {
  operations.splice(0).forEach((operation) => operation.dispose());
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const operation = (): Operation => { const value = createOperation(); operations.push(value); return value; };
const fixture = async () => {
  const temporary = path.resolve(import.meta.dirname, "../../../../.tmp/repository-tests");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "context 用户 "));
  directories.push(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "git@git.example:Org/Repo.git"]);
  return root;
};
const api = (projects: readonly Project[] = [project]) => ({
  listProjects: vi.fn<ProjectApi["listProjects"]>().mockResolvedValue(projects),
  getProject: vi.fn<ProjectApi["getProject"]>().mockImplementation(async (projectId) => {
    const found = projects.find((candidate) => candidate.id === projectId);
    if (found === undefined) throw notFound(projectId);
    return found;
  }),
});
const notFound = (projectId = id) => new ApiError({ operation: "project.show", projectId }, "response", { cause: new Error("Project was not found."), status: 404, serverError: { code: "not_found", message: "Project was not found.", requestId: "request-missing" }, confirmedRefusal: true });
const save = async (root: string, binding: Partial<ProjectBinding> = {}) => {
  await mkdir(path.join(root, ".daynight"), { recursive: true });
  await writeFile(path.join(root, ".daynight/project.yml"), stringify({ serverUrl, repoIdentity: "git.example/Org/Repo", projectId: id, ...binding }));
};

describe("repository project selection", () => {
  it("uses explicit project outside a repository without touching Git or metadata", async () => {
    const client = api();
    const result = await resolveProject({ serverUrl, operation: operation(), api: client, workingDirectory: path.resolve("does-not-exist"), projectId: id });
    expect(result).toBe(project);
    expect(client.getProject).toHaveBeenCalledExactlyOnceWith(id);
    expect(client.listProjects).not.toHaveBeenCalled();
  });

  it("discovers by equivalent remote from a subdirectory and persists only after detail verification", async () => {
    const root = await fixture();
    const child = path.join(root, "source");
    await mkdir(child);
    const client = api();
    expect(await resolveProject({ serverUrl, operation: operation(), api: client, workingDirectory: child })).toBe(project);
    expect(client.listProjects).toHaveBeenCalledOnce();
    expect(client.getProject).toHaveBeenCalledExactlyOnceWith(id);
    expect(await readFile(path.join(root, ".daynight/project.yml"), "utf8")).toBe(stringify({ serverUrl, repoIdentity: "git.example/Org/Repo", projectId: id }));
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("/.daynight/\n");
    expect(await readdir(path.join(root, ".daynight"))).toEqual(["project.yml"]);
  });

  it("writes separate bindings in a linked worktree and a submodule", async () => {
    const source = await fixture(), parent = await fixture();
    const git = (root: string, args: string[], input?: string) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000, ...(input === undefined ? {} : { input }) }).trim();
    const tree = git(source, ["mktree"], "");
    const commit = git(source, ["hash-object", "-t", "commit", "-w", "--stdin"], `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nFixture\n`);
    git(source, ["update-ref", "refs/heads/main", commit]); git(source, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const linked = path.join(source, "linked worktree 中文"); git(source, ["worktree", "add", "--detach", linked, "HEAD"]);
    git(parent, ["-c", "protocol.file.allow=always", "submodule", "add", source, "module 中文"]);
    const submodule = path.join(parent, "module 中文"); git(submodule, ["remote", "set-url", "origin", "ssh://git@git.example/Org/Repo.git"]);
    const expected = { serverUrl, repoIdentity: "git.example/Org/Repo", projectId: id };
    for (const root of [linked, submodule]) {
      expect((await lstat(path.join(root, ".git"))).isFile()).toBe(true);
      const client = api();
      expect(await resolveProject({ serverUrl, operation: operation(), api: client, workingDirectory: root })).toBe(project);
      expect(await readFile(path.join(root, ".daynight/project.yml"), "utf8")).toBe(stringify(expected));
      expect(git(root, ["check-ignore", "--", ".daynight/project.yml"])).toBe(".daynight/project.yml");
      expect(client.listProjects).toHaveBeenCalledOnce(); expect(client.getProject).toHaveBeenCalledWith(id);
    }
    for (const root of [source, parent]) await expect(lstat(path.join(root, ".daynight"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports a real access-denied binding read without rediscovery or writes", async () => {
    const root = await fixture(); await save(root);
    const file = path.join(root, ".daynight/project.yml"), original = await readFile(file, "utf8"), client = api();
    await chmod(file, 0o000);
    try {
      const failure = await resolveProject({ serverUrl, operation: operation(), api: client, workingDirectory: root }).catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ message: `Cannot read repository binding ${file}.`, cause: { code: "EACCES" } });
      expect(formatError(failure)).toContain("Cannot read repository binding"); expect(formatError(failure)).toContain("EACCES");
      expect(client.listProjects).not.toHaveBeenCalled(); expect(client.getProject).not.toHaveBeenCalled();
    } finally { await chmod(file, 0o600); }
    expect(await readFile(file, "utf8")).toBe(original); await expect(lstat(path.join(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a verified cached target when another project is later registered for the same repo", async () => {
    const root = await fixture();
    await save(root);
    const source = await readFile(path.join(root, ".daynight/project.yml"), "utf8");
    const client = api([project, { ...project, id: otherId }]);
    expect(await resolveProject({ serverUrl, operation: operation(), api: client, workingDirectory: root })).toBe(project);
    expect(client.getProject).toHaveBeenCalledExactlyOnceWith(id);
    expect(client.listProjects).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, ".daynight/project.yml"), "utf8")).toBe(source);
  });

  it.each(["server", "origin"])("rediscovers when only the %s context changes", async (change) => {
    const root = await fixture();
    await save(root);
    const nextProject = change === "origin" ? { ...project, id: otherId, repoUrl: "https://git.example/Other/Repo" } : { ...project, id: otherId };
    if (change === "origin") execFileSync("git", ["-C", root, "remote", "set-url", "origin", nextProject.repoUrl]);
    const currentServer = change === "server" ? "https://another.example" : serverUrl;
    const client = api([nextProject]);
    expect(await resolveProject({ serverUrl: currentServer, operation: operation(), api: client, workingDirectory: root })).toBe(nextProject);
    expect(client.listProjects).toHaveBeenCalledOnce();
    expect(client.getProject).toHaveBeenCalledExactlyOnceWith(otherId);
    expect(await readFile(path.join(root, ".daynight/project.yml"), "utf8")).toContain(currentServer);
  });

  it.each(["404", "association"])("rediscovers once after a cached %s mismatch", async (kind) => {
    const root = await fixture();
    await save(root);
    const next = { ...project, id: otherId };
    const client = api([next]);
    if (kind === "association") client.getProject.mockImplementation(async (projectId) => projectId === id ? { ...project, repoUrl: "https://git.example/Changed/Repo" } : next);
    expect(await resolveProject({ serverUrl, operation: operation(), api: client, workingDirectory: root })).toEqual(next);
    expect(client.listProjects).toHaveBeenCalledOnce();
    expect(client.getProject.mock.calls.map(([projectId]) => projectId)).toEqual([id, otherId, id]);
  });

  it("preserves server errors instead of interpreting them as missing cache", async () => {
    const root = await fixture();
    await save(root);
    const failure = new ApiError({ operation: "project.show", projectId: id }, "response", { cause: new Error("Database unavailable"), status: 500, serverError: { code: "internal", message: "Unavailable", requestId: "server-error" } });
    const client = api();
    client.getProject.mockRejectedValue(failure);
    await expect(resolveProject({ serverUrl, operation: operation(), api: client, workingDirectory: root })).rejects.toBe(failure);
    expect(client.listProjects).not.toHaveBeenCalled();
    await expect(readFile(path.join(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves cached GET cancellation and response cleanup errors without rediscovery", async () => {
    const root = await fixture();
    await save(root);
    const source = new AbortController();
    const op = createOperation({ signal: source.signal }); operations.push(op);
    const client = api();
    const cleanupFailure = new Error("Response stream cancellation cleanup failed");
    let failure: ApiError | undefined;
    client.getProject.mockImplementation(async () => {
      source.abort(new Error("Cancelled by caller"));
      failure = new ApiError({ operation: "project.show", projectId: id }, "response", {
        cause: new AggregateError([op.signal.reason, cleanupFailure], "HTTP request failed and response cleanup failed."),
      });
      throw failure;
    });
    const result = await resolveProject({ serverUrl, operation: op, api: client, workingDirectory: root }).catch((error: unknown) => error);
    expect(result).toBe(failure);
    expect(formatError(result)).toContain("Operation cancelled");
    expect(formatError(result)).toContain(cleanupFailure.message);
    expect(client.listProjects).not.toHaveBeenCalled();
    await expect(readFile(path.join(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([0, 2])("rejects %i discovery matches without preparing local files", async (count) => {
    const root = await fixture();
    const client = api(count === 0 ? [] : [project, { ...project, id: otherId }]);
    const failure = await resolveProject({ serverUrl, operation: operation(), api: client, workingDirectory: root }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ProjectDiscoveryError);
    expect(failure).toMatchObject({ kind: count === 0 ? "missing" : "ambiguous", projectIds: count === 0 ? [] : [id, otherId] });
    expect((failure as Error).message).toBe(count === 0 ? "Project does not exist." : `Multiple projects match this repository (${id}, ${otherId}); specify --project <id>.`);
    expect(client.getProject).not.toHaveBeenCalled();
    await expect(readdir(path.join(root, ".daynight"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an invalid repoUrl from any listed project instead of manufacturing a unique match", async () => {
    const root = await fixture();
    const client = api([project, { ...project, id: otherId, repoUrl: "invalid" }]);
    await expect(resolveProject({ serverUrl, operation: operation(), api: client, workingDirectory: root })).rejects.toMatchObject({ name: "ApiError", phase: "protocol", projectId: otherId });
    expect(client.getProject).not.toHaveBeenCalled();
    await expect(readdir(path.join(root, ".daynight"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["404", "changed"])("does not recurse after discovered detail is %s", async (kind) => {
    const root = await fixture();
    const client = api();
    if (kind === "404") client.getProject.mockRejectedValue(notFound());
    else client.getProject.mockResolvedValue({ ...project, repoUrl: "https://git.example/Other/Repo" });
    await expect(resolveProject({ serverUrl, operation: operation(), api: client, workingDirectory: root })).rejects.toThrow(kind === "404" ? "not_found" : "changed during repository discovery");
    expect(client.listProjects).toHaveBeenCalledOnce();
    await expect(readdir(path.join(root, ".daynight"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors a concurrently established valid binding when discovery began earlier", async () => {
    const root = await fixture();
    const concurrent = { ...project, id: otherId };
    const client = api();
    client.getProject.mockImplementation(async (projectId) => {
      if (projectId === id) { await save(root, { projectId: otherId }); return project; }
      return concurrent;
    });
    expect(await resolveProject({ serverUrl, operation: operation(), api: client, workingDirectory: root })).toBe(concurrent);
    expect(await readFile(path.join(root, ".daynight/project.yml"), "utf8")).toContain(otherId);
    await expect(readFile(path.join(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops after cancellation during discovery before creating local state or requesting detail", async () => {
    const root = await fixture();
    const source = new AbortController();
    const op = createOperation({ signal: source.signal }); operations.push(op);
    const client = api();
    client.listProjects.mockImplementation(async () => { source.abort(new Error("cancelled by test")); return [project]; });
    await expect(resolveProject({ serverUrl, operation: op, api: client, workingDirectory: root })).rejects.toThrow("Operation cancelled");
    expect(client.getProject).not.toHaveBeenCalled();
    await expect(readdir(path.join(root, ".daynight"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
