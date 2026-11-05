import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocaleRender } from './helpers/renderWithLocale';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';
import { createTerminalSessionApi } from '../src/api/terminal-sessions';
import type { SessionHistoryItem } from '../src/api/terminal-sessions';
import { ApiError } from '../src/api/client';
import { ManagedSessionRecords } from '../src/features/task-agent-session/TaskSessionHost';
import { beginSessionHistoryRefresh, saveSessionHistory } from '../src/features/task-agent-session/session-history-cache';
import * as historyCache from '../src/features/task-agent-session/session-history-cache';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';

vi.mock('../src/api/terminal-sessions', async (original) => ({ ...(await original<typeof import('../src/api/terminal-sessions')>()), createTerminalSessionApi: vi.fn() }));
vi.mock('../src/features/task-agent-session/TaskAgentSession', () => ({ TaskAgentSession: () => null }));
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const item: SessionHistoryItem = { sessionId: '00000004-1111-4111-8111-111111111111', claimId: '00000003-1111-4111-8111-111111111111', executionGeneration: '1', agentControlMode: 'herdr', contentKind: 'terminal_recording', createdAt: '2026-11-03T10:00:00Z', endedAt: '2026-11-03T10:01:00Z', archive: { state: 'pending', sha256: null, byteLength: null, completeness: null } };
const second = { ...item, sessionId: '00000005-1111-4111-8111-111111111111', createdAt: '2026-11-02T10:00:00Z' };
const sig = () => new AbortController().signal;
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
async function seed() {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const graph = graphFixture([detailFixture(projectId, taskId)]);
  await scope.applySync(await scope.beginSync(projectId, sig()), taskSyncFromGraph(graph, { versionForTask: () => 1n }), sig());
  return scope;
}
function fixture() {
  const api = { history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [item], nextCursor: null as string | null })), archive: vi.fn(async () => ({ status: { payload: { state: 'pending' } }, archive: null })), current: vi.fn(), channel: vi.fn(), command: vi.fn() };
  vi.mocked(createTerminalSessionApi).mockReturnValue(api as never); return api;
}
const render = createLocaleRender('en');
const records = (label: string) => <div key={label} data-testid={label}><ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords></div>;
afterEach(() => { scopes.splice(0).forEach(scope => scope.dispose()); });

it('coalesces two visible consumers and publishes the saved response to the waiter', async () => {
  const scope = await seed(); const api = fixture();
  let finish!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  api.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<TaskCacheProvider scope={scope}>{records('first')}{records('second')}</TaskCacheProvider>);
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(within(screen.getByTestId('second')).getByRole('status')).toBeVisible());
  await act(async () => finish({ items: [item], nextCursor: null }));
  expect(await within(screen.getByTestId('first')).findByRole('button', { name: /Herdr/ })).toBeVisible();
  expect(await within(screen.getByTestId('second')).findByRole('button', { name: /Herdr/ })).toBeVisible();
  expect(api.history).toHaveBeenCalledTimes(1);
});

it('allows a waiting consumer to take over after the owner unmounts', async () => {
  const scope = await seed(); const api = fixture();
  api.history.mockImplementationOnce(() => new Promise(() => {}));
  const view = render(<TaskCacheProvider scope={scope}>{records('first')}</TaskCacheProvider>);
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
  view.rerender(<TaskCacheProvider scope={scope}>{records('first')}{records('second')}</TaskCacheProvider>);
  await waitFor(() => expect(within(screen.getByTestId('second')).getByRole('status')).toBeVisible());
  expect(api.history).toHaveBeenCalledTimes(1);
  view.rerender(<TaskCacheProvider scope={scope}>{records('second')}</TaskCacheProvider>);
  expect(await within(screen.getByTestId('second')).findByRole('button', { name: /Herdr/ })).toBeVisible();
  expect(api.history).toHaveBeenCalledTimes(2);
});

it('exposes failure to the waiter and allows a manual retry', async () => {
  const scope = await seed(); const api = fixture();
  let fail!: (cause: Error) => void;
  api.history.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  render(<TaskCacheProvider scope={scope}>{records('first')}{records('second')}</TaskCacheProvider>);
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(within(screen.getByTestId('second')).getByRole('status')).toBeVisible());
  await act(async () => fail(new Error('offline')));
  expect(await within(screen.getByTestId('second')).findByRole('alert')).toBeVisible();
  fireEvent.click(within(screen.getByTestId('second')).getByRole('button', { name: 'Refresh' }));
  expect(await within(screen.getByTestId('second')).findByRole('button', { name: /Herdr/ })).toBeVisible();
  expect(api.history).toHaveBeenCalledTimes(2);
});

it('does not retry a persistent denial automatically or restore the previous selection on manual recovery', async () => {
  const scope = await seed(); const api = fixture();
  api.history.mockResolvedValueOnce({ items: [item], nextCursor: null }).mockRejectedValueOnce(new ApiError('server', 403)).mockResolvedValueOnce({ items: [item], nextCursor: null });
  render(<TaskCacheProvider scope={scope}>{records('only')}</TaskCacheProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Herdr/ }));
  await screen.findByText('Recording is waiting to be archived.');
  const refresh = screen.getAllByRole('button', { name: 'Refresh' })[0]!;
  await waitFor(() => expect(refresh).toBeEnabled());
  fireEvent.click(refresh);
  expect(await screen.findByRole('alert')).toHaveTextContent('You no longer have permission');
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(api.history).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: 'Close recording' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('button', { name: /Herdr/ })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.queryByRole('button', { name: 'Close recording' })).toBeNull();
  expect(api.history).toHaveBeenCalledTimes(3);
});

it('discards an old continuation response when another refresh changes the cache token', async () => {
  const scope = await seed(); const api = fixture();
  let finish!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  api.history.mockResolvedValueOnce({ items: [item], nextCursor: 'next' }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<TaskCacheProvider scope={scope}>{records('only')}</TaskCacheProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Load earlier records' }));
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
  const ticket = await scope.beginSync(projectId, sig());
  const lease = (await beginSessionHistoryRefresh(scope, ticket, taskId, sig()))!;
  if (lease.kind !== 'lease') throw new Error('Expected a history lease.');
  expect(lease.acquired).toBe(true);
  await act(async () => { expect(await saveSessionHistory(scope, ticket, taskId, { items: [], nextCursor: null }, lease.token, sig())).toBe(true); });
  await act(async () => finish({ items: [second], nextCursor: null }));
  expect(screen.queryByRole('button', { name: /2026-11-02.*Herdr/ })).toBeNull();
});

class TestChannel {
  static channels: TestChannel[] = [];
  static heldClear: unknown[] = [];
  static holdClear = false;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor() { TestChannel.channels.push(this); }
  postMessage(value: unknown) {
    if (TestChannel.holdClear && typeof value === 'object' && value !== null && 'sessionHistoryCleared' in value) {
      TestChannel.heldClear.push(value); return;
    }
    for (const channel of TestChannel.channels) if (channel !== this) queueMicrotask(() => channel.onmessage?.({ data: value } as MessageEvent<unknown>));
  }
  close() { TestChannel.channels = TestChannel.channels.filter(channel => channel !== this); }
  static deliver(value: unknown) { for (const channel of TestChannel.channels) channel.onmessage?.({ data: value } as MessageEvent<unknown>); }
}
function channelSetup() {
  TestChannel.channels = []; TestChannel.heldClear = []; TestChannel.holdClear = false;
  vi.stubGlobal('BroadcastChannel', TestChannel);
}
async function anotherScope() {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const ticket = await scope.beginSync(projectId, sig());
  const graph = graphFixture([detailFixture(projectId, taskId)]);
  await scope.applySync(ticket, taskSyncFromGraph(graph, { versionForTask: () => 1n, query: { epoch: ticket.epoch! } }), sig());
  return scope;
}
const surface = (scope: ReturnType<typeof createTaskCacheScope>, name: string) => <TaskCacheProvider key={name} scope={scope}>{records(name)}</TaskCacheProvider>;

it('prevents an old cursor from appending while another scope refreshes the first page', async () => {
  channelSetup(); const first = await seed(); const secondScope = await anotherScope();
  const apiA = fixture(); apiA.history.mockResolvedValueOnce({ items: [item], nextCursor: 'next' });
  const apiB = { ...apiA, history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [second], nextCursor: null as string | null })) };
  let finish!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  apiB.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(apiA as never).mockReturnValueOnce(apiB as never);
  const view = render(<>{surface(first, 'first')}</>);
  await screen.findByRole('button', { name: 'Load earlier records' });
  view.rerender(<>{surface(first, 'first')}{surface(secondScope, 'second')}</>);
  await waitFor(() => expect(apiB.history).toHaveBeenCalledTimes(1));
  fireEvent.click(within(screen.getByTestId('first')).getByRole('button', { name: 'Load earlier records' }));
  await act(async () => finish({ items: [second], nextCursor: null }));
  await waitFor(() => expect(within(screen.getByTestId('first')).getByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible());
  expect(apiA.history.mock.calls.every(([cursor]) => cursor === null)).toBe(true);
  expect(within(screen.getByTestId('first')).queryByRole('button', { name: /2026-11-03.*Herdr/ })).toBeNull();
});

it('allows a previously denied scope to follow another scope recovery', async () => {
  channelSetup(); const first = await seed(); const secondScope = await anotherScope();
  const apiA = fixture();
  const apiB = { ...apiA, history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [item], nextCursor: null as string | null })) };
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(apiA as never).mockReturnValueOnce(apiB as never);
  const view = render(<>{surface(first, 'first')}</>);
  await within(screen.getByTestId('first')).findByRole('button', { name: /Herdr/ });
  view.rerender(<>{surface(first, 'first')}{surface(secondScope, 'second')}</>);
  await within(screen.getByTestId('second')).findByRole('button', { name: /Herdr/ });
  await waitFor(() => expect(within(screen.getByTestId('second')).getByRole('button', { name: 'Refresh' })).toBeEnabled());
  apiA.history.mockRejectedValueOnce(new ApiError('server', 403));
  fireEvent.click(within(screen.getByTestId('first')).getByRole('button', { name: 'Refresh' }));
  await within(screen.getByTestId('first')).findByRole('alert');
  await within(screen.getByTestId('second')).findByRole('alert');
  let finish!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  apiB.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(within(screen.getByTestId('second')).getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(apiB.history).toHaveBeenCalledTimes(2));
  fireEvent.click(within(screen.getByTestId('first')).getByRole('button', { name: 'Refresh' }));
  await act(async () => finish({ items: [second], nextCursor: null }));
  expect(await within(screen.getByTestId('first')).findByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
  await waitFor(() => expect(within(screen.getByTestId('first')).queryByRole('alert')).toBeNull());
});

it('does not cancel a local recovery when a delayed clear arrives from another scope', async () => {
  channelSetup(); const first = await seed(); const secondScope = await anotherScope();
  const apiA = fixture();
  const apiB = { ...apiA, history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [item], nextCursor: null as string | null })) };
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(apiA as never).mockReturnValueOnce(apiB as never);
  const view = render(<>{surface(first, 'first')}</>);
  await within(screen.getByTestId('first')).findByRole('button', { name: /Herdr/ });
  view.rerender(<>{surface(first, 'first')}{surface(secondScope, 'second')}</>);
  await waitFor(() => expect(within(screen.getByTestId('second')).getByRole('button', { name: 'Refresh' })).toBeEnabled());
  TestChannel.holdClear = true; apiA.history.mockRejectedValueOnce(new ApiError('server', 403));
  fireEvent.click(within(screen.getByTestId('first')).getByRole('button', { name: 'Refresh' }));
  await within(screen.getByTestId('first')).findByRole('alert');
  expect(TestChannel.heldClear).toHaveLength(1);
  let finish!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  apiB.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(within(screen.getByTestId('second')).getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(apiB.history).toHaveBeenCalledTimes(2));
  const observed = vi.fn(); secondScope.subscribe(observed);
  await act(async () => { TestChannel.deliver(TestChannel.heldClear[0]); });
  await waitFor(() => expect(observed).toHaveBeenCalledWith(expect.objectContaining({ sessionHistoryCleared: expect.objectContaining({ taskId }) })));
  await within(screen.getByTestId('second')).findByRole('alert');
  expect(apiB.history.mock.calls[1]![1].aborted).toBe(false);
  await act(async () => finish({ items: [second], nextCursor: null }));
  expect(await within(screen.getByTestId('second')).findByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
  expect(apiB.history).toHaveBeenCalledTimes(2);
});

it('waits for the project cache admission on a cold start before requesting history', async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const api = fixture(); render(surface(scope, 'only'));
  await screen.findByRole('status');
  expect(api.history).not.toHaveBeenCalled();
  const ticket = await scope.beginSync(projectId, sig());
  await act(async () => { await scope.applySync(ticket, taskSyncFromGraph(graphFixture([detailFixture(projectId, taskId)]), { versionForTask: () => 1n }), sig()); });
  expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
  expect(api.history).toHaveBeenCalledTimes(1);
});

it('withdraws both scopes after a failed denial marker, rejects an unreserved late result, and recovers on explicit retry', async () => {
  channelSetup(); const first = await seed(); const secondScope = await anotherScope();
  const apiA = fixture();
  const apiB = { ...apiA, history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [second], nextCursor: null as string | null })) };
  let finishOld!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  apiB.history.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(apiA as never).mockReturnValueOnce(apiB as never);
  const view = render(<>{surface(first, 'first')}</>);
  await within(screen.getByTestId('first')).findByRole('button', { name: /Herdr/ });
  await waitFor(() => expect(within(screen.getByTestId('first')).getByRole('button', { name: 'Refresh' })).toBeEnabled());
  const unavailable = vi.spyOn(secondScope, 'sessionHistoryTransaction').mockRejectedValue(new Error('Injected cache read failure'));
  view.rerender(<>{surface(first, 'first')}{surface(secondScope, 'second')}</>);
  await waitFor(() => expect(apiB.history).toHaveBeenCalledTimes(1));
  unavailable.mockRestore();
  const { IDBObjectStore } = await import('fake-indexeddb');
  const put = IDBObjectStore.prototype.put;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    const value = args[0] as { clearedToken?: string | null };
    if (this.name === 'sessionHistory' && value.clearedToken) throw new DOMException('Injected quota failure', 'QuotaExceededError');
    return put.apply(this, args);
  });
  apiA.history.mockRejectedValueOnce(new ApiError('server', 403));
  fireEvent.click(within(screen.getByTestId('first')).getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(apiA.history).toHaveBeenCalledTimes(2));
  await within(screen.getByTestId('first')).findByRole('alert');
  await within(screen.getByTestId('second')).findByRole('alert');
  expect(within(screen.getByTestId('first')).queryByRole('button', { name: /Herdr/ })).toBeNull();
  fault.mockRestore();
  await act(async () => finishOld({ items: [second], nextCursor: null }));
  expect(within(screen.getByTestId('second')).queryByRole('button', { name: /Herdr/ })).toBeNull();
  const retry = within(screen.getByTestId('first')).getByRole('button', { name: 'Refresh' });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  expect(await within(screen.getByTestId('first')).findByRole('button', { name: /Herdr/ })).toBeVisible();
  await waitFor(() => expect(within(screen.getByTestId('first')).queryByRole('alert')).toBeNull());
});

it('withdraws another scope when storage opening fails before an unreserved 403 and rejects the older response', async () => {
  channelSetup(); const first = await seed(); const secondScope = await anotherScope();
  const apiA = fixture();
  const apiB = { ...apiA, history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [second], nextCursor: null as string | null })) };
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(apiA as never).mockReturnValueOnce(apiB as never);
  const view = render(<>{surface(first, 'first')}</>);
  await within(screen.getByTestId('first')).findByRole('button', { name: /Herdr/ });
  const refresh = within(screen.getByTestId('first')).getByRole('button', { name: 'Refresh' });
  await waitFor(() => expect(refresh).toBeEnabled());
  let finishOld!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  apiA.history.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  fireEvent.click(refresh);
  await waitFor(() => expect(apiA.history).toHaveBeenCalledTimes(2));
  const events = vi.fn(); first.subscribe(events);
  const failedOpen = vi.spyOn(secondScope, 'beginSync').mockRejectedValue(new Error('Injected database open failure'));
  apiB.history.mockRejectedValueOnce(new ApiError('server', 403));
  view.rerender(<>{surface(first, 'first')}{surface(secondScope, 'second')}</>);
  await waitFor(() => expect(apiB.history).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ sessionHistoryUncertain: { taskId, expectedToken: null, unbound: true } })));
  await within(screen.getByTestId('first')).findByRole('alert');
  expect(within(screen.getByTestId('first')).queryByRole('button', { name: /Herdr/ })).toBeNull();
  await act(async () => finishOld({ items: [second], nextCursor: null }));
  expect(within(screen.getByTestId('first')).queryByRole('button', { name: /Herdr/ })).toBeNull();
  failedOpen.mockRestore();
});

async function waitForCompleteEmpty(scope: ReturnType<typeof createTaskCacheScope>) {
  const ticket = await scope.beginSync(projectId, sig());
  await waitFor(async () => {
    const row = await scope.sessionHistoryTransaction(ticket, sig(), store => store.get([scope.userId, projectId, taskId]));
    expect((row as unknown as { confirmedCompleteEmpty?: boolean } | undefined)?.confirmedCompleteEmpty).toBe(true);
  });
}

it('keeps a fully paginated empty directory hidden through remount, delayed cache read and refresh', async () => {
  const scope = await seed(); const api = fixture();
  api.history.mockResolvedValueOnce({ items: [], nextCursor: 'next' }).mockResolvedValueOnce({ items: [], nextCursor: null });
  const view = render(surface(scope, 'only'));
  fireEvent.click(await screen.findByRole('button', { name: 'Load earlier records' }));
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull());
  await waitForCompleteEmpty(scope);
  view.unmount();
  const reopened = await anotherScope();
  let releaseCache!: () => void;
  const gate = new Promise<void>(resolve => { releaseCache = resolve; });
  const transaction = reopened.sessionHistoryTransaction.bind(reopened);
  const delayed = vi.spyOn(reopened, 'sessionHistoryTransaction').mockImplementationOnce((async (...args: Parameters<typeof transaction>) => {
    await gate; return transaction(...args);
  }) as typeof reopened.sessionHistoryTransaction);
  let finishRefresh!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  api.history.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
  render(surface(reopened, 'reopened'));
  await waitFor(() => expect(delayed).toHaveBeenCalled());
  expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull();
  await act(async () => releaseCache());
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(3));
  expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull();
  await act(async () => finishRefresh({ items: [], nextCursor: null }));
  expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull();
});

it('revalidates later pages when a confirmed empty directory still has an empty first page with a cursor', async () => {
  const scope = await seed(); const api = fixture();
  api.history.mockResolvedValueOnce({ items: [], nextCursor: 'next' }).mockResolvedValueOnce({ items: [], nextCursor: null });
  const view = render(surface(scope, 'only'));
  fireEvent.click(await screen.findByRole('button', { name: 'Load earlier records' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull());
  await waitForCompleteEmpty(scope);
  view.unmount();
  const reopened = await anotherScope();
  let finishFirst!: (value: { items: SessionHistoryItem[]; nextCursor: string }) => void;
  let finishLater!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  api.history.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishLater = resolve; }));
  render(surface(reopened, 'reopened'));
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(3));
  expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull();
  await act(async () => finishFirst({ items: [], nextCursor: 'next' }));
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(4));
  expect(api.history.mock.calls[3]![0]).toBe('next');
  expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull();
  await act(async () => finishLater({ items: [second], nextCursor: null }));
  expect(await screen.findByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
});

it('publishes a newly discovered later-page recording to both consumers of a confirmed empty directory', async () => {
  channelSetup(); const first = await seed(); const secondScope = await anotherScope(); const api = fixture();
  api.history.mockResolvedValueOnce({ items: [], nextCursor: 'next' }).mockResolvedValueOnce({ items: [], nextCursor: null });
  const initial = render(surface(first, 'initial'));
  fireEvent.click(await screen.findByRole('button', { name: 'Load earlier records' }));
  await waitForCompleteEmpty(first); initial.unmount();
  let finishFirst!: (value: { items: SessionHistoryItem[]; nextCursor: string }) => void;
  let finishLater!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  api.history.mockImplementation(async cursor => cursor === null ? { items: [], nextCursor: 'next' } : { items: [second], nextCursor: null });
  api.history.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishLater = resolve; }));
  const leases = vi.spyOn(historyCache, 'beginSessionHistoryRefresh');
  render(<>{surface(first, 'first')}{surface(secondScope, 'second')}</>);
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(3));
  await waitFor(async () => {
    const results = await Promise.all(leases.mock.results.map(result => result.value));
    expect(results.some(result => result?.kind === 'lease' && !result.acquired)).toBe(true);
  });
  expect(screen.queryAllByRole('region', { name: 'Session recordings' })).toHaveLength(0);
  await act(async () => finishFirst({ items: [], nextCursor: 'next' }));
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(4));
  expect(screen.queryAllByRole('region', { name: 'Session recordings' })).toHaveLength(0);
  await act(async () => finishLater({ items: [second], nextCursor: null }));
  expect(await within(screen.getByTestId('first')).findByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
  expect(await within(screen.getByTestId('second')).findByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
});

it('discards a continuation when a newer token wins before the empty-proof transaction', async () => {
  channelSetup(); const first = await seed(); const other = await anotherScope(); const api = fixture();
  api.history.mockResolvedValueOnce({ items: [], nextCursor: 'next' });
  let finishOld!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  api.history.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  render(surface(first, 'first'));
  fireEvent.click(await screen.findByRole('button', { name: 'Load earlier records' }));
  await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
  const original = historyCache.setSessionHistoryCompleteEmpty;
  let releaseProof!: () => void;
  const gate = new Promise<void>(resolve => { releaseProof = resolve; });
  const pending = vi.spyOn(historyCache, 'setSessionHistoryCompleteEmpty').mockImplementationOnce(async (...args) => { await gate; return original(...args); });
  await act(async () => finishOld({ items: [second], nextCursor: null }));
  await waitFor(() => expect(pending).toHaveBeenCalled());
  const ticket = await other.beginSync(projectId, sig());
  const lease = (await beginSessionHistoryRefresh(other, ticket, taskId, sig()))!;
  if (lease.kind !== 'lease' || !lease.acquired) throw new Error('Expected the newer refresh lease.');
  await act(async () => { expect(await saveSessionHistory(other, ticket, taskId, { items: [item], nextCursor: null }, lease.token, sig())).toBe(true); });
  await act(async () => releaseProof());
  expect(await screen.findByRole('button', { name: /2026-11-03.*Herdr/ })).toBeVisible();
  expect(screen.queryByRole('button', { name: /2026-11-02.*Herdr/ })).toBeNull();
});

it('discards an older nonempty continuation after another consumer confirms the same inventory empty', async () => {
  channelSetup(); const first = await seed(); const secondScope = await anotherScope();
  const apiA = fixture();
  apiA.history.mockImplementation(async cursor => cursor === null ? { items: [], nextCursor: 'next' } : { items: [], nextCursor: null });
  let finishOld!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  apiA.history.mockImplementationOnce(async () => ({ items: [], nextCursor: 'next' }))
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const apiB = { ...apiA, history: vi.fn(async (cursor: string | null, _signal: AbortSignal) => cursor === null ? { items: [] as SessionHistoryItem[], nextCursor: 'next' as string | null } : { items: [], nextCursor: null }) };
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(apiA as never).mockReturnValueOnce(apiB as never);
  const view = render(<>{surface(first, 'first')}</>);
  await within(screen.getByTestId('first')).findByRole('button', { name: 'Load earlier records' });
  view.rerender(<>{surface(first, 'first')}{surface(secondScope, 'second')}</>);
  const secondMore = await within(screen.getByTestId('second')).findByRole('button', { name: 'Load earlier records' });
  await waitFor(() => expect(secondMore).toBeEnabled());
  const firstMore = within(screen.getByTestId('first')).getByRole('button', { name: 'Load earlier records' });
  await waitFor(() => expect(firstMore).toBeEnabled());
  fireEvent.click(firstMore);
  await waitFor(() => expect(apiA.history).toHaveBeenCalledTimes(2));
  fireEvent.click(secondMore);
  await waitFor(() => expect(apiB.history).toHaveBeenCalledWith('next', expect.any(AbortSignal)));
  await waitForCompleteEmpty(secondScope);
  await act(async () => finishOld({ items: [second], nextCursor: null }));
  await waitFor(() => expect(within(screen.getByTestId('first')).queryByRole('region', { name: 'Session recordings' })).toBeNull());
  expect(within(screen.getByTestId('second')).queryByRole('region', { name: 'Session recordings' })).toBeNull();
  expect(screen.queryByRole('button', { name: /2026-11-02.*Herdr/ })).toBeNull();
});

it('keeps the newer continuation running and offers retry when concurrent pagination supersedes the older request', async () => {
  channelSetup(); const first = await seed(); const secondScope = await anotherScope();
  const apiA = fixture();
  apiA.history.mockImplementation(async cursor => cursor === null ? { items: [item], nextCursor: 'next' } : { items: [second], nextCursor: null });
  const apiB = { ...apiA, history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [item], nextCursor: 'next' as string | null })) };
  let finishOld!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  let finishNew!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  apiA.history.mockResolvedValueOnce({ items: [item], nextCursor: 'next' })
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  apiB.history.mockResolvedValueOnce({ items: [item], nextCursor: 'next' })
    .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(apiA as never).mockReturnValueOnce(apiB as never);
  const view = render(<>{surface(first, 'first')}</>);
  await within(screen.getByTestId('first')).findByRole('button', { name: 'Load earlier records' });
  view.rerender(<>{surface(first, 'first')}{surface(secondScope, 'second')}</>);
  const firstMore = within(screen.getByTestId('first')).getByRole('button', { name: 'Load earlier records' });
  const secondMore = await within(screen.getByTestId('second')).findByRole('button', { name: 'Load earlier records' });
  await waitFor(() => { expect(firstMore).toBeEnabled(); expect(secondMore).toBeEnabled(); });
  fireEvent.click(firstMore); await waitFor(() => expect(apiA.history).toHaveBeenCalledTimes(2));
  fireEvent.click(secondMore); await waitFor(() => expect(apiB.history).toHaveBeenCalledTimes(2));
  await act(async () => finishOld({ items: [second], nextCursor: null }));
  expect(await within(screen.getByTestId('first')).findByRole('alert')).toBeVisible();
  expect(apiA.history).toHaveBeenCalledTimes(2);
  expect(apiB.history.mock.calls[1]![1].aborted).toBe(false);
  await act(async () => finishNew({ items: [second], nextCursor: null }));
  expect(await within(screen.getByTestId('second')).findByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
  const retry = within(screen.getByTestId('first')).getByRole('button', { name: 'Load earlier records' });
  expect(retry).toBeEnabled(); fireEvent.click(retry);
  expect(await within(screen.getByTestId('first')).findByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
  await waitFor(() => expect(within(screen.getByTestId('first')).queryByRole('alert')).toBeNull());
});

it('ignores a stale continuation denial after another scope successfully loads a newer page', async () => {
  channelSetup(); const first = await seed(); const secondScope = await anotherScope();
  const apiA = fixture();
  apiA.history.mockImplementation(async cursor => cursor === null ? { items: [item], nextCursor: 'next' } : { items: [second], nextCursor: null });
  const apiB = { ...apiA, history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [item], nextCursor: 'next' as string | null })) };
  let rejectOld!: (reason: Error) => void;
  let finishNew!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  apiA.history.mockResolvedValueOnce({ items: [item], nextCursor: 'next' })
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  apiB.history.mockResolvedValueOnce({ items: [item], nextCursor: 'next' })
    .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(apiA as never).mockReturnValueOnce(apiB as never);
  const view = render(<>{surface(first, 'first')}</>);
  await within(screen.getByTestId('first')).findByRole('button', { name: 'Load earlier records' });
  view.rerender(<>{surface(first, 'first')}{surface(secondScope, 'second')}</>);
  const firstMore = within(screen.getByTestId('first')).getByRole('button', { name: 'Load earlier records' });
  const secondMore = await within(screen.getByTestId('second')).findByRole('button', { name: 'Load earlier records' });
  await waitFor(() => { expect(firstMore).toBeEnabled(); expect(secondMore).toBeEnabled(); });
  fireEvent.click(firstMore); await waitFor(() => expect(apiA.history).toHaveBeenCalledTimes(2));
  fireEvent.click(secondMore); await waitFor(() => expect(apiB.history).toHaveBeenCalledTimes(2));
  await act(async () => finishNew({ items: [second], nextCursor: null }));
  expect(await within(screen.getByTestId('second')).findByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
  await act(async () => rejectOld(new ApiError('server', 403)));
  await waitFor(() => expect(within(screen.getByTestId('first')).getByRole('button', { name: 'Load earlier records' })).toBeEnabled());
  expect(within(screen.getByTestId('second')).getByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
  expect(screen.queryByText('You no longer have permission to access this Session.')).toBeNull();
  expect(within(screen.getByTestId('first')).getByRole('button', { name: /2026-11-03.*Herdr/ })).toBeVisible();
});

it('keeps a newer continuation in flight when the older continuation returns 403', async () => {
  channelSetup(); const first = await seed(); const secondScope = await anotherScope();
  const apiA = fixture();
  apiA.history.mockImplementation(async cursor => cursor === null ? { items: [item], nextCursor: 'next' } : { items: [second], nextCursor: null });
  const apiB = { ...apiA, history: vi.fn(async (_cursor: string | null, _signal: AbortSignal) => ({ items: [item], nextCursor: 'next' as string | null })) };
  let rejectOld!: (reason: Error) => void;
  let finishNew!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
  apiA.history.mockResolvedValueOnce({ items: [item], nextCursor: 'next' })
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  apiB.history.mockResolvedValueOnce({ items: [item], nextCursor: 'next' })
    .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
  vi.mocked(createTerminalSessionApi).mockReturnValueOnce(apiA as never).mockReturnValueOnce(apiB as never);
  const view = render(<>{surface(first, 'first')}</>);
  await within(screen.getByTestId('first')).findByRole('button', { name: 'Load earlier records' });
  view.rerender(<>{surface(first, 'first')}{surface(secondScope, 'second')}</>);
  const firstMore = within(screen.getByTestId('first')).getByRole('button', { name: 'Load earlier records' });
  const secondMore = await within(screen.getByTestId('second')).findByRole('button', { name: 'Load earlier records' });
  await waitFor(() => { expect(firstMore).toBeEnabled(); expect(secondMore).toBeEnabled(); });
  fireEvent.click(firstMore); await waitFor(() => expect(apiA.history).toHaveBeenCalledTimes(2));
  fireEvent.click(secondMore); await waitFor(() => expect(apiB.history).toHaveBeenCalledTimes(2));
  await act(async () => rejectOld(new ApiError('server', 403)));
  expect(await within(screen.getByTestId('first')).findByRole('alert')).toBeVisible();
  expect(screen.queryByText('You no longer have permission to access this Session.')).toBeNull();
  expect(apiA.history).toHaveBeenCalledTimes(2);
  expect(apiB.history.mock.calls[1]![1].aborted).toBe(false);
  await act(async () => finishNew({ items: [second], nextCursor: null }));
  expect(await within(screen.getByTestId('second')).findByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
});
