import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteTask, getTask, setTaskAgentPermission, setTaskRequiredPlatform, setTaskStatus } from '../src/api/client';
import type { TaskDetail } from '../src/api/types';
import { canDeleteTask, TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { admitTaskGraph, createTaskSessionWorld } from './helpers/taskSessions';
import { detailFixture, graphFixture } from './helpers/taskDetail';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), deleteTask: vi.fn(), getTask: vi.fn(), setTaskStatus: vi.fn(), setTaskAgentPermission: vi.fn(), setTaskRequiredPlatform: vi.fn() }));
const project = '10000000-0000-4000-8000-000000000001'; const task = '20000000-0000-4000-8000-000000000001'; const sibling = '20000000-0000-4000-8000-000000000002';
const initial = detailFixture(project, task, { title: 'Old reviewed task', version: 9n });
const replacement = { ...initial, title: 'Different restored task at the same version' };
const reads = vi.mocked(getTask); const deletes = vi.mocked(deleteTask);
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const worlds = new Map<TaskDetailSessions, ReturnType<typeof createTaskSessionWorld>>(); const releases = new Set<() => void>();
const createSessions = () => { const world = createTaskSessionWorld(); const sessions = new TaskDetailSessions(world.scope); worlds.set(sessions, world); return sessions; };
const open = async (sessions: TaskDetailSessions) => {
  const world = worlds.get(sessions)!; await world.sync([initial]); sessions.observe(project, task, world.node(project, task)); sessions.load(project, task, 1);
  await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(initial));
};
const replace = async (sessions: TaskDetailSessions, details: readonly TaskDetail[]) => {
  const world = worlds.get(sessions)!; const byId = new Map(details.map((detail) => [detail.id, detail]));
  await admitTaskGraph(world.scope, graphFixture(details), { epoch: crypto.randomUUID(), versionForTask: (node) => byId.get(node.id)!.version });
};
const pausePreparation = (sessions: TaskDetailSessions, point: 'beginSync' | 'detailTransaction') => {
  const world = worlds.get(sessions)!; const entered = deferred<void>(); const release = deferred<void>(); let calls = 0;
  releases.add(release.resolve);
  if (point === 'beginSync') {
    const ready = world.scope.ready.bind(world.scope);
    vi.spyOn(world.scope, 'ready').mockImplementation(async (signal) => {
      if (++calls === 1) { entered.resolve(); await release.promise; }
      await ready(signal);
    });
  } else {
    const transact = world.scope.detailTransaction.bind(world.scope);
    const paused: typeof world.scope.detailTransaction = async <T,>(...args: Parameters<typeof transact<T>>): Promise<T> => {
      const result = await transact<T>(...args);
      if (++calls === 1) { entered.resolve(); await release.promise; }
      return result;
    };
    vi.spyOn(world.scope, 'detailTransaction').mockImplementation(paused);
  }
  return { entered: entered.promise, release: release.resolve };
};
const assertNoWrites = () => { expect(deletes).not.toHaveBeenCalled(); expect(setTaskStatus).not.toHaveBeenCalled(); expect(setTaskAgentPermission).not.toHaveBeenCalled(); expect(setTaskRequiredPlatform).not.toHaveBeenCalled(); };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => { for (const [sessions, world] of worlds) { sessions.dispose(); world.dispose(); } for (const release of releases) release(); releases.clear(); worlds.clear(); });
beforeEach(() => { reads.mockReset().mockResolvedValue(initial); deletes.mockReset(); vi.mocked(setTaskStatus).mockReset(); vi.mocked(setTaskAgentPermission).mockReset(); vi.mocked(setTaskRequiredPlatform).mockReset(); });

describe('reviewed task mutation preparation', () => {
  it.each((['beginSync', 'detailTransaction'] as const).flatMap((point) => [false, true].map((observe) => ({ point, observe }))))('expires a reviewed DELETE paused at $point when replacement history arrives with observe=$observe', async ({ point, observe }) => {
    const sessions = createSessions(); await open(sessions); const world = worlds.get(sessions)!; const gate = pausePreparation(sessions, point);
    sessions.deleteTask(project, task, initial.version); await gate.entered; assertNoWrites();
    await replace(sessions, [replacement]); if (observe) sessions.observe(project, task, world.node(project, task), true);
    reads.mockResolvedValue(replacement); gate.release();
    await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(replacement));
    expect(sessions.snapshot(project, task).status).toBe('ready'); expect(canDeleteTask(sessions.snapshot(project, task))).toBe(true); assertNoWrites(); expect(reads).toHaveBeenCalledTimes(2);
    const pending = deferred<void>(); deletes.mockReturnValueOnce(pending.promise); sessions.deleteTask(project, task, replacement.version);
    await waitFor(() => expect(deletes).toHaveBeenCalledExactlyOnceWith(project, task, replacement.version, expect.any(AbortSignal), expect.anything()));
  });
  it.each((['status', 'allowAgents', 'requiredPlatform'] as const).flatMap((action) => (['beginSync', 'detailTransaction'] as const).map((point) => ({ action, point }))))('expires $action preparation paused at $point before it can mutate a different history', async ({ action, point }) => {
    const sessions = createSessions(); await open(sessions); const gate = pausePreparation(sessions, point);
    if (action === 'status') sessions.setStatus(project, task, 'done', initial.version);
    else if (action === 'allowAgents') sessions.setAgentPermission(project, task, true, initial.version);
    else sessions.setRequiredPlatform(project, task, 'linux', initial.version);
    await gate.entered; assertNoWrites(); await replace(sessions, [replacement]); const world = worlds.get(sessions)!; sessions.observe(project, task, world.node(project, task), true);
    reads.mockResolvedValue(replacement); gate.release(); await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(replacement));
    assertNoWrites(); expect(reads).toHaveBeenCalledTimes(2); expect(sessions.snapshot(project, task).mutation.phase).not.toBe('pending'); expect(canDeleteTask(sessions.snapshot(project, task))).toBe(true);
  });
  it.each(['beginSync', 'detailTransaction'] as const)('does not dispatch or unlock an obsolete owner paused at %s after a new deletion owns restored history', async (point) => {
    const sessions = createSessions(); await open(sessions); const world = worlds.get(sessions)!; const gate = pausePreparation(sessions, point);
    sessions.deleteTask(project, task, initial.version); await gate.entered;
    await replace(sessions, [detailFixture(project, sibling)]); sessions.observe(project, task, undefined, true); expect(sessions.snapshot(project, task).status).toBe('deleted');
    const restored = { ...replacement, version: 3n }; await replace(sessions, [restored]); sessions.observe(project, task, world.node(project, task), true); reads.mockResolvedValue(restored); sessions.requireOpeningRead(project, task); sessions.load(project, task, 3, 'open');
    await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(restored)); const pending = deferred<void>(); deletes.mockReturnValueOnce(pending.promise); sessions.deleteTask(project, task, restored.version);
    await waitFor(() => expect(deletes).toHaveBeenCalledExactlyOnceWith(project, task, 3n, expect.any(AbortSignal), expect.anything()));
    gate.release(); await flush(); expect(deletes).toHaveBeenCalledOnce(); expect(sessions.snapshot(project, task).mutation).toMatchObject({ operation: { action: 'delete', version: 3n }, phase: 'pending' });
    pending.resolve(); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('deleted')); expect(reads).toHaveBeenCalledTimes(2);
  });
  it.each(['beginSync', 'detailTransaction'] as const)('retains one same-history deletion intent through view closure while %s is pending', async (point) => {
    const sessions = createSessions(); const close = sessions.subscribe(project, task, vi.fn()); await open(sessions); const gate = pausePreparation(sessions, point); const pending = deferred<void>(); deletes.mockReturnValueOnce(pending.promise);
    sessions.deleteTask(project, task, initial.version); await gate.entered; close(); sessions.releaseRead(project, task); sessions.deleteTask(project, task, initial.version); assertNoWrites();
    gate.release(); await waitFor(() => expect(deletes).toHaveBeenCalledExactlyOnceWith(project, task, initial.version, expect.any(AbortSignal), expect.anything()));
    expect(deletes.mock.calls[0]![3].aborted).toBe(false); pending.resolve(); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('deleted')); expect(reads).toHaveBeenCalledOnce();
  });
  it.each(['beginSync', 'detailTransaction'] as const)('retains its confirmed intent when the same task closes and reopens during %s preparation', async (point) => {
    const sessions = createSessions(); const close = sessions.subscribe(project, task, vi.fn()); await open(sessions); const world = worlds.get(sessions)!;
    const gate = pausePreparation(sessions, point); const pending = deferred<void>(); deletes.mockReturnValueOnce(pending.promise); sessions.deleteTask(project, task, initial.version); await gate.entered;
    close(); sessions.releaseRead(project, task); const closeReopened = sessions.subscribe(project, task, vi.fn()); sessions.requireOpeningRead(project, task); sessions.observe(project, task, world.node(project, task), true); sessions.load(project, task, 2, 'open');
    expect(sessions.snapshot(project, task).requiresFreshRead).toBe(true); expect(reads).toHaveBeenCalledOnce(); assertNoWrites();
    gate.release(); await waitFor(() => expect(deletes).toHaveBeenCalledExactlyOnceWith(project, task, initial.version, expect.any(AbortSignal), expect.anything()));
    pending.resolve(); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('deleted')); expect(reads).toHaveBeenCalledOnce(); closeReopened();
  });
  it.each(['beginSync', 'detailTransaction'] as const)('does not dispatch after project access is revoked during %s preparation', async (point) => {
    const sessions = createSessions(); await open(sessions); const world = worlds.get(sessions)!; const ticket = await world.scope.beginSync(project, world.scope.signal);
    const gate = pausePreparation(sessions, point); sessions.deleteTask(project, task, initial.version); await gate.entered;
    await expect(world.scope.revokeProject(ticket, world.scope.signal, false)).resolves.toBe(true); expect(world.scope.getAuthorizedProject(project)).toBeNull();
    gate.release(); await flush(); assertNoWrites(); expect(reads).toHaveBeenCalledOnce();
  });
  it.each(['beginSync', 'detailTransaction'] as const)('does not dispatch after identity retirement during %s preparation', async (point) => {
    const sessions = createSessions(); await open(sessions); const gate = pausePreparation(sessions, point); sessions.deleteTask(project, task, initial.version); await gate.entered;
    const world = worlds.get(sessions)!; void world.scope.invalidateScope(); gate.release(); await flush();
    expect(world.scope.isInvalidated).toBe(true); assertNoWrites(); expect(reads).toHaveBeenCalledOnce();
  });
});
