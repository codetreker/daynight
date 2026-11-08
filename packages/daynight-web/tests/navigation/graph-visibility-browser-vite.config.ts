import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';
export default mergeConfig(base, defineConfig({
  cacheDir: fileURLToPath(new URL('../../../../.tmp/graph-visibility-browser-vite', import.meta.url)),
  server: { port: 4213 }, preview: { port: 4213 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/graph-visibility-browser-host', import.meta.url)) },
}));
