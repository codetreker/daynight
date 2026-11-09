import { readFileSync } from 'node:fs';
import { useState } from 'react';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionV2Archive, TerminalFrame } from '../../daynight/src/session/v2/types';
import { pauseAuthRequests } from '../src/api/client';
import { createTerminalSessionApi } from '../src/api/terminal-sessions';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { TaskDetailSessionProvider } from '../src/features/task-detail/TaskDetailSession';
import { useTaskDetail } from '../src/features/task-detail/useTaskDetail';
import { TaskSessionHost } from '../src/features/task-agent-session/TaskSessionHost';
import { createLocaleRender } from './helpers/renderWithLocale';
import { detailFixture, resourceResponse } from './helpers/taskDetail';
import { fixtureTaskEpoch, TEST_VIEWER_ID } from './helpers/taskSync';

vi.mock('../src/api/terminal-sessions', async original => ({ ...await original<typeof import('../src/api/terminal-sessions')>(), createTerminalSessionApi: vi.fn() }));
vi.mock('../src/features/task-agent-session/TerminalSessionView', () => ({ TerminalSessionView: ({ current }: { current: boolean }) => <span data-testid="live-session-current">{String(current)}</span> }));
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const claimId = '30000000-0000-4000-8000-000000000001';
const item = { sessionId: '00000004-1111-4111-8111-111111111111', claimId, executionGeneration: '1', agentControlMode: 'herdr', contentKind: 'terminal_recording', createdAt: '2026-11-03T10:00:00Z', endedAt: '2026-11-03T10:01:00Z', archive: { state: 'pending', sha256: null, byteLength: null, completeness: null } } as const;
const render = createLocaleRender('en');
function recording(): SessionV2Archive {
  const archive = JSON.parse(readFileSync('../daynight/test/session/fixtures/v2/valid-archive.json', 'utf8')) as SessionV2Archive;
  const segment = archive.segments[0]!, file = archive.files[0]!, frame = JSON.parse(file.data) as TerminalFrame;
  const entries = [{ time: '0', text: 'First frame' }, { time: '800', text: 'Second frame' }];
  return { ...archive, segments: [{ ...segment, durationMs: '1000' }],
    files: entries.map((entry, i) => ({ ...file, fileId: `${file.fileId}-${i}`, frameSeq: String(i + 1), data: JSON.stringify({ ...frame, frameSeq: String(i + 1), elapsedMs: entry.time, rows: [[{ ...frame.rows[0]![0]!, text: entry.text }]] }) })),
    index: entries.map((entry, i) => ({ fileId: `${file.fileId}-${i}`, segmentId: segment.segmentId, frameSeq: String(i + 1), firstElapsedMs: entry.time, lastElapsedMs: entry.time })), gaps: [] };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(completed = false, live = false) {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const fetcher = vi.fn(async () => resourceResponse(detailFixture(projectId, taskId), TEST_VIEWER_ID)); vi.stubGlobal('fetch', fetcher);
  const api = { history: vi.fn(async () => ({ items: [item], nextCursor: null })), archive: vi.fn(async () => ({ status: { payload: { state: 'ready' } }, archive: recording() })), current: vi.fn(), channel: vi.fn(), command: vi.fn() };
  if (completed) api.current.mockResolvedValue({ status: 'registered', ...item } as never);
  vi.mocked(createTerminalSessionApi).mockReturnValue(api as never);
  let rerenderChecking!: (value: boolean) => void;
  function Harness() {
    const [, setChecking] = useState(false); rerenderChecking = setChecking;
    const task = useTaskDetail(projectId, taskId, { kind: 'direct' });
    return <TaskSessionHost projectId={projectId} taskId={taskId} {...(completed || live ? { claimId, ownerUserId: TEST_VIEWER_ID, mode: 'herdr' as const, completed } : {})} active current={task.sessionCurrent} direct />;
  }
  const view = render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><Harness /></TaskDetailSessionProvider></TaskCacheProvider>);
  return { scope, api, fetcher, view, setChecking: (value: boolean) => rerenderChecking(value) };
}
async function openRecording() {
  await screen.findByText('First frame');
  fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
  expect(screen.getByText('Second frame')).toBeVisible();
  fireEvent.change(screen.getByRole('combobox', { name: 'Text size' }), { target: { value: '150' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enter Session fullscreen' }));
  expect(screen.getByRole('button', { name: 'Exit Session fullscreen' })).toHaveAttribute('aria-pressed', 'true');
}
it('retains the selected fullscreen recording and playback position through a same-account identity check', async () => {
  const { scope, api, fetcher, view, setChecking } = setup(); let resume: (() => void) | undefined;
  try {
    await openRecording(); expect(api.archive).toHaveBeenCalledTimes(1);
    const requests = fetcher.mock.calls.length; const histories = api.history.mock.calls.length;
    act(() => { resume = pauseAuthRequests(); setChecking(true); });
    expect(screen.getByRole('button', { name: 'Exit Session fullscreen' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Second frame')).toBeVisible(); expect(screen.getByRole('combobox', { name: 'Text size' })).toHaveValue('150');
    const refresh = within(screen.getByRole('region', { name: 'Session recording' }).parentElement!).getByRole('button', { name: 'Refresh' });
    expect(refresh).toBeDisabled(); fireEvent.click(refresh);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(api.archive).toHaveBeenCalledTimes(1); expect(api.history).toHaveBeenCalledTimes(histories); expect(api.command).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(requests);
    act(() => { resume?.(); resume = undefined; setChecking(false); });
    expect(screen.getByRole('button', { name: 'Exit Session fullscreen' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Second frame')).toBeVisible(); expect(screen.getByRole('combobox', { name: 'Text size' })).toHaveValue('150');
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});
it('gates the live Session through same-account identity verification', async () => {
  const { scope, api, view, setChecking } = setup(false, true); let resume: (() => void) | undefined;
  try {
    await waitFor(() => expect(screen.getByTestId('live-session-current')).toHaveTextContent('true'));
    act(() => { resume = pauseAuthRequests(); setChecking(true); });
    expect(screen.getByTestId('live-session-current')).toHaveTextContent('false');
    expect(api.history).not.toHaveBeenCalled(); expect(api.command).not.toHaveBeenCalled();
    act(() => { resume?.(); resume = undefined; setChecking(false); });
    expect(screen.getByTestId('live-session-current')).toHaveTextContent('true');
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});
it('revalidates a completed direct claim after a peer history denial before restoring its recording', async () => {
  const { scope, api, view } = setup(true);
  let finish!: (value: { status: 'registered' } & typeof item) => void;
  try {
    expect(await screen.findByText('First frame')).toBeVisible();
    expect(api.history).not.toHaveBeenCalled();
    api.current.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as never);
    const signal = new AbortController().signal;
    const fence = await scope.beginTaskRead(projectId, taskId, 0, 0, signal);
    await act(async () => { expect(scope.reportDirectSessionDenied(fence, fixtureTaskEpoch(projectId))).toBe(true); });
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByText('First frame')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.current).toHaveBeenCalledTimes(2));
    expect(api.history).toHaveBeenCalledOnce();
    expect(screen.queryByText('First frame')).toBeNull();
    await act(async () => finish({ status: 'registered', ...item }));
    expect(await screen.findByText('First frame')).toBeVisible();
  } finally { view.unmount(); scope.dispose(); }
});
it.each(['access', 'identity'] as const)('withdraws the selected fullscreen recording on %s retirement during an identity check', async retirement => {
  const { scope, view, setChecking } = setup(); let resume: (() => void) | undefined;
  try {
    await openRecording(); act(() => { resume = pauseAuthRequests(); setChecking(true); });
    if (retirement === 'access') act(() => scope.suspendProject(projectId));
    else await act(async () => { await scope.invalidateScope(); });
    await waitFor(() => expect(screen.queryByText('Second frame')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Exit Session fullscreen' })).toBeNull();
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});
it('defers a recording response already in flight until the same account is verified', async () => {
  const { scope, api, view, setChecking } = setup(); let resume: (() => void) | undefined; let finish!: (value: Awaited<ReturnType<typeof api.archive>>) => void;
  api.archive.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  try {
    await waitFor(() => expect(api.archive).toHaveBeenCalledOnce());
    act(() => { resume = pauseAuthRequests(); setChecking(true); });
    await act(async () => finish({ status: { payload: { state: 'ready' } }, archive: recording() }));
    expect(screen.queryByText('First frame')).toBeNull();
    act(() => { resume?.(); resume = undefined; setChecking(false); });
    expect(await screen.findByText('First frame')).toBeVisible(); expect(api.archive).toHaveBeenCalledOnce();
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});
