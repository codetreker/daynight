import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runValidation } from './testdata/validation-fixture.mts';

test('module check leaves command execution and coverage to its independent owner', async (t) => {
  const { result, trace } = await runValidation(t, 'check', undefined, { GOFLAGS: '-race=false -tags=stress' });
  assert.equal(result.status, 0, result.stderr);
  const coverage = trace.split('\n').find(line => line.startsWith('go-cov '))!;
  assert.match(coverage, /--race=true --exclude-packages=example\/cmd\/daynight-server/);
  assert.match(coverage, /-tags= -race=true -coverpkg=example\/api,example\/internal\/server/);
  assert.doesNotMatch(coverage, /-coverpkg=[^ ]*cmd\/daynight-server/);
  assert.match(trace, /go test -count=1 -timeout=30s .\/testdata\/testauth .* -race=true/);
  assert.doesNotMatch(trace, /TestWebhookRunnerAbruptProcessRecovery|go build |--tags=startupshutdown/);
  assert.match(trace, /node --test scripts\/coverage.test.mts scripts\/check.test.mts scripts\/validation-env.test.mts scripts\/command-timeout.test.mts/);
  assert.match(trace, /node scripts\/coverage.mts coverage.out/);
});

test('PR CI disables inherited race and propagates coverage failure', async (t) => {
  const { result, trace } = await runValidation(t, 'check', 'true', {
    COV_EXIT: '17', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/42/merge',
  });
  assert.equal(result.status, 17);
  assert.match(trace, /go vet .* -race=false/);
  assert.match(trace, /go test .* -race=false/);
  assert.match(trace, /go-cov --race=false .* -race=false -coverpkg=/);
  assert.doesNotMatch(trace, /node scripts\/coverage.mts/);
});

test('module check propagates vet and fixture test failures before coverage', async (t) => {
  for (const [extra, expected] of [[{ VET_EXIT: '21' }, 21], [{ TESTAUTH_EXIT: '22' }, 22]] as const) {
    const { result, trace } = await runValidation(t, 'check', undefined, extra);
    assert.equal(result.status, expected);
    assert.doesNotMatch(trace, /go-cov|node scripts\/coverage.mts/);
  }
});

test('main push enables race despite inherited false flags', async (t) => {
  const { result, trace } = await runValidation(t, 'check', 'true', {
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GOFLAGS: '-race=false',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(trace, /go vet .* -race=true/);
  assert.match(trace, /go test .* -race=true/);
  assert.match(trace, /go-cov --race=true .* -race=true -coverpkg=/);
});

test('other CI events retain conservative race settings', async (t) => {
  for (const extra of [{}, { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/feature' }]) {
    const { result, trace } = await runValidation(t, 'check', 'true', extra);
    assert.equal(result.status, 0, result.stderr);
    assert.match(trace, /go-cov --race=false .* -race=false -coverpkg=/);
  }
});

test('module check rejects empty production selection and exact ninety percent coverage', async (t) => {
  const empty = await runValidation(t, 'check', 'true', { EMPTY_PACKAGES: '1' });
  assert.notEqual(empty.result.status, 0);
  assert.match(empty.result.stderr, /No production packages found/);
  assert.doesNotMatch(empty.trace, /go-cov/);
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
