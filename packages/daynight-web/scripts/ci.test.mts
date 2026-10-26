import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCi, runCiCommand } from './ci.mts';
import { isGroupStopped, processIdentity, requireGroupStopped } from './acceptance/identity.mts';
import { commandBytes, terminateGroup, type CommandOptions } from './acceptance/process.mts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const operations = () => {
  const calls: { file: string; args: readonly string[]; options: CommandOptions }[] = [];
  const accepted: AbortController[] = [];
  return { calls, accepted, command: async (file: string, args: readonly string[], options: CommandOptions) => {
    calls.push({ file, args, options }); return '';
  }, acceptance: async (controller: AbortController) => { accepted.push(controller); } };
};

test('quality mode runs the full harness and coverage with their original bounds and worker limit', async () => {
  const observed = operations();
  const controller = new AbortController();
  await runCi('quality', controller, observed);
  assert.deepEqual(observed.calls.map(({ file, args }) => [file, args]), [
    ['pnpm', ['--filter', '@codetreker/daynight-web', 'test:harness']],
    ['pnpm', ['--filter', '@codetreker/daynight-web', 'test:coverage']],
  ]);
  for (const call of observed.calls) {
    assert.equal(call.options.timeoutMs, 180_000);
    assert.equal(call.options.cwd, repositoryRoot);
    assert.equal(call.options.signal, controller.signal);
  }
  assert.equal(observed.calls[1]!.options.env!.VITEST_MAX_WORKERS, '2');
  assert.deepEqual(observed.accepted, []);
});

test('browser mode installs its browser with the original bound before ordinary acceptance', async () => {
  const observed = operations();
  const controller = new AbortController();
  const installing = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  observed.command = async (file, args, options) => {
    observed.calls.push({ file, args, options }); started.resolve(); return await installing.promise;
  };
  const pending = runCi('browser', controller, observed);
  await started.promise;
  assert.deepEqual(observed.accepted, []);
  installing.resolve('installed');
  await pending;
  assert.equal(observed.calls.length, 1);
  assert.deepEqual(observed.calls[0]!.args, ['--filter', '@codetreker/daynight-web', 'exec', 'playwright', 'install', '--with-deps', 'chromium']);
  assert.equal(observed.calls[0]!.options.timeoutMs, 600_000);
  assert.equal(observed.calls[0]!.options.signal, controller.signal);
  assert.deepEqual(observed.accepted, [controller]);
});

test('invalid CI modes start no command or acceptance', async () => {
  for (const mode of ['', 'unknown', 'coverage', 'quality browser']) {
    const observed = operations();
    await assert.rejects(runCi(mode, new AbortController(), observed), /Usage:.*<quality\|browser>/);
    assert.deepEqual(observed.calls, []);
    assert.deepEqual(observed.accepted, []);
  }
});

test('command failures retain the original error and prevent later verification work', async () => {
  for (const { mode, failingCommand } of [{ mode: 'quality', failingCommand: 1 }, { mode: 'quality', failingCommand: 2 }, { mode: 'browser', failingCommand: 1 }]) {
    const observed = operations();
    const failure = new Error(`${mode} command failed`);
    observed.command = async (file, args, options) => {
      observed.calls.push({ file, args, options });
      if (observed.calls.length === failingCommand) throw failure;
      return '';
    };
    await assert.rejects(runCi(mode, new AbortController(), observed), (error) => error === failure);
    assert.equal(observed.calls.length, failingCommand);
    assert.deepEqual(observed.accepted, []);
  }
});

test('browser acceptance failure remains a failed CI operation', async () => {
  const observed = operations();
  const failure = new Error('Browser acceptance failed');
  observed.acceptance = async () => { throw failure; };
  await assert.rejects(runCi('browser', new AbortController(), observed), (error) => error === failure);
  assert.equal(observed.calls.length, 1);
});

test('cancellation prevents new commands and acceptance after a completed command', async () => {
  for (const mode of ['quality', 'browser']) {
    const observed = operations();
    const controller = new AbortController();
    const reason = new Error('CI cancelled');
    observed.command = async (file, args, options) => {
      observed.calls.push({ file, args, options }); controller.abort(reason); return '';
    };
    await assert.rejects(runCi(mode, controller, observed), (error) => error === reason);
    assert.equal(observed.calls.length, 1);
    assert.deepEqual(observed.accepted, []);
    observed.calls.length = 0;
    await assert.rejects(runCi(mode, controller, observed), (error) => error === reason);
    assert.deepEqual(observed.calls, []);
  }
});

const withDirectory = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const temporary = fileURLToPath(new URL('../.tmp/', import.meta.url));
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'ci-command-test-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

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
    for (const args of [[], ['unknown'], ['quality', 'extra']]) {
      const result = await commandBytes(process.execPath, [fileURLToPath(module), ...args], { cwd, env, timeoutMs: 5_000 });
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr.toString(), /Usage:.*<quality\|browser>/);
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
          const deadline = performance.now() + 3_000;
          while (!isGroupStopped(child.pid) && performance.now() < deadline) await delay(10);
          requireGroupStopped(child.pid);
        }
      }
    }
  });
});

test('Web quality and browser jobs retain independent guards and both feed the required aggregator', async () => {
  const lines = (await readFile(new URL('../../../.github/workflows/checks.yml', import.meta.url), 'utf8')).split(/\r?\n/);
  const jobs = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines) {
    const job = /^  ([\w-]+):\s*$/.exec(line);
    if (job !== null) { current = []; jobs.set(job[1]!, current); }
    else current?.push(line);
  }
  const quality = jobs.get('verify-web-quality')!.join('\n');
  const browser = jobs.get('verify-web')!.join('\n');
  for (const job of [quality, browser]) {
    assert.match(job, /^    needs: detect-changes$/m);
    assert.match(job, /^    timeout-minutes: 20$/m);
    assert.match(job, /^    if: \$\{\{ needs\.detect-changes\.outputs\.web == 'true' \}\}$/m);
  }
  assert.match(quality, /scripts\/ci\.mts quality/);
  assert.match(quality, /daynight-web-coverage/);
  assert.doesNotMatch(quality, /web:acceptance|setup-go|attachments\.mts/);
  assert.match(browser, /scripts\/ci\.mts browser/);
  assert.match(browser, /acceptance\.mts --cleanup/);
  assert.match(browser, /tests\/attachments\.mts/);
  assert.doesNotMatch(browser, /daynight-web-coverage/);
  const aggregate = jobs.get('checks')!.join('\n');
  const needed = /^    needs: \[([^\]]+)\]$/m.exec(aggregate)![1]!.split(',').map((name) => name.trim());
  assert.ok(needed.includes('verify-web-quality'));
  assert.ok(needed.includes('verify-web'));
  assert.match(aggregate, /all\(\.\[\]; \. == "success" or \. == "skipped"\)/);
});
