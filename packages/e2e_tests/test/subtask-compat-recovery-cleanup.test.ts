import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { initializeRunOwnership, startOwnedPlaywright } from '../src/fixture-owner.ts';
import { captureProcessEvidence, inspectProcessEvidence, stopEvidenceGroup, type ProcessEvidence } from '../src/process-evidence.ts';
import { cleanupRecoveryResources, type RecoveryProcess, type RecoveryResource } from '../src/subtask-compat-recovery-cleanup.ts';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const ownerModule = new URL('../src/fixture-owner.ts', import.meta.url).href;
const resources: RecoveryResource[] = [{ kind: 'container', name: 'application' }, { kind: 'container', name: 'postgres' }, { kind: 'volume', name: 'database' }];
const state = () => {
  const present = new Set(resources.map(item => item.name));
  const mutations: string[] = [];
  return { present, mutations,
    inspect: async (resource: RecoveryResource) => present.has(resource.name),
    stop: async (resource: RecoveryResource) => { mutations.push(`stop:${resource.name}`); },
    remove: async (resource: RecoveryResource) => { mutations.push(`remove:${resource.name}`); present.delete(resource.name); },
  };
};
const waitFile = async (filename: string): Promise<string> => {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    try { return await readFile(filename, 'utf8'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Owned fixture did not report readiness.');
};
const ownerFixture = async (bind: boolean) => {
  const id = randomUUID(), root = path.join(repository, '.tmp', 'product-e2e'), run = path.join(root, id);
  await mkdir(root, { recursive: true }); await mkdir(run, { mode: 0o700 }); await initializeRunOwnership(repository, run);
  const marker = path.join(run, 'browser-ready');
  const script = `import { beginBrowserScope, bindBrowserScope } from ${JSON.stringify(ownerModule)};
import { spawn } from 'node:child_process'; import { rename, writeFile } from 'node:fs/promises';
const [repo,run,marker,bind]=process.argv.slice(1);
const publish = async value => { await writeFile(marker+'.tmp', value, {flag:'wx'}); await rename(marker+'.tmp', marker); };
const scope=await beginBrowserScope(repo,run);
if (bind === 'yes') {
  const browser=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{detached:true,stdio:'ignore'});
  if (!browser.pid) throw new Error('process did not start');
  await bindBrowserScope(repo,run,scope,browser.pid);
  await publish(String(browser.pid)); setInterval(() => {},1000);
} else { await publish('unbound'); process.exitCode=1; }`;
  const command = await startOwnedPlaywright({ repository, runDirectory: run, command: process.execPath,
    args: ['--input-type=module', '-e', script, repository, run, marker, bind ? 'yes' : 'no'],
    options: { cwd: run, timeoutMs: 30_000, onOutput: () => {} } });
  const markerValue = await waitFile(marker);
  return { id, run, markerValue, command };
};

test('missing browser stop proof retains every owned dependency on repeated observation', async () => {
  const fixture = await ownerFixture(false), docker = state();
  try {
    assert.notEqual((await fixture.command.finished).exitCode, 0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await cleanupRecoveryResources({ repository, runId: fixture.id, mode: 'owner', browserOwner: fixture.run,
        processes: [], resources, deadline: Date.now() + 15_000, save: async () => {}, ...docker });
      assert.equal(result.usersStopped, false);
      assert.ok(result.failures.length > 0);
      assert.deepEqual(docker.mutations, []);
      assert.deepEqual([...docker.present], ['application', 'postgres', 'database']);
      assert.deepEqual(Object.values(result.observations), ['owned-retained', 'owned-retained', 'owned-retained']);
    }
  } finally { await fixture.command.stop().catch(() => {}); await rm(fixture.run, { recursive: true, force: true }); }
});

test('real recorded browser group stops before its service and database are removed', async () => {
  const fixture = await ownerFixture(true), docker = state();
  let proof: ProcessEvidence | undefined;
  try {
    const registry = JSON.parse(await readFile(path.join(fixture.run, 'results', 'browser-ownership.json'), 'utf8')) as { scopes: { proof: ProcessEvidence }[] };
    proof = registry.scopes[0]?.proof;
    assert.ok(proof); assert.equal(proof.pid, Number(fixture.markerValue));
    assert.equal(await inspectProcessEvidence(proof), 'running');
    const result = await cleanupRecoveryResources({ repository, runId: fixture.id, mode: 'owner', browserOwner: fixture.run,
      processes: [], resources, deadline: Date.now() + 15_000, save: async () => {}, inspect: docker.inspect,
      stop: async resource => { assert.equal(await inspectProcessEvidence(proof!), 'stopped'); await docker.stop(resource); }, remove: docker.remove });
    assert.equal(await inspectProcessEvidence(proof), 'stopped');
    assert.equal(result.usersStopped, true); assert.deepEqual(result.failures, []);
    assert.deepEqual(docker.mutations, ['stop:application', 'remove:application', 'stop:postgres', 'remove:postgres', 'remove:database']);
    assert.equal(docker.present.size, 0);
  } finally {
    await fixture.command.stop().catch(() => {});
    if (proof) await stopEvidenceGroup(proof, [], Date.now() + 10_000).catch(() => {});
    await rm(fixture.run, { recursive: true, force: true });
  }
});

test('a real recorded related process is stopped before resources are touched', async () => {
  const child: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const docker = state(); let proof: ProcessEvidence | undefined;
  try {
    assert.ok(child.pid); proof = await captureProcessEvidence(child.pid);
    const processes: RecoveryProcess[] = [{ id: randomUUID(), operation: 'database lock', proof }];
    const result = await cleanupRecoveryResources({ repository, runId: randomUUID(), mode: 'owner', processes, resources,
      deadline: Date.now() + 15_000, save: async () => {}, inspect: docker.inspect,
      stop: async resource => { assert.equal(await inspectProcessEvidence(proof!), 'stopped'); await docker.stop(resource); }, remove: docker.remove });
    assert.equal(result.usersStopped, true); assert.deepEqual(result.failures, []); assert.deepEqual(processes, []); assert.equal(docker.present.size, 0);
  } finally { if (proof) await stopEvidenceGroup(proof, [], Date.now() + 10_000).catch(() => {}); else child.kill('SIGKILL'); }
});

test('a live related process without persisted identity blocks mutation', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const docker = state(); let proof: ProcessEvidence | undefined;
  try {
    assert.ok(child.pid); proof = await captureProcessEvidence(child.pid);
    const processes: RecoveryProcess[] = [{ id: randomUUID(), operation: 'unidentified original user', proof: null }];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await cleanupRecoveryResources({ repository, runId: randomUUID(), mode: 'owner', processes, resources,
        deadline: Date.now() + 15_000, save: async () => {}, ...docker });
      assert.equal(result.usersStopped, false); assert.ok(result.failures.length > 0);
      assert.equal(await inspectProcessEvidence(proof), 'running');
      assert.deepEqual(docker.mutations, []); assert.equal(docker.present.size, 3);
    }
  } finally { if (proof) await stopEvidenceGroup(proof, [], Date.now() + 10_000); else child.kill('SIGKILL'); }
});

test('an unconfirmed service stop retains later database dependencies', async () => {
  const docker = state();
  const result = await cleanupRecoveryResources({ repository, runId: randomUUID(), mode: 'owner', processes: [], resources, deadline: Date.now() + 15_000,
    save: async () => {}, inspect: docker.inspect, stop: async resource => { docker.mutations.push(`stop:${resource.name}`); throw new Error('stop unconfirmed'); }, remove: docker.remove });
  assert.equal(result.usersStopped, true); assert.equal(result.failures.length, 1);
  assert.deepEqual(docker.mutations, ['stop:application']);
  assert.deepEqual([...docker.present], ['application', 'postgres', 'database']);
  assert.equal(result.observations['container:postgres'], 'owned-retained');
  assert.equal(result.observations['volume:database'], 'owned-retained');
});
