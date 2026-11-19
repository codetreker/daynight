import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import reading from './goal-reading-playwright.config';

export default defineConfig({
  ...reading,
  testMatch: '**/goal-dependencies.browser.ts',
  globalTimeout: 360_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/goal-dependencies-results', import.meta.url)),
});
