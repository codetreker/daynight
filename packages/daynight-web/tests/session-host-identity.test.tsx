import { readFileSync } from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import { useState } from 'react';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionV2Archive, TerminalFrame } from '../../daynight/src/session/v2/types';
import { pauseAuthRequests } from '../src/api/client';
import { createTerminalSessionApi } from '../src/api/terminal-sessions';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { TaskDetailSessionProvider } from '../src/features/task-detail/TaskDetailSession';
import { useTaskDetail } from '../src/features/task-detail/useTaskDetail';
import { FixedSessionRecording, TaskSessionHost, suspendStaticSessionMediaForAccountRefresh } from '../src/features/task-agent-session/TaskSessionHost';
import { pageImageStore } from '../src/features/task-agent-session/images/image-store';
import { createLocaleRender } from './helpers/renderWithLocale';
import { detailFixture, resourceResponse } from './helpers/taskDetail';
import { sessionImageBytes } from './helpers/sessionImages';
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

it('stops direct recorded media immediately while keeping the displayed image and rejecting late bytes', async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const bytes = sessionImageBytes('png');
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const resource = (id: string, name: string) => ({ resourceId: id, revision: '1', name, status: 'available' as const, mediaType: 'image/png', byteLength: String(bytes.length), sha256, width: 3, height: 2, frameCount: 1, error: null });
  const first = resource('00000012-1111-4111-8111-111111111111', 'First.png');
  const second = resource('00000013-1111-4111-8111-111111111111', 'Second.png');
  const archive = { schemaVersion: 3 as const, sessionId: item.sessionId, claimId, executionGeneration: '1', controllerId: projectId, controllerInstanceId: taskId, provider: 'codex' as const, nativeSessionId: null, completeness: 'complete' as const,
    entries: [{ entryId: '00000007-1111-4111-8111-111111111111', entrySeq: '1', revision: '1', kind: 'assistant_message' as const, content: [{ type: 'text' as const, text: 'Retained recording.' }, ...[first, second].map((value, index) => ({ type: 'image' as const, imageId: index === 0 ? '00000014-1111-4111-8111-111111111111' : '00000015-1111-4111-8111-111111111111', resourceId: value.resourceId, label: value.name }))] }],
    resources: [first, second].map(value => ({ resource: value, blobId: '00000016-1111-4111-8111-111111111111' })) };
  const status = { state: 'ready' as const, sha256: 'a'.repeat(64), byteLength: '1024', errorCode: null, schemaVersion: 3 as const, completeness: 'complete' as const };
  const record = { ...item, agentControlMode: 'web' as const, contentKind: 'native_timeline' as const, archive: status };
  let finish!: (bytes: Uint8Array<ArrayBuffer>) => void;
  const reader = { readResource: vi.fn((value: typeof first, _signal: AbortSignal) => value.resourceId === first.resourceId ? Promise.resolve(bytes) : new Promise<Uint8Array<ArrayBuffer>>(resolve => { finish = resolve; })), close: vi.fn(async () => {}) };
  const api = { nativeArchive: vi.fn(async () => ({ status, archive })), resources: vi.fn(() => reader) };
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3, height: 2, close: vi.fn() })));
  const scopes = vi.spyOn(pageImageStore, 'createScope');
  const content = (current: boolean) => <TaskCacheProvider scope={scope}><FixedSessionRecording projectId={projectId} api={api as never} item={record} active current={current} /></TaskCacheProvider>;
  const view = render(content(true));
  try {
    const image = await screen.findByRole('img', { name: first.name });
    await waitFor(() => expect(reader.readResource).toHaveBeenCalledTimes(2));
    const images = scopes.mock.results[0]!.value;
    const pending = reader.readResource.mock.calls.find(([value]) => value.resourceId === second.resourceId)!;
    act(() => { suspendStaticSessionMediaForAccountRefresh(scope); suspendStaticSessionMediaForAccountRefresh(scope); });
    expect(pending[1].aborted).toBe(true);
    expect(reader.close).toHaveBeenCalledOnce();
    expect(images.valid).toBe(true); expect(images.canRead()).toBe(false); expect(images.canDownload()).toBe(false);
    expect(screen.getByText('Retained recording.')).toBeVisible(); expect(screen.getByRole('img', { name: first.name })).toBe(image);
    await act(async () => finish(bytes));
    view.rerender(content(false)); view.rerender(content(true));
    expect(screen.getByRole('img', { name: first.name })).toBe(image);
    expect(screen.queryByRole('img', { name: second.name })).toBeNull();
    expect(reader.readResource).toHaveBeenCalledTimes(2);
    view.unmount(); expect(images.valid).toBe(false);
    expect(reader.close).toHaveBeenCalledOnce();
    const later = render(content(true));
    try {
      expect(await screen.findByText('Retained recording.')).toBeVisible();
      expect(reader.readResource).toHaveBeenCalledTimes(2);
      expect(api.resources).toHaveBeenCalledOnce();
      expect(scopes.mock.results[1]!.value.canRead()).toBe(false);
    } finally { later.unmount(); }
  } finally { view.unmount(); scope.dispose(); scopes.mockRestore(); }
});
