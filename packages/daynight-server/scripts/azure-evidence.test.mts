import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./azure-evidence.mts', import.meta.url));
const prefix = 'github.com/codetreker/daynight/packages/daynight-server/';
const cases: Record<string, string[]> = {
  'internal/core/filestorage/azure': ['TestAzurite', 'TestAzuriteArchiveStaging'],
  'internal/service': ['TestAzureStartupWithAzurite'],
  'internal/service/mcpdownload': ['TestAzureAttachmentDownloadSnapshotAndCleanup'],
  'internal/core/session': ['TestAzureImageCompletionIntegrityAndCleanup', 'TestAzureImageCompletionIntegrityAndCleanup/length', 'TestAzureImageCompletionIntegrityAndCleanup/digest', 'TestAzureImageCompletionIntegrityAndCleanup/verified_and_cleanup_failure'],
};
type Event = { Action: string; Package: string; Test?: string };
const passing = (): Event[] => Object.entries(cases).flatMap(([pkg, tests]) => [
  { Action: 'start', Package: prefix + pkg },
  ...tests.flatMap(Test => ['run', 'pass'].map(Action => ({ Action, Package: prefix + pkg, Test }))),
  { Action: 'pass', Package: prefix + pkg },
]);
const fixture = (t: test.TestContext, events: Event[], options: { marker?: unknown; suffix?: string; failure?: boolean; second?: boolean } = {}) => {
  const scratch = fileURLToPath(new URL('../.tmp/', import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'azure-evidence-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = join(root, 'run-one');
  mkdirSync(run);
  if (options.second) mkdirSync(join(root, 'run-two'));
  const data = events.map(event => JSON.stringify(event)).join('\n') + (options.suffix ?? '\n');
  writeFileSync(join(run, 'go-test.jsonl'), data);
  writeFileSync(join(run, 'go-test.complete.json'), JSON.stringify(options.marker ?? { version: 1, bytes: Buffer.byteLength(data), exitCode: 0, signal: null }));
  if (options.failure) writeFileSync(join(run, 'go-test.failed.json'), '{}');
  return () => spawnSync(process.execPath, [script, root], { encoding: 'utf8', timeout: 10000 });
};

test('accepts a complete successful capture with the real package and test identities', t => {
  const result = fixture(t, passing())();
  assert.equal(result.status, 0, result.stderr);
});

test('rejects missing, skipped, failed or conflicting test events', async t => {
  const target = 'TestAzurite';
  for (const action of ['missing', 'skip', 'fail', 'duplicate', 'duplicate-run', 'wrong-package', 'package-fail']) {
    await t.test(action, t => {
      const events = passing();
      const index = events.findIndex(e => e.Test === target && e.Action === 'pass');
      if (action === 'missing') events.splice(index, 1);
      if (action === 'skip' || action === 'fail') events[index]!.Action = action;
      if (action === 'duplicate') events.push({ ...events[index]! });
      if (action === 'duplicate-run') events.push({ ...events[index]!, Action: 'run' });
      if (action === 'wrong-package') events[index]!.Package += '/other';
      if (action === 'package-fail') events.push({ Action: 'fail', Package: events[index]!.Package });
      assert.notEqual(fixture(t, events)().status, 0);
    });
  }
});

test('rejects a skipped image subtest even when its parent passes', t => {
  const events = passing();
  events.find(e => e.Test?.endsWith('/digest') && e.Action === 'pass')!.Action = 'skip';
  assert.notEqual(fixture(t, events)().status, 0);
});

test('rejects incomplete or ambiguous capture', async t => {
  for (const options of [
    { marker: { version: 1, bytes: 1, exitCode: 0, signal: null } },
    { marker: { version: 1, bytes: 1, exitCode: 1, signal: null } },
    { suffix: '' }, { suffix: '\ninvalid\n' }, { failure: true }, { second: true },
  ]) {
    await t.test(JSON.stringify(options), t => assert.notEqual(fixture(t, passing(), options)().status, 0));
  }
});
