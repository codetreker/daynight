import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
const root = fileURLToPath(new URL('../..', import.meta.url));
const executable = process.env.DAYNIGHT_BROWSER_EXECUTABLE;
export default defineConfig({
  testDir: '.', testMatch: '**/my-tasks.browser.ts', workers: 1, retries: 0, timeout: 45_000, globalTimeout: 180_000, reporter: 'line',
  outputDir: fileURLToPath(new URL('../../../../.tmp/my-tasks-browser-results', import.meta.url)),
  use: { channel: 'chromium', ...(executable === undefined ? {} : { launchOptions: { executablePath: executable } }), baseURL: 'http://127.0.0.1:14295', locale: 'en-US', reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/my-tasks-browser-vite.config.ts && pnpm exec vite preview --config tests/navigation/my-tasks-browser-vite.config.ts', cwd: root, url: 'http://127.0.0.1:14295/tests/navigation/my-tasks-browser.html', reuseExistingServer: false, timeout: 90_000 },
});
