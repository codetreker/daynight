import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rewrite = (request: IncomingMessage) => {
  const path = request.url?.split('?')[0];
  if (path !== undefined && /^\/(projects|teams|shared-projects|workers|bots|account|test-sessions)(\/|$)/.test(path)) request.url = '/tests/navigation/team-preference.html';
};
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [react(), { name: 'project-withdrawal-host', configureServer(server) { server.middlewares.use((request, _response, next) => { rewrite(request); next(); }); }, configurePreviewServer(server) { server.middlewares.use((request, _response, next) => { rewrite(request); next(); }); } }],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/project-withdrawal/vite', import.meta.url)),
  preview: { host: '127.0.0.1', port: 4288, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/project-withdrawal/app', import.meta.url)), emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./team-preference.html', import.meta.url)) } },
});
