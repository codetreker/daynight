import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)), plugins: [react()],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/graph-direction-browser-vite', import.meta.url)),
  server: { host: '127.0.0.1', port: 4215, strictPort: true }, preview: { host: '127.0.0.1', port: 4215, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/graph-direction-browser-host', import.meta.url)), emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./graph-direction-browser.html', import.meta.url)) } },
});
