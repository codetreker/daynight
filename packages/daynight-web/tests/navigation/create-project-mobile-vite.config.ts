import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';
export default mergeConfig(base, defineConfig({
  cacheDir: fileURLToPath(new URL('../../../../.tmp/create-project-mobile-vite', import.meta.url)),
  server: { port: 4211 }, preview: { port: 4211 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/create-project-mobile-host', import.meta.url)) },
}));
