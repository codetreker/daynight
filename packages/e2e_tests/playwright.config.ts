import { defineConfig } from "@playwright/test";
import path from "node:path";
import { readFileSync } from "node:fs";

const runDirectory = process.env.DAYNIGHT_E2E_RUN_DIRECTORY;
if (runDirectory === undefined) throw new Error("Run product E2E through pnpm e2e:test.");
const topology = JSON.parse(readFileSync(path.join(runDirectory, "environment.json"), "utf8")) as { baseURL: string; proxyURL: string };

export default defineConfig({
  testDir: "tests",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(runDirectory, "results", "browser"),
  reporter: [["list"], ["json", { outputFile: path.join(runDirectory, "results", "playwright.json") }]],
  use: {
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
    baseURL: topology.baseURL,
    proxy: { server: topology.proxyURL, bypass: "127.0.0.1,localhost" },
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
