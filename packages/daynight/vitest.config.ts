import "./scripts/test-bootstrap.js";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import ImmediateFailureReporter from "./scripts/vitest-failure-reporter.js";

const failures = new ImmediateFailureReporter({ directory: fileURLToPath(new URL("../../.tmp/cli-test-failures/", import.meta.url)) });

export default defineConfig({
  test: {
    globalSetup: ["test/fixtures/test-isolation-cleanup.ts"],
    reporters: [...configDefaults.reporters, failures],
    onUnhandledError: failures.onUnhandledError,
  },
});
