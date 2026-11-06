import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';
export default mergeConfig(base, defineConfig({
  cacheDir: fileURLToPath(new URL('../../../../.tmp/identity-cache-vite', import.meta.url)),
  server: { port: 4206 }, preview: { port: 4206 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/identity-cache-host', import.meta.url)) },
}));
