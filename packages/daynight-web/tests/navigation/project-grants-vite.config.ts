import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';

export default mergeConfig(base, {
  cacheDir: fileURLToPath(new URL('../../../../.tmp/project-grants-vite', import.meta.url)),
  server: { port: 4198 }, preview: { port: 4198 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/project-grants-host', import.meta.url)) },
});
