import path from "node:path";
import { defineConfig } from "@playwright/test";

const stress = process.env.DAYNIGHT_ACCEPTANCE_STRESS;
if (stress !== undefined && stress !== "1") throw new Error("Invalid browser stress selection.");
if (stress === "1" && process.env.CI !== undefined) throw new Error("Browser stress acceptance is local-only and cannot run in CI.");
const directory = process.env.DAYNIGHT_ACCEPTANCE_DIRECTORY;
const baseURL = process.env.DAYNIGHT_BASE_URL;
if (directory === undefined || baseURL === undefined) {
  throw new Error("Run browser acceptance through pnpm web:acceptance.");
}
const executable = process.env.DAYNIGHT_BROWSER_EXECUTABLE;

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: stress === "1" ? [] : ["**/capacity.spec.ts"],
  timeout: 180_000,
  globalTimeout: 900_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: process.env.CI !== undefined,
  workers: 1,
  retries: 0,
  outputDir: path.join(directory, "test-results"),
  reporter: [["line"], ["json", { outputFile: path.join(directory, "playwright.json") }]],
  use: {
    baseURL,
    channel: "chromium",
    viewport: { width: 1600, height: 1100 },
    locale: "zh-CN",
    trace: "off",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    launchOptions: {
      env: { ...process.env, TMPDIR: '.tmp' },
      ...(executable === undefined ? {} : { executablePath: executable }),
    },
  },
});
