import { defineConfig, mergeConfig, type Plugin } from 'vite';
import base from '../../vite.config.ts';

// The production server normally injects this public setting into the shell.
export const fixturePreviewOrigin = (): Plugin => ({ name: 'test-preview-origin', transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'daynight-preview-origin', content: 'http://preview.localhost:8787' }, injectTo: 'head-prepend' }] });
export default mergeConfig(base, defineConfig({ plugins: [fixturePreviewOrigin()] }));
