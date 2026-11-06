import { act, cleanup, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
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
