import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { runValidation } from './testdata/validation-fixture.mts';

test('startup and shutdown runner owns only command coverage and the process recovery probe', async (t) => {
  const { result, trace, fixture } = await runValidation(t, 'startup-shutdown', undefined);
  assert.equal(result.status, 0, result.stderr);
  const coverage = trace.split('\n').find(line => line.startsWith('go-cov '))!;
  assert.ok(coverage.includes(`--config=${join(fixture, '.go-cov.toml')}`));
  assert.match(coverage, /--race=true --tags=startupshutdown/);
  assert.ok(coverage.includes(`--coverprofile=${join(fixture, 'startup-shutdown-coverage.out')}`));
  assert.match(coverage, /-tags=startupshutdown -coverpkg=example\/cmd\/daynight-server /);
  assert.ok(coverage.includes(`CWD=${join(fixture, 'cmd/daynight-server')}`));
  assert.doesNotMatch(coverage, /--exclude|--skip-result|-coverpkg=[^ ]*(?:example\/api|internal)/);
  assert.match(trace, /go build .*\.\/cmd\/daynight-server .* -tags=startupshutdown/);
  assert.match(trace, /node scripts\/command-timeout.mts 300000 5000 env GOFLAGS=/);
  assert.match(trace, /node scripts\/command-timeout.mts 240000 5000 env GOFLAGS=/);
  assert.match(trace, /node scripts\/command-timeout.mts 180000 5000 go install/);
  assert.ok(trace.includes(`node ${join(fixture, 'scripts/command-timeout.mts')} 720000 5000 env GOFLAGS=`));
  assert.match(trace, /go vet \.\/cmd\/daynight-server .* -tags=startupshutdown/);
  assert.match(trace, /go test -count=1 -timeout=3m -tags=webhooktest -run \^TestWebhookRunnerAbruptProcessRecovery\$ \.\/internal\/service\/webhook .* -race=true/);
  assert.doesNotMatch(trace, /go test .*\.\/testdata\/testauth|--tags=stress/);
  assert.ok(trace.includes(`node ${join(fixture, 'scripts/coverage.mts')} ${join(fixture, 'startup-shutdown-coverage.out')}`));
});

test('startup and shutdown runner applies the same local, main and PR race policy', async (t) => {
  for (const [ci, extra, race] of [
    [undefined, { GOFLAGS: '-race=false -tags=stress' }, true],
    ['true', { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GOFLAGS: '-race=false' }, true],
    ['true', { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/42/merge' }, false],
    ['true', {}, false],
  ] as const) {
    const { result, trace } = await runValidation(t, 'startup-shutdown', ci, extra);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(trace.includes(`--race=${race} --tags=startupshutdown`));
    for (const line of trace.split('\n').filter(line => /^go (?:build|vet|test) /.test(line))) {
      assert.ok(line.includes(`-tags= -race=${race}`), line);
    }
  }
});

test('startup and shutdown runner propagates build, vet, recovery and coverage failures', async (t) => {
  for (const [extra, expected] of [
    [{ BUILD_EXIT: '21' }, 21], [{ VET_EXIT: '22' }, 22], [{ PROCESS_EXIT: '23' }, 23], [{ COV_EXIT: '24' }, 24],
  ] as const) {
    const { result, trace } = await runValidation(t, 'startup-shutdown', undefined, extra);
    assert.equal(result.status, expected);
    if (expected !== 24) assert.doesNotMatch(trace, /go-cov /);
    assert.doesNotMatch(trace, /node .*\/scripts\/coverage.mts /);
  }
});

test('startup and shutdown runner enforces strict unrounded coverage above ninety percent', async (t) => {
  const { result } = await runValidation(t, 'startup-shutdown', undefined, {
    PROFILE_COVERED: '9', PROFILE_TOTAL: '10',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Overall coverage must be >90%/);
});
