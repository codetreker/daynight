import assert from 'node:assert/strict';
import { test } from 'vitest';
import { verifyImpactProjects, type ProjectAccessCheck } from '../src/features/github-app-impact/verify-projects';

const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const denial = new Error('denied');
const setup = (overrides: Partial<ProjectAccessCheck> = {}): ProjectAccessCheck => ({ signal: new AbortController().signal, ready: async signal => signal.throwIfAborted(), read: async () => {}, isDenied: error => error === denial, isCurrent: () => true, onDenied: () => {}, ...overrides });

test('permission denial clears the projection immediately without waiting for other checks', async () => {
  const pending = deferred<void>(), cleared = deferred<void>();
  const result = verifyImpactProjects([{ id: 'slow' }, { id: 'denied' }], setup({ read: id => id === 'slow' ? pending.promise : Promise.reject(denial), onDenied: () => cleared.resolve() }));
  await cleared.promise; await assert.rejects(result, error => error === denial); pending.resolve();
});

test('ignores denial callbacks from cancelled or superseded operations', async () => {
  const pending = deferred<void>(), controller = new AbortController(); let calls = 0, current = true;
  const result = verifyImpactProjects([{ id: 'project' }], setup({ signal: controller.signal, read: () => pending.promise, isCurrent: () => current, onDenied: () => calls++ }));
  await Promise.resolve(); current = false; controller.abort(); pending.reject(denial);
  await assert.rejects(result); assert.equal(calls, 0);
});

test('reports a later denial even if a different check already failed', async () => {
  const pending = deferred<void>(), failure = new Error('network'); let calls = 0;
  const result = verifyImpactProjects([{ id: 'failure' }, { id: 'denied' }], setup({ read: id => id === 'failure' ? Promise.reject(failure) : pending.promise, onDenied: () => calls++ }));
  await assert.rejects(result, error => error === failure); pending.reject(denial); await Promise.resolve(); await Promise.resolve(); assert.equal(calls, 1);
});

test('does not interpret admission failures as Project denial', async () => {
  let calls = 0;
  await assert.rejects(verifyImpactProjects([{ id: 'project' }], setup({ ready: async () => { throw denial; }, onDenied: () => calls++ })));
  assert.equal(calls, 0);
});
