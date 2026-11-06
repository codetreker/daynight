import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireGroupStopped } from './identity.mts';
import { command, type CommandOptions } from './process.mts';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

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

export const runNavigationChecks = async (cancellation: AbortController, execute = runCiCommand): Promise<void> => {
  const environment = { ...process.env };
  // Production recovery owns only browsers carrying its phase marker.
  delete environment.DAYNIGHT_ACCEPTANCE_DIRECTORY;
  for (const [configuration, timeoutMs, selection] of [
    ['tests/navigation/playwright.config.ts', 180_000, []],
    ['tests/navigation/team-playwright.config.ts', 540_000, ['--grep', '@routine']],
    ['tests/navigation/bots-viewport-playwright.config.ts', 180_000, ['--grep', '@routine']],
  ] as const) {
    cancellation.signal.throwIfAborted();
    await execute('pnpm', ['--filter', '@codetreker/daynight-web', 'exec', 'playwright', 'test', '--config', configuration, ...selection],
      // The dev-ci callback receives five seconds to drain before its group is killed.
      { timeoutMs, forceAfterMs: 1_000, cwd: repositoryRoot, env: environment, signal: cancellation.signal });
  }
};

export const runContainerFunctionalChecks = async (cancellation: AbortController, functional: () => Promise<void>,
  navigation: () => Promise<void> = () => runNavigationChecks(cancellation)): Promise<void> => {
  const failures = new Set<unknown>();
  const aborted = (): void => { failures.add(cancellation.signal.reason); };
  const drain = async (operation: () => Promise<void>): Promise<void> => {
    try { cancellation.signal.throwIfAborted(); await operation(); }
    catch (error) {
      failures.add(error);
      if (!cancellation.signal.aborted) cancellation.abort(error);
    }
  };
  cancellation.signal.addEventListener('abort', aborted, { once: true });
  try { await Promise.all([drain(functional), drain(navigation)]); }
  finally { cancellation.signal.removeEventListener('abort', aborted); }
  if (failures.size === 1) throw [...failures][0];
  if (failures.size > 1) throw new AggregateError(failures, 'Container functional and navigation checks failed.');
};
