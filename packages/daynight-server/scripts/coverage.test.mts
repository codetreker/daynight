import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseCoverageProfile, parseCoverageStream, requireCoverageAbove90 } from './coverage.mts';

const profile = (covered: bigint, total: bigint): string =>
  `mode: atomic\nexample.com/server/main.go:1.1,2.1 ${covered} 1\nexample.com/server/main.go:3.1,4.1 ${total - covered} 0\n`;

test('rejects exactly 90% and coverage below it', () => {
  for (const covered of [0n, 8n, 9n]) {
    assert.throws(() => requireCoverageAbove90(parseCoverageProfile(profile(covered, 10n))), />90%/);
  }
});

test('accepts coverage above 90% including totals that would round to 90.0%', () => {
  for (const [covered, total] of [[10n, 11n], [90001n, 100000n], [10n ** 30n, 10n ** 30n + 1n]]) {
    assert.doesNotThrow(() => requireCoverageAbove90(parseCoverageProfile(profile(covered, total))));
  }
});

test('counts duplicate blocks once and treats any positive counter as covered', () => {
  const result = parseCoverageProfile([
    'mode: count',
    'example.com/server/main.go:1.1,2.1 10 0',
    'example.com/server/main.go:1.1,2.1 10 2',
    'example.com/server/main.go:1.1,2.1 10 0',
    'example.com/server/main.go:3.1,4.1 1 0',
  ].join('\n'));
  assert.deepEqual(result, { covered: 10n, total: 11n });
  assert.doesNotThrow(() => requireCoverageAbove90(result));
});

test('distinguishes blocks by filename and all position coordinates', () => {
  assert.deepEqual(parseCoverageProfile([
    'mode: set',
    'first.go:1.1,2.1 1 1',
    'second.go:1.1,2.1 2 0',
    'first.go:1.2,2.1 3 1',
    'first.go:1.1,2.2 4 0',
    'first.go:2.1,3.1 5 1',
  ].join('\n')), { covered: 9n, total: 15n });
});

test('accepts CRLF and zero-statement blocks without changing the denominator', () => {
  assert.deepEqual(parseCoverageProfile('mode: atomic\r\nsource.go:1.1,2.1 1 1\r\nsource.go:3.1,4.1 0 0\r\n'),
    { covered: 1n, total: 1n });
});

test('rejects duplicate blocks with inconsistent statement counts', () => {
  assert.throws(() => parseCoverageProfile('mode: atomic\na.go:1.1,2.1 1 0\na.go:1.1,2.1 2 1\n'), /Inconsistent/);
});

test('rejects empty profiles, invalid modes, and profiles without statements', () => {
  for (const input of ['', 'mode: unknown\n', 'mode: atomic\n', 'mode: set\na.go:1.1,2.1 0 1\n']) {
    assert.throws(() => parseCoverageProfile(input));
  }
});

test('rejects malformed rows and invalid statement counts or coordinates', () => {
  for (const row of [
    '', 'not a profile row', 'a.go:1.1,2.1 -1 1', 'a.go:1.1,2.1 1.1 1',
    'a.go:1.1,2.1 NaN 1', 'a.go:1.1,2.1 1 -1', 'a.go:1.1,2.1 1 1 extra',
    'a.go:0.1,2.1 1 1', 'a.go:1.0,2.1 1 1', 'a.go:2.1,1.1 1 1',
    'a.go:1.2,1.1 1 1', 'a.go:1.1,2.1 01 1',
  ]) {
    assert.throws(() => parseCoverageProfile(`mode: atomic\n${row}\na.go:3.1,4.1 1 1\n`));
  }
});

test('stream parsing agrees across all chunk boundaries including CRLF and Unicode', async () => {
  const input = 'mode: atomic\r\n路径.go:1.1,2.1 90001 0\r\n路径.go:1.1,2.1 90001 2\r\nb.go:3.1,4.1 9999 0';
  const expected = parseCoverageProfile(input);
  for (let split = 0; split <= input.length; split++) {
    async function* chunks() { yield input.slice(0, split); yield input.slice(split); }
    assert.deepEqual(await parseCoverageStream(chunks()), expected);
  }
});

test('stream rejects the same malformed lines and propagates read errors', async () => {
  for (const input of ['', 'mode: set\r', 'mode: set\n\n', 'mode: set\na.go:1.1,2.1 1 1\r',
    'mode: atomic\na.go:1.1,2.1 1 0\na.go:1.1,2.1 2 1\n']) {
    async function* chunks() { for (const char of input) yield char; }
    assert.throws(() => parseCoverageProfile(input));
    await assert.rejects(parseCoverageStream(chunks()));
  }
  const cause = new Error('read failed');
  async function* failed() { yield 'mode: set\n'; throw cause; }
  await assert.rejects(parseCoverageStream(failed()), error => error === cause);
});

test('stream merges a large repeated profile without storing the whole input', async () => {
  async function* chunks() {
    yield 'mode: count\n';
    for (let i = 0; i < 200_000; i++) yield `same.go:1.1,2.1 90001 ${i === 199_999 ? 1 : 0}\n`;
    yield 'other.go:1.1,2.1 9999 0\n';
  }
  const result = await parseCoverageStream(chunks());
  assert.deepEqual(result, { covered: 90001n, total: 100000n });
  assert.doesNotThrow(() => requireCoverageAbove90(result));
});

test('CLI succeeds only for a valid profile above 90%', async () => {
  const script = fileURLToPath(new URL('./coverage.mts', import.meta.url));
  const temporaryRoot = fileURLToPath(new URL('../.tmp/', import.meta.url));
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'coverage-test-'));
  try {
    const file = join(directory, 'coverage.out');
    for (const [input, expectedStatus, expectedOutput] of [
      [profile(10n, 11n), 0, /10\/11/],
      [profile(9n, 10n), 1, />90%/],
      ['mode: atomic\n', 1, /no statements/],
      ['mode: atomic\nmalformed\n', 1, /Invalid/],
    ] as const) {
      await writeFile(file, input);
      const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8', timeout: 5000 });
      assert.ifError(result.error);
      assert.equal(result.status, expectedStatus);
      assert.match(result.stdout + result.stderr, expectedOutput);
    }
    const missingFile = spawnSync(process.execPath, [script, join(directory, 'missing')], { encoding: 'utf8', timeout: 5000 });
    assert.equal(missingFile.status, 1);
    assert.match(missingFile.stderr, /ENOENT/);
    const missingArgument = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 5000 });
    assert.equal(missingArgument.status, 1);
    assert.match(missingArgument.stderr, /Usage:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
