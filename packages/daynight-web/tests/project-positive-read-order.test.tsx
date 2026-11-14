import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getProjectAccess } from '../src/api/auth';
import { ApiError, getTaskObservation, getTaskSync } from '../src/api/client';
import { getProject } from '../src/api/project-settings';
import { searchTasks } from '../src/api/task-search';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { renderWithLocale } from './helpers/renderWithLocale';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFromGraph, taskSyncReadFixture, TEST_VIEWER_ID } from './helpers/taskSync';

vi.mock('../src/api/client', async original => ({ ...await original<typeof import('../src/api/client')>(), getTaskObservation: vi.fn(), getTaskSync: vi.fn() }));
vi.mock('../src/api/auth', async original => ({ ...await original<typeof import('../src/api/auth')>(), getProjectAccess: vi.fn() }));
vi.mock('../src/api/project-settings', async original => ({ ...await original<typeof import('../src/api/project-settings')>(), getProject: vi.fn() }));
vi.mock('../src/api/task-search', async original => ({ ...await original<typeof import('../src/api/task-search')>(), searchTasks: vi.fn() }));

const projectId = '00000000-0000-4000-8000-000000000031';
const taskId = '00000000-0000-4000-8000-000000000041';
const detail = detailFixture(projectId, taskId, { title: 'Evidence task', description: 'Private description' });
const graph = graphFixture([detail]);
const scopes: TaskCacheScope[] = [];
const roots: HTMLElement[] = [];

beforeEach(() => {
  window.history.replaceState(null, '', `/projects/${projectId}`);
  vi.mocked(getProjectAccess).mockReset().mockImplementation(async (_id, _signal, admission) => directAccessFixture(projectId, admission.userId));
  vi.mocked(getProject).mockReset().mockResolvedValue(graph.project);
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (_id, query) => taskSyncReadFixture(taskSyncFromGraph(graph, { query, versionForTask: () => detail.version, propertiesForTask: () => detail.properties })));
  vi.mocked(getTaskObservation).mockReset().mockResolvedValue({ detail, epoch: taskSyncEpoch(projectId) });
  vi.mocked(searchTasks).mockReset();
});
afterEach(() => { cleanup(); for (const root of roots.splice(0)) root.remove(); for (const scope of scopes.splice(0)) scope.dispose(); });

const mount = async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  scopes.push(scope);
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root); roots.push(root);
  renderWithLocale(<ProjectPage projectId={projectId} />, { locale: 'en', taskCache: { scope }, container: root });
  await screen.findByRole('heading', { name: graph.project.name });
  await screen.findByRole('region', { name: 'Project task statistics' });
  fireEvent.click(screen.getByRole('tab', { name: 'Task list' }));
  await screen.findByRole('tab', { name: 'Standalone tasks' });
  return scope;
};

const startOldProjectRead = async () => {
  const old = Promise.withResolvers<typeof graph.project>();
  vi.mocked(getTaskSync).mockReturnValue(new Promise(() => {}));
  vi.mocked(getProjectAccess).mockReturnValue(new Promise(() => {}));
  vi.mocked(getProject).mockReset().mockReturnValueOnce(old.promise).mockReturnValue(new Promise(() => {}));
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(getProject).toHaveBeenCalledOnce());
  return old;
};

it('retains a newer successful search when an older Project read returns 404', async () => {
  const scope = await mount();
  const old = await startOldProjectRead();
  const before = scope.getProjectReadRevision(projectId);
  vi.mocked(searchTasks).mockResolvedValue({ projectId, total: 1, nextCursor: null, items: [{ tags: [], type: 'task', parentId: null, id: taskId, projectId, title: 'Search evidence', status: 'todo', assignedTo: null, updatedAt: detail.updatedAt, cancelledAt: null, context: null, match: { fields: ['title'], descriptionSnippet: null } }] });
  const input = screen.getByRole('textbox', { name: /Search task IDs/ });
  fireEvent.change(input, { target: { value: 'evidence' } });
  fireEvent.submit(input.closest('form')!);
  const result = await screen.findByText('Search evidence');
  expect(result.closest('.task-search-result')!.querySelector('.task-tag-list')).toBeNull();
  expect(scope.getProjectReadRevision(projectId)).toBeGreaterThan(before);
  await act(async () => { old.reject(new ApiError('server', 404, 'not_found')); });
  expect(screen.getByText('Search evidence')).toBe(result);
  expect(screen.getByRole('heading', { name: graph.project.name })).toBeVisible();
  expect(scope.isProjectSuspended(projectId)).toBe(false);
});

it('retains a newer successful summary detail when an older Project read returns 404', async () => {
  const scope = await mount();
  const old = await startOldProjectRead();
  const before = scope.getProjectReadRevision(projectId);
  fireEvent.click(screen.getByRole('tab', { name: 'Standalone tasks' }));
  fireEvent.click(screen.getByRole('button', { name: /Evidence task/ }));
  const dialog = screen.getByRole('dialog');
  await within(dialog).findByText('Private description');
  expect(getTaskObservation).toHaveBeenCalled();
  expect(scope.getProjectReadRevision(projectId)).toBeGreaterThan(before);
  await act(async () => { old.reject(new ApiError('server', 404, 'not_found')); });
  expect(dialog).toBeVisible();
  expect(within(dialog).getByText('Private description')).toBeVisible();
  expect(screen.getByRole('heading', { name: graph.project.name })).toBeVisible();
  expect(scope.isProjectSuspended(projectId)).toBe(false);
});
