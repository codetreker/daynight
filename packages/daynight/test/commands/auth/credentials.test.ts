import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { updateCredential } from "../../../src/commands/auth/credentials.js";
import { resolveConfigurationPaths } from "../../../src/config/paths.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const fixture = async (source: string) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/auth-credential-tests");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "credential-"));
  directories.push(directory);
  const paths = resolveConfigurationPaths(directory);
  await mkdir(paths.stateDirectory);
  await writeFile(paths.configFile, source);
  return paths;
};
const observed = { serverUrl: "https://daynight.cc", serverToken: "old-token" };
const signal = new AbortController().signal;

describe("credential configuration ownership", () => {
  it.each(["future: *token", "future: { credential: *token }"])("refuses replacement when an unknown value uses the token alias: %s", async (unknown) => {
    const source = `serverToken: &token old-token\n${unknown}\n`;
    const paths = await fixture(source);
    await expect(updateCredential(paths, observed, "new-token", signal)).rejects.toThrow("shared YAML aliases that would change unrelated settings");
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });

  it("preserves unaffected unknown aliases when replacing the credential", async () => {
    const source = "serverToken: old-token\nfuture: &metadata { enabled: true }\nother: *metadata\n";
    const paths = await fixture(source);
    await updateCredential(paths, observed, "new-token", signal);
    const saved = await readFile(paths.configFile, "utf8");
    expect(parse(saved)).toEqual({ serverToken: "new-token", future: { enabled: true }, other: { enabled: true } });
    expect(saved).toContain("future: &metadata { enabled: true }");
    expect(saved).toContain("other: *metadata");
  });

  it("permits an unchanged credential whose alias retains the same unknown value", async () => {
    const source = "serverToken: &token old-token\nfuture: *token\n";
    const paths = await fixture(source);
    await updateCredential(paths, observed, "old-token", signal);
    expect(parse(await readFile(paths.configFile, "utf8"))).toEqual({ serverToken: "old-token", future: "old-token" });
  });

  it("preserves the original file when removing an anchor would leave an unresolved unknown alias", async () => {
    const source = "serverToken: &token old-token\nfuture: *token\n";
    const paths = await fixture(source);
    await expect(updateCredential(paths, observed, undefined, signal)).rejects.toThrow("Unresolved alias");
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
  });
});
