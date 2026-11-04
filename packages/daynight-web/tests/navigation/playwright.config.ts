import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const evidence = fileURLToPath(new URL('../../.tmp/acceptance/navigation-contract', import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: `${evidence}/test-results`,
  reporter: [['line'], ['json', { outputFile: `${evidence}/results.json` }]],
  workers: 1,
  retries: 0,
  timeout: 30_000,
  globalTimeout: 360_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: 'http://127.0.0.1:4193',
    viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite build --config tests/navigation/vite.config.ts && pnpm exec vite preview --config tests/navigation/vite.config.ts',
    cwd: root,
    url: 'http://127.0.0.1:4193',
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
