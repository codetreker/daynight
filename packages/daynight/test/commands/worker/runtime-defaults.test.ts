import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWorker } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const fixture = async (source: string | undefined) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-runtime-defaults-tests");
  await mkdir(temporary, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(temporary, "home-"));
  directories.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  if (source !== undefined) {
    await mkdir(paths.stateDirectory);
    await writeFile(paths.configFile, source);
  }
  const before = (await readdir(homeDirectory, { recursive: true })).sort();
  return { homeDirectory, paths, before };
};

const packageDirectory = path.resolve(import.meta.dirname, "../../..");
const authenticationError = "You are not logged in. Run daynight login to authenticate.";

describe("worker startup configuration defaults", () => {
  it.each([
    { label: "a missing configuration file", source: undefined },
    { label: "an empty configuration mapping", source: "{}\n" },
    { label: "an empty worker mapping", source: "worker: {}\n" },
    { label: "partial worker settings without repositories", source: "worker:\n  maxConcurrent: 2\n  agent: codex\n" },
  ])("reaches authentication with $label and preserves the user's files", async ({ source }) => {
    const { homeDirectory, paths, before } = await fixture(source);
    const messages: string[] = [];
    await expect(runWorker({ homeDirectory, packageDirectory, log: (message) => { messages.push(message); } }))
      .rejects.toThrow(authenticationError);
    expect((await readdir(homeDirectory, { recursive: true })).sort()).toEqual(before);
    if (source !== undefined) expect(await readFile(paths.configFile, "utf8")).toBe(source);
    expect(messages).toEqual([]);
  });

  it.each([
    { source: "worker: null\n", message: "worker must be a mapping" },
    { source: "worker:\n  maxConcurrent: 0\n", message: "worker.maxConcurrent must be a positive safe integer" },
    { source: "worker:\n  repositories: null\n", message: "worker.repositories must be a sequence" },
  ])("rejects invalid configuration before authentication: $source", async ({ source, message }) => {
    const { homeDirectory, paths, before } = await fixture(source);
    await expect(runWorker({ homeDirectory, packageDirectory })).rejects.toThrow(message);
    expect((await readdir(homeDirectory, { recursive: true })).sort()).toEqual(before);
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
  });
});
