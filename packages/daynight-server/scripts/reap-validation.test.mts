import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

const script = fileURLToPath(new URL('./reap-validation.py', import.meta.url));
const temporary = resolve(fileURLToPath(new URL('../.tmp', import.meta.url)));
const stopped = (pid: number) => {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
  assert.ifError(result.error);
  return result.status === 1 || result.stdout.trim().startsWith('Z');
};

const nested = async (t: TestContext, mode: 'timeout' | 'signal' | 'orphan', incoming: NodeJS.Signals = 'SIGTERM') => {
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'reap-validation-test-'));
  const leaf = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.env.TEST_ROOT+'/leaf',String(process.pid));setInterval(()=>{},1000)`;
  const middle = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.env.TEST_ROOT+'/middle',String(process.pid));require('node:child_process').spawn(process.execPath,['-e',process.env.LEAF_SOURCE],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)`;
  const leader = `process.on('SIGTERM',()=>{});const fs=require('node:fs');fs.writeFileSync(process.env.TEST_ROOT+'/leader',String(process.pid));require('node:child_process').spawn(process.execPath,['-e',process.env.MIDDLE_SOURCE],{detached:true,stdio:'ignore'});const timer=setInterval(()=>{if(process.env.TEST_MODE==='orphan'&&fs.existsSync(process.env.TEST_ROOT+'/leaf')){clearInterval(timer);process.exit(0)}},10)`;
  const child = spawn('python3', [script, mode === 'timeout' ? '2000' : '10000', '100', process.execPath, '-e', leader], {
    env: { ...process.env, TEST_ROOT: root, TEST_MODE: mode, LEAF_SOURCE: leaf, MIDDLE_SOURCE: middle },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  const pids: number[] = [];
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
    for (const pid of pids) if (!stopped(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  });
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    try {
      pids.push(...await Promise.all(['leader', 'middle', 'leaf'].map(async name => Number(await readFile(join(root, name), 'utf8')))));
      break;
    } catch { await delay(10); }
  }
  assert.equal(pids.length, 3, stderr);
  if (mode === 'signal') child.kill(incoming);
  const [status, termination] = await closed;
  assert.equal(termination, null, stderr);
  assert.equal(status, mode === 'timeout' ? 124 : mode === 'orphan' ? 0 : incoming === 'SIGINT' ? 130 : 143, stderr);
  for (const pid of pids) assert.ok(stopped(pid), `validation descendant ${pid} remains running`);
  if (mode === 'timeout') assert.match(stderr, /Validation command exceeded/);
};

test('supervisor preserves ordinary command exit status and output', () => {
  for (const code of [0, 17]) {
    const result = spawnSync('python3', [script, '5000', '100', process.execPath, '-e', `process.stdout.write('ok');process.exit(${code})`], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, code, result.stderr);
    assert.equal(result.stdout, 'ok');
  }
});

test('a successful leader cannot leave detached descendants behind', { timeout: 10000 }, t => nested(t, 'orphan'));
test('deadline reaps multiple detached generations that ignore TERM', { timeout: 10000 }, t => nested(t, 'timeout'));
for (const incoming of ['SIGINT', 'SIGTERM'] as const) {
  test(`${incoming} reaps multiple detached generations that ignore TERM`, { timeout: 10000 }, t => nested(t, 'signal', incoming));
}
