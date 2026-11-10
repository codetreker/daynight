import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  cacheDir: ".tmp/vitest",
  test: {
    environment: "jsdom",
    silent: "passed-only",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [],
      reportsDirectory: ".tmp/coverage",
      reporter: ["text", "json"],
      reportOnFailure: true,
    },
  },
});
