import "./scripts/test-bootstrap.js";
import { defineConfig } from "vitest/config";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");

export default defineConfig({
  cacheDir: ".tmp/vite",
  test: {
    fsModuleCachePath: ".tmp/vitest-modules",
    setupFiles: ["test/fixtures/test-isolation.ts"],
    globalSetup: ["test/fixtures/test-isolation-cleanup.ts"],
    include: ["test/**/*.stress.ts"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
