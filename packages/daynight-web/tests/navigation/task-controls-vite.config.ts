import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import type { IncomingMessage } from 'node:http';
import base from './team-preference-vite.config';

export default mergeConfig(base, defineConfig({
  plugins: [{ name: 'summary-detail-fixture', configurePreviewServer(server) {
    server.middlewares.use((request: IncomingMessage, _response, next) => {
      if (request.url?.split('?')[0] === '/summary-detail-fixture') request.url = '/tests/navigation/summary-detail.html';
      next();
    });
  } }],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/task-controls-vite', import.meta.url)),
  server: { port: 4203 }, preview: { port: 4203 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/task-controls-host', import.meta.url)), rollupOptions: { input: {
    workspace: fileURLToPath(new URL('./team-preference.html', import.meta.url)),
    summary: fileURLToPath(new URL('./summary-detail.html', import.meta.url)),
  } } },
}));
