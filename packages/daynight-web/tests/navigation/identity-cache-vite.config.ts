import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';

const rewritePublicEntry = (request: IncomingMessage) => {
  const path = request.url?.split('?')[0];
  if (path === '/' || path === '/login' || path === '/auth/complete') request.url = '/tests/navigation/team-preference.html';
};
export default mergeConfig(base, defineConfig({
  plugins: [{ name: 'identity-cache-public-entry', configureServer(server) { server.middlewares.use((request, _response, next) => { rewritePublicEntry(request); next(); }); }, configurePreviewServer(server) { server.middlewares.use((request, _response, next) => { rewritePublicEntry(request); next(); }); } }],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/identity-cache-vite', import.meta.url)),
  server: { port: 4206 }, preview: { port: 4206 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/identity-cache-host', import.meta.url)) },
}));
