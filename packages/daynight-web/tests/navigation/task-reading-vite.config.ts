import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config';

export default mergeConfig(base, defineConfig({
  cacheDir: fileURLToPath(new URL('../../../../.tmp/task-reading-vite', import.meta.url)),
  server: { port: 4204 }, preview: { port: 4204 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/task-reading-host', import.meta.url)) },
}));
