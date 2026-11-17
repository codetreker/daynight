import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanupOwnedResources, markBuildComplete, markEnvironmentComplete, recoverEnvironment, resourceIdentity, writeCleanupReceipt, type DockerCommand, type RecoveryMetadata, type ResourceIdentity } from '../src/recovery.ts';
import { initializeRunOwnership } from '../src/fixture-owner.ts';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const directory = async (): Promise<string> => {
  const value = path.join(repository, '.tmp', 'product-e2e', randomUUID());
  await mkdir(path.join(value, 'private'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(value, 'logs'));
  await mkdir(path.join(value, 'results'));
  return value;
};
const metadata = async (runDirectory: string, runId: string): Promise<RecoveryMetadata> => {
  const owner = await stat(runDirectory);
  return { schemaVersion: 1, runId, directoryId: path.basename(runDirectory), ownerUid: owner.uid, ownerGid: owner.gid };
};
const stoppedOwner = (runDirectory: string): void => {
  const module = new URL('../src/fixture-owner.ts', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { initializeRunOwnership } from ${JSON.stringify(module)}; await initializeRunOwnership(process.argv[1], process.argv[2]);`, repository, runDirectory], { timeout: 15_000 });
};
const completedOwner = (runDirectory: string): void => {
  const module = new URL('../src/fixture-owner.ts', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { initializeRunOwnership, recoverRunOwnership } from ${JSON.stringify(module)}; await initializeRunOwnership(process.argv[1], process.argv[2]); await recoverRunOwnership({repository:process.argv[1],runDirectory:process.argv[2],mode:'owner'});`, repository, runDirectory], { timeout: 15_000 });
};

const fakeDocker = (resources: ResourceIdentity, runId: string, options: { helperFailure?: Error; helperCreateFailure?: boolean; foreignApplication?: boolean; foreignRedis?: boolean; redisRemovalFailure?: boolean; missingRedis?: boolean } = {}) => {
  const labels = { 'daynight.e2e.run': runId };
  const objects = new Map<string, unknown>([
    [resources.applicationContainer, { Config: { Labels: options.foreignApplication ? {} : labels }, State: { Running: false, ExitCode: 137 } }],
    [resources.ownershipContainer, { Config: { Labels: labels }, State: { Running: true, ExitCode: 0 } }],
    [resources.postgresContainer, { Config: { Labels: labels }, State: { Running: true, ExitCode: 0 } }],
    ...options.missingRedis ? [] : [[resources.redisContainer, { Config: { Labels: options.foreignRedis ? {} : labels }, State: { Running: true, ExitCode: 0 } }] as [string, unknown]],
    [resources.postgresVolume, { Labels: labels }], [resources.network, { Labels: labels }],
    [resources.ingressNetwork, { Labels: labels }], [resources.runtimeImage, { Config: { Labels: labels } }],
  ]);
  const calls: string[][] = [];
  const execute: DockerCommand = async (arguments_) => {
    const args = [...arguments_];
    calls.push(args);
    if (args[1] === 'inspect') {
      const resource = args[2]!;
      const object = objects.get(resource);
      return object === undefined
        ? { exitCode: 1, stdout: '', stderr: `Error: No such object: ${resource}` }
        : { exitCode: 0, stdout: JSON.stringify([object]), stderr: '' };
    }
    if (args[1] === 'rm') {
      if (options.redisRemovalFailure && args.at(-1) === resources.redisContainer) return { exitCode: 1, stdout: '', stderr: 'Redis removal failed' };
      objects.delete(args.at(-1)!); return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'logs') return { exitCode: 0, stdout: 'runtime output', stderr: '' };
    if (args[0] === 'create') {
      assert.equal(args[args.indexOf('--network') + 1], 'none');
      if (options.helperCreateFailure) return { exitCode: 1, stdout: '', stderr: 'Docker response lost' };
      const resource = args[args.indexOf('--name') + 1]!;
      objects.set(resource, { Config: { Labels: labels }, State: { Running: false, ExitCode: 0 } });
      return { exitCode: 0, stdout: resource, stderr: '' };
    }
    if (args[0] === 'start') {
      if (options.helperFailure !== undefined) throw options.helperFailure;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected fake Docker operation: ${args.join(' ')}`);
  };
  return { objects, calls, execute };
};

test('recovery of a killed application reuses ownership repair before removing images and verifies every resource', async () => {
  const runDirectory = await directory();
  try {
    const runId = randomUUID(), resources = resourceIdentity(runId);
    const docker = fakeDocker(resources, runId);
    const result = await cleanupOwnedResources({ repository, runDirectory, resources, metadata: await metadata(runDirectory, runId), mode: 'recovery', applicationStarted: false, execute: docker.execute });
    assert.equal(result.verified, true);
    assert.equal(result.resourcesAbsent, true);
    assert.equal(docker.objects.size, 0);
    const applicationRemoved = docker.calls.findIndex((args) => args[1] === 'rm' && args.at(-1) === resources.applicationContainer);
    const helperCreated = docker.calls.findIndex((args) => args[0] === 'create');
    const imageRemoved = docker.calls.findIndex((args) => args[1] === 'rm' && args.at(-1) === resources.runtimeImage);
    assert.ok(applicationRemoved < helperCreated && helperCreated < imageRemoved);
    assert.equal(await readFile(path.join(runDirectory, 'logs', 'runtime.stdout.log'), 'utf8'), 'runtime output');
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('partial setup without Redis still verifies all run-owned resources absent', async () => {
  const runDirectory = await directory();
  try {
    const runId = randomUUID(), resources = resourceIdentity(runId);
    const docker = fakeDocker(resources, runId, { missingRedis: true });
    const result = await cleanupOwnedResources({ repository, runDirectory, resources, metadata: await metadata(runDirectory, runId), mode: 'recovery', applicationStarted: false, execute: docker.execute });
    assert.equal(result.verified, true);
    assert.ok(docker.calls.some((args) => args[1] === 'inspect' && args[2] === resources.redisContainer));
    assert.equal(docker.objects.size, 0);
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('unexpected Redis exit fails normal cleanup while still removing all resources', async () => {
  const runDirectory = await directory();
  try {
    const runId = randomUUID(), resources = resourceIdentity(runId);
    const docker = fakeDocker(resources, runId);
    docker.objects.set(resources.redisContainer, { Config: { Labels: { 'daynight.e2e.run': runId } }, State: { Running: false, ExitCode: 1 } });
    const result = await cleanupOwnedResources({ repository, runDirectory, resources, metadata: await metadata(runDirectory, runId), mode: 'normal', applicationStarted: false, redisStarted: true, execute: docker.execute });
    assert.equal(result.verified, false);
    assert.equal(result.resourcesAbsent, true);
    assert.ok(result.cleanupErrors.some((error) => error.includes('Redis exited before requested shutdown')));
    assert.equal(docker.objects.size, 0);
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('Redis removal failures and foreign ownership prevent verified cleanup', async () => {
  for (const options of [{ redisRemovalFailure: true }, { foreignRedis: true }]) {
    const runDirectory = await directory();
    try {
      const runId = randomUUID(), resources = resourceIdentity(runId);
      const docker = fakeDocker(resources, runId, options);
      const result = await cleanupOwnedResources({ repository, runDirectory, resources, metadata: await metadata(runDirectory, runId), mode: 'recovery', applicationStarted: false, execute: docker.execute });
      assert.equal(result.verified, false);
      assert.equal(result.resourcesAbsent, false);
      assert.ok(docker.objects.has(resources.redisContainer));
      if (options.foreignRedis) assert.ok(!docker.calls.some((args) => args[1] === 'rm' && args.at(-1) === resources.redisContainer));
      else assert.ok(result.remaining.includes(resources.redisContainer));
    } finally { await rm(runDirectory, { recursive: true }); }
  }
});

test('legacy receipts lacking Redis identity are rejected without guessing ownership', async () => {
  const runDirectory = await directory();
  try {
    stoppedOwner(runDirectory);
    await markBuildComplete(runDirectory); await markEnvironmentComplete(runDirectory);
    const runId = randomUUID(), resources = resourceIdentity(runId);
    const { redisContainer: _redis, ...legacy } = resources;
    await writeCleanupReceipt(runDirectory, { ...await metadata(runDirectory, runId), resourceIdentity: legacy as ResourceIdentity, state: 'pending', verified: false, resourcesAbsent: false, remaining: [], verificationErrors: [], cleanupErrors: [] });
    await assert.rejects(recoverEnvironment({ repository, runDirectory }), /exactly its run-owned resources/);
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('ownership helper timeout retains its unknown mutation and does not claim successful cleanup', async () => {
  const runDirectory = await directory();
  try {
    const runId = randomUUID(), resources = resourceIdentity(runId), failure = new Error('helper timeout');
    const docker = fakeDocker(resources, runId, { helperFailure: failure });
    const result = await cleanupOwnedResources({ repository, runDirectory, resources, metadata: await metadata(runDirectory, runId), mode: 'recovery', applicationStarted: false, execute: docker.execute });
    assert.equal(result.verified, false);
    assert.equal(result.resourcesAbsent, false);
    assert.ok(result.failures.some(error => error === failure || error instanceof AggregateError && error.errors.includes(failure)));
    assert.ok(docker.objects.has(resources.ownershipContainer));
    assert.equal(JSON.parse(await readFile(path.join(runDirectory, 'results', 'docker-cleanup-intent.json'), 'utf8')).runId, runId);
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('foreign ownership labels prevent container mutation and remain an unverified cleanup result', async () => {
  const runDirectory = await directory();
  try {
    const runId = randomUUID(), resources = resourceIdentity(runId);
    const docker = fakeDocker(resources, runId, { foreignApplication: true });
    const result = await cleanupOwnedResources({ repository, runDirectory, resources, metadata: await metadata(runDirectory, runId), mode: 'recovery', applicationStarted: false, execute: docker.execute });
    assert.equal(result.verified, false);
    assert.equal(result.resourcesAbsent, false);
    assert.ok(docker.objects.has(resources.applicationContainer));
    assert.ok(!docker.calls.some((args) => args[1] === 'rm' && args.at(-1) === resources.applicationContainer));
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('a corrupt resource whitelist is rejected before Docker commands or local deletion', async () => {
  const runDirectory = await directory();
  try {
    stoppedOwner(runDirectory);
    await markBuildComplete(runDirectory); await markEnvironmentComplete(runDirectory);
    const runId = randomUUID(), resources = { ...resourceIdentity(runId), applicationContainer: 'unrelated-container' };
    await writeFile(path.join(runDirectory, 'private', 'keep.txt'), 'keep');
    await writeCleanupReceipt(runDirectory, { ...await metadata(runDirectory, runId), resourceIdentity: resources, state: 'pending', verified: false, resourcesAbsent: false, remaining: [], verificationErrors: [], cleanupErrors: [] });
    await assert.rejects(recoverEnvironment({ repository, runDirectory }), /exactly its run-owned resources/);
    assert.equal(await readFile(path.join(runDirectory, 'private', 'keep.txt'), 'utf8'), 'keep');
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('an interrupted build without completion evidence retains private artifacts', async () => {
  const runDirectory = await directory();
  try {
    stoppedOwner(runDirectory);
    await mkdir(path.join(runDirectory, 'artifacts'));
    await writeFile(path.join(runDirectory, 'private', 'fixture.txt'), 'private');
    await assert.rejects(recoverEnvironment({ repository, runDirectory, phase: 'build' }), /Build process stop is unverified/);
    assert.equal(await readFile(path.join(runDirectory, 'private', 'fixture.txt'), 'utf8'), 'private');
    assert.equal((await stat(path.join(runDirectory, 'artifacts'))).isDirectory(), true);
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('a completed build with no runtime receipt removes private artifacts and records independent recovery', async () => {
  const runDirectory = await directory();
  try {
    stoppedOwner(runDirectory);
    await markBuildComplete(runDirectory);
    await mkdir(path.join(runDirectory, 'artifacts'));
    await writeFile(path.join(runDirectory, 'private', 'fixture.txt'), 'private');
    await recoverEnvironment({ repository, runDirectory, phase: 'build' });
    await assert.rejects(stat(path.join(runDirectory, 'private')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(runDirectory, 'artifacts')), { code: 'ENOENT' });
    const receipt = JSON.parse(await readFile(path.join(runDirectory, 'results', 'environment-recovery.json'), 'utf8'));
    assert.equal(receipt.runtimeRegistered, false);
    assert.equal(receipt.recovery.completed, true);
    await recoverEnvironment({ repository, runDirectory, phase: 'build' });
    const repeated = JSON.parse(await readFile(path.join(runDirectory, 'results', 'environment-recovery.json'), 'utf8'));
    assert.equal(repeated.recovery.completed, true);
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('a missing runtime receipt outside a confirmed build phase remains unknown and retains private data', async () => {
  const runDirectory = await directory();
  try {
    stoppedOwner(runDirectory);
    await markBuildComplete(runDirectory); await markEnvironmentComplete(runDirectory);
    await writeFile(path.join(runDirectory, 'private', 'keep.txt'), 'keep');
    await assert.rejects(recoverEnvironment({ repository, runDirectory, phase: 'environment' }), /remain unverified/);
    assert.equal(await readFile(path.join(runDirectory, 'private', 'keep.txt'), 'utf8'), 'keep');
    const receipt = JSON.parse(await readFile(path.join(runDirectory, 'results', 'environment-recovery.json'), 'utf8'));
    assert.equal(receipt.runtimeRegistered, 'unknown');
    assert.equal(receipt.recovery.completed, false);
    assert.equal(receipt.recovery.verified, false);
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('independent recovery refuses a live runner and retains private state and artifacts', async () => {
  const runDirectory = await directory();
  try {
    await mkdir(path.join(runDirectory, 'artifacts'));
    await writeFile(path.join(runDirectory, 'private', 'keep.txt'), 'private');
    await writeFile(path.join(runDirectory, 'artifacts', 'keep.txt'), 'proof');
    await initializeRunOwnership(repository, runDirectory);
    await markBuildComplete(runDirectory);
    let dockerCalled = false;
    await assert.rejects(recoverEnvironment({ repository, runDirectory, phase: 'build', execute: async () => { dockerCalled = true; throw new Error('Unexpected Docker access.'); } }), /ownership or process stop remains unverified/);
    assert.equal(dockerCalled, false);
    assert.equal(await readFile(path.join(runDirectory, 'private', 'keep.txt'), 'utf8'), 'private');
    assert.equal(await readFile(path.join(runDirectory, 'artifacts', 'keep.txt'), 'utf8'), 'proof');
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('independent recovery accepts a proved normal cleanup after artifacts were removed', async () => {
  const runDirectory = await directory();
  try {
    completedOwner(runDirectory);
    await markBuildComplete(runDirectory);
    await rm(path.join(runDirectory, 'private'), { recursive: true });
    await recoverEnvironment({ repository, runDirectory, phase: 'build' });
    const receipt = JSON.parse(await readFile(path.join(runDirectory, 'results', 'environment-recovery.json'), 'utf8'));
    assert.equal(receipt.recovery.completed, true);
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('missing ownership evidence cannot authorize cleanup even in the build phase', async () => {
  const runDirectory = await directory();
  try {
    await mkdir(path.join(runDirectory, 'artifacts'));
    await writeFile(path.join(runDirectory, 'private', 'keep.txt'), 'private');
    await markBuildComplete(runDirectory);
    await assert.rejects(recoverEnvironment({ repository, runDirectory, phase: 'build' }), /ownership or process stop remains unverified/);
    assert.equal(await readFile(path.join(runDirectory, 'private', 'keep.txt'), 'utf8'), 'private');
    assert.equal((await stat(path.join(runDirectory, 'artifacts'))).isDirectory(), true);
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('failed environment cleanup retains private state and proof binaries', async () => {
  const runDirectory = await directory();
  try {
    stoppedOwner(runDirectory);
    await markBuildComplete(runDirectory); await markEnvironmentComplete(runDirectory);
    await mkdir(path.join(runDirectory, 'artifacts'));
    await writeFile(path.join(runDirectory, 'private', 'keep.txt'), 'private');
    await writeFile(path.join(runDirectory, 'artifacts', 'keep.txt'), 'proof');
    const runId = randomUUID(), resources = resourceIdentity(runId), docker = fakeDocker(resources, runId, { foreignRedis: true });
    await writeCleanupReceipt(runDirectory, { ...await metadata(runDirectory, runId), resourceIdentity: resources, state: 'pending', verified: false, resourcesAbsent: false, remaining: [], verificationErrors: [], cleanupErrors: [] });
    await assert.rejects(recoverEnvironment({ repository, runDirectory, execute: docker.execute }));
    assert.equal(await readFile(path.join(runDirectory, 'private', 'keep.txt'), 'utf8'), 'private');
    assert.equal(await readFile(path.join(runDirectory, 'artifacts', 'keep.txt'), 'utf8'), 'proof');
    assert.ok(docker.objects.has(resources.redisContainer));
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('interrupted environment setup retains evidence and does not inspect Docker', async () => {
  const runDirectory = await directory();
  try {
    stoppedOwner(runDirectory);
    await markBuildComplete(runDirectory);
    await mkdir(path.join(runDirectory, 'artifacts'));
    await writeFile(path.join(runDirectory, 'private', 'keep.txt'), 'private');
    let dockerCalled = false;
    await assert.rejects(recoverEnvironment({ repository, runDirectory, phase: 'environment', execute: async () => { dockerCalled = true; throw new Error('Unexpected Docker access.'); } }), /Environment setup process stop is unverified/);
    assert.equal(dockerCalled, false);
    assert.equal(await readFile(path.join(runDirectory, 'private', 'keep.txt'), 'utf8'), 'private');
    assert.equal((await stat(path.join(runDirectory, 'artifacts'))).isDirectory(), true);
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('an uncertain Docker helper creation blocks later recovery without repeating mutations', async () => {
  const runDirectory = await directory();
  try {
    stoppedOwner(runDirectory);
    await markBuildComplete(runDirectory); await markEnvironmentComplete(runDirectory);
    await mkdir(path.join(runDirectory, 'artifacts'));
    await writeFile(path.join(runDirectory, 'private', 'keep.txt'), 'private');
    const runId = randomUUID(), resources = resourceIdentity(runId), docker = fakeDocker(resources, runId, { helperCreateFailure: true });
    const meta = await metadata(runDirectory, runId);
    await writeCleanupReceipt(runDirectory, { ...meta, resourceIdentity: resources, state: 'pending', verified: false, resourcesAbsent: false, remaining: [], verificationErrors: [], cleanupErrors: [] });
    const first = await cleanupOwnedResources({ repository, runDirectory, resources, metadata: meta, mode: 'recovery', applicationStarted: false, execute: docker.execute });
    assert.equal(first.verified, false);
    assert.equal(JSON.parse(await readFile(path.join(runDirectory, 'results', 'docker-cleanup-intent.json'), 'utf8')).runId, runId);
    let retried = false;
    await assert.rejects(recoverEnvironment({ repository, runDirectory, phase: 'environment', execute: async () => { retried = true; throw new Error('Unexpected Docker access.'); } }), /prior Docker cleanup mutation has an unknown outcome/);
    assert.equal(retried, false);
    assert.equal(await readFile(path.join(runDirectory, 'private', 'keep.txt'), 'utf8'), 'private');
    assert.equal((await stat(path.join(runDirectory, 'artifacts'))).isDirectory(), true);
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('independent Docker recovery is serialized before any second recovery command', async () => {
  const runDirectory = await directory();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let first: Promise<void> | undefined;
  try {
    stoppedOwner(runDirectory);
    await markBuildComplete(runDirectory); await markEnvironmentComplete(runDirectory);
    const runId = randomUUID(), resources = resourceIdentity(runId), docker = fakeDocker(resources, runId);
    const meta = await metadata(runDirectory, runId);
    await writeCleanupReceipt(runDirectory, { ...meta, resourceIdentity: resources, state: 'pending', verified: false, resourcesAbsent: false, remaining: [], verificationErrors: [], cleanupErrors: [] });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let firstCall = true;
    first = recoverEnvironment({ repository, runDirectory, phase: 'environment', execute: async (args, timeout) => {
      if (firstCall) { firstCall = false; entered(); await barrier; }
      return docker.execute(args, timeout);
    } });
    await started;
    let secondCalls = 0;
    await assert.rejects(recoverEnvironment({ repository, runDirectory, phase: 'environment', execute: async () => { secondCalls++; throw new Error('Unexpected concurrent Docker access.'); } }), /locked/);
    assert.equal(secondCalls, 0);
    release();
    await first;
  } finally { release(); await first?.catch(() => {}); await rm(runDirectory, { recursive: true }); }
});

test('ordinary failed setup can complete its boundary only after all commands join', async () => {
  const runDirectory = await directory();
  const command = new URL('../src/command.ts', import.meta.url).href;
  const recovery = new URL('../src/recovery.ts', import.meta.url).href;
  try {
    const script = `import { runCommand } from ${JSON.stringify(command)}; import { completeFailedEnvironmentSetup } from ${JSON.stringify(recovery)};
      try { await runCommand(process.execPath, ['-e', 'process.exit(7)'], {cwd:process.argv[1],timeoutMs:5000,onOutput:()=>{}}); } catch {}
      if (!await completeFailedEnvironmentSetup(process.argv[2], true, false)) throw new Error('Joined failure was not recognized.');`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script, repository, runDirectory], { timeout: 15_000 });
    const marker = JSON.parse(await readFile(path.join(runDirectory, 'results', 'environment-complete.json'), 'utf8'));
    assert.equal(marker.complete, true);
    assert.equal(marker.directoryId, path.basename(runDirectory));
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('a timed-out setup command cannot produce a quiescent environment boundary', async () => {
  const runDirectory = await directory();
  const command = new URL('../src/command.ts', import.meta.url).href;
  const recovery = new URL('../src/recovery.ts', import.meta.url).href;
  try {
    const script = `import { runCommand } from ${JSON.stringify(command)}; import { completeFailedEnvironmentSetup } from ${JSON.stringify(recovery)};
      try { await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {cwd:process.argv[1],timeoutMs:100,onOutput:()=>{}}); } catch {}
      if (await completeFailedEnvironmentSetup(process.argv[2], true, false)) throw new Error('Unknown outcome was treated as settled.');`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script, repository, runDirectory], { timeout: 15_000 });
    await assert.rejects(stat(path.join(runDirectory, 'results', 'environment-complete.json')), { code: 'ENOENT' });
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('a failed Docker mutation cannot produce a quiescent environment boundary', async () => {
  const runDirectory = await directory();
  const command = new URL('../src/command.ts', import.meta.url).href;
  const recovery = new URL('../src/recovery.ts', import.meta.url).href;
  try {
    const docker = path.join(runDirectory, 'private', 'docker');
    await writeFile(docker, '#!/usr/bin/env node\nprocess.exit(1);\n');
    await chmod(docker, 0o700);
    const script = `import { runCommand } from ${JSON.stringify(command)}; import { completeFailedEnvironmentSetup } from ${JSON.stringify(recovery)};
      try { await runCommand('docker', ['run'], {cwd:process.argv[1],timeoutMs:5000,onOutput:()=>{}}); } catch {}
      if (await completeFailedEnvironmentSetup(process.argv[2], true, false)) throw new Error('Docker outcome was treated as settled.');`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script, repository, runDirectory], { timeout: 15_000, env: { ...process.env, PATH: `${path.dirname(docker)}${path.delimiter}${process.env.PATH ?? ''}` } });
    await assert.rejects(stat(path.join(runDirectory, 'results', 'environment-complete.json')), { code: 'ENOENT' });
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('environment startup retains ownership after a Docker mutation has an unknown outcome', async () => {
  const runDirectory = await directory();
  const environment = new URL('../src/environment.ts', import.meta.url).href;
  try {
    const docker = path.join(runDirectory, 'private', 'docker'), log = path.join(runDirectory, 'docker-calls.jsonl'), artifacts = path.join(runDirectory, 'artifacts');
    await mkdir(artifacts);
    await writeFile(path.join(artifacts, 'daynight-ca.pem'), 'fixture certificate');
    await writeFile(docker, '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.E2E_DOCKER_TEST_LOG, JSON.stringify(process.argv.slice(2))+"\\n"); process.exit(1);\n');
    await chmod(docker, 0o700);
    const script = `import { startEnvironment } from ${JSON.stringify(environment)};
      try { await startEnvironment({repository:process.argv[1],runDirectory:process.argv[2],artifactsDirectory:process.argv[3]}); throw new Error('Unexpected success'); }
      catch (error) { if (!String(error).includes('outcome is unconfirmed')) throw error; }`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script, repository, runDirectory, artifacts], { timeout: 15_000, env: { ...process.env, PATH: `${path.dirname(docker)}${path.delimiter}${process.env.PATH ?? ''}`, E2E_DOCKER_TEST_LOG: log }, stdio: 'pipe' });
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.slice(0, 2), ['network', 'create']);
    const receipt = JSON.parse(await readFile(path.join(runDirectory, 'results', 'environment-cleanup.json'), 'utf8'));
    assert.equal(receipt.state, 'pending');
    assert.equal((await stat(artifacts)).isDirectory(), true);
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('CI recovery removes only a successfully verified run pointer so the location can be reused', async () => {
  const runDirectory = await directory();
  const pointer = path.join(repository, '.tmp', `e2e-pointer-${randomUUID()}.json`);
  try {
    stoppedOwner(runDirectory);
    await markBuildComplete(runDirectory);
    await writeFile(pointer, JSON.stringify({ schemaVersion: 1, runDirectory, phase: 'build' }));
    execFileSync(process.execPath, [fileURLToPath(new URL('../src/ci-cleanup.ts', import.meta.url))], { env: { ...process.env, DAYNIGHT_E2E_RUN_POINTER: pointer }, timeout: 20_000 });
    await assert.rejects(stat(pointer), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(runDirectory, 'private')), { code: 'ENOENT' });
  } finally { await rm(pointer, { force: true }); await rm(runDirectory, { recursive: true }); }
});

test('CI recovery preserves the pointer and private state when ownership is unavailable', async () => {
  const runDirectory = await directory();
  const pointer = path.join(repository, '.tmp', `e2e-pointer-${randomUUID()}.json`);
  try {
    await writeFile(path.join(runDirectory, 'private', 'keep.txt'), 'private');
    await markBuildComplete(runDirectory);
    await writeFile(pointer, JSON.stringify({ schemaVersion: 1, runDirectory, phase: 'build' }));
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('../src/ci-cleanup.ts', import.meta.url))], { env: { ...process.env, DAYNIGHT_E2E_RUN_POINTER: pointer }, timeout: 20_000, stdio: 'pipe' }));
    assert.equal((await stat(pointer)).isFile(), true);
    assert.equal(await readFile(path.join(runDirectory, 'private', 'keep.txt'), 'utf8'), 'private');
  } finally { await rm(pointer, { force: true }); await rm(runDirectory, { recursive: true }); }
});
