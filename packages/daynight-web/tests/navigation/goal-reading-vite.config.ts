import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './team-preference-vite.config.ts';
export default mergeConfig(base, defineConfig({ cacheDir: fileURLToPath(new URL('../../../../.tmp/goal-reading-vite', import.meta.url)), server: { port: 4209 }, preview: { port: 4209 }, build: { outDir: fileURLToPath(new URL('../../../../.tmp/goal-reading-host', import.meta.url)) } }));
