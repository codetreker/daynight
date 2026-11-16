import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { mergeConfig, type Plugin } from 'vite';
import base from './project-grants-vite.config.ts';

const rewrite = (request: IncomingMessage) => {
  const path = request.url?.split('?')[0];
  if (path !== undefined && /^\/github-apps(?:\/|$)/.test(path)) request.url = '/tests/navigation/team-preference.html';
};
const host: Plugin = { name: 'github-app-management-host', configureServer(server) { server.middlewares.use((request, _response, next) => { rewrite(request); next(); }); }, configurePreviewServer(server) { server.middlewares.use((request, _response, next) => { rewrite(request); next(); }); } };
export default mergeConfig(base, {
  plugins: [host],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/github-app-management-vite', import.meta.url)),
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/github-app-management-host', import.meta.url)) },
});
