import assert from 'node:assert/strict';
import test from 'node:test';
import { runPipeline } from './pipeline.mts';

const deferred = <T = void,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};
const names = ['nativePreparation', 'nativeFunctional', 'container', 'releaseContainer', 'capacity'] as const;
type Phase = typeof names[number];
const harness = () => {
  const events: string[] = [];
  const gates = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<Phase, ReturnType<typeof deferred<void>>>;
  const began = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<Phase, ReturnType<typeof deferred<void>>>;
  const ended = Object.fromEntries(names.map((name) => [name, deferred()])) as Record<Phase, ReturnType<typeof deferred<void>>>;
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

test('waits for native preparation, releases a late container callback, and runs capacity after cleanup', async () => {
  const run = harness();
  const callbackReady = deferred();
  const callbackWaiting = deferred();
  const permission = deferred();
  const nativeRecovery = deferred();
  const containerRecovery = deferred();
  const containerRecovered = deferred();
  let browserOwner: 'native' | 'container' | 'capacity' | undefined;
  const controller = new AbortController();
  run.phases.nativeFunctional = async () => {
    run.events.push('nativeFunctional:start');
    assert.equal(browserOwner, undefined);
    browserOwner = 'native';
    run.began.nativeFunctional.resolve();
    await run.gates.nativeFunctional.promise;
    await nativeRecovery.promise;
    browserOwner = undefined;
    run.events.push('nativeFunctional:recovered');
  };
  run.phases.releaseContainer = async () => {
    assert.equal(browserOwner, undefined);
    run.events.push('releaseContainer:start');
    run.began.releaseContainer.resolve();
    permission.resolve();
  };
  run.phases.container = async () => {
    run.events.push('container:start');
    run.began.container.resolve();
    await callbackReady.promise;
    run.events.push('container:callback');
    callbackWaiting.resolve();
    await permission.promise;
    assert.equal(browserOwner, undefined);
    browserOwner = 'container';
    run.events.push('container:browser');
    await run.gates.container.promise;
    await containerRecovery.promise;
    browserOwner = undefined;
    run.events.push('container:recovered');
    containerRecovered.resolve();
  };
  run.phases.capacity = async () => {
    assert.equal(browserOwner, undefined);
    browserOwner = 'capacity';
    run.events.push('capacity:start');
    run.began.capacity.resolve();
    await run.gates.capacity.promise;
    browserOwner = undefined;
  };
  const completion = observe(runPipeline(controller, run.phases));
  await startedInitial(run);
  assert.deepEqual(run.events, initial.map((name) => `${name}:start`));
  assert.equal(run.events.includes('nativePreparation:end'), false);
  assert.equal(run.events.includes('container:end'), false);
  run.gates.nativePreparation.resolve();
  await run.began.nativeFunctional.promise;
  assert.ok(run.events.indexOf('nativePreparation:end') < run.events.indexOf('nativeFunctional:start'));
  run.gates.nativeFunctional.resolve();
  assert.equal(run.events.includes('releaseContainer:start'), false);
  nativeRecovery.resolve();
  await run.began.releaseContainer.promise;
  assert.equal(run.events.includes('container:callback'), false);
  callbackReady.resolve();
  await callbackWaiting.promise;
  run.gates.container.resolve();
  await run.ended.nativePreparation.promise;
  assert.equal(run.events.includes('capacity:start'), false);
  assert.equal(completion.settled(), false);
  containerRecovery.resolve();
  await containerRecovered.promise;
  await run.began.capacity.promise;
  assert.equal(run.events.at(-2), 'container:recovered');
  assert.equal(run.events.at(-1), 'capacity:start');
  run.gates.capacity.resolve();
  assert.equal((await completion.result).error, undefined);
  assert.equal(controller.signal.aborted, false);
});

test('an early container callback waits for native browser recovery before using the browser', async () => {
  const run = harness();
  const permission = deferred();
  const waiting = deferred();
  const nativeRecovery = deferred();
  let nativeBrowser = false;
  run.phases.container = async () => {
    run.began.container.resolve();
    waiting.resolve();
    await permission.promise;
    assert.equal(nativeBrowser, false);
    run.events.push('container:browser');
    await run.gates.container.promise;
  };
  run.phases.nativeFunctional = async () => {
    nativeBrowser = true;
    run.began.nativeFunctional.resolve();
    await nativeRecovery.promise;
    nativeBrowser = false;
    run.events.push('native:recovered');
  };
  run.phases.releaseContainer = async () => {
    run.events.push('releaseContainer:start');
    permission.resolve();
  };
  const completion = observe(runPipeline(new AbortController(), run.phases));
  await startedInitial(run);
  await waiting.promise;
  run.gates.nativePreparation.resolve();
  await run.began.nativeFunctional.promise;
  assert.equal(run.events.includes('container:browser'), false);
  nativeRecovery.resolve();
  run.gates.container.resolve();
  await run.began.capacity.promise;
  assert.ok(run.events.indexOf('native:recovered') < run.events.indexOf('releaseContainer:start'));
  assert.ok(run.events.indexOf('releaseContainer:start') < run.events.indexOf('container:browser'));
  run.gates.capacity.resolve();
  assert.equal((await completion.result).error, undefined);
});

for (const failed of initial) test(`${failed} failure aborts immediately and drains every started preparation`, async () => {
  const run = harness();
  const controller = new AbortController();
  const aborted = deferred();
  controller.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
  const failure = new Error(`${failed} failed`);
  const completion = observe(runPipeline(controller, run.phases));
  await startedInitial(run);
  run.gates[failed].reject(failure);
  await aborted.promise;
  assert.equal(controller.signal.reason, failure);
  for (const name of initial) if (name !== failed && name !== 'container') run.gates[name].resolve();
  await Promise.all(initial.filter((name) => name !== 'container').map((name) => run.ended[name].promise));
  if (failed !== 'container') {
    assert.equal(completion.settled(), false);
    run.gates.container.resolve();
  }
  assert.equal((await completion.result).error, failure);
  assert.equal(run.events.includes('nativeFunctional:start'), false);
  assert.equal(run.events.includes('releaseContainer:start'), false);
  assert.equal(run.events.includes('capacity:start'), false);
});

test('retains native functional and container cleanup failures without repeating the cancellation reason', async () => {
  const run = harness();
  const controller = new AbortController();
  const aborted = deferred();
  controller.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
  const failure = new Error('Native functional failed.');
  const cleanupFailure = new Error('Container cleanup failed.');
  const completion = observe(runPipeline(controller, run.phases));
  await startedInitial(run);
  run.gates.nativePreparation.resolve();
  await run.began.nativeFunctional.promise;
  run.gates.nativeFunctional.reject(failure);
  await aborted.promise;
  assert.equal(controller.signal.reason, failure);
  run.gates.container.reject(cleanupFailure);
  const { error } = await completion.result;
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(error.errors, [failure, cleanupFailure]);
  assert.equal(run.events.includes('releaseContainer:start'), false);
  assert.equal(run.events.includes('capacity:start'), false);
});

test('a container release failure prevents capacity and waits for container shutdown', async () => {
  const run = harness();
  const controller = new AbortController();
  const failure = new Error('Container permission failed.');
  const completion = observe(runPipeline(controller, run.phases));
  await startedInitial(run);
  run.gates.nativePreparation.resolve();
  await run.began.nativeFunctional.promise;
  run.gates.nativeFunctional.resolve();
  await run.began.releaseContainer.promise;
  run.gates.releaseContainer.reject(failure);
  await run.ended.releaseContainer.promise;
  assert.equal(completion.settled(), false);
  run.gates.container.resolve();
  assert.equal((await completion.result).error, failure);
  assert.equal(controller.signal.reason, failure);
  assert.equal(run.events.includes('capacity:start'), false);
});

test('capacity failure aborts after every earlier operation has finished', async () => {
  const run = harness();
  const controller = new AbortController();
  const completion = observe(runPipeline(controller, run.phases));
  await startedInitial(run);
  run.gates.nativePreparation.resolve();
  run.gates.container.resolve();
  await run.began.nativeFunctional.promise;
  run.gates.nativeFunctional.resolve();
  await run.began.releaseContainer.promise;
  run.gates.releaseContainer.resolve();
  await run.began.capacity.promise;
  for (const name of names.filter((name) => name !== 'capacity')) assert.ok(run.events.includes(`${name}:end`));
  const failure = new Error('Capacity failed.');
  run.gates.capacity.reject(failure);
  assert.equal((await completion.result).error, failure);
  assert.equal(controller.signal.reason, failure);
});

test('external abort rejects a blocked container callback and waits for task cleanup', async () => {
  const run = harness();
  const controller = new AbortController();
  const callbackWaiting = deferred();
  const cleanup = deferred();
  const callbackAborted = deferred();
  run.phases.container = async () => {
    run.began.container.resolve();
    try {
      await new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => { callbackAborted.resolve(); reject(controller.signal.reason); }, { once: true });
        callbackWaiting.resolve();
      });
    } finally { await cleanup.promise; }
  };
  const completion = observe(runPipeline(controller, run.phases));
  await startedInitial(run);
  await callbackWaiting.promise;
  const reason = new Error('SIGTERM');
  controller.abort(reason);
  await callbackAborted.promise;
  run.gates.nativePreparation.resolve();
  await run.ended.nativePreparation.promise;
  assert.equal(completion.settled(), false);
  cleanup.resolve();
  assert.equal((await completion.result).error, reason);
  assert.equal(run.events.includes('nativeFunctional:start'), false);
  assert.equal(run.events.includes('releaseContainer:start'), false);
  assert.equal(run.events.includes('capacity:start'), false);
});

test('external abort during native functional recovery prevents container permission release', async () => {
  const run = harness();
  const controller = new AbortController();
  const completion = observe(runPipeline(controller, run.phases));
  await startedInitial(run);
  run.gates.nativePreparation.resolve();
  await run.began.nativeFunctional.promise;
  const reason = new Error('SIGTERM during native recovery');
  controller.abort(reason);
  run.gates.container.resolve();
  await Promise.all([run.ended.nativePreparation.promise, run.ended.container.promise]);
  assert.equal(completion.settled(), false);
  run.gates.nativeFunctional.resolve();
  assert.equal((await completion.result).error, reason);
  assert.equal(run.events.includes('releaseContainer:start'), false);
  assert.equal(run.events.includes('capacity:start'), false);
});

test('a pre-aborted pipeline does not start operations', async () => {
  const run = harness();
  const controller = new AbortController();
  const reason = new Error('Already stopped.');
  controller.abort(reason);
  await assert.rejects(runPipeline(controller, run.phases), (error) => error === reason);
  assert.deepEqual(run.events, []);
});

test('native target executes only preparation, functional recovery and then capacity', async () => {
  const { runTargetPipeline } = await import('./pipeline.mts');
  const events: string[] = [];
  const functional = deferred();
  const began = deferred();
  const pending = runTargetPipeline(new AbortController(), { target: 'native',
    preparation: async () => { events.push('prepared'); },
    functional: async () => { events.push('functional'); began.resolve(); await functional.promise; events.push('recovered'); },
    capacity: async () => { events.push('capacity'); },
  });
  await began.promise;
  assert.deepEqual(events, ['prepared', 'functional']);
  functional.resolve();
  await pending;
  assert.deepEqual(events, ['prepared', 'functional', 'recovered', 'capacity']);
});

test('container target prepares its installation and directly executes its owned gateway', async () => {
  const { runTargetPipeline } = await import('./pipeline.mts');
  const events: string[] = [];
  await runTargetPipeline(new AbortController(), { target: 'container',
    preparation: async () => { events.push('installed'); }, container: async () => { events.push('container'); },
  });
  assert.deepEqual(events, ['installed', 'container']);
});

test('target pipeline cancellation and failures prevent later phases without replacing the reason', async () => {
  const { runTargetPipeline } = await import('./pipeline.mts');
  for (const aborted of [false, true]) {
    const controller = new AbortController();
    const failure = new Error('Target preparation failed');
    let later = false;
    await assert.rejects(runTargetPipeline(controller, { target: 'native', preparation: async () => {
      if (aborted) controller.abort(failure); else throw failure;
    }, functional: async () => { later = true; }, capacity: async () => { later = true; } }), (error) => error === failure);
    assert.equal(later, false);
    assert.equal(controller.signal.reason, failure);
  }
});

test('target cancellation waits for the active phase and retains a separate cleanup failure', async () => {
  const { runTargetPipeline } = await import('./pipeline.mts');
  const controller = new AbortController();
  const began = deferred();
  const cleanup = deferred();
  const reason = new Error('Target cancelled');
  const cleanupFailure = new Error('Target browser cleanup failed');
  let capacity = false;
  const pending = observe(runTargetPipeline(controller, { target: 'native', preparation: async () => {},
    functional: async () => { began.resolve(); await cleanup.promise; throw cleanupFailure; }, capacity: async () => { capacity = true; },
  }));
  await began.promise;
  controller.abort(reason);
  assert.equal(pending.settled(), false);
  cleanup.resolve();
  const result = await pending.result;
  assert.ok(result.error instanceof AggregateError);
  assert.deepEqual(result.error.errors, [reason, cleanupFailure]);
  assert.equal(capacity, false);
});
