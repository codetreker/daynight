import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureWorkerIdentity } from "../../../src/commands/worker/identity.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { readConfiguration } from "../../../src/config/document.js";
import * as configurationFiles from "../../../src/config/files.js";

vi.mock("../../../src/config/files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/files.js")>();
  return { ...actual, updateConfigurationFile: vi.fn(actual.updateConfigurationFile) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.mocked(configurationFiles.updateConfigurationFile).mockClear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const fixture = async (source?: string) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-identity-tests");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "identity 用户 "));
  directories.push(directory);
  const paths = resolveWorkerPaths(directory);
  if (source !== undefined) {
    await mkdir(paths.stateDirectory);
    await writeFile(paths.configFile, source);
  }
  return paths;
};

const identity = "E434211D-1116-4C73-A3AC-C1587A2B17CD";

describe("stable worker identity", () => {
  it("creates and reuses a persisted UUID without creating runtime state", async () => {
    const paths = await fixture();
    const generated = await ensureWorkerIdentity(paths);
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((await readConfiguration(paths)).mapping.workerId).toBe(generated);
    expect(await ensureWorkerIdentity(paths)).toBe(generated);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("returns the canonical existing identity without rewriting configuration", async () => {
    const source = `# Existing identity\nworkerId: ${identity} # retained spelling\nserverUrl: https://service.example\n`;
    const paths = await fixture(source);
    const before = await stat(paths.configFile);
    expect(await ensureWorkerIdentity(paths)).toBe(identity.toLowerCase());
    expect(configurationFiles.updateConfigurationFile).not.toHaveBeenCalled();
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
    expect((await stat(paths.configFile)).mtimeMs).toBe(before.mtimeMs);
  });

  it("preserves other fields, YAML comments and aliases while securing an existing credential", async () => {
    const paths = await fixture("# Connection\nserverUrl: &service https://service.example\nreview:\n  repositoryRoot: *service # kept alias\nserverToken: synthetic-token\n");
    const generated = await ensureWorkerIdentity(paths);
    const saved = await readFile(paths.configFile, "utf8");
    expect(saved).toContain("# Connection");
    expect(saved).toContain("serverUrl: &service https://service.example");
    expect(saved).toContain("repositoryRoot: *service # kept alias");
    expect((await readConfiguration(paths)).mapping).toMatchObject({ workerId: generated, serverToken: "synthetic-token", serverUrl: "https://service.example" });
    if (process.platform !== "win32") expect((await stat(paths.configFile)).mode & 0o777).toBe(0o600);
  });

  it.each(["null", "", '""', "123", "true", "[]", "{}", "not-a-uuid", '" e434211d-1116-4c73-a3ac-c1587a2b17cd "'])
  ("retains an invalid configured identity %s and reports it", async (value) => {
    const source = `workerId: ${value}\nserverUrl: https://service.example\n`;
    const paths = await fixture(source);
    await expect(ensureWorkerIdentity(paths)).rejects.toThrow("workerId must be a hyphenated UUID");
    expect(configurationFiles.updateConfigurationFile).not.toHaveBeenCalled();
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
  });

  it("reuses an identity written before acquiring the configuration lock", async () => {
    const paths = await fixture("serverUrl: https://service.example\n");
    const source = `workerId: ${identity}\nserverUrl: https://service.example\n`;
    const actual = await vi.importActual<typeof import("../../../src/config/files.js")>("../../../src/config/files.js");
    vi.mocked(configurationFiles.updateConfigurationFile).mockImplementationOnce(async (locations, update, signal) => {
      await writeFile(locations.configFile, source);
      return actual.updateConfigurationFile(locations, update, signal);
    });
    expect(await ensureWorkerIdentity(paths)).toBe(identity.toLowerCase());
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
  });

  it("retains a concurrently written invalid identity after the under-lock reread", async () => {
    const paths = await fixture("serverUrl: https://service.example\n");
    const source = "workerId: null\nserverUrl: https://service.example\n";
    const actual = await vi.importActual<typeof import("../../../src/config/files.js")>("../../../src/config/files.js");
    vi.mocked(configurationFiles.updateConfigurationFile).mockImplementationOnce(async (locations, update, signal) => {
      await writeFile(locations.configFile, source);
      return actual.updateConfigurationFile(locations, update, signal);
    });
    await expect(ensureWorkerIdentity(paths)).rejects.toThrow("workerId must be a hyphenated UUID");
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
  });

  it("permits concurrent creators to persist only one identity and exposes writer contention", async () => {
    const paths = await fixture();
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => ensureWorkerIdentity(paths)));
    const saved = (await readConfiguration(paths)).mapping.workerId;
    const values = attempts.filter((attempt) => attempt.status === "fulfilled").map((attempt) => attempt.value);
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values)).toEqual(new Set([saved]));
    for (const attempt of attempts) {
      if (attempt.status === "rejected") expect(attempt.reason).toMatchObject({ message: expect.stringContaining("locked by another writer"), cause: { code: "EEXIST" } });
    }
    expect(await ensureWorkerIdentity(paths)).toBe(saved);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("does not mutate configuration when cancelled or YAML is invalid", async () => {
    const paths = await fixture("serverUrl: [\n");
    await expect(ensureWorkerIdentity(paths)).rejects.toThrow("Invalid YAML");
    const controller = new AbortController();
    const reason = new Error("Worker startup cancelled");
    controller.abort(reason);
    await expect(ensureWorkerIdentity(paths, controller.signal)).rejects.toBe(reason);
    expect(await readFile(paths.configFile, "utf8")).toBe("serverUrl: [\n");
    expect(configurationFiles.updateConfigurationFile).not.toHaveBeenCalled();
  });
});
