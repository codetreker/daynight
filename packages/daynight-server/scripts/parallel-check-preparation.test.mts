import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

const script = fileURLToPath(new URL('./parallel-check-preparation.mts', import.meta.url));
const temporary = resolve(fileURLToPath(new URL('../.tmp', import.meta.url)));

const fixture = async (t: TestContext, options: Record<string, string> = {}) => {
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'parallel-preparation-test-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  const executable = join(root, 'auth-fixture');
  await writeFile(executable, 'fixture');
  await chmod(executable, 0o700);
  const command = `const {spawn}=require('node:child_process');
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.env.FAKE_ROOT+'/contract-descendant',String(process.pid));setInterval(()=>{},1000)"],{stdio:'ignore'});
setInterval(()=>{},1000);`;
  const preload = `const fs=require('node:fs');
if(process.argv[1]?.endsWith('command-timeout.mts')) {
  const schedule=global.setTimeout;
  global.setTimeout=function(callback,ms,...args) {
    if(ms!==5000)return schedule(callback,ms,...args);
    const timer=setInterval(()=>{if(fs.existsSync(process.env.FAKE_ROOT+'/release-contract')){clearInterval(timer);callback(...args);}},10);
    return timer;
  };
}`;
  await writeFile(join(root, 'preload.cjs'), preload);
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const p = require('node:path');
const root = process.env.FAKE_ROOT;
const marker = name => p.join(root, name);
const mark = name => fs.writeFileSync(marker(name), '');
const wait = async name => { while (!fs.existsSync(marker(name))) await new Promise(r => setTimeout(r, 10)); };
const main = async () => {
  if (process.argv[1].endsWith('/go')) {
    mark('go-started');
    if (process.env.DAYNIGHT_TEST_UNIAUTH_FIXTURE !== marker('auth-fixture') || process.env.GOFLAGS !== 'expected flags') process.exit(98);
    process.exit(Number(process.env.GO_EXIT || 0));
  }
  if (process.argv[2] === '--test') {
    mark('contracts-started');
    await wait('auth-started');
    if (process.env.HANG === '1') {
      const child = spawn(process.execPath, [process.env.TIMEOUT_HELPER, '5000', '100', process.execPath, '-e', ${JSON.stringify(command)}],
        { stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '--require=' + marker('preload.cjs') } });
      const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve([code, signal])); });
      await wait('contract-descendant'); mark('contracts-ready');
      const result = await closed;
      if (result[0] !== 124 || result[1] !== null) process.exit(96);
    }
    mark('contracts-finished');
    process.exit(Number(process.env.CONTRACT_EXIT || 0));
  }
  if (process.argv[2] === 'scripts/prepare-uniauth-fixture.mts') {
    mark('auth-started');
    await wait('contracts-started');
    if (process.env.HANG === '1') {
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>process.exit(0)); require('node:fs').writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000)", marker('descendant-pid')], { detached: true, stdio: 'ignore' });
      process.on('SIGTERM', () => { process.kill(-child.pid, 'SIGTERM'); child.once('close', () => { mark('auth-stopped'); process.exit(0); }); });
      await wait('descendant-pid'); mark('auth-ready'); setInterval(() => {}, 1000); await new Promise(() => {});
    }
    if (process.env.PREP_EXIT) process.exit(Number(process.env.PREP_EXIT));
    process.stdout.write(marker(process.env.MISSING === '1' ? 'missing' : 'auth-fixture') + '\\n');
    process.exit(0);
  }
  process.exit(99);
};
main().catch(error => { console.error(error); process.exit(97); });
`;
  for (const command of ['node', 'go']) {
    await writeFile(join(bin, command), fake, { mode: 0o700 });
  }
  const result = join(root, 'result');
  const child = spawn(process.execPath, [script, result, options.TIMEOUT_MS || '5000'], {
    cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_ROOT: root, UNIT_GO_FLAGS: 'expected flags',
      TIMEOUT_HELPER: fileURLToPath(new URL('./command-timeout.mts', import.meta.url)), ...options },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  t.after(async () => {
    await writeFile(join(root, 'release-contract'), '');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
    const pid = Number(await readFile(join(root, 'descendant-pid'), 'utf8').catch(() => '0'));
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    const contractPid = Number(await readFile(join(root, 'contract-descendant'), 'utf8').catch(() => '0'));
    if (contractPid) { try { process.kill(contractPid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    await rm(root, { recursive: true, force: true });
  });
  const waitFor = async (name: string) => {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      try { await readFile(join(root, name)); return; } catch { await delay(10); }
    }
    throw new Error(`Missing ${name}: ${stdout} ${stderr}`);
  };
  const finish = async () => ({ status: (await closed)[0], stdout, stderr });
  return { root, result, child, finish, waitFor };
};

test('parallel preparation waits for both stages and passes the verified fixture to testauth', async t => {
  const run = await fixture(t);
  const result = await run.finish();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(run.result, 'utf8'), `${join(run.root, 'auth-fixture')}\n`);
  await run.waitFor('contracts-finished');
  await run.waitFor('go-started');
  assert.match(result.stdout, /Node contract tests completed in/);
  assert.match(result.stdout, /Authentication fixture validation completed in/);
});

test('each failed stage prevents publication and waits for the other stage', async t => {
  for (const [options, expected, peer] of [
    [{ CONTRACT_EXIT: '17' }, 17, 'go-started'],
    [{ PREP_EXIT: '21' }, 21, 'contracts-finished'],
    [{ GO_EXIT: '22' }, 22, 'contracts-finished'],
    [{ MISSING: '1' }, 1, 'contracts-finished'],
  ] as const) {
    await t.test(JSON.stringify(options), async child => {
      const run = await fixture(child, options);
      const result = await run.finish();
      assert.equal(result.status, expected, result.stderr);
      await run.waitFor(peer);
      await assert.rejects(readFile(run.result));
      if ('MISSING' in options) {
        assert.match(result.stderr, /fixture is unavailable/);
        await assert.rejects(readFile(join(run.root, 'go-started')));
      }
    });
  }
});

for (const mode of ['signal', 'deadline'] as const) {
  test(`${mode} waits for contract cleanup and stops the fixture preparer's detached descendant`, { timeout: 10000 }, async t => {
    const run = await fixture(t, { HANG: '1', TIMEOUT_MS: mode === 'deadline' ? '1000' : '5000' });
    await Promise.all([run.waitFor('contracts-ready'), run.waitFor('auth-ready')]);
    const pid = Number(await readFile(join(run.root, 'descendant-pid'), 'utf8'));
    const contractPid = Number(await readFile(join(run.root, 'contract-descendant'), 'utf8'));
    if (mode === 'signal') run.child.kill('SIGTERM');
    await run.waitFor('auth-stopped');
    await assert.rejects(readFile(join(run.root, 'contracts-finished')));
    if (mode === 'signal') run.child.kill('SIGTERM');
    await writeFile(join(run.root, 'release-contract'), '');
    const result = await run.finish();
    assert.equal(result.status, mode === 'signal' ? 143 : 124, result.stderr);
    await run.waitFor('contracts-finished');
    await assert.rejects(readFile(run.result));
    for (const ownedPid of [pid, contractPid]) {
      const observed = spawnSync('ps', ['-o', 'stat=', '-p', String(ownedPid)], { encoding: 'utf8', timeout: 1000 });
      assert.ifError(observed.error);
      assert.ok(observed.status === 1 || observed.stdout.trim().startsWith('Z'), 'detached descendant remains active');
    }
  });
}
