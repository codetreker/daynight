import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { StorageReceipt } from './storage.mts';
import { createAuthCombinedTarget, type CombinedCommand, type CombinedTarget } from './auth-combined-target.mts';
import { launchAuthCombinedBrowser, validateAuthCombinedReceipt, type AuthCombinedReceipt, type RestartReceipt } from './auth-combined.mts';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const sourceGitSha = '0123456789abcdef0123456789abcdef01234567';
const projectId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const patId = '44444444-4444-4444-8444-444444444444';
const marker = 'dnpat_combined-private-marker';
const cookieMarker = 'Cookie=combined-private-marker';
const within = async <T,>(promise: Promise<T>): Promise<T> => {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('Combined unit resource did not settle within its bound.')), 3_000);
    })]);
  } finally { clearTimeout(deadline); }
};
const safeFailure = async (promise: Promise<unknown>): Promise<Error> => {
  let failure: unknown;
  try { await within(promise); } catch (error) { failure = error; }
  assert.equal(failure instanceof Error, true, 'The operation must fail with an Error.');
  const error = failure as Error;
  const diagnostic = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  assert.equal(diagnostic.includes(marker) || diagnostic.includes(cookieMarker), false, 'Private markers must not enter failure diagnostics.');
  assert.equal(error.cause === undefined, true, 'The diagnostic boundary must not retain the underlying cause.');
  return error;
};

type RecordedCommand = { file: string; args: readonly string[] };
type TargetFixture = {
  target: CombinedTarget;
  run: CombinedCommand;
  calls: RecordedCommand[];
  state: { postgresLabel: string; service: string; expiry: unknown; failure: Error | null };
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
  await writeFile(join(acceptanceDirectory, 'evidence.json'), JSON.stringify({ schemaVersion: 3, runId: basename(acceptanceDirectory), source: { gitSha: sourceGitSha },
    ...(storage === undefined ? {} : { native: { storageRoot: storage.directory, storage } }) }));
  const calls: RecordedCommand[] = [];
  const state = { postgresLabel: target.projectLabel.value, service: 'postgres', expiry: [{ id: patId, userId, expiresAt: '2026-10-23T00:00:00.000001+00:00' }] as unknown, failure: null as Error | null };
  const run: CombinedCommand = async (file, args, options) => {
    calls.push({ file, args: [...args] });
    assert.equal(file, 'docker');
    assert.equal(options?.quiet, true, 'Control output must remain private.');
    assert.equal(Number.isInteger(options?.timeoutMs) && options!.timeoutMs! > 0 && options!.timeoutMs! <= 15_000, true);
    if (state.failure !== null) throw state.failure;
    if (args[0] === 'inspect') {
      if (args.at(-1) === target.postgresContainer) return args[2]!.includes('com.docker.compose.service') ? state.service : state.postgresLabel;
      throw new Error('Unexpected combined unit container.');
    }
    if (args[0] === 'exec' && args[1] === target.postgresContainer && args.at(-1)!.startsWith('WITH expired')) return JSON.stringify(state.expiry);
    throw new Error('Unexpected combined unit control command.');
  };
  try { await action({ target, run, calls, state }); }
  finally { await rm(acceptanceDirectory, { recursive: true, force: true }); }
};

test('PAT expiry requires the owned target, source and storage before any database mutation', async () => {
  for (const kind of ['native', 'container'] as const) await withTarget(kind, async ({ target, run, calls, state }) => {
    assert.throws(() => createAuthCombinedTarget({ ...target, postgresContainer: '../foreign' }, run), /ownership validation/);
    const controls = createAuthCombinedTarget(target, run), evidencePath = join(target.acceptanceDirectory, 'evidence.json');
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    await writeFile(evidencePath, JSON.stringify({ ...evidence, source: { gitSha: 'f'.repeat(40) } }));
    await safeFailure(controls.expirePAT({ id: patId, userId })); expectNoMutation();
    await writeFile(evidencePath, JSON.stringify(evidence));
    if (kind === 'native') {
      await writeFile(join(evidence.native.storageRoot, 'storage-receipt.json'), JSON.stringify({ ...evidence.native.storage, phase: 'planned' }));
      await safeFailure(controls.expirePAT({ id: patId, userId })); expectNoMutation();
      await writeFile(join(evidence.native.storageRoot, 'storage-receipt.json'), JSON.stringify(evidence.native.storage));
    }
    state.postgresLabel = 'foreign';
    await safeFailure(controls.expirePAT({ id: patId, userId })); expectNoMutation();
    state.postgresLabel = target.projectLabel.value;
    if (kind === 'container') { state.service = 'server'; await safeFailure(controls.expirePAT({ id: patId, userId })); expectNoMutation(); state.service = 'postgres'; }
    state.failure = new Error(`${cookieMarker}; Authorization: Bearer ${marker}`);
    await safeFailure(controls.expirePAT({ id: patId, userId })); expectNoMutation();
    function expectNoMutation() { assert.equal(calls.some(({ args }) => args[0] === 'exec'), false); }
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

const receiptChecks = ['partial-sharing', 'normal-member-writes', 'bilingual-token', 'same-data-cli-browser',
  'restart-original-state', 'logout-independent-pat', 'pat-revocation', 'membership-revocation', 'expired-pat', 'secret-scan'];
const membershipProof = { projectId, taskId, memberId: userId, removalStatus: 204, memberAbsent: true,
  ownerBytesRetained: true, newResourceStatus: 404, privateProjectStatus: 200, cliDenied: true, browserUnavailable: true };
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
    checks: receiptChecks.map((name) => ({ name, result: 'passed', details: name === 'membership-revocation' ? membershipProof : {} })),
    screenshots: [join(target.acceptanceDirectory, 'auth-combined/sharing.png'), join(target.acceptanceDirectory, 'auth-combined/persistence.png')],
    commands: [], commandGroups: [], restart };
};

test('complete combined receipts retain exact native and container target identities', async () => {
  for (const kind of ['native', 'container'] as const) await withTarget(kind, async ({ target }) => {
    const receipt = combinedReceipt(target);
    assert.equal(validateAuthCombinedReceipt(receipt, target), receipt);
    assert.equal(receipt.checks.length, 10);
    assert.equal(new Set(receipt.checks.map(({ name }) => name)).size, 10);
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

test('each of the ten combined checks is mandatory exactly once with a passing result', async () => {
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

test('combined receipts require actual membership outcomes', async () => {
  await withTarget('native', async ({ target }) => {
    const receipt = combinedReceipt(target);
    for (const [name, details, message] of [
      ['membership-revocation', { ...membershipProof, memberAbsent: false }, /membership revocation evidence/],
      ['membership-revocation', { ...membershipProof, newResourceStatus: 200 }, /membership revocation evidence/],
    ] as const) {
      const checks = receipt.checks.map(entry => entry.name === name ? { ...entry, details } : entry);
      assert.throws(() => validateAuthCombinedReceipt({ ...receipt, checks }, target), message);
    }
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
