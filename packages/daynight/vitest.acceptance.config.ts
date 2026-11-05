import "./scripts/test-bootstrap.js";
import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".tmp/vite",
  test: {
    fsModuleCachePath: ".tmp/vitest-modules",
    setupFiles: ["test/fixtures/test-isolation.ts"],
    globalSetup: ["test/fixtures/test-isolation-cleanup.ts", "test/fixtures/acceptance-setup.ts"],
    include: ["test/**/*.acceptance.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
