import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { parseServerConfiguration } from "../../../src/config/server.js";
import { parseWorkerConfiguration, readWorkerConfiguration } from "../../../src/commands/worker/config.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const paths = resolveWorkerPaths("/home/worker-user", path.posix);
const remote = "https://git.example/team/project.git";
const repo = { remote, path: "../checkout" };
const parse = (worker: Record<string, unknown>) => parseWorkerConfiguration(stringify({ worker: { repositories: [repo], ...worker } }), paths, path.posix);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("worker configuration", () => {
  it("uses a separate namespace and resolves paths relative to the config file", () => {
    expect(parse({})).toEqual({
      maxConcurrent: 1, pollIntervalMs: 5_000, recoveryLimit: 3, agent: "copilot", model: null, args: [],
      repositories: [{ ...repo, path: "/home/worker-user/checkout", agent: "copilot", model: null, args: [], recoveryLimit: 3 }],
    });
    expect(parseServerConfiguration(stringify({ worker: { repositories: "not validated by server commands" } }), paths)).toEqual({ serverUrl: "https://daynight.cc" });
    expect(parseWorkerConfiguration(stringify({ review: { repositories: "review-owned", copilotModel: null }, worker: { repositories: [] } }), paths).repositories).toEqual([]);
  });

  it("merges same-kind overrides field by field and permits explicit reset to native model defaults", () => {
    const configuration = parse({ agent: "codex", model: "global-model", args: ["--search"], recoveryLimit: 0, repositories: [
      { ...repo, agent: "codex", args: [] },
      { remote: "git@elsewhere.example:team/second.git", path: "/absolute/repository", model: null },
    ] });
    expect(configuration.recoveryLimit).toBe(0);
    expect(configuration.repositories).toEqual([
      { ...repo, path: "/home/worker-user/checkout", agent: "codex", model: "global-model", args: [], recoveryLimit: 0 },
      { remote: "git@elsewhere.example:team/second.git", path: "/absolute/repository", agent: "codex", model: null, args: ["--search"], recoveryLimit: 0 },
    ]);
  });

  it("drops model and args inheritance when the repository switches native agent kind", () => {
    const configuration = parse({ agent: "codex", model: "codex-model", args: ["--search"], repositories: [
      { ...repo, agent: "copilot" },
      { remote: "ssh://git@other.example/team/r", path: "/second", agent: "copilot", model: "copilot-model", args: ["--reasoning-effort", "high"] },
    ] });
    expect(configuration.repositories[0]).toMatchObject({ agent: "copilot", model: null, args: [] });
    expect(configuration.repositories[1]).toMatchObject({ agent: "copilot", model: "copilot-model", args: ["--reasoning-effort", "high"] });
    expect(parse({ agent: "copilot", model: "copilot-model", args: ["--allow-all"], repositories: [{ ...repo, agent: "codex" }] }).repositories[0])
      .toMatchObject({ agent: "codex", model: null, args: [] });
  });

  it("normalizes configured project IDs and preserves generic SSH repository identities", () => {
    const projectId = "C6BCA371-9F08-4510-B850-24F6BA6D3224";
    expect(parse({ repositories: [{ remote: "ssh://builder@git.example:2222/team/r.git", path: "/repo", projectId }] }).repositories[0])
      .toMatchObject({ projectId: projectId.toLowerCase() });
  });

  it.each([
    { maxConcurrent: 0 }, { maxConcurrent: 1.5 }, { maxConcurrent: "1" }, { maxConcurrent: null },
    { pollIntervalMs: 0 }, { pollIntervalMs: 2_147_483_648 }, { pollIntervalMs: false },
    { recoveryLimit: -1 }, { recoveryLimit: 0.5 }, { recoveryLimit: Number.MAX_SAFE_INTEGER + 1 },
    { agent: "claude" }, { agent: null }, { model: "" }, { model: 42 }, { args: "--allow-all" }, { args: [null] },
    { repositories: {} }, { repositories: [null] }, { repositories: [{ ...repo, projectId: "bad" }] },
    { repositories: [{ ...repo, remote: "https://name:secret@git.example/team/r" }] },
    { repositories: [{ ...repo, path: "~/repo" }] }, { repositories: [{ ...repo, path: "" }] },
    { stateDirectory: "/tmp/state" }, { platform: "windows" }, { timeoutMs: 1 },
    { repositories: [{ ...repo, platform: "windows" }] },
  ])("rejects invalid settings %j", (worker) => { expect(() => parse(worker)).toThrow(); });

  it.each([
    { agent: "codex", args: ["--model", "other"] },
    { agent: "copilot", args: ["--resume=some-session"] },
    { agent: "codex", args: ["-C", "/another"] },
    { agent: "copilot", args: ["start doing work"] },
    { agent: "codex", args: ["--config", "contains\nnewline"] },
  ])("rejects arguments owned by the worker %j before any claim", (worker) => { expect(() => parse(worker)).toThrow(); });

  it.each([
    [{ ...repo }, { remote: "git@git.example:team/project", path: "/another" }],
    [{ ...repo }, { remote: "https://other.example/team/r", path: "../checkout/../checkout" }],
    [{ ...repo }, { remote: "https://other.example/team/r", path: "../checkout/nested" }],
    [{ ...repo, projectId: "c6bca371-9f08-4510-b850-24f6ba6d3224" }, { remote: "https://other.example/team/r", path: "/another", projectId: "C6BCA371-9F08-4510-B850-24F6BA6D3224" }],
    [{ ...repo, path: "." }], [{ ...repo, path: "worker/repository" }], [{ ...repo, path: ".." }],
  ])("rejects duplicate or overlapping repository settings %j", (...repositories) => { expect(() => parse({ repositories })).toThrow(); });

  it("requires worker and repositories but supports an empty list for reconciliation of retained claims", () => {
    expect(() => parseWorkerConfiguration("{}", paths)).toThrow("Worker configuration is missing");
    expect(() => parseWorkerConfiguration("worker: {}", paths)).toThrow("worker.repositories");
    expect(() => parseWorkerConfiguration("worker: null", paths)).toThrow("worker must be a mapping");
    expect(parse({ repositories: [] }).repositories).toEqual([]);
  });

  it("handles Windows absolute and config-relative paths without a runtime-platform override", () => {
    const windows = resolveWorkerPaths("C:\\Users\\worker", path.win32);
    const configuration = parseWorkerConfiguration(stringify({ worker: { repositories: [{ ...repo, path: "..\\checkout" }] } }), windows, path.win32);
    expect(configuration.repositories[0]!.path).toBe("C:\\Users\\worker\\checkout");
    expect(() => parseWorkerConfiguration(stringify({ worker: { repositories: [{ ...repo, path: "C:relative" }] } }), windows, path.win32)).toThrow("drive-relative");
  });

  it("reads once without modifying configuration, cloning repositories or creating worker state", async () => {
    const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-config-tests");
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "config "));
    directories.push(directory);
    const local = resolveWorkerPaths(directory);
    await mkdir(local.stateDirectory);
    const source = stringify({ worker: { repositories: [{ ...repo, path: "../missing-repo" }] } });
    await writeFile(local.configFile, source);
    expect((await readWorkerConfiguration(local)).repositories[0]!.path).toBe(path.join(directory, "missing-repo"));
    expect(await readFile(local.configFile, "utf8")).toBe(source);
    expect(await readdir(local.stateDirectory)).toEqual(["config.yml"]);
    await writeFile(local.configFile, stringify({ worker: { maxConcurrent: 4, repositories: [] } }));
    expect((await readWorkerConfiguration(local)).maxConcurrent).toBe(4);
  });

  it("rejects physical aliases between repositories or into state", async () => {
    const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-config-tests");
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "aliases "));
    directories.push(directory);
    const local = resolveWorkerPaths(directory);
    await mkdir(local.stateDirectory);
    const target = path.join(directory, "repository");
    const alias = path.join(directory, "alias");
    await mkdir(target);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    await writeFile(local.configFile, stringify({ worker: { repositories: [{ ...repo, path: target }, { remote: "https://another.example/team/r", path: alias }] } }));
    await expect(readWorkerConfiguration(local)).rejects.toThrow("physically overlaps another worker repository");
    await rm(alias);
    await symlink(local.stateDirectory, alias, process.platform === "win32" ? "junction" : "dir");
    await writeFile(local.configFile, stringify({ worker: { repositories: [{ ...repo, path: alias }] } }));
    await expect(readWorkerConfiguration(local)).rejects.toThrow("physically overlaps the Daynight state");
  });

  it("distinguishes missing repository destinations with native filesystem rules and removes comparison probes", async () => {
    const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-config-tests");
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "destinations "));
    directories.push(directory);
    const local = resolveWorkerPaths(directory);
    await mkdir(local.stateDirectory);
    await writeFile(local.configFile, stringify({ worker: { repositories: [
      { ...repo, path: "../first" }, { remote: "https://other.example/team/r", path: "../second" },
    ] } }));
    expect((await readWorkerConfiguration(local)).repositories).toHaveLength(2);
    expect(await readdir(directory)).toEqual([".daynight"]);
  });
});
