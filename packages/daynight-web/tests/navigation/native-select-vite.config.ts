import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)), plugins: [react()],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/native-select-browser/vite-cache', import.meta.url)),
  preview: { host: '127.0.0.1', port: 14301, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('../../../../.tmp/native-select-browser/app', import.meta.url)), emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./native-select-fixture.html', import.meta.url)) },
  },
});
