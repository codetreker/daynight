import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanupOwnedResources, recoverEnvironment, resourceIdentity, writeCleanupReceipt, type DockerCommand, type RecoveryMetadata, type ResourceIdentity } from '../src/recovery.ts';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const directory = async (): Promise<string> => {
  const value = path.join(repository, '.tmp', 'product-e2e', randomUUID());
  await mkdir(path.join(value, 'private'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(value, 'logs'));
  return value;
};
const metadata = async (runDirectory: string, runId: string): Promise<RecoveryMetadata> => {
  const owner = await stat(runDirectory);
  return { schemaVersion: 1, runId, directoryId: path.basename(runDirectory), ownerUid: owner.uid, ownerGid: owner.gid };
};

const fakeDocker = (resources: ResourceIdentity, runId: string, options: { helperFailure?: Error; foreignApplication?: boolean } = {}) => {
  const labels = { 'daynight.e2e.run': runId };
  const objects = new Map<string, unknown>([
    [resources.applicationContainer, { Config: { Labels: options.foreignApplication ? {} : labels }, State: { Running: false, ExitCode: 137 } }],
    [resources.ownershipContainer, { Config: { Labels: labels }, State: { Running: true, ExitCode: 0 } }],
    [resources.postgresContainer, { Config: { Labels: labels }, State: { Running: true, ExitCode: 0 } }],
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
    if (args[1] === 'rm') { objects.delete(args.at(-1)!); return { exitCode: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'logs') return { exitCode: 0, stdout: 'runtime output', stderr: '' };
    if (args[0] === 'create') {
      assert.equal(args[args.indexOf('--network') + 1], 'none');
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

test('ownership helper timeout still removes the helper and all other resources without claiming verified success', async () => {
  const runDirectory = await directory();
  try {
    const runId = randomUUID(), resources = resourceIdentity(runId), failure = new Error('helper timeout');
    const docker = fakeDocker(resources, runId, { helperFailure: failure });
    const result = await cleanupOwnedResources({ repository, runDirectory, resources, metadata: await metadata(runDirectory, runId), mode: 'recovery', applicationStarted: false, execute: docker.execute });
    assert.equal(result.verified, false);
    assert.equal(result.resourcesAbsent, true);
    assert.ok(result.failures.includes(failure));
    assert.equal(docker.objects.size, 0);
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
    const runId = randomUUID(), resources = { ...resourceIdentity(runId), applicationContainer: 'unrelated-container' };
    await writeFile(path.join(runDirectory, 'private', 'keep.txt'), 'keep');
    await writeCleanupReceipt(runDirectory, { ...await metadata(runDirectory, runId), resourceIdentity: resources, state: 'pending', verified: false, resourcesAbsent: false, remaining: [], verificationErrors: [], cleanupErrors: [] });
    await assert.rejects(recoverEnvironment({ repository, runDirectory }), /exactly its run-owned resources/);
    assert.equal(await readFile(path.join(runDirectory, 'private', 'keep.txt'), 'utf8'), 'keep');
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('a canceled build with no runtime receipt only removes private artifacts and records independent recovery', async () => {
  const runDirectory = await directory();
  try {
    await mkdir(path.join(runDirectory, 'artifacts'));
    await writeFile(path.join(runDirectory, 'private', 'fixture.txt'), 'private');
    await recoverEnvironment({ repository, runDirectory, phase: 'build' });
    await assert.rejects(stat(path.join(runDirectory, 'private')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(runDirectory, 'artifacts')), { code: 'ENOENT' });
    const receipt = JSON.parse(await readFile(path.join(runDirectory, 'results', 'environment-recovery.json'), 'utf8'));
    assert.equal(receipt.runtimeRegistered, false);
    assert.equal(receipt.recovery.completed, true);
  } finally { await rm(runDirectory, { recursive: true }); }
});

test('a missing runtime receipt outside a confirmed build phase remains unknown and retains private data', async () => {
  const runDirectory = await directory();
  try {
    await writeFile(path.join(runDirectory, 'private', 'keep.txt'), 'keep');
    await assert.rejects(recoverEnvironment({ repository, runDirectory, phase: 'environment' }), /remain unverified/);
    assert.equal(await readFile(path.join(runDirectory, 'private', 'keep.txt'), 'utf8'), 'keep');
    const receipt = JSON.parse(await readFile(path.join(runDirectory, 'results', 'environment-recovery.json'), 'utf8'));
    assert.equal(receipt.runtimeRegistered, 'unknown');
    assert.equal(receipt.recovery.completed, false);
    assert.equal(receipt.recovery.verified, false);
  } finally { await rm(runDirectory, { recursive: true }); }
});
