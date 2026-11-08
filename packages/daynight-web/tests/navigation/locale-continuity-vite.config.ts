import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';
export default mergeConfig(base, defineConfig({
  cacheDir: fileURLToPath(new URL('../../../../.tmp/locale-continuity-vite', import.meta.url)),
  server: { port: 4208 }, preview: { port: 4208 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/locale-continuity-host', import.meta.url)) },
}));
