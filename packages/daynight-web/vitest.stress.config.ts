import { defineConfig } from 'vitest/config';

if (process.env.CI) throw new Error('Web stress tests are local-only and cannot run in CI.');

export default defineConfig({
  cacheDir: '.tmp/vitest-stress',
  test: {
    environment: 'node',
    include: ['tests/**/*.stress.ts'],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
