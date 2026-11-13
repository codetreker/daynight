import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)), plugins: [react()],
  cacheDir: fileURLToPath(new URL('../../.tmp/session-drafts-browser/vite-cache', import.meta.url)),
  server: { host: '127.0.0.1', port: 14293, strictPort: true }, preview: { host: '127.0.0.1', port: 14293, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../.tmp/session-drafts-browser/app', import.meta.url)), emptyOutDir: true, rollupOptions: { input: [fileURLToPath(new URL('./session-drafts-fixture.html', import.meta.url)), fileURLToPath(new URL('./session-drafts-client-fixture.html', import.meta.url))] } },
});
