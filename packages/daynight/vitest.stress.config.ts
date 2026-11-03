import { defineConfig } from "vitest/config";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");

export default defineConfig({
  test: {
    include: ["test/**/*.stress.ts"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
