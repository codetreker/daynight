import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
const root = fileURLToPath(new URL('../..', import.meta.url));
const evidence = fileURLToPath(new URL('../../../../.tmp/bar-chart-browser/', import.meta.url));
const executable = process.env.DAYNIGHT_BROWSER_EXECUTABLE;
export default defineConfig({
  testDir: '.', testMatch: '**/bar-chart.browser.ts', workers: 1, retries: 0, timeout: 45_000, globalTimeout: 240_000,
  outputDir: `${evidence}/results`, reporter: [['line'], ['json', { outputFile: `${evidence}/results.json` }]],
  use: { channel: 'chromium', baseURL: 'http://127.0.0.1:14302', screenshot: 'only-on-failure', ...(executable === undefined ? {} : { launchOptions: { executablePath: executable } }) },
  webServer: { command: `"${process.execPath}" node_modules/vite/bin/vite.js build --config tests/navigation/bar-chart-vite.config.ts && "${process.execPath}" node_modules/vite/bin/vite.js preview --config tests/navigation/bar-chart-vite.config.ts`, cwd: root, url: 'http://127.0.0.1:14302/tests/navigation/bar-chart-fixture.html', reuseExistingServer: false, timeout: 90_000 },
});
