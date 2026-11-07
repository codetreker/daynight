import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';

export default mergeConfig(base, {
  cacheDir: fileURLToPath(new URL('../../../../.tmp/project-deletion-layout/vite', import.meta.url)),
  server: { port: 4397, strictPort: true }, preview: { port: 4397, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/project-deletion-layout/app', import.meta.url)) },
});
