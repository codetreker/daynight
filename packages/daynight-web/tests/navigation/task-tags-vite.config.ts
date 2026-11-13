import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';

export default mergeConfig(base, defineConfig({
  cacheDir: fileURLToPath(new URL('../../../../.tmp/task-tags-vite', import.meta.url)),
  server: { port: 4228 }, preview: { port: 4228 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/task-tags-host', import.meta.url)) },
}));
