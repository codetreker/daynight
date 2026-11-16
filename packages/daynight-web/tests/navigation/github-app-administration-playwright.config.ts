import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/github-app-administration.browser.ts', workers: 1, retries: 0, timeout: 30_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/github-app-administration-results', import.meta.url)), reporter: 'line',
  use: { channel: 'chromium', ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { launchOptions: { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE } }), baseURL: 'http://127.0.0.1:4198', viewport: { width: 1280, height: 900 }, locale: 'en-US', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/github-app-administration-vite.config.ts && pnpm exec vite preview --config tests/navigation/github-app-administration-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4198/projects', reuseExistingServer: false, timeout: 90_000 },
});
