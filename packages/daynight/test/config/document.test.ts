import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfigurationDocument, readConfiguration } from "../../src/config/document.js";
import { resolveConfigurationPaths } from "../../src/config/paths.js";
import { formatError } from "../../src/platform/diagnostics.js";

const paths = resolveConfigurationPaths("/home/config", path.posix);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("shared YAML document boundary", () => {
  it("recognizes each command's fields without imposing its value rules", () => {
    const source = "# Server settings\nworkerId: null\nworker: malformed\nserverUrl: &server nonsense\nreview:\n  repositoryRoot: *server # preserved alias\n  repositories: malformed\n  pollIntervalMs: null\n  maxConcurrentWorker: false\n  agentTimeoutMs: []\n  maxAttempts: {}\n  retryDelayMs: -1\n  copilotModel: null\n  copilotReasoningEffort: false\n";
    const { document, mapping } = parseConfigurationDocument(source, paths);
    expect(mapping).toEqual({ workerId: null, worker: "malformed", serverUrl: "nonsense", review: { repositoryRoot: "nonsense", repositories: "malformed", pollIntervalMs: null, maxConcurrentWorker: false, agentTimeoutMs: [], maxAttempts: {}, retryDelayMs: -1, copilotModel: null, copilotReasoningEffort: false } });
    expect(document.toString()).toContain("serverUrl: &server nonsense");
    expect(document.toString()).toContain("review:\n  repositoryRoot: *server # preserved alias");
  });

  it.each(["", "null", "[]", "42", "serverUrl"])("requires a mapping: %s", (source) => {
    expect(() => parseConfigurationDocument(source, paths)).toThrow("must be a mapping");
  });

  it.each([
    "serverUrl: http://localhost\nserverUrl: http://other\n",
    "review:\n  repositories: [{remote: first, remote: second}]\n",
    "serverUrl: [\n",
    "serverUrl: !unsupported http://localhost\n",
    "serverUrl: http://localhost\n---\nserverUrl: http://other\n",
  ])("rejects syntax, duplicate keys, tags and multiple documents: %s", (source) => {
    try {
      parseConfigurationDocument(source, paths);
      expect.unreachable("Invalid YAML must fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBeInstanceOf(AggregateError);
      expect(formatError(error)).toContain(paths.configFile);
    }
  });

  it.each(["typo: true\nserverUrl: http://localhost", "1: value", "__proto__: value"])("retains unknown root fields in the document: %s", (source) => {
    const { document, mapping } = parseConfigurationDocument(source, paths);
    expect(Object.keys(mapping)).toEqual(source.split("\n").map((line) => line.split(":")[0]));
    expect(parseConfigurationDocument(document.toString(), paths).mapping).toEqual(mapping);
    expect(Object.getPrototypeOf(mapping)).toBe(Object.prototype);
  });

  it("preserves an unresolved alias as a decode failure", () => {
    expect(() => parseConfigurationDocument("serverUrl: *missing", paths)).toThrow(`Cannot decode YAML in ${paths.configFile}.`);
  });

  it.each([
    ["unresolved alias", (secret: string) => `serverUrl: https://service.example\nserverToken: *${secret}\n`, "ReferenceError"],
    ["verbatim tag warning", (secret: string) => `serverUrl: https://service.example\nserverToken: !<${secret}> value\n`, "TAG_RESOLVE_FAILED at offsets"],
    ["local tag warning", (secret: string) => `serverUrl: https://service.example\nserverToken: !${secret} value\n`, "TAG_RESOLVE_FAILED at offsets"],
    ["duplicate secret key", (secret: string) => `${secret}: first\n${secret}: second\n`, "DUPLICATE_KEY at offsets"],
    ["malformed scalar", (secret: string) => `serverToken: "${secret}\n`, "MISSING_CHAR at offsets"],
    ["malformed collection", (secret: string) => `serverToken: [${secret}\n`, "BAD_INDENT at offsets"],
  ])("reports %s without retaining secret bytes anywhere in the diagnostic chain", (_name, source, category) => {
    const secret = "synthetic_PAT_do_not_disclose_7362";
    let failure: unknown;
    try { parseConfigurationDocument(source(secret), paths); }
    catch (cause) { failure = cause; }
    expect(failure).toBeInstanceOf(Error);
    const diagnostic = formatError(failure);
    expect(diagnostic).toContain(category);
    expect(diagnostic).not.toContain(secret);
    expect(inspect(failure, { depth: Infinity })).not.toContain(secret);
  });

  it("reads a document without mutating global configuration or creating runtime data", async () => {
    const temporary = path.resolve(import.meta.dirname, "../../../../.tmp/config-tests");
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "document 用户 "));
    directories.push(directory);
    const runtimePaths = resolveConfigurationPaths(directory);
    await expect(readConfiguration(runtimePaths)).rejects.toMatchObject({ message: `Cannot read configuration file ${runtimePaths.configFile}.`, cause: { code: "ENOENT" } });
    expect(await readdir(directory)).toEqual([]);
    await mkdir(runtimePaths.stateDirectory);
    const source = "# Connection\nserverUrl: http://localhost:8787\n";
    await writeFile(runtimePaths.configFile, source);
    expect((await readConfiguration(runtimePaths)).mapping).toEqual({ serverUrl: "http://localhost:8787" });
    expect(await readFile(runtimePaths.configFile, "utf8")).toBe(source);
    expect(await readdir(runtimePaths.stateDirectory)).toEqual(["config.yml"]);
  });
});
