import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/fixtures/acceptance-setup.ts"],
    include: ["test/**/*.acceptance.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
