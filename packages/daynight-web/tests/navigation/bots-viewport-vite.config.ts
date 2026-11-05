import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rewrite = (request: { url?: string | undefined }) => {
  const path = request.url?.split('?')[0];
  if (path === '/bots' || path?.startsWith('/bots/')) request.url = '/tests/navigation/bots-viewport.html';
};
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [{
    name: 'controlled-bot-session-api', enforce: 'pre',
    resolveId(source, importer) {
      if (importer?.endsWith('/features/bots/session-cache.ts') && source === '../../api/sessions') return fileURLToPath(new URL('./bots-viewport-session.ts', import.meta.url));
    },
  }, react(), {
    name: 'bot-viewport-host',
    configureServer(server) { server.middlewares.use((request, _response, next) => { rewrite(request); next(); }); },
    configurePreviewServer(server) { server.middlewares.use((request, _response, next) => { rewrite(request); next(); }); },
  }],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/bots-viewport-vite', import.meta.url)),
  server: { host: '127.0.0.1', port: 4198, strictPort: true, hmr: false },
  preview: { host: '127.0.0.1', port: 4198, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/bots-viewport-host', import.meta.url)), emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./bots-viewport.html', import.meta.url)) } },
});
