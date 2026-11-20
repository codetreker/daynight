import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)), plugins: [react()],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/scoped-authorization-vite', import.meta.url)),
  preview: { host: '127.0.0.1', port: 4258, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/scoped-authorization-host', import.meta.url)), emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./scoped-authorization.html', import.meta.url)) } },
});
