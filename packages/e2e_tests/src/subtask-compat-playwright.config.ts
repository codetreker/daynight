import { defineConfig } from '@playwright/test';
import path from 'node:path';
import base from '../playwright.config.ts';

export default defineConfig(base, {
  testDir: path.resolve(import.meta.dirname, '../tests'),
  testIgnore: [],
  testMatch: '**/subtask-compat.spec.ts',
});
