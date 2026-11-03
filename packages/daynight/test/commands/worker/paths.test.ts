import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

describe("fixed worker paths", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("isolates every local state path under DN_CONFIG_DIR", () => {
    vi.stubEnv("DN_CONFIG_DIR", "/isolated/daynight-dev");
    const paths = resolveWorkerPaths("/real/home", path.posix);
    for (const value of Object.values(paths)) expect(value === "/isolated/daynight-dev" || value.startsWith("/isolated/daynight-dev/")).toBe(true);
  });

  it("keeps shared configuration and worker runtime in their fixed home locations", () => {
    expect(resolveWorkerPaths("/home/Worker User 用户", path.posix)).toEqual({
      stateDirectory: "/home/Worker User 用户/.daynight",
      configFile: "/home/Worker User 用户/.daynight/config.yml",
      workerDirectory: "/home/Worker User 用户/.daynight/worker",
      databaseFile: "/home/Worker User 用户/.daynight/worker/state.sqlite",
      lockFile: "/home/Worker User 用户/.daynight/worker/instance.lock",
      herdrDirectory: "/home/Worker User 用户/.daynight/worker/h",
      logsDirectory: "/home/Worker User 用户/.daynight/worker/logs",
      temporaryDirectory: "/home/Worker User 用户/.daynight/worker/tmp",
    });
  });

  it("uses Windows home and path semantics", () => {
    expect(resolveWorkerPaths("C:\\Users\\Worker User 用户", path.win32)).toEqual({
      stateDirectory: "C:\\Users\\Worker User 用户\\.daynight",
      configFile: "C:\\Users\\Worker User 用户\\.daynight\\config.yml",
      workerDirectory: "C:\\Users\\Worker User 用户\\.daynight\\worker",
      databaseFile: "C:\\Users\\Worker User 用户\\.daynight\\worker\\state.sqlite",
      lockFile: "C:\\Users\\Worker User 用户\\.daynight\\worker\\instance.lock",
      herdrDirectory: "C:\\Users\\Worker User 用户\\.daynight\\worker\\h",
      logsDirectory: "C:\\Users\\Worker User 用户\\.daynight\\worker\\logs",
      temporaryDirectory: "C:\\Users\\Worker User 用户\\.daynight\\worker\\tmp",
    });
  });

  it("rejects a relative home", () => {
    expect(() => resolveWorkerPaths("relative", path.posix)).toThrow("absolute path");
  });
});
