import { defineConfig } from "vitest/config";
import ordinary from "./vitest.config.js";

const reporters = ordinary.test?.reporters;
if (!Array.isArray(reporters)) throw new Error("Ordinary CLI reporters must be an array.");

export default defineConfig({
  ...ordinary,
  test: {
    ...ordinary.test,
    reporters: [...reporters, ["json", { outputFile: "../../.tmp/windows-cli-shard/results.json" }]],
  },
});
