import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { navigate } from '../src/app/router';
import { browserNavigation } from '../src/app/navigation';
import { getTask } from '../src/api/client';
import { deleteTaskStep, editTaskStep, getTaskSteps, type StepsResource } from '../src/api/task-steps';
import { TaskDetailSurface } from '../src/features/task-detail/TaskDetailSurface';
import { TaskDetailSessionBoundary, useTaskDetailSessions, type TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { detailFixture, graphFixture, snapshotFixture } from './helpers/taskDetail';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';
import { renderWithLocale } from './helpers/renderWithLocale';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), getTask: vi.fn() }));
vi.mock('../src/features/task-agent-session/TaskAgentSession', () => ({ TaskAgentSession: () => <div>Private session</div> }));
vi.mock('../src/api/task-steps', async (original) => ({ ...await original<typeof import('../src/api/task-steps')>(), getTaskSteps: vi.fn(), editTaskStep: vi.fn(), deleteTaskStep: vi.fn() }));
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const otherId = '20000000-0000-4000-8000-000000000002';
const detail = detailFixture(projectId, taskId, { title: 'Current task', description: 'Private confirmed text', version: 5n });
const other = detailFixture(projectId, otherId);
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const api = { list: vi.fn(async () => ({ items: [], nextCursor: null })), put: vi.fn(), remove: vi.fn(), readText: vi.fn(), checkPreview: vi.fn() };
afterEach(() => { cleanup(); browserNavigation().dispose(); vi.restoreAllMocks(); });

it.each((['edit', 'delete'] as const).flatMap(action => (['identity', 'project'] as const).map(retirement => ({ action, retirement }))))('rejects a late $action receipt after $retirement retirement', async ({ action, retirement }) => {
  const world = createTaskSessionWorld(); await world.sync([detail]);
  const step = { id: '00000001', title: 'Private step', description: 'Private step description', status: 'todo' as const, createdAt: '2026-10-22T10:00:00Z', updatedAt: '2026-10-22T10:00:00Z' };
  const initial: StepsResource = { projectId, taskId, version: 5n, steps: [step] };
  const pending = deferred<StepsResource>();
  vi.mocked(getTask).mockReset().mockResolvedValue(detail);
  vi.mocked(getTaskSteps).mockReset().mockResolvedValue(initial);
  vi.mocked(editTaskStep).mockReset().mockReturnValue(pending.promise);
  vi.mocked(deleteTaskStep).mockReset().mockReturnValue(pending.promise);
  let sessions!: TaskDetailSessions;
  const Capture = () => { sessions = useTaskDetailSessions(); return null; };
  history.replaceState(null, '', `/projects/${projectId}/tasks/${taskId}?tab=steps`);
  const tree = <TaskDetailSessionBoundary><Capture /><TaskDetailSurface presentation="page" fullscreen={{ active: false, onChange: vi.fn() }} projectId={projectId} taskId={taskId} snapshot={snapshotFixture([detail])} navigation={{ tab: 'steps', path: null }} attachmentApi={api} onNavigate={vi.fn()} onSelectTask={vi.fn()} onRefreshGraph={vi.fn()} /></TaskDetailSessionBoundary>;
  renderWithLocale(tree, { locale: 'en', taskCache: { scope: world.scope } });
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Private step' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit step' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Unsaved private edit' } });
    if (action === 'edit') fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    else {
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Private step' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete step' }));
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete step' }));
    }
    const write = action === 'edit' ? vi.mocked(editTaskStep) : vi.mocked(deleteTaskStep);
    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    await act(async () => {
      if (retirement === 'identity') await world.scope.invalidateScope();
      else { const ticket = await world.scope.beginSync(projectId, world.scope.signal); expect(await world.scope.revokeProject(ticket, world.scope.signal, false)).toBe(true); }
    });
    expect(sessions.stepsSnapshot(projectId, taskId).resource).toBeNull();
    expect(screen.queryByDisplayValue('Unsaved private edit')).toBeNull();
    await act(async () => { pending.resolve({ ...initial, version: 6n, steps: action === 'delete' ? [] : [{ ...step, title: 'Unsaved private edit' }] }); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(sessions.stepsSnapshot(projectId, taskId).resource).toBeNull();
    expect(screen.queryByDisplayValue('Unsaved private edit')).toBeNull();
    expect(screen.queryByText('Private step description')).toBeNull();
    expect(write).toHaveBeenCalledOnce();
  } finally { world.dispose(); }
});

it.each(['identity', 'project'] as const)('retains the draft across another task deletion and clears it on %s retirement', async (retirement) => {
  const world = createTaskSessionWorld(); await world.sync([detail, other]);
  const replacement = deferred<typeof detail>();
  vi.mocked(getTask).mockReset().mockResolvedValueOnce(detail).mockReturnValueOnce(replacement.promise).mockResolvedValue(detail);
  vi.mocked(getTaskSteps).mockReset().mockResolvedValue({ projectId, taskId, version: 5n, steps: [] });
  history.replaceState(null, '', `/projects/${projectId}/tasks/${taskId}?tab=steps`);
  const view = (revision: number, tasks: typeof detail[]) => <TaskDetailSessionBoundary><TaskDetailSurface presentation="page" fullscreen={{ active: false, onChange: vi.fn() }} projectId={projectId} taskId={taskId} snapshot={snapshotFixture(tasks, revision)} navigation={{ tab: 'steps', path: null }} attachmentApi={api} onNavigate={vi.fn()} onSelectTask={vi.fn()} onRefreshGraph={vi.fn()} /></TaskDetailSessionBoundary>;
  const rendered = renderWithLocale(view(1, [detail, other]), { locale: 'en', taskCache: { scope: world.scope } });
  try {
    const add = await screen.findByRole('button', { name: 'Add step' }); await waitFor(() => expect(add).toBeEnabled()); fireEvent.click(add);
    const title = screen.getByRole('textbox', { name: 'Title' }); fireEvent.change(title, { target: { value: 'Unsaved private draft' } });
    const panels = title.closest<HTMLElement>('.task-detail-panels')!;
    expect(panels.parentElement).toHaveClass('task-detail-body'); expect(panels).not.toHaveAttribute('hidden');
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Unsaved private draft');
    const ticket = await world.scope.beginSync(projectId, world.scope.signal);
    await act(async () => { await world.scope.applySync(ticket, taskSyncFromGraph(graphFixture([detail]), { epoch: '30000000-0000-4000-8000-000000000003', versionForTask: () => detail.version, propertiesForTask: () => detail.properties }), world.scope.signal); });
    rendered.rerender(view(2, [detail]));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Private confirmed text')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByText('Unsaved private draft')).toBeNull();
    expect(title).not.toBeVisible(); expect(title).toHaveValue('Unsaved private draft');
    expect(panels).toHaveAttribute('hidden'); expect(panels).toHaveAttribute('inert'); expect(panels).toHaveStyle({ display: 'none' });
    act(() => navigate('/projects'));
    expect(screen.getByRole('alertdialog')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await act(async () => { replacement.reject(new Error('Offline')); });
    await screen.findByRole('button', { name: 'Retry details' });
    expect(title).not.toBeVisible(); expect(title).toHaveValue('Unsaved private draft');
    fireEvent.click(screen.getByRole('button', { name: 'Retry details' }));
    await waitFor(() => expect(title).toBeVisible());
    expect(screen.getByRole('textbox', { name: 'Title' })).toBe(title);
    expect(panels.parentElement).toHaveClass('task-detail-body'); expect(panels).not.toHaveAttribute('hidden'); expect(panels.style.display).toBe('');
    expect(title).toHaveValue('Unsaved private draft');
    await act(async () => {
      if (retirement === 'identity') await world.scope.invalidateScope();
      else { const active = await world.scope.beginSync(projectId, world.scope.signal); expect(await world.scope.revokeProject(active, world.scope.signal, false)).toBe(true); }
    });
    expect(screen.queryByDisplayValue('Unsaved private draft')).toBeNull();
    act(() => navigate('/projects'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  } finally { world.dispose(); }
});


it('keeps the Session selection without retaining its private content while the new generation is unreadable', async () => {
  const claim = { claimId: '30000000-0000-4000-8000-000000000001', state: 'active', userId: TEST_VIEWER_ID,
    workerId: '40000000-0000-4000-8000-000000000001', machine: { id: '50000000-0000-4000-8000-000000000001', name: 'worker' },
    platform: 'macos', agent: 'codex', agentControlMode: 'web', worktreeId: '60000000-0000-4000-8000-000000000001',
    phase: 'executing', herdr: null, nativeSessionId: 'session', claimedAt: '2026-11-04T00:00:00Z' };
  const running = detailFixture(projectId, taskId, { title: 'Running task', status: 'in_progress', ready: false, properties: { worker: claim }, version: 5n });
  const world = createTaskSessionWorld(); await world.sync([running, other]);
  const replacement = deferred<typeof running>(); const onNavigate = vi.fn();
  vi.mocked(getTask).mockReset().mockResolvedValueOnce(running).mockReturnValueOnce(replacement.promise);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')));
  const view = (revision: number, tasks: typeof detail[]) => <TaskDetailSessionBoundary><TaskDetailSurface presentation="page" fullscreen={{ active: false, onChange: vi.fn() }} projectId={projectId} taskId={taskId} snapshot={snapshotFixture(tasks, revision)} navigation={{ tab: 'session', path: null }} attachmentApi={api} onNavigate={onNavigate} onSelectTask={vi.fn()} onRefreshGraph={vi.fn()} /></TaskDetailSessionBoundary>;
  const rendered = renderWithLocale(view(1, [running, other]), { locale: 'en', taskCache: { scope: world.scope } });
  try {
    await screen.findByText('Private session');
    const ticket = await world.scope.beginSync(projectId, world.scope.signal);
    await act(async () => { await world.scope.applySync(ticket, taskSyncFromGraph(graphFixture([running]), { epoch: '30000000-0000-4000-8000-000000000003', versionForTask: () => running.version, propertiesForTask: () => running.properties }), world.scope.signal); });
    rendered.rerender(view(2, [running]));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Private session')).toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
  } finally { world.dispose(); }
});
