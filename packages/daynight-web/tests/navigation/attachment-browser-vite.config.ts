import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';

export default mergeConfig(base, defineConfig({
  cacheDir: fileURLToPath(new URL('../../../../.tmp/attachment-browser-vite', import.meta.url)),
  server: { port: 4202 },
  preview: { port: 4202 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/attachment-browser-host', import.meta.url)) },
}));
