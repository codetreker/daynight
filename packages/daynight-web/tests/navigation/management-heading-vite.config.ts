import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import teamPreference from './team-preference-vite.config.ts';

export default mergeConfig(teamPreference, {
  cacheDir: fileURLToPath(new URL('../../../../.tmp/management-heading-vite', import.meta.url)),
  server: { port: 14389 },
  preview: { port: 14389 },
  build: { outDir: fileURLToPath(new URL('../../../../.tmp/management-heading-host', import.meta.url)) },
});
