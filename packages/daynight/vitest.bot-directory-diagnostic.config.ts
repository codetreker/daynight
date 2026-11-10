import path from "node:path";
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import ordinary from "./vitest.config.js";

export default mergeConfig(ordinary, defineConfig({
  test: {
    runner: path.join(import.meta.dirname, "scripts/bot-directory-test-runner.mjs"),
    exclude: [...configDefaults.exclude, "test/commands/worker/bot-process-directory-lock.windows.test.ts"],
  },
}));
