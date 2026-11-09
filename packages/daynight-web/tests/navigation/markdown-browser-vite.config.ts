import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';

export default mergeConfig(base, defineConfig({
  cacheDir: fileURLToPath(new URL('../../../../.tmp/markdown-browser-vite', import.meta.url)),
  server: { port: 4203 }, preview: { port: 4203 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/markdown-browser-host', import.meta.url)) },
}));
