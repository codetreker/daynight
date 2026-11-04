import assert from 'node:assert/strict';
import test from 'node:test';
import { runPipeline } from './pipeline.mts';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};
const names = ['nativePreparation', 'nativeFunctional', 'container', 'releaseContainer', 'functionalCleanup', 'capacity'] as const;
type Phase = typeof names[number];
const harness = () => {
  const events: string[] = [];
  const gates = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<Phase, ReturnType<typeof deferred>>;
  const began = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<Phase, ReturnType<typeof deferred>>;
  const ended = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<Phase, ReturnType<typeof deferred>>;
  const phases = Object.fromEntries(names.map((name) => [name, async () => {
    events.push(`${name}:start`);
    began[name].resolve();
    try { await gates[name].promise; }
    finally { events.push(`${name}:end`); ended[name].resolve(); }
  }])) as Record<Phase, () => Promise<void>>;
  return { events, gates, began, ended, phases };
};
const observe = (promise: Promise<void>) => {
  let settled = false;
  const result = promise.then(() => ({ error: undefined }), (error: unknown) => ({ error })).finally(() => { settled = true; });
  return { result, settled: () => settled };
};
const initial = ['nativePreparation', 'container'] as const;
const startedInitial = async (run: ReturnType<typeof harness>): Promise<void> => {
  await Promise.all(initial.map((name) => run.began[name].promise));
};
const prepared = async (run: ReturnType<typeof harness>): Promise<void> => {
  await startedInitial(run);
  run.gates.nativePreparation.resolve();
  await Promise.all([run.began.nativeFunctional.promise, run.began.releaseContainer.promise]);
};

test('functional-only acceptance overlaps both targets and waits for shared cleanup', async () => {
  const run = harness();
  const controller = new AbortController();
  const { capacity: _capacity, ...phases } = run.phases;
  const completion = observe(runPipeline(controller, phases));
  await startedInitial(run);
  assert.deepEqual(run.events, initial.map((name) => `${name}:start`));
  await prepared(run);
  assert.equal(run.events.includes('nativeFunctional:end'), false);
  run.gates.releaseContainer.resolve();
  run.gates.container.resolve();
  await run.ended.container.promise;
  assert.equal(run.events.includes('functionalCleanup:start'), false);
  run.gates.nativeFunctional.resolve();
  await run.began.functionalCleanup.promise;
  assert.equal(completion.settled(), false);
  run.gates.functionalCleanup.resolve();
  assert.equal((await completion.result).error, undefined);
  assert.equal(controller.signal.aborted, false);
  assert.equal(run.events.includes('capacity:start'), false);
});

for (const callbackTiming of ['early', 'late'] as const) test(`${callbackTiming} container callback runs during native checks after preparation`, async () => {
  const run = harness();
  const callbackReady = deferred();
  const permission = deferred();
  const containerBrowser = deferred();
  const nativeRecovery = deferred();
  const containerRecovery = deferred();
  run.phases.nativeFunctional = async () => {
    run.began.nativeFunctional.resolve();
    await nativeRecovery.promise;
    run.events.push('native:recovered');
  };
  run.phases.releaseContainer = async () => {
    assert.ok(run.events.includes('nativePreparation:end'));
    run.began.releaseContainer.resolve();
    permission.resolve();
  };
  run.phases.container = async () => {
    run.began.container.resolve();
    await callbackReady.promise;
    await permission.promise;
    assert.equal(run.events.includes('native:recovered'), false);
    containerBrowser.resolve();
    await containerRecovery.promise;
    run.events.push('container:recovered');
  };
  const completion = observe(runPipeline(new AbortController(), run.phases));
  await startedInitial(run);
  if (callbackTiming === 'early') callbackReady.resolve();
  await prepared(run);
  if (callbackTiming === 'late') callbackReady.resolve();
  await containerBrowser.promise;
  assert.equal(run.events.includes('functionalCleanup:start'), false);
  nativeRecovery.resolve();
  containerRecovery.resolve();
  await run.began.functionalCleanup.promise;
  assert.ok(run.events.includes('native:recovered'));
  assert.ok(run.events.includes('container:recovered'));
  assert.equal(run.events.includes('capacity:start'), false);
  run.gates.functionalCleanup.resolve();
  await run.began.capacity.promise;
  assert.ok(run.events.indexOf('functionalCleanup:end') < run.events.indexOf('capacity:start'));
  run.gates.capacity.resolve();
  assert.equal((await completion.result).error, undefined);
});

for (const failed of initial) test(`${failed} failure aborts and drains preparation without releasing browser work`, async () => {
  const run = harness();
  const controller = new AbortController();
  const aborted = deferred();
  controller.signal.addEventListener('abort', aborted.resolve, { once: true });
  const failure = new Error(`${failed} failed`);
  const completion = observe(runPipeline(controller, run.phases));
  await startedInitial(run);
  run.gates[failed].reject(failure);
  await aborted.promise;
  assert.equal(controller.signal.reason, failure);
  assert.equal(completion.settled(), false);
  for (const name of initial) if (name !== failed) run.gates[name].resolve();
  assert.equal((await completion.result).error, failure);
  for (const name of ['nativeFunctional', 'releaseContainer', 'functionalCleanup', 'capacity']) assert.equal(run.events.includes(`${name}:start`), false);
});

test('retains concurrent native and container failures and drains release before returning', async () => {
  const run = harness();
  const controller = new AbortController();
  const failure = new Error('Native functional failed.');
  const cleanupFailure = new Error('Container cleanup failed.');
  const completion = observe(runPipeline(controller, run.phases));
  await prepared(run);
  run.gates.nativeFunctional.reject(failure);
  run.gates.container.reject(cleanupFailure);
  await run.ended.nativeFunctional.promise;
  await run.ended.container.promise;
  assert.equal(completion.settled(), false);
  run.gates.releaseContainer.resolve();
  const { error } = await completion.result;
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(new Set(error.errors), new Set([failure, cleanupFailure]));
  assert.equal(run.events.includes('functionalCleanup:start'), false);
  assert.equal(run.events.includes('capacity:start'), false);
});

test('permission failure cancels both active targets and drains their cleanup', async () => {
  const run = harness();
  const controller = new AbortController();
  const failure = new Error('Container permission failed.');
  const completion = observe(runPipeline(controller, run.phases));
  await prepared(run);
  run.gates.releaseContainer.reject(failure);
  await run.ended.releaseContainer.promise;
  assert.equal(completion.settled(), false);
  run.gates.nativeFunctional.resolve();
  run.gates.container.resolve();
  assert.equal((await completion.result).error, failure);
  assert.equal(controller.signal.reason, failure);
  assert.equal(run.events.includes('functionalCleanup:start'), false);
  assert.equal(run.events.includes('capacity:start'), false);
});

for (const failed of ['functionalCleanup', 'capacity'] as const) test(`${failed} failure propagates after both targets finish`, async () => {
  const run = harness();
  const controller = new AbortController();
  const completion = observe(runPipeline(controller, run.phases));
  await prepared(run);
  run.gates.nativeFunctional.resolve();
  run.gates.releaseContainer.resolve();
  run.gates.container.resolve();
  await run.began.functionalCleanup.promise;
  for (const name of ['nativePreparation', 'nativeFunctional', 'releaseContainer', 'container']) assert.ok(run.events.includes(`${name}:end`));
  if (failed === 'capacity') {
    run.gates.functionalCleanup.resolve();
    await run.began.capacity.promise;
  }
  const failure = new Error(`${failed} failed`);
  run.gates[failed].reject(failure);
  assert.equal((await completion.result).error, failure);
  assert.equal(controller.signal.reason, failure);
  if (failed === 'functionalCleanup') assert.equal(run.events.includes('capacity:start'), false);
});

for (const timing of ['preparation', 'functional'] as const) test(`external abort during ${timing} drains all started work`, async () => {
  const run = harness();
  const controller = new AbortController();
  const completion = observe(runPipeline(controller, run.phases));
  await startedInitial(run);
  if (timing === 'functional') await prepared(run);
  const reason = new Error('SIGTERM');
  controller.abort(reason);
  run.gates.nativePreparation.resolve();
  if (timing === 'functional') {
    run.gates.nativeFunctional.resolve();
    run.gates.releaseContainer.resolve();
    await run.ended.nativeFunctional.promise;
    await run.ended.releaseContainer.promise;
  }
  await run.ended.nativePreparation.promise;
  assert.equal(completion.settled(), false);
  run.gates.container.resolve();
  assert.equal((await completion.result).error, reason);
  assert.equal(run.events.includes('functionalCleanup:start'), false);
  assert.equal(run.events.includes('capacity:start'), false);
});

test('an already-aborted invocation starts no work', async () => {
  const run = harness();
  const controller = new AbortController();
  const failure = new Error('Already cancelled.');
  controller.abort(failure);
  await assert.rejects(runPipeline(controller, run.phases), (error) => error === failure);
  assert.deepEqual(run.events, []);
});
