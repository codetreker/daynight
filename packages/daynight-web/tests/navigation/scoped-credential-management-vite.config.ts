import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)), plugins: [react()],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/scoped-credential-management-vite', import.meta.url)),
  preview: { host: '127.0.0.1', port: 4261, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/scoped-credential-management-host', import.meta.url)), emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./scoped-credential-management.html', import.meta.url)) } },
});
