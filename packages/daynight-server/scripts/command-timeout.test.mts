import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { signalCommandGroup } from './command-process-group.mts';

const script = fileURLToPath(new URL('./command-timeout.mts', import.meta.url));
const run = (source: string, duration = 5000) => spawnSync(process.execPath,
  [script, String(duration), '100', process.execPath, '-e', source], { encoding: 'utf8', timeout: 10000 });
const stopped = (pid: number): boolean => {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
  assert.ifError(result.error);
  return result.status === 1 || (result.status === 0 && result.stdout.trim().startsWith('Z'));
};
const ready = async (child: ChildProcess): Promise<string> => {
  let output = '';
  const deadline = AbortSignal.timeout(5000);
  while (!output.includes('ready\n')) {
    const [chunk] = await once(child.stdout!, 'data', { signal: deadline });
    output += chunk.toString();
  }
  return output;
};
const cleanup = (t: TestContext, child: ChildProcess, closed: Promise<unknown>, pids: number[]): void => {
  t.after(async () => {
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
  });
};

test('Darwin EPERM accepts only a complete observation of a stopped process group', (t) => {
  const uid = process.getuid!();
  const denied = Object.assign(new Error('permission denied'), { code: 'EPERM' });
  t.mock.method(process, 'kill', () => { throw denied; });
  const read = t.mock.method(childProcess, 'spawnSync');
  const observed = (members: string) => ({
    pid: 900, status: 0, signal: null, error: undefined,
    // macOS ps has effective UID 0; unrelated exiting processes can show '?'.
    stdout: `1 1 0 Ss\n900 800 0 R\n901 801 ${uid} ?s\n${members}`, stderr: '',
  });
  for (const members of [`700 600 ${uid} Z\n`, '']) {
    read.mock.mockImplementation(() => observed(members));
    assert.doesNotThrow(() => signalCommandGroup(600, 'SIGKILL', 'darwin'));
  }
  for (const members of [
    ...['I', 'R', 'S', 'T', 'U'].map(state => `700 600 ${uid} ${state}\n`),
    `700 600 ${uid} Z\n701 600 ${uid} S\n`,
    `700 600 ${uid + 1} Z\n`,
  ]) {
    read.mock.mockImplementation(() => observed(members));
    assert.throws(() => signalCommandGroup(600, 'SIGKILL', 'darwin'), error => error === denied);
  }
  const complete = observed(`700 600 ${uid} Z\n`);
  for (const invalid of [
    { ...complete, status: 1 }, { ...complete, signal: 'SIGKILL' },
    { ...complete, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
    { ...complete, error: Object.assign(new Error('output limit'), { code: 'ENOBUFS' }) },
    { ...complete, stderr: 'partial observation' }, { ...complete, pid: undefined },
    { ...complete, stdout: complete.stdout.replace('900 800 0 R', '900 800 0 ?') },
    { ...complete, stdout: '' }, { ...complete, stdout: `700 600 ${uid} Z\n` },
    { ...complete, stdout: complete.stdout.trimEnd() },
    { ...complete, stdout: complete.stdout + 'incomplete row\n' },
    { ...complete, stdout: complete.stdout + `700 600 ${uid} Z\n` },
    { ...complete, stdout: complete.stdout + `701 600 ${uid} ?\n` },
    { ...complete, stdout: complete.stdout + `-1 600 ${uid} Z\n` },
  ]) {
    read.mock.mockImplementation(() => invalid);
    assert.throws(() => signalCommandGroup(600, 'SIGKILL', 'darwin'), error => error === denied);
  }
  read.mock.mockImplementation(() => { throw new Error('unable to launch ps'); });
  assert.throws(() => signalCommandGroup(600, 'SIGKILL', 'darwin'), error => error === denied);
  for (const call of read.mock.calls) {
    assert.deepEqual(call.arguments, ['/bin/ps', ['-axo', 'pid=,pgid=,uid=,stat='], {
      encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    }]);
  }
});

test('process group signals retain success and permission failures outside Darwin EPERM', (t) => {
  const kill = t.mock.method(process, 'kill', () => true);
  const read = t.mock.method(childProcess, 'spawnSync', () => { throw new Error('unexpected observation'); });
  signalCommandGroup(600, 'SIGTERM', 'darwin');
  assert.deepEqual(kill.mock.calls[0]!.arguments, [-600, 'SIGTERM']);
  for (const code of ['ESRCH', 'EPERM', 'EACCES']) {
    const failure = Object.assign(new Error(code), { code });
    kill.mock.mockImplementation(() => { throw failure; });
    for (const platform of ['darwin', 'linux'] as const) {
      if (code === 'EPERM' && platform === 'darwin') continue;
      if (code === 'ESRCH') assert.doesNotThrow(() => signalCommandGroup(600, 'SIGKILL', platform));
      else assert.throws(() => signalCommandGroup(600, 'SIGKILL', platform), error => error === failure);
    }
  }
  assert.equal(read.mock.callCount(), 0);
});

test('bounded command preserves output and ordinary exit status', () => {
  for (const code of [0, 17]) {
    const result = run(`process.stdout.write('output'); process.stderr.write('diagnostic'); process.exit(${code});`);
    assert.ifError(result.error);
    assert.equal(result.status, code, result.stderr);
    assert.equal(result.stdout, 'output');
    assert.equal(result.stderr, 'diagnostic');
  }
});

test('bounded command rejects invalid deadlines and reports launch failure', () => {
  for (const duration of ['0', '-1', 'NaN', '2147483648']) {
    const result = spawnSync(process.execPath, [script, duration, '100', process.execPath], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 125);
    assert.match(result.stderr, /Command deadlines/);
  }
  const missing = spawnSync(process.execPath, [script, '1000', '100', '/no-such-validation-command'], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(missing.error);
  assert.equal(missing.status, 125);
  assert.match(missing.stderr, /Unable to run validation command/);
});

test('deadline remains failure when the command handles TERM successfully', () => {
  const result = run("process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);", 1000);
  assert.ifError(result.error);
  assert.match(result.stdout, /ready/);
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /exceeded 1000ms/);
});

test('deadline force-stops a command and descendant that both ignore TERM', (t) => {
  const source = `const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready\\\\n');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});
    descendant.stdout.once('data',()=>{process.stdout.write('descendant='+descendant.pid+'\\nready\\n')});
    setInterval(()=>{},1000);`;
  const result = run(source, 1500);
  const descendants = [...result.stdout.matchAll(/descendant=(\d+)/g)].map(match => Number(match[1]));
  t.after(() => {
    for (const pid of descendants) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stdout, /ready/);
  assert.equal(descendants.length, 1);
  assert.ok(stopped(descendants[0]!), 'owned descendant remains running after the deadline');
});

test('cancellation stops descendants even when their leader exits first', { timeout: 10000 }, async (t) => {
  const source = `const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>process.exit(0));
    const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready\\\\n');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});
    descendant.stdout.once('data',()=>process.stdout.write('leader='+process.pid+'\\ndescendant='+descendant.pid+'\\nready\\n'));
    setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, [script, '5000', '100', process.execPath, '-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
  const closed = once(child, 'close');
  const pids: number[] = [];
  cleanup(t, child, closed, pids);
  const output = await ready(child);
  pids.push(...[...output.matchAll(/(?:leader|descendant)=(\d+)/g)].map(match => Number(match[1])));
  assert.equal(pids.length, 2);
  child.kill('SIGTERM');
  assert.deepEqual(await closed, [143, null]);
  for (const pid of pids) assert.ok(stopped(pid), 'owned command process remains running after cancellation');
});
