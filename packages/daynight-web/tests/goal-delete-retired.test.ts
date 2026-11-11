import { afterEach, expect, it, vi } from 'vitest';
import { waitForState as waitFor } from './helpers/waitForState';
import { createTaskCacheScope } from '../src/features/task-cache/project-cache';
import { TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { detailFixture } from './helpers/taskDetail';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';
import { wireResponse } from './helpers/wireJson';

const project = '10000000-0000-4000-8000-000000000001';
const goal = '20000000-0000-4000-8000-000000000001';
const child = '30000000-0000-4000-8000-000000000001';
const epoch = '40000000-0000-4000-8000-000000000001';
const goalDetail = detailFixture(project, goal, { type: 'goal', ready: false });
const childDetail = detailFixture(project, child, { parentId: goal, title: 'Private child' });
const response = (body: unknown) => wireResponse(body, { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) });
class Channel {
  static peers = new Set<Channel>(); static messages: unknown[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(_name: string) { Channel.peers.add(this); }
  postMessage(data: unknown) { Channel.messages.push(data); for (const peer of Channel.peers) if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data } as MessageEvent<unknown>)); }
  close() { Channel.peers.delete(this); }
}
const resources: { scope: ReturnType<typeof createTaskCacheScope>; sessions: TaskDetailSessions }[] = [];
const world = () => { const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); const sessions = new TaskDetailSessions(scope); resources.push({ scope, sessions }); return { scope, sessions }; };
afterEach(() => { for (const { scope, sessions } of resources.splice(0)) { sessions.dispose(); scope.dispose(); } Channel.peers.clear(); Channel.messages = []; vi.unstubAllGlobals(); });

it.each(['confirmed', 'unknown', 'already-deleted'] as const)('fences a peer child read before its first epoch after a %s Goal deletion', async outcome => {
  vi.stubGlobal('BroadcastChannel', Channel);
  let finishWrite!: (response: Response) => void; let loseWrite!: (error: Error) => void;
  const write = new Promise<Response>((resolve, reject) => { finishWrite = resolve; loseWrite = reject; });
  let finishOld!: (response: Response) => void;
  const old = new Promise<Response>(resolve => { finishOld = resolve; });
  let deleted = false; let childReads = 0; let firstSignal: AbortSignal | undefined; let writes = 0;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') { writes++; return write; }
    if (url.endsWith(child)) {
      childReads++;
      if (childReads === 1) { firstSignal = init?.signal as AbortSignal; return old; }
      return Promise.reject(new Error('offline'));
    }
    if (deleted) return Promise.resolve(wireResponse({ error: { code: 'task_deleted', message: 'Deleted', requestId: 'deleted' } }, { status: 410, headers: viewerHeaders(TEST_VIEWER_ID) }));
    return Promise.resolve(response(goalDetail));
  }));
  const owner = world(), peer = world(); const close = owner.sessions.subscribe(project, goal, () => {});
  peer.sessions.subscribe(project, child, () => {}); owner.sessions.openDirect(project, goal); peer.sessions.openDirect(project, child);
  await waitFor(() => expect(owner.sessions.snapshot(project, goal).detail).toEqual(goalDetail));
  await waitFor(() => expect(childReads).toBe(1));
  expect(peer.scope.getHistoryGeneration(project)).toBe(0);
  owner.sessions.deleteTask(project, goal, goalDetail.version, false);
  await waitFor(() => expect(writes).toBe(1));
  if (outcome !== 'confirmed') close();
  deleted = true;
  if (outcome === 'confirmed') finishWrite(new Response(null, { status: 204, headers: viewerHeaders(TEST_VIEWER_ID) }));
  else if (outcome === 'unknown') loseWrite(new Error('response lost'));
  else finishWrite(wireResponse({ error: { code: 'task_deleted', message: 'Deleted', requestId: 'deleted' } }, { status: 410, headers: viewerHeaders(TEST_VIEWER_ID) }));
  await waitFor(() => expect(firstSignal?.aborted).toBe(true));
  await waitFor(() => expect(childReads).toBeGreaterThan(1));
  finishOld(response(childDetail)); await old; await new Promise(resolve => setTimeout(resolve, 0));
  expect(peer.sessions.snapshot(project, child).detail).toBeNull();
  expect(Channel.messages.some(value => typeof value === 'object' && value !== null && (outcome === 'confirmed' ? 'retiredEpoch' in value : 'uncertainEpoch' in value))).toBe(true);
  expect(writes).toBe(1);
});

it('retires an already-open child when a closed Goal deletion loses its receipt and reconciles as deleted', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  let loseWrite!: (error: Error) => void; const write = new Promise<Response>((_resolve, reject) => { loseWrite = reject; });
  let deleted = false; let writes = 0;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') { writes++; return write; }
    if (deleted && url.endsWith(goal)) return Promise.resolve(wireResponse({ error: { code: 'task_deleted', message: 'Deleted', requestId: 'deleted' } }, { status: 410, headers: viewerHeaders(TEST_VIEWER_ID) }));
    if (deleted) return Promise.reject(new Error('offline'));
    return Promise.resolve(response(url.endsWith(child) ? childDetail : goalDetail));
  }));
  const owner = world(), peer = world(); const close = owner.sessions.subscribe(project, goal, () => {});
  peer.sessions.subscribe(project, child, () => {}); owner.sessions.openDirect(project, goal); peer.sessions.openDirect(project, child);
  await waitFor(() => expect(owner.sessions.snapshot(project, goal).detail).toEqual(goalDetail));
  await waitFor(() => expect(peer.sessions.snapshot(project, child).detail).toEqual(childDetail));
  owner.sessions.deleteTask(project, goal, goalDetail.version, false); await waitFor(() => expect(writes).toBe(1));
  close(); deleted = true; loseWrite(new Error('response lost'));
  await waitFor(() => expect(peer.sessions.snapshot(project, child).detail).toBeNull());
  expect(Channel.messages.some(value => typeof value === 'object' && value !== null && 'uncertainEpoch' in value)).toBe(true);
  expect(writes).toBe(1);
});

it('does not fence a later history from a stale retired reconciliation 410', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const replacement = '40000000-0000-4000-8000-000000000002';
  let loseWrite!: (error: Error) => void; const write = new Promise<Response>((_resolve, reject) => { loseWrite = reject; });
  let finishOldRead!: (response: Response) => void; const oldRead = new Promise<Response>(resolve => { finishOldRead = resolve; });
  let writes = 0; let reads = 0;
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') { writes++; return write; }
    reads++; return reads === 1 ? Promise.resolve(response(goalDetail)) : oldRead;
  }));
  const owner = world(); const close = owner.sessions.subscribe(project, goal, () => {});
  owner.sessions.openDirect(project, goal); await waitFor(() => expect(owner.sessions.snapshot(project, goal).detail).toEqual(goalDetail));
  owner.sessions.deleteTask(project, goal, goalDetail.version, false); await waitFor(() => expect(writes).toBe(1));
  close(); loseWrite(new Error('response lost')); await waitFor(() => expect(reads).toBe(2));
  const original = await owner.scope.beginTaskRead(project, child, 1, 1, owner.scope.signal);
  expect(await owner.scope.observeHistory(original, replacement, owner.scope.signal)).toBe('retired');
  const current = await owner.scope.beginTaskRead(project, child, 2, 2, owner.scope.signal);
  expect(await owner.scope.observeHistory(current, replacement, owner.scope.signal)).toBe('current');
  finishOldRead(wireResponse({ error: { code: 'task_deleted', message: 'Deleted', requestId: 'stale' } }, { status: 410, headers: viewerHeaders(TEST_VIEWER_ID) }));
  await oldRead; await new Promise(resolve => setTimeout(resolve, 0));
  expect(owner.scope.isTaskReadCurrent(current)).toBe(true);
  expect(Channel.messages.some(value => typeof value === 'object' && value !== null && 'uncertainEpoch' in value)).toBe(false);
});
