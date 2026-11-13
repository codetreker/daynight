import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, getTask, updateTaskFields } from '../src/api/client';
import type { TaskDetail } from '../src/api/types';
import { canSetTags, TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { waitForState as waitFor } from './helpers/waitForState';

vi.mock('../src/api/client', async (original) => {
  const actual = await original<typeof import('../src/api/client')>();
  const { fixtureTaskEpoch } = await import('./helpers/taskSync');
  const read = vi.fn();
  return { ...actual, getTask: read, getTaskObservation: async (...args: Parameters<typeof actual.getTask>) => ({ detail: await read(...(args[4] === undefined ? args.slice(0, 4) : args)), epoch: fixtureTaskEpoch(args[0]) }), updateTaskFields: vi.fn() };
});
const project = '10000000-0000-4000-8000-000000000001';
const id = '20000000-0000-4000-8000-000000000001';
const one = '30000000-0000-4000-8000-000000000001';
const two = '30000000-0000-4000-8000-000000000002';
const initial: TaskDetail = { tags: [{ id: one, name: 'One' }], type: 'task', parentId: null, assignedTo: null, id, projectId: project, title: 'Task', description: 'kept', status: 'todo', version: 9007199254740993n,
  allowAgents: false, requiredPlatform: null, ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], properties: { pullRequests: [] }, startedAt: null, completedAt: null, cancelledAt: null,
  createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' };
const saved: TaskDetail = { ...initial, tags: [{ id: two, name: 'Two' }], version: initial.version + 1n };
const reads = vi.mocked(getTask), writes = vi.mocked(updateTaskFields);
const worlds = new Map<TaskDetailSessions, ReturnType<typeof createTaskSessionWorld>>();
const create = () => { const world = createTaskSessionWorld(); const sessions = new TaskDetailSessions(world.scope); worlds.set(sessions, world); return sessions; };
const sync = async (sessions: TaskDetailSessions, detail: TaskDetail) => { const world = worlds.get(sessions)!; await world.sync([detail]); sessions.observe(project, id, world.node(project, id)); };
const open = async (sessions: TaskDetailSessions, detail = initial) => { await sync(sessions, detail); sessions.load(project, id, 1); await waitFor(() => expect(sessions.snapshot(project, id).status).toBe('ready')); };
afterEach(() => { for (const [sessions, world] of worlds) { sessions.dispose(); world.dispose(); } worlds.clear(); });
beforeEach(() => { reads.mockReset().mockResolvedValue(initial); writes.mockReset(); });

it('sends one canonical set at the captured version and serializes duplicate submissions', async () => {
  const sessions = create(); await open(sessions);
  let finish!: (detail: TaskDetail) => void; writes.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  sessions.setTags(project, id, [two, two], initial.version); sessions.setTags(project, id, [], initial.version);
  await waitFor(() => expect(writes).toHaveBeenCalledOnce());
  expect(writes).toHaveBeenCalledExactlyOnceWith(project, id, { tagIds: [two] }, initial.version, expect.any(AbortSignal), expect.objectContaining({ userId: worlds.get(sessions)!.scope.userId }));
  await sync(sessions, saved); finish(saved);
  await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('confirmed'));
  expect(sessions.snapshot(project, id).detail).toEqual(saved);
});

it('does not send a stale draft and accepts an unchanged set without advancing the version', async () => {
  const sessions = create(); await open(sessions);
  sessions.setTags(project, id, [two], initial.version - 1n);
  expect(writes).not.toHaveBeenCalled();
  writes.mockResolvedValueOnce(initial); sessions.setTags(project, id, [one], initial.version);
  await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('confirmed'));
  expect(writes).toHaveBeenCalledOnce(); expect(sessions.snapshot(project, id).detail).toEqual(initial);
});

it('does not publish an old task write into another open task', async () => {
  const sessions = create(); const close = sessions.subscribe(project, id, vi.fn()); await open(sessions);
  let finish!: (detail: TaskDetail) => void; writes.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  sessions.setTags(project, id, [two], initial.version); await waitFor(() => expect(writes).toHaveBeenCalledOnce());
  close();
  const other = { ...initial, id: '20000000-0000-4000-8000-000000000002', title: 'Other' };
  const world = worlds.get(sessions)!; await world.sync([other]); sessions.observe(project, other.id, world.node(project, other.id));
  reads.mockResolvedValueOnce(other); const closeOther = sessions.subscribe(project, other.id, vi.fn()); sessions.load(project, other.id, 1);
  await waitFor(() => expect(sessions.snapshot(project, other.id).detail).toEqual(other));
  await sync(sessions, saved); finish(saved);
  await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('confirmed'));
  expect(sessions.snapshot(project, other.id).detail).toEqual(other); closeOther();
});

it.each(['in_progress', 'cancelled'] as const)('allows tags in %s, including Goals', async status => {
  const detail: TaskDetail = { ...initial, type: 'goal', status, ready: false, startedAt: '2026-10-24T00:01:00Z', cancelledAt: status === 'cancelled' ? '2026-10-24T00:02:00Z' : null };
  reads.mockResolvedValueOnce(detail); const sessions = create(); sessions.subscribe(project, id, () => {}); sessions.openDirect(project, id);
  await waitFor(() => expect(sessions.snapshot(project, id).status).toBe('ready'));
  expect(canSetTags(sessions.snapshot(project, id))).toBe(true);
  writes.mockResolvedValueOnce({ ...detail, tags: [], version: detail.version + 1n });
  sessions.setTags(project, id, [], detail.version);
  await waitFor(() => expect(writes).toHaveBeenCalledOnce());
  expect(writes.mock.calls[0]![2]).toEqual({ tagIds: [] });
});

it.each([new ApiError('network'), new ApiError('server', 409, 'version_conflict')])('reads current state after an uncertain or conflicting write without replay %#', async failure => {
  reads.mockResolvedValueOnce(initial).mockResolvedValueOnce(saved); const sessions = create(); await open(sessions);
  writes.mockRejectedValueOnce(failure); sessions.setTags(project, id, [two], initial.version);
  await waitFor(() => expect(writes).toHaveBeenCalledOnce()); await sync(sessions, saved);
  await waitFor(() => expect(sessions.snapshot(project, id).detail).toEqual(saved));
  expect(sessions.snapshot(project, id).mutation.error).toBe(failure); expect(writes).toHaveBeenCalledOnce();
  if (failure.kind === 'network') expect(sessions.snapshot(project, id).mutation).toMatchObject({ phase: 'reconciled', reconciledFrom: 'unknown' });
});

it.each([{ ...saved, tags: [] }, { ...saved, title: 'Changed' }, { ...saved, allowAgents: true }, { ...saved, version: initial.version }])('reconciles an unqualified receipt %#', async receipt => {
  reads.mockResolvedValueOnce(initial).mockResolvedValueOnce(saved); const sessions = create(); await open(sessions);
  writes.mockResolvedValueOnce(receipt); sessions.setTags(project, id, [two], initial.version);
  await waitFor(() => expect(writes).toHaveBeenCalledOnce()); await sync(sessions, saved);
  await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('reconciled'));
  expect(sessions.snapshot(project, id).mutation.error).toMatchObject({ kind: 'protocol' }); expect(writes).toHaveBeenCalledOnce();
});
