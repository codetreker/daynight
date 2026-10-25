import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MissingConfigurationFileError, isMissingConfiguration } from "../../src/config/errors.js";
import { readConfigurationSource } from "../../src/config/files.js";
import { resolveConfigurationPaths } from "../../src/config/paths.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("missing configuration classification", () => {
  it("classifies missing files while preserving invalid ancestors and dangling symlinks", async () => {
    const temporary = path.resolve(import.meta.dirname, "../../../../.tmp/config-tests");
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "read 用户-"));
    directories.push(directory);
    const paths = resolveConfigurationPaths(directory);
    await expect(readConfigurationSource(paths)).rejects.toBeInstanceOf(MissingConfigurationFileError);
    await writeFile(paths.stateDirectory, "not a directory");
    expect(isMissingConfiguration(await readConfigurationSource(paths).catch((cause: unknown) => cause), "repositories")).toBe(false);
    if (process.platform !== "win32") {
      await rm(paths.stateDirectory);
      await symlink(path.join(directory, "missing-state"), paths.stateDirectory);
      expect(isMissingConfiguration(await readConfigurationSource(paths).catch((cause: unknown) => cause), "repositories")).toBe(false);
    }
  });
});
