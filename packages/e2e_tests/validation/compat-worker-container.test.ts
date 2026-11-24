import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { startCompatWorkerContainer, stopCompatWorkerContainer } from '../src/subtask-compat-worker-container.ts';

test('container stop covers a detached child and records failure without exposing the token', { timeout: 60_000 }, async () => {
  const checkout = path.resolve(import.meta.dirname, '../../..'), id = randomUUID();
  const run = path.join(checkout, '.tmp', 'product-e2e', id);
  const root = path.join(checkout, '.tmp', 'product-e2e-retained', id);
  const workerId = randomUUID();
  const config = path.join(root, 'worker-config'), entry = path.join(root, 'worker.mjs'), resolver = path.join(root, 'resolver path', 'resolve.cjs');
  await mkdir(path.join(run, 'results'), { recursive: true });
  await mkdir(path.join(run, 'logs'), { recursive: true });
  await mkdir(config, { recursive: true });
  await mkdir(path.dirname(resolver), { recursive: true });
  await writeFile(resolver, "process.env.COMPAT_RESOLVER_LOADED='yes';\n");
  await writeFile(path.join(config, 'config.yml'), JSON.stringify({ serverToken: 'test-secret-token' }));
  await writeFile(entry, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; if(process.env.COMPAT_RESOLVER_LOADED!=='yes')process.exit(21); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); child.unref(); writeFileSync(${JSON.stringify(path.join(root, 'child'))},String(child.pid)); process.stderr.write('Bearer test-secret-token\\n'); process.on('SIGINT',()=>process.exit(7)); setInterval(()=>{},1000);`);
  let clean = false;
  try {
    const worker = await startCompatWorkerContainer({ checkout, runDirectory: run, root, entry, config, workerId, log: path.join(root, 'peer'), ca: '/etc/ssl/certs/ca-certificates.crt', resolver });
    const deadline = Date.now() + 15_000;
    for (;;) { try { await readFile(path.join(root, 'child')); break; } catch (error) { if (Date.now() >= deadline) throw error; await delay(100); } }
    const before = JSON.parse(await readFile(path.join(run, 'results', 'compat-worker-container.json'), 'utf8')) as { id: string };
    const childPid = (await readFile(path.join(root, 'child'), 'utf8')).trim();
    assert.match(childPid, /^\d+$/);
    execFileSync('docker', ['exec', before.id, 'kill', '-0', childPid], { timeout: 10_000 });
    await assert.rejects(stopCompatWorkerContainer(run, false, randomUUID()), /does not match/);
    const stopped = await stopCompatWorkerContainer(run, false, workerId);
    assert.equal(stopped?.exitCode, 7);
    assert.doesNotMatch(stopped!.stderr, /test-secret-token/);
    assert.equal((await worker.finished).exitCode, 7);
    const receipt = JSON.parse(await readFile(path.join(run, 'results', 'compat-worker-container.json'), 'utf8')) as { phase: string; state: { exitCode: number } };
    assert.equal(receipt.phase, 'stopped'); assert.equal(receipt.state.exitCode, 7);
    const bin = path.join(root, 'bin'); await mkdir(bin);
    const wrapper = path.join(bin, 'docker');
    await writeFile(wrapper, '#!/bin/sh\nif [ "$1" = rm ]; then echo "Error response from daemon: permission denied" >&2; exit 1; fi\nexec /usr/bin/docker "$@"\n'); await chmod(wrapper, 0o700);
    const module = new URL('../src/subtask-compat-worker-container.ts', import.meta.url).href;
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', `import {stopCompatWorkerContainer} from ${JSON.stringify(module)}; await stopCompatWorkerContainer(${JSON.stringify(run)}, true, ${JSON.stringify(workerId)});`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'pipe', timeout: 15_000 }));
    const refused = JSON.parse(await readFile(path.join(run, 'results', 'compat-worker-container.json'), 'utf8')) as { phase: string };
    assert.equal(refused.phase, 'stopped');
    await stopCompatWorkerContainer(run, true, workerId);
    const after = JSON.parse(await readFile(path.join(run, 'results', 'compat-worker-container.json'), 'utf8')) as { phase: string };
    assert.equal(after.phase, 'removed');
    clean = true;
  } finally {
    if (!clean) await stopCompatWorkerContainer(run, true, workerId);
    await rm(run, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  }
});

for (const phase of ['creating', 'starting'] as const) test(`observes the original container after an interrupted ${phase} receipt`, { timeout: 60_000 }, async () => {
  const checkout = path.resolve(import.meta.dirname, '../../..'), id = randomUUID(), workerId = randomUUID();
  const run = path.join(checkout, '.tmp', 'product-e2e', id);
  const root = path.join(checkout, '.tmp', 'product-e2e-retained', id), config = path.join(root, 'worker-config');
  const entry = path.join(root, 'worker.mjs'), receiptFile = path.join(run, 'results', 'compat-worker-container.json');
  await mkdir(path.join(run, 'results'), { recursive: true }); await mkdir(path.join(run, 'logs'), { recursive: true }); await mkdir(config, { recursive: true });
  await writeFile(path.join(config, 'config.yml'), JSON.stringify({ serverToken: 'test-secret-token' }));
  await writeFile(entry, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(path.join(root, 'ready'))},'ready'); process.on('SIGINT',()=>process.exit(0)); setInterval(()=>{},1000);`);
  let clean = false;
  try {
    const worker = await startCompatWorkerContainer({ checkout, runDirectory: run, root, entry, config, workerId, log: path.join(root, 'peer'), ca: '/etc/ssl/certs/ca-certificates.crt', resolver: path.join(checkout, 'packages/e2e_tests/src/resolve-local.cjs') });
    const deadline = Date.now() + 15_000;
    for (;;) { try { await readFile(path.join(root, 'ready')); break; } catch (error) { if (Date.now() >= deadline) throw error; await delay(100); } }
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8')) as Record<string, unknown>;
    receipt.phase = phase; if (phase === 'creating') receipt.id = null;
    await writeFile(receiptFile, JSON.stringify(receipt));
    const stopped = await stopCompatWorkerContainer(run, false, workerId);
    assert.equal(stopped?.exitCode, 0); assert.equal((await worker.finished).exitCode, 0);
    const recovered = JSON.parse(await readFile(receiptFile, 'utf8')) as { id: string; phase: string };
    assert.match(recovered.id, /^[a-f0-9]{64}$/); assert.equal(recovered.phase, 'stopped');
    await stopCompatWorkerContainer(run, true, workerId); clean = true;
  } finally {
    if (!clean) await stopCompatWorkerContainer(run, true, workerId);
    await rm(run, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  }
});

test('an unresolved creation without an observed container retains its receipt', { timeout: 15_000 }, async () => {
  const checkout = path.resolve(import.meta.dirname, '../../..'), id = randomUUID(), workerId = randomUUID();
  const run = path.join(checkout, '.tmp', 'product-e2e', id), file = path.join(run, 'results', 'compat-worker-container.json');
  await mkdir(path.dirname(file), { recursive: true });
  const receipt = { schemaVersion: 1, runId: id, workerId, name: `daynight-compat-worker-${id}`, image: 'node:24-bookworm@sha256:4140e303c3dcf97edde1e42837bcb8db8c5d349d20582990d9b3ee99ee71481e', phase: 'creating', id: null };
  try {
    await writeFile(file, JSON.stringify(receipt));
    await assert.rejects(stopCompatWorkerContainer(run, true, workerId), /creation outcome is unconfirmed/);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), receipt);
  } finally { await rm(run, { recursive: true, force: true }); }
});

test('a definite invalid bind refusal records no container and permits cleanup', { timeout: 30_000 }, async () => {
  const checkout = path.resolve(import.meta.dirname, '../../..'), id = randomUUID(), workerId = randomUUID();
  const run = path.join(checkout, '.tmp', 'product-e2e', id);
  const root = path.join(checkout, '.tmp', 'product-e2e-retained', id);
  await mkdir(path.join(run, 'results'), { recursive: true }); await mkdir(path.join(run, 'logs'), { recursive: true });
  try {
    await assert.rejects(startCompatWorkerContainer({ checkout, runDirectory: run, root, entry: path.join(root, 'missing.mjs'), config: path.join(root, 'worker-config'), workerId, log: path.join(root, 'peer'), ca: '/etc/ssl/certs/ca-certificates.crt', resolver: path.join(checkout, 'packages/e2e_tests/src/resolve-local.cjs') }), /invalid mount config/i);
    const receipt = JSON.parse(await readFile(path.join(run, 'results', 'compat-worker-container.json'), 'utf8')) as { phase: string };
    assert.equal(receipt.phase, 'never-created');
    assert.equal(await stopCompatWorkerContainer(run, true, workerId), undefined);
  } finally { await rm(run, { recursive: true, force: true }); }
});

test('recovery joins an interrupted Docker signal and kills a Worker that ignored SIGINT', { timeout: 60_000 }, async () => {
  const checkout = path.resolve(import.meta.dirname, '../../..'), id = randomUUID(), workerId = randomUUID();
  const run = path.join(checkout, '.tmp', 'product-e2e', id), root = path.join(checkout, '.tmp', 'product-e2e-retained', id);
  const config = path.join(root, 'worker-config'), entry = path.join(root, 'worker.mjs'), bin = path.join(root, 'bin');
  await mkdir(path.join(run, 'results'), { recursive: true }); await mkdir(path.join(run, 'logs'), { recursive: true }); await mkdir(config, { recursive: true }); await mkdir(bin);
  await writeFile(path.join(config, 'config.yml'), JSON.stringify({ serverToken: 'test-secret-token' }));
  await writeFile(entry, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(path.join(root, 'ready'))},'ready'); process.on('SIGINT',()=>{}); setInterval(()=>{},1000);`);
  const wrapper = path.join(bin, 'docker'), signalled = path.join(root, 'signalled');
  await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = kill ] && [ "$3" = INT ]; then /usr/bin/docker "$@"; touch '${signalled}'; sleep 60; exit 0; fi\nexec /usr/bin/docker "$@"\n`); await chmod(wrapper, 0o700);
  let clean = false;
  try {
    const worker = await startCompatWorkerContainer({ checkout, runDirectory: run, root, entry, config, workerId, log: path.join(root, 'peer'), ca: '/etc/ssl/certs/ca-certificates.crt', resolver: path.join(checkout, 'packages/e2e_tests/src/resolve-local.cjs') });
    const waitFile = async (file: string) => { const deadline = Date.now() + 15_000; for (;;) { try { await readFile(file); return; } catch (error) { if (Date.now() >= deadline) throw error; await delay(50); } } };
    await waitFile(path.join(root, 'ready'));
    const module = new URL('../src/subtask-compat-worker-container.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {stopCompatWorkerContainer} from ${JSON.stringify(module)}; await stopCompatWorkerContainer(${JSON.stringify(run)}, false, ${JSON.stringify(workerId)});`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' });
    await waitFile(signalled); child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('close', () => resolve()));
    const before = JSON.parse(await readFile(path.join(run, 'results', 'compat-worker-container.json'), 'utf8')) as { phase: string; stopGateId: string };
    assert.equal(before.phase, 'stopping'); assert.ok(before.stopGateId);
    const stopped = await stopCompatWorkerContainer(run, false, workerId);
    assert.equal(stopped?.exitCode, 137); assert.equal((await worker.finished).exitCode, 137);
    await stopCompatWorkerContainer(run, true, workerId); clean = true;
  } finally {
    if (!clean) await stopCompatWorkerContainer(run, true, workerId);
    await rm(run, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  }
});

test('image preparation failure creates no container intent', { timeout: 20_000 }, async () => {
  const checkout = path.resolve(import.meta.dirname, '../../..'), id = randomUUID(), workerId = randomUUID();
  const run = path.join(checkout, '.tmp', 'product-e2e', id), root = path.join(checkout, '.tmp', 'product-e2e-retained', id), bin = path.join(root, 'bin');
  await mkdir(path.join(run, 'results'), { recursive: true }); await mkdir(bin, { recursive: true });
  const marker = path.join(root, 'create-called'), wrapper = path.join(bin, 'docker');
  await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = image ]; then echo 'Error: No such image' >&2; exit 1; fi\nif [ "$1" = pull ]; then echo 'registry unavailable' >&2; exit 1; fi\ntouch '${marker}'; exit 1\n`); await chmod(wrapper, 0o700);
  const module = new URL('../src/subtask-compat-worker-container.ts', import.meta.url).href;
  const input = { checkout, runDirectory: run, root, entry: path.join(root, 'worker.mjs'), config: path.join(root, 'worker-config'), workerId, log: path.join(root, 'peer'), ca: '/etc/ssl/certs/ca-certificates.crt', resolver: path.join(checkout, 'packages/e2e_tests/src/resolve-local.cjs') };
  try {
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', `import {startCompatWorkerContainer} from ${JSON.stringify(module)}; await startCompatWorkerContainer(${JSON.stringify(input)});`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'pipe', timeout: 15_000 }));
    await assert.rejects(readFile(path.join(run, 'results', 'compat-worker-container.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal(await stopCompatWorkerContainer(run, true, workerId), undefined);
  } finally { await rm(run, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});
