import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const evidence = fileURLToPath(new URL('../../../../.tmp/webhook-tabs', import.meta.url));
export default defineConfig({ ...base,
  testMatch: '**/webhook-tabs.spec.ts', globalTimeout: 300_000,
  outputDir: `${evidence}/test-results`,
  reporter: [['line'], ['json', { outputFile: `${evidence}/results.json` }]],
  use: { ...base.use, hasTouch: true, ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { launchOptions: { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE } }) },
  webServer: { ...base.webServer, command: `"${process.execPath}" node_modules/vite/bin/vite.js build --config tests/navigation/vite.config.ts && "${process.execPath}" node_modules/vite/bin/vite.js preview --config tests/navigation/vite.config.ts` },
});
