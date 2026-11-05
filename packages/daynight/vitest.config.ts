import "./scripts/test-bootstrap.js";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/fixtures/test-isolation-cleanup.ts"],
  },
});
