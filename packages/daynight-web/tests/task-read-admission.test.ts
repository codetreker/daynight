import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getTaskSync, pauseAuthRequests } from '../src/api/client';
import type { TaskSync } from '../src/api/types';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { readCachedDetail, saveDetail } from '../src/features/task-detail/detail-cache';
import { taskResourceKey } from '../src/features/task-cache/read-admission';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { taskSyncFromGraph, taskSyncReadFixture, TEST_VIEWER_ID } from './helpers/taskSync';

vi.mock('../src/api/client', async original => ({ ...await original<typeof import('../src/api/client')>(), getTaskSync: vi.fn() }));
const projectId = '10000000-0000-4000-8000-000000000001';
const rootId = '20000000-0000-4000-8000-000000000001';
const childId = '20000000-0000-4000-8000-000000000002';
const siblingId = '20000000-0000-4000-8000-000000000003';
const epoch = '30000000-0000-4000-8000-000000000001';
const replacement = '30000000-0000-4000-8000-000000000002';
const root = detailFixture(projectId, rootId, { parentTaskId: null });
const child = detailFixture(projectId, childId, { parentTaskId: rootId });
const sibling = detailFixture(projectId, siblingId, { parentTaskId: null });
const response = (tasks = [root, child, sibling], query: { epoch?: string; since?: string } = {}, changes: Partial<TaskSync> = {}): TaskSync => ({
  ...taskSyncFromGraph({ ...graphFixture(tasks.length === 0 ? [root] : tasks), tasks: tasks.length === 0 ? [] : graphFixture(tasks).tasks.map(task => ({ ...task, parentTaskId: tasks.find(item => item.id === task.id)!.parentTaskId! })) }, { query, epoch, coverageUpdatedAt: root.updatedAt, versionForTask: () => 1n, propertiesForTask: task => tasks.find(item => item.id === task.id)!.properties }), ...changes,
});
const scopes: TaskCacheScope[] = [];
const scope = () => { const cache = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(cache); return cache; };
const signal = () => new AbortController().signal;
const seed = async (cache: TaskCacheScope) => cache.applySync(await cache.beginSync(projectId, signal()), response(), signal());
const remove = async (cache: TaskCacheScope, ids = [rootId, childId]) => {
  const ticket = await cache.beginSync(projectId, signal());
  await cache.applySync(ticket, response([], { epoch }, { deletedTaskIds: ids, dependencyStates: {} }), signal());
};
beforeEach(() => { vi.mocked(getTaskSync).mockReset(); });
afterEach(() => scopes.splice(0).forEach(cache => cache.dispose()));

it('denies direct and candidate results from shared committed removals without a received hint', async () => {
  const writer = scope(); await seed(writer);
  const reader = scope();
  const fence = await reader.beginTaskRead(projectId, childId, 1, 1, signal());
  const snapshot = await reader.prepareProjection(signal());
  await remove(writer);
  expect(await reader.verifyTaskRead(fence, signal())).toBe(false);
  const allowed = await reader.qualifyProjection(snapshot, [{ projectId, id: childId }, { projectId, id: siblingId }], signal());
  expect([...allowed]).toEqual([taskResourceKey(projectId, siblingId)]);
});

it('keeps the complete graph until authoritative deletion while fencing descendants and preserving unrelated reads', async () => {
  const cache = scope(); await seed(cache);
  const rootFence = await cache.beginTaskRead(projectId, rootId, 1, 1, signal());
  const childFence = await cache.beginTaskRead(projectId, childId, 1, 1, signal());
  const siblingFence = await cache.beginTaskRead(projectId, siblingId, 1, 1, signal());
  let finish!: (value: ReturnType<typeof taskSyncReadFixture>) => void;
  vi.mocked(getTaskSync).mockImplementation((_project, _query, _user, signal) => new Promise((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  expect(cache.reportTaskDeleted(rootFence, epoch)).toBe(true);
  expect(cache.getAuthorizedProject(projectId)?.summaries.size).toBe(3);
  expect(cache.isTaskReadCurrent(rootFence)).toBe(false);
  expect(cache.isTaskReadCurrent(childFence)).toBe(false);
  expect(await cache.verifyTaskRead(siblingFence, signal())).toBe(true);
  await vi.waitFor(() => expect(getTaskSync).toHaveBeenCalledOnce());
  finish(taskSyncReadFixture(response([], { epoch }, { deletedTaskIds: [rootId, childId], dependencyStates: {} })));
  await vi.waitFor(() => expect(cache.getAuthorizedProject(projectId)?.summaries.size).toBe(1));
});

it('starts another sync after a hint arriving during the current recheck', async () => {
  const cache = scope(); await seed(cache);
  const first = await cache.beginTaskRead(projectId, rootId, 1, 1, signal());
  const second = await cache.beginTaskRead(projectId, siblingId, 1, 1, signal());
  let finish!: (value: ReturnType<typeof taskSyncReadFixture>) => void;
  vi.mocked(getTaskSync).mockImplementationOnce((_project, _query, _user, signal) => new Promise((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }))
    .mockResolvedValueOnce(taskSyncReadFixture(response([], { epoch }, { deletedTaskIds: [rootId, childId, siblingId], dependencyStates: {} })));
  cache.reportTaskDeleted(first, epoch);
  await vi.waitFor(() => expect(getTaskSync).toHaveBeenCalledOnce());
  expect(cache.reportTaskDeleted(second, epoch)).toBe(true);
  finish(taskSyncReadFixture(response([], { epoch }, { deletedTaskIds: [rootId, childId], dependencyStates: {} })));
  await vi.waitFor(() => expect(getTaskSync).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(cache.getAuthorizedProject(projectId)?.summaries.size).toBe(0));
});

it('rejects late negative results after a confirmed replacement history', async () => {
  const cache = scope(); await seed(cache);
  const old = await cache.beginTaskRead(projectId, rootId, 1, 1, signal());
  let ticket = await cache.beginSync(projectId, signal());
  await cache.observeHistory(ticket, replacement, signal());
  ticket = await cache.beginSync(projectId, signal());
  await cache.observeHistory(ticket, replacement, signal());
  ticket = await cache.beginSync(projectId, signal());
  await cache.applySync(ticket, response([root], {}, { epoch: replacement }), signal());
  expect(cache.reportTaskDeleted(old, epoch)).toBe(false);
  expect(cache.getAuthorizedProject(projectId)?.summaries.has(rootId)).toBe(true);
});

it('requires a fresh projection for an unknown resource crossing a same-epoch rebuild without inventing a removal', async () => {
  const cache = scope(); await seed(cache);
  const unknownId = '20000000-0000-4000-8000-000000000004';
  const old = await cache.prepareProjection(signal());
  await cache.applySync(await cache.beginSync(projectId, signal()), response(), signal(), true, { rebuild: true });
  expect((await cache.qualifyProjection(old, [{ projectId, id: unknownId }], signal())).size).toBe(0);
  expect((await cache.taskReadQualification(projectId, unknownId, signal())).removed).toBe(false);
  const fresh = await cache.prepareProjection(signal());
  expect((await cache.qualifyProjection(fresh, [{ projectId, id: unknownId }], signal())).size).toBe(1);
});

it('rejects old reads of changed tasks across a rebuild while retaining unchanged readers', async () => {
  const cache = scope(); await seed(cache);
  const changed = await cache.beginTaskRead(projectId, rootId, 1, 1, signal());
  const unchanged = await cache.beginTaskRead(projectId, siblingId, 1, 1, signal());
  const projection = await cache.prepareProjection(signal());
  const snapshot = response();
  const tasks = snapshot.tasks.map(task => task.id === rootId ? { ...task, version: 2n } : task);
  await cache.applySync(await cache.beginSync(projectId, signal()), { ...snapshot, tasks,
    dependencyStates: { ...snapshot.dependencyStates, [rootId]: { ...snapshot.dependencyStates[rootId]!, taskVersion: 2n } } }, signal(), true, { rebuild: true });
  expect(await cache.verifyTaskRead(changed, signal())).toBe(false);
  expect(await cache.verifyTaskRead(unchanged, signal())).toBe(true);
  expect((await cache.qualifyProjection(projection, [{ projectId, id: rootId }], signal())).size).toBe(0);
});

it('rechecks a direct read begun while its baseline was unreadable after a rebuild', async () => {
  const cache = scope(); await seed(cache);
  const unknownId = '20000000-0000-4000-8000-000000000004';
  const get = IDBObjectStore.prototype.get;
  const failure = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'projects') throw new Error('Temporary storage failure');
    return get.apply(this, args);
  });
  const fence = await cache.beginTaskRead(projectId, unknownId, 1, 1, signal());
  failure.mockRestore();
  await cache.applySync(await cache.beginSync(projectId, signal()), response(), signal(), true, { rebuild: true });
  expect(await cache.verifyTaskRead(fence, signal())).toBe(false);
  expect((await cache.taskReadQualification(projectId, unknownId, signal())).removed).toBe(false);
});

it('retains a direct reader across same-history session cache generation rotation', async () => {
  const cache = scope(); await seed(cache);
  const fence = await cache.beginTaskRead(projectId, rootId, 1, 1, signal());
  const ticket = await cache.beginSync(projectId, signal());
  expect(await cache.rotateSessionHistoryGeneration(ticket, 0, signal())).toBe(true);
  expect(await cache.verifyTaskRead(fence, signal())).toBe(true);
});

it('rejects old history reads from shared storage before a peer hint arrives', async () => {
  const writer = scope(); await seed(writer);
  const reader = scope();
  const fence = await reader.beginTaskRead(projectId, rootId, 1, 1, signal());
  const projection = await reader.prepareProjection(signal());
  const ticket = await writer.beginSync(projectId, signal());
  await writer.applySync(ticket, response([root], {}, { epoch: replacement }), signal());
  expect(await reader.verifyTaskRead(fence, signal())).toBe(false);
  expect((await reader.qualifyProjection(projection, [{ projectId, id: rootId }], signal())).size).toBe(0);
});

it('rejects an old direct response observed without a manifest after a peer installs a new history', async () => {
  const reader = scope();
  const fence = await reader.beginTaskRead(projectId, rootId, 1, 1, signal());
  const projection = await reader.prepareProjection(signal());
  const writer = scope(); const ticket = await writer.beginSync(projectId, signal());
  await writer.applySync(ticket, response([root], {}, { epoch: replacement }), signal());
  expect(await reader.observeHistory(fence, epoch, signal())).toBe('current');
  expect(await reader.verifyTaskRead(fence, signal())).toBe(false);
  expect((await reader.qualifyProjection(projection, [{ projectId, id: rootId }], signal())).size).toBe(0);
});

it('rejects a page begun against a placeholder before another history is installed', async () => {
  const writer = scope(); const ticket = await writer.beginSync(projectId, signal());
  const reader = scope(); const projection = await reader.prepareProjection(signal());
  await writer.applySync(ticket, response([root], {}, { epoch: replacement }), signal());
  expect((await reader.qualifyProjection(projection, [{ projectId, id: rootId }], signal())).size).toBe(0);
});

it('does not treat retained detail rows as corrupt while a precise deletion is awaiting sync', async () => {
  const cache = scope(); await seed(cache);
  const ticket = await cache.beginSync(projectId, signal());
  await saveDetail(cache, ticket, root, signal()); await saveDetail(cache, ticket, sibling, signal());
  const fence = await cache.beginTaskRead(projectId, rootId, 1, 1, signal());
  vi.mocked(getTaskSync).mockImplementation((_project, _query, _user, lifetime) => new Promise((_resolve, reject) => lifetime.addEventListener('abort', () => reject(lifetime.reason), { once: true })));
  cache.reportTaskDeleted(fence, epoch);
  expect(await readCachedDetail(cache, ticket, rootId, signal())).toBeNull();
  expect((await readCachedDetail(cache, ticket, siblingId, signal()))?.id).toBe(siblingId);
  expect((await saveDetail(cache, ticket, sibling, signal())).kind).toBe('matching');
});

it('delivers safe negative hints during same-account verification and waits before synchronization', async () => {
  const cache = scope(); await seed(cache);
  const fence = await cache.beginTaskRead(projectId, rootId, 1, 1, signal());
  const listener = vi.fn(); const unsubscribe = cache.subscribe(listener);
  const resume = pauseAuthRequests();
  vi.mocked(getTaskSync).mockResolvedValue(taskSyncReadFixture(response([], { epoch }, { deletedTaskIds: [rootId, childId], dependencyStates: {} })));
  try {
    expect(cache.reportTaskDeleted(fence, epoch)).toBe(true);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ taskDeletionHint: { taskId: rootId, pendingTaskIds: [childId] } }));
    expect(getTaskSync).not.toHaveBeenCalled();
  } finally { resume(); unsubscribe(); }
  await vi.waitFor(() => expect(cache.getAuthorizedProject(projectId)?.summaries.size).toBe(1));
});
