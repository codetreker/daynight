import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import ordinary from './session-drafts-playwright.config';

if (process.env.CI) throw new Error('Session draft browser capacity tests are local-only and cannot run in CI.');

export default defineConfig({
  ...ordinary,
  grep: /@capacity/,
  grepInvert: [],
  outputDir: fileURLToPath(new URL('../../.tmp/session-drafts-capacity/results', import.meta.url)),
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../.tmp/session-drafts-capacity/results.json', import.meta.url)) }]],
});
