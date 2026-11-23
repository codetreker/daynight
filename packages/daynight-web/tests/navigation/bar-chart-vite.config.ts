import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)), plugins: [react()],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/bar-chart-browser/vite-cache', import.meta.url)),
  preview: { host: '127.0.0.1', port: 14302, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/bar-chart-browser/app', import.meta.url)), emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./bar-chart-fixture.html', import.meta.url)) } },
});
