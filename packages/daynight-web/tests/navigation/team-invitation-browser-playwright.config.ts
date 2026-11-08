import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/team-invitation.browser.ts', workers: 1, retries: 0, timeout: 45_000, globalTimeout: 180_000, reporter: 'line',
  outputDir: fileURLToPath(new URL('../../../../.tmp/team-invitation-browser-results', import.meta.url)),
  use: { channel: 'chromium', ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { launchOptions: { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE } }), baseURL: 'http://127.0.0.1:4214', viewport: { width: 320, height: 844 }, locale: 'zh-CN', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/team-invitation-browser-vite.config.ts && pnpm exec vite preview --config tests/navigation/team-invitation-browser-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4214/team-invitations', reuseExistingServer: false, timeout: 90_000 },
});
