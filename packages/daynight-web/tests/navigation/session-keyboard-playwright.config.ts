import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/session-keyboard.browser.ts', workers: 1, retries: 0, timeout: 45_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/session-keyboard/results', import.meta.url)),
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../../../.tmp/session-keyboard/results.json', import.meta.url)) }]],
  use: { baseURL: 'http://127.0.0.1:4307', viewport: { width: 390, height: 844 }, locale: 'en-US', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE ? { launchOptions: { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE } } : {}) } },
    ...(process.env.DAYNIGHT_WEBKIT === '1' ? [{ name: 'webkit', use: { browserName: 'webkit' as const } }] : []),
  ],
  webServer: { command: 'pnpm exec vite build --outDir ../../.tmp/session-keyboard/app --emptyOutDir && pnpm exec vite preview --outDir ../../.tmp/session-keyboard/app --port 4307 --strictPort', cwd: root, url: 'http://127.0.0.1:4307/projects', reuseExistingServer: false, timeout: 120_000 },
});
