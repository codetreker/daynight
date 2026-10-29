import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { lstat, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { StorageReceipt } from './storage.mts';
import { acceptanceEvidenceSchemaVersion } from './evidence.mts';
import { createAuthCombinedTarget, type CombinedCommand, type CombinedTarget } from './auth-combined-target.mts';
import { AuthCombinedTransportError, startAuthCombinedUpload, type AuthCombinedTransportCategory, type AuthCombinedUploadOptions, type PausedUpload } from './auth-combined-transport.mts';
import { launchAuthCombinedBrowser, validateAuthCombinedReceipt, type AuthCombinedReceipt, type RestartReceipt } from './auth-combined.mts';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const sourceGitSha = '0123456789abcdef0123456789abcdef01234567';
const projectId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const patId = '44444444-4444-4444-8444-444444444444';
const marker = 'dnpat_combined-private-marker';
const cookieMarker = 'Cookie=combined-private-marker';
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const prefix = Buffer.from([0, 255, 128, 10, 1, 2, 3, 4]);
const upload = { projectId, taskId, userId, path: "nested/quote ' $() 文档.bin", prefixBytes: prefix.length, prefixSha256: hash(prefix) };
const emptyObservation = { temporaryFiles: 0, temporaryBytes: 0, temporarySha256: null, finalExists: false, metadataRows: 0, memberRows: 1, memberVersion: '9223372036854775807' };
const within = async <T,>(promise: Promise<T>): Promise<T> => {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('Combined unit resource did not settle within its bound.')), 3_000);
    })]);
  } finally { clearTimeout(deadline); }
};
const safeFailure = async (promise: Promise<unknown>, category?: AuthCombinedTransportCategory): Promise<Error> => {
  let failure: unknown;
  try { await within(promise); } catch (error) { failure = error; }
  assert.equal(failure instanceof Error, true, 'The operation must fail with an Error.');
  const error = failure as Error;
  const diagnostic = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  assert.equal(diagnostic.includes(marker) || diagnostic.includes(cookieMarker), false, 'Private markers must not enter failure diagnostics.');
  assert.equal(error.cause === undefined, true, 'The diagnostic boundary must not retain the underlying cause.');
  if (category !== undefined) {
    assert.equal(error instanceof AuthCombinedTransportError, true, 'Transport refusals retain their public category.');
    assert.equal((error as AuthCombinedTransportError).category, category);
  }
  return error;
};

type RecordedCommand = { file: string; args: readonly string[] };
type TargetFixture = {
  target: CombinedTarget;
  run: CombinedCommand;
  calls: RecordedCommand[];
  state: { postgresLabel: string; service: string; serverIdentity: string; files: string; database: unknown; expiry: unknown; failure: Error | null };
};
const withTarget = async (kind: CombinedTarget['target'], action: (fixture: TargetFixture) => Promise<void>): Promise<void> => {
  const acceptanceDirectory = join(repository, 'packages/daynight-web/.tmp/acceptance', `20261023000000-${randomUUID()}`);
  const owner = `daynight-web-${basename(acceptanceDirectory)}`;
  const composeProject = 'daynight-dev-ci-20261023000000-1234-56789';
  const target: CombinedTarget = { target: kind, baseUrl: 'http://127.0.0.1:12345', sourceGitSha, acceptanceDirectory,
    postgresContainer: kind === 'native' ? `${owner}-postgres` : 'a'.repeat(64),
    projectLabel: kind === 'native' ? { key: 'io.daynight.acceptance.run', value: owner } : { key: 'com.docker.compose.project', value: composeProject },
    database: 'daynight', storage: kind === 'native' ? { kind: 'native', root: join(acceptanceDirectory, 'native-storage/data') }
      : { kind: 'container', root: '/var/lib/daynight/storage', containerId: 'b'.repeat(64), imageId: `sha256:${'c'.repeat(64)}` } };
  await mkdir(acceptanceDirectory, { recursive: true });
  let storage: StorageReceipt | undefined;
  if (target.storage.kind === 'native') {
    await mkdir(target.storage.root, { recursive: true });
    const directory = join(acceptanceDirectory, 'native-storage');
    const identity = await lstat(directory, { bigint: true });
    storage = { schemaVersion: 1, platform: process.platform as 'linux' | 'darwin', directory,
      directoryIdentity: { device: String(identity.dev), inode: String(identity.ino) },
      root: target.storage.root, mode: 'directory', phase: 'ready' };
    await writeFile(join(directory, 'storage-receipt.json'), JSON.stringify(storage));
  }
  await writeFile(join(acceptanceDirectory, 'evidence.json'), JSON.stringify({ schemaVersion: acceptanceEvidenceSchemaVersion, scope: 'all', runId: basename(acceptanceDirectory),
    source: { gitSha: sourceGitSha, gitTreeSha: 'b'.repeat(40), githubSha: null, dirty: true },
    ...(storage === undefined ? {} : { native: { storageRoot: storage.directory, storage } }) }));
  const calls: RecordedCommand[] = [];
  const state = { postgresLabel: target.projectLabel.value, service: 'postgres', serverIdentity: `${composeProject}|server|sha256:${'c'.repeat(64)}`,
    files: '0\t0\t-\t0', database: { metadataRows: 0, memberRows: 1, memberVersion: '9223372036854775807' } as unknown,
    expiry: [{ id: patId, userId, expiresAt: '2026-10-23T00:00:00.000001+00:00' }] as unknown, failure: null as Error | null };
  const run: CombinedCommand = async (file, args, options) => {
    calls.push({ file, args: [...args] });
    assert.equal(file, 'docker');
    assert.equal(options?.quiet, true, 'Control output must remain private.');
    assert.equal(Number.isInteger(options?.timeoutMs) && options!.timeoutMs! > 0 && options!.timeoutMs! <= 15_000, true);
    if (state.failure !== null) throw state.failure;
    if (args[0] === 'inspect') {
      if (args.at(-1) === target.postgresContainer) return args[2]!.includes('com.docker.compose.service') ? state.service : state.postgresLabel;
      return state.serverIdentity;
    }
    if (args[0] === 'exec' && args[1] === target.postgresContainer) return JSON.stringify(args.at(-1)!.startsWith('WITH expired') ? state.expiry : state.database);
    if (args[0] === 'exec' && target.storage.kind === 'container' && args[1] === target.storage.containerId) return state.files;
    throw new Error('Unexpected combined unit control command.');
  };
  try { await action({ target, run, calls, state }); }
  finally { await rm(acceptanceDirectory, { recursive: true, force: true }); }
};

test('target controls admit current parent evidence for complete and matching standalone scopes', async () => {
  for (const kind of ['native', 'container'] as const) await withTarget(kind, async ({ target, run, calls }) => {
    const path = join(target.acceptanceDirectory, 'evidence.json');
    const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const controls = createAuthCombinedTarget(target, run);
    for (const scope of ['all', kind]) {
      calls.length = 0;
      await writeFile(path, JSON.stringify({ ...original, scope }));
      assert.deepEqual(await controls.observeUpload(upload), emptyObservation);
      assert.equal((await controls.expirePAT({ id: patId, userId })).id, patId);
      assert.equal(calls.some(({ args }) => args[0] === 'exec' && args[1] === target.postgresContainer), true);
    }
  });
});

test('target source admission rejects old schemas and absent or foreign scopes before control commands', async () => {
  for (const kind of ['native', 'container'] as const) await withTarget(kind, async ({ target, run, calls }) => {
    const path = join(target.acceptanceDirectory, 'evidence.json');
    const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const { scope: _scope, ...withoutScope } = original;
    const controls = createAuthCombinedTarget(target, run);
    for (const changed of [
      { ...original, schemaVersion: 3 },
      withoutScope,
      { ...original, scope: kind === 'native' ? 'container' : 'native' },
      { ...original, scope: 'unknown' },
      { ...original, source: { ...(original.source as Record<string, unknown>), gitTreeSha: marker } },
    ]) {
      calls.length = 0;
      await writeFile(path, JSON.stringify(changed));
      await safeFailure(controls.observeUpload(upload));
      await safeFailure(controls.expirePAT({ id: patId, userId }));
      assert.equal(calls.length, 0, 'Invalid parent admission must precede even read-only Docker controls.');
    }
  });
});

test('native observations distinguish an admitted prefix, publication and discarded upload with exact member versions', async () => {
  await withTarget('native', async ({ target, run, state, calls }) => {
    assert.equal(target.storage.kind, 'native');
    const controls = createAuthCombinedTarget(target, run);
    assert.deepEqual(await controls.observeUpload(upload), emptyObservation);
    const legacyDirectory = join(target.storage.root, 'task-attachments', taskId, 'nested');
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(join(legacyDirectory, '.daynight-upload-obsolete'), prefix);
    assert.deepEqual(await controls.observeUpload(upload), emptyObservation);
    const taskRoot = join(target.storage.root, 'task-attachments', projectId, taskId.slice(0, 2), taskId);
    const directory = join(taskRoot, 'nested');
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, '.daynight-upload-owned');
    await writeFile(temporary, prefix);
    await writeFile(join(directory, 'unrelated.txt'), 'Existing attachment');
    assert.deepEqual(await controls.observeUpload(upload), { ...emptyObservation, temporaryFiles: 1, temporaryBytes: prefix.length, temporarySha256: hash(prefix) });
    await writeFile(temporary, Buffer.concat([prefix, Buffer.from('tail')]));
    const incomplete = await controls.observeUpload(upload);
    assert.equal(incomplete.temporaryBytes, prefix.length + 4);
    assert.equal(incomplete.temporarySha256, null);
    await rename(temporary, join(directory, basename(upload.path)));
    state.database = { metadataRows: 1, memberRows: 1, memberVersion: '9223372036854775807' };
    assert.deepEqual(await controls.observeUpload(upload), { ...emptyObservation, finalExists: true, metadataRows: 1 });
    await rm(taskRoot, { recursive: true });
    state.database = { metadataRows: 0, memberRows: 0, memberVersion: null };
    assert.deepEqual(await controls.observeUpload(upload), { ...emptyObservation, memberRows: 0, memberVersion: null });
    const queries = calls.filter(({ args }) => args[0] === 'exec').map(({ args }) => args.at(-1)!);
    assert.equal(queries.every((query) => query.startsWith('SELECT ') && !query.includes(upload.path)), true, 'Read observations encode attachment paths and never mutate rows.');
  });
});

test('native observation refuses ambiguous temporary files and filesystem aliases', async () => {
  await withTarget('native', async ({ target, run }) => {
    const controls = createAuthCombinedTarget(target, run);
    const taskRoot = join(target.storage.root, 'task-attachments', projectId, taskId.slice(0, 2), taskId);
    const directory = join(taskRoot, 'nested');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '.daynight-upload-one'), prefix);
    await writeFile(join(directory, '.daynight-upload-two'), prefix);
    const observed = await controls.observeUpload(upload);
    assert.equal(observed.temporaryFiles, 2);
    assert.equal(observed.temporaryBytes, prefix.length * 2);
    assert.equal(observed.temporarySha256, null);
    await rm(directory, { recursive: true });
    await symlink(target.acceptanceDirectory, directory, 'dir');
    await safeFailure(controls.observeUpload(upload));
  });
});

test('native observations reject directory aliases at each project, shard and task boundary', async () => {
  for (const segments of [[projectId], [projectId, taskId.slice(0, 2)], [projectId, taskId.slice(0, 2), taskId]]) {
    await withTarget('native', async ({ target, run }) => {
      const controls = createAuthCombinedTarget(target, run);
      const parent = join(target.storage.root, 'task-attachments', ...segments.slice(0, -1));
      await mkdir(parent, { recursive: true });
      await symlink(target.acceptanceDirectory, join(parent, segments.at(-1)!), 'dir');
      await safeFailure(controls.observeUpload(upload));
    });
  }
});

test('target controls reject invalid paths, source receipts and changed PostgreSQL ownership before SQL', async () => {
  await withTarget('native', async ({ target, run, calls, state }) => {
    assert.throws(() => createAuthCombinedTarget({ ...target, storage: { kind: 'native', root: target.acceptanceDirectory } }, run), /ownership validation/);
    const controls = createAuthCombinedTarget(target, run);
    for (const path of ['../escape', '/absolute', 'nested//file', 'nested/./file', 'nested\\file', 'nested/\0file']) await safeFailure(controls.observeUpload({ ...upload, path }));
    assert.equal(calls.length, 0);
    const originalEvidence = JSON.parse(await readFile(join(target.acceptanceDirectory, 'evidence.json'), 'utf8'));
    await writeFile(join(target.acceptanceDirectory, 'evidence.json'), JSON.stringify({ ...originalEvidence, source: { ...originalEvidence.source, gitSha: 'f'.repeat(40) } }));
    await safeFailure(controls.observeUpload(upload));
    assert.equal(calls.length, 0);
    await writeFile(join(target.acceptanceDirectory, 'evidence.json'), JSON.stringify(originalEvidence));
    state.postgresLabel = 'another-run';
    await safeFailure(controls.observeUpload(upload));
    assert.equal(calls.some(({ args }) => args[0] === 'exec'), false);
    state.postgresLabel = target.projectLabel.value;
    state.failure = new Error(`${cookieMarker}; Authorization: Bearer ${marker}`);
    await safeFailure(controls.expirePAT({ id: patId, userId }));
  });
});

test('native target observation binds the ready storage journal before database commands', async () => {
  await withTarget('native', async ({ target, run, calls }) => {
    const path = join(target.acceptanceDirectory, 'evidence.json');
    const evidence = JSON.parse(await readFile(path, 'utf8'));
    const controls = createAuthCombinedTarget(target, run);
    for (const changed of [
      { ...evidence, schemaVersion: 2 },
      { ...evidence, native: { ...evidence.native, storage: undefined } },
      { ...evidence, native: { ...evidence.native, storage: { ...evidence.native.storage, phase: 'planned' } } },
      { ...evidence, native: { ...evidence.native, storage: { ...evidence.native.storage, directoryIdentity: { device: '0', inode: '0' } } } },
      { ...evidence, native: { ...evidence.native, storage: { ...evidence.native.storage, root: join(target.acceptanceDirectory, 'native-storage/mount/data') } } },
    ]) {
      await writeFile(path, JSON.stringify(changed));
      await safeFailure(controls.observeUpload(upload));
      assert.equal(calls.length, 0);
    }
    await writeFile(path, JSON.stringify(evidence));
    await writeFile(join(evidence.native.storageRoot, 'storage-receipt.json'), JSON.stringify({ ...evidence.native.storage, phase: 'planned' }));
    await safeFailure(controls.observeUpload(upload));
    assert.equal(calls.length, 0);
    await writeFile(join(evidence.native.storageRoot, 'storage-receipt.json'), JSON.stringify(evidence.native.storage));
    assert.deepEqual(await controls.observeUpload(upload), emptyObservation);
  });
});

test('container probes require server project, service and image before positional read-only filesystem execution', async () => {
  await withTarget('container', async ({ target, run, calls, state }) => {
    const controls = createAuthCombinedTarget(target, run);
    for (const serverIdentity of ['another-project|server|image', `${target.projectLabel.value}|postgres|sha256:${'c'.repeat(64)}`, `${target.projectLabel.value}|server|sha256:${'d'.repeat(64)}`]) {
      state.serverIdentity = serverIdentity;
      const before = calls.length;
      await safeFailure(controls.observeUpload(upload));
      assert.equal(calls.slice(before).some(({ args }) => args[0] === 'exec'), false);
    }
    state.serverIdentity = `${target.projectLabel.value}|server|sha256:${'c'.repeat(64)}`;
    state.files = `1\t${prefix.length}\t${hash(prefix)}\t0`;
    assert.deepEqual(await controls.observeUpload(upload), { ...emptyObservation, temporaryFiles: 1, temporaryBytes: prefix.length, temporarySha256: hash(prefix) });
    const probe = calls.find(({ args }) => args[0] === 'exec' && args[1] !== target.postgresContainer)!;
    assert.equal(probe.args[2], 'sh');
    assert.equal(probe.args[3], '-c');
    assert.equal(probe.args[4]!.includes(upload.path), false, 'The fixed shell program must receive paths only as positional arguments.');
    assert.deepEqual(probe.args.slice(6), [target.storage.root, projectId, taskId.slice(0, 2), taskId,
      'nested', basename(upload.path), String(prefix.length)]);
    assert.equal(probe.args.at(-2), basename(upload.path));
    assert.equal(probe.args.at(-1), String(prefix.length));
    state.files = '0\t0\t-\t0';
    assert.deepEqual(await controls.observeUpload(upload), emptyObservation);
    for (const files of ['1\t8\tinvalid\t0', '1\t8\t-\t2', '9007199254740992\t8\t-\t0', '0\t0\t-\t0\textra']) {
      state.files = files;
      await safeFailure(controls.observeUpload(upload));
    }
  });
});

test('database observations preserve int64 versions and reject inconsistent membership projections', async () => {
  await withTarget('native', async ({ target, run, state }) => {
    const controls = createAuthCombinedTarget(target, run);
    for (const database of [{ metadataRows: 2, memberRows: 1, memberVersion: '1' }, { metadataRows: 0, memberRows: 0, memberVersion: '1' },
      { metadataRows: 0, memberRows: 1, memberVersion: 9007199254740992 }, { metadataRows: 0, memberRows: 1, memberVersion: '9223372036854775808' }]) {
      state.database = database;
      await safeFailure(controls.observeUpload(upload));
    }
  });
});

test('PAT expiry changes only the exact normally minted credential expiration and requires one returned row', async () => {
  await withTarget('native', async ({ target, run, calls, state }) => {
    const controls = createAuthCombinedTarget(target, run);
    assert.deepEqual(await controls.expirePAT({ id: patId, userId }), (state.expiry as unknown[])[0]);
    const query = calls.find(({ args }) => args[0] === 'exec')!.args.at(-1)!;
    assert.match(query, /UPDATE personal_access_tokens SET expires_at=created_at\+interval '1 microsecond'/);
    assert.equal(/SET\s+created_at\s*=|,\s*created_at\s*=/.test(query), false);
    assert.equal(query.includes(`WHERE id='${patId}' AND user_id='${userId}'`), true);
    assert.equal(query.includes("created_at+interval '1 microsecond'<clock_timestamp()"), true);
    for (const expiry of [[], [{ id: patId, userId, expiresAt: 'invalid' }], [{ id: taskId, userId, expiresAt: '2026-10-23T00:00:00Z' }],
      [{ id: patId, userId, expiresAt: '2026-10-23T00:00:00Z' }, { id: patId, userId, expiresAt: '2026-10-23T00:00:00Z' }]]) {
      state.expiry = expiry;
      await safeFailure(controls.expirePAT({ id: patId, userId }));
    }
    const before = calls.length;
    await safeFailure(controls.expirePAT({ id: '../invalid', userId }));
    assert.equal(calls.length, before);
  });
});

const withHTTP = async (handler: (request: IncomingMessage, response: ServerResponse) => void,
  action: (origin: string) => Promise<void>): Promise<void> => {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => { request.on('error', () => {}); response.on('error', () => {}); handler(request, response); });
  server.on('connection', (socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The unit HTTP listener has no loopback address.');
  try { await action(`http://127.0.0.1:${address.port}`); }
  finally {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(new Error('The unit HTTP server failed to close.'))));
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await within(closed);
  }
};
const body = Buffer.concat([prefix, Buffer.alloc(32_768, 173)]);
const options = (origin: string, controller: AbortController, overrides: Partial<AuthCombinedUploadOptions> = {}): AuthCombinedUploadOptions => ({
  origin, path: `/api/v1/projects/${projectId}/tasks/${taskId}/attachments/files/probe.bin`, token: marker,
  body, prefixBytes: prefix.length, requestId: 'combined-unit-upload', signal: controller.signal, timeoutMs: 2_000, ...overrides,
});
const closeUpload = async (upload: PausedUpload | undefined): Promise<void> => {
  if (upload === undefined) return;
  try { await within(upload.close()); } catch (error) {
    assert.equal(error instanceof AuthCombinedTransportError, true, 'Cleanup may only retain the classified transport failure.');
  }
};

test('real HTTP upload exposes only its prefix until release and preserves binary bytes and response identity', async () => {
  const admitted = Promise.withResolvers<void>();
  let received = Buffer.alloc(0); let authorizationMatches = false; let contentLength = '';
  await withHTTP((request, response) => {
    authorizationMatches = request.headers.authorization === `Bearer ${marker}`;
    contentLength = request.headers['content-length']!;
    request.on('data', (chunk: Buffer) => { received = Buffer.concat([received, chunk]); if (received.length >= prefix.length) admitted.resolve(); });
    request.once('end', () => { response.writeHead(201, { 'Content-Type': 'application/json', 'X-Request-ID': 'combined-unit-response' }); response.end('{"saved":true}'); });
  }, async (origin) => {
    const controller = new AbortController(); let paused: PausedUpload | undefined;
    try {
      paused = await startAuthCombinedUpload(options(origin, controller));
      await within(admitted.promise);
      assert.equal(authorizationMatches, true, 'The server receives the intended credential without exposing it in diagnostics.');
      assert.equal(Number(contentLength), body.length);
      assert.deepEqual(received, prefix);
      assert.equal(paused.sentBytes, prefix.length);
      assert.equal(paused.completed, false);
      const first = paused.complete();
      assert.equal(paused.complete() === first, true, 'Completion is a single controlled write operation.');
      const response = await within(first);
      assert.deepEqual(received, body);
      assert.equal(paused.sentBytes, body.length);
      assert.equal(paused.completed, true);
      assert.deepEqual(response, { status: 201, contentType: 'application/json', requestId: 'combined-unit-response', body: Buffer.from('{"saved":true}') });
      await within(paused.socketClosed);
      await paused.close(); await paused.close();
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally { await closeUpload(paused); }
  });
});

test('intentional HTTP disconnect sends no suffix and waits for socket closure without hiding an unexpected failure', async () => {
  const admitted = Promise.withResolvers<void>(); const aborted = Promise.withResolvers<void>();
  let bytes = 0; let ended = false;
  await withHTTP((request) => {
    request.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes >= prefix.length) admitted.resolve(); });
    request.once('aborted', aborted.resolve); request.once('end', () => { ended = true; });
  }, async (origin) => {
    const controller = new AbortController(); let paused: PausedUpload | undefined;
    try {
      paused = await startAuthCombinedUpload(options(origin, controller));
      await within(admitted.promise);
      const first = paused.disconnect();
      assert.equal(paused.disconnect() === first, true);
      await within(first); await within(paused.socketClosed); await within(aborted.promise);
      await safeFailure(paused.response, 'disconnected');
      await safeFailure(paused.complete(), 'disconnected');
      assert.equal(paused.completed, true); assert.equal(bytes, prefix.length); assert.equal(ended, false);
      await paused.close();
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally { await closeUpload(paused); }
  });
});

test('an unexpected server reset stays a transport failure through response, disconnect and cleanup', async () => {
  const admitted = Promise.withResolvers<Socket>();
  await withHTTP((request) => { request.once('data', () => admitted.resolve(request.socket)); }, async (origin) => {
    const controller = new AbortController(); let paused: PausedUpload | undefined;
    try {
      paused = await startAuthCombinedUpload(options(origin, controller));
      (await within(admitted.promise)).destroy(new Error(`${marker} ${cookieMarker}`));
      await safeFailure(paused.response, 'transport');
      await safeFailure(paused.disconnect(), 'transport');
      await safeFailure(paused.close(), 'transport');
      await within(paused.socketClosed);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally { await closeUpload(paused); }
  });
});

test('an unfinished real HTTP request hits its deadline and releases its cancellation listener', async () => {
  const aborted = Promise.withResolvers<void>();
  await withHTTP((request) => { request.resume(); request.once('aborted', aborted.resolve); }, async (origin) => {
    const controller = new AbortController(); let paused: PausedUpload | undefined;
    try {
      paused = await startAuthCombinedUpload(options(origin, controller, { timeoutMs: 100 }));
      await safeFailure(paused.response, 'timeout');
      await safeFailure(paused.close(), 'timeout');
      await within(aborted.promise);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally { await closeUpload(paused); }
  });
});

test('caller cancellation exposes only its public category and drains the request socket', async () => {
  const admitted = Promise.withResolvers<void>(); const aborted = Promise.withResolvers<void>();
  await withHTTP((request) => { request.once('data', admitted.resolve); request.once('aborted', aborted.resolve); }, async (origin) => {
    const controller = new AbortController(); let paused: PausedUpload | undefined;
    try {
      paused = await startAuthCombinedUpload(options(origin, controller));
      await within(admitted.promise);
      controller.abort(new Error(`${cookieMarker} ${marker}`));
      await safeFailure(paused.response, 'aborted');
      await safeFailure(paused.close(), 'aborted');
      await within(paused.socketClosed); await within(aborted.promise);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally { await closeUpload(paused); }
  });
});

test('credential-bearing response content and headers produce fixed response failures', async () => {
  for (const leak of ['body', 'content-type', 'request-id'] as const) {
    await withHTTP((request, response) => {
      request.resume();
      request.once('end', () => {
        response.writeHead(200, { 'Content-Type': leak === 'content-type' ? `text/${marker}` : 'text/plain', 'X-Request-ID': leak === 'request-id' ? marker : 'combined-safe-response' });
        response.end(leak === 'body' ? marker : 'Safe body');
      });
    }, async (origin) => {
      let paused: PausedUpload | undefined;
      try {
        paused = await startAuthCombinedUpload(options(origin, new AbortController()));
        await safeFailure(paused.complete(), 'response');
        await safeFailure(paused.close(), 'response');
      } finally { await closeUpload(paused); }
    });
  }
});

test('unsafe configuration and pre-aborted signals never reach the HTTP listener or reveal private input', async () => {
  let requests = 0;
  await withHTTP((_request, response) => { requests++; response.end(); }, async (origin) => {
    for (const change of [{ origin: `${origin}/${cookieMarker}` }, { path: `/file/${marker}` }, { token: `${marker}\n${cookieMarker}` }, { prefixBytes: body.length }, { timeoutMs: 0 }]) {
      await safeFailure(startAuthCombinedUpload(options(origin, new AbortController(), change)), 'configuration');
    }
    const controller = new AbortController(); controller.abort(new Error(`${cookieMarker} ${marker}`));
    await safeFailure(startAuthCombinedUpload(options(origin, controller)), 'aborted');
    assert.equal(requests, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
});

const receiptChecks = ['partial-sharing', 'normal-member-writes', 'bilingual-token', 'same-data-cli-browser',
  'restart-original-state', 'logout-independent-pat', 'pat-revocation', 'socket-disconnect',
  'admitted-member-removal', 'expired-pat', 'secret-scan'];
const combinedReceipt = (target: CombinedTarget): AuthCombinedReceipt => {
  const restart: RestartReceipt = { target: target.target, origin: target.baseUrl,
    startedAt: '2026-10-23T00:00:00Z', readyAt: '2026-10-23T00:00:01Z',
    before: { pid: 101, start: '1001' }, after: { pid: 202, start: '2002' },
    binaryOrImage: target.storage.kind === 'container' ? target.storage.imageId : 'a'.repeat(64),
    ...(target.storage.kind === 'container' ? { containerId: target.storage.containerId } : {}) };
  return { schemaVersion: 1, kind: 'auth-combined', target: target.target, sourceGitSha: target.sourceGitSha,
    origin: target.baseUrl, result: 'passed', startedAt: '2026-10-23T00:00:00Z', finishedAt: '2026-10-23T00:00:02Z',
    cleanup: 'passed', browserCleanup: 'passed', browser: { name: 'chromium', version: '151.0.7922.34', platform: process.platform, executableOverride: false },
    installedCli: { version: '0.9.0', sourceGitSha: target.sourceGitSha, entrySha256: '1'.repeat(64), tarballSha256: '2'.repeat(64) },
    checks: receiptChecks.map((name) => ({ name, result: 'passed', details: {} })),
    screenshots: [join(target.acceptanceDirectory, 'auth-combined/sharing.png'), join(target.acceptanceDirectory, 'auth-combined/persistence.png')],
    commands: [], commandGroups: [], restart };
};

test('complete combined receipts retain exact native and container target identities', async () => {
  for (const kind of ['native', 'container'] as const) await withTarget(kind, async ({ target }) => {
    const receipt = combinedReceipt(target);
    assert.equal(validateAuthCombinedReceipt(receipt, target), receipt);
    assert.equal(receipt.checks.length, 11);
    assert.equal(new Set(receipt.checks.map(({ name }) => name)).size, 11);
  });
});

test('combined receipts reject another source, target or origin and unfinished results', async () => {
  await withTarget('native', async ({ target }) => {
    const receipt = combinedReceipt(target);
    for (const changed of [{ schemaVersion: 2 }, { kind: 'another-kind' }, { target: 'container' }, { sourceGitSha: 'f'.repeat(40) },
      { origin: 'http://127.0.0.1:54321' }, { result: 'running' }, { result: 'failed' }]) {
      assert.throws(() => validateAuthCombinedReceipt({ ...receipt, ...changed }, target), /identity or cleanup differs/);
    }
    assert.throws(() => validateAuthCombinedReceipt(null, target), /receipt is missing/);
  });
});

test('combined receipts cannot pass while either browser or target cleanup is incomplete', async () => {
  await withTarget('native', async ({ target }) => {
    const receipt = combinedReceipt(target);
    for (const changed of [{ cleanup: 'pending' }, { cleanup: 'failed' }, { browserCleanup: 'not-started' },
      { browserCleanup: 'pending' }, { browserCleanup: 'failed' }]) {
      assert.throws(() => validateAuthCombinedReceipt({ ...receipt, ...changed }, target), /identity or cleanup differs/);
    }
  });
});

test('each of the eleven combined checks is mandatory exactly once with a passing result', async () => {
  await withTarget('native', async ({ target }) => {
    const receipt = combinedReceipt(target);
    for (const omitted of receiptChecks) {
      const checks = receipt.checks.filter(({ name }) => name !== omitted);
      assert.throws(() => validateAuthCombinedReceipt({ ...receipt, checks }, target), /every required result exactly once/);
    }
    for (const checks of [
      [receipt.checks[0]!, ...receipt.checks.slice(0, -1)],
      [...receipt.checks.slice(0, -1), { name: 'unknown-combined-check', result: 'passed', details: {} }],
      receipt.checks.map((entry, index) => index === 0 ? { ...entry, result: 'failed' } : entry),
      [...receipt.checks, receipt.checks[0]!],
    ]) assert.throws(() => validateAuthCombinedReceipt({ ...receipt, checks }, target), /every required result exactly once/);
  });
});

test('combined restart proof requires a new process PID and start identity at the original origin', async () => {
  await withTarget('native', async ({ target }) => {
    const receipt = combinedReceipt(target);
    const restart = receipt.restart!;
    for (const changed of [{ ...restart, after: { ...restart.after, pid: restart.before.pid } },
      { ...restart, after: { ...restart.after, start: restart.before.start } },
      { ...restart, origin: 'http://127.0.0.1:54321' }]) {
      assert.throws(() => validateAuthCombinedReceipt({ ...receipt, restart: changed }, target), /restart did not replace the owned process/);
    }
    const { restart: _restart, ...withoutRestart } = receipt;
    assert.throws(() => validateAuthCombinedReceipt(withoutRestart, target), /restart did not replace the owned process/);
  });
});

test('combined browser proof requires Chromium version identity and the native CI browser policy', async () => {
  await withTarget('native', async ({ target }) => {
    const receipt = combinedReceipt(target);
    for (const browser of [{ ...receipt.browser!, name: 'firefox' }, { ...receipt.browser!, version: '151' }]) {
      assert.throws(() => validateAuthCombinedReceipt({ ...receipt, browser }, target), /browser identity is invalid/);
    }
    const { browser: _browser, ...withoutBrowser } = receipt;
    assert.throws(() => validateAuthCombinedReceipt(withoutBrowser, target), /browser identity is invalid/);
    const originalCI = process.env.CI;
    process.env.CI = '1';
    try {
      for (const browser of [{ ...receipt.browser!, platform: process.platform === 'darwin' ? 'linux' : 'darwin' }, { ...receipt.browser!, executableOverride: true }]) {
        assert.throws(() => validateAuthCombinedReceipt({ ...receipt, browser }, target), /browser identity is invalid/);
      }
      assert.equal(validateAuthCombinedReceipt(receipt, target), receipt);
    } finally { if (originalCI === undefined) delete process.env.CI; else process.env.CI = originalCI; }
  });
});

test('combined receipt validation binds the installed CLI source and requires multiple screenshots', async () => {
  await withTarget('native', async ({ target }) => {
    const receipt = combinedReceipt(target);
    assert.throws(() => validateAuthCombinedReceipt({ ...receipt, installedCli: { ...receipt.installedCli, sourceGitSha: 'f'.repeat(40) } }, target), /CLI source or screenshot evidence is missing/);
    for (const screenshots of [[], receipt.screenshots.slice(0, 1)]) {
      assert.throws(() => validateAuthCombinedReceipt({ ...receipt, screenshots }, target), /CLI source or screenshot evidence is missing/);
    }
  });
});

const withLaunchDirectory = async (action: (directory: string) => Promise<void>): Promise<void> => {
  const directory = join(repository, 'packages/daynight-web/.tmp', `auth-combined-browser-unit-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};
const restoreTemporaryDirectory = (previous: string | undefined): void => {
  if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
};

test('browser launch creates its parent temporary directory and restores an exactly unset TMPDIR', async () => {
  await withLaunchDirectory(async (directory) => {
    const previous = process.env.TMPDIR;
    delete process.env.TMPDIR;
    const root = join(directory, 'launch');
    const expected = { browser: 'controlled-launch-result' };
    try {
      await assert.rejects(stat(root), { code: 'ENOENT' });
      const result = await launchAuthCombinedBrowser(root, async () => {
        assert.equal(process.env.TMPDIR, root);
        assert.equal((await stat(root)).isDirectory(), true);
        return expected;
      });
      assert.equal(result, expected);
      assert.equal(Object.hasOwn(process.env, 'TMPDIR'), false);
    } finally { restoreTemporaryDirectory(previous); }
  });
});

test('browser launch preserves the original thrown error and restores both nonempty and empty TMPDIR values', async () => {
  await withLaunchDirectory(async (directory) => {
    const original = process.env.TMPDIR;
    try {
      for (const previous of [join(directory, 'previous'), '']) {
        process.env.TMPDIR = previous;
        const failure = new Error('Controlled browser launch failed.');
        let observed: unknown;
        try {
          await launchAuthCombinedBrowser(join(directory, 'launch'), async () => {
            assert.equal(process.env.TMPDIR, join(directory, 'launch'));
            throw failure;
          });
        } catch (error) { observed = error; }
        assert.equal(observed === failure, true, 'Launch failure must keep the exact original Error object.');
        assert.equal(Object.hasOwn(process.env, 'TMPDIR'), true);
        assert.equal(process.env.TMPDIR, previous);
      }
    } finally { restoreTemporaryDirectory(original); }
  });
});

test('a temporary-directory creation failure leaves TMPDIR intact and releases the launch guard', async () => {
  await withLaunchDirectory(async (directory) => {
    const original = process.env.TMPDIR;
    const previous = join(directory, 'previous');
    process.env.TMPDIR = previous;
    let launches = 0;
    try {
      const blocker = join(directory, 'regular-file');
      await writeFile(blocker, 'The requested parent is a file.');
      await assert.rejects(launchAuthCombinedBrowser(join(blocker, 'child'), async () => { launches++; }),
        (error: unknown) => error instanceof Error && 'code' in error && ['ENOTDIR', 'EEXIST'].includes(String(error.code)));
      assert.equal(launches, 0);
      assert.equal(process.env.TMPDIR, previous);
      const recovered = join(directory, 'recovered');
      await launchAuthCombinedBrowser(recovered, async () => { launches++; assert.equal(process.env.TMPDIR, recovered); });
      assert.equal(launches, 1);
      assert.equal(process.env.TMPDIR, previous);
    } finally { restoreTemporaryDirectory(original); }
  });
});

test('overlapping browser launches refuse the second boundary without mutating the first environment or directory', async () => {
  await withLaunchDirectory(async (directory) => {
    const original = process.env.TMPDIR;
    const previous = join(directory, 'previous');
    process.env.TMPDIR = previous;
    const firstRoot = join(directory, 'first');
    const secondRoot = join(directory, 'second');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let secondLaunched = false;
    const first = launchAuthCombinedBrowser(firstRoot, async () => {
      entered.resolve();
      await release.promise;
      assert.equal(process.env.TMPDIR, firstRoot);
      return 'first-launch';
    });
    void first.catch(() => {});
    try {
      await within(entered.promise);
      await assert.rejects(launchAuthCombinedBrowser(secondRoot, async () => { secondLaunched = true; }), /launch is already active/);
      assert.equal(secondLaunched, false);
      assert.equal(process.env.TMPDIR, firstRoot);
      await assert.rejects(stat(secondRoot), { code: 'ENOENT' });
      release.resolve();
      assert.equal(await within(first), 'first-launch');
      assert.equal(process.env.TMPDIR, previous);
    } finally {
      release.resolve();
      try { await within(first); } finally { restoreTemporaryDirectory(original); }
    }
  });
});
