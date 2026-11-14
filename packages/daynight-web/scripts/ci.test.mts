import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import test from 'node:test';
import { runCi, runCiCommand } from './ci.mts';
import { isGroupStopped, processIdentity, requireGroupStopped } from './validation/identity.mts';
import { commandBytes, terminateGroup, type CommandOptions } from './validation/process.mts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('ordinary Web tests and CI harness execute the native select ownership policy', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(scripts.test, /\bpnpm test:harness\b/);
  assert.match(scripts['test:harness'], /\bnode --test\b.*\bscripts\/native-select-policy\.test\.mts\b/);
  assert.ok(scripts['test:harness'].endsWith(`&& ${scripts['test:select-policy']}`));
  assert.equal(scripts['test:select-policy'], 'node scripts/native-select-policy.mts');
});

const operations = () => {
  const calls: { file: string; args: readonly string[]; options: CommandOptions }[] = [];
  return { calls, command: async (file: string, args: readonly string[], options: CommandOptions) => {
    calls.push({ file, args, options }); return '';
  } };
};

test('quality mode checks workspace types and the production Docker context before coverage', async () => {
  const observed = operations();
  const controller = new AbortController();
  await runCi('quality', controller, observed);
  assert.deepEqual(observed.calls.map(({ file, args }) => [file, args]), [
    ['pnpm', ['web:typecheck']],
    ['pnpm', ['--filter', '@codetreker/daynight-web', 'test:harness']],
    ['docker', ['build', '--progress=plain', '--target', 'web', '--file', 'deployment/localhost/Dockerfile', '.']],
    ['pnpm', ['--filter', '@codetreker/daynight-web', 'exec', 'vitest', 'run', '--coverage']],
    ['pnpm', ['--filter', '@codetreker/daynight-web', 'exec', 'node', 'scripts/coverage.mts']],
  ]);
  assert.deepEqual(observed.calls.map(({ options }) => options.timeoutMs), [60_000, 180_000, 300_000, 900_000, 60_000]);
  for (const call of observed.calls) {
    assert.equal(call.options.cwd, repositoryRoot);
    assert.equal(call.options.signal, controller.signal);
  }
  assert.equal(observed.calls[3]!.options.env!.VITEST_MAX_WORKERS, '4');

});

test('invalid CI modes start no command', async () => {
  for (const mode of ['', 'unknown', 'coverage', 'quality browser']) {
    const observed = operations();
    await assert.rejects(runCi(mode, new AbortController(), observed), /Usage:.*quality/);
    assert.deepEqual(observed.calls, []);

  }
});

test('command failures retain the original error and prevent later serial commands', async () => {
  for (const failingCommand of [1, 2, 3, 4, 5]) {
    const observed = operations();
    const failure = new Error('quality command failed');
    observed.command = async (file, args, options) => {
      observed.calls.push({ file, args, options });
      if (observed.calls.length === failingCommand) throw failure;
      return '';
    };
    await assert.rejects(runCi('quality', new AbortController(), observed), (error) => error === failure);
    assert.equal(observed.calls.length, failingCommand);

  }
});

test('cancellation prevents new work after a completed serial command', async () => {
  for (const completedCommand of [1, 2, 3, 4]) {
    const observed = operations();
    const controller = new AbortController();
    const reason = new Error('CI cancelled');
    observed.command = async (file, args, options) => {
      observed.calls.push({ file, args, options });
      if (observed.calls.length === completedCommand) controller.abort(reason);
      return '';
    };
    await assert.rejects(runCi('quality', controller, observed), (error) => error === reason);
    assert.equal(observed.calls.length, completedCommand);

    observed.calls.length = 0;
    await assert.rejects(runCi('quality', controller, observed), (error) => error === reason);
    assert.deepEqual(observed.calls, []);
  }
});

const withDirectory = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const temporary = fileURLToPath(new URL('../.tmp/', import.meta.url));
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'ci-command-test-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

const waitForGroupStopped = async (pid: number): Promise<void> => {
  const deadline = performance.now() + 3_000;
  while (performance.now() < deadline) {
    try { if (isGroupStopped(pid)) return; }
    catch (error) {
      // macOS may report EPERM while the last group member exits; only ESRCH proves absence.
      if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
    }
    await delay(10);
  }
  requireGroupStopped(pid);
};

test('CI cleanup waits through transient EPERM until the group is absent', { skip: !['linux', 'darwin'].includes(process.platform) }, async (context) => {
  const results = ['EPERM', 'alive', 'ESRCH'];
  let observedAbsent = false;
  context.mock.method(process, 'kill', () => {
    const result = results.shift() ?? 'ESRCH';
    if (result === 'alive') return true;
    if (result === 'ESRCH') observedAbsent = true;
    throw Object.assign(new Error(`kill ${result}`), { code: result });
  });
  await waitForGroupStopped(42);
  assert.equal(observedAbsent, true);
});

test('CI cleanup fails persistent EPERM at its original deadline', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 15_000 }, async (context) => {
  const failure = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  context.mock.method(process, 'kill', () => { throw failure; });
  const started = performance.now();
  await assert.rejects(waitForGroupStopped(42), (error) => error === failure);
  assert.ok(performance.now() - started >= 3_000, 'EPERM must remain unresolved until the cleanup deadline.');
});

test('CI cleanup preserves errors other than EPERM', { skip: !['linux', 'darwin'].includes(process.platform) }, async (context) => {
  const failure = Object.assign(new Error('kill EINVAL'), { code: 'EINVAL' });
  context.mock.method(process, 'kill', () => { throw failure; });
  await assert.rejects(waitForGroupStopped(42), (error) => error === failure);
});

test('CI import is inert and its entrypoint rejects missing or unknown modes before commands', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  await withDirectory(async (cwd) => {
    const bin = join(cwd, 'bin');
    const log = join(cwd, 'commands.log');
    await mkdir(bin);
    await writeFile(log, '');
    await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nprintf called >> "$DAYNIGHT_CI_TEST_COMMAND_LOG"\nexit 91\n', { mode: 0o755 });
    const env = { ...process.env, PATH: bin, DAYNIGHT_CI_TEST_COMMAND_LOG: log };
    const module = new URL('./ci.mts', import.meta.url);
    const imported = await commandBytes(process.execPath, ['--input-type=module', '-e', `
      const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
      const { runCi } = await import(${JSON.stringify(module.href)});
      if (typeof runCi !== 'function') throw new Error('CI operation is unavailable.');
      console.log(JSON.stringify({before,after:[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')]}));
    `], { cwd, env, timeoutMs: 5_000 });
    assert.equal(imported.exitCode, 0, imported.stderr.toString());
    const listeners = JSON.parse(imported.stdout.toString()) as { before: number[]; after: number[] };
    assert.deepEqual(listeners.after, listeners.before);
    for (const args of [[], ['unknown'], ['quality', 'extra'], ['quality', '--shard=1/2'], ['browser', '--shard=3/2'], ['browser', '--skip-auth']]) {
      const result = await commandBytes(process.execPath, [fileURLToPath(module), ...args], { cwd, env, timeoutMs: 5_000 });
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr.toString(), /Usage:.*quality/);
    }
    assert.equal(await readFile(log, 'utf8'), '');
  });
});

test('CI commands retain bounded capture and terminate cancelled or timed-out groups', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  await withDirectory(async (cwd) => {
    let child: ChildProcess | undefined;
    await assert.rejects(runCiCommand(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(8*1024*1024+1))'], {
      cwd, quiet: true, onSpawn: (spawned) => { child = spawned; },
    }), /bounded output/);
    requireGroupStopped(child!.pid!);
    for (const cancelled of [false, true]) {
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const pending = runCiCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        cwd, quiet: true, signal: controller.signal, timeoutMs: cancelled ? 5_000 : 100,
        onSpawn: (spawned) => { child = spawned; started.resolve(); },
      });
      await started.promise;
      if (cancelled) controller.abort(new Error('CI command cancelled'));
      await assert.rejects(pending, cancelled ? /cancelled/ : /timed out/);
      assert.equal(await processIdentity(child!.pid!), null);
      requireGroupStopped(child!.pid!);
    }
  });
});

test('CI commands reject a successful leader with a surviving redirected child and retain combined failures', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 15_000 }, async () => {
  await withDirectory(async (cwd) => {
    for (const exitCode of [0, 3]) {
      let child: ChildProcess | undefined;
      const ledger = join(cwd, `child-${exitCode}.json`);
      const source = `
        const { spawn } = await import('node:child_process');
        const { writeFile } = await import('node:fs/promises');
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
        await writeFile(process.argv[1], JSON.stringify({pid:child.pid}));
        child.unref();
        process.exitCode = ${exitCode};
      `;
      try {
        await assert.rejects(runCiCommand(process.execPath, ['--input-type=module', '-e', source, ledger], {
          cwd, quiet: true, timeoutMs: 5_000, onSpawn: (spawned) => { child = spawned; },
        }), (error) => {
          if (exitCode === 0) return error instanceof Error && /process group is still running/.test(error.message);
          assert.ok(error instanceof AggregateError);
          assert.match(error.errors[0].message, /exit=3/);
          assert.match(error.errors[1].message, /process group is still running/);
          assert.equal(error.cause, error.errors[0]);
          return true;
        });
        assert.notEqual(child?.pid, undefined);
        assert.equal(isGroupStopped(child!.pid!), false);
      } finally {
        if (child?.pid !== undefined && !isGroupStopped(child.pid)) {
          terminateGroup(child, 'SIGTERM');
          await waitForGroupStopped(child.pid);
        }
      }
    }
  });
});
