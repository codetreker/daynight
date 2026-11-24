import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoveryFailureDetail, verifyRecoveryReadback } from '../src/subtask-compat-recovery-readback.ts';

const expectedPhases = ['verify-web-navigation', 'verify-web-heading', 'verify-cli-task', 'verify-task-comparison', 'verify-cli-attachment', 'verify-attachment-comparison', 'verify-web-leave'];
const fixture = (stopAt?: string) => {
  const phases: string[] = [], calls: string[] = [], failure = new Error('test failure');
  const step = (name: string) => { calls.push(name); if (stopAt === name) throw failure; };
  return { phases, calls, failure, input: {
    phase: async (name: string) => { phases.push(name); }, child: 'child', goal: 'goal',
    navigate: async () => { step('navigate'); }, heading: async () => { step('heading'); },
    readTask: async () => { step('task'); return { id: 'child', parentId: 'goal' }; },
    readAttachment: async () => { step('attachment'); return 'paired122'; },
    leave: async () => { step('leave'); },
  } };
};

test('readback retains the original cross-client operations and comparisons', async () => {
  const value = fixture(); await verifyRecoveryReadback(value.input);
  assert.deepEqual(value.phases, expectedPhases);
  assert.deepEqual(value.calls, ['navigate', 'heading', 'task', 'attachment', 'leave']);
  const wrongTask = fixture(); wrongTask.input.readTask = async () => ({ id: 'child', parentId: 'wrong' });
  await assert.rejects(verifyRecoveryReadback(wrongTask.input), /Cross-client Task readback mismatch/);
  assert.equal(wrongTask.phases.at(-1), 'verify-task-comparison');
  const wrongAttachment = fixture(); wrongAttachment.input.readAttachment = async () => 'post124';
  await assert.rejects(verifyRecoveryReadback(wrongAttachment.input), /Cross-client attachment mismatch/);
  assert.equal(wrongAttachment.phases.at(-1), 'verify-attachment-comparison');
});

test('each failed observation retains its exact phase and stops later work', async () => {
  for (const [step, phase] of [['navigate', 'verify-web-navigation'], ['heading', 'verify-web-heading'], ['task', 'verify-cli-task'], ['attachment', 'verify-cli-attachment'], ['leave', 'verify-web-leave']] as const) {
    const value = fixture(step);
    await assert.rejects(verifyRecoveryReadback(value.input), error => error === value.failure);
    assert.equal(value.phases.at(-1), phase);
    assert.equal(value.calls.at(-1), step);
  }
});

test('failure details use fixed safe categories without forwarding sensitive error text', () => {
  const secret = 'token-unsafe.example/private';
  assert.equal(recoveryFailureDetail(new Error(`net::ERR_CONNECTION_RESET ${secret}`), 'verify-web-navigation'), 'net-err-connection-reset');
  assert.equal(recoveryFailureDetail(new Error(`net::ERR_SENSITIVE_${secret}`), 'verify-web-navigation'), undefined);
  assert.equal(recoveryFailureDetail(new Error(secret), 'verify-web-heading', { status: 200, taskStatus: 401, route: 'login' }), 'web-status-200-route-login-task-401');
  assert.equal(recoveryFailureDetail(new Error(secret), 'verify-web-heading', { status: 200, route: 'expected', cache: { version: 14, result: 'version-error' } }), 'web-status-200-route-expected-task-none-cache-14-open-version-error');
  assert.equal(recoveryFailureDetail(new Error(secret), 'verify-web-heading', { status: 200, route: 'expected', cache: { version: 13, result: 'opened' } }), 'web-status-200-route-expected-task-none');
  assert.equal(recoveryFailureDetail(new Error('CLI task attachment failed (exit=1).'), 'verify-cli-attachment'), 'cli-task-attachment-exit-1');
  assert.equal(recoveryFailureDetail(new Error('Cross-client attachment mismatch.'), 'verify-attachment-comparison'), 'attachment-mismatch');
  assert.equal(recoveryFailureDetail(new Error(secret), 'verify-cli-task'), undefined);
});
