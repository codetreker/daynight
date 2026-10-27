import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfiguration } from "../../../src/commands/review/config.js";
import { resolveReviewPaths } from "../../../src/commands/review/paths.js";
import { addRepository } from "../../../src/commands/review/repositories.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const remote = "https://github.com/OWNER/REPO.git";

describe("repository registration", () => {
  let directory: string;
  beforeAll(async () => {
    const temporaryDirectory = fileURLToPath(new URL("../../../../../.tmp/", import.meta.url));
    await mkdir(temporaryDirectory, { recursive: true });
    directory = await mkdtemp(path.join(temporaryDirectory, "repositories-tests-"));
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
  const setup = async (name: string, source?: string) => {
    const homeDirectory = path.join(directory, name);
    const paths = resolveReviewPaths(homeDirectory);
    await mkdir(paths.stateDirectory, { recursive: true });
    if (source !== undefined) { await writeFile(paths.configFile, source); }
    return { paths, options: { homeDirectory, workingDirectory: path.join(homeDirectory, "working") } };
  };

  it("creates only configuration and freezes a normalized default destination", async () => {
    const { paths, options } = await setup("default");
    const result = await addRepository({ remote }, paths, options);
    expect(result.added).toBe(true);
    expect(result.repository.path).toBe(path.join(options.homeDirectory, "daynights", "github.com", "owner", "repo"));
    expect(await readFile(paths.configFile, "utf8")).toContain("review:\n  repositoryRoot: ~/daynights");
    expect((await loadConfiguration(paths)).repositories).toEqual([result.repository]);
    expect(await readdir(options.homeDirectory)).toEqual([".daynight"]);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("resolves explicit relative paths against cwd and preserves comments, settings and unknown fields", async () => {
    const { paths, options } = await setup("existing", "# Review settings\nfuture: { enabled: true }\nreview:\n  future: review-owned\n  pollIntervalMs: 120000 # keep interval\n  copilotModel: auto # keep model\n  copilotReasoningEffort: high # keep reasoning effort\n  repositories:\n    # Existing repository\n    - remote: https://github.com/o/old\n      path: ../old # keep path\n      future: repository-owned\n");
    const result = await addRepository({ remote, path: "../my-clone" }, paths, options);
    expect(result.repository.path).toBe(path.resolve(options.workingDirectory, "../my-clone"));
    const source = await readFile(paths.configFile, "utf8");
    for (const retained of ["# Review settings", "future: { enabled: true }", "future: review-owned", "future: repository-owned", "pollIntervalMs: 120000 # keep interval", "copilotModel: auto # keep model", "copilotReasoningEffort: high # keep reasoning effort", "# Existing repository", "path: ../old # keep path", "repositoryRoot: ~/daynights"]) {
      expect(source).toContain(retained);
    }
    expect((await loadConfiguration(paths)).pollIntervalMs).toBe(120000);
    expect((await loadConfiguration(paths)).copilotModel).toBe("auto");
    expect((await loadConfiguration(paths)).copilotReasoningEffort).toBe("high");
  });

  it("adds the first review repository to server-only configuration and preserves its YAML and idempotence", async () => {
    const source = "# Shared connection\nserverUrl: &connection http://localhost:8787/ # keep origin\n";
    const { paths, options } = await setup("server-only", source);
    const result = await addRepository({ remote }, paths, options);
    const updated = await readFile(paths.configFile, "utf8");
    expect(updated).toContain(source);
    expect((await loadConfiguration(paths)).repositories).toEqual([result.repository]);
    expect(await addRepository({ remote: "git@github.com:owner/repo.git" }, paths, options)).toEqual({ ...result, added: false });
    expect(await readFile(paths.configFile, "utf8")).toBe(updated);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("retains anchors and comments while adding the first repository with explicit review metadata", async () => {
    const root = path.join(directory, "first-aliased-root");
    const source = `# Review destination\nserverUrl: invalid-for-server\nreview:\n  repositoryRoot: &cloneRoot ${JSON.stringify(root)} # keep root\n`;
    const { paths, options } = await setup("server-first-aliased-root", source);
    const result = await addRepository({ remote }, paths, options);
    expect(result.repository.path).toBe(path.join(root, "github.com", "owner", "repo"));
    const updated = await readFile(paths.configFile, "utf8");
    for (const retained of ["# Review destination", "serverUrl: invalid-for-server", "review:\n  repositoryRoot: &cloneRoot", "# keep root"]) {
      expect(updated).toContain(retained);
    }
  });

  it.each([
    "review:\n  maxConcurrentWorker: 0",
    "review:\n  repositoryRoot: null",
    "review:\n  copilotModel: null",
    "review:\n  copilotReasoningEffort: null",
    "review:\n  repositories: []",
    "review:\n  repositories: null",
    "review:\n  repositories: false",
    "review:\n  repositories: [{remote: https://github.com/o/r}]",
  ])("does not bootstrap over explicitly malformed review fields: %s", async (field) => {
    const source = `serverUrl: http://localhost:8787\n${field}\n`;
    const { paths, options } = await setup(`invalid-bootstrap-${field.split(":")[0]}-${String(field.length)}`, source);
    await expect(addRepository({ remote }, paths, options)).rejects.toThrow("Invalid configuration file");
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("uses a changed root only for new repositories and keeps repeated addition untouched", async () => {
    const { paths, options } = await setup("changed-root");
    const original = await addRepository({ remote }, paths, options);
    const edited = (await readFile(paths.configFile, "utf8")).replace("review:\n  repositoryRoot: ~/daynights", "review:\n  repositoryRoot: ../new-root");
    await writeFile(paths.configFile, edited);
    expect(await addRepository({ remote: "git@github.com:owner/repo.git" }, paths, options)).toEqual({ ...original, added: false });
    expect(await readFile(paths.configFile, "utf8")).toBe(edited);
    const second = await addRepository({ remote: "https://github.com/o/new" }, paths, options);
    expect(second.repository.path).toBe(path.resolve(paths.stateDirectory, "../new-root/github.com/o/new"));
    expect((await loadConfiguration(paths)).repositories[0]!.path).toBe(original.repository.path);
  });

  it("resolves a valid aliased root without rewriting its anchor", async () => {
    const root = path.join(directory, "aliased-clones");
    const { paths, options } = await setup("aliased-root", `review:\n  repositories:\n    - remote: https://github.com/o/existing\n      path: &cloneRoot ${JSON.stringify(root)}\n  repositoryRoot: *cloneRoot # shared root\n`);
    const result = await addRepository({ remote }, paths, options);
    expect(result.repository.path).toBe(path.join(root, "github.com", "owner", "repo"));
    expect(await readFile(paths.configFile, "utf8")).toContain("repositoryRoot: *cloneRoot # shared root");
  });

  it("uses deterministic portable default path components", async () => {
    const { paths, options } = await setup("portable-components");
    const result = await addRepository({ remote: "https://github.example.test:8443/CON/Aux.git" }, paths, options);
    expect(result.repository.path).toBe(path.join(options.homeDirectory, "daynights", "github.example.test%3A8443", "%63on", "%61ux"));
    const trailing = await addRepository({ remote: "https://github.com/o/repo..git" }, paths, options);
    expect(trailing.repository.path).toBe(path.join(options.homeDirectory, "daynights", "github.com", "o", "repo%2E"));
  });

  it("accepts an explicit physical alias for the same repository but rejects changed destinations and alias collisions", async () => {
    const { paths, options } = await setup("physical-alias");
    const actual = path.join(options.homeDirectory, "actual");
    const alias = path.join(options.homeDirectory, "alias");
    await mkdir(actual);
    await symlink(actual, alias, "junction");
    const original = await addRepository({ remote, path: path.join(actual, "missing") }, paths, options);
    const source = await readFile(paths.configFile, "utf8");
    expect(await addRepository({ remote, path: path.join(alias, "missing") }, paths, options)).toEqual({ ...original, added: false });
    await expect(addRepository({ remote, path: path.join(actual, "different") }, paths, options)).rejects.toThrow("already configured");
    await expect(addRepository({ remote: "https://github.com/o/other", path: path.join(alias, "missing") }, paths, options)).rejects.toThrow("same location");
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
    expect(await readdir(actual)).toEqual([]);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("rejects invalid existing configuration without replacing it", async () => {
    const invalid = "review:\n  maxConcurrentWorker: 0\n  repositories: [{remote: https://github.com/o/r, path: ../repo}]\n";
    const { paths, options } = await setup("invalid-config", invalid);
    await expect(addRepository({ remote }, paths, options)).rejects.toThrow("maxConcurrentWorker");
    expect(await readFile(paths.configFile, "utf8")).toBe(invalid);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("rejects config symlinks and preserves the link and target", async () => {
    const { paths, options } = await setup("symlink-config");
    const target = path.join(options.homeDirectory, "target.yml");
    const source = "review:\n  repositories: [{remote: https://github.com/o/r, path: ../repo}]\n";
    await writeFile(target, source);
    await symlink(target, paths.configFile, "file");
    await expect(addRepository({ remote }, paths, options)).rejects.toThrow("symbolic-link writes are not supported");
    expect((await lstat(paths.configFile)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe(source);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("fails fast on an existing writer lock without removing someone else's lock", async () => {
    const { paths, options } = await setup("locked");
    const lock = `${paths.configFile}.lock`;
    await writeFile(lock, "another writer");
    await expect(addRepository({ remote }, paths, options)).rejects.toThrow("locked by another writer");
    expect(await readFile(lock, "utf8")).toBe("another writer");
    await expect(readFile(paths.configFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes successful writers and allows a locked caller to retry without losing additions", async () => {
    const { paths, options } = await setup("concurrent");
    const remotes = [remote, "https://github.com/o/second"];
    const results = await Promise.allSettled(remotes.map((value) => addRepository({ remote: value }, paths, options)));
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        expect(result.reason).toHaveProperty("message", expect.stringContaining("locked by another writer"));
        await addRepository({ remote: remotes[index]! }, paths, options);
      }
    }
    expect((await loadConfiguration(paths)).repositories).toHaveLength(2);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("preserves configuration and cleans its temporary file and lock if atomic replacement fails", async () => {
    const source = "review:\n  repositories: [{remote: https://github.com/o/r, path: ../repo}]\n";
    const { paths, options } = await setup("rename-failure", source);
    const failure = Object.assign(new Error("replacement denied"), { code: "EACCES" });
    const replace = vi.mocked(filesystem.rename).mockRejectedValueOnce(failure);
    try {
      await expect(addRepository({ remote }, paths, options)).rejects.toBe(failure);
    } finally {
      replace.mockReset();
    }
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it.skipIf(process.platform === "win32")("preserves existing POSIX configuration permissions", async () => {
    const { paths, options } = await setup("permissions", "review:\n  repositories: [{remote: https://github.com/o/r, path: ../repo}]\n");
    await chmod(paths.configFile, 0o640);
    await addRepository({ remote }, paths, options);
    expect((await lstat(paths.configFile)).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform === "win32")("preserves server-only configuration permissions on first registration", async () => {
    const { paths, options } = await setup("server-only-permissions", "serverUrl: http://localhost:8787\n");
    await chmod(paths.configFile, 0o640);
    await addRepository({ remote }, paths, options);
    expect((await lstat(paths.configFile)).mode & 0o777).toBe(0o640);
  });

  it("does not require an unused root to be a directory when an explicit path is provided", async () => {
    const { paths, options } = await setup("unused-root", "review:\n  repositoryRoot: ../root-file\n  repositories: [{remote: https://github.com/o/r, path: ../repo}]\n");
    await writeFile(path.join(options.homeDirectory, "root-file"), "not a directory");
    expect((await addRepository({ remote, path: "../explicit" }, paths, options)).repository.path).toBe(path.join(options.homeDirectory, "explicit"));
  });
});
