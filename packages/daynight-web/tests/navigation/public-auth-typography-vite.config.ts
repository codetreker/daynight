import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fixturePreviewOrigin } from './product-shell-vite.config.ts';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)), plugins: [react(), fixturePreviewOrigin()],
  cacheDir: fileURLToPath(new URL('../../../../.tmp/public-auth-typography-vite', import.meta.url)),
  preview: { host: '127.0.0.1', port: 4211, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/public-auth-typography-host', import.meta.url)), emptyOutDir: true },
});
