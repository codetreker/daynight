import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { isGroupStopped, processIdentity, requireGroupStopped, requireStopped, sameProcess } from './identity.mts';

test('native identity records executable and start time and rejects an active owner', async () => {
  const identity = await processIdentity(process.pid);
  assert.notEqual(identity, null);
  assert.ok(sameProcess(identity!, identity));
  assert.equal(sameProcess({ ...identity!, startTicks: '0' }, identity), false);
  await assert.rejects(requireStopped(identity!), /still running/);
  await assert.rejects(requireStopped({ ...identity!, executable: '/different-executable' }), /still running/);
});
test('invalid process identities fail before process operations', async () => {
  for (const pid of [0, 1, -1, 1.5, NaN]) {
    await assert.rejects(processIdentity(pid));
    assert.throws(() => isGroupStopped(pid));
    assert.throws(() => requireGroupStopped(pid));
  }
});

test('a process disappearing after its stat file opens is absent', { skip: process.platform !== 'linux' }, async (context) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const readFile = fs.readFile;
  let observedCode: unknown;
  const read = context.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] !== `/proc/${child.pid}/stat`) return await readFile(...args);
    const handle = await fs.open(args[0], 'r');
    try {
      child.kill('SIGTERM');
      await exited;
      return await handle.readFile('utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error) observedCode = error.code;
      throw error;
    } finally { await handle.close(); }
  });
  syncBuiltinESMExports();
  try {
    await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
    assert.equal(await processIdentity(child.pid!), null);
    assert.equal(observedCode, 'ESRCH');
  } finally {
    read.mock.restore();
    syncBuiltinESMExports();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});

test('Linux identity preserves filesystem failures other than process absence', { skip: process.platform !== 'linux' }, async (context) => {
  const failure = Object.assign(new Error('Cannot read process identity.'), { code: 'EACCES' });
  const read = context.mock.method(fs, 'readFile', async () => { throw failure; });
  syncBuiltinESMExports();
  try { await assert.rejects(processIdentity(process.pid), (error) => error === failure); }
  finally { read.mock.restore(); syncBuiltinESMExports(); }
});

test('process-group absence requires ESRCH and preserves other probe failures', (context) => {
  const gone = Object.assign(new Error('Group is absent.'), { code: 'ESRCH' });
  const denied = Object.assign(new Error('Group is inaccessible.'), { code: 'EPERM' });
  let failure: Error | undefined;
  const kill = context.mock.method(process, 'kill', () => { if (failure !== undefined) throw failure; return true; });
  assert.equal(isGroupStopped(42), false);
  failure = gone;
  assert.equal(isGroupStopped(42), true);
  failure = denied;
  assert.throws(() => isGroupStopped(42), (error) => error === denied);
  assert.throws(() => requireGroupStopped(42), (error) => error === denied);
  assert.deepEqual(kill.mock.calls.map(({ arguments: args }) => args), [[-42, 0], [-42, 0], [-42, 0], [-42, 0]]);
});
