import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rewriteHost = (request: IncomingMessage) => {
  const path = request.url?.split('?')[0];
  if (path === '/invitations' || path === '/team-invitations') {
    request.url = '/index.html';
    return;
  }
  if (path === '/' || path === '/outside' || path?.startsWith('/projects')) request.url = '/tests/navigation/index.html';
};

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [react(), {
    name: 'navigation-contract-host',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        rewriteHost(request);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, _response, next) => {
        rewriteHost(request);
        next();
      });
    },
  }],
  cacheDir: '.tmp/navigation-vite',
  optimizeDeps: { entries: ['index.html', 'tests/navigation/index.html'] },
  server: { host: '127.0.0.1', port: 4193, strictPort: true, hmr: false },
  preview: { host: '127.0.0.1', port: 4193, strictPort: true },
  build: {
    outDir: '.tmp/navigation-host',
    emptyOutDir: true,
    rollupOptions: { input: [
      fileURLToPath(new URL('../../index.html', import.meta.url)),
      fileURLToPath(new URL('./index.html', import.meta.url)),
    ] },
  },
});
