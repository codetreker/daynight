import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
const rewrite = (request: IncomingMessage) => { if (/^\/(team-invitations|teams|projects)(\/|\?|$)/.test(request.url ?? '')) request.url = '/tests/navigation/team-preference.html'; };
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [react(), { name: 'team-invitation-host', configureServer(server) { server.middlewares.use((request, _response, next) => { rewrite(request); next(); }); }, configurePreviewServer(server) { server.middlewares.use((request, _response, next) => { rewrite(request); next(); }); } }],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/team-invitation-browser-vite', import.meta.url)),
  server: { host: '127.0.0.1', port: 4214, strictPort: true }, preview: { host: '127.0.0.1', port: 4214, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/team-invitation-browser-host', import.meta.url)), emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./team-preference.html', import.meta.url)) } },
});
