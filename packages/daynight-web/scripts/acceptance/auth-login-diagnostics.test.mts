import assert from 'node:assert/strict';
import test from 'node:test';
import { runAuthLogin, type AuthLoginOperation, type AuthLoginStep } from '../../tests/e2e/auth-login-diagnostics.ts';

const directStep: AuthLoginStep = async (_, action) => action();
const setup = (attach: (operations: readonly AuthLoginOperation[]) => Promise<void> = async () => {}) => ({
  step: directStep, attach, cleanupTimeoutMs: 20,
});
const rejectWith = async (failure: unknown): Promise<never> => { throw failure; };

test('successful login records operations and completes every cleanup before attaching diagnostics', async () => {
  const events: string[] = [];
  let receipt: readonly AuthLoginOperation[] = [];
  const value = await runAuthLogin(setup(async (operations) => {
    events.push('attach');
    receipt = operations;
  }), async ({ operation, withCleanup }) => withCleanup(async () => {
    await operation('Complete login', async () => { events.push('login'); });
    return 'authenticated';
  }, [
    { operation: 'Disable interception', action: async () => { events.push('disable'); } },
    { operation: 'Detach session', action: async () => { events.push('detach'); } },
  ]));
  assert.equal(value, 'authenticated');
  assert.deepEqual(events, ['login', 'disable', 'detach', 'attach']);
  assert.deepEqual(receipt.map(({ operation, status }) => ({ operation, status })), [
    { operation: 'Complete login', status: 'passed' },
    { operation: 'Disable interception', status: 'passed' },
    { operation: 'Detach session', status: 'passed' },
  ]);
  assert.ok(receipt.every((operation) => Number.isInteger(operation.durationMs) && operation.durationMs >= 0));
});

test('a primary login error retains its identity when cleanup and diagnostics succeed', async () => {
  const primary = new Error('The original login assertion failed.');
  let receipt: readonly AuthLoginOperation[] = [];
  let detached = false;
  await assert.rejects(runAuthLogin(setup(async (operations) => { receipt = operations; }),
    async ({ operation, withCleanup }) => withCleanup(() => operation('Assert login', () => rejectWith(primary)), [
      { operation: 'Detach session', action: async () => { detached = true; } },
    ])), (error) => error === primary);
  assert.equal(detached, true);
  assert.equal(receipt[0]?.operation, 'Assert login');
  assert.equal(receipt[0]?.status, 'failed');
  assert.equal(receipt[0]?.errorName, 'Error');
});

test('an actual timed out login operation remains first when disable and detach both fail', async () => {
  const primary = new Error('Timed out waiting for the login callback.');
  primary.name = 'TimeoutError';
  const disable = new Error('Fetch.disable target closed.');
  const detach = new Error('Detach target closed.');
  const events: string[] = [];
  let receipt: readonly AuthLoginOperation[] = [];
  await assert.rejects(runAuthLogin(setup(async (operations) => { receipt = operations; }),
    async ({ operation, withCleanup }) => withCleanup(() => operation('Wait for login callback', () => new Promise<never>((_, reject) => {
      setTimeout(() => reject(primary), 10);
    })), [
      { operation: 'Disable interception', action: async () => { events.push('disable'); throw disable; } },
      { operation: 'Detach session', action: async () => { events.push('detach'); throw detach; } },
    ])), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.deepEqual(error.errors, [primary, disable, detach]);
      return true;
    });
  assert.deepEqual(events, ['disable', 'detach']);
  assert.deepEqual(receipt.map(({ status, errorName }) => ({ status, errorName })), [
    { status: 'failed', errorName: 'TimeoutError' },
    { status: 'failed', errorName: 'Error' },
    { status: 'failed', errorName: 'Error' },
  ]);
});

test('failed disable still detaches and fails an otherwise successful login', async () => {
  const failure = new Error('Fetch.disable failed.');
  let detached = false;
  await assert.rejects(runAuthLogin(setup(), async ({ withCleanup }) => withCleanup(async () => {}, [
    { operation: 'Disable interception', action: () => rejectWith(failure) },
    { operation: 'Detach session', action: async () => { detached = true; } },
  ])), (error) => error === failure);
  assert.equal(detached, true);
});

test('hung disable reaches its cleanup deadline and still detaches; its late rejection is observed', async () => {
  const disabled = Promise.withResolvers<void>();
  let detached = false;
  const started = performance.now();
  await assert.rejects(runAuthLogin(setup(), async ({ withCleanup }) => withCleanup(async () => {}, [
    { operation: 'Disable interception', action: () => disabled.promise },
    { operation: 'Detach session', action: async () => { detached = true; } },
  ])), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'TimeoutError');
    assert.match(error.message, /Disable interception/);
    return true;
  });
  assert.equal(detached, true);
  assert.ok(performance.now() - started < 1_000);
  disabled.reject(new Error('Late CDP target closure.'));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('detach failure remains observable after successful disable', async () => {
  const failure = new Error('Detach failed.');
  await assert.rejects(runAuthLogin(setup(), async ({ withCleanup }) => withCleanup(async () => {}, [
    { operation: 'Disable interception', action: async () => {} },
    { operation: 'Detach session', action: () => rejectWith(failure) },
  ])), (error) => error === failure);
});

test('nested identity cleanup, provider cleanup and attachment errors retain the first operation and all original errors', async () => {
  const primary = new Error('Identity assertion failed.');
  const unroute = new Error('Unroute failed.');
  const drain = new Error('Held identity read failed.');
  const disable = new Error('Disable failed.');
  const attachment = new Error('Attachment failed.');
  await assert.rejects(runAuthLogin(setup(() => rejectWith(attachment)), async ({ withCleanup }) => withCleanup(
    () => withCleanup(() => rejectWith(primary), [
      { operation: 'Unroute identity', action: () => rejectWith(unroute) },
      { operation: 'Drain held identity', action: () => rejectWith(drain) },
    ]), [{ operation: 'Disable interception', action: () => rejectWith(disable) }],
  )), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primary);
    assert.deepEqual(error.errors, [primary, unroute, drain, disable, attachment]);
    return true;
  });
});

test('attachment failure fails a successful login without replacing an original body failure', async () => {
  const attachment = new Error('Attachment failed.');
  await assert.rejects(runAuthLogin(setup(() => rejectWith(attachment)), async () => 'authenticated'), (error) => error === attachment);
});

test('operation ledger retains labels, status, duration and error names without error messages, stacks or credential data', async () => {
  const credential = 'dnst_controlled_auth_diagnostic_secret';
  const failure = new Error(`Request https://github.com/login/oauth/authorize?code=${credential} failed.`);
  let receipt: readonly AuthLoginOperation[] = [];
  await assert.rejects(runAuthLogin(setup(async (operations) => { receipt = operations; }), async ({ operation }) => {
    await operation('Complete external provider', () => rejectWith(failure));
  }), (error) => error === failure);
  assert.equal(JSON.stringify(receipt).includes(credential), false);
  assert.deepEqual(Object.keys(receipt[0]!).sort(), ['durationMs', 'errorName', 'operation', 'status']);
  assert.equal(receipt[0]?.errorName, 'Error');
});
