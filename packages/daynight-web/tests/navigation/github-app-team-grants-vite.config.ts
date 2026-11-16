import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from './github-app-management-vite.config.ts';

export default mergeConfig(base, {
  cacheDir: fileURLToPath(new URL('../../../../.tmp/github-app-team-grants-vite', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('../../../../.tmp/github-app-team-grants-host', import.meta.url)),
    rollupOptions: { input: { shell: fileURLToPath(new URL('./team-preference.html', import.meta.url)), focus: fileURLToPath(new URL('./github-app-team-grants-focus.html', import.meta.url)) } },
  },
});
