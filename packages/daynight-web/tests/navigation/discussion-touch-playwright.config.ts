import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import base from './task-reading-playwright.config';

export default defineConfig(base, {
  testMatch: '**/discussion-touch.browser.ts',
  globalTimeout: 360_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/discussion-touch-results', import.meta.url)),
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../../../.tmp/discussion-touch-results.json', import.meta.url)) }]],
});
