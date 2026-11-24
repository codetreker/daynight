import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const runner = path.join(root, 'packages/e2e_tests/src/subtask-compat-recovery.ts');
const candidate = 'a'.repeat(40), baseline = 'b'.repeat(40);

// Fake commands exercise the runner's process and resource ownership protocol,
// including a genuinely interrupted child, without starting product services.
const fake = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), childProcess = require('node:child_process');
const name = path.basename(process.argv[1]), a = process.argv.slice(2), base = process.env.FAKE_ROOT;
const save = (f, v) => fs.writeFileSync(f, v);
const stateFile = path.join(base, 'state.json');
let state = JSON.parse(fs.readFileSync(stateFile));
const put = () => save(stateFile, JSON.stringify(state));
if (name === 'tsc' && (process.env.FAKE_MODE === 'build-failure' || process.env.FAKE_MODE === 'acceptance-default')) {
  console.error('ERR_BUILD_FAILED compile.ts:12:9 token=dnpat_secret-password postgres://user:password@localhost/db');
  process.exitCode = 1;
} else if (name === 'git') {
  if (a[0] === 'clone') {
    const dest = a.at(-1), module = path.join(dest, 'packages/daynight-server');
    fs.mkdirSync(path.join(module, 'scripts'), {recursive:true});
    fs.mkdirSync(path.join(module, 'cmd/daynight-server'), {recursive:true});
    fs.mkdirSync(path.join(dest, 'packages/daynight-web/scripts'), {recursive:true});
    save(path.join(module, 'scripts/unit-overlay.json'), JSON.stringify({Replace:{}}));
    save(path.join(module, 'cmd/daynight-server/webhook_controlled_lifecycle_test.go'), '_, daynightRoot, err := parseCommand(\\nconfig.LoadServer(daynightRoot, os.LookupEnv)');
    save(path.join(dest, 'packages/daynight-web/scripts/publish-assets.mts'), '');
  } else if (a[0] === 'checkout') save(path.join(process.cwd(), '.fake-revision'), a.at(-1));
  else if (a[1] === '--is-shallow-repository') console.log('false');
  else if (a[1] === 'HEAD') console.log(fs.readFileSync('.fake-revision', 'utf8'));
  else console.log('same-server-tree');
} else if (name === 'go') {
  if (a[0] === 'build') save(a[a.indexOf('-o')+1], 'binary');
  else if (a[0] === 'version') console.log('\\tbuild\\tvcs.revision=' + process.env.FAKE_CANDIDATE + '\\n\\tbuild\\tvcs.modified=false');
  else if (a[0] === 'test') {
    console.log('=== RUN   TestS1PairedRecoveryEvidence/external_effect_false');
    if (process.env.FAKE_MODE === 'failure') console.log('x'.repeat(1100000) + 'dnpat_secret-password');
    console.log('    recovery_test.go:42: failed with dnpat_secret-password postgres://user:password@localhost/db');
    console.log('    recovery_test.go:43: external_effect=false receiver_requests=0 effect_sha256=none snapshot_sha256=abcd ledger_preserved=true attachment_restored=true post_upgrade_write_removed=true endpoint_reconciliation=false');
    save(path.join(base, 'test-started'), 'yes');
    if (process.env.FAKE_MODE === 'interrupt' || process.env.FAKE_MODE === 'locked') setInterval(() => {}, 1000);
    else if (process.env.FAKE_MODE === 'legacy-pass') {
      for (const test of ['TestS1PairedRecoveryEvidence','TestV1PrecommitLockFailureRestoresOldServer','TestTaskAncestorMigrationCommittedStartupFailureAndRecovery','TestWorkerActiveClaimMigrationProcessRecovery','TestServerProcessMigrationFailuresNeverListenAndRecover']) console.log('--- PASS: ' + test + ' (1.00s)');
      console.log('external_effect=false receiver_requests=0');
      console.log('external_effect=true receiver_requests=1 ledger_preserved=true attachment_restored=true post_upgrade_write_removed=true');
      console.log('production candidate ready on migrated ledger; HTTP GET/PUT/GET succeeded');
      console.log('controlled Webhook transport process used for external-effect boundary');
    } else { console.log('--- FAIL: TestS1PairedRecoveryEvidence (0.01s)'); process.exitCode = 1; }
  }
} else if (name === 'docker') {
  if ((a[0] === 'network' || a[0] === 'volume') && a[1] === 'create') {
    const resource = a.at(-1), label = a[a.indexOf('--label')+1].split('=')[1];
    if (['late', 'legacy'].includes(process.env.FAKE_MODE) && a[0] === 'network') {
      const daemonCode = "const fs=require('node:fs'),path=require('node:path'); const [base,resource,label]=process.argv.slice(1); const t=setInterval(()=>{if(!fs.existsSync(path.join(base,'release-daemon'))) return; clearInterval(t); const file=path.join(base,'state.json'); const state=JSON.parse(fs.readFileSync(file)); state[resource]={label}; fs.writeFileSync(file,JSON.stringify(state)); fs.writeFileSync(path.join(base,'late-created'),'yes');},25); setTimeout(()=>process.exit(2),15000).unref();";
      const daemon = childProcess.spawn(process.execPath, ['-e', daemonCode, base, resource, label], {detached:true,stdio:'ignore'}); daemon.unref();
      save(path.join(base, 'docker-started'), 'yes'); setInterval(() => {}, 1000);
    } else { state[resource] = {label}; put(); }
  } else if (a[0] === 'run') {
    const resource = a[a.indexOf('--name')+1], label = a[a.indexOf('--label')+1].split('=')[1], network = a[a.indexOf('--network')+1]; state[resource] = {label: process.env.FAKE_MODE === 'foreign' && resource.endsWith('-postgres') ? 'foreign' : label, network}; put();
  } else if (a[0] === 'exec' || a[0] === 'stop') { }
  else if (a[1] === 'inspect') {
    const item = state[a[2]];
    if (!item) { console.error('No such ' + a[0] + ': ' + a[2]); process.exitCode = 1; }
    else console.log(JSON.stringify([{Config:{Labels:{'daynight.compat.recovery':item.label}}, Labels:{'daynight.compat.recovery':item.label}, NetworkSettings:{Networks:{[item.network]:{IPAddress:'127.0.0.1'}}}}]));
  } else if (a[1] === 'rm') { delete state[a[2]]; put(); }
  else { console.error('unexpected docker command'); process.exitCode = 1; }
}
`;

export async function run(mode: 'failure' | 'interrupt' | 'foreign' | 'late' | 'build-failure' | 'legacy-pass' | 'locked' | 'acceptance-default' | 'legacy'): Promise<void> {
  const scratchRoot = path.join(root, '.tmp');
  await mkdir(scratchRoot, { recursive: true });
  const dir = await mkdtemp(path.join(scratchRoot, 'compat-recovery-harness-'));
  try {
    const repository = path.join(dir, 'repo'), bin = path.join(dir, 'bin'), report = path.join(dir, 'report');
    await mkdir(path.join(repository, 'packages/e2e_tests/src'), { recursive: true });
    await mkdir(path.join(repository, 'packages/daynight-web/node_modules/.bin'), { recursive: true });
    await mkdir(path.join(repository, 'node_modules'), { recursive: true });
    await mkdir(bin); await mkdir(report);
    await writeFile(path.join(repository, 'packages/e2e_tests/src/subtask-compat-recovery-test.go.txt'), 'probe');
    await writeFile(path.join(dir, 'fake.cjs'), fake, { mode: 0o700 });
    await writeFile(path.join(dir, 'state.json'), '{}');
    for (const name of ['git', 'go', 'docker']) await symlink(path.join(dir, 'fake.cjs'), path.join(bin, name));
    for (const name of ['tsc', 'vite']) await symlink(path.join(dir, 'fake.cjs'), path.join(repository, 'packages/daynight-web/node_modules/.bin', name));
    const child = spawn(process.execPath, [runner, '--repository', repository, '--candidate', candidate, '--baseline', baseline, '--directory', report, ...(mode === 'acceptance-default' ? [] : ['--legacy-diagnostic'])], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_ROOT: dir, FAKE_CANDIDATE: candidate, FAKE_MODE: mode }, stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    try {
      if (mode === 'interrupt' || mode === 'late' || mode === 'legacy' || mode === 'locked') {
        const deadline = Date.now() + 20_000;
        while (true) {
          try { await readFile(path.join(dir, (mode === 'late' || mode === 'legacy') ? 'docker-started' : 'test-started')); break; } catch { /* Wait for the child to reach go test. */ }
          if (Date.now() > deadline) throw new Error('test child did not start');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (mode === 'locked') {
          const concurrent = spawn(process.execPath, [runner, '--cleanup', '--repository', repository, '--directory', report], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_ROOT: dir, FAKE_CANDIDATE: candidate, FAKE_MODE: mode }, stdio: 'ignore',
          });
          assert.notEqual(await new Promise<number | null>((resolve, reject) => { concurrent.once('error', reject); concurrent.once('exit', resolve); }), 0);
          assert.equal(Object.keys(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))).length, 4);
        }
        child.kill('SIGTERM');
      }
      assert.notEqual(await exited, 0);
    } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    const receipt = JSON.parse(await readFile(path.join(report, 'recovery.json'), 'utf8'));
    if (mode === 'acceptance-default') {
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.phase, 'prepare');
      assert.equal(receipt.failure.phase, 'prepare');
      assert.match(await readFile(path.join(report, 'failure.json'), 'utf8'), /Baseline npm CLI artifact is required/);
      assert.equal(receipt.fixtureVerification, undefined);
      assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')), {});
      assert.equal(receipt.cleanup.verified, true);
      const before = await readFile(path.join(report, 'recovery.json'), 'utf8');
      const repeat = spawn(process.execPath, [runner, '--repository', repository, '--candidate', candidate, '--baseline', baseline, '--directory', report], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_ROOT: dir, FAKE_CANDIDATE: candidate, FAKE_MODE: mode }, stdio: 'ignore',
      });
      assert.notEqual(await new Promise<number | null>((resolve, reject) => { repeat.once('error', reject); repeat.once('exit', resolve); }), 0);
      assert.equal(await readFile(path.join(report, 'recovery.json'), 'utf8'), before);
      return;
    }
    if (mode === 'late' || mode === 'legacy') {
      assert.equal(receipt.cleanup.verified, false);
      assert.equal(receipt.pendingDocker.length, 1);
      assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')), {});
      if (mode === 'legacy') {
        delete receipt.runId; delete receipt.pendingDocker; delete receipt.originQuiescent;
        receipt.schemaVersion = 1;
        receipt.resources = { network: receipt.resources.network, volume: receipt.resources.volume, postgres: receipt.resources.postgres, redis: receipt.resources.redis };
        await writeFile(path.join(report, 'recovery.json'), JSON.stringify(receipt));
      }
      await writeFile(path.join(dir, 'release-daemon'), 'yes');
      const deadline = Date.now() + 10_000;
      while (true) {
        try { await readFile(path.join(dir, 'late-created')); break; } catch { /* Wait for the simulated daemon. */ }
        if (Date.now() > deadline) throw new Error('late create did not complete');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))[receipt.resources.network]);
      const compensation = spawn(process.execPath, [runner, '--cleanup', '--repository', repository, '--directory', report], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_ROOT: dir, FAKE_CANDIDATE: candidate, FAKE_MODE: mode }, stdio: 'ignore',
      });
      assert.notEqual(await new Promise<number | null>((resolve, reject) => { compensation.once('error', reject); compensation.once('exit', resolve); }), 0);
      const after = JSON.parse(await readFile(path.join(report, 'recovery.json'), 'utf8'));
      assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')), {});
      assert.equal(after.cleanup.verified, false);
      assert.equal(after.pendingDocker.length, 1);
      if (mode === 'legacy') assert.equal(after.pendingDocker[0].operation, 'legacy outcome unconfirmed');
      assert.equal(after.cleanup.observations[`network:${receipt.resources.network}`], 'absent');
      return;
    }
    if (mode === 'build-failure') {
      const failure = await readFile(path.join(report, 'failure.json'), 'utf8');
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.failure.phase, 'build-production-candidate');
      assert.equal(receipt.failure.command, 'tsc');
      assert.match(failure, /ERR_BUILD_FAILED/);
      assert.match(failure, /compile.ts:12:9/);
      assert.doesNotMatch(failure, /dnpat_secret|password|postgres:/);
      assert.ok(Buffer.byteLength(failure) < 10_000);
      assert.equal(receipt.cleanup.verified, true);
      return;
    }
    if (mode === 'legacy-pass') {
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.fixtureVerification.verified, false);
      assert.equal(receipt.phase, 'fixture-verification');
      assert.equal(receipt.cleanup.verified, true);
      return;
    }
    const log = await readFile(path.join(report, 'recovery.log'), 'utf8');
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.phase, 'go-test');
    assert.equal(receipt.testDiagnostics.lastTest, 'TestS1PairedRecoveryEvidence/external_effect_false');
    assert.match(log, /recovery_test\.go:42: diagnostic redacted/);
    assert.match(log, /external_effect=false receiver_requests=0 effect_sha256=none/);
    assert.doesNotMatch(log, /dnpat_secret|secret-password|postgres:\/\//);
    if (mode === 'failure') assert.equal(receipt.testDiagnostics.truncated.stdout, true);
    assert.ok(Buffer.byteLength(log) < 10_000);
    const remaining = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    if (mode === 'foreign') {
      assert.deepEqual(new Set(Object.keys(remaining)), new Set([receipt.resources.postgres, receipt.resources.volume, receipt.resources.network]));
      assert.equal(receipt.cleanup.observations[`container:${receipt.resources.postgres}`], 'unconfirmed');
      assert.equal(receipt.cleanup.observations[`volume:${receipt.resources.volume}`], 'owned-retained');
      assert.equal(receipt.cleanup.observations[`network:${receipt.resources.network}`], 'owned-retained');
      assert.match(receipt.cleanup.failures.join(' '), /Ownership label mismatch/);
    } else {
      assert.deepEqual(remaining, {});
      assert.ok(Object.values(receipt.cleanup.observations).every(value => value === 'absent'));
    }
    assert.equal(receipt.cleanup.quiescent, mode !== 'interrupt' && mode !== 'locked');
    assert.equal(receipt.cleanup.verified, mode === 'failure');
  } finally { await rm(dir, { recursive: true, force: true }); }
}
