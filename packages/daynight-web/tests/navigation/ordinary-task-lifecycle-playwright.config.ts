import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const evidence = fileURLToPath(new URL('../../../../.tmp/ordinary-task-lifecycle-browser/', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/ordinary-task-lifecycle.browser.ts', workers: 1, retries: 0,
  timeout: 45_000, globalTimeout: 300_000, outputDir: `${evidence}/results`,
  reporter: [['line'], ['json', { outputFile: `${evidence}/results.json` }]],
  use: { baseURL: 'http://127.0.0.1:4203', screenshot: 'only-on-failure', launchOptions: {
    ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE }),
  } },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/task-controls-vite.config.ts && pnpm exec vite preview --config tests/navigation/task-controls-vite.config.ts', cwd: fileURLToPath(new URL('../..', import.meta.url)), url: 'http://127.0.0.1:4203/projects', reuseExistingServer: false, timeout: 90_000 },
});
