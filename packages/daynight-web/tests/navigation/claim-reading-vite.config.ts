import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';
export default mergeConfig(base, defineConfig({
  cacheDir: fileURLToPath(new URL('../../../../.tmp/claim-reading-vite', import.meta.url)),
  server: { port: 4205 }, preview: { port: 4205 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/claim-reading-host', import.meta.url)) },
}));
