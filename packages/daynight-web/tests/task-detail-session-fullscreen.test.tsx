import { readFileSync } from 'node:fs';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../src/api/auth';
import * as resources from '../src/api/client';
import * as sessions from '../src/api/sessions';
import type { SessionApi } from '../src/api/sessions';
import type { TaskDetail } from '../src/api/types';
import type { BrowserMessage } from '../../daynight/src/session/controller-protocol';
import type { TaskSessionSnapshot } from './helpers/session';
import type { TaskDetailNavigation } from '../src/app/router';
import { TaskDetailSurface } from '../src/features/task-detail/TaskDetailSurface';
import { TaskDetailSessionBoundary } from '../src/features/task-detail/TaskDetailSession';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { detailFixture, resourceResponse, snapshotFixture } from './helpers/taskDetail';
import { renderWithLocale } from './helpers/renderWithLocale';
import { directAccessFixture, TEST_VIEWER_ID, fixtureTaskEpoch } from './helpers/taskSync';

const initial = (): TaskSessionSnapshot => ({ ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), executionGeneration: '1', connectionEpoch: '1', lastEventSeq: '0' });
let world: ReturnType<typeof createTaskSessionWorld>;
let root: HTMLElement;
beforeEach(() => {
  world = createTaskSessionWorld();
  root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  vi.spyOn(auth, 'listMembers').mockImplementation(async (projectId) => ({ items: [], actorAccess: directAccessFixture(projectId, TEST_VIEWER_ID, 'admin') }));
  vi.spyOn(auth, 'getProjectAccess').mockImplementation(async (projectId) => directAccessFixture(projectId, TEST_VIEWER_ID, 'admin'));
  vi.stubGlobal('fetch', vi.fn(async () => resourceResponse({ items: [], nextCursor: null }, TEST_VIEWER_ID)));
});
afterEach(() => { cleanup(); world.dispose(); root.remove(); document.body.style.overflow = ''; });

function Host({ detail, modal, initialFullscreen = false, tab = 'session', onClose }: {
  detail: TaskDetail; modal: boolean; initialFullscreen?: boolean; tab?: TaskDetailNavigation['tab']; onClose: () => void;
}) {
  const [fullscreen, setFullscreen] = useState(initialFullscreen);
  const [navigation, setNavigation] = useState<TaskDetailNavigation>({ tab, path: null });
  useEffect(() => setNavigation({ tab, path: null }), [tab]);
  const surface = <TaskDetailSurface projectId={detail.projectId} taskId={detail.id} snapshot={snapshotFixture([detail], Number(detail.version))}
    fullscreen={{ active: fullscreen, onChange: setFullscreen }} navigation={navigation} onNavigate={setNavigation}
    onSelectTask={() => {}} onRefreshGraph={() => {}}
    {...(modal ? { presentation: 'dialog' as const, onClose, onRestoreFocus: () => {} } : { presentation: 'page' as const })} />;
  return <TaskDetailSessionBoundary>{modal ? createPortal(surface, document.body) : surface}</TaskDetailSessionBoundary>;
}

async function fixture(modal: boolean, initialFullscreen = false) {
  let snapshot = initial();
  const claim = () => ({ claimId: snapshot.claimId, state: 'active', userId: TEST_VIEWER_ID, workerId: snapshot.identity.workerId, machine: { id: snapshot.identity.controllerId, name: 'Test machine' }, platform: 'macos', agent: 'codex', agentControlMode: 'web', worktreeId: snapshot.identity.worktreeId, phase: 'executing', herdr: null, nativeSessionId: 'native-thread', claimedAt: '2026-11-04T00:00:00Z' });
  let detail = detailFixture(snapshot.identity.projectId, snapshot.identity.taskId, { title: 'Fullscreen task', status: 'in_progress', ready: false, properties: { worker: claim() }, version: 1n });
  vi.spyOn(resources, 'getTaskObservation').mockImplementation(async () => ({ detail, epoch: fixtureTaskEpoch(detail.projectId) }));
  let receive!: (message: BrowserMessage) => void;
  let connections = 0, closed = 0;
  const api: SessionApi = {
    current: async () => ({ status: 'registered', session: snapshot }),
    timeline: async () => ({ sessionId: snapshot.sessionId, historyEpoch: snapshot.historyEpoch, items: [{ kind: 'assistant_message', entryId: 'message', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Retained message' }] }], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' }),
    channel: (_id, _after, onMessage) => { connections++; receive = onMessage; return { close: () => { closed++; } }; },
    archive: vi.fn(), archiveContent: vi.fn(), command: vi.fn(), operation: vi.fn(), resource: vi.fn(), resources: () => { throw new Error('Unexpected image resource client call.'); }, resourceUrl: () => '/unused',
  };
  vi.spyOn(sessions, 'createSessionApi').mockReturnValue(api);
  await world.sync([detail]);
  const onClose = vi.fn();
  const element = (tab: TaskDetailNavigation['tab'] = 'session') => <Host detail={detail} modal={modal} initialFullscreen={initialFullscreen} tab={tab} onClose={onClose} />;
  const view = renderWithLocale(element(), { locale: 'en', container: root, taskCache: { scope: world.scope } });
  const hydrate = async () => {
    await waitFor(() => expect(receive).toBeTypeOf('function'));
    act(() => receive({ protocol: snapshot.protocol, type: 'snapshot', userId: TEST_VIEWER_ID, snapshot, cursor: 'zero' }));
    await screen.findByText('Retained message');
  };
  await hydrate();
  const surface = document.querySelector<HTMLElement>(modal ? '.task-detail-dialog' : '.task-detail-page')!;
  return { view, surface, onClose, counts: () => ({ connections, closed }), setTab: (tab: TaskDetailNavigation['tab']) => view.rerender(element(tab)), changeClaim: async () => {
    snapshot = { ...snapshot, sessionId: crypto.randomUUID(), claimId: crypto.randomUUID() };
    detail = { ...detail, version: 2n, properties: { worker: claim() } };
    await act(async () => world.sync([detail]));
    view.rerender(element());
    await waitFor(() => expect(connections).toBe(2));
    await hydrate();
  } };
}

describe('Session fullscreen inside task details', () => {
  it.each([true, false])('keeps an unresolved history read distinct from an empty task (modal=%s)', async modal => {
    const snapshot = initial();
    const detail = detailFixture(snapshot.identity.projectId, snapshot.identity.taskId, { properties: {}, status: 'todo' });
    let finish!: (response: Response) => void;
    vi.spyOn(resources, 'getTaskObservation').mockResolvedValue({ detail, epoch: fixtureTaskEpoch(detail.projectId) });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/sessions?')
      ? new Promise<Response>(resolve => { finish = resolve; })
      : resourceResponse({ items: [], nextCursor: null }, TEST_VIEWER_ID)));
    await world.sync([detail]);
    renderWithLocale(<Host detail={detail} modal={modal} onClose={() => {}} />, { locale: 'en', container: root, taskCache: { scope: world.scope } });
    expect(await screen.findByRole('tab', { name: 'Session' })).toBeVisible();
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    await act(async () => finish(resourceResponse({ items: [], nextCursor: null }, TEST_VIEWER_ID)));
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Session' })).toBeNull());
  });

  it('automatically retains historical Session access after a task returns to todo without a claim', async () => {
    const snapshot = initial();
    const detail = detailFixture(snapshot.identity.projectId, snapshot.identity.taskId, { properties: {}, status: 'todo' });
    vi.spyOn(resources, 'getTaskObservation').mockResolvedValue({ detail, epoch: fixtureTaskEpoch(detail.projectId) });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/sessions?')) return resourceResponse({ items: [{ sessionId: snapshot.sessionId, claimId: snapshot.claimId, executionGeneration: '1', agentControlMode: 'web', contentKind: 'native_timeline', createdAt: '2026-11-04T00:00:00Z', endedAt: '2026-11-04T01:00:00Z', archive: { state: 'pending', sha256: null, byteLength: null, completeness: null } }], nextCursor: null }, TEST_VIEWER_ID);
      if (url.endsWith('/archive')) return resourceResponse({ archive: { state: 'pending', sha256: null, byteLength: null, errorCode: null } }, TEST_VIEWER_ID);
      return resourceResponse({ items: [], nextCursor: null }, TEST_VIEWER_ID);
    }));
    await world.sync([detail]);
    renderWithLocale(<Host detail={detail} modal={false} onClose={() => {}} />, { locale: 'en', container: root, taskCache: { scope: world.scope } });
    expect(await screen.findByRole('tab', { name: 'Session' })).toBeVisible();
    expect(await screen.findByText('Recording is waiting to be archived.')).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Execution record' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it.each(['released', 'completed'])('reads the retained %s claim archive after returning to todo', async state => {
    const snapshot = initial();
    const worker = { claimId: snapshot.claimId, state, userId: TEST_VIEWER_ID, workerId: snapshot.identity.workerId, machine: { id: snapshot.identity.controllerId, name: 'Test machine' }, platform: 'macos', agent: 'codex', agentControlMode: 'web', worktreeId: snapshot.identity.worktreeId, phase: 'executing', herdr: null, nativeSessionId: 'native-thread', claimedAt: '2026-11-04T00:00:00Z' };
    const detail = detailFixture(snapshot.identity.projectId, snapshot.identity.taskId, { properties: { worker }, status: 'todo' });
    vi.spyOn(resources, 'getTaskObservation').mockResolvedValue({ detail, epoch: fixtureTaskEpoch(detail.projectId) });
    const current = vi.fn(async () => ({ status: 'registered' as const, session: snapshot }));
    const command = vi.fn();
    const archive = vi.fn(async () => ({ state: 'pending' as const, sha256: null, byteLength: null, errorCode: null })), archiveContent = vi.fn(), channel = vi.fn();
    vi.spyOn(sessions, 'createSessionApi').mockReturnValue({ current, channel, timeline: vi.fn(), command, archive, archiveContent } as unknown as SessionApi);
    vi.stubGlobal('fetch', vi.fn(async () => resourceResponse({ items: [], nextCursor: null }, TEST_VIEWER_ID)));
    await world.sync([detail]);
    renderWithLocale(<Host detail={detail} modal={false} onClose={() => {}} />, { locale: 'en', container: root, taskCache: { scope: world.scope } });
    expect(await screen.findByText('Recording is waiting to be archived.')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(command).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalled();
    expect(archive).toHaveBeenCalledWith(snapshot.sessionId, expect.any(AbortSignal));
    expect(archiveContent).not.toHaveBeenCalled(); expect(channel).not.toHaveBeenCalled();
  });

  it.each([{ modal: true, outer: false }, { modal: true, outer: true }, { modal: false, outer: false }, { modal: false, outer: true }])('restores the original task surface (modal=$modal, fullscreen=$outer)', async ({ modal, outer }) => {
    const f = await fixture(modal, outer);
    const input = screen.getByRole('textbox', { name: 'Message' }), message = screen.getByText('Retained message');
    await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
    fireEvent.change(input, { target: { value: 'Unsent draft' } });
    const toggle = screen.getByRole('button', { name: 'Enter Session fullscreen' }); fireEvent.click(toggle);
    expect(f.surface).toHaveClass('task-detail-session-fullscreen');
    expect(f.surface.classList.contains('task-detail-fullscreen')).toBe(outer);
    for (const selector of ['.task-detail-header', '.task-detail-heading', '.task-detail-tabs', '.task-detail-notifications']) expect(f.surface.querySelector(selector)).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
    expect(screen.getByText('Retained message')).toBe(message);
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Conversation' }), { key: 'Escape' });
    expect(f.surface).toHaveClass('task-detail-session-fullscreen');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(f.surface).not.toHaveClass('task-detail-session-fullscreen');
    expect(f.surface).toHaveClass('task-detail-session-layout');
    expect(f.surface.classList.contains('task-detail-fullscreen')).toBe(outer);
    expect(f.onClose).not.toHaveBeenCalled();
    expect(toggle).toHaveFocus(); expect(input).toHaveValue('Unsent draft');
    expect(f.counts()).toEqual({ connections: 1, closed: 0 });
    expect(f.surface.querySelector('.task-detail-header')).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe(modal ? 'hidden' : '');
    fireEvent.keyDown(toggle, { key: 'Escape' });
    if (outer) { expect(f.surface).not.toHaveClass('task-detail-fullscreen'); expect(f.onClose).not.toHaveBeenCalled(); }
    else if (modal) expect(f.onClose).toHaveBeenCalledOnce();
    else expect(f.onClose).not.toHaveBeenCalled();
    f.view.unmount(); expect(document.body.style.overflow).toBe(''); expect(root).not.toHaveAttribute('inert');
  });

  it('releases Session ownership when its tab becomes inactive and does not restore it on return', async () => {
    const f = await fixture(true); fireEvent.click(screen.getByRole('button', { name: 'Enter Session fullscreen' }));
    f.setTab('overview');
    expect(f.surface).not.toHaveClass('task-detail-session-fullscreen');
    expect(f.surface.querySelector('.task-detail-header')).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    f.setTab('session'); expect(screen.getByRole('button', { name: 'Enter Session fullscreen' })).toBeVisible();
    expect(f.counts()).toEqual({ connections: 1, closed: 0 });
  });

  it('releases the old claim owner and starts the replacement Session in its ordinary layout', async () => {
    const f = await fixture(false); fireEvent.click(screen.getByRole('button', { name: 'Enter Session fullscreen' }));
    await f.changeClaim();
    expect(f.surface).not.toHaveClass('task-detail-session-fullscreen');
    expect(screen.getByRole('button', { name: 'Enter Session fullscreen' })).toBeVisible();
    expect(f.counts()).toEqual({ connections: 2, closed: 1 });
    expect(document.body.style.overflow).toBe('');
  });
});

it.each([
  { setting: 'Model', label: 'Model settings', fullscreen: false },
  { setting: 'Permissions', label: 'Permission settings', fullscreen: false },
  { setting: 'Model', label: 'Model settings', fullscreen: true },
  { setting: 'Permissions', label: 'Permission settings', fullscreen: true },
])('retains $setting and its task dialog during composition Escape (fullscreen=$fullscreen)', async ({ setting, label, fullscreen }) => {
  const f = await fixture(true);
  if (fullscreen) fireEvent.click(screen.getByRole('button', { name: 'Enter Session fullscreen' }));
  fireEvent.click(screen.getByRole('button', { name: setting }));
  const input = screen.getByRole('textbox', { name: 'Message' }); input.focus();
  const verify = () => {
    expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(f.surface.classList.contains('task-detail-session-fullscreen')).toBe(fullscreen);
    expect(f.onClose).not.toHaveBeenCalled(); expect(input).toHaveFocus();
  };
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    expect(fireEvent.keyDown(input, { key: 'Escape', cancelable: true, ...composition })).toBe(true);
    verify();
  }
  fireEvent.compositionStart(input);
  expect(fireEvent.keyDown(input, { key: 'Escape', cancelable: true })).toBe(true); verify();
  fireEvent.compositionEnd(input);
  expect(fireEvent.keyDown(input, { key: 'Escape', cancelable: true })).toBe(false);
  expect(screen.queryByLabelText(label)).toBeNull();
  expect(f.surface.classList.contains('task-detail-session-fullscreen')).toBe(fullscreen);
  expect(f.onClose).not.toHaveBeenCalled();
});
