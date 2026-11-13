import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';

export default mergeConfig(base, defineConfig({
  cacheDir: fileURLToPath(new URL('../../../../.tmp/project-tags/vite', import.meta.url)),
  server: { port: 4302 }, preview: { port: 4302 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/project-tags/app', import.meta.url)) },
}));
