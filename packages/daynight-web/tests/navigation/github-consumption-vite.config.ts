import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [react()],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/github-consumption-vite', import.meta.url)),
  server: { host: '127.0.0.1', port: 4199, strictPort: true, hmr: false },
  preview: { host: '127.0.0.1', port: 4199, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/github-consumption-host', import.meta.url)), emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./github-consumption.html', import.meta.url)) } },
});
