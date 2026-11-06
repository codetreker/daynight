import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { browserConfigs, runBrowser, runBrowserCommand } from './browser.mts';
import { processIdentity, requireGroupStopped, sameProcess } from './validation/identity.mts';

test('browser entry runs every module configuration once, in sequence', async () => {
  const names = (await readdir(new URL('../tests/navigation/', import.meta.url)))
    .filter(name => name === 'playwright.config.ts' || name.endsWith('-playwright.config.ts'));
  assert.deepEqual([...browserConfigs].sort(), names.sort());
  const calls: string[] = [];
  const controller = new AbortController();
  await runBrowser(controller, { command: async (file, args, options) => {
    assert.equal(file, process.execPath);
    assert.equal(args[0], fileURLToPath(import.meta.resolve('@playwright/test/cli')));
    assert.deepEqual(args.slice(1, 3), ['test', '--config']);
    assert.equal(options.cwd, fileURLToPath(new URL('../', import.meta.url)));
    assert.equal(options.signal, controller.signal);
    assert.equal(options.timeoutMs, 1_800_000);
    calls.push(args[3]!);
    return '';
  } });
  assert.deepEqual(calls, browserConfigs.map(name => `tests/navigation/${name}`));
});

test('browser entry propagates a failure and does not start later suites', async () => {
  const failure = new Error('browser failed');
  let calls = 0;
  await assert.rejects(runBrowser(new AbortController(), { command: async () => {
    if (++calls === 2) throw failure;
    return '';
  } }), error => error === failure);
  assert.equal(calls, 2);
});

test('browser entry stops before starting another suite after cancellation', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  let calls = 0;
  await assert.rejects(runBrowser(controller, { command: async () => {
    calls++;
    controller.abort(reason);
    return '';
  } }), error => error === reason);
  assert.equal(calls, 1);
});

test('cancellation drains the running browser command group', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 10_000 }, async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let child: ChildProcess | undefined;
  const pending = runBrowser(controller, { command: async (_file, _args, options) => await runBrowserCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    ...options, quiet: true, onSpawn: spawned => { child = spawned; started.resolve(); },
  }) });
  await started.promise;
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.notEqual(child?.pid, undefined);
  requireGroupStopped(child!.pid!);
});

test('browser command reports its timeout', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 10_000 }, async () => {
  await assert.rejects(runBrowserCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), timeoutMs: 100, quiet: true,
  }), /timed out/);
});

test('cancellation stops a descendant in a separate process group', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 15_000 }, async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<number>();
  const source = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref(); console.log(child.pid); setInterval(() => {}, 1000);
  `;
  const pending = runBrowserCommand(process.execPath, ['-e', source], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), signal: controller.signal, timeoutMs: 10_000,
    quiet: true, onOutput: chunk => started.resolve(Number(chunk.trim())),
  });
  const pid = await started.promise;
  assert.ok(pid > 1);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(await processIdentity(pid), null);
});

test('a failed command also stops a detached descendant', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 15_000 }, async () => {
  let pid = 0;
  const source = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref(); console.log(child.pid); process.exitCode = 3;
  `;
  await assert.rejects(runBrowserCommand(process.execPath, ['-e', source], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), timeoutMs: 10_000,
    quiet: true, onOutput: chunk => { pid = Number(chunk.trim()); },
  }), /exit=3/);
  assert.ok(pid > 1);
  assert.equal(await processIdentity(pid), null);
});

test('a process retaining the browser profile cannot silently outlive a successful command', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 15_000 }, async () => {
  let pid = 0;
  const source = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--user-data-dir=' + require('node:path').join(process.env.TMPDIR, 'profile')], { detached: true, stdio: 'ignore', env: {} });
    child.unref(); console.log(child.pid);
  `;
  await assert.rejects(runBrowserCommand(process.execPath, ['-e', source], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), timeoutMs: 10_000,
    quiet: true, onOutput: chunk => { pid = Number(chunk.trim()); },
  }), /profile survived Playwright/);
  assert.ok(pid > 1);
  assert.equal(await processIdentity(pid), null);
});

test('a matching relative profile under another working directory is not owned', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 15_000 }, async () => {
  let pid = 0;
  const source = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--user-data-dir=' + require('node:path').join(process.env.TMPDIR, 'profile')], { detached: true, cwd: '/', stdio: 'ignore', env: {} });
    child.unref(); console.log(child.pid);
  `;
  try {
    await runBrowserCommand(process.execPath, ['-e', source], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), timeoutMs: 10_000,
      quiet: true, onOutput: chunk => { pid = Number(chunk.trim()); },
    });
    assert.ok(pid > 1); assert.notEqual(await processIdentity(pid), null);
  } finally {
    if (pid > 1) {
      const identity = await processIdentity(pid);
      if (identity !== null && identity.group === pid && sameProcess(identity, await processIdentity(pid))) process.kill(-pid, 'SIGKILL');
      const deadline = performance.now() + 3_000;
      while (await processIdentity(pid) !== null && performance.now() < deadline) await delay(20);
      assert.equal(await processIdentity(pid), null);
    }
  }
});

test('forced timeout still cleans an unmarked process using the browser profile', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 15_000 }, async () => {
  let pid = 0;
  let temporary = '';
  const source = `
    process.on('SIGINT', () => {});
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--user-data-dir=' + require('node:path').join(process.env.TMPDIR, 'profile')], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: {} });
    child.unref(); console.log(JSON.stringify({pid:child.pid,temporary:process.env.TMPDIR})); setInterval(() => {}, 1000);
  `;
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  try {
    await assert.rejects(runBrowserCommand(process.execPath, ['-e', source], {
      cwd, timeoutMs: 200,
      quiet: true, onOutput: chunk => { ({ pid, temporary } = JSON.parse(chunk.trim()) as { pid: number; temporary: string }); },
    }), /Browser command and cleanup failed/);
    assert.ok(pid > 1);
    assert.equal(await processIdentity(pid), null);
    assert.equal((await stat(path.resolve(cwd, temporary))).isDirectory(), true);
  } finally { if (temporary.startsWith('.tmp/browser-run-')) await rm(path.resolve(cwd, temporary), { recursive: true, force: true }); }
});

test('marker cleanup failure does not prevent independent browser profile cleanup', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 15_000 }, async () => {
  let pid = 0;
  let markedPid = 0;
  let temporary = '';
  const source = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--user-data-dir=' + require('node:path').join(process.env.TMPDIR, 'profile')], { detached: true, stdio: 'ignore', env: {} });
    const marked = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref(); marked.unref(); console.log(JSON.stringify({pid:child.pid,markedPid:marked.pid,temporary:process.env.TMPDIR}));
  `;
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  try {
    await assert.rejects(runBrowserCommand(process.execPath, ['-e', source], {
      cwd, timeoutMs: 10_000,
      quiet: true, onOutput: chunk => { ({ pid, markedPid, temporary } = JSON.parse(chunk.trim()) as { pid: number; markedPid: number; temporary: string }); },
    }, { stopOwned: async () => { throw new Error('marker discovery failed'); } }), error => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors[0] instanceof AggregateError);
      assert.match(String(error.errors[0].errors[0]), /marker discovery failed/);
      assert.match(String(error.errors[0].errors[1]), /profile survived Playwright/);
      assert.match(String(error.errors[1]), /directory retained/);
      return true;
    });
    assert.ok(pid > 1);
    assert.equal(await processIdentity(pid), null);
    assert.notEqual(await processIdentity(markedPid), null);
    assert.equal((await stat(path.resolve(cwd, temporary))).isDirectory(), true);
  } finally {
    if (markedPid > 1) {
      const identity = await processIdentity(markedPid);
      if (identity !== null && identity.group === markedPid && sameProcess(identity, await processIdentity(markedPid))) process.kill(-markedPid, 'SIGKILL');
      const deadline = performance.now() + 3_000;
      while (await processIdentity(markedPid) !== null && performance.now() < deadline) await delay(20);
      assert.equal(await processIdentity(markedPid), null);
    }
    if (temporary.startsWith('.tmp/browser-run-')) await rm(path.resolve(cwd, temporary), { recursive: true, force: true });
  }
});

test('forced termination retains the directory when detached descendants are unverified', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 15_000 }, async () => {
  let pid = 0, temporary = '';
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const source = `
    process.on('SIGINT', () => {}); const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, cwd: process.env.TMPDIR, stdio: 'ignore', env: {} });
    child.unref(); console.log(JSON.stringify({pid:child.pid,temporary:process.env.TMPDIR})); setInterval(() => {}, 1000);
  `;
  try {
    await assert.rejects(runBrowserCommand(process.execPath, ['-e', source], {
      cwd, timeoutMs: 200, quiet: true,
      onOutput: chunk => { ({ pid, temporary } = JSON.parse(chunk.trim()) as { pid: number; temporary: string }); },
    }), /Browser command and cleanup failed/);
    assert.ok(pid > 1); assert.notEqual(await processIdentity(pid), null);
    assert.equal((await stat(path.resolve(cwd, temporary))).isDirectory(), true);
  } finally {
    if (pid > 1) {
      const identity = await processIdentity(pid);
      if (identity !== null && identity.group === pid && sameProcess(identity, await processIdentity(pid))) process.kill(-pid, 'SIGKILL');
      const deadline = performance.now() + 3_000;
      while (await processIdentity(pid) !== null && performance.now() < deadline) await delay(20);
      assert.equal(await processIdentity(pid), null);
    }
    if (temporary.startsWith('.tmp/browser-run-')) await rm(path.resolve(cwd, temporary), { recursive: true, force: true });
  }
});

test('a surviving browser profile leader and its unmarked group members are stopped', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 15_000 }, async () => {
  let leader = 0, member = 0;
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const source = `
    const { spawn } = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path');
    const ledger = path.join(process.env.TMPDIR, 'leader-ready'); const ready = path.join(process.env.TMPDIR, 'member-ready');
    const memberSource = 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)';
    const leaderSource = 'const fs=require("node:fs"),{spawn}=require("node:child_process");const c=spawn(process.execPath,["-e",process.argv[3],process.argv[2]],{stdio:"ignore",env:{}});setInterval(()=>{if(fs.existsSync(process.argv[2]))fs.writeFileSync(process.argv[1],String(c.pid))},10)';
    const child = spawn(process.execPath, ['-e', leaderSource, ledger, ready, memberSource, '--user-data-dir=' + path.join(process.env.TMPDIR, 'profile')], { detached: true, stdio: 'ignore', env: {} });
    child.unref(); const timer=setInterval(()=>{if(fs.existsSync(ledger)){clearInterval(timer);console.log(child.pid+':'+fs.readFileSync(ledger,'utf8'));}},10);
  `;
  try {
    await assert.rejects(runBrowserCommand(process.execPath, ['-e', source], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), timeoutMs: 10_000,
      quiet: true, onOutput: chunk => { [leader, member] = chunk.trim().split(':').map(Number) as [number, number]; },
    }), /profile survived Playwright/);
    assert.ok(leader > 1 && member > 1);
    assert.equal(await processIdentity(leader), null);
    assert.equal(await processIdentity(member), null);
    assert.notEqual(await processIdentity(unrelated.pid!), null);
  } finally {
    if (unrelated.exitCode === null && unrelated.signalCode === null) {
      const closed = new Promise<void>(resolve => unrelated.once('close', () => resolve()));
      unrelated.kill('SIGKILL'); await closed;
    }
  }
});
