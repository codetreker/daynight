import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/project-tags.browser.ts', workers: 1, retries: 0, timeout: 60_000, globalTimeout: 240_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/project-tags/results', import.meta.url)),
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../../../.tmp/project-tags/report.json', import.meta.url)) }]],
  use: { channel: 'chromium', ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { launchOptions: { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE } }), baseURL: 'http://127.0.0.1:4302', viewport: { width: 1100, height: 700 }, screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/project-tags-vite.config.ts && pnpm exec vite preview --config tests/navigation/project-tags-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4302/projects', reuseExistingServer: false, timeout: 120_000 },
});
