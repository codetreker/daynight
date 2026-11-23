import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { mergeConfig, type Plugin } from 'vite';
import base from './github-app-management-vite.config.ts';

const rewrite = (request: IncomingMessage) => {
  if (request.url?.split('?')[0] === '/github-app-admin-invitations') request.url = '/tests/navigation/team-preference.html';
};
const host: Plugin = { name: 'github-app-administration-host', configureServer(server) { server.middlewares.use((request, _response, next) => { rewrite(request); next(); }); }, configurePreviewServer(server) { server.middlewares.use((request, _response, next) => { rewrite(request); next(); }); } };
export default mergeConfig(base, {
  plugins: [host],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/github-app-administration-vite', import.meta.url)),
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/github-app-administration-host', import.meta.url)) },
});
