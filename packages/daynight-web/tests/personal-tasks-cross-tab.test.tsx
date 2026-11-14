import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { unsupportedSessionObservation } from '../../daynight/src/api/task-observation';
import * as api from '../src/api/personal-tasks';
import { useMyTasks } from '../src/features/my-tasks/useMyTasks';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { WORKER_TIME, WORKER_USER, workerId } from './helpers/workers';

class Channel {
  static channels = new Set<Channel>();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(readonly name: string) { Channel.channels.add(this); }
  postMessage(data: unknown) { for (const peer of Channel.channels) if (peer !== this && peer.name === this.name) queueMicrotask(() => peer.onmessage?.({ data } as MessageEvent<unknown>)); }
  close() { Channel.channels.delete(this); }
}
const row = (task: number, project: number): api.PersonalTaskPage['items'][number] => ({
  project: { id: workerId(project), name: `Project ${project}`, ownerTeam: { id: workerId(9), kind: 'personal', name: null }, executionWarningMinutes: 120, matchedTaskCount: 1 },
  task: { id: workerId(task), version: '1', title: `Task ${task}`, status: 'in_progress', startedAt: null, allowAgents: true, paused: false, worker: null, goal: null },
  session: unsupportedSessionObservation(),
});
const page = (items: api.PersonalTaskPage['items']): api.PersonalTaskPage => ({ observedAt: WORKER_TIME, inventoryRevision: 'a'.repeat(64), totalTaskCount: items.length, totalProjectCount: items.length, sessionPartial: true, items, nextCursor: null });
afterEach(() => { Channel.channels.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('withdraws a project in another cache scope and ignores its late in-flight page', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const owner = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: vi.fn() });
  const peer = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: vi.fn() });
  const signal = new AbortController().signal;
  const ticket = await owner.beginSync(workerId(3), signal);
  const old = Promise.withResolvers<api.PersonalTaskPage>(), fresh = Promise.withResolvers<api.PersonalTaskPage>();
  const load = vi.spyOn(api, 'listPersonalTasks').mockResolvedValueOnce(page([row(10, 3), row(11, 4)]))
    .mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
  const wrapper = ({ children }: { readonly children: ReactNode }) => <TaskCacheProvider scope={peer}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useMyTasks(true), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.loaded).toBe(true), { timeout: 10000 });
    act(() => view.result.current.refresh());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2), { timeout: 10000 });
    await act(async () => { await owner.revokeProject(ticket, signal); });
    await waitFor(() => expect(view.result.current.items.map(item => item.task.id)).toEqual([workerId(11)]), { timeout: 10000 });
    expect(view.result.current.totalTaskCount).toBeNull();
    await act(async () => old.resolve(page([row(10, 3), row(11, 4)])));
    expect(view.result.current.items.map(item => item.task.id)).toEqual([workerId(11)]);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3), { timeout: 10000 });
    await act(async () => fresh.resolve(page([row(11, 4)])));
    await waitFor(() => expect(view.result.current.totalTaskCount).toBe(1), { timeout: 10000 });
    expect(view.result.current.items.map(item => item.task.id)).toEqual([workerId(11)]);
  } finally { view.unmount(); owner.dispose(); peer.dispose(); }
}, 20000);
