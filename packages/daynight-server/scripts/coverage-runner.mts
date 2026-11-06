import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseCoverageProfile, requireCoverageAbove90 } from './coverage.mts';

type CommandExit = { code: number | null; signal: NodeJS.Signals | null };

const waitForClose = async (closed: Promise<CommandExit>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Go coverage process did not close within two seconds.')), 2_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): boolean => {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
};

const stopCommand = async (child: ChildProcess, closed: Promise<CommandExit>): Promise<void> => {
  const failures: unknown[] = [];
  let signalled = false;
  try {
    signalled = signalGroup(child, 'SIGTERM');
  } catch (error) { failures.push(error); }
  // The command can exit before a descendant; retain group ownership through escalation.
  if (signalled) await delay(1_000);
  try { signalGroup(child, 'SIGKILL'); }
  catch (error) { failures.push(error); }
  try { await waitForClose(closed); }
  catch (error) { failures.push(error); }
  if (failures.length !== 0) throw new AggregateError(failures, 'Go coverage process-group cleanup failed.');
};

export const runOwnedCommand = async (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal },
): Promise<void> => {
  options.signal.throwIfAborted();
  const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: 'inherit', detached: true });
  let launchFailure: unknown;
  child.once('error', (error) => { launchFailure = error; });
  const closed = new Promise<CommandExit>((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const stopping = Promise.withResolvers<Error>();
  const cancel = (): void => stopping.resolve(new Error('Go coverage was cancelled.', { cause: options.signal.reason }));
  options.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => stopping.resolve(new Error('Go coverage exceeded its outer watchdog.')), options.timeoutMs);
  if (options.signal.aborted) cancel();
  const failures: unknown[] = [];
  try {
    const result = await Promise.race([closed, stopping.promise]);
    if (result instanceof Error) throw result;
    options.signal.throwIfAborted();
    if (launchFailure !== undefined) throw launchFailure;
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(`Go coverage command failed (${result.signal === null ? `exit ${result.code}` : `signal ${result.signal}`}).`);
    }
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', cancel);
    try { await stopCommand(child, closed); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length !== 0) throw new AggregateError(failures, 'Go coverage command and cleanup failed.');
};

const main = async (): Promise<void> => {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/coverage-runner.mts');
  const race = process.env.DAYNIGHT_TEST_RACE;
  if (race !== undefined && race !== 'true' && race !== 'false') throw new Error('DAYNIGHT_TEST_RACE must be true or false.');
  const cancellation = new AbortController();
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const listeners = signals.map((signal) => {
    const listener = (): void => cancellation.abort(new Error(`Go coverage received ${signal}.`));
    process.on(signal, listener);
    return { signal, listener };
  });
  try {
    const directory = path.resolve(import.meta.dirname, '..');
    await runOwnedCommand('go', [
      'run', 'github.com/codetreker/go-cov/cmd/go-cov@d6caf2759e330b48d69a543695e37002a48feb1d',
      '--config', '.go-cov.toml', '--ci', '--coverprofile', '.tmp/coverage.out', `--race=${race === 'false' ? 'false' : 'true'}`,
    ], { cwd: directory, env: process.env, timeoutMs: 12 * 60_000, signal: cancellation.signal });
    cancellation.signal.throwIfAborted();
    const coverage = parseCoverageProfile(await readFile(path.join(directory, '.tmp/coverage.out'), 'utf8'));
    requireCoverageAbove90(coverage);
    console.log(`Overall coverage >90%: ${coverage.covered}/${coverage.total} statements.`);
  } finally {
    for (const { signal, listener } of listeners) process.removeListener(signal, listener);
  }
};

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
