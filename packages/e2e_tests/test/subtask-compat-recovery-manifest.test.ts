import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readRegisteredMigrations } from '../src/subtask-compat-recovery-manifest.ts';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const entry = { version: 26, checksum: 'a'.repeat(64) };
const output = `DAYNIGHT_RECOVERY_MANIFEST=${JSON.stringify([entry])}\n`;

async function fixture() {
  const root = path.join(repository, '.tmp'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'recovery-manifest-harness-'));
  const module = path.join(directory, 'source/packages/daynight-server');
  await mkdir(path.join(module, 'scripts'), { recursive: true });
  await mkdir(path.join(module, 'internal/core/store/postgres'), { recursive: true });
  await writeFile(path.join(module, 'scripts/unit-overlay.json'), '{"Replace":{}}');
  const probe = path.join(directory, 'probe.txt'); await writeFile(probe, 'package postgres\nfor _, migration := range schemaMigrations { migration.checksum() }');
  return { directory, module, source: path.join(directory, 'source'), probe, overlayFile: path.join(directory, 'overlay.json'), filename: path.join(module, 'internal/core/store/postgres/zz_recovery_migration_manifest.go') };
}

test('registry extraction selects only its probe and clears database inputs', async () => {
  const f = await fixture();
  try {
    const result = await readRegisteredMigrations({ ...f, environment: { DAYNIGHT_TEST_DATABASE_URL: 'secret', DAYNIGHT_TEST_STORE_ROOT_DATABASE_URL: 'secret', DAYNIGHT_TEST_REDIS_URL: 'secret' },
      command: async (name, args, cwd, _timeout, env) => {
        assert.equal(name, 'go'); assert.equal(cwd, f.module); assert.equal(args[0], 'run'); assert.ok(args.some(value => value.startsWith('./.tmp/recovery-manifest-')));
        assert.equal(env?.DAYNIGHT_TEST_DATABASE_URL, undefined); assert.equal(env?.DAYNIGHT_TEST_STORE_ROOT_DATABASE_URL, undefined); assert.equal(env?.DAYNIGHT_TEST_REDIS_URL, undefined);
        assert.equal(await readFile(f.filename, 'utf8'), 'package postgres\nfor _, migration := range schemaMigrations { migration.checksum() }');
        return { stdout: output, stderr: '', exitCode: 0 };
      } });
    assert.deepEqual(result.entries, [entry]); assert.equal(result.registry, 'legacy'); assert.match(result.probeSHA256, /^[a-f0-9]{64}$/); await assert.rejects(readFile(f.filename));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('duplicate output and pre-existing probe are rejected without overwriting source', async () => {
  const f = await fixture();
  try {
    const command = async () => ({ stdout: output + output, stderr: '', exitCode: 0 });
    await assert.rejects(readRegisteredMigrations({ ...f, environment: {}, command }), /exactly once/);
    await assert.rejects(readFile(f.filename));
    await writeFile(f.filename, 'existing source');
    await assert.rejects(readRegisteredMigrations({ ...f, environment: {}, command }));
    assert.equal(await readFile(f.filename, 'utf8'), 'existing source');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('baseline extraction uses the production checksum registry and binds the generated probe', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.module, 'internal/core/store/postgres/migration_ledger.go'), 'package postgres');
    const result = await readRegisteredMigrations({ ...f, environment: {}, command: async () => {
      const probe = await readFile(f.filename, 'utf8');
      assert.match(probe, /range migrationChecksums\(schemaMigrations\)/);
      assert.match(probe, /migration\.checksum[^()]/);
      return { stdout: output, stderr: '', exitCode: 0 };
    } });
    assert.equal(result.registry, 'baseline');
    const { registryProbeHash } = await import('../src/subtask-compat-recovery-manifest.ts');
    assert.equal(result.probeSHA256, registryProbeHash(await readFile(f.probe, 'utf8'), 'baseline'));
    assert.notEqual(result.probeSHA256, registryProbeHash(await readFile(f.probe, 'utf8'), 'legacy'));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
