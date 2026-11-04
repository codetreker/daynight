import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { waitForContainerPermission, writeContainerPermission, type ContainerPermissionIdentity } from './permission.mts';

const identity: ContainerPermissionIdentity = {
  acceptanceRunId: '20261021123456-01234567-89ab-4cde-8fab-0123456789ab',
  devCiRunId: '20261021123457-1234-56789',
  sourceGitSha: '0123456789abcdef0123456789abcdef01234567',
};
const receipt = { schemaVersion: 1, phase: 'native-prepared', ...identity };
const timeoutCount = (): number => process.getActiveResourcesInfo().filter((type) => type === 'Timeout').length;
const withDirectory = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const temporaryRoot = new URL('../../.tmp/', import.meta.url);
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL('permission-', temporaryRoot)));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};
const waitUntilPolling = async (signal: AbortSignal): Promise<void> => {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (getEventListeners(signal, 'abort').length > 0) return;
    await nextTurn();
  }
  throw new Error('Permission waiter did not start polling.');
};

test('permission published before callback startup is accepted with no temporary files', async () => {
  await withDirectory(async (directory) => {
    const controller = new AbortController();
    const timers = timeoutCount();
    await writeContainerPermission(directory, identity);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'container-permission.json'), 'utf8')), receipt);
    await waitForContainerPermission(directory, identity, { signal: controller.signal, timeoutMs: 1_000 });
    assert.deepEqual(await readdir(directory), ['container-permission.json']);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(timeoutCount(), timers);
  });
});
test('a waiting callback accepts a later atomic permission and removes its abort listener and timer', async () => {
  await withDirectory(async (directory) => {
    const controller = new AbortController();
    const timers = timeoutCount();
    const waiting = waitForContainerPermission(directory, identity, { signal: controller.signal, timeoutMs: 1_000 });
    await waitUntilPolling(controller.signal);
    await writeContainerPermission(directory, identity);
    await waiting;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(timeoutCount(), timers);
    assert.deepEqual(await readdir(directory), ['container-permission.json']);
  });
});
test('invalid schema, phase, identity, and malformed receipts fail immediately', async () => {
  await withDirectory(async (directory) => {
    const controller = new AbortController();
    for (const invalid of [
      { ...receipt, acceptanceRunId: '20261021123456-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      { ...receipt, devCiRunId: '20261021123457-4321-56789' },
      { ...receipt, sourceGitSha: 'a'.repeat(40) },
      { ...receipt, schemaVersion: 2 },
      { ...receipt, phase: 'native-functional-running' },
      { ...receipt, extra: true },
      { schemaVersion: 1, ...identity },
      [], null,
    ]) {
      await writeFile(join(directory, 'container-permission.json'), JSON.stringify(invalid));
      await assert.rejects(waitForContainerPermission(directory, identity, { signal: controller.signal, timeoutMs: 1_000 }), /permission/);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
    await writeFile(join(directory, 'container-permission.json'), '{');
    await assert.rejects(waitForContainerPermission(directory, identity, { signal: controller.signal, timeoutMs: 1_000 }), SyntaxError);
  });
});
test('missing permission times out without leaving polling resources', async () => {
  await withDirectory(async (directory) => {
    const controller = new AbortController();
    const timers = timeoutCount();
    await assert.rejects(waitForContainerPermission(directory, identity, { signal: controller.signal, timeoutMs: 5 }), /timed out/);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(timeoutCount(), timers);
    assert.deepEqual(await readdir(directory), []);
  });
});
test('cancellation interrupts polling and a pre-aborted callback does not read permission', async () => {
  await withDirectory(async (directory) => {
    const controller = new AbortController();
    const timers = timeoutCount();
    const reason = new Error('Acceptance cancelled.');
    const waiting = waitForContainerPermission(directory, identity, { signal: controller.signal, timeoutMs: 1_000 });
    const rejection = assert.rejects(waiting, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    await waitUntilPolling(controller.signal);
    controller.abort(reason);
    await rejection;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(timeoutCount(), timers);
    await writeFile(join(directory, 'container-permission.json'), '{');
    await assert.rejects(waitForContainerPermission(directory, identity, { signal: controller.signal, timeoutMs: 1_000 }), (error: unknown) => error === reason);
    assert.deepEqual(await readdir(directory), ['container-permission.json']);
  });
});
test('invalid invocation identities and paths fail before creating a receipt', async () => {
  await withDirectory(async (directory) => {
    const controller = new AbortController();
    for (const invalid of [
      { ...identity, acceptanceRunId: '20261021123456-not-a-uuid' },
      { ...identity, devCiRunId: '20261021123457-0-56789' },
      { ...identity, sourceGitSha: 'abc' },
    ]) {
      await assert.rejects(writeContainerPermission(directory, invalid), /identity/);
      await assert.rejects(waitForContainerPermission(directory, invalid, { signal: controller.signal, timeoutMs: 100 }), /identity/);
    }
    await assert.rejects(writeContainerPermission('relative', identity), /absolute/);
    await assert.rejects(waitForContainerPermission('relative', identity, { signal: controller.signal, timeoutMs: 100 }), /absolute/);
    for (const timeoutMs of [0, -1, NaN, Infinity]) {
      await assert.rejects(waitForContainerPermission(directory, identity, { signal: controller.signal, timeoutMs }), /timeout/);
    }
    assert.deepEqual(await readdir(directory), []);
  });
});
test('failed atomic publication removes its owned temporary file', async () => {
  await withDirectory(async (directory) => {
    await mkdir(join(directory, 'container-permission.json'));
    await assert.rejects(writeContainerPermission(directory, identity));
    assert.deepEqual(await readdir(directory), ['container-permission.json']);
  });
});
