import { runAcceptance } from './acceptance/runner.mts';

const cancellation = new AbortController();
const cancel = (): void => cancellation.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);

try {
  await runAcceptance(cancellation, {
    browser: async (run) => { await run('pnpm', ['--filter', '@codetreker/daynight-web', 'exec', 'playwright', 'install', '--with-deps', 'chromium'], { timeoutMs: 600_000 }); },
    coverage: async (run) => {
      await run('pnpm', ['--filter', '@codetreker/daynight-web', 'test:harness'], { timeoutMs: 180_000 });
      await run('pnpm', ['--filter', '@codetreker/daynight-web', 'test:coverage'], { env: { ...process.env, VITEST_MAX_WORKERS: '2' }, timeoutMs: 180_000 });
    },
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
