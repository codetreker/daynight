import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { providerDiagnosticSink, writeProviderDiagnostics } from '../src/provider-diagnostics.ts';

test('live provider snapshots persist before close and write failures remain visible', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'provider-diagnostics-'));
  try {
    const file = path.join(dir, 'provider.json');
    const failures: unknown[] = [];
    const sink = providerDiagnosticSink(file, error => failures.push(error));
    sink({ events: [], complete: false, truncated: false });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { events: [], complete: false, truncated: false });
    writeProviderDiagnostics(file, { events: [], complete: true, truncated: false });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).complete, true);
    const broken = providerDiagnosticSink(path.join(dir, 'missing', 'provider.json'), error => failures.push(error));
    broken({ events: [], complete: false, truncated: false });
    broken({ events: [], complete: false, truncated: false });
    assert.equal(failures.length, 1);
    assert.ok(failures[0] instanceof Error);
    assert.throws(() => writeProviderDiagnostics(path.join(dir, 'missing', 'provider.json'), { events: [], complete: true, truncated: false }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
