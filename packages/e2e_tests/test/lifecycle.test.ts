import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLifecycle, prepareWithLifecycle } from '../src/lifecycle.ts';

test('partial setup releases acquired resources in reverse order and preserves setup error', async () => {
  const released: string[] = [];
  const failure = new Error('setup failed');
  await assert.rejects(prepareWithLifecycle(async (lifecycle) => {
    lifecycle.defer(async () => { released.push('database'); });
    lifecycle.defer(async () => { released.push('application'); });
    throw failure;
  }), (error) => error === failure);
  assert.deepEqual(released, ['application', 'database']);
});

test('cleanup continues after failures and remains idempotent', async () => {
  const lifecycle = createLifecycle();
  const released: string[] = [];
  const failure = new Error('application cleanup failed');
  lifecycle.defer(async () => { released.push('database'); });
  lifecycle.defer(async () => { released.push('application'); throw failure; });
  await assert.rejects(lifecycle.close(), (error) => error === failure);
  await assert.rejects(lifecycle.close(), (error) => error === failure);
  assert.deepEqual(released, ['application', 'database']);
  assert.throws(() => lifecycle.defer(async () => {}), /after cleanup starts/);
});

test('setup and cleanup errors are both retained', async () => {
  const setup = new Error('setup');
  const cleanup = new Error('cleanup');
  await assert.rejects(prepareWithLifecycle(async (lifecycle) => {
    lifecycle.defer(async () => { throw cleanup; });
    throw setup;
  }), (error) => error instanceof AggregateError && error.cause === setup && error.errors[0] === setup && error.errors[1] === cleanup);
});

test('application diagnostic failure does not skip stop, terminal inspection or removal', async () => {
  const { cleanupApplication } = await import('../src/environment.ts');
  const operations: string[] = [];
  const diagnosticError = new Error('log volume write failed');
  const shutdownError = new Error('runtime terminal exit was nonzero');
  let captureCount = 0;
  await assert.rejects(cleanupApplication({
    captureDiagnostics: async () => { operations.push('diagnostics'); if (captureCount++ === 0) throw diagnosticError; },
    checkRunning: async () => { operations.push('running-state'); },
    stop: async () => { operations.push('stop'); },
    checkStopped: async () => { operations.push('terminal-state'); throw shutdownError; },
    remove: async () => { operations.push('remove'); },
  }), (error) => error instanceof AggregateError && error.errors[0] === diagnosticError && error.errors[1] === shutdownError);
  assert.deepEqual(operations, ['diagnostics', 'running-state', 'stop', 'terminal-state', 'diagnostics', 'remove']);
});
