import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { exists, fixture, marker, payload, stopped, waitFor } from './testdata/go-cov-fixture.mts';

test('capture retains Test output followed only by package fail without changing bytes or invocation', async t => {
  const f = await fixture(t);
  f.env.FIXTURE_GO_EXIT = '17';
  const result = f.run();
  assert.equal(result.status, 17, result.stderr);
  const runs = await f.runs();
  assert.equal(runs.length, 1);
  assert.deepEqual(await readFile(join(runs[0]!, 'go-test.jsonl')), payload);
  assert.match((await readFile(join(runs[0]!, 'go-test.jsonl'))).toString(), new RegExp(marker));
  assert.deepEqual(JSON.parse(await readFile(join(runs[0]!, 'go-test.complete.json'), 'utf8')),
    { version: 1, bytes: payload.length, exitCode: 17, signal: null });
  assert.deepEqual(await readFile(join(f.root, 'received')), payload);
  const trace = (await readFile(join(f.root, 'trace'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(trace.map(item => item.args), [
    ['list', './...'], ['test', 'example/pkg', '-json', '-timeout=10m', 'argument with spaces'],
  ]);
  assert.ok(trace.every(item => item.cwd === f.root && item.flags === f.env.GOFLAGS));
  assert.ok(trace.every(item => item.path === f.env.PATH), 'real go and non-test commands must receive the original PATH');
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'cov-args'), 'utf8')), ['--race=true', '--coverprofile=coverage.out']);
});

test('each coverage owner keeps prior runs and requires a complete capture before success', async t => {
  const f = await fixture(t);
  for (const scope of ['module', 'module', 'startup-shutdown']) {
    const result = f.run(scope);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal((await f.runs()).length, 2);
  assert.equal((await f.runs('startup-shutdown')).length, 1);
  f.env.FIXTURE_MODE = 'missing';
  const missing = f.run();
  assert.equal(missing.status, 125);
  assert.match(missing.stderr, /capture|evidence/i);
});

test('capture failures cannot become success even when the consumer ignores failure', async t => {
  for (const fault of ['open', 'write', 'close']) {
    const f = await fixture(t, 'ignore-failure', Buffer.concat([payload, payload]), fault);
    const result = f.run();
    assert.equal(result.status, 125, result.stderr);
    const [run] = await f.runs();
    assert.ok(run);
    assert.equal(await exists(join(run, 'go-test.complete.json')), false);
    const failure = JSON.parse(await readFile(join(run, 'go-test.failed.json'), 'utf8'));
    assert.equal(failure.version, 1);
    assert.match(failure.error, /capture (?:open denied|disk full|close failed)/);
    if (fault === 'write') {
      const partial = await readFile(join(run, 'go-test.jsonl'));
      assert.ok(partial.length > 0 && partial.length < payload.length * 2);
      assert.deepEqual(partial, Buffer.concat([payload, payload]).subarray(0, partial.length));
    }
  }
});

test('a closed consumer fails capture and preserves the written prefix', async t => {
  const f = await fixture(t, 'forward-failure', Buffer.alloc(2 * 1024 * 1024, 97));
  const result = f.run();
  assert.equal(result.status, 125, result.stderr);
  const [run] = await f.runs();
  assert.ok(run);
  assert.equal(await exists(join(run, 'go-test.complete.json')), false);
  assert.ok((await stat(join(run, 'go-test.jsonl'))).size > 0);
});

test('slow consumers bound production until they release the stream', async t => {
  const input = Buffer.alloc(2 * 1024 * 1024, 120);
  const f = await fixture(t, 'slow', input);
  const active = f.start();
  await waitFor(() => exists(join(f.root, 'held')));
  await delay(150);
  const [run] = await f.runs();
  assert.ok(run);
  assert.ok((await stat(join(run, 'go-test.jsonl'))).size < input.length);
  assert.ok(Number(await readFile(join(f.root, 'produced'), 'utf8')) < input.length);
  await writeFile(join(f.root, 'release'), '');
  assert.deepEqual(await active.closed, [0, null], active.output().stderr);
  assert.deepEqual(await readFile(join(run, 'go-test.jsonl')), input);
  assert.deepEqual(await readFile(join(f.root, 'received')), input);
});

test('the outer supervisor cleans real go and tests after shim kill or early consumer exit', async t => {
  for (const mode of ['kill-shim', 'early']) {
    const f = await fixture(t, mode);
    const result = f.run();
    assert.equal(result.status, 125, result.stderr);
    const [run] = await f.runs();
    assert.ok(run);
    assert.equal(await exists(join(run, 'go-test.complete.json')), false);
    assert.ok((await stat(join(run, 'go-test.jsonl'))).size > 0);
    for (const pid of JSON.parse(await readFile(join(f.root, 'pids'), 'utf8')) as number[]) {
      assert.ok(stopped(pid), 'owned test process remains after consumer exit');
    }
  }
});

test('cancellation and deadlines retain partial output and clean the same process group', async t => {
  for (const interrupted of [false, true]) {
    const f = await fixture(t, 'hang');
    // Trigger the supervisor's deadline only after raw output reached its consumer.
    // command-timeout.test.mts owns real elapsed-time expiry; this test owns capture
    // and descendant cleanup after that deadline fires, independent of startup cost.
    const active = f.start(5000, !interrupted);
    await active.ready('capture-ready');
    if (interrupted) active.child.kill('SIGTERM');
    assert.deepEqual(await active.closed, [interrupted ? 143 : 124, null], active.output().stderr);
    const [run] = await f.runs();
    assert.ok(run);
    assert.equal(await exists(join(run, 'go-test.complete.json')), false);
    assert.ok((await stat(join(run, 'go-test.jsonl'))).size > 0);
    for (const pid of JSON.parse(await readFile(join(f.root, 'pids'), 'utf8')) as number[]) {
      assert.ok(stopped(pid), 'owned test process remains after cancellation');
    }
  }
});


test('a repeated go test cannot reuse a previous completion after capture fails', async t => {
  const f = await fixture(t, 'repeat');
  const result = f.run();
  assert.equal(result.status, 125, result.stderr);
  const [run] = await f.runs();
  assert.ok(run);
  assert.deepEqual(await readFile(join(run, 'go-test.jsonl')), payload);
  assert.equal(await exists(join(run, 'go-test.complete.json')), false);
});


test('overlapping capture failure survives a later successful completion', async t => {
  const f = await fixture(t, 'overlap');
  const result = f.run();
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'second-result'), 'utf8')), [125, null]);
  assert.equal(result.status, 125, result.stderr);
  const [run] = await f.runs();
  assert.ok(run);
  assert.deepEqual(await readFile(join(run, 'go-test.jsonl')), payload);
  assert.deepEqual(JSON.parse(await readFile(join(run, 'go-test.complete.json'), 'utf8')),
    { version: 1, bytes: payload.length, exitCode: 0, signal: null });
  const failure = JSON.parse(await readFile(join(run, 'go-test.failed.json'), 'utf8'));
  assert.equal(failure.version, 1);
  assert.match(failure.error, /EEXIST.*go-test.jsonl/);
  assert.match(result.stderr, /capture failure.*go-test.failed.json/);
});
