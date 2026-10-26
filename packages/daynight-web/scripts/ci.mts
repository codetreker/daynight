import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireGroupStopped } from './acceptance/identity.mts';
import { command, type CommandOptions } from './acceptance/process.mts';
import { runAcceptance } from './acceptance/runner.mts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const usage = 'Usage: node scripts/ci.mts <quality|browser>';

export const runCiCommand = async (file: string, args: readonly string[], options: CommandOptions): Promise<string> => {
  let child: ChildProcess | undefined;
  let output = '';
  let failure: unknown;
  try {
    output = await command(file, args, { ...options, onSpawn: async (spawned) => {
      child = spawned;
      await options.onSpawn?.(spawned);
    } });
  } catch (error) { failure = error; }
  if (child?.pid !== undefined) {
    try { requireGroupStopped(child.pid); }
    catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'CI command and process-group cleanup failed.', { cause: failure }); }
  }
  if (failure !== undefined) throw failure;
  return output;
};

type CiOperations = { command: typeof runCiCommand; acceptance: typeof runAcceptance };
export const runCi = async (mode: string, cancellation: AbortController,
  operations: CiOperations = { command: runCiCommand, acceptance: runAcceptance }): Promise<void> => {
  if (mode !== 'quality' && mode !== 'browser') throw new Error(usage);
  const run = async (args: readonly string[], options: Omit<CommandOptions, 'cwd' | 'signal'>): Promise<void> => {
    cancellation.signal.throwIfAborted();
    await operations.command('pnpm', args, { ...options, cwd: repositoryRoot, signal: cancellation.signal });
  };
  if (mode === 'quality') {
    await run(['--filter', '@codetreker/daynight-web', 'test:harness'], { timeoutMs: 180_000 });
    await run(['--filter', '@codetreker/daynight-web', 'test:coverage'], {
      env: { ...process.env, VITEST_MAX_WORKERS: '2' }, timeoutMs: 180_000,
    });
    return;
  }
  await run(['--filter', '@codetreker/daynight-web', 'exec', 'playwright', 'install', '--with-deps', 'chromium'], { timeoutMs: 600_000 });
  cancellation.signal.throwIfAborted();
  await operations.acceptance(cancellation);
};

const main = async (): Promise<void> => {
  if (process.argv.length !== 3 || !['quality', 'browser'].includes(process.argv[2]!)) throw new Error(usage);
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try { await runCi(process.argv[2]!, cancellation); }
  finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
};

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
