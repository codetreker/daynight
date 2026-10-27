import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import * as configurationFiles from "../../../src/config/files.js";
import { parseServerConfiguration } from "../../../src/config/server.js";
import { parseWorkerConfiguration, readWorkerConfiguration } from "../../../src/commands/worker/config.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const paths = resolveWorkerPaths("/home/worker-user", path.posix);
const remote = "https://git.example/team/project.git";
const repo = { remote, path: "../checkout" };
const parse = (worker: Record<string, unknown>) => parseWorkerConfiguration(stringify({ worker: { repositories: [repo], ...worker } }), paths, path.posix);
const defaults = { maxConcurrent: 1, pollIntervalMs: 5_000, recoveryLimit: 3, agent: "copilot", model: null, args: [], repositories: [] };
const directories: string[] = [];
const fixture = async (prefix: string) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-config-tests");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, `${prefix} `));
  directories.push(directory);
  return { directory, local: resolveWorkerPaths(directory) };
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("worker configuration", () => {
  it("uses a separate namespace and resolves paths relative to the config file", () => {
    expect(parse({})).toEqual({
      maxConcurrent: 1, pollIntervalMs: 5_000, recoveryLimit: 3, agent: "copilot", model: null, args: [],
      repositories: [{ ...repo, path: "/home/worker-user/checkout", agent: "copilot", model: null, args: [], recoveryLimit: 3 }],
    });
    expect(parseServerConfiguration(stringify({ worker: { repositories: "not validated by server commands" } }), paths)).toEqual({ serverUrl: "https://daynight.cc" });
    expect(parseWorkerConfiguration(stringify({ repositories: "review-owned", copilotModel: null, worker: { repositories: [] } }), paths).repositories).toEqual([]);
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
    { repositories: null }, { repositories: {} }, { repositories: [null] }, { repositories: [{ ...repo, projectId: "bad" }] },
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

  it.each([
    {},
    { serverUrl: "https://daynight.example" },
    { repositories: [{ remote: "review-owned", path: "/review-owned" }], copilotModel: "review-model" },
    { worker: {} },
    { worker: { repositories: [] } },
  ])("uses defaults without implicit repository discovery for %j", (configuration) => {
    expect(parseWorkerConfiguration(stringify(configuration), paths)).toEqual(defaults);
  });

  it("preserves configured worker fields when repositories are omitted", () => {
    expect(parseWorkerConfiguration(stringify({ worker: {
      agent: "codex", model: "configured-model", args: ["--search"], maxConcurrent: 4, recoveryLimit: 0,
    } }), paths)).toEqual({
      ...defaults, agent: "codex", model: "configured-model", args: ["--search"], maxConcurrent: 4, recoveryLimit: 0,
    });
  });

  it.each([null, [], false, "worker"])("rejects explicitly invalid worker mappings %j", (worker) => {
    expect(() => parseWorkerConfiguration(stringify({ worker }), paths)).toThrow("worker must be a mapping");
  });

  it.each(["", "worker: [", "worker: {}\nworker: {}", "unsupported: true", "worker: {unsupported: true}"])("rejects invalid configuration documents %j", (source) => {
    expect(() => parseWorkerConfiguration(source, paths)).toThrow();
  });

  it("handles Windows absolute and config-relative paths without a runtime-platform override", () => {
    const windows = resolveWorkerPaths("C:\\Users\\worker", path.win32);
    const configuration = parseWorkerConfiguration(stringify({ worker: { repositories: [{ ...repo, path: "..\\checkout" }] } }), windows, path.win32);
    expect(configuration.repositories[0]!.path).toBe("C:\\Users\\worker\\checkout");
    expect(() => parseWorkerConfiguration(stringify({ worker: { repositories: [{ ...repo, path: "C:relative" }] } }), windows, path.win32)).toThrow("drive-relative");
  });

  it("reads once without modifying configuration, cloning repositories or creating worker state", async () => {
    const { directory, local } = await fixture("config");
    await mkdir(local.stateDirectory);
    const source = stringify({ worker: { repositories: [{ ...repo, path: "../missing-repo" }] } });
    await writeFile(local.configFile, source);
    expect((await readWorkerConfiguration(local)).repositories[0]!.path).toBe(path.join(directory, "missing-repo"));
    expect(await readFile(local.configFile, "utf8")).toBe(source);
    expect(await readdir(local.stateDirectory)).toEqual(["config.yml"]);
    await writeFile(local.configFile, stringify({ worker: { maxConcurrent: 4, repositories: [] } }));
    expect((await readWorkerConfiguration(local)).maxConcurrent).toBe(4);
  });

  it.each([false, true])("uses defaults when configuration is absent without creating files (state directory exists: %j)", async (stateExists) => {
    const { directory, local } = await fixture("missing");
    if (stateExists) await mkdir(local.stateDirectory);
    expect(await readWorkerConfiguration(local)).toEqual(defaults);
    expect(await readdir(directory)).toEqual(stateExists ? [".daynight"] : []);
    if (stateExists) expect(await readdir(local.stateDirectory)).toEqual([]);
  });

  it.each([
    ["# Connection settings\nserverUrl: https://daynight.example\n", {}],
    ["# Explicit defaults\nworker: {}\n", {}],
    ["# Partial worker settings\nworker:\n  maxConcurrent: 4\n", { maxConcurrent: 4 }],
  ] as const)("reads an existing partial configuration without changing its bytes: %s", async (source, configured) => {
    const { directory, local } = await fixture("partial");
    await mkdir(local.stateDirectory);
    await writeFile(local.configFile, source);
    expect(await readWorkerConfiguration(local)).toEqual({ ...defaults, ...configured });
    expect(await readFile(local.configFile, "utf8")).toBe(source);
    expect(await readdir(local.stateDirectory)).toEqual(["config.yml"]);
    expect(await readdir(directory)).toEqual([".daynight"]);
  });

  it("propagates unreadable configuration errors without substituting defaults", async () => {
    const { directory, local } = await fixture("unreadable");
    const failure = new Error("Configuration read denied.", { cause: Object.assign(new Error("Permission denied."), { code: "EACCES" }) });
    vi.spyOn(configurationFiles, "readConfigurationSource").mockRejectedValueOnce(failure);
    await expect(readWorkerConfiguration(local)).rejects.toBe(failure);
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects invalid filesystem locations without treating them as missing configuration", async () => {
    const { directory, local } = await fixture("invalid-path");
    await writeFile(local.stateDirectory, "not a directory");
    await expect(readWorkerConfiguration(local)).rejects.toThrow("Cannot read configuration file");
    await rm(local.stateDirectory);
    await mkdir(local.configFile, { recursive: true });
    await expect(readWorkerConfiguration(local)).rejects.toThrow("Cannot read configuration file");
    expect(await readdir(directory)).toEqual([".daynight"]);
    expect(await readdir(local.stateDirectory)).toEqual(["config.yml"]);
  });

  it.skipIf(process.platform === "win32")("rejects dangling configuration and ancestor symlinks", async () => {
    const { directory, local } = await fixture("dangling-link");
    await mkdir(local.stateDirectory);
    await symlink(path.join(directory, "missing-config"), local.configFile);
    await expect(readWorkerConfiguration(local)).rejects.toThrow("Cannot read configuration file");
    await rm(local.stateDirectory, { recursive: true });
    await symlink(path.join(directory, "missing-state"), local.stateDirectory);
    await expect(readWorkerConfiguration(local)).rejects.toThrow("Cannot read configuration file");
    expect(await readdir(directory)).toEqual([".daynight"]);
  });

  it.each([false, true])("preserves cancellation before reading configuration (file exists: %j)", async (fileExists) => {
    const { directory, local } = await fixture("cancelled");
    const source = "worker: {}\n";
    if (fileExists) { await mkdir(local.stateDirectory); await writeFile(local.configFile, source); }
    const controller = new AbortController();
    const reason = new Error("Configuration read cancelled.");
    controller.abort(reason);
    await expect(readWorkerConfiguration(local, controller.signal)).rejects.toBe(reason);
    expect(await readdir(directory)).toEqual(fileExists ? [".daynight"] : []);
    if (fileExists) expect(await readFile(local.configFile, "utf8")).toBe(source);
  });

  it("rejects physical aliases between repositories or into state", async () => {
    const { directory, local } = await fixture("aliases");
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
    const { directory, local } = await fixture("destinations");
    await mkdir(local.stateDirectory);
    await writeFile(local.configFile, stringify({ worker: { repositories: [
      { ...repo, path: "../first" }, { remote: "https://other.example/team/r", path: "../second" },
    ] } }));
    expect((await readWorkerConfiguration(local)).repositories).toHaveLength(2);
    expect(await readdir(directory)).toEqual([".daynight"]);
  });
});
