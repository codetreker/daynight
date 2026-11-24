import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getTaskSync } from '../src/api/client';
import type { TaskSync } from '../src/api/types';
import { deriveTaskSyncBindings, deriveTaskSyncVersions } from '../src/features/task-cache/execution-binding';
import { createTaskCacheScope, TaskCacheLifecycleChanged, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { executeTaskSync, taskSyncQuery } from '../src/features/task-cache/task-sync-execution';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { taskSyncFromGraph, taskSyncReadFixture, TEST_VIEWER_ID } from './helpers/taskSync';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), getTaskSync: vi.fn() }));
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const deletedId = '20000000-0000-4000-8000-000000000002';
const time = '2026-10-22T10:00:00Z';
const later = '2026-10-22T10:00:01Z';
const task = detailFixture(projectId, taskId, { updatedAt: time, parentTaskId: null });
const graph = graphFixture([task]);
const response = (query: { readonly epoch?: string; readonly since?: string } = {}, changes: Partial<TaskSync> = {}) => ({
  ...taskSyncFromGraph(graph, { query, versionForTask: () => 1n }), ...changes,
});
const scopes: TaskCacheScope[] = [];
const scope = () => { const cache = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(cache); return cache; };
const signal = () => new AbortController().signal;
const seed = async (cache: TaskCacheScope) => {
  const ticket = await cache.beginSync(projectId, signal());
  await cache.applySync(ticket, response(), signal());
};
beforeEach(() => vi.mocked(getTaskSync).mockReset());
afterEach(() => scopes.splice(0).forEach(cache => cache.dispose()));

it('uses the persisted coverage even when the remaining live tasks are older', async () => {
  const cache = scope(); await seed(cache);
  let ticket = await cache.beginSync(projectId, signal());
  await cache.applySync(ticket, response({ epoch: ticket.epoch! }, { tasks: [], dependencyStates: {}, coverageUpdatedAt: later, deletedTaskIds: [deletedId] }), signal());
  ticket = await cache.beginSync(projectId, signal());
  expect(taskSyncQuery(ticket)).toEqual({ epoch: ticket.epoch, since: later });
  vi.mocked(getTaskSync).mockImplementationOnce(async (_project, query) => taskSyncReadFixture(response(query, { tasks: [], dependencyStates: {}, coverageUpdatedAt: later })));
  const result = await executeTaskSync({ scope: cache, projectId, signal: signal(), trigger: 'automatic' });
  expect(result.history).toBe('current');
  expect(vi.mocked(getTaskSync).mock.calls[0]![1]).toEqual({ epoch: ticket.epoch, since: later });
});

it('keeps parent metadata recovery as an unbounded delta merge', async () => {
  const cache = scope();
  const initial = await cache.beginSync(projectId, signal());
  await cache.applySync(initial, response(), signal(), false);
  const ticket = await cache.beginSync(projectId, signal());
  expect(ticket.parentTaskFullSync).toBe(true);
  const apply = vi.spyOn(cache, 'applySync');
  vi.mocked(getTaskSync).mockImplementationOnce(async (_project, query) => taskSyncReadFixture(response(query)));
  const result = await executeTaskSync({ scope: cache, projectId, signal: signal(), ticket });
  expect(vi.mocked(getTaskSync).mock.calls[0]![1]).toEqual({ epoch: ticket.epoch });
  expect(apply.mock.calls[0]![3]).toBe(true);
  expect(result.history === 'current' && result.project.summaries.has(taskId)).toBe(true);
  expect((await cache.beginSync(projectId, signal())).parentTaskFullSync).toBe(false);
});

it('removes deleted IDs from inherited execution and version observations', async () => {
  const cache = scope(); await seed(cache);
  const ticket = await cache.beginSync(projectId, signal());
  const deletion = response({ epoch: ticket.epoch! }, { tasks: [], dependencyStates: {}, deletedTaskIds: [taskId] });
  expect(deriveTaskSyncBindings(ticket, deletion).has(taskId)).toBe(false);
  expect(deriveTaskSyncVersions(ticket, deletion).has(taskId)).toBe(false);
});

it.each(['retired', 'confirm'] as const)('returns %s without applying or issuing a second HTTP read', async history => {
  const cache = scope(); await seed(cache);
  const observe = vi.spyOn(cache, 'observeHistory').mockResolvedValueOnce(history);
  const apply = vi.spyOn(cache, 'applySync');
  const observing = vi.fn();
  vi.mocked(getTaskSync).mockImplementationOnce(async (_project, query) => taskSyncReadFixture(response(query)));
  expect(await executeTaskSync({ scope: cache, projectId, signal: signal(), observingHistory: observing })).toEqual({ history });
  expect(observe).toHaveBeenCalledOnce(); expect(apply).not.toHaveBeenCalled(); expect(getTaskSync).toHaveBeenCalledOnce();
  expect(observing.mock.calls).toEqual([[true], [false]]);
});

it('rejects a result superseded by a deletion committed after its application', async () => {
  const cache = scope(); await seed(cache);
  const apply = cache.applySync.bind(cache);
  vi.spyOn(cache, 'applySync').mockImplementationOnce(async (...args) => {
    const applied = await apply(...args);
    const ticket = await cache.beginSync(projectId, signal());
    await apply(ticket, response({ epoch: ticket.epoch! }, { tasks: [], dependencyStates: {}, deletedTaskIds: [taskId], coverageUpdatedAt: later }), signal());
    return applied;
  });
  vi.mocked(getTaskSync).mockImplementationOnce(async (_project, query) => taskSyncReadFixture(response(query)));
  await expect(executeTaskSync({ scope: cache, projectId, signal: signal() })).rejects.toBeInstanceOf(TaskCacheLifecycleChanged);
  expect(cache.getAuthorizedProject(projectId)?.summaries.has(taskId)).toBe(false);
});

it('preserves the baseline and original error when the HTTP read fails', async () => {
  const cache = scope(); await seed(cache);
  const before = await cache.beginSync(projectId, signal());
  const failure = new Error('offline'); vi.mocked(getTaskSync).mockRejectedValueOnce(failure);
  await expect(executeTaskSync({ scope: cache, projectId, signal: signal() })).rejects.toBe(failure);
  const after = await cache.beginSync(projectId, signal());
  expect(after.syncRevision).toBe(before.syncRevision); expect(after.coverageUpdatedAt).toBe(before.coverageUpdatedAt);
});

it('does not apply a response from a cancelled read', async () => {
  const cache = scope(); await seed(cache);
  const controller = new AbortController(); const apply = vi.spyOn(cache, 'applySync');
  vi.mocked(getTaskSync).mockImplementationOnce(async (_project, query) => { controller.abort(); return taskSyncReadFixture(response(query)); });
  await expect(executeTaskSync({ scope: cache, projectId, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(apply).not.toHaveBeenCalled();
});

it('allows same-history resource observation after a commit while fencing obsolete sync and history replacement', async () => {
  const cache = scope(); await seed(cache);
  const stale = await cache.beginSync(projectId, signal());
  const current = await cache.beginSync(projectId, signal());
  const newerTask = { ...response({ epoch: current.epoch! }).tasks[0]!, version: 2n, updatedAt: later };
  await cache.applySync(current, response({ epoch: current.epoch! }, { tasks: [newerTask],
    dependencyStates: { [taskId]: { taskVersion: 2n, blockedBy: [], ready: true } }, coverageUpdatedAt: later }), signal());
  expect(await cache.observeHistory(stale, stale.epoch!, signal())).toBe('current');
  vi.mocked(getTaskSync).mockResolvedValueOnce(taskSyncReadFixture(response({ epoch: stale.epoch! })));
  await expect(executeTaskSync({ scope: cache, projectId, signal: signal(), ticket: stale })).rejects.toBeInstanceOf(TaskCacheLifecycleChanged);
  await expect(cache.applySync(stale, response({ epoch: stale.epoch! }), signal())).rejects.toBeInstanceOf(TaskCacheLifecycleChanged);
  await expect(cache.observeHistory(stale, crypto.randomUUID(), signal())).rejects.toBeInstanceOf(TaskCacheLifecycleChanged);
  expect(cache.getAuthorizedProject(projectId)?.summaries.get(taskId)?.version).toBe(2n);
  expect(cache.getHistoryGeneration(projectId)).toBe(0);
});
