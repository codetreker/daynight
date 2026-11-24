import { spawn, type ChildProcess } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { accessSync, constants as fsConstants, statSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { isAbsolute } from 'node:path';
import { signalCommandGroup } from './command-process-group.mts';

const [resultFile, deadlineArgument, ...extra] = process.argv.slice(2);
const deadlineMs = deadlineArgument === undefined ? 1_200_000 : Number(deadlineArgument);
if (!resultFile || !isAbsolute(resultFile) || extra.length || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2_147_483_647 || process.platform === 'win32' || process.env.UNIT_GO_FLAGS === undefined) {
  console.error('Usage: UNIT_GO_FLAGS=... node scripts/parallel-check-preparation.mts ABSOLUTE_RESULT_FILE [TIMEOUT_MS]');
  process.exit(125);
}

const active = new Map<ChildProcess, boolean>();
let interrupted: number | undefined;
let signalFailure = false;
let escalation: NodeJS.Timeout | undefined;
const signal = (child: ChildProcess, name: NodeJS.Signals) => {
  if (child.pid === undefined) return;
  try { signalCommandGroup(child.pid, name); }
  catch (error) {
    signalFailure = true;
    console.error('Unable to terminate preparation process group:', error);
  }
};
const stop = (code: number) => {
  if (interrupted !== undefined) return;
  interrupted = code;
  // The contract runner owns tests that create their own detached groups.
  // Let it finish its cleanup hooks instead of killing its parent process.
  for (const [child, stoppable] of active) if (stoppable) signal(child, 'SIGTERM');
  // The fixture preparer owns detached grandchildren and needs time to stop
  // and reap them before its own process is forcefully terminated.
  escalation = setTimeout(() => { for (const [child, stoppable] of active) if (stoppable) signal(child, 'SIGKILL'); }, 5000);
};
const terminate = () => stop(143);
const interrupt = () => stop(130);
process.on('SIGTERM', terminate);
process.on('SIGINT', interrupt);
const deadline = setTimeout(() => {
  console.error(`Parallel preparation exceeded ${deadlineMs}ms`);
  stop(124);
}, deadlineMs);

type Result = { code: number; output: string };
const run = (command: string, args: string[], capture = false, environment = process.env, stoppable = true): Promise<Result> => new Promise(resolve => {
  if (interrupted !== undefined) { resolve({ code: interrupted, output: '' }); return; }
  const child = spawn(command, args, { env: environment, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'], detached: true });
  active.set(child, stoppable);
  let output = '';
  let failed = false;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
    if (output.length > 1_048_576) {
      console.error('Fixture preparation output exceeded its limit');
      failed = true;
      stop(125);
    }
  });
  child.once('error', error => {
    failed = true;
    console.error(`Unable to start ${command}:`, error);
  });
  child.once('close', (code, exitSignal) => {
    signal(child, 'SIGKILL');
    active.delete(child);
    resolve({ code: failed ? 125 : code ?? 128 + osConstants.signals[exitSignal!], output });
  });
});

const timed = async <T extends { code: number }>(name: string, operation: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  console.log(`${name} started`);
  try {
    const result = await operation();
    console.log(`${name} completed in ${((performance.now() - start) / 1000).toFixed(2)}s (exit ${result.code})`);
    return result;
  } catch (error) {
    console.error(`${name} failed after ${((performance.now() - start) / 1000).toFixed(2)}s:`, error);
    throw error;
  }
};

try {
  const [contractsOutcome, authOutcome] = await Promise.allSettled([
    timed('Node contract tests', () => run('node', ['--test', 'scripts/coverage.test.mts', 'scripts/check.test.mts', 'scripts/validation-env.test.mts', 'scripts/command-timeout.test.mts', 'scripts/go-cov-capture.test.mts', 'scripts/go-test-database-exec.test.mts', 'scripts/parallel-check-preparation.test.mts', 'scripts/reap-validation.test.mts', 'scripts/check-cancellation.test.mts'], false, process.env, false)),
    timed('Authentication fixture validation', async () => {
      const prepared = await run('node', ['scripts/prepare-uniauth-fixture.mts'], true);
      if (prepared.code !== 0 || interrupted !== undefined) return { code: prepared.code || interrupted!, path: '' };
      const path = prepared.output.trim();
      try {
        if (!isAbsolute(path) || path.includes('\n') || !(await stat(path)).isFile()) throw new Error('Fixture is not an absolute file path');
        await access(path, fsConstants.X_OK);
      } catch (error) {
        console.error('Prepared authentication fixture is unavailable:', error);
        return { code: 1, path: '' };
      }
      const test = await run('go', ['test', '-count=1', '-timeout=30s', './testdata/testauth'], false,
        { ...process.env, GOFLAGS: process.env.UNIT_GO_FLAGS, DAYNIGHT_TEST_UNIAUTH_FIXTURE: path });
      return { code: test.code, path };
    }),
  ]);
  if (contractsOutcome.status === 'rejected') throw contractsOutcome.reason;
  if (authOutcome.status === 'rejected') throw authOutcome.reason;
  const contracts = contractsOutcome.value, auth = authOutcome.value;
  if (signalFailure) process.exitCode = 125;
  else if (interrupted !== undefined) process.exitCode = interrupted;
  else if (contracts.code !== 0) process.exitCode = contracts.code;
  else if (auth.code !== 0) process.exitCode = auth.code;
  else {
    // Read back after both stages: a disappearing fixture must not admit go-cov.
    if (!statSync(auth.path).isFile()) throw new Error('Prepared authentication fixture is no longer a file');
    accessSync(auth.path, fsConstants.X_OK);
    writeFileSync(resultFile, `${auth.path}\n`, { flag: 'wx' });
  }
} catch (error) {
  console.error('Parallel preparation failed:', error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  clearTimeout(escalation);
  process.removeListener('SIGTERM', terminate);
  process.removeListener('SIGINT', interrupt);
}
