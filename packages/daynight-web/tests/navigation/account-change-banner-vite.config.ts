import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from '../../vite.config.ts';

export default mergeConfig(base, {
  build: { rollupOptions: { input: {
    main: fileURLToPath(new URL('../../index.html', import.meta.url)),
    accountChangeBanner: fileURLToPath(new URL('./account-change-banner.html', import.meta.url)),
  } } },
});
