import userEvent from '@testing-library/user-event';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, deleteTask, getTask, getTaskSync } from '../src/api/client';
import { getProject } from '../src/api/project-settings';
import { getProjectAccess } from '../src/api/auth';
import { browserNavigation } from '../src/app/navigation';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import type { TaskDetail } from '../src/api/types';
import { installGraphMeasurements } from './graph-measurements';
import { renderWithLocale } from './helpers/renderWithLocale';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { directAccessFixture, fixtureTaskEpoch, taskSyncFromGraph, taskSyncReadFixture, TEST_VIEWER_ID } from './helpers/taskSync';
import { selectTaskList } from './helpers/projectViews';

vi.mock('../src/api/client', async original => {
  const actual = await original<typeof import('../src/api/client')>();
  const read = vi.fn();
  return { ...actual, deleteTask: vi.fn(), getTaskSync: vi.fn(), getTask: read,
    getTaskObservation: async (...args: Parameters<typeof actual.getTask>) => ({ detail: await read(...args), epoch: fixtureTaskEpoch(args[0]) }) };
});

vi.mock('../src/api/project-settings', async original => ({ ...await original<typeof import('../src/api/project-settings')>(), getProject: vi.fn() }));
vi.mock('../src/api/auth', async original => ({ ...await original<typeof import('../src/api/auth')>(), getProjectAccess: vi.fn() }));

const projectId = '00000000-0000-4000-8000-000000000031';
const goalId = '00000000-0000-4000-8000-000000000041';
const firstId = '00000000-0000-4000-8000-000000000042';
const secondId = '00000000-0000-4000-8000-000000000043';
const goal = detailFixture(projectId, goalId, { type: 'goal', title: 'Delivery Goal' });
const first = detailFixture(projectId, firstId, { parentId: goalId, title: 'Delete this member' });
const second = detailFixture(projectId, secondId, { parentId: goalId, title: 'Remaining member', dependsOn: [firstId], blockedBy: [firstId], ready: false });
const nextEpoch = '00000000-0000-4000-8000-000000000901';
let details: readonly TaskDetail[];
let epoch: string | undefined;
let scope: TaskCacheScope;
let root: HTMLDivElement;
let pendingSnapshotStarted: boolean;
let pendingSnapshot: ReturnType<typeof Promise.withResolvers<Awaited<ReturnType<typeof getTaskSync>>>> | null;
const syncResult = (query: { readonly epoch?: string; readonly since?: string }) => taskSyncReadFixture(taskSyncFromGraph(graphFixture(details), {
  query, ...(epoch === undefined ? {} : { epoch }), versionForTask: () => 1n, propertiesForTask: task => details.find(item => item.id === task.id)!.properties,
}));

beforeEach(() => {
  window.history.replaceState(null, '', `/projects/${projectId}`);
  installGraphMeasurements();
  details = [goal, first, second]; epoch = undefined; pendingSnapshot = null; pendingSnapshotStarted = false;
  vi.mocked(getProject).mockReset().mockResolvedValue(graphFixture(details).project);
  vi.mocked(getProjectAccess).mockReset().mockImplementation(async (_projectId, _signal, admission) => directAccessFixture(projectId, admission.userId));
  scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: () => { throw new Error('Unexpected identity mismatch'); } });
  root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (_projectId, query) => {
    if (pendingSnapshot !== null && epoch !== undefined && query.epoch === undefined) { pendingSnapshotStarted = true; return pendingSnapshot.promise; }
    return syncResult(query);
  });
  vi.mocked(getTask).mockReset().mockImplementation(async (_projectId, id) => {
    const task = details.find(item => item.id === id);
    if (task === undefined) throw new ApiError('server', 410, 'task_deleted');
    return task;
  });
  vi.mocked(deleteTask).mockReset().mockImplementation(async (_projectId, id) => {
    details = details.filter(task => task.id !== id).map(task => ({ ...task, dependsOn: task.dependsOn.filter(dependency => dependency !== id), blockedBy: [], ready: true }));
    epoch = nextEpoch;
  });
});
afterEach(() => { cleanup(); scope.dispose(); root.remove(); });

const openGraph = async () => {
  renderWithLocale(<ProjectPage projectId={projectId} />, { locale: 'en', taskCache: { scope }, container: root });
  await selectTaskList();
  fireEvent.click(await screen.findByRole('tab', { name: /^Goals?$/ }));
  await waitFor(() => expect(document.getElementById(`project-goal-graph-${goalId}`)).not.toBeNull());
  fireEvent.click(document.getElementById(`project-goal-graph-${goalId}`)!);
  return screen.findByRole('dialog', { name: goal.title });
};
const deleteFirst = async (graph: HTMLElement) => {
  await userEvent.setup().click(await within(graph).findByRole('button', { name: `${first.title}, Details` }));
  await waitFor(() => expect(getTask).toHaveBeenCalled());
  const dialog = await screen.findByRole('dialog', { name: first.title });
  const actions = within(dialog).getByRole('button', { name: 'More task actions' });
  await waitFor(() => expect(actions).toBeEnabled());
  fireEvent.click(actions);
  fireEvent.click(within(dialog).getByRole('menuitem', { name: 'Delete task' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete and remove dependencies' }));
  await waitFor(() => expect(deleteTask).toHaveBeenCalledOnce());
};

describe('Goal graph reading after task deletion', () => {
  it.each([1, 2])('withdraws the old Goal graph after deleting a member from %i members and admits only fresh graph data', async count => {
    if (count === 1) details = [goal, first];
    const graph = await openGraph();
    pendingSnapshot = Promise.withResolvers();
    await deleteFirst(graph);
    await waitFor(() => expect(pendingSnapshotStarted).toBe(true));
    expect(graph.isConnected).toBe(false);
    expect(screen.queryByRole('dialog', { name: goal.title })).toBeNull();
    expect(screen.queryByText(first.title)).toBeNull();
    expect(screen.queryByText('Refreshing')).toBeNull();
    await act(async () => { pendingSnapshot!.resolve(syncResult({})); });
    await waitFor(() => expect(fixtureTaskEpoch(projectId)).toBe(nextEpoch));
    expect(screen.queryByRole('dialog', { name: first.title })).toBeNull();
    await waitFor(() => expect(document.getElementById(`project-goal-graph-${goalId}`)).not.toBeNull());
    if (screen.queryByRole('dialog', { name: goal.title }) === null) fireEvent.click(document.getElementById(`project-goal-graph-${goalId}`)!);
    const fresh = await screen.findByRole('dialog', { name: goal.title });
    expect(fresh).not.toBe(graph);
    expect(within(fresh).queryByRole('button', { name: `${first.title}, Details` })).toBeNull();
    await waitFor(() => expect(fresh.querySelectorAll('.react-flow__node')).toHaveLength(count - 1));
    expect(fresh.querySelectorAll('.task-dependency-edge')).toHaveLength(0);
    const close = within(fresh).getByRole('button', { name: 'Close dependency graph' });
    if (count === 1) expect(within(fresh).getByText('This Goal has no tasks.')).toBeVisible();
    else {
      fireEvent.click(within(fresh).getByRole('button', { name: `${second.title}, Details` }));
      const remaining = await screen.findByRole('dialog', { name: second.title });
      fireEvent.click(within(remaining).getByRole('button', { name: 'Close task details' }));
      expect(screen.getByRole('dialog', { name: goal.title })).toBe(fresh);
    }
    fireEvent.click(close);
    await waitFor(() => expect(document.getElementById(`project-goal-graph-${goalId}`)).toHaveFocus());
  });

  it('closes the graph when the next epoch no longer contains its Goal', async () => {
    await openGraph();
    details = [detailFixture(projectId, secondId, { title: 'Unrelated task' })]; epoch = nextEpoch;
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(scope.getAuthorizedProject(projectId)?.summaries.has(goalId)).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not reopen the Goal graph after a section change while its new snapshot is pending', async () => {
    const graph = await openGraph();
    pendingSnapshot = Promise.withResolvers();
    await deleteFirst(graph);
    await waitFor(() => expect(pendingSnapshotStarted).toBe(true));
    expect(screen.queryByRole('dialog', { name: goal.title })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    await act(async () => { pendingSnapshot!.resolve(syncResult({})); });
    await waitFor(() => expect(scope.getAuthorizedProject(projectId)?.summaries.has(firstId)).toBe(false));
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('restores a retained Goal navigation only after fresh history when returning to its entry', async () => {
    const graph = await openGraph();
    pendingSnapshot = Promise.withResolvers();
    await deleteFirst(graph);
    await waitFor(() => expect(pendingSnapshotStarted).toBe(true));
    const originalEntry = browserNavigation().snapshot().entryId;
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(browserNavigation().snapshot().entryId).not.toBe(originalEntry);
    act(() => window.history.back());
    await waitFor(() => expect(browserNavigation().snapshot().entryId).toBe(originalEntry));
    expect(screen.queryByRole('dialog', { name: goal.title })).toBeNull();
    await act(async () => { pendingSnapshot!.resolve(syncResult({})); });
    await waitFor(() => expect(scope.getAuthorizedProject(projectId)?.summaries.has(firstId)).toBe(false));
    const restored = await screen.findByRole('dialog', { name: goal.title });
    expect(restored).not.toBe(graph);
    expect(within(restored).queryByRole('button', { name: `${first.title}, Details` })).toBeNull();
    expect(screen.getByRole('tab', { name: /^Goals?$/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('drops pending graph recovery when Project access is revoked', async () => {
    const graph = await openGraph();
    pendingSnapshot = Promise.withResolvers();
    await deleteFirst(graph);
    await waitFor(() => expect(pendingSnapshotStarted).toBe(true));
    expect(screen.queryByRole('dialog', { name: goal.title })).toBeNull();
    await act(async () => {
      const ticket = await scope.beginSync(projectId, scope.signal);
      expect(await scope.revokeProject(ticket, scope.signal)).toBe(true);
      pendingSnapshot!.resolve(syncResult({}));
    });
    expect(scope.getAuthorizedProject(projectId)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });


  it('keeps the old Goal graph withdrawn through failed refresh and deliberate retry', async () => {
    const graph = await openGraph();
    pendingSnapshot = Promise.withResolvers();
    await deleteFirst(graph);
    await waitFor(() => expect(pendingSnapshotStarted).toBe(true));
    expect(screen.queryByRole('dialog', { name: goal.title })).toBeNull();
    await act(async () => { pendingSnapshot!.reject(new ApiError('network')); });
    expect(screen.queryByRole('dialog', { name: goal.title })).toBeNull();
    const retry = await screen.findByRole('button', { name: /^retry$/i });
    pendingSnapshot = null;
    fireEvent.click(retry);
    await waitFor(() => expect(document.getElementById(`project-goal-graph-${goalId}`)).not.toBeNull());
    const recovered = await screen.findByRole('dialog', { name: goal.title });
    expect(recovered).not.toBe(graph);
    await waitFor(() => expect(within(recovered).queryByRole('button', { name: `${first.title}, Details` })).toBeNull());
    expect(within(recovered).getByRole('button', { name: `${second.title}, Details` })).toBeVisible();
    expect(deleteTask).toHaveBeenCalledOnce();
  });

});
