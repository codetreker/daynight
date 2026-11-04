import { execFileSync, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../src/api/index.js";
import type { Operation, Project } from "../../src/api/index.js";
import { persistProjectBinding, readProjectBinding } from "../../src/repository/binding.js";
import type { ProjectApi, ProjectBinding } from "../../src/repository/binding.js";
import * as files from "../../src/platform/files.js";
import * as git from "../../src/repository/git.js";

vi.mock("../../src/platform/files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/platform/files.js")>();
  return { ...actual, replaceFileAtomically: vi.fn(actual.replaceFileAtomically) };
});
vi.mock("../../src/repository/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/repository/git.js")>();
  return { ...actual, runRepositoryGit: vi.fn(actual.runRepositoryGit) };
});

const id = "11111111-1111-1111-1111-111111111111";
const serverUrl = "http://localhost:8787";
const project: Project = { id, name: "Project", repoUrl: "https://git.example/Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z" };
const binding: ProjectBinding = { serverUrl, repoIdentity: "git.example/Org/Repo", projectId: id };
const directories: string[] = [];
const operations: Operation[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  operations.splice(0).forEach((operation) => operation.dispose());
  vi.mocked(files.replaceFileAtomically).mockReset();
  vi.mocked(git.runRepositoryGit).mockReset();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const operation = (): Operation => { const value = createOperation(); operations.push(value); return value; };
const fixture = async () => {
  const temporary = path.resolve(import.meta.dirname, "../../../../.tmp/repository-tests");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "binding 用户 "));
  directories.push(root);
  execFileSync("git", ["init", "-q", root]);
  return { root, directory: path.join(root, ".daynight"), file: path.join(root, ".daynight/project.yml"), lock: path.join(root, ".daynight/project.yml.lock"), ignore: path.join(root, ".gitignore") };
};
const api = (): ProjectApi => ({ listProjects: vi.fn().mockResolvedValue([project]), getProject: vi.fn().mockResolvedValue(project) });
const persist = (root: string, op = operation(), client = api()) => persistProjectBinding({ root, binding, project, operation: op, api: client });

describe("repository binding files", () => {
  it("distinguishes missing bindings from corrupt records without creating directories", async () => {
    const { root, directory, file } = await fixture();
    expect(await readProjectBinding(root, operation())).toBeUndefined();
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(directory);
    expect(await readProjectBinding(root, operation())).toBeUndefined();
    await writeFile(file, stringify(binding));
    expect(await readProjectBinding(root, operation())).toEqual(binding);
  });

  it.each([
    "", "[]", "serverUrl: [", "serverUrl: *missing", "serverUrl: !unsupported x", stringify({ ...binding, extra: true }), stringify({ ...binding, projectId: "invalid" }), stringify({ ...binding, serverUrl: "http://localhost:8787/" }), stringify({ ...binding, repoIdentity: "with whitespace" }), stringify({ ...binding, repoIdentity: 42 }), stringify({ ...binding, projectId: null }), `serverUrl: http://localhost:8787\n${stringify(binding)}`,
  ])("reports malformed binding without overwriting it: %j", async (source) => {
    const { root, directory, file } = await fixture();
    await mkdir(directory);
    await writeFile(file, source);
    await expect(readProjectBinding(root, operation())).rejects.toThrow(`Invalid repository binding ${file}`);
    expect(await readFile(file, "utf8")).toBe(source);
    expect(await readdir(directory)).toEqual(["project.yml"]);
  });

  it.each(["metadata directory", "metadata file", "ignore file"])("rejects a symbolic link for the %s", async (target) => {
    const { root, directory, file, ignore } = await fixture();
    const destination = path.join(root, "target");
    if (target === "metadata directory") { await mkdir(destination); await symlink(destination, directory, "junction"); }
    else {
      await mkdir(directory);
      await writeFile(destination, target === "metadata file" ? stringify(binding) : "# target\n");
      await symlink(destination, target === "metadata file" ? file : ignore, "file");
    }
    await expect(target === "ignore file" ? persist(root) : readProjectBinding(root, operation())).rejects.toThrow("symbolic links are not supported");
    expect((await lstat(target === "metadata directory" ? directory : target === "metadata file" ? file : ignore)).isSymbolicLink()).toBe(true);
  });

  it.each(["metadata directory", "metadata file", "ignore file"])("rejects a nonordinary %s", async (target) => {
    const { root, directory, file, ignore } = await fixture();
    if (target === "metadata directory") await writeFile(directory, "file");
    else { await mkdir(directory); await mkdir(target === "metadata file" ? file : ignore); }
    await expect(target === "ignore file" ? persist(root) : readProjectBinding(root, operation())).rejects.toThrow(target === "metadata directory" ? "must be a directory" : "must be a regular file");
  });
});

describe("repository binding preparation", () => {
  it.each([
    { source: "# Existing\n*.log\n", suffix: "/.daynight/\n" },
    { source: "# Existing\r\n*.log", suffix: "\r\n/.daynight/\r\n" },
    { source: "# Existing without final newline", suffix: "\n/.daynight/\n" },
    { source: "/.daynight/\n!/.daynight/\n", suffix: "/.daynight/\n" },
  ])("preserves bytes and appends an effective terminal rule: $source", async ({ source, suffix }) => {
    const { root, directory, file, ignore } = await fixture();
    await writeFile(ignore, source);
    expect(await persist(root)).toBe(project);
    expect(await readFile(ignore, "utf8")).toBe(source + suffix);
    expect(await readFile(file, "utf8")).toBe(stringify(binding));
    expect(execFileSync("git", ["-C", root, "check-ignore", "--", ".daynight/project.yml"], { encoding: "utf8" })).toBe(".daynight/project.yml\n");
    expect(await readdir(directory)).toEqual(["project.yml"]);
  });

  it("preserves an existing effective root rule without rewriting its file", async () => {
    const { root, ignore } = await fixture();
    const source = "# Existing\n/.daynight/\n*.log\n";
    await writeFile(ignore, source);
    await persist(root);
    expect(await readFile(ignore, "utf8")).toBe(source);
    expect(vi.mocked(files.replaceFileAtomically).mock.calls.map(([file]) => file)).not.toContain(ignore);
  });

  it("restores directory-wide ignore when only the existing project file is ignored", async () => {
    const { root, ignore } = await fixture();
    const source = "/.daynight/\n!/.daynight/\n/.daynight/project.yml\n";
    await writeFile(ignore, source);
    await persist(root);
    expect(await readFile(ignore, "utf8")).toBe(`${source}/.daynight/\n`);
    for (const target of [".daynight/", ".daynight/project.yml", ".daynight/project.yml.lock", ".daynight/other.yml"]) {
      expect(execFileSync("git", ["-C", root, "check-ignore", "--", target], { encoding: "utf8" })).toBe(`${target}\n`);
    }
  });

  it("rejects tracked metadata contents before preparing the ignore file", async () => {
    const { root, directory, ignore } = await fixture();
    await mkdir(directory);
    await writeFile(path.join(directory, "tracked.txt"), "tracked");
    execFileSync("git", ["-C", root, "add", ".daynight/tracked.txt"]);
    await expect(persist(root)).rejects.toThrow("tracked by Git");
    await expect(readFile(ignore)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual(["tracked.txt"]);
  });

  it.skipIf(process.platform === "win32")("preserves modes and rejects an unwritable ignore file", async () => {
    const { root, file, directory, ignore } = await fixture();
    await writeFile(ignore, "# rules\n");
    await chmod(ignore, 0o640);
    await persist(root);
    expect((await lstat(ignore)).mode & 0o777).toBe(0o640);
    await chmod(file, 0o640);
    await writeFile(file, stringify({ ...binding, serverUrl: "https://old.example" }));
    await persist(root);
    expect((await lstat(file)).mode & 0o777).toBe(0o640);
    await chmod(ignore, 0o400);
    await rm(file);
    await expect(persist(root)).rejects.toThrow("is not writable");
    expect(await readdir(directory)).toEqual([]);
  });

  it("retains a successful ignore update if metadata replacement fails and prevents the following mutation", async () => {
    const { root, directory, ignore, file } = await fixture();
    const original = vi.mocked(files.replaceFileAtomically).getMockImplementation()!;
    const failure = new Error("Metadata rename denied");
    vi.mocked(files.replaceFileAtomically).mockImplementation(async (target, content, mode) => {
      if (target === file) throw failure;
      return original(target, content, mode);
    });
    const mutation = vi.fn();
    await expect(persist(root).then(mutation)).rejects.toBe(failure);
    expect(mutation).not.toHaveBeenCalled();
    expect(await readFile(ignore, "utf8")).toBe("/.daynight/\n");
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not save metadata when Git reports the final ignore rule remains ineffective", async () => {
    const { root, directory } = await fixture();
    const original = vi.mocked(git.runRepositoryGit).getMockImplementation()!;
    vi.mocked(git.runRepositoryGit).mockImplementation(async (cwd, args, op, options) => args[0] === "check-ignore" ? { stdout: "", stderr: "", exitCode: 1 } : original(cwd, args, op, options));
    await expect(persist(root)).rejects.toThrow("ignore rule for .daynight/ is ineffective");
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("repository metadata writer ownership", () => {
  it.each(["malformed", JSON.stringify({ pid: 2147483647, token: "old-owner" })])("retains an existing lock without guessing whether its writer is alive: %s", async (source) => {
    const { root, directory, lock } = await fixture();
    await mkdir(directory);
    await writeFile(lock, source);
    await expect(persist(root)).rejects.toThrow(`confirm the writer has stopped before removing this lock`);
    expect(await readFile(lock, "utf8")).toBe(source);
    expect(await readdir(directory)).toEqual(["project.yml.lock"]);
  });

  it("fails promptly while a separate process owns the exclusive lock", async () => {
    const { root, directory, lock } = await fixture();
    await mkdir(directory);
    const child = spawn(process.execPath, ["--input-type=module", "-e", "import {open} from 'node:fs/promises'; const handle=await open(process.argv[1],'wx'); await handle.writeFile(JSON.stringify({pid:process.pid,token:'child-owner'})); process.stdout.write('locked'); process.stdin.resume();", lock], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    cleanups.push(async () => { child.kill(); await exited; });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Lock child exited before acquisition: ${code}`)));
    });
    await expect(persist(root)).rejects.toThrow("Repository metadata is locked");
    expect(await readFile(lock, "utf8")).toContain("child-owner");
  });

  it("preserves a changed ownership token and exposes cleanup failure", async () => {
    const { root, lock, ignore } = await fixture();
    const original = vi.mocked(files.replaceFileAtomically).getMockImplementation()!;
    vi.mocked(files.replaceFileAtomically).mockImplementation(async (file, content, mode) => {
      if (file === ignore) await writeFile(lock, "replacement owner");
      return original(file, content, mode);
    });
    await expect(persist(root)).rejects.toThrow("lock cleanup failed");
    expect(await readFile(lock, "utf8")).toBe("replacement owner");
  });

  it("cleans an owned lock when cancellation happens during locked revalidation", async () => {
    const { root, directory, file } = await fixture();
    await mkdir(directory);
    await writeFile(file, stringify(binding));
    const source = new AbortController();
    const op = createOperation({ signal: source.signal }); operations.push(op);
    const client = api();
    vi.mocked(client.getProject).mockImplementation(async () => { source.abort(); return project; });
    await expect(persist(root, op, client)).rejects.toThrow("Operation cancelled");
    expect(await readdir(directory)).toEqual(["project.yml"]);
    expect(files.replaceFileAtomically).not.toHaveBeenCalled();
  });
});
