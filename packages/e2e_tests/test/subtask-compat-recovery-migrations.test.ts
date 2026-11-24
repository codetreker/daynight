import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyMigrationLedger, migrationManifestHash, parseMigrationManifest, requireMigrationPlan, type MigrationEntry } from '../src/subtask-compat-recovery-migrations.ts';

const entry = (version: number, character = 'a'): MigrationEntry => ({ version, checksum: character.repeat(64) });
const baseline = [entry(1), entry(3), entry(122)];
const candidate = [...baseline, entry(123, 'b'), entry(124, 'c'), entry(125, 'd'), entry(126, 'e')];

test('complete ordered registered checksums distinguish baseline, partial and candidate ledger', () => {
  requireMigrationPlan(baseline, candidate, candidate);
  assert.equal(classifyMigrationLedger(baseline, baseline, candidate), 'baseline');
  assert.equal(classifyMigrationLedger(candidate.slice(0, -1), baseline, candidate), 'partial');
  assert.equal(classifyMigrationLedger(candidate, baseline, candidate), 'candidate');
  assert.match(migrationManifestHash(candidate), /^[a-f0-9]{64}$/);
  assert.notEqual(migrationManifestHash(candidate), migrationManifestHash(candidate.slice(0, -1)));
});

test('missing, extra and changed checksums cannot pass with the same maximum version', () => {
  assert.equal(classifyMigrationLedger(candidate.filter(item => item.version !== 124), baseline, candidate), 'unexpected');
  assert.equal(classifyMigrationLedger([...candidate.slice(0, -1), entry(126, 'f')], baseline, candidate), 'unexpected');
  assert.equal(classifyMigrationLedger([...candidate, entry(127)], baseline, candidate), 'unexpected');
  assert.equal(classifyMigrationLedger([], baseline, candidate), 'unexpected');
  assert.throws(() => parseMigrationManifest([entry(1), entry(1)]), /invalid/);
  assert.throws(() => parseMigrationManifest([{ version: 1, checksum: 'a'.repeat(64), extra: true }]), /invalid/);
});

test('incompatible repair and baseline registries are rejected before use', () => {
  assert.throws(() => requireMigrationPlan(baseline, candidate, candidate.slice(0, -1)), /Repair migration registry/);
  assert.throws(() => requireMigrationPlan(baseline, candidate, [...candidate.slice(0, -1), entry(126, 'f')]), /Repair migration registry/);
  assert.throws(() => requireMigrationPlan([entry(1), entry(3), entry(122, 'f')], candidate, candidate), /strict candidate prefix/);
  assert.throws(() => requireMigrationPlan(candidate, candidate, candidate), /strict candidate prefix/);
});

test('partial and unsettled observations are recorded without becoming candidate success', async () => {
  const { observeMigrationLedger, requireSettledCandidateLedger } = await import('../src/subtask-compat-recovery-migrations.ts');
  const records: Record<string, unknown>[] = [];
  const rows = candidate.slice(0, -1).map(item => ({ ...item, applied_at: '2026-01-01T00:00:00Z' }));
  const partial = await observeMigrationLedger({ baseline, candidate, settled: true,
    query: async () => JSON.stringify({ entries: candidate.slice(0, -1), rows }), record: async value => { records.push(value); } });
  assert.equal(partial.state, 'partial'); assert.equal(records[0]?.state, 'partial');
  assert.throws(() => requireSettledCandidateLedger(partial), /partial migration ledger/);
  const unsettled = await observeMigrationLedger({ baseline, candidate, settled: false,
    query: async () => JSON.stringify({ entries: candidate, rows: candidate.map(item => ({ ...item, applied_at: '2026-01-01T00:00:00Z' })) }), record: async value => { records.push(value); } });
  assert.equal(unsettled.state, 'candidate'); assert.equal(records[1]?.settled, false);
  assert.throws(() => requireSettledCandidateLedger(unsettled), /unconfirmed/);
});

test('failed or inconsistent database observation remains unknown', async () => {
  const { observeMigrationLedger } = await import('../src/subtask-compat-recovery-migrations.ts');
  const records: Record<string, unknown>[] = [];
  await assert.rejects(observeMigrationLedger({ baseline, candidate, settled: false, query: async () => { throw new Error('connection lost'); }, record: async value => { records.push(value); } }), /connection lost/);
  assert.deepEqual(records[0], { state: 'unknown', settled: false, reason: 'ledger-observation-failed' });
  await assert.rejects(observeMigrationLedger({ baseline, candidate, settled: true,
    query: async () => JSON.stringify({ entries: candidate, rows: [...candidate.slice(0, -1), entry(126, 'f')].map(item => ({ ...item, applied_at: '2026-01-01T00:00:00Z' })) }), record: async value => { records.push(value); } }), /rows disagree/);
  assert.deepEqual(records[1], { state: 'unknown', settled: true, reason: 'ledger-observation-failed' });
});

test('later registered migrations extend the exact plan without a fixed terminal version', () => {
  const next = [...candidate, entry(127, 'f')];
  requireMigrationPlan(baseline, next, next);
  assert.equal(classifyMigrationLedger(candidate, baseline, next), 'partial');
  assert.equal(classifyMigrationLedger(next, baseline, next), 'candidate');
});

test('registry probe retains private source when command stop is unconfirmed', async () => {
  const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const root = fileURLToPath(new URL('../../../.tmp/', import.meta.url)); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'registry-stop-harness-'));
  const module = path.join(directory, 'source/packages/daynight-server');
  try {
    await mkdir(path.join(module, 'scripts'), { recursive: true }); await mkdir(path.join(module, 'internal/core/store/postgres'), { recursive: true });
    await writeFile(path.join(module, 'scripts/unit-overlay.json'), '{"Replace":{}}');
    const probe = path.join(directory, 'probe'); await writeFile(probe, 'package postgres');
    const { readRegisteredMigrations } = await import('../src/subtask-compat-recovery-manifest.ts');
    await assert.rejects(readRegisteredMigrations({ source: path.join(directory, 'source'), probe, overlayFile: path.join(directory, 'overlay.json'), environment: {},
      command: async () => { throw new Error('original command stop unconfirmed'); } }), /stop unconfirmed/);
    assert.equal(await readFile(path.join(module, 'internal/core/store/postgres/zz_recovery_migration_manifest.go'), 'utf8'), 'package postgres');
    assert.equal((await readdir(path.join(module, '.tmp'))).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('registry extraction refuses overlays that replace production migration code', async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const root = fileURLToPath(new URL('../../../.tmp/', import.meta.url)); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'registry-overlay-harness-'));
  const module = path.join(directory, 'source/packages/daynight-server');
  try {
    await mkdir(path.join(module, 'scripts'), { recursive: true });
    await writeFile(path.join(module, 'scripts/unit-overlay.json'), JSON.stringify({ Replace: { 'internal/core/store/postgres/migrate.go': 'internal/core/store/postgres/fixture.go' } }));
    const { readRegisteredMigrations } = await import('../src/subtask-compat-recovery-manifest.ts');
    await assert.rejects(readRegisteredMigrations({ source: path.join(directory, 'source'), probe: path.join(directory, 'unused'), overlayFile: path.join(directory, 'overlay.json'), environment: {},
      command: async () => { throw new Error('unexpected command'); } }), /only replace Web fixtures/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
