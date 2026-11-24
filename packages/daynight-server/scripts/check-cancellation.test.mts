import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

const moduleRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const stopped = (pid: number) => {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
  assert.ifError(result.error);
  return result.status === 1 || result.stdout.trim().startsWith('Z');
};

const exercise = async (t: TestContext, incoming: 'SIGINT' | 'SIGTERM') => {
  const temporary = join(moduleRoot, '.tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'check-cancellation-'));
  const scripts = join(root, 'scripts'), tools = join(root, 'tools');
  await mkdir(scripts);
  await mkdir(tools);
  for (const name of ['check.sh', 'env.sh', 'validation-env.sh', 'unit-overlay.json', 'parallel-check-preparation.mts', 'command-process-group.mts', 'reap-validation.py']) {
    await copyFile(join(moduleRoot, 'scripts', name), join(scripts, name));
  }
  const worker = `const fs=require('node:fs');const {spawn}=require('node:child_process');
const path=require('node:path');const root=process.env.TEST_ROOT,role=process.argv[2];
const leaf="process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.env.TEST_ROOT+'/'+process.env.TEST_ROLE+'-leaf',String(process.pid));setInterval(()=>{},1000)";
const middle="process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.env.TEST_ROOT+'/'+process.env.TEST_ROLE+'-middle',String(process.pid));require('node:child_process').spawn(process.execPath,['-e',process.env.LEAF_SOURCE],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)";
process.on('SIGTERM',()=>{});fs.writeFileSync(path.join(root,role+'-leader'),String(process.pid));
spawn(process.execPath,['-e',middle],{detached:true,stdio:'ignore',env:{...process.env,TEST_ROLE:role,LEAF_SOURCE:leaf}});
setInterval(()=>{},1000);
`;
  await writeFile(join(root, 'worker.cjs'), worker);
  await writeFile(join(root, 'go-trace'), '');
  const fakeNode = `#!/usr/bin/env bash
set -eu
case "$1" in
  --input-type=module|scripts/parallel-check-preparation.mts) exec ${quote(process.execPath)} "$@" ;;
  --test) exec ${quote(process.execPath)} "$TEST_ROOT/worker.cjs" contracts ;;
  scripts/prepare-uniauth-fixture.mts) exec ${quote(process.execPath)} "$TEST_ROOT/worker.cjs" auth ;;
  *) printf 'Unexpected node command: %s\\n' "$*" >&2; exit 99 ;;
esac
`;
  await writeFile(join(tools, 'node'), fakeNode, { mode: 0o700 });
  await writeFile(join(tools, 'go'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$TEST_ROOT/go-trace"\nexit 99\n', { mode: 0o700 });
  const child = spawn('python3', [join(scripts, 'reap-validation.py'), '1800000', '2000', 'bash', join(scripts, 'check.sh'), '--coverage'], {
    cwd: root,
    env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, TEST_ROOT: root,
      DAYNIGHT_TEST_DATABASE_URL: 'postgres://fixture', DAYNIGHT_TEST_REDIS_URL: 'redis://fixture',
      CI: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/42/merge' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  const pids: number[] = [];
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([closed, delay(15000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const name of ['contracts-leader', 'contracts-middle', 'contracts-leaf', 'auth-leader', 'auth-middle', 'auth-leaf']) {
      const pid = Number(await readFile(join(root, name), 'utf8').catch(() => '0'));
      if (pid && !stopped(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10000;
  const names = ['contracts-leader', 'contracts-middle', 'contracts-leaf', 'auth-leader', 'auth-middle', 'auth-leaf'];
  while (Date.now() < deadline) {
    try { pids.push(...await Promise.all(names.map(async name => Number(await readFile(join(root, name), 'utf8'))))); break; }
    catch { await delay(20); }
  }
  assert.equal(pids.length, names.length, `stages did not start: ${stdout}\n${stderr}`);
  const started = Date.now();
  child.kill(incoming);
  const [status, termination] = await Promise.race([closed, delay(7000, undefined, { ref: false }).then(() => { throw new Error('check.sh did not finish cancellation within 7 seconds'); })]);
  assert.equal(termination, null, stderr);
  assert.equal(status, incoming === 'SIGINT' ? 130 : 143, stderr);
  assert.ok(Date.now() - started < 7000);
  for (const pid of pids) assert.ok(stopped(pid), `validation descendant ${pid} remains running`);
  assert.equal(await readFile(join(root, 'go-trace'), 'utf8'), '', 'Go validation must not start');
  const remaining = await readdir(join(root, '.tmp/tmp'));
  assert.ok(remaining.every(name => !name.startsWith('check-fixture.')), 'temporary result directory remains');
};

test('PR validation entry drains detached descendants on cancellation', { timeout: 25000, concurrency: true, skip: process.platform !== 'linux' }, async t => {
  await Promise.all((['SIGINT', 'SIGTERM'] as const).map(signal => t.test(signal, child => exercise(child, signal))));
});
