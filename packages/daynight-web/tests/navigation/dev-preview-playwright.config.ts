import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/dev-preview.browser.ts', workers: 1, retries: 0, timeout: 30_000,
  reporter: 'line', outputDir: fileURLToPath(new URL('../../../../.tmp/dev-preview-results', import.meta.url)),
  use: { baseURL: 'http://127.0.0.1:4256', locale: 'en-US', ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { launchOptions: { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE } }) },
  webServer: { command: 'pnpm exec vite --host 127.0.0.1 --port 4256 --strictPort', cwd: root, env: { DAYNIGHT_PREVIEW_ORIGIN: 'http://preview.daynight.localhost:8787' }, url: 'http://127.0.0.1:4256', reuseExistingServer: false, timeout: 90_000 },
});
