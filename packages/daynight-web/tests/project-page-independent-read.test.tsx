import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, getTaskSync } from '../src/api/client';
import { getProjectAccess } from '../src/api/auth';
import { getProject } from '../src/api/project-settings';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { ProjectAccessBoundary, useProjectAccessSession, type ProjectAccessSession } from '../src/features/projects/ProjectAccess';
import { useProjectPageRead } from '../src/features/projects/useProjectPageRead';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { LocaleProvider } from '../src/i18n/LocaleProvider';
import { TestTaskCacheBoundary } from './helpers/taskCache';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { directAccessFixture, taskSyncFromGraph, taskSyncReadFixture, TEST_VIEWER_ID } from './helpers/taskSync';

vi.mock('../src/api/client', async original => ({ ...await original<typeof import('../src/api/client')>(), getTaskSync: vi.fn() }));
vi.mock('../src/api/auth', async original => ({ ...await original<typeof import('../src/api/auth')>(), getProjectAccess: vi.fn() }));
vi.mock('../src/api/project-settings', async original => ({ ...await original<typeof import('../src/api/project-settings')>(), getProject: vi.fn() }));

const projectId = '00000000-0000-4000-8000-000000000031';
const otherUser = '00000000-0000-4000-8000-000000000202';
const graph = graphFixture([detailFixture(projectId, '00000000-0000-4000-8000-000000000041', { title: 'Graph task' })]);
const project = { ...graph.project, name: 'Independent project', repoUrl: 'https://github.com/example/independent' };
const sync = taskSyncReadFixture(taskSyncFromGraph(graph, { versionForTask: () => 1n }));
const scopes: TaskCacheScope[] = [];
const scope = (userId = TEST_VIEWER_ID) => {
  const value = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  scopes.push(value); return value;
};
const page = (value: TaskCacheScope) => <LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={value}>
  <ProjectPage projectId={projectId} renderActions={item => <a href={`/projects/${item.id}/settings`}>Manage {item.name}</a>} />
</TestTaskCacheBoundary></LocaleProvider>;

beforeEach(() => {
  window.history.replaceState(null, '', `/projects/${projectId}`);
  vi.mocked(getProjectAccess).mockReset().mockImplementation(async (_id, _signal, admission) => directAccessFixture(projectId, admission.userId));
  vi.mocked(getProject).mockReset().mockResolvedValue(project);
  vi.mocked(getTaskSync).mockReset();
});
afterEach(() => { for (const value of scopes.splice(0)) value.dispose(); });

it('keeps project facts and management available in both sections when the graph is pending or fails', async () => {
  const pending = Promise.withResolvers<typeof sync>();
  vi.mocked(getTaskSync).mockReturnValueOnce(pending.promise).mockResolvedValue(sync);
  render(page(scope()));
  await screen.findByRole('heading', { name: 'Independent project' });
  expect(screen.getByText(project.repoUrl)).toBeVisible();
  expect(screen.getByRole('link', { name: 'Manage Independent project' })).toBeVisible();
  expect(screen.getByRole('status', { name: 'Loading task graph' })).toBeVisible();
  const tabs = screen.getByRole('tablist', { name: 'Project views' });
  expect(within(tabs).getAllByRole('tab')).toHaveLength(4);
  fireEvent.click(within(tabs).getByRole('tab', { name: 'Task list' }));
  expect(screen.getByRole('textbox', { name: /Search task IDs/ })).toBeVisible();
  await waitFor(() => expect(getTaskSync).toHaveBeenCalledOnce());
  await act(async () => { pending.reject(new ApiError('server', 500, 'internal_error', 'graph-failure')); });
  expect(await screen.findByRole('alert')).toHaveTextContent('graph-failure');
  expect(screen.getByRole('heading', { name: 'Independent project' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: /Search task IDs/ })).toBeVisible();
  fireEvent.click(within(tabs).getByRole('tab', { name: 'Overview' }));
  expect(screen.getByRole('alert')).toHaveTextContent('graph-failure');
  expect(screen.getByRole('link', { name: 'Manage Independent project' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(screen.getByRole('heading', { name: 'Independent project' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: graph.project.name })).toBeNull();
});

it('lets a slow project read finish across polling intervals and focus recovery', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const pending = Promise.withResolvers<typeof project>();
  const started = Promise.withResolvers<AbortSignal>();
  vi.mocked(getProject).mockImplementationOnce((_id, signal, _admission, onDispatch) => { onDispatch?.(); started.resolve(signal); return pending.promise; }).mockResolvedValue(project);
  vi.mocked(getProjectAccess).mockReturnValue(new Promise(() => {}));
  vi.mocked(getTaskSync).mockReturnValue(new Promise(() => {}));
  render(page(scope()));
  let deadline!: ReturnType<typeof setTimeout>;
  const signal = await Promise.race([started.promise, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Project read did not start')), 5_000); })]).finally(() => clearTimeout(deadline));
  await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
  fireEvent(window, new Event('focus'));
  expect(signal.aborted).toBe(false);
  expect(getProject).toHaveBeenCalledOnce();
  await act(async () => { pending.resolve(project); });
  await screen.findByRole('heading', { name: 'Independent project' });
  expect(screen.getByText(project.repoUrl)).toBeVisible();
});

it('withdraws project facts on access revocation and rejects a late read', async () => {
  const old = Promise.withResolvers<typeof project>(), fresh = Promise.withResolvers<typeof project>();
  vi.mocked(getTaskSync).mockReturnValue(new Promise(() => {}));
  vi.mocked(getProject).mockResolvedValueOnce(project)
    .mockImplementationOnce((_id, _signal, _admission, onDispatch) => { onDispatch?.(); return old.promise; })
    .mockImplementation((_id, _signal, _admission, onDispatch) => { onDispatch?.(); return fresh.promise; });
  const current = scope();
  render(page(current));
  await screen.findByRole('heading', { name: 'Independent project' });
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
  const oldSignal = vi.mocked(getProject).mock.calls[1]![1];
  act(() => current.suspendProject(projectId));
  expect(oldSignal.aborted).toBe(true);
  expect(screen.queryByRole('heading', { name: 'Independent project' })).toBeNull();
  expect(screen.queryByText(project.repoUrl)).toBeNull();
  expect(screen.queryByRole('link', { name: 'Manage Independent project' })).toBeNull();
  await waitFor(() => expect(getProject).toHaveBeenCalledTimes(3));
  await act(async () => { old.resolve(project); });
  expect(screen.queryByRole('heading', { name: 'Independent project' })).toBeNull();
  await act(async () => { fresh.resolve({ ...project, name: 'Rechecked project' }); });
  await screen.findByRole('heading', { name: 'Rechecked project' });
});

it('does not expose the previous identity project while the replacement identity reads', async () => {
  const pending = Promise.withResolvers<typeof project>();
  vi.mocked(getTaskSync).mockReturnValue(new Promise(() => {}));
  vi.mocked(getProject).mockResolvedValueOnce(project).mockReturnValue(pending.promise);
  const view = render(page(scope()));
  await screen.findByRole('heading', { name: 'Independent project' });
  view.rerender(page(scope(otherUser)));
  expect(screen.queryByRole('heading', { name: 'Independent project' })).toBeNull();
  expect(screen.queryByText(project.repoUrl)).toBeNull();
  expect(screen.queryByRole('link', { name: 'Manage Independent project' })).toBeNull();
  await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
  await act(async () => { pending.resolve({ ...project, name: 'New identity project' }); });
  await screen.findByRole('heading', { name: 'New identity project' });
});

it('reads project metadata when the task cache cannot begin a sync', async () => {
  const current = scope();
  vi.spyOn(current, 'beginSync').mockRejectedValue(new Error('cache unavailable'));
  render(page(current));
  await screen.findByRole('heading', { name: 'Independent project' });
  expect(screen.getByText(project.repoUrl)).toBeVisible();
  expect(screen.getByRole('link', { name: 'Manage Independent project' })).toBeVisible();
  expect(await screen.findByRole('alert')).toBeVisible();
});

it('withdraws project and task data after a trusted project 404 even when access verification fails', async () => {
  let denied = false;
  vi.mocked(getTaskSync).mockResolvedValue(sync);
  vi.mocked(getProject).mockImplementation(async () => { if (denied) throw new ApiError('server', 404, 'not_found'); return project; });
  vi.mocked(getProjectAccess).mockImplementation(async () => { if (denied) throw new ApiError('network'); return directAccessFixture(projectId); });
  render(page(scope()));
  await screen.findByRole('heading', { name: 'Independent project' });
  fireEvent.click(screen.getByRole('tab', { name: 'Task list' }));
  await screen.findByRole('tab', { name: 'Standalone tasks' });
  fireEvent.click(screen.getByRole('tab', { name: 'Standalone tasks' }));
  await screen.findByText('Graph task');
  const reads = vi.mocked(getProject).mock.calls.length;
  denied = true;
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(vi.mocked(getProject).mock.calls.length).toBeGreaterThan(reads));
  await waitFor(() => {
    expect(screen.queryByRole('heading', { name: 'Independent project' })).toBeNull();
    expect(screen.queryByText(project.repoUrl)).toBeNull();
    expect(screen.queryByText('Graph task')).toBeNull();
  });
});

it('ignores a late project 404 after a newer read succeeds', async () => {
  const old = Promise.withResolvers<typeof project>();
  let session: ProjectAccessSession | null = null;
  const Probe = () => {
    session = useProjectAccessSession(projectId);
    const result = useProjectPageRead(projectId);
    return <><p>{result.project?.name ?? 'Loading'}</p><button onClick={result.retry}>Retry project</button></>;
  };
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={scope()}>
    <ProjectAccessBoundary projectId={projectId}><Probe /></ProjectAccessBoundary>
  </TestTaskCacheBoundary></LocaleProvider>);
  await screen.findByText('Independent project');
  await waitFor(() => expect(session!.snapshot().refreshing).toBe(false));
  vi.mocked(getProject).mockReset().mockReturnValueOnce(old.promise).mockResolvedValue({ ...project, name: 'Current project' });
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(getProject).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'Retry project' }));
  await screen.findByText('Current project');
  await act(async () => { old.reject(new ApiError('server', 404, 'not_found')); });
  expect(screen.getByText('Current project')).toBeVisible();
});

it('accepts a project read despite newer successful task-sync access observations', async () => {
  const old = Promise.withResolvers<typeof project>();
  vi.mocked(getProject).mockResolvedValue(project);
  let session: ProjectAccessSession | null = null;
  const Probe = () => {
    session = useProjectAccessSession(projectId);
    const result = useProjectPageRead(projectId);
    return <p>{result.project?.name ?? 'Loading'}</p>;
  };
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={scope()}>
    <ProjectAccessBoundary projectId={projectId}><Probe /></ProjectAccessBoundary>
  </TestTaskCacheBoundary></LocaleProvider>);
  await screen.findByText('Independent project');
  await waitFor(() => expect(session!.snapshot().refreshing).toBe(false));
  vi.mocked(getProject).mockReset().mockImplementationOnce((_id, _signal, _admission, onDispatch) => { onDispatch?.(); return old.promise; });
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(getProject).toHaveBeenCalledTimes(1));
  act(() => { for (let index = 0; index < 3; index++) expect(session!.publishSync(session!.beginObservation(), directAccessFixture(projectId))).toBe(true); });
  await act(async () => { old.resolve({ ...project, name: 'Current project' }); });
  await screen.findByText('Current project');
  expect(getProject).toHaveBeenCalledOnce();
});
