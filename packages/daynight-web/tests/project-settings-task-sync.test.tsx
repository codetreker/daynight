import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { TaskCacheLifecycleChanged } from '../src/features/task-cache/lifecycle';
import { TaskSyncCard } from '../src/features/management/project-settings/TaskSyncCard';
import { createLocaleRender } from './helpers/renderWithLocale';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), access: { status: 'ready', access: { effectiveRole: 'member' }, session: { beginObservation: vi.fn(() => 1), publishSync: vi.fn(), requireProjectReadRecheck: vi.fn(), retryProjectRead: vi.fn(), scope: { signal: new AbortController().signal, mismatchSignal: new AbortController().signal, isInvalidated: false, hasIdentityMismatch: false, beginSync: vi.fn(), getProjectReadRevision: vi.fn(() => 0), isSyncCommitCurrent: vi.fn(() => true), notifyTagColors: vi.fn(), canRevokeProjectRead: vi.fn(() => true), revokeProject: vi.fn() } } } }));
vi.mock('../src/features/projects/ProjectAccess', () => ({ useProjectAccess: () => mocks.access }));
vi.mock('../src/features/task-cache/task-sync-execution', () => ({ executeTaskSync: mocks.execute }));
const projectId = '00000000-0000-4000-8000-000000000003';
const ticket = { projectId };
const applied = (tasks: unknown[]) => ({ history: 'current', project: { manifest: {} }, sync: { actorAccess: {}, tasks } });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.status = 'ready'; mocks.access.access = { effectiveRole: 'member' };
  mocks.access.session.scope.beginSync.mockResolvedValue(ticket);
  mocks.access.session.scope.isSyncCommitCurrent.mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

it('coalesces clicks and reports a successful empty snapshot for a project member', async () => {
  const request = deferred<ReturnType<typeof applied>>(); mocks.execute.mockReturnValue(request.promise);
  createLocaleRender('en')(<TaskSyncCard projectId={projectId} active onRoute />);
  const button = screen.getByRole('button', { name: 'Resync' });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
  expect(button).toHaveTextContent('Syncing…'); expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ projectId, ticket, trigger: 'manual-rebuild' }));
  await act(async () => request.resolve(applied([])));
  expect(screen.getByText('Tasks synced. This project has no tasks.')).toBeVisible();
  expect(mocks.access.session.publishSync).toHaveBeenCalledWith(1, {});
});

it('shows retry after a failed request and succeeds on a manual retry', async () => {
  mocks.execute.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(applied([{}]));
  createLocaleRender('zh-CN')(<TaskSyncCard projectId={projectId} active onRoute />);
  fireEvent.click(screen.getByRole('button', { name: '重新同步' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('任务同步失败。已保留此浏览器中的任务缓存。');
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('任务已同步。')).toBeVisible();
  expect(mocks.execute).toHaveBeenCalledTimes(2);
});

it('cancels the request and ignores its late result after leaving the section', async () => {
  const request = deferred<ReturnType<typeof applied>>(); mocks.execute.mockReturnValue(request.promise);
  const view = createLocaleRender('en')(<TaskSyncCard projectId={projectId} active onRoute />);
  fireEvent.click(screen.getByRole('button', { name: 'Resync' }));
  await waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
  const signal = mocks.execute.mock.calls[0]![0].signal as AbortSignal;
  view.rerender(<TaskSyncCard projectId={projectId} active={false} onRoute />);
  expect(signal.aborted).toBe(true);
  await act(async () => request.resolve(applied([{}])));
  expect(screen.queryByText('Tasks synced.')).toBeNull();
  expect(mocks.access.session.publishSync).not.toHaveBeenCalled();
});

it('withdraws the matching project on a current not-found response', async () => {
  mocks.execute.mockRejectedValue(new ApiError('server', 404, 'not_found'));
  createLocaleRender('en')(<TaskSyncCard projectId={projectId} active onRoute />);
  fireEvent.click(screen.getByRole('button', { name: 'Resync' }));
  await waitFor(() => expect(mocks.access.session.scope.revokeProject).toHaveBeenCalled());
  expect(mocks.access.session.scope.canRevokeProjectRead).toHaveBeenCalledWith(ticket, 0);
});


it('offers a retry when a concurrent commit rejects the snapshot', async () => {
  mocks.execute.mockRejectedValue(new TaskCacheLifecycleChanged());
  createLocaleRender('en')(<TaskSyncCard projectId={projectId} active onRoute />);
  fireEvent.click(screen.getByRole('button', { name: 'Resync' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Task sync failed');
  expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
});

it('retains task access refusal across project refresh and retries only on request', async () => {
  mocks.execute.mockRejectedValueOnce(new ApiError('server', 403, 'forbidden')).mockResolvedValueOnce(applied([{}]));
  const view = createLocaleRender('en')(<TaskSyncCard projectId={projectId} active onRoute />);
  fireEvent.click(screen.getByRole('button', { name: 'Resync' }));
  expect(await screen.findByText('You do not have permission to read tasks in this project.')).toBeVisible();
  mocks.access.access = { effectiveRole: 'member' };
  view.rerender(<TaskSyncCard projectId={projectId} active onRoute />);
  expect(screen.getByText('You do not have permission to read tasks in this project.')).toBeVisible();
  expect(mocks.execute).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Tasks synced.')).toBeVisible();
});
