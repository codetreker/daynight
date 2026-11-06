import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { pauseAuthRequests } from '../src/api/client';
import { CurrentAccountProvider } from '../src/app/CurrentAccountContext';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskDetailSurface } from '../src/features/task-detail/TaskDetailSurface';
import { TaskDetailSessionProvider, useTaskDetailSessions, type TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { detailFixture, graphFixture, resourceResponse } from './helpers/taskDetail';
import { directAccessFixture, TEST_VIEWER_ID } from './helpers/taskSync';
import { renderWithLocale } from './helpers/renderWithLocale';
import { wireResponse } from './helpers/wireJson';
import { viewerHeaders } from './helpers/taskSync';

vi.mock('../src/features/task-detail/attachments/TaskAttachments', () => ({ TaskAttachmentsPanel: () => null }));
vi.mock('../src/features/task-detail/attachments/useAttachments', () => ({ useAttachments: () => ({ select: vi.fn() }) }));
vi.mock('../src/features/task-agent-session/TaskSessionHost', () => ({
  TaskSessionHost: ({ current }: { current: boolean }) => <span data-testid="session-current">{String(current)}</span>,
  ManagedSessionRecords: ({ children }: { children: (value: { sidebar: null; preview: null; clearSelection: () => void }) => ReactNode }) => children({ sidebar: null, preview: null, clearSelection: () => {} }),
}));
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const otherId = '20000000-0000-4000-8000-000000000002';
const id = '30000000-0000-4000-8000-000000000001';
const worker = { claimId: id, state: 'active', userId: TEST_VIEWER_ID, workerId: id, machine: { id, name: 'test' }, platform: 'macos', agent: 'codex', agentControlMode: 'web', worktreeId: id, phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: '2026-10-22T10:00:00Z' } as const;
const task = detailFixture(projectId, taskId, { title: 'Parent', status: 'in_progress', startedAt: '2026-10-22T10:00:00Z', ready: false, properties: { worker } });
const successor = detailFixture(projectId, otherId, { title: 'Successor', dependsOn: [taskId], blockedBy: [taskId], ready: false });
const graph = graphFixture([task, successor]);
const step = { id: '00000001', title: 'Step', description: '', status: 'todo', createdAt: '2026-10-22T10:00:00Z', updatedAt: '2026-10-22T10:00:00Z' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let sessions: TaskDetailSessions;
function Capture() { sessions = useTaskDetailSessions(); return null; }
const denied = () => wireResponse({ error: { code: 'forbidden', message: 'denied', requestId: 'denied' } }, { status: 403, headers: viewerHeaders(TEST_VIEWER_ID) });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetcher);
  return renderWithLocale(<TaskDetailSessionProvider><Capture /><TaskDetailSurface presentation="page" projectId={projectId} taskId={taskId} observation={{ kind: 'direct' }} navigation={{ tab: 'overview', path: null }} onNavigate={vi.fn()} onSelectTask={vi.fn()} onRefreshGraph={vi.fn()} fullscreen={{ active: false, onChange: vi.fn() }} /></TaskDetailSessionProvider>, { locale: 'en', taskCache: true });
}
function resources(url: string) {
  if (url.endsWith('/access')) return resourceResponse(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin'), TEST_VIEWER_ID);
  if (url.endsWith('/steps')) return resourceResponse({ projectId, taskId, version: 1n, steps: [step] }, TEST_VIEWER_ID);
  if (url.includes('/task-graph')) return resourceResponse(graph, TEST_VIEWER_ID);
  return resourceResponse(task, TEST_VIEWER_ID);
}
it('aborts a delayed relationship read during a parent write and retries after a 403', async () => {
  const graphRead = deferred<Response>(); const write = deferred<Response>(); let graphs = 0; let writes = 0;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { writes++; return write.promise; }
    if (url.includes('/task-graph')) return ++graphs === 1 ? graphRead.promise : Promise.resolve(resources(url));
    return Promise.resolve(resources(url));
  });
  mount(fetcher); await screen.findByRole('heading', { name: 'Parent' });
  await waitFor(() => expect(graphs).toBe(1)); await waitFor(() => expect(screen.getByTestId('session-current')).toHaveTextContent('true'));
  act(() => sessions.setStatus(projectId, taskId, 'done', 1n));
  await waitFor(() => expect(writes).toBe(1)); expect(screen.getByTestId('session-current')).toHaveTextContent('false');
  await act(async () => graphRead.resolve(resources('/task-graph')));
  expect(screen.queryByRole('button', { name: /Successor/ })).toBeNull();
  await act(async () => write.resolve(denied()));
  await waitFor(() => expect(graphs).toBe(2));
  expect(await screen.findByRole('button', { name: /Successor/ })).toBeVisible();
  expect(screen.getByTestId('session-current')).toHaveTextContent('true');
});
it('keeps Session qualified during an in-flight Step write while locking task writes', async () => {
  const write = deferred<Response>(); let writes = 0;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { writes++; return write.promise; }
    return Promise.resolve(resources(url));
  });
  mount(fetcher); await screen.findByRole('heading', { name: 'Parent' });
  const unsubscribe = sessions.subscribeSteps(projectId, taskId, () => {}); sessions.loadSteps(projectId, taskId);
  await waitFor(() => expect(sessions.canSetStepStatus(projectId, taskId)).toBe(true));
  act(() => sessions.setStepStatus(projectId, taskId, '00000001', 'done', 1n));
  await waitFor(() => expect(writes).toBe(1));
  expect(screen.getByTestId('session-current')).toHaveTextContent('true');
  expect(sessions.captureDirectQualification(projectId, taskId)).not.toBeNull();
  expect(sessions.canSetStepStatus(projectId, taskId)).toBe(false);
  await act(async () => write.resolve(denied())); unsubscribe();
});
it('keeps Session available while a confirmed Step write reconciles, but suspends it if the parent read fails', async () => {
  const parent = deferred<Response>(); const retry = deferred<Response>(); let parentReads = 0; let writes = 0;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { writes++; return Promise.resolve(resourceResponse({ projectId, taskId, version: 2n, steps: [{ ...step, status: 'done' }] }, TEST_VIEWER_ID)); }
    if (url.endsWith(`/tasks/${taskId}`)) return ++parentReads === 1 ? Promise.resolve(resources(url)) : parentReads === 2 ? parent.promise : retry.promise;
    return Promise.resolve(resources(url));
  });
  mount(fetcher); await screen.findByRole('heading', { name: 'Parent' });
  const unsubscribe = sessions.subscribeSteps(projectId, taskId, () => {}); sessions.loadSteps(projectId, taskId);
  await waitFor(() => expect(sessions.canSetStepStatus(projectId, taskId)).toBe(true));
  act(() => sessions.setStepStatus(projectId, taskId, '00000001', 'done', 1n));
  await waitFor(() => expect(writes).toBe(1)); await waitFor(() => expect(parentReads).toBe(2));
  await waitFor(() => expect(sessions.snapshot(projectId, taskId).mutation).toMatchObject({ phase: 'confirmed', reconciling: true }));
  expect(screen.getByTestId('session-current')).toHaveTextContent('true');
  await act(async () => parent.resolve(wireResponse({ error: { code: 'internal_error', message: 'read failed', requestId: 'failed' } }, { status: 503, headers: viewerHeaders(TEST_VIEWER_ID) })));
  await waitFor(() => expect(screen.getByTestId('session-current')).toHaveTextContent('false'));
  act(() => sessions.load(projectId, taskId, 1, 'refresh'));
  await waitFor(() => expect(parentReads).toBe(3));
  expect(screen.getByTestId('session-current')).toHaveTextContent('false');
  await act(async () => retry.resolve(resourceResponse({ ...task, version: 2n }, TEST_VIEWER_ID)));
  await waitFor(() => expect(screen.getByTestId('session-current')).toHaveTextContent('true'));
  unsubscribe();
});
it('keeps Session available after a lost Step receipt while reconciliation is pending', async () => {
  const parent = deferred<Response>(); let parentReads = 0; let writes = 0;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { writes++; return Promise.reject(new Error('connection lost')); }
    if (url.endsWith(`/tasks/${taskId}`)) return ++parentReads === 1 ? Promise.resolve(resources(url)) : parent.promise;
    return Promise.resolve(resources(url));
  });
  mount(fetcher); await screen.findByRole('heading', { name: 'Parent' });
  const unsubscribe = sessions.subscribeSteps(projectId, taskId, () => {}); sessions.loadSteps(projectId, taskId);
  await waitFor(() => expect(sessions.canSetStepStatus(projectId, taskId)).toBe(true));
  act(() => sessions.setStepStatus(projectId, taskId, '00000001', 'done', 1n));
  await waitFor(() => expect(writes).toBe(1)); await waitFor(() => expect(parentReads).toBe(2));
  expect(sessions.snapshot(projectId, taskId).mutation).toMatchObject({ phase: 'unknown', reconciling: true });
  expect(screen.getByTestId('session-current')).toHaveTextContent('true');
  expect(sessions.captureDirectSessionQualification(projectId, taskId)).not.toBeNull();
  await act(async () => parent.resolve(resources(`/tasks/${taskId}`))); unsubscribe();
});
it('keeps the reopened Session usable while an earlier Step write remains in flight', async () => {
  const write = deferred<Response>(); let writes = 0;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { writes++; return write.promise; }
    return Promise.resolve(resources(url));
  });
  mount(fetcher); await screen.findByRole('heading', { name: 'Parent' });
  const unsubscribe = sessions.subscribeSteps(projectId, taskId, () => {}); sessions.loadSteps(projectId, taskId);
  await waitFor(() => expect(sessions.canSetStepStatus(projectId, taskId)).toBe(true));
  act(() => sessions.setStepStatus(projectId, taskId, '00000001', 'done', 1n)); await waitFor(() => expect(writes).toBe(1));
  act(() => { sessions.releaseRead(projectId, taskId); sessions.openDirect(projectId, taskId); });
  await waitFor(() => expect(sessions.snapshot(projectId, taskId)).toMatchObject({ status: 'ready', detail: { title: 'Parent' } }));
  await waitFor(() => expect(screen.getByTestId('session-current')).toHaveTextContent('true'));
  expect(sessions.captureDirectSessionQualification(projectId, taskId)).not.toBeNull();
  expect(sessions.canSetStepStatus(projectId, taskId)).toBe(false);
  await act(async () => write.resolve(denied())); unsubscribe();
});
it('suspends a reopened Session after retired Step 404 parent verification fails until a fresh parent succeeds', async () => {
  const write = deferred<Response>(); const retry = deferred<Response>(); let parentReads = 0; let writes = 0; let failParent = false; let failed = false;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { writes++; return write.promise; }
    if (url.endsWith(`/tasks/${taskId}`)) {
      parentReads++;
      if (failParent && !failed) { failed = true; return Promise.resolve(wireResponse({ error: { code: 'internal_error', message: 'unavailable', requestId: 'failed' } }, { status: 503, headers: viewerHeaders(TEST_VIEWER_ID) })); }
      if (failed) return retry.promise.then(response => response.clone());
    }
    return Promise.resolve(resources(url));
  });
  mount(fetcher); await screen.findByRole('heading', { name: 'Parent' });
  const unsubscribe = sessions.subscribeSteps(projectId, taskId, () => {}); sessions.loadSteps(projectId, taskId);
  await waitFor(() => expect(sessions.canSetStepStatus(projectId, taskId)).toBe(true));
  act(() => sessions.setStepStatus(projectId, taskId, '00000001', 'done', 1n)); await waitFor(() => expect(writes).toBe(1));
  act(() => { sessions.releaseRead(projectId, taskId); sessions.openDirect(projectId, taskId); });
  await waitFor(() => expect(parentReads).toBeGreaterThanOrEqual(2)); await waitFor(() => expect(sessions.snapshot(projectId, taskId)).toMatchObject({ status: 'ready', detail: { title: 'Parent' } }));
  await waitFor(() => expect(screen.getByTestId('session-current')).toHaveTextContent('true'));
  failParent = true;
  await act(async () => write.resolve(wireResponse({ error: { code: 'not_found', message: 'missing step', requestId: 'missing' } }, { status: 404, headers: viewerHeaders(TEST_VIEWER_ID) })));
  await waitFor(() => expect(failed).toBe(true)); await waitFor(() => expect(screen.getByTestId('session-current')).toHaveTextContent('false'));
  const beforeRetry = parentReads;
  act(() => sessions.load(projectId, taskId, 1, 'refresh')); await waitFor(() => expect(parentReads).toBeGreaterThan(beforeRetry));
  expect(screen.getByTestId('session-current')).toHaveTextContent('false');
  await act(async () => retry.resolve(resources(`/tasks/${taskId}`)));
  await waitFor(() => expect(screen.getByTestId('session-current')).toHaveTextContent('true'));
  unsubscribe();
});

function mountIdentityCheck(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  let setChecking!: (value: boolean) => void;
  function Harness() {
    const [checking, set] = useState(false); setChecking = set;
    const [navigation, setNavigation] = useState<{ tab: 'overview' | 'attachments' | 'steps' | 'discussion' | 'session'; path: string | null }>({ tab: 'overview', path: null });
    return <CurrentAccountProvider user={{ id: TEST_VIEWER_ID, name: null }} admissionBlocked={checking}>
      <TaskDetailSessionProvider><Capture /><TaskDetailSurface presentation="page" projectId={projectId} taskId={taskId} observation={{ kind: 'direct' }} navigation={navigation} onNavigate={setNavigation} onSelectTask={vi.fn()} onRefreshGraph={vi.fn()} fullscreen={{ active: false, onChange: vi.fn() }} /></TaskDetailSessionProvider>
    </CurrentAccountProvider>;
  }
  const view = renderWithLocale(<Harness />, { locale: 'en', taskCache: { scope } });
  return { scope, setChecking, view };
}
function identityResources(url: string) {
  const unclaimed = detailFixture(projectId, taskId, { title: 'Parent' });
  if (url.includes('/task-graph')) return resourceResponse(graphFixture([unclaimed, successor]), TEST_VIEWER_ID);
  if (url.endsWith(`/tasks/${taskId}`)) return resourceResponse(unclaimed, TEST_VIEWER_ID);
  if (url.includes('/task-assignees')) return resourceResponse({ items: [{ userId: otherId, version: 'a'.repeat(64), name: 'Alice', avatarUrl: null, hasProjectAccess: true }], unresolvedUserIds: [] }, TEST_VIEWER_ID);
  return resources(url);
}
it('retains the direct relations, open assignee menu and search during an identity check without requests or writes', async () => {
  const fetcher = vi.fn((url: string, _options?: RequestInit) => Promise.resolve(identityResources(url)));
  const { scope, setChecking, view } = mountIdentityCheck(fetcher);
  let resume: (() => void) | undefined;
  try {
    await screen.findByRole('button', { name: /Successor/ });
    fireEvent.click(screen.getByRole('button', { name: /^Assignee:/ }));
    const option = await screen.findByRole('option', { name: 'Alice' });
    const search = screen.getByRole('textbox', { name: 'Search people' });
    fireEvent.change(search, { target: { value: 'Ali' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' }); expect(option).toHaveFocus();
    const count = fetcher.mock.calls.length;
    act(() => { resume = pauseAuthRequests(); setChecking(true); });
    expect(screen.getByRole('button', { name: /Successor/ })).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Assignee' })).toBeVisible();
    expect(search).toHaveValue('Ali'); expect(option).toHaveFocus(); expect(option).toHaveAttribute('aria-disabled', 'true');
    expect(document.querySelector('.task-detail-retained')).toBeNull();
    fireEvent.click(option); await userEvent.setup().keyboard('{Enter}'); expect(option).toHaveFocus(); expect(screen.getByRole('dialog', { name: 'Assignee' })).toBeVisible();
    act(() => sessions.load(projectId, taskId, 1, 'automatic'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(fetcher.mock.calls).toHaveLength(count);
    act(() => { resume?.(); resume = undefined; setChecking(false); });
    expect(search).toHaveValue('Ali'); await waitFor(() => expect(option).toHaveAttribute('aria-disabled', 'false')); expect(option).toHaveFocus();
    expect(fetcher.mock.calls.every(([, options]) => options?.method !== 'PATCH')).toBe(true);
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});
it('withdraws retained direct relations and the assignee menu when access is revoked during an identity check', async () => {
  const fetcher = vi.fn((url: string, _options?: RequestInit) => Promise.resolve(identityResources(url)));
  const { scope, setChecking, view } = mountIdentityCheck(fetcher); let resume: (() => void) | undefined;
  try {
    await screen.findByRole('button', { name: /Successor/ });
    fireEvent.click(screen.getByRole('button', { name: /^Assignee:/ }));
    await screen.findByRole('option', { name: 'Alice' });
    act(() => { resume = pauseAuthRequests(); setChecking(true); });
    act(() => scope.suspendProject(projectId));
    expect(screen.queryByRole('button', { name: /Successor/ })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Assignee' })).toBeNull();
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});
it('withdraws the retained menu and relations when the task history changes', async () => {
  const fetcher = vi.fn((url: string, _options?: RequestInit) => Promise.resolve(identityResources(url)));
  const { scope, view } = mountIdentityCheck(fetcher);
  try {
    await screen.findByRole('button', { name: /Successor/ });
    fireEvent.click(screen.getByRole('button', { name: /^Assignee:/ }));
    await screen.findByRole('option', { name: 'Alice' });
    const signal = new AbortController().signal;
    const fence = await scope.beginTaskRead(projectId, taskId, 0, 0, signal);
    await act(async () => { expect(await scope.observeHistory(fence, '40000000-0000-4000-8000-000000000001', signal)).toBe('retired'); });
    expect(screen.queryByRole('button', { name: /Successor/ })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Assignee' })).toBeNull();
  } finally { view.unmount(); scope.dispose(); }
});

const openTaskReview = (kind: 'status' | 'delete' | 'platform' | 'agents') => {
  if (kind === 'status') { fireEvent.click(document.querySelector('.task-status-trigger')!); fireEvent.click(screen.getByRole('menuitemradio', { name: 'Done' })); }
  else if (kind === 'delete') { fireEvent.click(screen.getByRole('button', { name: 'More task actions' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Delete task' })); }
  else if (kind === 'platform') fireEvent.change(screen.getByRole('combobox', { name: 'Execution platform' }), { target: { value: 'linux' } });
  else fireEvent.click(screen.getByRole('switch', { name: 'Automatic execution' }));
  return screen.getByRole('alertdialog');
};
it.each(['status', 'delete', 'platform', 'agents'] as const)('retains the %s confirmation across same-account verification and forbids submission until it finishes', async kind => {
  const fetcher = vi.fn((url: string, _options?: RequestInit) => Promise.resolve(identityResources(url)));
  const { scope, setChecking, view } = mountIdentityCheck(fetcher); let resume: (() => void) | undefined;
  try {
    await screen.findByRole('button', { name: /Successor/ }); const confirmation = openTaskReview(kind);
    const submit = confirmation.querySelector<HTMLButtonElement>('.dialog-footer button:last-child')!; expect(submit).toHaveAttribute('aria-disabled', 'false');
    act(() => submit.focus()); expect(submit).toHaveFocus();
    const count = fetcher.mock.calls.length;
    act(() => { resume = pauseAuthRequests(); setChecking(true); });
    expect(screen.getByRole('alertdialog')).toBe(confirmation); expect(submit).toHaveAttribute('aria-disabled', 'true'); expect(submit).toHaveFocus(); fireEvent.click(submit); await userEvent.setup().keyboard('{Enter}'); expect(submit).toHaveFocus();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(fetcher.mock.calls).toHaveLength(count); expect(screen.getByRole('alertdialog')).toBe(confirmation);
    act(() => { resume?.(); resume = undefined; setChecking(false); });
    expect(screen.getByRole('alertdialog')).toBe(confirmation); await waitFor(() => expect(submit).toHaveAttribute('aria-disabled', 'false'));
    fireEvent.click(submit); await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === 'PUT' || options?.method === 'PATCH' || options?.method === 'DELETE')).toBe(true));
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});
it('retains an open task status menu during identity verification', async () => {
  const fetcher = vi.fn((url: string, _options?: RequestInit) => Promise.resolve(identityResources(url)));
  const { scope, setChecking, view } = mountIdentityCheck(fetcher); let resume: (() => void) | undefined;
  try {
    await screen.findByRole('button', { name: /Successor/ }); fireEvent.click(document.querySelector('.task-status-trigger')!);
    const menu = screen.getByRole('menu'); act(() => { resume = pauseAuthRequests(); setChecking(true); });
    expect(screen.getByRole('menu')).toBe(menu); expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
    act(() => { resume?.(); resume = undefined; setChecking(false); }); expect(screen.getByRole('menu')).toBe(menu);
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});
it.each(['access', 'identity'] as const)('withdraws an open task confirmation when %s retires during verification', async retirement => {
  const fetcher = vi.fn((url: string, _options?: RequestInit) => Promise.resolve(identityResources(url)));
  const { scope, setChecking, view } = mountIdentityCheck(fetcher); let resume: (() => void) | undefined;
  try {
    await screen.findByRole('button', { name: /Successor/ }); openTaskReview('status');
    act(() => { resume = pauseAuthRequests(); setChecking(true); });
    if (retirement === 'access') act(() => scope.suspendProject(projectId));
    else await act(async () => { await scope.invalidateScope(); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});
it('retains Step status and actions menus and deletion confirmation across identity verification without writes', async () => {
  const fetcher = vi.fn((url: string, _options?: RequestInit) => Promise.resolve(identityResources(url)));
  const { scope, setChecking, view } = mountIdentityCheck(fetcher); let resume: (() => void) | undefined;
  const pause = () => act(() => { resume = pauseAuthRequests(); setChecking(true); });
  const unpause = () => act(() => { resume?.(); resume = undefined; setChecking(false); });
  try {
    await screen.findByRole('button', { name: /Successor/ }); fireEvent.click(screen.getByRole('tab', { name: 'Steps' }));
    const trigger = await screen.findByRole('button', { name: /Status for Step/ });
    await waitFor(() => expect(trigger).toHaveAttribute('aria-disabled', 'false'));
    fireEvent.click(trigger); const menu = screen.getByRole('menu', { name: 'Status for Step' });
    const done = screen.getByRole('menuitemradio', { name: 'Done' }); act(() => done.focus()); expect(done).toHaveFocus();
    const statusBlur = vi.fn(); done.addEventListener('focusout', statusBlur);
    pause(); expect(screen.getByRole('menu', { name: 'Status for Step' })).toBe(menu);
    expect(done).toHaveFocus(); expect(done).toBeEnabled(); expect(done).toHaveAttribute('aria-disabled', 'true'); expect(statusBlur).not.toHaveBeenCalled();
    fireEvent.click(done);
    expect(screen.getByRole('menu', { name: 'Status for Step' })).toBe(menu);
    unpause(); expect(screen.getByRole('menu', { name: 'Status for Step' })).toBe(menu);
    fireEvent.keyDown(menu, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Step' }));
    const more = screen.getByRole('menu', { name: 'More actions for Step' });
    const deletion = screen.getByRole('menuitem', { name: 'Delete step' }); act(() => deletion.focus()); expect(deletion).toHaveFocus();
    const moveBlur = vi.fn(); deletion.addEventListener('focusout', moveBlur);
    pause(); expect(screen.getByRole('menu', { name: 'More actions for Step' })).toBe(more);
    expect(deletion).toHaveFocus(); expect(deletion).toBeEnabled(); expect(deletion).toHaveAttribute('aria-disabled', 'true'); expect(moveBlur).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
    fireEvent.click(deletion); expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.keyDown(more, { key: 'Home' }); expect(screen.getByRole('menuitem', { name: 'Add before' })).toHaveFocus();
    unpause(); expect(screen.getByRole('menu', { name: 'More actions for Step' })).toBe(more);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete step' }));
    const confirmation = screen.getByRole('alertdialog'); const submit = confirmation.querySelector<HTMLButtonElement>('.dialog-footer button:last-child')!;
    pause(); expect(screen.getByRole('alertdialog')).toBe(confirmation); expect(submit).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(submit);
    expect(screen.getByRole('alertdialog')).toBe(confirmation);
    expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
    unpause(); await waitFor(() => expect(submit).toHaveAttribute('aria-disabled', 'false')); expect(screen.getByRole('alertdialog')).toBe(confirmation);
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});
it.each(['access', 'identity'] as const)('withdraws an open Step deletion confirmation on %s retirement', async retirement => {
  const fetcher = vi.fn((url: string, _options?: RequestInit) => Promise.resolve(identityResources(url)));
  const { scope, setChecking, view } = mountIdentityCheck(fetcher); let resume: (() => void) | undefined;
  try {
    await screen.findByRole('button', { name: /Successor/ }); fireEvent.click(screen.getByRole('tab', { name: 'Steps' }));
    const trigger = await screen.findByRole('button', { name: 'More actions for Step' });
    await waitFor(() => expect(trigger).toHaveAttribute('aria-disabled', 'false'));
    await waitFor(() => expect(sessions.canSetStepStatus(projectId, taskId)).toBe(true));
    fireEvent.click(trigger); fireEvent.click(screen.getByRole('menuitem', { name: 'Delete step' }));
    act(() => { resume = pauseAuthRequests(); setChecking(true); });
    if (retirement === 'access') act(() => scope.suspendProject(projectId));
    else await act(async () => { await scope.invalidateScope(); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});
it('retains a withdrawal review while access is being rechecked and submits only after both gates recover', async () => {
  const heldAccess = deferred<Response>(); let hold = false; let accessReads = 0;
  const fetcher = vi.fn((url: string, _options?: RequestInit) => {
    if (url.endsWith('/access')) { accessReads++; return hold ? heldAccess.promise : Promise.resolve(resources(url)); }
    return Promise.resolve(resources(url));
  });
  const { scope, setChecking, view } = mountIdentityCheck(fetcher); let resume: (() => void) | undefined;
  try {
    await screen.findByRole('heading', { name: 'Parent' });
    const withdraw = await screen.findByRole('button', { name: 'Force withdraw' }); await waitFor(() => expect(withdraw).toBeEnabled());
    fireEvent.click(withdraw); const confirmation = await screen.findByRole('alertdialog', { name: 'Force withdraw this task?' });
    const submit = confirmation.querySelector<HTMLButtonElement>('.dialog-footer button:last-child')!; expect(submit).toHaveAttribute('aria-disabled', 'false');
    hold = true; const before = accessReads; act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(accessReads).toBeGreaterThan(before));
    expect(screen.getByRole('alertdialog')).toBe(confirmation); expect(submit).toHaveAttribute('aria-disabled', 'true');
    act(() => { resume = pauseAuthRequests(); setChecking(true); }); fireEvent.click(submit);
    expect(screen.getByRole('alertdialog')).toBe(confirmation); expect(submit).toHaveAttribute('aria-disabled', 'true');
    expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
    act(() => { resume?.(); resume = undefined; setChecking(false); }); expect(submit).toHaveAttribute('aria-disabled', 'true');
    await act(async () => heldAccess.resolve(resources(`/api/v1/projects/${projectId}/access`)));
    await waitFor(() => expect(submit).toHaveAttribute('aria-disabled', 'false')); expect(screen.getByRole('alertdialog')).toBe(confirmation);
    fireEvent.click(submit); await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true));
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});

it.each(['access', 'identity'] as const)('withdraws an open Claim review on %s retirement', async retirement => {
  const fetcher = vi.fn((url: string, _options?: RequestInit) => Promise.resolve(resources(url)));
  const { scope, setChecking, view } = mountIdentityCheck(fetcher); let resume: (() => void) | undefined;
  try {
    await screen.findByRole('heading', { name: 'Parent' }); const button = await screen.findByRole('button', { name: 'Force withdraw' });
    await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
    await screen.findByRole('alertdialog', { name: 'Force withdraw this task?' });
    act(() => { resume = pauseAuthRequests(); setChecking(true); });
    if (retirement === 'access') act(() => scope.suspendProject(projectId));
    else await act(async () => { await scope.invalidateScope(); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});
it('retains the open task actions menu during identity verification', async () => {
  const fetcher = vi.fn((url: string, _options?: RequestInit) => Promise.resolve(identityResources(url)));
  const { scope, setChecking, view } = mountIdentityCheck(fetcher); let resume: (() => void) | undefined;
  try {
    await screen.findByRole('button', { name: /Successor/ }); fireEvent.click(screen.getByRole('button', { name: 'More task actions' }));
    const menu = screen.getByRole('menu', { name: 'More task actions' });
    act(() => { resume = pauseAuthRequests(); setChecking(true); });
    expect(screen.getByRole('menu', { name: 'More task actions' })).toBe(menu);
    expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
    act(() => { resume?.(); resume = undefined; setChecking(false); }); expect(screen.getByRole('menu', { name: 'More task actions' })).toBe(menu);
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});
it('does not expose a new withdrawal action while project access is being rechecked', async () => {
  const heldAccess = deferred<Response>(); let hold = false; let accessReads = 0;
  const fetcher = vi.fn((url: string, _options?: RequestInit) => {
    if (url.endsWith('/access')) { accessReads++; return hold ? heldAccess.promise : Promise.resolve(resources(url)); }
    return Promise.resolve(resources(url));
  });
  const { scope, view } = mountIdentityCheck(fetcher);
  try {
    await screen.findByRole('heading', { name: 'Parent' });
    const withdraw = await screen.findByRole('button', { name: 'Force withdraw' }); await waitFor(() => expect(withdraw).toBeEnabled());
    hold = true; const before = accessReads; act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(accessReads).toBeGreaterThan(before));
    expect(screen.queryByRole('button', { name: 'Force withdraw' })).toBeNull();
    await act(async () => heldAccess.resolve(resources(`/api/v1/projects/${projectId}/access`)));
    expect(await screen.findByRole('button', { name: 'Force withdraw' })).toBeEnabled();
  } finally { view.unmount(); scope.dispose(); }
});
