import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)), plugins: [react()],
  cacheDir: '.tmp/graph-browser-vite',
  preview: { host: '127.0.0.1', port: 4204, strictPort: true },
  build: { outDir: '.tmp/graph-browser-host', emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./graph-browser.html', import.meta.url)) } },
});
