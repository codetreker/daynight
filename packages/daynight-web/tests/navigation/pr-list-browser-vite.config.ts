import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';

export default mergeConfig(base, {
  cacheDir: fileURLToPath(new URL('../../../../.tmp/pr-list-browser/vite', import.meta.url)),
  server: { port: 14303, strictPort: true }, preview: { port: 14303, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/pr-list-browser/app', import.meta.url)) },
});
