import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';

const rewritePersonalTasks = (request: IncomingMessage) => {
  if (request.url?.split('?')[0] === '/my-tasks') request.url = '/tests/navigation/team-preference.html';
};

export default mergeConfig(base, defineConfig({
  plugins: [{ name: 'goal-acceptance-host', enforce: 'pre', transformIndexHtml: { order: 'pre', handler: html => html.replace('/src/main.tsx', '/tests/navigation/goal-acceptance-host.ts') },
    configureServer(server) { server.middlewares.use((request, _response, next) => { rewritePersonalTasks(request); next(); }); },
    configurePreviewServer(server) { server.middlewares.use((request, _response, next) => { rewritePersonalTasks(request); next(); }); },
  }],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/goal-acceptance-vite', import.meta.url)),
  server: { port: 4244 }, preview: { port: 4244 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/goal-acceptance-host', import.meta.url)) },
}));
