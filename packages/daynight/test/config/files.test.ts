import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateConfigurationFile } from "../../src/config/files.js";
import { resolveConfigurationPaths } from "../../src/config/paths.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.mocked(filesystem.rename).mockReset();
  vi.mocked(filesystem.unlink).mockReset();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const fixture = async () => {
  const temporary = path.resolve(import.meta.dirname, "../../../../.tmp/config-tests");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "mutation 用户 "));
  directories.push(directory);
  const paths = resolveConfigurationPaths(directory);
  await mkdir(paths.stateDirectory);
  const source = "serverUrl: http://localhost:8787\n";
  await writeFile(paths.configFile, source);
  return { paths, source };
};

describe("configuration mutation failures", () => {
  it("retains the original callback failure and lock cleanup failure", async () => {
    const { paths, source } = await fixture();
    const operationFailure = new Error("Configuration rejected by its owner");
    const cleanupFailure = Object.assign(new Error("Lock removal denied"), { code: "EACCES" });
    vi.mocked(filesystem.unlink).mockRejectedValueOnce(cleanupFailure);
    try {
      await updateConfigurationFile(paths, async () => { throw operationFailure; });
      expect.unreachable("The mutation must fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([operationFailure, cleanupFailure]);
    }
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml", "config.yml.lock"]);
  });

  it("enforces write ownership under the lock before replacing aliased unknown values", async () => {
    const { paths } = await fixture();
    const source = "serverUrl: &server http://localhost:8787\nfuture: *server\n";
    await writeFile(paths.configFile, source);
    await expect(updateConfigurationFile(paths, async (current) => {
      expect(current).toBe(source);
      expect(await readdir(paths.stateDirectory)).toContain("config.yml.lock");
      return {
        kind: "write", result: "updated", ownership: { fields: ["serverUrl"] },
        source: "serverUrl: &server http://other:8787\nfuture: *server\n",
      };
    })).rejects.toThrow("shared YAML aliases that would change unrelated settings");
    expect(filesystem.rename).not.toHaveBeenCalled();
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("writes owned fields while preserving unrelated cyclic unknown values", async () => {
    const { paths } = await fixture();
    const source = "serverUrl: http://localhost:8787\nfuture: &metadata { loop: *metadata }\n";
    await writeFile(paths.configFile, source);
    const proposed = "serverUrl: http://other:8787\nfuture: &metadata { loop: *metadata }\n";
    expect(await updateConfigurationFile(paths, async () => ({
      kind: "write", result: "updated", source: proposed, ownership: { fields: ["serverUrl"] },
    }))).toBe("updated");
    expect(await readFile(paths.configFile, "utf8")).toBe(proposed);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("retains replacement and temporary cleanup errors while releasing the writer lock", async () => {
    const { paths, source } = await fixture();
    const replaceFailure = new Error("Atomic replacement denied");
    const cleanupFailure = new Error("Temporary removal denied");
    vi.mocked(filesystem.rename).mockRejectedValueOnce(replaceFailure);
    vi.mocked(filesystem.unlink).mockRejectedValueOnce(cleanupFailure);
    try {
      await updateConfigurationFile(paths, async () => ({ kind: "write", result: "updated", source: "serverUrl: http://other:8787\n", ownership: { fields: ["serverUrl"] } }));
      expect.unreachable("The mutation must fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([replaceFailure, cleanupFailure]);
    }
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
    const entries = await readdir(paths.stateDirectory);
    expect(entries).not.toContain("config.yml.lock");
    expect(entries.filter((entry) => entry.startsWith(".atomic-") && entry.endsWith(".tmp"))).toHaveLength(1);
  });
});
