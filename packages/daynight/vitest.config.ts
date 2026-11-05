import "./scripts/test-bootstrap.js";
import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".tmp/vite",
  test: {
    fsModuleCachePath: ".tmp/vitest-modules",
    setupFiles: ["test/fixtures/test-isolation.ts"],
    globalSetup: ["test/fixtures/test-isolation-cleanup.ts"],
  },
});
