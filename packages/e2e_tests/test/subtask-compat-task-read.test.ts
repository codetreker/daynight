import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCommandQuiescence, CommandFailure, startCommand, type CommandResult } from '../src/command.ts';
import { CompatTaskReadError, readCompatTask, type CompatTaskObservation } from '../src/subtask-compat-task-read.ts';

const projectId = 'project', taskId = 'task', workerId = 'worker', claimId = 'claim';
const time = '2026-11-24T10:00:00Z';
const session = (reason = 'idle'): CompatTaskObservation & Record<string, unknown> => ({ schemaVersion: 1, observation: 'observed', registration: 'registered', reason, claimId, sessionId: 'session', nativeSessionId: 'native', executionGeneration: '1', connectionEpoch: '1', agentControlMode: 'web', contentKind: 'native_timeline', provider: 'codex', indicator: 'working', activity: 'working', connectionState: 'connected', lifecycle: 'active', currentTurnId: null, needsAttention: false, send: { allowed: true, mode: 'steer', reason: 'allowed' }, error: null, observedAt: time, lastSeenAt: time, freshUntil: time });
const task = () => ({ id: taskId, projectId, version: 3, status: 'in_progress', properties: { worker: { workerId, claimId, state: 'active' } }, session: session() });
const result = (value: unknown, exitCode = 0): CommandResult => ({ stdout: JSON.stringify(value), stderr: exitCode === 3 ? 'partial Session\n' : '', exitCode });
const partial = (reason: string) => {
  const value = task();
  value.session = { ...session(reason), observation: 'unavailable', registration: 'unknown', claimId: null, error: { code: reason, message: 'query again' } };
  return result(value, 3);
};
const options = { projectId, taskId, workerId, claimId, intervalMs: 1, timeoutMs: 1_000 };

test('rechecks the same read after returned and thrown recoverable observations', async () => {
  const calls: string[][] = [];
  const values = [partial('execution_changed'), partial('observation_unavailable'), result(task())];
  const actual = await readCompatTask({ ...options, command: async args => {
    calls.push(args);
    const next = values.shift()!;
    if (calls.length === 2) throw new CommandFailure('daynight', next);
    return next;
  } });
  assert.deepEqual(actual, task());
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ['task', 'show', taskId, '--project', projectId, '--json']));
});

test('accepts a complete Task before a claim exists and supports an observed claim without an expected claim ID', async () => {
  const unclaimed = task(); delete (unclaimed.properties as { worker?: unknown }).worker;
  unclaimed.session = { ...session(), registration: 'not_applicable', claimId: null };
  assert.deepEqual(await readCompatTask({ ...options, claimId: undefined, command: async () => result(unclaimed) }), unclaimed);
  assert.deepEqual(await readCompatTask({ ...options, claimId: undefined, command: async () => result(task()) }), task());
});

test('does not retry unknown, unsupported, malformed, or contradictory observations', async () => {
  const invalid = [partial('upgrade_required'), partial('insufficient_scope'), result({ ...task(), session: { ...session(), observation: 'unsupported' } }, 3),
    result({ ...task(), session: { ...session('execution_changed'), observation: 'observed' } }, 3),
    result({ ...task(), session: { ...session('execution_changed'), observation: 'unavailable', error: { code: 5, message: 'bad' } } }, 3),
    result({ ...task(), session: { ...session('execution_changed'), observation: 'unavailable', error: { code: 'forbidden', message: 'denied' } } }, 3),
    result({ ...task(), session: { ...session('execution_changed'), observation: 'unavailable', send: null } }, 3),
    { stdout: '{', stderr: 'partial', exitCode: 3 },
    result({ ...task(), session: { ...session(), observation: 'unavailable' } }),
  ];
  for (const response of invalid) {
    let calls = 0;
    await assert.rejects(readCompatTask({ ...options, command: async () => { calls++; return response; } }), CompatTaskReadError);
    assert.equal(calls, 1);
  }
});

test('never retries another exit code or an arbitrary thrown error', async () => {
  const failure = new CommandFailure('daynight', { stdout: '', stderr: 'forbidden', exitCode: 1 });
  const unknown = new Error('transport failed');
  for (const thrown of [failure, unknown]) {
    let calls = 0;
    await assert.rejects(readCompatTask({ ...options, command: async () => { calls++; throw thrown; } }), error => error === thrown);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(readCompatTask({ ...options, command: async () => { calls++; return failure.result; } }), error => error instanceof CommandFailure && error.result === failure.result);
  assert.equal(calls, 1);
});

test('rejects project, Task, worker, claim and Session claim mismatch, even on exit 3', async () => {
  for (const change of [
    (value: ReturnType<typeof task>) => { value.projectId = 'other'; },
    (value: ReturnType<typeof task>) => { value.id = 'other'; },
    (value: ReturnType<typeof task>) => { value.properties.worker.workerId = 'other'; },
    (value: ReturnType<typeof task>) => { value.properties.worker.claimId = 'other'; },
    (value: ReturnType<typeof task>) => { value.session.claimId = 'other'; },
    (value: ReturnType<typeof task>) => { delete (value.properties as { worker?: unknown }).worker; },
  ]) {
    const value = JSON.parse(partial('execution_changed').stdout) as ReturnType<typeof task>;
    change(value);
    let calls = 0;
    await assert.rejects(readCompatTask({ ...options, command: async () => { calls++; return result(value, 3); } }), error => {
      assert.ok(error instanceof CompatTaskReadError); assert.match(error.message, /identity mismatch/);
      assert.equal(error.observations[0]?.reason, 'execution_changed'); return true;
    });
    assert.equal(calls, 1);
  }
});

test('requires a registered Session to identify its claim', async () => {
  const value = task(); value.session.claimId = null;
  await assert.rejects(readCompatTask({ ...options, command: async () => result(value) }), /Session claim identity mismatch/);
});

test('pins the first observed Worker and claim during recovery even without an expected claim', async () => {
  const changed = task(); changed.properties.worker.claimId = 'replacement';
  let calls = 0;
  await assert.rejects(readCompatTask({ ...options, claimId: undefined, command: async () => ++calls === 1 ? partial('execution_changed') : result(changed) }), /identity mismatch/);
  assert.equal(calls, 2);
});

test('deadline retains reasons, errors, freshness and stderr; no partial Task is returned', async () => {
  let calls = 0;
  await assert.rejects(readCompatTask({ ...options, timeoutMs: 20, intervalMs: 2, command: async () => { calls++; return partial('observation_unavailable'); } }), error => {
    assert.ok(error instanceof CompatTaskReadError);
    assert.match(error.message, /deadline exceeded/);
    assert.deepEqual(error.observations[0], { reason: 'observation_unavailable', error: { code: 'observation_unavailable', message: 'query again' }, observedAt: time, lastSeenAt: time, freshUntil: time, stderr: 'partial Session\n' });
    assert.match(error.message, /query again/);
    return true;
  });
  assert.ok(calls >= 1);
});

test('a later command failure retains earlier partial diagnostics', async () => {
  let calls = 0;
  const error = new Error('read failed');
  await assert.rejects(readCompatTask({ ...options, command: async () => { if (++calls === 1) return partial('execution_changed'); throw error; } }), cause => {
    assert.ok(cause instanceof CompatTaskReadError); assert.equal(cause.cause, error);
    assert.equal(cause.observations[0]?.reason, 'execution_changed'); return true;
  });
});

test('an expired retry deadline waits for the in-flight command to finish its cleanup', async () => {
  let release!: () => void, started!: () => void, calls = 0, settled = false, cleaned = false;
  const startedCommand = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = readCompatTask({ ...options, timeoutMs: 20, command: async () => {
    calls++; started(); await gate; cleaned = true; return result(task());
  } });
  void reading.then(() => { settled = true; }, () => { settled = true; });
  await startedCommand;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(settled, false);
  assert.equal(cleaned, false);
  release();
  await assert.rejects(reading, /deadline exceeded/);
  assert.equal(cleaned, true);
  assert.equal(calls, 1);
});

test('deadline waits for a real owned process and leaves command lifecycle confirmed', async () => {
  let ready!: () => void, settled = false;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const command = startCommand(process.execPath, ['-e', "process.stderr.write('ready');process.stdin.once('data',()=>{process.stdout.write(process.argv[1],()=>process.exit(0));});", JSON.stringify(task())], {
    cwd: process.cwd(), timeoutMs: 5_000, stdin: 'pipe', onOutput: (channel, chunk) => { if (channel === 'stderr' && chunk.includes('ready')) ready(); },
  });
  const reading = readCompatTask({ ...options, timeoutMs: 20, command: async () => command.finished });
  void reading.then(() => { settled = true; }, () => { settled = true; });
  try {
    await started;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(settled, false);
    await command.writeInput('finish');
    await assert.rejects(reading, /deadline exceeded/);
    assertCommandQuiescence();
  } finally { await command.stop(); }
});

test('rejects an unsafe version and invalid identity or retry timing without executing a command', async () => {
  let calls = 0;
  await assert.rejects(readCompatTask({ ...options, command: async () => { calls++; return result({ ...task(), version: Number.MAX_SAFE_INTEGER + 1 }); } }), /malformed Task/);
  for (const change of [{ workerId: undefined }, { timeoutMs: 0 }, { intervalMs: Infinity }]) {
    await assert.rejects(readCompatTask({ ...options, ...change, command: async () => { calls++; return result(task()); } }), /Invalid Task read/);
  }
  assert.equal(calls, 1);
});
