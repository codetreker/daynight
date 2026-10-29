import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createInstalledCli, readCliSourceIdentity } from '../../../daynight/test/fixtures/installed-cli.ts';
import { prepareCliPackage, readCliPackage, type CliPackageManifest } from './cli-package.mts';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const temporary = join(repository, '.tmp/cli-package-tests');
const producer = { runId: '12345', originAttempt: 2 };
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const environment = (values: NodeJS.ProcessEnv): (() => void) => {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return () => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
};
const fixture = async (run: (value: { directory: string; manifest: CliPackageManifest; bytes: Buffer }) => Promise<void>): Promise<void> => {
  await mkdir(temporary, { recursive: true });
  const directory = join(temporary, randomUUID());
  await mkdir(directory);
  const bytes = Buffer.from('source-bound package fixture');
  const source = readCliSourceIdentity();
  const sourceManifest = JSON.parse(await readFile(join(repository, 'packages/daynight/package.json'), 'utf8')) as { version: string };
  const manifest: CliPackageManifest = { schemaVersion: 1, source, packageVersion: sourceManifest.version, tarballSha256: hash(bytes), producer };
  await writeFile(join(directory, 'daynight.tgz'), bytes);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const restore = environment({ CI: undefined });
  try { await run({ directory, manifest, bytes }); }
  finally { restore(); await rm(directory, { recursive: true, force: true }); }
};

test('package input binds source, version and bytes independently from the producer manifest', async () => {
  await fixture(async ({ directory, manifest, bytes }) => {
    const expected = { ...producer, source: readCliSourceIdentity() };
    const prepared = await readCliPackage(directory, expected);
    assert.deepEqual(prepared.manifest, manifest);
    assert.equal(prepared.packedPackage.tarballPath, join(directory, 'daynight.tgz'));
    assert.equal(prepared.packedPackage.tarballSha256, hash(bytes));
    assert.deepEqual(prepared.packedPackage.source, expected.source);
    for (const changed of [
      { ...manifest, schemaVersion: 2 },
      { ...manifest, source: { ...manifest.source, gitSha: 'f'.repeat(40) } },
      { ...manifest, source: { ...manifest.source, gitTreeSha: 'f'.repeat(40) } },
      { ...manifest, source: { ...manifest.source, dirty: !manifest.source.dirty } },
      { ...manifest, packageVersion: '999.0.0' },
      { ...manifest, tarballSha256: '0'.repeat(64) },
      { ...manifest, producer: { ...producer, runId: 'another-run' } },
      { ...manifest, producer: { ...producer, originAttempt: 3 } },
    ]) {
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(changed));
      await assert.rejects(readCliPackage(directory, expected));
    }
  });
});

test('package input rejects malformed metadata and preserves absent artifact errors', async () => {
  await fixture(async ({ directory, manifest }) => {
    const expected = { ...producer, source: manifest.source };
    for (const malformed of [null, [], {}, { ...manifest, source: null }, { ...manifest, source: { ...manifest.source, dirty: 0 } },
      { ...manifest, producer: { ...producer, originAttempt: 0 } }, { ...manifest, producer: { ...producer, originAttempt: '2' } },
      { ...manifest, producer: { ...producer, runId: '' } }, { ...manifest, producer: { ...producer, runId: '01' } },
      { ...manifest, producer: { ...producer, runId: 'local-run' } }, { ...manifest, tarballSha256: 'invalid' }]) {
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(malformed));
      await assert.rejects(readCliPackage(directory, expected));
    }
    await writeFile(join(directory, 'manifest.json'), '{');
    await assert.rejects(readCliPackage(directory, expected), SyntaxError);
    await rm(join(directory, 'manifest.json'));
    await assert.rejects(readCliPackage(directory, expected), { code: 'ENOENT' });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await rm(join(directory, 'daynight.tgz'));
    await assert.rejects(readCliPackage(directory, expected), { code: 'ENOENT' });
  });
});

test('changed package bytes are rejected before creating an installed CLI command', async () => {
  await fixture(async ({ directory, manifest }) => {
    await writeFile(join(directory, 'daynight.tgz'), 'corrupted package');
    const packedPackage = { tarballPath: join(directory, 'daynight.tgz'), tarballSha256: manifest.tarballSha256,
      packageVersion: manifest.packageVersion, source: manifest.source };
    const installedRoot = join(directory, 'owned-installation');
    let spawned = 0;
    await assert.rejects(createInstalledCli({ temporaryRoot: directory, rootDirectory: installedRoot, packedPackage,
      onSpawn: () => { spawned += 1; } }), /hash differs/);
    assert.equal(spawned, 0);
    await assert.rejects(readFile(join(installedRoot, 'installed-cli.json')), { code: 'ENOENT' });
    assert.equal(await readFile(join(directory, 'daynight.tgz'), 'utf8'), 'corrupted package');
  });
});

test('package input rejects an expected identity copied from another checkout', async () => {
  await fixture(async ({ directory, manifest }) => {
    await assert.rejects(readCliPackage(directory, { ...producer, source: { ...manifest.source, gitSha: 'e'.repeat(40) } }), /current checkout/);
    await assert.rejects(readCliPackage('relative/package', { ...producer, source: manifest.source }), /absolute/);
  });
});

test('producer attempt is explicit and may precede the consuming job attempt', async () => {
  await fixture(async ({ directory, manifest }) => {
    const restore = environment({ GITHUB_RUN_ATTEMPT: '9' });
    try {
      assert.deepEqual((await readCliPackage(directory, { ...producer, source: manifest.source })).manifest.producer, producer);
      await assert.rejects(readCliPackage(directory, { runId: producer.runId, originAttempt: 9, source: manifest.source }), /expected source or producer/);
    } finally { restore(); }
  });
});

test('CI package consumption requires its exact clean source and workflow run', async () => {
  await fixture(async ({ directory, manifest }) => {
    const restore = environment({ CI: 'true', GITHUB_SHA: manifest.source.gitSha, GITHUB_RUN_ID: producer.runId, GITHUB_RUN_ATTEMPT: '9' });
    try {
      const expected = { ...producer, source: manifest.source };
      if (manifest.source.dirty) await assert.rejects(readCliPackage(directory, expected), /clean GitHub source/);
      else assert.deepEqual((await readCliPackage(directory, expected)).manifest.producer, producer);
      process.env.GITHUB_RUN_ID = 'wrong-run';
      await assert.rejects(readCliPackage(directory, expected), /clean GitHub source/);
      process.env.GITHUB_RUN_ID = producer.runId;
      process.env.GITHUB_SHA = 'e'.repeat(40);
      await assert.rejects(readCliPackage(directory, expected), /clean GitHub source/);
    } finally { restore(); }
  });
});

test('package producer refuses preexisting output and cancelled preparation without deleting it', async () => {
  await fixture(async ({ directory }) => {
    const retained = await readFile(join(directory, 'manifest.json'));
    await assert.rejects(prepareCliPackage(directory, producer, new AbortController()), { code: 'EEXIST' });
    assert.deepEqual(await readFile(join(directory, 'manifest.json')), retained);
    const cancelled = new AbortController();
    const reason = new Error('cancelled package preparation');
    cancelled.abort(reason);
    await assert.rejects(prepareCliPackage(join(directory, 'not-created'), producer, cancelled), (error) => error === reason);
    await assert.rejects(readFile(join(directory, 'not-created', 'manifest.json')), { code: 'ENOENT' });
    await assert.rejects(prepareCliPackage('relative/package', producer, new AbortController()), /absolute/);
  });
});

test('CI package producer rejects a different attempt before creating output', async () => {
  await fixture(async ({ directory, manifest }) => {
    const restore = environment({ CI: 'true', GITHUB_SHA: manifest.source.gitSha, GITHUB_RUN_ID: producer.runId, GITHUB_RUN_ATTEMPT: '9' });
    try {
      await assert.rejects(prepareCliPackage(join(directory, 'not-created'), producer, new AbortController()), /clean GitHub source/);
      await assert.rejects(readFile(join(directory, 'not-created', 'manifest.json')), { code: 'ENOENT' });
    } finally { restore(); }
  });
});
