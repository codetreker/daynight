import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfigurationPaths } from "../../src/config/paths.js";

describe("shared configuration paths", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    { home: "/home/CLI User 用户", api: path.posix, directory: "/home/CLI User 用户/.daynight", file: "/home/CLI User 用户/.daynight/config.yml" },
    { home: "C:\\Users\\CLI User 用户", api: path.win32, directory: "C:\\Users\\CLI User 用户\\.daynight", file: "C:\\Users\\CLI User 用户\\.daynight\\config.yml" },
  ])("resolves the existing global locations for $home", ({ home, api, directory, file }) => {
    expect(resolveConfigurationPaths(home, api)).toEqual({ stateDirectory: directory, configFile: file });
  });

  it.each([
    { home: "/home/user", root: "/tmp/dev 用户", api: path.posix },
    { home: "C:\\Users\\user", root: "D:\\Daynight Dev", api: path.win32 },
  ])("uses an explicit state root without changing home for $home", ({ home, root, api }) => {
    vi.stubEnv("DN_CONFIG_DIR", root);
    expect(resolveConfigurationPaths(home, api)).toEqual({ stateDirectory: root, configFile: api.join(root, "config.yml") });
  });

  it.each(["", "relative", "~/.daynight-dev", "/tmp/invalid\nroot", "/tmp/invalid\0root", "/tmp/invalid\troot", "/tmp/invalid\x1broot"])("rejects ambiguous DN_CONFIG_DIR %j", root => {
    vi.stubEnv("DN_CONFIG_DIR", root);
    expect(() => resolveConfigurationPaths("/home/user", path.posix, { DN_CONFIG_DIR: root })).toThrow("DN_CONFIG_DIR");
  });

  it("rejects a relative home without consulting environment variables", () => {
    expect(() => resolveConfigurationPaths("relative", path.posix)).toThrow("absolute path");
  });
});
