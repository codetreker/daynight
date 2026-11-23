import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { ProjectAccessBoundary } from '../src/features/projects/ProjectAccess';
import { TaskDetailSessionBoundary } from '../src/features/task-detail/TaskDetailSession';
import { useTaskDetail } from '../src/features/task-detail/useTaskDetail';
import { OrdinaryTaskRelations } from '../src/features/task-detail/OrdinaryTaskRelations';
import { detailFixture, graphFixture, resourceResponse } from './helpers/taskDetail';
import { directAccessFixture, taskSyncFromGraph, taskSyncEpoch, TEST_VIEWER_ID } from './helpers/taskSync';
import { renderWithLocale } from './helpers/renderWithLocale';

const projectId = '00000000-0000-4000-8000-000000000100';
const parentId = '00000000-0000-4000-8000-000000000001';
const childId = '00000000-0000-4000-8000-000000000002';
const parent = detailFixture(projectId, parentId, { title: 'Parent', parentTaskId: null });
const child = detailFixture(projectId, childId, { title: 'Child', parentTaskId: parentId });

const prepare = async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const graph = graphFixture([parent]);
  const ticket = await scope.beginSync(projectId, scope.signal);
  await scope.applySync(ticket, taskSyncFromGraph(graph, { epoch: taskSyncEpoch(projectId), versionForTask: () => 1n, propertiesForTask: () => parent.properties }), scope.signal);
  return { scope, graph };
};

it('qualifies summary-backed Task using a real cache history and discards a late page after the parent version changes', async () => {
  const { scope, graph } = await prepare();
  const pending = Promise.withResolvers<Response>();
  let listReads = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/access')) return resourceResponse(directAccessFixture(projectId), TEST_VIEWER_ID);
    if (parsed.pathname === `/api/v1/projects/${projectId}/tasks/${parentId}`) return resourceResponse(parent, TEST_VIEWER_ID);
    if (parsed.pathname === `/api/v1/projects/${projectId}/tasks` && parsed.searchParams.get('parentTaskId') === parentId) { listReads++; return pending.promise; }
    throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const node = graph.tasks[0]!;
  const Harness = ({ version }: { version: bigint }) => {
    const task = useTaskDetail(projectId, parentId, { kind: 'project-summary', revision: 1, task: node });
    return task.detail === null || task.requiresFreshRead ? <p>Waiting for detail</p> : <OrdinaryTaskRelations projectId={projectId} detail={{ ...task.detail, version }} history={task.historyGeneration} active onRefreshGraph={() => {}} />;
  };
  const renderPage = (version: bigint) => <ProjectAccessBoundary projectId={projectId}><TaskDetailSessionBoundary><Harness version={version} /></TaskDetailSessionBoundary></ProjectAccessBoundary>;
  const view = renderWithLocale(renderPage(1n), { locale: 'en', taskCache: { scope } });
  try {
    await waitFor(() => expect(listReads).toBe(1));
    view.rerender(renderPage(2n));
    await act(async () => { pending.resolve(resourceResponse({ items: [child], nextCursor: null }, TEST_VIEWER_ID)); await pending.promise; });
    expect(screen.queryByText('Child')).toBeNull();
    expect(screen.getByRole('button', { name: 'New subtask' })).toBeDisabled();
  } finally { view.unmount(); scope.dispose(); vi.unstubAllGlobals(); }
});

it('admits a matching live Task and submits the fixed parent through real access and cache providers', async () => {
  const { scope } = await prepare();
  const writes: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/access')) return resourceResponse(directAccessFixture(projectId), TEST_VIEWER_ID);
    if (parsed.pathname === `/api/v1/projects/${projectId}/tasks/${parentId}`) return resourceResponse(parent, TEST_VIEWER_ID);
    if (parsed.pathname === `/api/v1/projects/${projectId}/tasks` && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); writes.push(body);
      const result = resourceResponse({ ...child, title: body.title, description: body.description, assignedTo: body.assignedTo, status: body.status, ready: body.status === 'todo' }, TEST_VIEWER_ID);
      return new Response(result.body, { status: 201, headers: result.headers });
    }
    if (parsed.pathname === `/api/v1/projects/${projectId}/tasks`) return resourceResponse({ items: [], nextCursor: null }, TEST_VIEWER_ID);
    if (parsed.pathname.endsWith('/task-assignees')) return resourceResponse({ items: [], unresolvedUserIds: [] }, TEST_VIEWER_ID);
    throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`);
  }));
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  const view = renderWithLocale(<ProjectAccessBoundary projectId={projectId} initialRead><OrdinaryTaskRelations projectId={projectId} detail={parent} history={scope.getHistoryGeneration(projectId)} active onRefreshGraph={() => {}} /></ProjectAccessBoundary>, { locale: 'en', taskCache: { scope }, container: root });
  try {
    await screen.findByText('No subtasks');
    fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Repair' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ title: 'Repair', parentTaskId: parentId });
  } finally { view.unmount(); root.remove(); scope.dispose(); vi.unstubAllGlobals(); }
});

it('does not publish a late child page after the real project history is retired', async () => {
  const { scope } = await prepare();
  const pending = Promise.withResolvers<Response>();
  let listReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/access')) return resourceResponse(directAccessFixture(projectId), TEST_VIEWER_ID);
    if (parsed.pathname === `/api/v1/projects/${projectId}/tasks/${parentId}`) return resourceResponse(parent, TEST_VIEWER_ID);
    if (parsed.pathname === `/api/v1/projects/${projectId}/tasks`) { listReads++; return pending.promise; }
    throw new Error(`Unexpected GET ${url}`);
  }));
  const view = renderWithLocale(<ProjectAccessBoundary projectId={projectId}><OrdinaryTaskRelations projectId={projectId} detail={parent} history={scope.getHistoryGeneration(projectId)} active onRefreshGraph={() => {}} /></ProjectAccessBoundary>, { locale: 'en', taskCache: { scope } });
  try {
    await waitFor(() => expect(listReads).toBe(1));
    const generation = scope.getHistoryGeneration(projectId);
    act(() => scope.retireGoalHistory(projectId, taskSyncEpoch(projectId)));
    expect(scope.getHistoryGeneration(projectId)).toBeGreaterThan(generation);
    await act(async () => { pending.resolve(resourceResponse({ items: [child], nextCursor: null }, TEST_VIEWER_ID)); await pending.promise; });
    expect(screen.queryByText('Child')).toBeNull();
    expect(screen.getByRole('button', { name: 'New subtask' })).toBeDisabled();
  } finally { view.unmount(); scope.dispose(); vi.unstubAllGlobals(); }
});

it('withdraws private content after access revocation while a creation receipt is delayed', async () => {
  const { scope } = await prepare();
  const pending = Promise.withResolvers<Response>();
  let writes = 0;
  const privateParent = { ...parent, title: 'Private parent marker' };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/access')) return resourceResponse(directAccessFixture(projectId), TEST_VIEWER_ID);
    if (parsed.pathname === `/api/v1/projects/${projectId}/tasks/${parentId}`) return resourceResponse(privateParent, TEST_VIEWER_ID);
    if (parsed.pathname === `/api/v1/projects/${projectId}/tasks` && init?.method === 'POST') { writes++; return pending.promise; }
    if (parsed.pathname === `/api/v1/projects/${projectId}/tasks`) return resourceResponse({ items: [child], nextCursor: null }, TEST_VIEWER_ID);
    if (parsed.pathname.endsWith('/task-assignees')) return resourceResponse({ items: [], unresolvedUserIds: [] }, TEST_VIEWER_ID);
    throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`);
  }));
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  const view = renderWithLocale(<ProjectAccessBoundary projectId={projectId} initialRead><OrdinaryTaskRelations projectId={projectId} detail={privateParent} history={scope.getHistoryGeneration(projectId)} active onRefreshGraph={() => {}} /></ProjectAccessBoundary>, { locale: 'en', taskCache: { scope }, container: root });
  try {
    await screen.findByText('Child');
    fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Private new child' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(writes).toBe(1));
    const ticket = await scope.beginSync(projectId, scope.signal);
    await act(async () => { expect(await scope.revokeProject(ticket, scope.signal, false)).toBe(true); });
    const result = resourceResponse({ ...child, title: 'Private new child', status: 'proposed', ready: false, assignedTo: TEST_VIEWER_ID }, TEST_VIEWER_ID);
    await act(async () => { pending.resolve(new Response(result.body, { status: 201, headers: result.headers })); await pending.promise; });
    expect(screen.queryByText(/Private parent marker/)).toBeNull();
    expect(screen.queryByText('Child')).toBeNull();
    expect(screen.queryByText(/Subtask created: Private new child/)).toBeNull();
    expect(writes).toBe(1);
  } finally { view.unmount(); root.remove(); scope.dispose(); vi.unstubAllGlobals(); }
});
