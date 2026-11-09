import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config';

export default mergeConfig(base, defineConfig({
  cacheDir: fileURLToPath(new URL('../../../../.tmp/task-controls-vite', import.meta.url)),
  server: { port: 4203 }, preview: { port: 4203 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/task-controls-host', import.meta.url)) },
}));
