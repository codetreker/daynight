import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/command.ts';
import { readRegisteredMigrations } from '../src/subtask-compat-recovery-manifest.ts';
import { requireMigrationPlan } from '../src/subtask-compat-recovery-migrations.ts';

const repository = fileURLToPath(new URL('../../..', import.meta.url));

test('real historical and 099-baselined production registries agree', { timeout: 1_800_000 }, async () => {
  const revisions = [process.env.RECOVERY_REGISTRY_BASELINE, process.env.RECOVERY_REGISTRY_CANDIDATE, process.env.RECOVERY_REGISTRY_REPAIR];
  if (!revisions.every(value => value && /^[a-f0-9]{40}$/.test(value))) throw new Error('Supply complete RECOVERY_REGISTRY_BASELINE, RECOVERY_REGISTRY_CANDIDATE and RECOVERY_REGISTRY_REPAIR commits.');
  const temporary = path.join(repository, '.tmp'); await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, 'real-registry-test-'));
  const command = (name: string, args: string[], cwd = repository, timeoutMs = 600_000, environment = process.env) =>
    runCommand(name, args, { cwd, timeoutMs, env: environment, onOutput: () => {} });
  try {
    const results = [];
    for (const [index, revision] of revisions.entries()) {
      const clone = path.join(root, `source-${index}`);
      await command('git', ['clone', '--no-hardlinks', '--no-checkout', repository, clone]);
      await command('git', ['checkout', '--quiet', '--detach', revision!], clone);
      assert.equal((await command('git', ['rev-parse', 'HEAD'], clone)).stdout.trim(), revision);
      results.push(await readRegisteredMigrations({ source: clone, probe: path.join(repository, 'packages/e2e_tests/src/subtask-compat-recovery-manifest-probe.go.txt'), overlayFile: path.join(root, `overlay-${index}.json`), environment: process.env, command }));
    }
    const [old, candidate, repair] = results;
    assert.equal(old!.registry, 'legacy'); assert.equal(candidate!.registry, 'baseline');
    const frozen = (await readFile(path.join(repository, 'packages/daynight-server/internal/core/store/postgres/schema/legacy-checksums.tsv'), 'utf8')).trimEnd().split('\n').map(line => {
      const [version, checksum] = line.split('\t'); return { version: Number(version), checksum };
    });
    assert.equal(frozen.length, 97); assert.equal(frozen.at(-1)?.version, 99);
    assert.deepEqual(old!.entries.slice(0, frozen.length), frozen);
    assert.deepEqual(candidate!.entries.slice(0, frozen.length), frozen);
    requireMigrationPlan(old!.entries, candidate!.entries, repair!.entries);
    assert.throws(() => requireMigrationPlan(old!.entries.filter(entry => entry.version < 99), candidate!.entries, repair!.entries), /does not reach version 99/);
    const changed = candidate!.entries.map((entry, index) => index === 0 ? { ...entry, checksum: '0'.repeat(64) } : entry);
    assert.throws(() => requireMigrationPlan(old!.entries, changed, repair!.entries), /strict candidate prefix/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
