import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createLocaleRender } from './helpers/renderWithLocale';
import { ManagedSessionRecords, TaskSessionHost } from '../src/features/task-agent-session/TaskSessionHost';
import { TaskDetailReading } from '../src/features/task-detail/TaskDetailReading';
import { createTerminalSessionApi } from '../src/api/terminal-sessions';
import type { SessionHistoryItem } from '../src/api/terminal-sessions';
import { ApiError } from '../src/api/client';
import { beginSessionHistoryRefresh, readCachedSessionHistory, saveSessionHistory } from '../src/features/task-agent-session/session-history-cache';
import { createTaskCacheScope, TaskCacheProvider, TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
vi.mock('../src/api/terminal-sessions', () => ({ createTerminalSessionApi: vi.fn(), parseSessionHistory: (value: unknown) => value }));
vi.mock('../src/features/task-agent-session/session-history-cache', () => ({ beginSessionHistoryRefresh: vi.fn(), readCachedSessionHistory: vi.fn(), saveSessionHistory: vi.fn(), beginSessionHistoryPagination: vi.fn(async () => null), setSessionHistoryCompleteEmpty: vi.fn(async () => true), clearSessionHistory: vi.fn(async () => true), getSessionHistoryToken: vi.fn(async () => null), isSessionHistoryClearCurrent: vi.fn(async () => ({ current: true, refreshing: false })), readSessionHistoryPaginationState: vi.fn(async () => null), releaseSessionHistoryRefresh: vi.fn(async () => true) }));
vi.mock('../src/features/task-agent-session/TaskAgentSession', () => ({ TaskAgentSession: () => <div>Native timeline</div> }));
beforeEach(() => {
  vi.spyOn(TaskCacheScope.prototype, 'isSessionHistoryTicketCurrent').mockReturnValue(true);
  vi.mocked(readCachedSessionHistory).mockReset().mockResolvedValue(null);
  vi.mocked(beginSessionHistoryRefresh).mockReset().mockResolvedValue({ kind: 'lease', token: '00000005-1111-4111-8111-111111111111', acquired: true, expiresAt: Date.now() + 30000 });
  vi.mocked(saveSessionHistory).mockReset().mockResolvedValue(true);
});
afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });
const render = createLocaleRender('en', { taskCache: true });
const projectId = '00000001-1111-4111-8111-111111111111';
const taskId = '00000002-1111-4111-8111-111111111111';
const claimId = '00000003-1111-4111-8111-111111111111';
const record = { sessionId: '00000004-1111-4111-8111-111111111111', claimId, executionGeneration: '1', agentControlMode: 'herdr', contentKind: 'terminal_recording', createdAt: '2026-11-03T10:00:00Z', endedAt: '2026-11-03T10:01:00Z', archive: { state: 'pending', sha256: null, byteLength: null, completeness: null } } as const;
function fixture() {
  const api = { history: vi.fn(async () => ({ items: [record], nextCursor: null })), archive: vi.fn(async () => ({ status: { payload: { state: 'pending' } }, archive: null })), current: vi.fn(), channel: vi.fn(), command: vi.fn() };
  vi.mocked(createTerminalSessionApi).mockReturnValue(api as never); return api;
}
describe('unified Session and managed records', () => {
  it('hides only a confirmed empty inventory and retains loading, failure and retry', async () => {
    const api = fixture();
    let finish!: (value: { items: never[]; nextCursor: null }) => void;
    api.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as never);
    render(<ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>);
    expect(await screen.findByRole('region', { name: 'Session recordings' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    await act(async () => finish({ items: [], nextCursor: null }));
    expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull();
  });
  it('keeps failures recoverable and hides after a successful retry', async () => {
    const api = fixture();
    api.history.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [], nextCursor: null } as never);
    render(<ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>);
    expect(await screen.findByRole('alert')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull());
    expect(api.history).toHaveBeenCalledTimes(2);
  });
  it('rechecks a confirmed empty inventory when the retained tab is reopened', async () => {
    const api = fixture();
    api.history.mockResolvedValueOnce({ items: [], nextCursor: null } as never).mockResolvedValueOnce({ items: [record], nextCursor: null });
    const content = (active: boolean) => <ManagedSessionRecords projectId={projectId} taskId={taskId} active={active}>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>;
    const view = render(content(true));
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull());
    view.rerender(content(false));
    view.rerender(content(true));
    expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
    expect(api.history).toHaveBeenCalledTimes(2);
  });
  it('restarts from the first page when reopening an exhausted empty inventory', async () => {
    const api = fixture();
    api.history.mockResolvedValueOnce({ items: [], nextCursor: 'next' } as never)
      .mockResolvedValueOnce({ items: [], nextCursor: null } as never)
      .mockResolvedValueOnce({ items: [record], nextCursor: null });
    const content = (active: boolean) => <ManagedSessionRecords projectId={projectId} taskId={taskId} active={active}>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>;
    const view = render(content(true));
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier records' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull());
    view.rerender(content(false));
    view.rerender(content(true));
    expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
    expect(api.history).toHaveBeenLastCalledWith(null, expect.any(AbortSignal));
  });
  it('keeps an empty page with a continuation reachable', async () => {
    const api = fixture();
    api.history.mockResolvedValueOnce({ items: [], nextCursor: 'next' } as never).mockResolvedValueOnce({ items: [record], nextCursor: null });
    render(<ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>);
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier records' }));
    expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
    expect(api.history).toHaveBeenLastCalledWith('next', expect.any(AbortSignal));
  });
  it('does not expose the empty section while a cache read and subsequent refresh are delayed', async () => {
    const api = fixture();
    let finishCache!: (value: { items: never[]; nextCursor: null; confirmedCompleteEmpty: boolean }) => void;
    let finishNetwork!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
    vi.mocked(readCachedSessionHistory).mockImplementationOnce(() => new Promise(resolve => { finishCache = resolve; }));
    api.history.mockImplementationOnce(() => new Promise(resolve => { finishNetwork = resolve; }) as never);
    render(<ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>);
    await waitFor(() => expect(readCachedSessionHistory).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull();
    await act(async () => finishCache({ items: [], nextCursor: null, confirmedCompleteEmpty: false }));
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull();
    await act(async () => finishNetwork({ items: [record], nextCursor: null }));
    expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
  });
  it('retains cached records and the selected original preview during refresh, then updates archive status', async () => {
    const api = fixture();
    let finishNetwork!: (value: { items: SessionHistoryItem[]; nextCursor: null }) => void;
    const updated = { ...record, archive: { ...record.archive, state: 'failed' as const } };
    vi.mocked(readCachedSessionHistory).mockResolvedValueOnce({ items: [record], nextCursor: null, confirmedCompleteEmpty: false });
    api.history.mockImplementationOnce(() => new Promise(resolve => { finishNetwork = resolve; }) as never);
    render(<ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>);
    const button = await screen.findByRole('button', { name: /Herdr/ });
    fireEvent.click(button);
    await screen.findByText('Recording is waiting to be archived.');
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
    await act(async () => finishNetwork({ items: [updated], nextCursor: null }));
    expect(await screen.findByRole('button', { name: /Herdr.*could not be saved or verified/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Recording is waiting to be archived.')).toBeVisible();
    expect(api.archive).toHaveBeenCalledTimes(1);
    expect(api.archive).toHaveBeenCalledWith(record, expect.any(AbortSignal));
  });
  it('retains a cached empty result after a refresh failure and exposes a retry', async () => {
    const api = fixture();
    vi.mocked(readCachedSessionHistory).mockResolvedValueOnce({ items: [], nextCursor: null, confirmedCompleteEmpty: false });
    api.history.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [record], nextCursor: null });
    render(<ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
  });
  it('keeps cached records readable on refresh failure and recovers on retry', async () => {
    const api = fixture();
    vi.mocked(readCachedSessionHistory).mockResolvedValueOnce({ items: [record], nextCursor: null, confirmedCompleteEmpty: false });
    api.history.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [record], nextCursor: null });
    render(<ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByRole('button', { name: /Herdr/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole('button', { name: /Herdr/ })).toBeVisible();
  });
  it('still loads the network when persistent storage fails', async () => {
    const api = fixture();
    vi.mocked(readCachedSessionHistory).mockRejectedValueOnce(new Error('storage unavailable'));
    render(<ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>);
    expect(await screen.findByRole('button', { name: /Herdr/ })).toBeVisible();
    expect(api.history).toHaveBeenCalledTimes(1);
  });
  it('does not let a delayed response for an old task replace the new task', async () => {
    const oldApi = fixture();
    let finishOld!: (value: { items: typeof record[]; nextCursor: null }) => void;
    oldApi.history.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }) as never);
    const newApi = { ...oldApi, history: vi.fn(async () => ({ items: [], nextCursor: null })) };
    vi.mocked(createTerminalSessionApi).mockImplementation((_project, task) => (task === taskId ? oldApi : newApi) as never);
    const content = (id: string) => <ManagedSessionRecords projectId={projectId} taskId={id} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>;
    const view = render(content(taskId));
    await waitFor(() => expect(oldApi.history).toHaveBeenCalledTimes(1));
    view.rerender(content('00000005-1111-4111-8111-111111111111'));
    await waitFor(() => expect(newApi.history).toHaveBeenCalledTimes(1));
    await act(async () => finishOld({ items: [record], nextCursor: null }));
    expect(screen.queryByRole('button', { name: /Herdr/ })).toBeNull();
  });
  it('retains the loaded older page when the first page is unchanged on reactivation', async () => {
    const api = fixture();
    const older = { ...record, sessionId: '00000006-1111-4111-8111-111111111111', createdAt: '2026-11-02T10:00:00Z' };
    api.history.mockResolvedValueOnce({ items: [record], nextCursor: 'next' } as never)
      .mockResolvedValueOnce({ items: [older], nextCursor: null } as never)
      .mockResolvedValueOnce({ items: [record], nextCursor: 'next' } as never);
    const content = (active: boolean) => <ManagedSessionRecords projectId={projectId} taskId={taskId} active={active}>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>;
    const view = render(content(true));
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier records' }));
    expect(await screen.findByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
    view.rerender(content(false)); view.rerender(content(true));
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('button', { name: /2026-11-02.*Herdr/ })).toBeVisible();
    expect(api.history).toHaveBeenLastCalledWith(null, expect.any(AbortSignal));
  });
  it('clears the selected recording when the authenticated scope changes', async () => {
    const oldApi = fixture();
    const newApi = { ...oldApi, history: vi.fn(async () => ({ items: [], nextCursor: null })) };
    const oldScope = createTaskCacheScope({ userId: '00000007-1111-4111-8111-111111111111', onIdentityMismatch: vi.fn() });
    const newScope = createTaskCacheScope({ userId: '00000008-1111-4111-8111-111111111111', onIdentityMismatch: vi.fn() });
    vi.mocked(createTerminalSessionApi).mockImplementation((_project, _task, user) => (user === oldScope.userId ? oldApi : newApi) as never);
    const content = (scope: typeof oldScope) => <TaskCacheProvider scope={scope}><ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords></TaskCacheProvider>;
    const view = createLocaleRender('en')(content(oldScope));
    try {
      fireEvent.click(await screen.findByRole('button', { name: /Herdr/ }));
      await screen.findByText('Recording is waiting to be archived.');
      view.rerender(content(newScope));
      await waitFor(() => expect(newApi.history).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('button', { name: 'Close recording' })).toBeNull();
      expect(screen.queryByText('Recording is waiting to be archived.')).toBeNull();
    } finally { view.unmount(); oldScope.dispose(); newScope.dispose(); }
  });
  it('withdraws a selected recording when the history request reports lost access', async () => {
    const api = fixture();
    api.history.mockResolvedValueOnce({ items: [record], nextCursor: null }).mockRejectedValueOnce(new ApiError('server', 403));
    render(<ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>);
    fireEvent.click(await screen.findByRole('button', { name: /Herdr/ }));
    await screen.findByText('Recording is waiting to be archived.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh' })[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('You no longer have permission');
    expect(screen.queryByRole('button', { name: 'Close recording' })).toBeNull();
    expect(screen.queryByText('Recording is waiting to be archived.')).toBeNull();
  });
  it.each(['pending', 'failed', 'unavailable'] as const)('offers %s records and preserves their selected preview after an empty refresh', async state => {
    const api = fixture();
    const item = { ...record, archive: { ...record.archive, state } };
    api.history.mockResolvedValueOnce({ items: [item], nextCursor: null } as never).mockResolvedValueOnce({ items: [], nextCursor: null } as never);
    api.archive.mockResolvedValue({ status: { payload: { state } }, archive: null } as never);
    render(<ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>);
    fireEvent.click(await screen.findByRole('button', { name: /Herdr/ }));
    await waitFor(() => expect(api.archive).toHaveBeenCalledWith(item, expect.any(AbortSignal)));
    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh' })[0]!);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Session recordings' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Close recording' })).toBeVisible();
    expect(screen.getByText('Read-only')).toBeVisible();
  });
  it('keeps native current rendering and opens history by original identity without controls', async () => {
    const api = fixture();
    const view = render(<TaskSessionHost projectId={projectId} taskId={taskId} claimId={claimId} mode="web" active current />);
    expect(screen.getByText('Native timeline')).toBeInTheDocument();
    await screen.findByRole('option', { name: /Herdr/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Execution record' }), { target: { value: record.sessionId } });
    await screen.findByText('Recording is waiting to be archived.');
    expect(api.archive).toHaveBeenCalledWith(record, expect.any(AbortSignal));
    view.rerender(<TaskSessionHost projectId={projectId} taskId={taskId} claimId={taskId} mode="web" active current />);
    expect(screen.getByRole('combobox', { name: 'Execution record' })).toHaveValue(record.sessionId);
    expect(api.current).not.toHaveBeenCalled(); expect(api.channel).not.toHaveBeenCalled(); expect(api.command).not.toHaveBeenCalled();
  });
  it('managed attachment entries only open read-only records and do not expose mutation actions', async () => {
    const api = fixture(); render(<ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>);
    fireEvent.click(await screen.findByRole('button', { name: /Herdr/ }));
    await waitFor(() => expect(api.archive).toHaveBeenCalledWith(record, expect.any(AbortSignal)));
    expect(screen.queryByRole('button', { name: /delete|rename|download|take control/i })).toBeNull();
    expect(api.channel).not.toHaveBeenCalled();
  });
  it('retains the loaded inventory and refreshes it when the hidden tab reopens', async () => {
    const api = fixture();
    const view = render(<ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>);
    await screen.findByRole('button', { name: /Herdr/ });
    view.rerender(<ManagedSessionRecords projectId={projectId} taskId={taskId} active={false}>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>);
    view.rerender(<ManagedSessionRecords projectId={projectId} taskId={taskId} active>{slots => <>{slots.sidebar}{slots.preview}</>}</ManagedSessionRecords>);
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: /Herdr/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(3));
  });
  it('shares the attachment sidebar and reader while preserving ordinary file drafts', async () => {
    const api = fixture();
    const stamp = '2026-11-03T10:00:00Z';
    const attachments = { list: vi.fn(async () => ({ items: [{ path: 'report.txt', contentType: 'text/plain', sizeBytes: 12, createdAt: stamp, updatedAt: stamp }], nextCursor: null })), readText: vi.fn(async () => 'Original attachment'), checkPreview: vi.fn(), put: vi.fn(), remove: vi.fn() };
    render(<TaskDetailReading projectId={projectId} taskId={taskId} api={attachments} description="[Read report](report.txt)" overview={node => node}
      sessionRecords={(active, render, resetSelection) => <ManagedSessionRecords projectId={projectId} taskId={taskId} active={active} resetSelection={resetSelection}>{render}</ManagedSessionRecords>} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Attachments' }));
    const item = await screen.findByRole('button', { name: /Herdr/ });
    expect(item.closest('.attachment-sidebar')).not.toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /^report.txt/ }));
    await screen.findByText('Original attachment');
    const original = screen.getByText('Original attachment');
    const upload = document.querySelector('.attachment-upload-disclosure')!;
    fireEvent.click(upload.querySelector('summary')!);
    const target = screen.getByRole('textbox', { name: 'Target relative path' });
    fireEvent.change(target, { target: { value: 'draft/unsent.txt' } });
    fireEvent.click(item);
    await screen.findByText('Recording is waiting to be archived.');
    expect(original).not.toBeVisible();
    expect(original).toBeInTheDocument();
    expect(screen.getByText('Read-only').closest('.attachment-preview-pane')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^report.txt/ }));
    expect(original).toBeVisible();
    expect(target).toHaveValue('draft/unsent.txt');
    expect(api.current).not.toHaveBeenCalled(); expect(api.channel).not.toHaveBeenCalled();
    fireEvent.click(item);
    await screen.findByText('Recording is waiting to be archived.');
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    fireEvent.click(screen.getByRole('link', { name: 'Read report' }));
    expect(original).toBeVisible();
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
  });

});
