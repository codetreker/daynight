import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';
export default mergeConfig(base, defineConfig({
  cacheDir: fileURLToPath(new URL('../../../../.tmp/task-view-continuity-vite', import.meta.url)),
  server: { port: 4212 }, preview: { port: 4212 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/task-view-continuity-host', import.meta.url)) },
}));
