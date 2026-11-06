import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as identity from './identity.mts';

const supported = process.platform === 'linux' || process.platform === 'darwin';
const execute = promisify(execFile);
const start = async (args: string[], environment: NodeJS.ProcessEnv = {}): Promise<ChildProcess> => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)', '--', ...args], {
    detached: true, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  await once(child.stdout!, 'data');
  return child;
};
const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
};

test('native identity includes precise stable platform/start identity and detached group', { skip: !supported }, async () => {
  const child = await start([]);
  try {
    const first = await identity.processIdentity(child.pid!);
    assert.ok(first);
    assert.equal((first as identity.ProcessIdentity & { platform: string }).platform, process.platform);
    assert.match(first.startTicks, /^\d+$/);
    if (process.platform === 'darwin') assert.ok(BigInt(first.startTicks) > 1_000_000_000_000_000n);
    assert.equal(first.group, child.pid);
    assert.equal(identity.sameProcess(first, await identity.processIdentity(child.pid!)), true);
    assert.equal(identity.sameProcess({ ...first, group: first.group + 1 }, first), false);
    assert.equal(identity.sameProcess({ ...first, platform: 'other' } as unknown as identity.ProcessIdentity, first), false);
    await assert.rejects(identity.requireStopped(first), /still running/);
    assert.equal(identity.isGroupStopped(first.group), false);
    assert.throws(() => identity.requireGroupStopped(first.group), /still running/);
    await stop(child);
    assert.equal(await identity.processIdentity(first.pid), null);
    await identity.requireStopped(first);
    assert.equal(identity.isGroupStopped(first.group), true);
    identity.requireGroupStopped(first.group);
    identity.requireGroupStopped(first.group + 10_000_000);
  } finally { await stop(child); }
});

test('macOS inspection treats a waitable exited child as absent even while kill zero succeeds', {
  skip: process.platform !== 'darwin', timeout: 45_000,
}, async () => {
  const root = fileURLToPath(new URL('../../../../.tmp/', import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'process-zombie-test-'));
  let fixture: ChildProcess | undefined;
  let closed: Promise<unknown> | undefined;
  try {
    const executable = join(directory, 'zombie-fixture');
    await execute('/usr/bin/xcrun', ['clang', '-Wall', '-Wextra', '-Werror', fileURLToPath(new URL('./process-zombie.fixture.c', import.meta.url)), '-o', executable], { timeout: 30_000 });
    fixture = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    closed = once(fixture, 'exit');
    const [output] = await Promise.race([
      once(fixture.stdout!, 'data'),
      closed.then(() => { throw new Error('The zombie fixture exited before recording its waitable child.'); }),
    ]);
    const state = JSON.parse(String(output)) as { pid: number; inspectionCount: number; inspectionError: number; signalResult: number };
    assert.equal(state.inspectionCount, 0);
    assert.equal(state.inspectionError, 3, 'Darwin ESRCH excludes the waitable child from the default libproc query');
    assert.equal(state.signalResult, 0, 'kill zero still succeeds for the waitable child');
    assert.equal(await identity.processIdentity(state.pid), null);
    assert.equal(await identity.processArguments(state.pid), null);
  } finally {
    fixture?.stdin!.end();
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});

test('macOS inspection waits for confirmed exit during path or argument reads and preserves live refusals', {
  skip: process.platform !== 'darwin', timeout: 45_000,
}, async () => {
  const root = fileURLToPath(new URL('../../../../.tmp/', import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'process-boundary-test-'));
  try {
    const executable = join(directory, 'boundary-fixture');
    await execute('/usr/bin/xcrun', ['clang', '-Wall', '-Wextra', '-Werror', fileURLToPath(new URL('./process-darwin-boundary.fixture.c', import.meta.url)), '-o', executable], { timeout: 30_000 });
    assert.equal((await execute(executable, ['path-exit'], { timeout: 10_000 })).stdout.trim(), 'null');
    assert.equal((await execute(executable, ['args-exit-completes'], { timeout: 10_000 })).stdout.trim(), 'null');
    assert.equal((await execute(executable, ['args-exit-completes', 'EIO'], { timeout: 10_000 })).stdout.trim(), 'null');
    for (const scenario of ['path-permission', 'bsd-permission', 'bsd-short-read', 'identity-change']) {
      await assert.rejects(execute(executable, [scenario], { timeout: 10_000 }), (error: unknown) => {
        const result = error as { code: number; stderr: string };
        assert.equal(result.code, 1);
        assert.match(result.stderr, /Cannot (read|identify)/);
        if (scenario.endsWith('permission')) assert.match(result.stderr, /errno 1/);
        return true;
      });
    }
    for (const scenario of ['args-permission', 'args-live-invalid', 'args-exit-persistent', 'args-exit-pid-change', 'args-exit-identity-change', 'args-exit-group-change']) {
      for (const extra of [[], ['EIO']]) await assert.rejects(execute(executable, [scenario, ...extra], { timeout: 10_000 }), (error: unknown) => {
        const result = error as { code: number; stderr: string };
        assert.equal(result.code, 1);
        assert.match(result.stderr, /Cannot (read|identify)/);
        assert.match(result.stderr, scenario === 'args-permission' ? /errno 1/ : extra.length === 0 ? /errno 22/ : /errno 5/);
        return true;
      });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native argv keeps spaces, empty arguments, Unicode and exact profile argument boundaries', { skip: !supported }, async () => {
  const args = ['argument with spaces', '', '附件 空间', '--user-data-dir=/tmp/profile with spaces'];
  const child = await start(args);
  try {
    assert.equal(typeof (identity as Record<string, unknown>).processArguments, 'function', 'processArguments API is required');
    const observed = await (identity as typeof identity & { processArguments(pid: number): Promise<string[] | null> }).processArguments(child.pid!);
    assert.deepEqual(observed?.slice(-args.length), args);
    await stop(child);
    assert.equal(await (identity as typeof identity & { processArguments(pid: number): Promise<string[] | null> }).processArguments(child.pid!), null);
  } finally { await stop(child); }
});

test('native environment discovery matches every complete marker and preserves unrelated processes', { skip: !supported }, async () => {
  const marker = randomUUID();
  const matching = await start([], { DAYNIGHT_PROCESS_TEST: marker, DAYNIGHT_PROCESS_ROLE: 'owned role' });
  const prefix = await start([], { DAYNIGHT_PROCESS_TEST: `${marker}-other`, DAYNIGHT_PROCESS_ROLE: 'owned role' });
  const different = await start([], { DAYNIGHT_PROCESS_TEST: marker, DAYNIGHT_PROCESS_ROLE: 'other role' });
  try {
    assert.equal(typeof (identity as Record<string, unknown>).findProcesses, 'function', 'findProcesses API is required');
    const find = (identity as typeof identity & { findProcesses(environment: Record<string, string>): Promise<identity.ProcessIdentity[]> }).findProcesses;
    const found = await find({ DAYNIGHT_PROCESS_TEST: marker, DAYNIGHT_PROCESS_ROLE: 'owned role' });
    assert.deepEqual(found.map((entry) => entry.pid), [matching.pid]);
    await assert.rejects(find({}), /marker|environment/i);
    await assert.rejects(find({ 'INVALID=KEY': marker }), /marker|environment/i);
    await stop(matching);
    assert.deepEqual(await find({ DAYNIGHT_PROCESS_TEST: marker, DAYNIGHT_PROCESS_ROLE: 'owned role' }), []);
    assert.ok(await identity.processIdentity(prefix.pid!));
    assert.ok(await identity.processIdentity(different.pid!));
  } finally { await Promise.all([stop(matching), stop(prefix), stop(different)]); }
});

test('Linux discovery tolerates an unreadable unrelated environment while registered ownership fails closed', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0,
}, async (context) => {
  const { readFile } = await import('node:fs/promises');
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); process.stdin.once("data",()=>{process.seteuid(1);process.seteuid(0);process.stdout.write("hidden")});setInterval(()=>{},1000)'], {
    detached: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  try {
    await once(child.stdout!, 'data');
    const owner = await identity.processIdentity(child.pid!);
    assert.ok(owner);
    const hidden = once(child.stdout!, 'data'); child.stdin!.write('hide'); await hidden;
    try {
      await readFile(`/proc/${child.pid}/environ`);
      context.skip('Host privileges permit nondumpable environment access.');
      return;
    } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'EACCES'); }
    assert.deepEqual(await identity.findProcesses({ DAYNIGHT_PROCESS_TEST: randomUUID() }), []);
    await assert.rejects(identity.processIdentity(child.pid!), { code: 'EACCES' });
    await assert.rejects(identity.requireStopped(owner), { code: 'EACCES' });
  } finally { await stop(child); }
});
