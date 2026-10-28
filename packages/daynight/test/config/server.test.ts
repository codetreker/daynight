import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadServerConfiguration, normalizeServerUrl, parseServerConfiguration } from "../../src/config/server.js";
import { resolveConfigurationPaths } from "../../src/config/paths.js";
import { formatError } from "../../src/platform/diagnostics.js";

const paths = resolveConfigurationPaths("/home/config", path.posix);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("server configuration projection", () => {
  it.each([
    ["http://localhost:8787", "http://localhost:8787"],
    ["HTTP://LOCALHOST:80/", "http://localhost"],
    ["HTTPS://Example.COM:443", "https://example.com"],
    ["https://example.com:8443/", "https://example.com:8443"],
    ["http://[0:0:0:0:0:0:0:1]:8787/", "http://[::1]:8787"],
  ])("normalizes %s as an origin", (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
    expect(parseServerConfiguration(`serverUrl: ${JSON.stringify(input)}`, paths)).toEqual({ serverUrl: expected });
  });

  it.each([
    undefined, null, 8787, "", "localhost:8787", "ftp://example.com", "http://", "http:///example.com", "https:example.com",
    "https://user@example.com", "https://user:secret@example.com", "https://@example.com", "https://example.com/api", "https://example.com/.", "https://example.com//", "https://example.com/%2e", "https://example.com?", "https://example.com?token=secret", "https://example.com/#", "https://example.com#part", "https://example.com\\", "https://example.com\\@other.com", " https://example.com", "https://example.com ", "https://exa\nmple.com", "https://example.com\u0000", "https://example.com\u007f", "https://example.com:65536",
  ])("rejects values that are not a literal HTTP(S) origin: %j", (input) => {
    expect(() => normalizeServerUrl(input)).toThrow("serverUrl");
  });

  it("requires only serverUrl and leaves review values to review", () => {
    expect(parseServerConfiguration("serverUrl: http://localhost:8787", paths)).toEqual({ serverUrl: "http://localhost:8787" });
    expect(parseServerConfiguration("serverUrl: http://localhost:8787\nreview:\n  repositoryRoot: null\n  repositories: false\n  pollIntervalMs: bad\n  maxConcurrentWorker: 0\n  agentTimeoutMs: -1\n  maxAttempts: null\n  retryDelayMs: {}", paths)).toEqual({ serverUrl: "http://localhost:8787" });
  });

  it.each(["null", "42", "true", "[]", "{}", '""', '"model\\u0000name"'])("leaves invalid Copilot model values to review: %s", (value) => {
    expect(parseServerConfiguration(`serverUrl: http://localhost:8787\nreview:\n  copilotModel: ${value}\n`, paths)).toEqual({ serverUrl: "http://localhost:8787" });
  });

  it.each(["null", "42", "true", "[]", "{}", '""', '"effort\\u0000name"'])("leaves invalid Copilot reasoning effort values to review: %s", (value) => {
    expect(parseServerConfiguration(`serverUrl: http://localhost:8787\nreview:\n  copilotReasoningEffort: ${value}\n`, paths)).toEqual({ serverUrl: "http://localhost:8787" });
  });

  it("ignores unknown fields while validating known server settings", () => {
    expect(parseServerConfiguration("serverURL: http://localhost\nfuture: { nested: true }", paths)).toEqual({ serverUrl: "https://daynight.cc" });
    expect(parseServerConfiguration("future: { nested: true }\nserverUrl: https://service.example\nserverToken: configured-secret", paths)).toEqual({ serverUrl: "https://service.example", serverToken: "configured-secret" });
    expect(() => parseServerConfiguration("future: true\nserverUrl: null", paths)).toThrow("serverUrl");
    expect(() => parseServerConfiguration("future: true\nserverToken: false", paths)).toThrow("serverToken");
  });

  it("reports the configuration filename, server field and original URL parse error", () => {
    try {
      parseServerConfiguration("serverUrl: http://[invalid", paths);
      expect.unreachable("Invalid origin must fail.");
    } catch (error) {
      expect(formatError(error)).toContain(paths.configFile);
      expect(formatError(error)).toContain("serverUrl");
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(((error as Error).cause as Error).cause).toBeInstanceOf(TypeError);
    }
  });

  it.each(["review:\n  repositories: []", "{}", "serverToken: default-secret"])("uses the production origin when serverUrl is omitted: %s", (source) => {
    expect(parseServerConfiguration(source, paths)).toEqual({ serverUrl: "https://daynight.cc", ...(source.startsWith("serverToken") ? { serverToken: "default-secret" } : {}) });
  });

  it.each(["serverUrl: http://localhost\nserverUrl: http://other", "review:\n  repositories: [{path: a, path: b}]\nserverUrl: http://localhost"])("retains the shared YAML rejection: %s", (source) => {
    expect(() => parseServerConfiguration(source, paths)).toThrow(`Invalid configuration file ${paths.configFile}`);
  });

  it("loads only configuration and preserves read failures without creating state", async () => {
    const temporary = path.resolve(import.meta.dirname, "../../../../.tmp/config-tests");
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "server 用户 "));
    directories.push(directory);
    const runtimePaths = resolveConfigurationPaths(directory);
    await expect(loadServerConfiguration(runtimePaths)).resolves.toEqual({ serverUrl: "https://daynight.cc" });
    expect(await readdir(directory)).toEqual([]);
    await mkdir(runtimePaths.stateDirectory);
    await writeFile(runtimePaths.configFile, "serverUrl: http://localhost:8787/\n");
    expect(await loadServerConfiguration(runtimePaths)).toEqual({ serverUrl: "http://localhost:8787" });
    expect(await readdir(runtimePaths.stateDirectory)).toEqual(["config.yml"]);
  });
});
