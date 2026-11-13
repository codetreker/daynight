import { useEffect, useState } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocaleRender } from './helpers/renderWithLocale';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { TEST_VIEWER_ID, viewerHeaders, taskSyncFromGraph, directAccessFixture } from './helpers/taskSync';
import { wireResponse } from './helpers/wireJson';
import { createTerminalSessionApi, type SessionHistoryItem } from '../src/api/terminal-sessions';
import { ApiError, pauseAuthRequests, subscribeUnauthorized } from '../src/api/client';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { TaskCacheLifecycleChanged } from '../src/features/task-cache/project-cache';
import { TaskDetailSessionProvider, useTaskDetailSessions, TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { ManagedSessionRecords, useTaskSessionRecords } from '../src/features/task-agent-session/TaskSessionHost';
import { beginSessionHistoryRefresh, clearSessionHistory, readCachedSessionHistory, readSessionHistoryOwnership, saveSessionHistory } from '../src/features/task-agent-session/session-history-cache';

vi.mock('../src/api/terminal-sessions', async (original) => ({ ...(await original<typeof import('../src/api/terminal-sessions')>()), createTerminalSessionApi: vi.fn() }));
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const epoch = '30000000-0000-4000-8000-000000000001';
const replacement = '30000000-0000-4000-8000-000000000002';
const item: SessionHistoryItem = { sessionId: '00000004-1111-4111-8111-111111111111', claimId: '00000003-1111-4111-8111-111111111111', executionGeneration: '1', agentControlMode: 'herdr', contentKind: 'terminal_recording', createdAt: '2026-11-03T10:00:00Z', endedAt: '2026-11-03T10:01:00Z', archive: { state: 'pending', sha256: null, byteLength: null, completeness: null } };
const second = { ...item, sessionId: '00000005-1111-4111-8111-111111111111', createdAt: '2026-11-02T10:00:00Z' };
const render = createLocaleRender('en');
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
function DirectRecords({ active = true, onSessions }: { active?: boolean; onSessions?: (sessions: TaskDetailSessions) => void } = {}) {
  const sessions = useTaskDetailSessions();
  useEffect(() => { onSessions?.(sessions); sessions.openDirect(projectId, taskId); return () => sessions.releaseRead(projectId, taskId); }, [sessions]);
  return <ManagedSessionRecords projectId={projectId} taskId={taskId} active={active} direct>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>;
}
function setup(taskEpoch = epoch, onSessions?: (sessions: TaskDetailSessions) => void) {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: () => { void scope.invalidateScope(); } }); scopes.push(scope);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': taskEpoch }) })));
  const api = { history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [item], nextCursor: null as string | null })), archive: vi.fn(async () => ({ status: { payload: { state: 'pending' } }, archive: null })), current: vi.fn(), channel: vi.fn(), command: vi.fn() };
  vi.mocked(createTerminalSessionApi).mockReturnValue(api as never);
  const view = render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><DirectRecords {...(onSessions === undefined ? {} : { onSessions })} /></TaskDetailSessionProvider></TaskCacheProvider>);
  return { scope, api, view };
}
afterEach(() => { scopes.splice(0).forEach(scope => scope.dispose()); vi.unstubAllGlobals(); });

it('loads and paginates live records without a project manifest', async () => {
  const { scope, api } = setup();
  api.history.mockResolvedValueOnce({ items: [item], nextCursor: 'next' }).mockResolvedValueOnce({ items: [second], nextCursor: null });
  expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
  expect(scope.getAuthorizedProject(projectId)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier records' }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: /Herdr/ })).toHaveLength(2));
  expect(api.history.mock.calls.map(call => call[0])).toEqual([null, 'next']);
});

it('discovers the newest direct recording after empty history pages without a project manifest', async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  const api = { history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [] as SessionHistoryItem[], nextCursor: null as string | null })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() };
  api.history.mockResolvedValueOnce({ items: [], nextCursor: 'next' }).mockResolvedValueOnce({ items: [item], nextCursor: null });
  vi.mocked(createTerminalSessionApi).mockReturnValue(api as never);
  function AutomaticRecords() {
    const sessions = useTaskDetailSessions();
    useEffect(() => { sessions.openDirect(projectId, taskId); return () => sessions.releaseRead(projectId, taskId); }, [sessions]);
    const history = useTaskSessionRecords(projectId, taskId, true, true);
    return <span>{history.items[0]?.sessionId ?? (history.confirmedEmpty ? 'empty' : 'loading')}</span>;
  }
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><AutomaticRecords /></TaskDetailSessionProvider></TaskCacheProvider>);
  expect(await screen.findByText(item.sessionId)).toBeVisible();
  expect(api.history.mock.calls.map(call => call[0])).toEqual([null, 'next']);
  expect(scope.getAuthorizedProject(projectId)).toBeNull();
});

it('rejects a repeated cursor while discovering direct Session records', async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  const api = { history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [] as SessionHistoryItem[], nextCursor: 'repeat' as string | null })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() };
  vi.mocked(createTerminalSessionApi).mockReturnValue(api as never);
  function AutomaticRecords() {
    const sessions = useTaskDetailSessions();
    useEffect(() => { sessions.openDirect(projectId, taskId); return () => sessions.releaseRead(projectId, taskId); }, [sessions]);
    const history = useTaskSessionRecords(projectId, taskId, true, true);
    return <span>{history.error instanceof ApiError && history.error.kind === 'protocol' ? 'protocol error' : 'loading'}</span>;
  }
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><AutomaticRecords /></TaskDetailSessionProvider></TaskCacheProvider>);
  expect(await screen.findByText('protocol error')).toBeVisible();
  expect(api.history.mock.calls.map(call => call[0])).toEqual([null, 'repeat']);
});

it('retains the direct history response through a rapidly completed identity check', async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  let finish!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  const api = { history: vi.fn((_cursor: string | null, _signal: AbortSignal) => new Promise<{ items: SessionHistoryItem[]; nextCursor: null }>(resolve => { finish = resolve; })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() };
  vi.mocked(createTerminalSessionApi).mockReturnValue(api as never);
  function AutomaticRecords() {
    const sessions = useTaskDetailSessions();
    useEffect(() => { sessions.openDirect(projectId, taskId); return () => sessions.releaseRead(projectId, taskId); }, [sessions]);
    const history = useTaskSessionRecords(projectId, taskId, true, true);
    return <span>{history.items[0]?.sessionId ?? 'loading'}</span>;
  }
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><AutomaticRecords /></TaskDetailSessionProvider></TaskCacheProvider>);
  await waitFor(() => expect(api.history).toHaveBeenCalledOnce());
  const verify = scope.verifyTaskRead.bind(scope);
  vi.spyOn(scope, 'verifyTaskRead').mockImplementationOnce(async () => {
    const resume = pauseAuthRequests(); resume(); throw new TaskCacheLifecycleChanged();
  }).mockImplementation(verify);
  await act(async () => finish({ items: [item], nextCursor: null }));
  expect(await screen.findByText(item.sessionId)).toBeVisible();
  expect(api.history).toHaveBeenCalledOnce();
});

it('keeps one recovered direct history owner when a claim starts on the attachments tab', async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  const api = { history: vi.fn(async (_cursor: string | null, _signal: AbortSignal): Promise<{ items: SessionHistoryItem[]; nextCursor: null }> => ({ items: [second], nextCursor: null })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() };
  api.history.mockRejectedValueOnce(new ApiError('server', 403));
  vi.mocked(createTerminalSessionApi).mockReturnValue(api as never);
  function SwitchingRecords() {
    const sessions = useTaskDetailSessions(); const [claimed, setClaimed] = useState(false);
    useEffect(() => { sessions.openDirect(projectId, taskId); return () => sessions.releaseRead(projectId, taskId); }, [sessions]);
    const attachmentsActive = true;
    const shared = useTaskSessionRecords(projectId, taskId, !claimed || attachmentsActive, true, !claimed);
    return <><button onClick={() => setClaimed(true)}>Start claim</button><ManagedSessionRecords projectId={projectId} taskId={taskId} active direct records={shared}>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords></>;
  }
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><SwitchingRecords /></TaskDetailSessionProvider></TaskCacheProvider>);
  expect(await screen.findByRole('alert')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('button', { name: /2026-11-02/ })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Start claim' }));
  expect(screen.getByRole('button', { name: /2026-11-02/ })).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(3));
});

it('keeps an empty direct attachments page with a claim available for manual pagination', async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  const api = { history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [] as SessionHistoryItem[], nextCursor: null as string | null })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() };
  api.history.mockResolvedValueOnce({ items: [], nextCursor: 'next' }).mockResolvedValueOnce({ items: [item], nextCursor: null });
  vi.mocked(createTerminalSessionApi).mockReturnValue(api as never);
  function ClaimedRecords() {
    const sessions = useTaskDetailSessions();
    useEffect(() => { sessions.openDirect(projectId, taskId); return () => sessions.releaseRead(projectId, taskId); }, [sessions]);
    const shared = useTaskSessionRecords(projectId, taskId, true, true, false);
    return <ManagedSessionRecords projectId={projectId} taskId={taskId} active direct records={shared}>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>;
  }
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><ClaimedRecords /></TaskDetailSessionProvider></TaskCacheProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Load earlier records' }));
  expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
  expect(api.history.mock.calls.map(call => call[0])).toEqual([null, 'next']);
});

it('withdraws records on a session denial and retries without restoring selection', async () => {
  const { api } = setup();
  fireEvent.click(await screen.findByRole('button', { name: /Herdr/ }));
  await screen.findByText('Recording is waiting to be archived.');
  api.history.mockRejectedValueOnce(new ApiError('server', 403));
  fireEvent.click(screen.getAllByRole('button', { name: 'Refresh' })[0]!);
  expect(await screen.findByRole('alert')).toHaveTextContent('You no longer have permission');
  expect(screen.queryByRole('button', { name: 'Close recording' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('button', { name: /Herdr/ })).toHaveAttribute('aria-pressed', 'false');
});

it('withdraws direct records and selection across a batched access recheck, and starts recovery at the first page', async () => {
  const { scope, api } = setup();
  api.history.mockResolvedValueOnce({ items: [item], nextCursor: 'next' });
  let finishOld!: (page: { items: SessionHistoryItem[]; nextCursor: string | null }) => void;
  api.history.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  api.history.mockRejectedValueOnce(new ApiError('server', 503));
  api.history.mockResolvedValueOnce({ items: [second], nextCursor: null });
  fireEvent.click(await screen.findByRole('button', { name: /Herdr/ }));
  expect(await screen.findByText('Recording is waiting to be archived.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier records' }));
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
  const oldSignal = api.history.mock.calls[1]![1];
  const emit = (scope as unknown as { emit(event: { projectId: string; directAccessUncertain?: true; directAccessRecheck?: true }): void }).emit.bind(scope);
  act(() => { emit({ projectId, directAccessUncertain: true }); emit({ projectId, directAccessRecheck: true }); });
  expect(oldSignal.aborted).toBe(true);
  expect(screen.queryByRole('button', { name: 'Close recording' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Load earlier records' })).toBeNull();
  await act(async () => finishOld({ items: [item], nextCursor: 'stale' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.queryByRole('button', { name: /Herdr/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('button', { name: /2026-11-02.*Herdr/ })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.queryByRole('button', { name: 'Close recording' })).toBeNull();
  expect(api.history.mock.calls.map(call => call[0])).toEqual([null, 'next', null, null]);
});

it.each(['same account', 'different account'] as const)('does not retry direct records until project access is rechecked for the %s', async account => {
  TestChannel.channels = []; TestChannel.suspended = false; TestChannel.holdClear = false; TestChannel.held = []; TestChannel.holdHint = false; TestChannel.heldHints = [];
  vi.stubGlobal('BroadcastChannel', TestChannel);
  let sessions!: TaskDetailSessions;
  const { scope, api } = setup(epoch, value => { sessions = value; });
  fireEvent.click(await screen.findByRole('button', { name: /Herdr/ }));
  const sender = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(sender);
  const ticket = await sender.beginSync(projectId, sender.signal);
  const firstAccess = Promise.withResolvers<Response>(); let accessReads = 0;
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/access')) {
      if (++accessReads === 1) return firstAccess.promise;
      const viewer = account === 'same account' ? TEST_VIEWER_ID : '00000000-0000-4000-8000-000000000202';
      return wireResponse(directAccessFixture(projectId), { headers: viewerHeaders(viewer) });
    }
    return wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) });
  });
  vi.stubGlobal('fetch', fetcher);
  const events: { directAccessUncertain?: true; directAccessRecheck?: true; error?: unknown }[] = [];
  const unsubscribe = scope.subscribe(event => events.push(event));
  await act(async () => { await sender.revokeProject(ticket, sender.signal); });
  await waitFor(() => expect(events).toContainEqual(expect.objectContaining({ directAccessUncertain: true })));
  await waitFor(() => expect(accessReads).toBe(1));
  expect(screen.queryByRole('button', { name: 'Close recording' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await act(async () => firstAccess.reject(new TypeError('Access check failed')));
  await waitFor(() => expect(events).toContainEqual(expect.objectContaining({ directAccessRecheck: true, error: expect.anything() })));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await act(async () => { await Promise.resolve(); });
  expect(api.history).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: /Herdr/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Close recording' })).toBeNull();
  api.history.mockResolvedValueOnce({ items: [second], nextCursor: null });
  act(() => sessions.load(projectId, taskId, 1, 'refresh'));
  if (account === 'same account') {
    expect(await screen.findByRole('button', { name: /2026-11-02.*Herdr/ })).toHaveAttribute('aria-pressed', 'false');
    expect(api.history.mock.calls.map(call => call[0])).toEqual([null, null]);
  } else {
    await waitFor(() => expect(scope.hasIdentityMismatch).toBe(true));
    expect(api.history).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /Herdr/ })).toBeNull();
  }
  expect(accessReads).toBeGreaterThanOrEqual(2);
  expect(screen.queryByRole('button', { name: 'Close recording' })).toBeNull();
  unsubscribe();
});

it.each(['same mount', 'remount'] as const)('recovers direct records after confirmed project withdrawal and reauthorization on %s', async mode => {
  let sessions!: TaskDetailSessions;
  const { scope, api, view } = setup(epoch, value => { sessions = value; });
  api.history.mockResolvedValueOnce({ items: [item], nextCursor: 'old-cursor' });
  fireEvent.click(await screen.findByRole('button', { name: /Herdr/ }));
  expect(await screen.findByText('Recording is waiting to be archived.')).toBeVisible();
  const emit = (scope as unknown as { emit(event: { projectId: string; directAccessUncertain: true }): void }).emit.bind(scope);
  act(() => emit({ projectId, directAccessUncertain: true }));
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse({ error: { code: 'not_found', message: 'not found', requestId: 'withdrawal' } }, { status: 404, headers: viewerHeaders(TEST_VIEWER_ID) })));
  await act(async () => { expect(await scope.revalidateProjectAccess(projectId)).toBe(false); });
  expect(screen.queryByRole('button', { name: /Herdr/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Close recording' })).toBeNull();
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  api.history.mockResolvedValueOnce({ items: [second], nextCursor: null });
  if (mode === 'same mount') act(() => sessions.openDirect(projectId, taskId));
  else {
    view.rerender(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider>{null}</TaskDetailSessionProvider></TaskCacheProvider>);
    view.rerender(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider>);
  }
  expect(await screen.findByRole('button', { name: /2026-11-02.*Herdr/ })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.queryByRole('button', { name: 'Close recording' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Load earlier records' })).toBeNull();
  expect(api.history.mock.calls.map(call => call[0])).toEqual([null, null]);
});

it('discards a delayed old-history response and reads again under the new receipt', async () => {
  const { scope, api } = setup();
  let finish!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  api.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
  vi.mocked(fetch).mockImplementation(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': replacement }) }));
  const signal = new AbortController().signal;
  const fence = await scope.beginTaskRead(projectId, taskId, 0, 0, signal);
  await act(async () => { expect(await scope.observeHistory(fence, replacement, signal)).toBe('retired'); });
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
  await act(async () => finish({ items: [second], nextCursor: null }));
  expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
  expect(screen.getAllByRole('button', { name: /Herdr/ })).toHaveLength(1);
});

class TestChannel {
  static channels: TestChannel[] = [];
  static suspended = false;
  static holdClear = false;
  static held: unknown[] = [];
  static holdHint = false;
  static heldHints: unknown[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor() { TestChannel.channels.push(this); }
  postMessage(data: unknown) { if (TestChannel.suspended) return; if (TestChannel.holdHint && typeof data === 'object' && data !== null && Object.keys(data).length === 2 && 'projectId' in data && 'userId' in data) { TestChannel.heldHints.push(data); return; } if (TestChannel.holdClear && typeof data === 'object' && data !== null && 'sessionHistoryCleared' in data) { TestChannel.held.push(data); return; } for (const other of TestChannel.channels) if (other !== this) queueMicrotask(() => other.onmessage?.({ data } as MessageEvent<unknown>)); }
  close() { TestChannel.channels = TestChannel.channels.filter(channel => channel !== this); }
}
async function seedPeer() {
  TestChannel.channels = []; TestChannel.suspended = false; TestChannel.holdClear = false; TestChannel.held = []; TestChannel.holdHint = false; TestChannel.heldHints = []; vi.stubGlobal('BroadcastChannel', TestChannel);
  const peer = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(peer);
  const signal = new AbortController().signal;
  await peer.applySync(await peer.beginSync(projectId, signal), taskSyncFromGraph(graphFixture([detailFixture(projectId, taskId)]), { epoch, versionForTask: () => 1n }), signal);
  const ticket = await peer.beginSync(projectId, signal);
  const lease = await beginSessionHistoryRefresh(peer, ticket, taskId, signal);
  if (lease === null || lease.kind !== 'lease') throw new Error('Expected a session refresh lease.');
  expect(await saveSessionHistory(peer, ticket, taskId, { items: [item], nextCursor: null }, lease.token, signal)).toBe(true);
  return { peer, ticket, signal };
}

it('withdraws a same-history peer cache when a direct records request is denied', async () => {
  const { peer, ticket, signal } = await seedPeer();
  const events = vi.fn(); peer.subscribe(events);
  const { api, scope } = setup();
  api.history.mockRejectedValueOnce(new ApiError('server', 403));
  expect(await screen.findByRole('alert')).toHaveTextContent('You no longer have permission');
  expect(scope.getAuthorizedProject(projectId)).toBeNull();
  await waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ sessionHistoryCleared: expect.objectContaining({ taskId }) })));
  expect(await readCachedSessionHistory(peer, ticket, taskId, signal)).toBeNull();
  const reopened = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(reopened);
  expect(await readCachedSessionHistory(reopened, await reopened.beginSync(projectId, signal), taskId, signal)).toBeNull();
});

it('withdraws direct records when another tab reports a matching denial', async () => {
  const { peer, ticket, signal } = await seedPeer();
  setup();
  expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
  await act(async () => { expect(await peer.reportHistoryUncertain(ticket, taskId, null, signal, true)).toBe(true); });
  await waitFor(() => expect(screen.queryByRole('button', { name: /Herdr/ })).toBeNull());
});

it('does not send an old denial to the replacement history', async () => {
  await seedPeer();
  const { scope, api } = setup();
  let reject!: (error: Error) => void;
  api.history.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const report = vi.spyOn(scope, 'reportHistoryUncertain');
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
  vi.mocked(fetch).mockImplementation(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': replacement }) }));
  const signal = new AbortController().signal;
  const fence = await scope.beginTaskRead(projectId, taskId, 0, 0, signal);
  await act(async () => { expect(await scope.observeHistory(fence, replacement, signal)).toBe('retired'); });
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
  await act(async () => reject(new ApiError('server', 403)));
  expect(report).not.toHaveBeenCalled();
  expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
});

it('does not clear a newer same-history refresh after an older denial', async () => {
  const { peer, ticket, signal } = await seedPeer();
  const { api } = setup();
  let reject!: (error: Error) => void;
  api.history.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
  const lease = await beginSessionHistoryRefresh(peer, ticket, taskId, signal);
  if (lease === null || lease.kind !== 'lease') throw new Error('Expected a session refresh lease.');
  expect(await saveSessionHistory(peer, ticket, taskId, { items: [second], nextCursor: null }, lease.token, signal)).toBe(true);
  await act(async () => reject(new ApiError('server', 403)));
  expect(await screen.findByRole('alert')).toHaveTextContent('You no longer have permission');
  expect(await readCachedSessionHistory(peer, ticket, taskId, signal)).toMatchObject({ items: [second] });
});

it('withdraws same-history direct peers without any active manifest', async () => {
  TestChannel.channels = []; TestChannel.suspended = false; TestChannel.holdClear = false; TestChannel.held = []; TestChannel.holdHint = false; TestChannel.heldHints = []; vi.stubGlobal('BroadcastChannel', TestChannel);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  const first = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const secondScope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(first, secondScope);
  const makeApi = () => ({ history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [item], nextCursor: null as string | null })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() });
  const firstApi = makeApi(), secondApi = makeApi();
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(firstApi as never).mockReturnValueOnce(secondApi as never);
  render(<><div data-testid="first"><TaskCacheProvider scope={first}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div><div data-testid="second"><TaskCacheProvider scope={secondScope}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div></>);
  const firstBox = screen.getByTestId('first'), secondBox = screen.getByTestId('second');
  await waitFor(() => expect(within(firstBox).getByRole('button', { name: /Herdr/ })).toBeVisible());
  await waitFor(() => expect(within(secondBox).getByRole('button', { name: /Herdr/ })).toBeVisible());
  firstApi.history.mockRejectedValueOnce(new ApiError('server', 403));
  fireEvent.click(within(firstBox).getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(within(secondBox).queryByRole('button', { name: /Herdr/ })).toBeNull());
});

it('retains a peer denial while the direct records tab is inactive', async () => {
  TestChannel.channels = []; TestChannel.suspended = false; TestChannel.holdClear = false; TestChannel.held = []; TestChannel.holdHint = false; TestChannel.heldHints = []; vi.stubGlobal('BroadcastChannel', TestChannel);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  const first = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const other = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(first, other);
  const makeApi = () => ({ history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [item], nextCursor: null as string | null })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() });
  const firstApi = makeApi(), otherApi = makeApi();
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(firstApi as never).mockReturnValueOnce(otherApi as never);
  const app = (active: boolean) => <><div data-testid="first"><TaskCacheProvider scope={first}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div><div data-testid="second"><TaskCacheProvider scope={other}><TaskDetailSessionProvider><DirectRecords active={active} /></TaskDetailSessionProvider></TaskCacheProvider></div></>;
  const view = render(app(true));
  await waitFor(() => expect(within(screen.getByTestId('first')).getByRole('button', { name: /Herdr/ })).toBeVisible());
  await waitFor(() => expect(within(screen.getByTestId('second')).getByRole('button', { name: /Herdr/ })).toBeVisible());
  view.rerender(app(false));
  firstApi.history.mockRejectedValueOnce(new ApiError('server', 403));
  fireEvent.click(within(screen.getByTestId('first')).getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(within(screen.getByTestId('second')).queryByRole('button', { name: /Herdr/ })).toBeNull());
  view.rerender(app(true));
  expect(within(screen.getByTestId('second')).queryByRole('button', { name: /Herdr/ })).toBeNull();
  expect(otherApi.history).toHaveBeenCalledTimes(1);
});

it('honors an in-flight Session denial after a same-history Task refresh', async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  let reject!: (error: Error) => void;
  const api = { history: vi.fn(() => new Promise<never>((_resolve, fail) => { reject = fail; })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() };
  vi.mocked(createTerminalSessionApi).mockReturnValue(api as never);
  let owner!: TaskDetailSessions;
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><DirectRecords onSessions={value => { owner = value; }} /></TaskDetailSessionProvider></TaskCacheProvider>);
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
  await act(async () => { owner.load(projectId, taskId, 1, 'automatic'); });
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(owner.snapshot(projectId, taskId).refreshing).toBe(false));
  await act(async () => reject(new ApiError('server', 403)));
  expect(await screen.findByRole('alert')).toHaveTextContent('You no longer have permission');
  expect(api.history).toHaveBeenCalledTimes(1);
});

it('continues a direct records read when optional cache admission changes', async () => {
  const capture = vi.spyOn(TaskDetailSessions.prototype, 'captureDirectHistoryTicket').mockRejectedValueOnce(new DOMException('Cache generation changed', 'AbortError'));
  try {
    const { api } = setup();
    expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
    expect(api.history).toHaveBeenCalledTimes(1);
  } finally { capture.mockRestore(); }
});

it('withdraws a direct-only peer during a same-account identity pause', async () => {
  TestChannel.channels = []; TestChannel.suspended = false; TestChannel.holdClear = false; TestChannel.held = []; TestChannel.holdHint = false; TestChannel.heldHints = []; vi.stubGlobal('BroadcastChannel', TestChannel);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  const first = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const other = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(first, other);
  const makeApi = () => ({ history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [item], nextCursor: null as string | null })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() });
  const firstApi = makeApi(), otherApi = makeApi();
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(firstApi as never).mockReturnValueOnce(otherApi as never);
  render(<><div data-testid="first"><TaskCacheProvider scope={first}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div><div data-testid="second"><TaskCacheProvider scope={other}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div></>);
  await waitFor(() => expect(within(screen.getByTestId('first')).getByRole('button', { name: /Herdr/ })).toBeVisible());
  await waitFor(() => expect(within(screen.getByTestId('second')).getByRole('button', { name: /Herdr/ })).toBeVisible());
  let reject!: (error: Error) => void;
  firstApi.history.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  fireEvent.click(within(screen.getByTestId('first')).getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(firstApi.history).toHaveBeenCalledTimes(2));
  const resume = pauseAuthRequests();
  try {
    await act(async () => reject(new ApiError('server', 403)));
    await waitFor(() => expect(within(screen.getByTestId('second')).queryByRole('button', { name: /Herdr/ })).toBeNull());
  } finally { resume(); }
});

it.each([403, 404])('retains direct records and peers on a different principal %i response', async status => {
  TestChannel.channels = []; TestChannel.suspended = false; TestChannel.holdClear = false; TestChannel.held = []; TestChannel.holdHint = false; TestChannel.heldHints = []; vi.stubGlobal('BroadcastChannel', TestChannel);
  const actual = await vi.importActual<typeof import('../src/api/terminal-sessions')>('../src/api/terminal-sessions');
  vi.mocked(createTerminalSessionApi).mockImplementation(actual.createTerminalSessionApi);
  let resume = () => {}; const mismatch = vi.fn(() => { resume = pauseAuthRequests(); });
  const first = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: mismatch });
  const peer = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(first, peer);
  const report = vi.spyOn(first, 'reportDirectSessionDenied');
  let finish!: (response: Response) => void; const held = new Promise<Response>(resolve => { finish = resolve; });
  let historyRequests = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/sessions?')) {
      historyRequests++;
      if (historyRequests === 3) return held;
      return wireResponse({ items: [item], nextCursor: 'next' }, { headers: viewerHeaders(TEST_VIEWER_ID) });
    }
    return wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) });
  }));
  const view = render(<><div data-testid="first"><TaskCacheProvider scope={first}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div><div data-testid="peer"><TaskCacheProvider scope={peer}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div></>);
  try {
    await waitFor(() => expect(within(screen.getByTestId('first')).getByRole('button', { name: /Herdr/ })).toBeVisible());
    await waitFor(() => expect(within(screen.getByTestId('peer')).getByRole('button', { name: /Herdr/ })).toBeVisible());
    fireEvent.click(within(screen.getByTestId('first')).getByRole('button', { name: 'Load earlier records' }));
    await waitFor(() => expect(historyRequests).toBe(3));
    const response = wireResponse({ error: { code: 'forbidden', message: 'Denied', requestId: 'other-user' } }, { status, headers: viewerHeaders('00000000-0000-4000-8000-000000000202') });
    await act(async () => { finish(response); await waitFor(() => expect(mismatch).toHaveBeenCalledOnce()); });
    expect(first.signal.aborted).toBe(false); expect(first.isInvalidated).toBe(false);
    expect(within(screen.getByTestId('first')).getByRole('button', { name: /Herdr/ })).toBeVisible();
    expect(within(screen.getByTestId('peer')).getByRole('button', { name: /Herdr/ })).toBeVisible();
    expect(report).not.toHaveBeenCalled();
  } finally { view.unmount(); resume(); vi.mocked(createTerminalSessionApi).mockReset(); }
});

it.each([401, 403, 404, 410])('withdraws direct records on a trusted %i response with an invalid body', async status => {
  const actual = await vi.importActual<typeof import('../src/api/terminal-sessions')>('../src/api/terminal-sessions');
  vi.mocked(createTerminalSessionApi).mockImplementation(actual.createTerminalSessionApi);
  const mismatch = vi.fn(), unauthorized = vi.fn(); const unsubscribe = subscribeUnauthorized(unauthorized);
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: mismatch }); scopes.push(scope);
  let historyRequests = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/sessions?')) {
      historyRequests++;
      if (historyRequests > 1) return new Response('invalid', { status, headers: status === 401 ? {} : viewerHeaders(TEST_VIEWER_ID) });
      return wireResponse({ items: [item], nextCursor: 'next' }, { headers: viewerHeaders(TEST_VIEWER_ID) });
    }
    return wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) });
  }));
  const view = render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider>);
  try {
    expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier records' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Herdr/ })).toBeNull());
    expect(screen.getByRole('alert')).toHaveTextContent('You no longer have permission');
    expect(mismatch).not.toHaveBeenCalled(); expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  } finally { view.unmount(); unsubscribe(); vi.mocked(createTerminalSessionApi).mockReset(); }
});

it.each([null, 'invalid'])('does not withdraw direct records for an untrusted 403 principal %s', async principal => {
  const actual = await vi.importActual<typeof import('../src/api/terminal-sessions')>('../src/api/terminal-sessions');
  vi.mocked(createTerminalSessionApi).mockImplementation(actual.createTerminalSessionApi);
  const mismatch = vi.fn(); const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: mismatch }); scopes.push(scope);
  const report = vi.spyOn(scope, 'reportDirectSessionDenied'); let historyRequests = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/sessions?')) {
      historyRequests++;
      if (historyRequests > 1) return new Response('invalid', { status: 403, headers: principal === null ? {} : { 'Daynight-User-ID': principal } });
      return wireResponse({ items: [item], nextCursor: 'next' }, { headers: viewerHeaders(TEST_VIEWER_ID) });
    }
    return wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) });
  }));
  const view = render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider>);
  try {
    expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier records' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The session could not be loaded or verified.');
    expect(screen.getByRole('button', { name: /Herdr/ })).toBeVisible();
    expect(mismatch).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled();
  } finally { view.unmount(); vi.mocked(createTerminalSessionApi).mockReset(); }
});

it('does not publish records after a peer silently replaces the user fence', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  const { scope, api } = setup();
  let finish!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  api.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
  const peer = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(peer);
  const signal = new AbortController().signal;
  await peer.beginTaskRead(projectId, taskId, 0, 0, signal);
  await peer.invalidateScope();
  await act(async () => finish({ items: [item], nextCursor: null }));
  await waitFor(() => expect(scope.isInvalidated || scope.signal.aborted).toBe(true));
  expect(screen.queryByRole('button', { name: /Herdr/ })).toBeNull();
  await scope.invalidateScope();
});

it('does not broadcast a stale denial after the cache generation changes', async () => {
  const { peer, ticket, signal } = await seedPeer();
  const { api } = setup();
  let reject!: (error: Error) => void;
  api.history.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
  const ownership = await readSessionHistoryOwnership(peer, ticket, taskId, signal);
  if (ownership.kind !== 'present') throw new Error('Expected cached records.');
  TestChannel.suspended = true;
  expect(await clearSessionHistory(peer, ticket, taskId, ownership.token, signal, ownership.paginationToken, ownership.leaseExpiresAt)).toBe(true);
  expect(await peer.rotateSessionHistoryGeneration(ticket, 1, signal)).toBe(true);
  const newer = await peer.beginSync(projectId, signal);
  const lease = await beginSessionHistoryRefresh(peer, newer, taskId, signal);
  if (lease === null || lease.kind !== 'lease') throw new Error('Expected a session refresh lease.');
  expect(await saveSessionHistory(peer, newer, taskId, { items: [second], nextCursor: null }, lease.token, signal)).toBe(true);
  TestChannel.suspended = false;
  const post = vi.spyOn(TestChannel.prototype, 'postMessage');
  try {
    await act(async () => reject(new ApiError('server', 403)));
    expect(await screen.findByRole('alert')).toHaveTextContent('You no longer have permission');
    expect(await readCachedSessionHistory(peer, newer, taskId, signal)).toMatchObject({ items: [second] });
    expect(post.mock.calls.some(([value]) => typeof value === 'object' && value !== null && 'directSessionDenied' in value)).toBe(false);
  } finally { post.mockRestore(); }
});

it('ignores a delayed durable denial after a newer direct records success', async () => {
  const { peer, ticket, signal } = await seedPeer();
  const { scope, api } = setup();
  expect(await screen.findByRole('button', { name: /2026-11-03.*Herdr/ })).toBeVisible();
  const ownership = await readSessionHistoryOwnership(peer, ticket, taskId, signal);
  if (ownership.kind !== 'present') throw new Error('Expected cached records.');
  TestChannel.holdClear = true;
  expect(await clearSessionHistory(peer, ticket, taskId, ownership.token, signal, ownership.paginationToken, ownership.leaseExpiresAt)).toBe(true);
  expect(TestChannel.held).toHaveLength(1);
  const lease = await beginSessionHistoryRefresh(peer, ticket, taskId, signal);
  if (lease === null || lease.kind !== 'lease') throw new Error('Expected a session refresh lease.');
  expect(await saveSessionHistory(peer, ticket, taskId, { items: [second], nextCursor: null }, lease.token, signal)).toBe(true);
  api.history.mockResolvedValueOnce({ items: [second], nextCursor: null });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
  const target = scope as unknown as { transaction(...args: unknown[]): Promise<unknown> };
  const original = target.transaction.bind(target);
  let verified = false;
  const transaction = vi.spyOn(target, 'transaction').mockImplementation(async (...args) => { const result = await original(...args); verified = true; return result; });
  try {
    await act(async () => { for (const channel of TestChannel.channels) channel.onmessage?.({ data: TestChannel.held[0] } as MessageEvent<unknown>); });
    await waitFor(() => expect(verified).toBe(true));
    expect(screen.getByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
  } finally { transaction.mockRestore(); }
});

it('does not withdraw a peer that acquired a persistent owner after a direct request started without a manifest', async () => {
  TestChannel.channels = []; TestChannel.suspended = false; TestChannel.holdClear = false; TestChannel.held = []; TestChannel.holdHint = false; TestChannel.heldHints = [];
  vi.stubGlobal('BroadcastChannel', TestChannel);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  const sender = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const receiver = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(sender, receiver);
  let reject!: (error: Error) => void;
  const senderApi = { history: vi.fn(() => new Promise<never>((_resolve, fail) => { reject = fail; })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() };
  const receiverApi = { history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [second], nextCursor: null as string | null })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() };
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(senderApi as never).mockReturnValueOnce(receiverApi as never);
  const app = (showReceiver: boolean) => <><div data-testid="first"><TaskCacheProvider scope={sender}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div>{showReceiver && <div data-testid="second"><TaskCacheProvider scope={receiver}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div>}</>;
  const view = render(app(false));
  await waitFor(() => expect(senderApi.history).toHaveBeenCalledTimes(1));
  const peer = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(peer);
  const signal = new AbortController().signal;
  await peer.applySync(await peer.beginSync(projectId, signal), taskSyncFromGraph(graphFixture([detailFixture(projectId, taskId)]), { epoch, versionForTask: () => 1n }), signal);
  const ticket = await peer.beginSync(projectId, signal);
  const lease = await beginSessionHistoryRefresh(peer, ticket, taskId, signal);
  if (lease === null || lease.kind !== 'lease') throw new Error('Expected a session refresh lease.');
  expect(await saveSessionHistory(peer, ticket, taskId, { items: [second], nextCursor: null }, lease.token, signal)).toBe(true);
  view.rerender(app(true));
  expect(await within(screen.getByTestId('second')).findByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
  await act(async () => reject(new ApiError('server', 403)));
  expect(await within(screen.getByTestId('first')).findByRole('alert')).toHaveTextContent('You no longer have permission');
  expect(await readCachedSessionHistory(peer, ticket, taskId, signal)).toMatchObject({ items: [second] });
  expect(within(screen.getByTestId('second')).getByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
});

it('withdraws a matching peer conservatively when its storage check fails', async () => {
  TestChannel.channels = []; TestChannel.suspended = false; TestChannel.holdClear = false; TestChannel.held = []; TestChannel.holdHint = false; TestChannel.heldHints = [];
  vi.stubGlobal('BroadcastChannel', TestChannel);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  const first = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const other = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(first, other);
  const makeApi = () => ({ history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [item], nextCursor: null as string | null })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() });
  const firstApi = makeApi(), otherApi = makeApi();
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(firstApi as never).mockReturnValueOnce(otherApi as never);
  render(<><div data-testid="first"><TaskCacheProvider scope={first}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div><div data-testid="second"><TaskCacheProvider scope={other}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div></>);
  await waitFor(() => expect(within(screen.getByTestId('first')).getByRole('button', { name: /Herdr/ })).toBeVisible());
  await waitFor(() => expect(within(screen.getByTestId('second')).getByRole('button', { name: /Herdr/ })).toBeVisible());
  const transaction = vi.spyOn(other as unknown as { transaction(...args: unknown[]): Promise<unknown> }, 'transaction').mockRejectedValueOnce(new Error('Storage unavailable'));
  try {
    firstApi.history.mockRejectedValueOnce(new ApiError('server', 403));
    fireEvent.click(within(screen.getByTestId('first')).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(within(screen.getByTestId('second')).queryByRole('button', { name: /Herdr/ })).toBeNull());
  } finally { transaction.mockRestore(); }
});

it('does not let its delayed denial notification cancel a successful retry', async () => {
  const { scope, api } = setup();
  expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
  let reject!: (error: Error) => void;
  api.history.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const target = scope as unknown as { transaction(...args: unknown[]): Promise<unknown> };
  const original = target.transaction.bind(target);
  let held = false;
  const observed = vi.fn(); scope.subscribe(observed);
  const transaction = vi.spyOn(target, 'transaction').mockImplementation(async (...args) => {
    if (!held && args[2] === true) { held = true; await gate; }
    return original(...args);
  });
  try {
    await act(async () => reject(new ApiError('server', 403)));
    expect(await screen.findByRole('alert')).toHaveTextContent('You no longer have permission');
    await waitFor(() => expect(held).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
    await act(async () => { release(); await Promise.resolve(); });
    await waitFor(() => expect(observed).toHaveBeenCalledWith(expect.objectContaining({ sessionHistoryUncertain: expect.objectContaining({ taskId }) })));
    expect(screen.getByRole('button', { name: /Herdr/ })).toBeVisible();
  } finally { release(); transaction.mockRestore(); }
});

it('withdraws another direct records owner in the same scope on denial', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const makeApi = () => ({ history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [item], nextCursor: null as string | null })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() });
  const firstApi = makeApi(), secondApi = makeApi();
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(firstApi as never).mockReturnValueOnce(secondApi as never);
  function SharedRecords() {
    const sessions = useTaskDetailSessions();
    useEffect(() => { sessions.openDirect(projectId, taskId); return () => sessions.releaseRead(projectId, taskId); }, [sessions]);
    const records = (name: string) => <div data-testid={name}><ManagedSessionRecords projectId={projectId} taskId={taskId} active direct>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords></div>;
    return <>{records('first')}{records('second')}</>;
  }
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><SharedRecords /></TaskDetailSessionProvider></TaskCacheProvider>);
  await waitFor(() => expect(within(screen.getByTestId('first')).getByRole('button', { name: /Herdr/ })).toBeVisible());
  await waitFor(() => expect(within(screen.getByTestId('second')).getByRole('button', { name: /Herdr/ })).toBeVisible());
  firstApi.history.mockRejectedValueOnce(new ApiError('server', 403));
  fireEvent.click(within(screen.getByTestId('first')).getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(within(screen.getByTestId('second')).queryByRole('button', { name: /Herdr/ })).toBeNull());
  expect(await within(screen.getByTestId('first')).findByRole('alert')).toHaveTextContent('You no longer have permission');
});

it('honors another owner denial while its own older cleanup is pending', async () => {
  await seedPeer();
  const { scope, api } = setup();
  expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
  let reject!: (error: Error) => void;
  api.history.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const target = scope as unknown as { sessionHistoryTransaction(...args: unknown[]): Promise<unknown> };
  const original = target.sessionHistoryTransaction.bind(target);
  let held = false;
  const transaction = vi.spyOn(target, 'sessionHistoryTransaction').mockImplementation(async (...args) => {
    if (!held) { held = true; await gate; }
    return original(...args);
  });
  try {
    await act(async () => reject(new ApiError('server', 403)));
    expect(await screen.findByRole('alert')).toHaveTextContent('You no longer have permission');
    await waitFor(() => expect(held).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
    const signal = new AbortController().signal;
    const fence = await scope.beginTaskRead(projectId, taskId, 0, 0, signal);
    await act(async () => { expect(scope.reportDirectSessionDenied(fence, epoch, false, Symbol('other-owner'))).toBe(true); });
    expect(screen.queryByRole('button', { name: /Herdr/ })).toBeNull();
  } finally { release(); transaction.mockRestore(); }
});

it('persists and broadcasts a task denial when cleared-marker capacity rotates', async () => {
  TestChannel.channels = []; TestChannel.suspended = false; TestChannel.holdClear = false; TestChannel.held = []; TestChannel.holdHint = false; TestChannel.heldHints = [];
  vi.stubGlobal('BroadcastChannel', TestChannel);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  const peer = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(peer);
  const signal = new AbortController().signal;
  await peer.applySync(await peer.beginSync(projectId, signal), taskSyncFromGraph(graphFixture([detailFixture(projectId, taskId)]), { epoch, versionForTask: () => 1n }), signal);
  const ticket = await peer.beginSync(projectId, signal);
  for (let n = 1; n <= 32; n++) {
    const id = `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    expect(await clearSessionHistory(peer, ticket, id, null, signal)).toBe(true);
  }
  const first = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const secondScope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(first, secondScope);
  const secondTicket = await secondScope.beginSync(projectId, signal);
  await secondScope.applySync(secondTicket, taskSyncFromGraph(graphFixture([detailFixture(projectId, taskId)]), { epoch, query: { epoch }, versionForTask: () => 1n }), signal);
  const makeApi = () => ({ history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [item], nextCursor: null as string | null })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() });
  const firstApi = makeApi(), secondApi = makeApi();
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(firstApi as never).mockReturnValueOnce(secondApi as never);
  render(<><div data-testid="first"><TaskCacheProvider scope={first}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div><div data-testid="second"><TaskCacheProvider scope={secondScope}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div></>);
  await waitFor(() => expect(within(screen.getByTestId('first')).getByRole('button', { name: /Herdr/ })).toBeVisible());
  await waitFor(() => expect(within(screen.getByTestId('second')).getByRole('button', { name: /Herdr/ })).toBeVisible());
  TestChannel.holdHint = true;
  firstApi.history.mockRejectedValueOnce(new ApiError('server', 403));
  fireEvent.click(within(screen.getByTestId('first')).getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(within(screen.getByTestId('second')).queryByRole('button', { name: /Herdr/ })).toBeNull());
  expect(TestChannel.heldHints.length).toBeGreaterThan(0);
  await act(async () => { for (const data of TestChannel.heldHints) for (const channel of TestChannel.channels) channel.onmessage?.({ data } as MessageEvent<unknown>); });
  expect(within(screen.getByTestId('second')).queryByRole('button', { name: /Herdr/ })).toBeNull();
  let current!: Awaited<ReturnType<typeof peer.beginSync>>;
  await waitFor(async () => { current = await peer.beginSync(projectId, signal); expect(current.cacheGeneration).not.toBe(ticket.cacheGeneration); });
  expect(await readSessionHistoryOwnership(peer, current, taskId, signal)).toMatchObject({ kind: 'present', cleared: true });
  const reopened = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(reopened);
  expect(await readCachedSessionHistory(reopened, await reopened.beginSync(projectId, signal), taskId, signal)).toBeNull();
});

it('ignores a delayed rotation marker after a newer Session success', async () => {
  TestChannel.channels = []; TestChannel.suspended = false; TestChannel.holdClear = false; TestChannel.held = []; TestChannel.holdHint = false; TestChannel.heldHints = [];
  vi.stubGlobal('BroadcastChannel', TestChannel);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) })));
  const peer = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(peer);
  const signal = new AbortController().signal;
  await peer.applySync(await peer.beginSync(projectId, signal), taskSyncFromGraph(graphFixture([detailFixture(projectId, taskId)]), { epoch, versionForTask: () => 1n }), signal);
  const original = await peer.beginSync(projectId, signal);
  for (let n = 1; n <= 32; n++) expect(await clearSessionHistory(peer, original, `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`, null, signal)).toBe(true);
  const sender = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const receiver = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(sender, receiver);
  const makeApi = () => ({ history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [item], nextCursor: null as string | null })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() });
  const senderApi = makeApi(), receiverApi = makeApi();
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(senderApi as never).mockReturnValueOnce(receiverApi as never);
  render(<><div data-testid="first"><TaskCacheProvider scope={sender}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div><div data-testid="second"><TaskCacheProvider scope={receiver}><TaskDetailSessionProvider><DirectRecords /></TaskDetailSessionProvider></TaskCacheProvider></div></>);
  await waitFor(() => expect(within(screen.getByTestId('first')).getByRole('button', { name: /Herdr/ })).toBeVisible());
  await waitFor(() => expect(within(screen.getByTestId('second')).getByRole('button', { name: /Herdr/ })).toBeVisible());
  TestChannel.holdClear = true;
  senderApi.history.mockRejectedValueOnce(new ApiError('server', 403));
  fireEvent.click(within(screen.getByTestId('first')).getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(TestChannel.held).toHaveLength(1));
  let current!: Awaited<ReturnType<typeof peer.beginSync>>;
  await waitFor(async () => { current = await peer.beginSync(projectId, signal); expect(current.cacheGeneration).not.toBe(original.cacheGeneration); });
  const lease = await beginSessionHistoryRefresh(peer, current, taskId, signal);
  if (lease === null || lease.kind !== 'lease') throw new Error('Expected a session refresh lease.');
  expect(await saveSessionHistory(peer, current, taskId, { items: [second], nextCursor: null }, lease.token, signal)).toBe(true);
  receiverApi.history.mockResolvedValueOnce({ items: [second], nextCursor: null });
  fireEvent.click(within(screen.getByTestId('second')).getByRole('button', { name: 'Refresh' }));
  expect(await within(screen.getByTestId('second')).findByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
  const target = receiver as unknown as { transaction(...args: unknown[]): Promise<unknown> };
  const transactionOriginal = target.transaction.bind(target);
  let verified = false;
  const transaction = vi.spyOn(target, 'transaction').mockImplementation(async (...args) => { const result = await transactionOriginal(...args); verified = true; return result; });
  try {
    await act(async () => { for (const channel of TestChannel.channels) channel.onmessage?.({ data: TestChannel.held[0] } as MessageEvent<unknown>); });
    await waitFor(() => expect(verified).toBe(true));
    expect(within(screen.getByTestId('second')).getByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
  } finally { transaction.mockRestore(); }
});

it('keeps session history readable during Step reconciliation and stops new reads after a parent failure', async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  let sessions!: TaskDetailSessions; let parentReads = 0;
  let resolveParent!: (response: Response) => void;
  const parent = new Promise<Response>(resolve => { resolveParent = resolve; });
  const step = { id: '00000001', title: 'Step', description: '', status: 'todo', createdAt: '2026-10-22T10:00:00Z', updatedAt: '2026-10-22T10:00:00Z' };
  const response = (value: unknown) => wireResponse(value, { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) });
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return Promise.resolve(response({ projectId, taskId, version: 2n, steps: [{ ...step, status: 'done' }] }));
    if (url.endsWith('/steps')) return Promise.resolve(response({ projectId, taskId, version: 1n, steps: [step] }));
    return ++parentReads === 1 ? Promise.resolve(response(detailFixture(projectId, taskId))) : parent;
  }));
  const api = { history: vi.fn(async () => ({ items: [item], nextCursor: null })), archive: vi.fn(), current: vi.fn(), channel: vi.fn(), command: vi.fn() };
  vi.mocked(createTerminalSessionApi).mockReturnValue(api as never);
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><DirectRecords onSessions={value => { sessions = value; }} /></TaskDetailSessionProvider></TaskCacheProvider>);
  await screen.findByRole('button', { name: /Herdr/ });
  const unsubscribe = sessions.subscribeSteps(projectId, taskId, () => {}); sessions.loadSteps(projectId, taskId);
  await waitFor(() => expect(sessions.canSetStepStatus(projectId, taskId)).toBe(true));
  act(() => sessions.setStepStatus(projectId, taskId, '00000001', 'done', 1n));
  await waitFor(() => expect(sessions.snapshot(projectId, taskId).mutation).toMatchObject({ phase: 'confirmed', reconciling: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
  await act(async () => resolveParent(wireResponse({ error: { code: 'internal_error', message: 'unavailable', requestId: 'failed' } }, { status: 503, headers: viewerHeaders(TEST_VIEWER_ID) })));
  await waitFor(() => expect(sessions.captureDirectSessionQualification(projectId, taskId)).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(api.history).toHaveBeenCalledTimes(2);
  unsubscribe();
});
