import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReviewPaths } from "../../../src/commands/review/paths.js";

describe("current-user runtime paths", () => {
  it("resolves all state locations from an injected POSIX home", () => {
    expect(resolveReviewPaths("/home/Review User 用户", path.posix)).toEqual({
      stateDirectory: "/home/Review User 用户/.daynight",
      configFile: "/home/Review User 用户/.daynight/config.yml",
      databaseFile: "/home/Review User 用户/.daynight/state.sqlite",
      lockFile: "/home/Review User 用户/.daynight/instance.lock",
      copilotDirectory: "/home/Review User 用户/.daynight/copilot",
      cacheDirectory: "/home/Review User 用户/.daynight/cache",
      temporaryDirectory: "/home/Review User 用户/.daynight/tmp",
      logsDirectory: "/home/Review User 用户/.daynight/logs",
    });
  });

  it("uses Windows path semantics without reading or changing HOME", () => {
    const paths = resolveReviewPaths("C:\\Users\\Review User 用户", path.win32);
    expect(paths.configFile).toBe("C:\\Users\\Review User 用户\\.daynight\\config.yml");
    expect(paths.databaseFile).toBe("C:\\Users\\Review User 用户\\.daynight\\state.sqlite");
  });

  it("rejects a relative home rather than deriving state from the working directory", () => {
    expect(() => resolveReviewPaths("relative", path.posix)).toThrow("absolute path");
  });
});
