import { afterEach, expect, it, vi } from 'vitest';
import { pauseAuthRequests } from '../src/api/client';
import type { TaskDetail, TaskSync, TaskSyncObservation, WorkerClaim } from '../src/api/types';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { deriveTaskSyncBindings, deriveTaskSyncVersions } from '../src/features/task-cache/execution-binding';
import { ProjectTaskObservationsStore, observationFor } from '../src/features/task-session-summary/project-observations';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '10000000-0000-4000-8000-000000000002';
const base = '2026-10-22T10:00:00Z';
const worker: WorkerClaim = { claimId: '10000000-0000-4000-8000-000000000010', state: 'active', userId: TEST_VIEWER_ID,
  workerId: '10000000-0000-4000-8000-000000000011', worktreeId: '10000000-0000-4000-8000-000000000012',
  machine: { id: '10000000-0000-4000-8000-000000000013', name: 'Worker' }, platform: 'linux', agent: 'codex',
  agentControlMode: 'web', phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: base };
const task = (changes: Partial<TaskDetail> = {}) => detailFixture(projectId, taskId, { status: 'in_progress', startedAt: base, properties: { worker }, ...changes });
const sample = (changes: Partial<TaskSyncObservation> = {}): TaskSyncObservation => ({ taskVersion: 1n, state: 'working', observedAt: base, freshUntil: '2026-10-22T10:00:30Z', needsAttention: false, canOpen: true, ...changes });
const scopes: TaskCacheScope[] = [];
const stores: ProjectTaskObservationsStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.dispose()); scopes.splice(0).forEach(s => s.dispose()); vi.useRealTimers(); });
async function setup(initial = task()) {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  async function read(item: TaskDetail, observation: TaskSyncObservation | null, overrides: Partial<TaskSync> = {}) {
    const ticket = await scope.beginSync(projectId, new AbortController().signal);
    const sync = { ...taskSyncFromGraph(graphFixture([item]), { query: ticket.epoch ? { epoch: ticket.epoch } : {}, versionForTask: () => item.version, propertiesForTask: () => item.properties,
      taskObservations: observation === null ? {} : { [taskId]: observation } }), ...overrides };
    return { ticket, sync };
  }
  const first = await read(initial, sample()); await scope.applySync(first.ticket, first.sync, new AbortController().signal);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const store = new ProjectTaskObservationsStore(scope, projectId); stores.push(store); store.start();
  async function publish(value: Awaited<ReturnType<typeof read>>, receivedMonotonic = performance.now()) {
    const result = await scope.applySync(value.ticket, value.sync, new AbortController().signal);
    store.replace({ project: result.project, observedBindings: deriveTaskSyncBindings(value.ticket, value.sync), observedVersions: deriveTaskSyncVersions(value.ticket, value.sync), sync: value.sync, receivedMonotonic });
  }
  return { scope, store, read, publish };
}
it('uses independent clocks, includes decoding time, and preserves a warning entrance during grace', async () => {
  const { store, read, publish } = await setup();
  const value = await read(task(), sample({ state: 'warning', needsAttention: true }), { responseTaskAt: '2026-10-22T10:01:59.999Z', responseSessionAt: '2026-10-22T10:00:25Z' });
  await publish(value, 0);
  expect(store.snapshot().get(taskId)).toEqual({ state: null, needsAttention: null, canOpen: true });
  await vi.advanceTimersByTimeAsync(1);
  expect(store.snapshot().get(taskId)).toEqual({ state: 'warning', needsAttention: true, canOpen: true });
  await vi.advanceTimersByTimeAsync(4999);
  expect(store.snapshot().get(taskId)).toEqual({ state: 'expired', needsAttention: null, canOpen: false });
  await publish(value, 0);
  expect(store.snapshot().get(taskId)?.state).toBe('expired');
});
it('distinguishes missing, unavailable and expired and does not invent an entrance', async () => {
  const { store, read, publish } = await setup();
  expect(observationFor(store.snapshot(), task())).toEqual({ state: 'unobserved', needsAttention: null, canOpen: false });
  await publish(await read(task(), sample({ state: 'pending', freshUntil: null, canOpen: false })));
  expect(store.snapshot().get(taskId)?.state).toBe('expired');
  await publish(await read(task(), sample({ state: 'unavailable', observedAt: null, freshUntil: null, canOpen: false, needsAttention: null })));
  expect(store.snapshot().get(taskId)).toEqual({ state: 'unavailable', needsAttention: null, canOpen: false });
  await publish(await read(task(), null));
  expect(observationFor(store.snapshot(), task())).toEqual({ state: 'unobserved', needsAttention: null, canOpen: false });
});
it('rejects late Task versions and omissions without restoring an old claim', async () => {
  const { scope, store, read, publish } = await setup();
  const old = await read(task(), sample({ state: 'notice' }));
  const newer = task({ version: 2n, updatedAt: '2026-10-22T10:00:01Z' });
  await publish(await read(newer, sample({ taskVersion: 2n, state: 'pending' })));
  await publish(old, 1);
  expect(store.snapshot().get(taskId)?.state).toBe('pending');
  const missing = await read(newer, null); await publish(missing, 2);
  expect(observationFor(store.snapshot(), newer)?.state).toBe('unobserved');
  await scope.invalidateProject(projectId, new AbortController().signal);
  expect(store.snapshot().size).toBe(0);
});

it('rejects invalid current execution combinations while permitting an active herdr binding', async () => {
  const { validateTaskSyncObservationBindings } = await import('../src/features/task-cache/execution-binding');
  const { read } = await setup();
  const value = await read(task(), sample());
  const versions = new Map([[taskId, 1n]]);
  const without = { status: 'in_progress' as const, worker: null };
  expect(() => validateTaskSyncObservationBindings(value.sync, new Map([[taskId, without]]), versions)).toThrow();
  const worker = { claimId: taskId, workerId: taskId, worktreeId: taskId, state: 'completed' as const, agentControlMode: 'herdr' as const };
  expect(() => validateTaskSyncObservationBindings(value.sync, new Map([[taskId, { ...without, worker }]]), versions)).toThrow();
  const active = { ...worker, state: 'active' as const };
  expect(() => validateTaskSyncObservationBindings(value.sync, new Map([[taskId, { ...without, worker: active }]]), versions)).not.toThrow();
  const noSession = { ...value.sync, taskObservations: { [taskId]: sample({ state: 'no_session', canOpen: false }) } };
  expect(() => validateTaskSyncObservationBindings(noSession, new Map([[taskId, { ...without, worker: active }]]), versions)).toThrow();
});


it.each([
  ['no_session', false, null], ['not_registered', false, null], ['pending', true, null],
  ['working', true, false], ['notice', true, true], ['warning', true, true],
  ['unavailable', false, null],
] as const)('presents the confirmed %s observation without changing its reading admission', async (state, canOpen, needsAttention) => {
  const item = state === 'no_session' ? task({ properties: {} }) : task();
  const { store, read, publish } = await setup(item);
  const observation = sample({ state, canOpen, needsAttention });
  await publish(await read(item, observation, { responseTaskAt: '2026-10-22T10:03:00Z', responseSessionAt: base }));
  expect(store.snapshot().get(taskId)).toEqual({ state, canOpen, needsAttention });
});

it('expires earlier batches independently using the final Engine response clock', async () => {
  const secondId = '10000000-0000-4000-8000-000000000003';
  const items = [task(), detailFixture(projectId, secondId, { status: 'in_progress', startedAt: base, properties: { worker } })];
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const ticket = await scope.beginSync(projectId, new AbortController().signal);
  const sync = { ...taskSyncFromGraph(graphFixture(items), { versionForTask: () => 1n, propertiesForTask: () => ({ worker }),
    taskObservations: { [taskId]: sample(), [secondId]: sample({ observedAt: '2026-10-22T10:00:25Z', freshUntil: '2026-10-22T10:00:55Z' }) } }),
    responseTaskAt: '2026-10-22T10:03:00Z', responseSessionAt: '2026-10-22T10:00:25Z' };
  const project = (await scope.applySync(ticket, sync, new AbortController().signal)).project;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const store = new ProjectTaskObservationsStore(scope, projectId); stores.push(store); store.start();
  store.replace({ project, observedBindings: deriveTaskSyncBindings(ticket, sync), observedVersions: deriveTaskSyncVersions(ticket, sync), sync, receivedMonotonic: performance.now() });
  expect(store.snapshot().get(taskId)?.state).toBe('working');
  expect(store.snapshot().get(secondId)?.state).toBe('working');
  await vi.advanceTimersByTimeAsync(5000);
  expect(store.snapshot().get(taskId)).toEqual({ state: 'expired', needsAttention: null, canOpen: false });
  expect(store.snapshot().get(secondId)?.state).toBe('working');
  await vi.advanceTimersByTimeAsync(25000);
  expect(store.snapshot().get(secondId)?.state).toBe('expired');
});

it('does not publish an already expired observation after body receipt and decoding delay', async () => {
  const { store, read, publish } = await setup();
  const value = await read(task(), sample(), { responseSessionAt: base });
  const received = performance.now();
  await vi.advanceTimersByTimeAsync(30_000);
  await publish(value, received);
  expect(store.snapshot().get(taskId)).toEqual({ state: 'expired', needsAttention: null, canOpen: false });
});

it('rejects freshness consumed by server tail work before body receipt', async () => {
  const { store, read, publish } = await setup();
  await publish(await read(task(), sample(), { responseSessionAt: '2026-10-22T10:00:31Z' }));
  expect(store.snapshot().get(taskId)).toEqual({ state: 'expired', needsAttention: null, canOpen: false });
});

it('does not defer a warning when the Task start is unknown', async () => {
  const unknownStart = task({ startedAt: null });
  const { store, read, publish } = await setup(unknownStart);
  await publish(await read(unknownStart, sample({ state: 'warning', needsAttention: true }), { responseTaskAt: base, responseSessionAt: base }));
  expect(store.snapshot().get(taskId)).toEqual({ state: 'warning', needsAttention: true, canOpen: true });
});

it('withdraws entries on authentication pause and waits for a new observation after recovery', async () => {
  const { scope, store, read, publish } = await setup();
  const value = await read(task(), sample(), { responseSessionAt: base });
  await publish(value);
  const resume = pauseAuthRequests();
  try { expect(store.snapshot().size).toBe(0); }
  finally { resume(); }
  expect(store.snapshot().size).toBe(0);
  const result = await scope.applySync(value.ticket, value.sync, new AbortController().signal);
  store.replace({ project: result.project, observedBindings: deriveTaskSyncBindings(value.ticket, value.sync), observedVersions: deriveTaskSyncVersions(value.ticket, value.sync), sync: value.sync, receivedMonotonic: performance.now() });
  expect(store.snapshot().get(taskId)?.state).toBe('working');
});

it('updates Session-only data without writing IndexedDB or notifying Task consumers', async () => {
  const { scope, store, read, publish } = await setup();
  const first = await read(task(), sample(), { responseSessionAt: base });
  await publish(first);
  const next = await read(task(), sample({ state: 'notice', needsAttention: true }), { responseSessionAt: base });
  const previous = scope.getAuthorizedProject(projectId)!;
  const events = vi.fn(); const unsubscribe = scope.subscribe(events);
  const put = vi.spyOn(IDBObjectStore.prototype, 'put'); put.mockClear();
  await publish(next);
  expect(store.snapshot().get(taskId)?.state).toBe('notice');
  expect(put).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled();
  expect(scope.getAuthorizedProject(projectId)?.graph).toBe(previous.graph);
  expect(scope.getAuthorizedProject(projectId)?.index).toBe(previous.index);
  unsubscribe();
});
