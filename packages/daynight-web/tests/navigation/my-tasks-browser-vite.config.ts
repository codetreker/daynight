import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)), plugins: [react(), { name: 'detail-destination', configurePreviewServer(server) { server.middlewares.use('/projects/', (_request, response) => { response.setHeader('content-type', 'text/html'); response.end('Detail destination'); }); } }],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/my-tasks-browser-vite', import.meta.url)),
  preview: { host: '127.0.0.1', port: 14295, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/my-tasks-browser-host', import.meta.url)), emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./my-tasks-browser.html', import.meta.url)) } },
});
