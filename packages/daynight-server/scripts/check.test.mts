import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runValidation } from './testdata/validation-fixture.mts';

test('module check shares compilation between full vet and coverage for its module packages', async (t) => {
  const { result, trace, fixture } = await runValidation(t, 'check', undefined, { GOFLAGS: '-race=false -tags=stress' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(trace, /node scripts\/command-timeout.mts 1800000 5000 env GOFLAGS=.*node scripts\/go-cov-capture.mts module /);
  const base = join(fixture, '.tmp/go-test-evidence/module');
  const [run] = await readdir(base);
  assert.ok(run);
  const raw = await readFile(join(base, run, 'go-test.jsonl'));
  assert.ok(raw.length > 0);
  assert.deepEqual(JSON.parse(await readFile(join(base, run, 'go-test.complete.json'), 'utf8')),
    { version: 1, bytes: raw.length, exitCode: 0, signal: null });
  const coverage = trace.split('\n').find(line => line.startsWith('go-cov '))!;
  assert.match(coverage, /--race=true --exclude-packages=example\/cmd\/daynight-server/);
  assert.match(coverage, /-p=2 .* -tags= -race=true -vet=all -coverpkg=example\/api,example\/internal\/server/);
  assert.doesNotMatch(coverage, /-coverpkg=[^ ]*cmd\/daynight-server/);
  assert.doesNotMatch(trace, /^go vet /m);
  const coveredTests = trace.split('\n').filter(line => line.startsWith('go test -json '));
  assert.equal(coveredTests.length, 1);
  assert.match(coveredTests[0]!, /-race=true -vet=all -coverpkg=example\/api,example\/internal\/server /);
  assert.match(trace, /go test -count=1 -timeout=30s .\/testdata\/testauth .* -race=true/);
  assert.doesNotMatch(trace, /TestWebhookRunnerAbruptProcessRecovery|go build |--tags=startupshutdown/);
  assert.match(trace, /node --test scripts\/coverage.test.mts scripts\/check.test.mts scripts\/validation-env.test.mts scripts\/command-timeout.test.mts scripts\/go-cov-capture.test.mts/);
  assert.match(trace, /node scripts\/coverage.mts coverage.out/);
});

test('PR CI uses four Go package slots with race disabled and propagates coverage failure', async (t) => {
  const { result, trace } = await runValidation(t, 'check', 'true', {
    COV_EXIT: '17', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/42/merge',
  });
  assert.equal(result.status, 17);
  assert.match(trace, /go test .* -race=false/);
  assert.match(trace, /go-cov --race=false .* -race=false -p=4 -vet=all -coverpkg=/);
  assert.doesNotMatch(trace, /node scripts\/coverage.mts/);
});

test('PR preparation failures prevent the covered invocation', { skip: process.platform !== 'linux' }, async (t) => {
  for (const [extra, expected] of [
    [{ CONTRACT_EXIT: '17' }, 17],
    [{ PREP_EXIT: '21' }, 21],
    [{ TESTAUTH_EXIT: '22' }, 22],
    [{ MISSING_FIXTURE: '1' }, 1],
  ] as const) {
    const { result, trace } = await runValidation(t, 'check', 'true', {
      GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/42/merge', ...extra,
    });
    assert.equal(result.status, expected, result.stderr);
    assert.doesNotMatch(trace, /(?:^|\n)go-cov |node scripts\/coverage.mts/);
  }
});

test('module check propagates fixture and covered test failures', async (t) => {
  const fixtureFailure = await runValidation(t, 'check', undefined, { TESTAUTH_EXIT: '22' });
  assert.equal(fixtureFailure.result.status, 22);
  assert.doesNotMatch(fixtureFailure.trace, /(?:^|\n)go-cov |node scripts\/coverage.mts/);

  const coveredFailure = await runValidation(t, 'check', undefined, { MODULE_TEST_EXIT: '23' });
  assert.equal(coveredFailure.result.status, 23);
  assert.match(coveredFailure.trace, /go test -json .* -vet=all /);
  assert.doesNotMatch(coveredFailure.trace, /node scripts\/coverage.mts/);
});

test('main push enables race despite inherited false flags', async (t) => {
  const { result, trace } = await runValidation(t, 'check', 'true', {
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GOFLAGS: '-race=false',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(trace, /go test .* -race=true/);
  assert.match(trace, /go-cov --race=true .* -p=2 .* -race=true -vet=all -coverpkg=/);
  assert.doesNotMatch(trace, /-p=4/);
});

test('other CI events retain conservative race settings', async (t) => {
  for (const extra of [{}, { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/feature' }]) {
    const { result, trace } = await runValidation(t, 'check', 'true', extra);
    assert.equal(result.status, 0, result.stderr);
    assert.match(trace, /go-cov --race=false .* -p=2 .* -race=false -vet=all -coverpkg=/);
    assert.doesNotMatch(trace, /-p=4/);
  }
});

test('module check rejects empty production selection and exact ninety percent coverage', async (t) => {
  const empty = await runValidation(t, 'check', 'true', { EMPTY_PACKAGES: '1' });
  assert.notEqual(empty.result.status, 0);
  assert.match(empty.result.stderr, /No production packages found/);
  assert.doesNotMatch(empty.trace, /(?:^|\n)go-cov /);
  const boundary = await runValidation(t, 'check', undefined, { PROFILE_COVERED: '9', PROFILE_TOTAL: '10' });
  assert.equal(boundary.result.status, 1);
  assert.match(boundary.result.stderr, /Overall coverage must be >90%/);
});

test('module check requires an isolated Redis instance', async (t) => {
  const { result, trace } = await runValidation(t, 'check', undefined, { DAYNIGHT_TEST_REDIS_URL: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DAYNIGHT_TEST_REDIS_URL/);
  assert.doesNotMatch(trace, /go vet|go-cov/);
});
