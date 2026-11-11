import { describe, expect, it } from "vitest";
import ordinary from "../../vitest.config.js";
import windows from "../../vitest.windows-shards.config.js";

describe("Windows shard configuration", () => {
  it("only adds execution JSON while preserving discovery, isolation, errors and existing reporters", () => {
    const { reporters: ordinaryReporters, ...ordinaryTest } = ordinary.test!;
    const { reporters: windowsReporters, ...windowsTest } = windows.test!;
    if (!Array.isArray(ordinaryReporters) || !Array.isArray(windowsReporters)) throw new Error("Expected reporter arrays.");
    expect(windowsTest).toEqual(ordinaryTest);
    expect(windowsTest.onUnhandledError).toBe(ordinaryTest.onUnhandledError);
    expect(windowsReporters).toEqual([
      ...ordinaryReporters,
      ["json", { outputFile: "../../.tmp/windows-cli-shard/results.json" }],
    ]);
    expect(windowsReporters.slice(0, -1)).toEqual(ordinaryReporters);
  });
});
