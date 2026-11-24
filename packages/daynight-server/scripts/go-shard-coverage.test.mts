import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mergeAtomicProfiles, validateShard } from './go-shard-coverage.mts';

const fixture = async (t: TestContext): Promise<string> => {
  const temp = fileURLToPath(new URL('../.tmp/', import.meta.url));
  await mkdir(temp, { recursive: true });
  const dir = await mkdtemp(join(temp, 'go-shard-test-'));
  t.after(() => rm(dir, { recursive: true }));
  return dir;
};

test('merges cross-package coverage and sums repeated atomic counters', async t => {
  const dir = await fixture(t);
  const a = join(dir, 'a.out'), b = join(dir, 'b.out'), merged = join(dir, 'merged.out');
  await writeFile(a, 'mode: atomic\nmod/a/a.go:1.1,2.1 3 0\nmod/a/a.go:1.1,2.1 3 100\nmod/b/b.go:1.1,2.1 1 4\n');
  await writeFile(b, 'mode: atomic\nmod/a/a.go:1.1,2.1 3 2\nmod/b/b.go:1.1,2.1 1 0\nmod/b/b.go:3.1,4.1 5 0\n');
  await mergeAtomicProfiles([a, b], merged, new Set(['mod/a', 'mod/b']));
  assert.equal(await readFile(merged, 'utf8'),
    'mode: atomic\nmod/a/a.go:1.1,2.1 3 102\nmod/b/b.go:1.1,2.1 1 4\nmod/b/b.go:3.1,4.1 5 0\n');
});

test('rejects empty, incompatible, invalid and out-of-partition coverage profiles', async t => {
  const dir = await fixture(t);
  const input = join(dir, 'input.out'), output = join(dir, 'output.out');
  for (const [profile, error] of [
    ['', /Empty/],
    ['mode: atomic\n', /Empty/],
    ['mode: count\nmod/a/a.go:1.1,2.1 3 1\n', /Invalid atomic/],
    ['mode: atomic\nmod/a/a.go:1.1,2.1 3 invalid\n', /Invalid coverage row/],
    ['mode: atomic\nmod/a/a.go:2.1,1.1 3 1\n', /Invalid coverage block position/],
    ['mode: atomic\nmod/a/a.go:1.1,2.1 3 1\nmod/a/a.go:1.1,2.1 2 0\n', /Conflicting/],
    ['mode: atomic\nmod/cmd/cmd.go:1.1,2.1 3 1\n', /outside/],
  ] as const) {
    await writeFile(input, profile);
    await assert.rejects(mergeAtomicProfiles([input], output, new Set(['mod/a'])), error);
  }
});

const packages = ['mod/a', 'mod/b'];
const tested = new Set(['mod/a']);
const results = [
  { Package: 'mod/a', Action: 'skip', Test: 'TestOptional' },
  { Package: 'mod/b', Action: 'skip' },
  { Package: 'mod/a', Action: 'pass' },
];

const capture = async (
  dir: string, events: Record<string, string>[] = results, completion: Record<string, unknown> = {},
) => {
  const contents = events.map(event => JSON.stringify(event) + '\n').join('');
  await writeFile(join(dir, 'go-test.jsonl'), contents);
  await writeFile(join(dir, 'go-test.complete.json'),
    JSON.stringify({ version: 1, bytes: Buffer.byteLength(contents), exitCode: 0, signal: null, ...completion }));
};

const receipt = async (dir: string, values: Record<string, unknown> = {}) => {
  await writeFile(join(dir, 'receipt.json'),
    JSON.stringify({ version: 1, shard: 'root', source: 'abc123', race: false, packages, ...values }));
};

test('accepts complete uncached package evidence and ordinary subtest skips', async t => {
  const dir = await fixture(t);
  await receipt(dir, { packages: [...packages].reverse() });
  await capture(dir);
  const result = await validateShard(dir, 'root', 'abc123', false, packages, tested);
  assert.equal(result, join(dir, 'go-test.jsonl'));
});

test('rejects unexpected receipt identities and assignments', async t => {
  const dir = await fixture(t);
  await capture(dir);
  for (const fields of [
    { shard: 'store-a' }, { source: 'other' }, { race: true },
    { packages: ['mod/a', 'mod/a'] }, { packages: ['mod/a'] }, { packages: ['mod/a', 'mod/c'] },
  ]) {
    await receipt(dir, fields);
    await assert.rejects(validateShard(dir, 'root', 'abc123', false, packages, tested), /Invalid source/);
  }
});

test('rejects incomplete or failed captures and duplicate, skipped, cached or missing tests', async t => {
  const dir = await fixture(t);
  await receipt(dir);

  const validate = () => validateShard(dir, 'root', 'abc123', false, packages, tested);
  for (const completion of [{ bytes: 1 }, { exitCode: 1 }, { signal: 'SIGTERM' }]) {
    await capture(dir, results, completion);
    await assert.rejects(validate(), /Incomplete/);
  }
  for (const [events, reason] of [
    [results.slice(0, -1), /Missing package/],
    [[...results, results.at(-1)!], /Duplicate or unexpected/],
    [[...results, { Package: 'mod/z', Action: 'pass' }], /Failed or unexpected/],
    [[...results.slice(0, -1), { Package: 'mod/a', Action: 'skip' }], /Duplicate or unexpected/],
    [[...results, { Package: 'mod/a', Action: 'output', Output: 'ok\tmod/a\t(cached)' }], /Cached package/],
    [[...results, { Package: 'mod/a', Action: 'fail', Test: 'TestFailure' }], /Failed or unexpected/],
  ] as const) {
    await capture(dir, [...events]);
    await assert.rejects(validate(), reason);
  }
  await capture(dir);
  await writeFile(join(dir, 'go-test.failed.json'), '{}');
  await assert.rejects(validate(), /recorded a test capture failure/);
});
