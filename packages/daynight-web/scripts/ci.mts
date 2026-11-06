import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireGroupStopped } from './validation/identity.mts';
import { command, type CommandOptions } from './validation/process.mts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const usage = 'Usage: node scripts/ci.mts quality';

export const parseCiArguments = (args: readonly string[]): { mode: 'quality' } => {
  if (args.length !== 1 || args[0] !== 'quality') throw new Error(usage);
  return { mode: 'quality' };
};

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

type CiOperations = { command: typeof runCiCommand };
export const runCi = async (mode: string, cancellation: AbortController,
  operations: CiOperations = { command: runCiCommand }): Promise<void> => {
  if (mode !== 'quality') throw new Error(usage);
  const run = async (args: readonly string[], options: Omit<CommandOptions, 'cwd' | 'signal'>): Promise<void> => {
    cancellation.signal.throwIfAborted();
    await operations.command('pnpm', args, { ...options, cwd: repositoryRoot, signal: cancellation.signal });
  };
  await run(['--filter', '@codetreker/daynight-web', 'test:harness'], { timeoutMs: 180_000 });
  await run(['--filter', '@codetreker/daynight-web', 'exec', 'vitest', 'run', '--coverage'], {
    env: { ...process.env, VITEST_MAX_WORKERS: '4' }, timeoutMs: 300_000,
  });
  await run(['--filter', '@codetreker/daynight-web', 'exec', 'node', 'scripts/coverage.mts'], { timeoutMs: 60_000 });
};

const main = async (): Promise<void> => {
  const { mode } = parseCiArguments(process.argv.slice(2));
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try { await runCi(mode, cancellation); }
  finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
};

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
