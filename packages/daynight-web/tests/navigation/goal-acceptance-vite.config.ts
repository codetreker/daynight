import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';

export default mergeConfig(base, defineConfig({
  plugins: [{ name: 'goal-acceptance-host', enforce: 'pre', transformIndexHtml: { order: 'pre', handler: html => html.replace('/src/main.tsx', '/tests/navigation/goal-acceptance-host.ts') } }],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/goal-acceptance-vite', import.meta.url)),
  server: { port: 4244 }, preview: { port: 4244 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/goal-acceptance-host', import.meta.url)) },
}));
