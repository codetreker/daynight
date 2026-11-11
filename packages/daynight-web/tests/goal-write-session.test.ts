import { afterEach, expect, it, vi } from 'vitest';
import { waitForState as waitFor } from './helpers/waitForState';
import { createTaskCacheScope } from '../src/features/task-cache/project-cache';
import { TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { projectTaskScope } from '../src/features/task-graph/scope';
import { detailFixture } from './helpers/taskDetail';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { fixtureTaskEpoch, TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';
import { wireResponse } from './helpers/wireJson';

const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const goal = '30000000-0000-4000-8000-000000000001';
const epoch = '40000000-0000-4000-8000-000000000001';
const time = '2026-10-24T00:01:00Z';
const response = (body: unknown, taskEpoch = epoch) => wireResponse(body, { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': taskEpoch }) });
const worlds: { scope: ReturnType<typeof createTaskCacheScope>; sessions: TaskDetailSessions }[] = [];
const world = () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  sessions.subscribe(project, task, () => {}); return sessions;
};
afterEach(() => { for (const { scope, sessions } of worlds.splice(0)) { sessions.dispose(); scope.dispose(); } vi.unstubAllGlobals(); });

it('reopens a cancelled Goal and edits it through the same versioned owner', async () => {
  const initial = detailFixture(project, task, { type: 'goal', status: 'cancelled', ready: false, startedAt: time, cancelledAt: time });
  const reopened = { ...initial, status: 'done' as const, completedAt: time, cancelledAt: null, version: initial.version + 1n };
  const edited = { ...reopened, title: 'Revised', description: 'Details', version: reopened.version + 1n };
  let current = initial; let writes = 0;
  const fetcher = vi.fn((_url: string, init: RequestInit) => {
    if (init.method === 'PUT') { writes++; current = reopened; }
    if (init.method === 'PATCH') { writes++; current = edited; }
    return Promise.resolve(response(current));
  }); vi.stubGlobal('fetch', fetcher);
  const sessions = world(); const refresh = vi.fn(); sessions.subscribeProject(project, refresh); sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('ready'));
  sessions.setStatus(project, task, 'done', initial.version);
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ detail: reopened, requiresFreshRead: false, mutation: { phase: 'confirmed' } }));
  sessions.editGoal(project, task, 'Revised', 'Details', reopened.version);
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ detail: edited, requiresFreshRead: false, mutation: { phase: 'confirmed' } }));
  expect(writes).toBe(2); expect(refresh).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetcher.mock.calls.find(([, init]) => init.method === 'PATCH')![1].body as string)).toEqual({ version: Number(reopened.version), title: 'Revised', description: 'Details' });
});

it('reconciles an unknown Parent write without replaying and keeps dependencies', async () => {
  const initial = detailFixture(project, task, { dependsOn: [goal], externalDependsOn: [goal] });
  const moved = { ...initial, parentId: goal, version: initial.version + 1n };
  let current = initial; let writes = 0;
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    if (init.method === 'PATCH') { writes++; current = moved; return Promise.reject(new Error('response lost')); }
    return Promise.resolve(response(current));
  }));
  const sessions = world(); const refresh = vi.fn(); sessions.subscribeProject(project, refresh); sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('ready'));
  sessions.setParent(project, task, goal, initial.version);
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ detail: moved, mutation: { phase: 'reconciled', reconciledFrom: 'unknown' } }));
  expect(sessions.snapshot(project, task).detail?.dependsOn).toEqual([goal]); expect(writes).toBe(1); expect(refresh).toHaveBeenCalledOnce();
});

it('requests a project sync after a summary-backed Parent move', async () => {
  const initial = detailFixture(project, task);
  const moved = { ...initial, parentId: goal, version: initial.version + 1n };
  const world = createTaskSessionWorld(); const sessions = new TaskDetailSessions(world.scope); const refresh = vi.fn();
  sessions.subscribe(project, task, () => {}); sessions.subscribeProject(project, refresh);
  try {
    await world.sync([initial, detailFixture(project, goal, { type: 'goal', ready: false })]); sessions.observe(project, task, world.node(project, task));
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => Promise.resolve(response(init.method === 'PATCH' ? moved : initial, fixtureTaskEpoch(project)))));
    sessions.load(project, task, 1); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('ready'));
    sessions.setParent(project, task, goal, initial.version);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await world.sync([moved]); sessions.observe(project, task, world.node(project, task));
    await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ detail: moved, mutation: { phase: 'confirmed' } }));
  } finally { sessions.dispose(); world.dispose(); }
});

it('publishes the moved Task and both Goal progress values from the same project snapshot', async () => {
  const secondGoal = '30000000-0000-4000-8000-000000000002';
  const initial = detailFixture(project, task, { parentId: goal, status: 'done', ready: false });
  const moved = { ...initial, parentId: secondGoal, version: initial.version + 1n };
  const first = detailFixture(project, goal, { type: 'goal', ready: false });
  const second = detailFixture(project, secondGoal, { type: 'goal', ready: false });
  const world = createTaskSessionWorld(); const sessions = new TaskDetailSessions(world.scope);
  sessions.subscribe(project, task, () => {});
  try {
    await world.sync([initial, first, second]); sessions.observe(project, task, world.node(project, task));
    const before = world.scope.getAuthorizedProject(project)!;
    expect(projectTaskScope(before.index, goal).progress).toMatchObject({ total: 1, done: 1 });
    expect(projectTaskScope(before.index, secondGoal).progress).toMatchObject({ total: 0, done: 0 });
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => Promise.resolve(response(init.method === 'PATCH' ? moved : initial, fixtureTaskEpoch(project)))));
    const refresh = vi.fn(); sessions.subscribeProject(project, refresh);
    sessions.load(project, task, 1); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('ready'));
    sessions.setParent(project, task, secondGoal, initial.version);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await world.sync([moved]); sessions.observe(project, task, world.node(project, task));
    const after = world.scope.getAuthorizedProject(project)!;
    expect(after.index.nodes.get(task)?.parentId).toBe(secondGoal);
    expect(projectTaskScope(after.index, goal).progress).toMatchObject({ total: 0, done: 0 });
    expect(projectTaskScope(after.index, secondGoal).progress).toMatchObject({ total: 1, done: 1 });
    await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ detail: moved, mutation: { phase: 'confirmed' } }));
  } finally { sessions.dispose(); world.dispose(); }
});

it('retires Goal and child history as soon as deletion is confirmed, even if refresh fails and an old response arrives', async () => {
  const goalDetail = detailFixture(project, task, { type: 'goal', ready: false });
  const child = detailFixture(project, goal, { parentId: task, title: 'Private child' });
  let deleted = false; let delayChild = false; let resolveOld!: (value: Response) => void;
  const old = new Promise<Response>(resolve => { resolveOld = resolve; });
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    if (init.method === 'DELETE') { deleted = true; return Promise.resolve(new Response(null, { status: 204, headers: viewerHeaders(TEST_VIEWER_ID) })); }
    if (deleted) return Promise.reject(new Error('offline'));
    if (url.endsWith(goal) && delayChild) return old;
    return Promise.resolve(response(url.endsWith(goal) ? child : goalDetail));
  }));
  const sessions = world(); sessions.subscribe(project, goal, () => {});
  sessions.openDirect(project, task); sessions.openDirect(project, goal);
  await waitFor(() => expect(sessions.snapshot(project, goal).detail).toEqual(child));
  await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(goalDetail));
  delayChild = true; sessions.load(project, goal, 2, 'refresh');
  await waitFor(() => expect(sessions.snapshot(project, goal).refreshing).toBe(true));
  sessions.deleteTask(project, task, goalDetail.version, false);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('deleted'));
  expect(sessions.snapshot(project, goal).detail).toBeNull();
  resolveOld(response(child));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(sessions.snapshot(project, goal).detail).toBeNull();
});

it('fences the deleted Goal history in another tab without waiting for project sync', async () => {
  class Channel {
    static peers = new Set<Channel>();
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor(_name: string) { Channel.peers.add(this); }
    postMessage(data: unknown) { for (const peer of Channel.peers) if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data } as MessageEvent<unknown>)); }
    close() { Channel.peers.delete(this); }
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  const goalDetail = detailFixture(project, task, { type: 'goal', ready: false });
  const child = detailFixture(project, goal, { parentId: task, title: 'Private child' });
  let deleted = false;
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    if (init.method === 'DELETE') { deleted = true; return Promise.resolve(new Response(null, { status: 204, headers: viewerHeaders(TEST_VIEWER_ID) })); }
    return deleted ? Promise.reject(new Error('offline')) : Promise.resolve(response(url.endsWith(goal) ? child : goalDetail));
  }));
  const owner = world(), peer = world(); peer.subscribe(project, goal, () => {});
  owner.openDirect(project, task); peer.openDirect(project, goal);
  await waitFor(() => expect(owner.snapshot(project, task).detail).toEqual(goalDetail));
  await waitFor(() => expect(peer.snapshot(project, goal).detail).toEqual(child));
  owner.deleteTask(project, task, goalDetail.version, false);
  await waitFor(() => expect(peer.snapshot(project, goal).detail).toBeNull());
});

it.each(['same', 'new'] as const)('fences a newer observed epoch until a read after the late deletion receipt: %s', async (outcome) => {
  const nextEpoch = '40000000-0000-4000-8000-000000000002';
  const deletionEpoch = '40000000-0000-4000-8000-000000000003';
  const goalDetail = detailFixture(project, task, { type: 'goal', ready: false });
  let finishDelete!: (value: Response) => void; let dispatched = false;
  const pending = new Promise<Response>(resolve => { finishDelete = resolve; });
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    if (init.method === 'DELETE') { dispatched = true; return pending; }
    return Promise.resolve(response(goalDetail));
  }));
  const sessions = world(); const scope = worlds.at(-1)!.scope;
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(goalDetail));
  sessions.deleteTask(project, task, goalDetail.version, false); await waitFor(() => expect(dispatched).toBe(true));
  const oldFence = await scope.beginTaskRead(project, goal, 1, 1, scope.signal);
  expect(await scope.observeHistory(oldFence, nextEpoch, scope.signal)).toBe('retired');
  const newFence = await scope.beginTaskRead(project, goal, 2, 2, scope.signal);
  expect(await scope.observeHistory(newFence, nextEpoch, scope.signal)).toBe('current');
  const generation = scope.getHistoryGeneration(project);
  finishDelete(new Response(null, { status: 204, headers: viewerHeaders(TEST_VIEWER_ID) }));
  await waitFor(() => expect(scope.isTaskReadCurrent(newFence)).toBe(false));
  expect(scope.getHistoryGeneration(project)).toBe(generation);
  expect(scope.canPreviewProject(project)).toBe(false);
  const later = await scope.beginTaskRead(project, goal, 3, 3, scope.signal);
  const observed = outcome === 'same' ? nextEpoch : deletionEpoch;
  expect(await scope.observeHistory(later, observed, scope.signal)).toBe(outcome === 'same' ? 'current' : 'retired');
  if (outcome === 'new') {
    const retry = await scope.beginTaskRead(project, goal, 4, 4, scope.signal);
    expect(await scope.observeHistory(retry, observed, scope.signal)).toBe('current');
  }
});

it('retires old Goal history after an unknown deletion is observed as task_deleted without claiming write success', async () => {
  const goalDetail = detailFixture(project, task, { type: 'goal', ready: false });
  const child = detailFixture(project, goal, { parentId: task, title: 'Private child' });
  let deleted = false; let writes = 0;
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    if (init.method === 'DELETE') { deleted = true; writes++; return Promise.reject(new Error('response lost')); }
    if (deleted && url.endsWith(task)) return Promise.resolve(wireResponse({ error: { code: 'task_deleted', message: 'Deleted', requestId: 'deleted' } }, { status: 410, headers: viewerHeaders(TEST_VIEWER_ID) }));
    if (deleted) return Promise.reject(new Error('offline'));
    return Promise.resolve(response(url.endsWith(goal) ? child : goalDetail));
  }));
  const sessions = world(); const scope = worlds.at(-1)!.scope; sessions.subscribe(project, goal, () => {});
  sessions.openDirect(project, task); sessions.openDirect(project, goal);
  await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(goalDetail));
  await waitFor(() => expect(sessions.snapshot(project, goal).detail).toEqual(child));
  sessions.deleteTask(project, task, goalDetail.version, false);
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: 'deleted', mutation: { phase: 'reconciled', error: { kind: 'network' } } }));
  expect(sessions.snapshot(project, goal).detail).toBeNull(); expect(writes).toBe(1);
  expect(scope.canPreviewProject(project)).toBe(false);
  const after = await scope.beginTaskRead(project, goal, 3, 3, scope.signal);
  expect(await scope.observeHistory(after, epoch, scope.signal)).toBe('current');
});
