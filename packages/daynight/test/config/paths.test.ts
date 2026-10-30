import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigurationPaths } from "../../src/config/paths.js";

describe("shared configuration paths", () => {
  it.each([
    { home: "/home/CLI User 用户", api: path.posix, directory: "/home/CLI User 用户/.daynight", file: "/home/CLI User 用户/.daynight/config.yml" },
    { home: "C:\\Users\\CLI User 用户", api: path.win32, directory: "C:\\Users\\CLI User 用户\\.daynight", file: "C:\\Users\\CLI User 用户\\.daynight\\config.yml" },
  ])("resolves the existing global locations for $home", ({ home, api, directory, file }) => {
    expect(resolveConfigurationPaths(home, api)).toEqual({ stateDirectory: directory, configFile: file });
  });

  it("rejects a relative home without consulting environment variables", () => {
    expect(() => resolveConfigurationPaths("relative", path.posix)).toThrow("absolute path");
  });
});
