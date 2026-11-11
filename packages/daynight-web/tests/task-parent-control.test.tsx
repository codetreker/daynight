import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TaskDetail, TaskSummary } from '../src/api/types';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { ExistingSelection, TaskParentControl } from '../src/features/task-detail/TaskOrganization';
import * as taskDetailHook from '../src/features/task-detail/useTaskDetail';
import type { TaskMutationState } from '../src/features/task-detail/TaskDetailSession';
import { renderWithLocale } from './helpers/renderWithLocale';
import { TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { TaskDetailSessionProvider, useTaskDetailSessions, type TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { pauseAuthRequests } from '../src/api/client';
import { detailFixture, snapshotFixture } from './helpers/taskDetail';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { fixtureTaskEpoch, TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';
import { wireResponse } from './helpers/wireJson';

const goal = (id: string, title: string) => ({ id, type: 'goal', titlePreview: title, titleTruncated: false } as TaskSummary);
const snapshot = { summaries: new Map([['a', goal('a', 'Goal A')], ['b', goal('b', 'Goal B')]]), index: { nodes: new Map() }, revision: 1 } as unknown as GraphSnapshot;
const detail = { parentId: 'a', version: 9007199254740993n } as TaskDetail;
const idle: TaskMutationState = { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null };

it('retains a summary Task choice after a malformed confirmed receipt until fresh detail matches the summary', async () => {
  const projectId = '10000000-0000-4000-8000-000000000001'; const taskId = '20000000-0000-4000-8000-000000000001'; const goalId = '20000000-0000-4000-8000-000000000002';
  const original = detailFixture(projectId, taskId, { title: 'Task' }); const target = detailFixture(projectId, goalId, { type: 'goal', title: 'Target Goal', ready: false });
  const saved = { ...original, parentId: goalId, version: original.version + 1n };
  const world = createTaskSessionWorld(); await world.sync([original, target]); let node = world.node(projectId, taskId); let snapshot = snapshotFixture([original, target]);
  const response = (value: unknown) => wireResponse(value, { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': fixtureTaskEpoch(projectId) }) });
  let resolveWrite!: (value: Response) => void; const writeResponse = new Promise<Response>((resolve) => { resolveWrite = resolve; });
  let reads = 0; let writes = 0; let sessions!: TaskDetailSessions; let resume: (() => void) | null = null;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === 'PATCH') { writes++; return writeResponse; }
    reads++; return reads === 1 ? Promise.resolve(response(original)) : reads === 2 ? Promise.reject(new Error('Offline')) : Promise.resolve(response(saved));
  }));
  const Workspace = () => {
    sessions = useTaskDetailSessions(); const task = taskDetailHook.useTaskDetail(projectId, taskId, 1, node);
    return task.detail === null ? null : <TaskParentControl detail={task.detail} snapshot={snapshot} disabled={!task.canSetParent} mutation={task.mutation} onSelect={task.setParent} onReconcile={task.reconcile} />;
  };
  const tree = () => <TaskCacheProvider scope={world.scope}><TaskDetailSessionProvider><Workspace /></TaskDetailSessionProvider></TaskCacheProvider>;
  const view = renderWithLocale(tree(), { locale: 'en' });
  try {
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Current Goal' })).toBeEnabled());
    fireEvent.change(screen.getByRole('combobox', { name: 'Current Goal' }), { target: { value: goalId } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal membership' }));
    await waitFor(() => expect(writes).toBe(1)); resume = pauseAuthRequests();
    await act(async () => { resolveWrite(response({ invalid: true })); });
    await waitFor(() => expect(sessions.snapshot(projectId, taskId).mutation).toMatchObject({ phase: 'confirmed', publicationPending: true }));
    const operation = sessions.snapshot(projectId, taskId).mutation.operation;
    expect(reads).toBe(1); (resume as (() => void) | null)?.(); resume = null;
    await waitFor(() => expect(sessions.snapshot(projectId, taskId).mutation).toMatchObject({ operation, phase: 'confirmed', publicationPending: true, reconciliationError: { kind: 'network' } }));
    expect(screen.getByRole('combobox', { name: 'Current Goal' })).toHaveValue(goalId);
    const refreshed = vi.fn(); sessions.subscribeProject(projectId, refreshed);
    await act(async () => { sessions.load(projectId, taskId, 1, 'refresh'); });
    await waitFor(() => { expect(reads).toBeGreaterThanOrEqual(3); expect(refreshed).toHaveBeenCalled(); });
    expect(sessions.snapshot(projectId, taskId)).toMatchObject({ detail: original, mutation: { operation, phase: 'confirmed', publicationPending: true } });
    expect(screen.getByRole('combobox', { name: 'Current Goal' })).toHaveValue(goalId);
    await act(async () => { await world.sync([saved]); node = world.node(projectId, taskId); snapshot = snapshotFixture([saved, target], 2); view.rerender(tree()); });
    await waitFor(() => expect(sessions.snapshot(projectId, taskId)).toMatchObject({ detail: saved, requiresFreshRead: false, mutation: { operation, phase: 'confirmed', publicationPending: false } }));
    expect(screen.getByRole('combobox', { name: 'Current Goal' })).toHaveValue(goalId); expect(writes).toBe(1);
  } finally { (resume as (() => void) | null)?.(); view.unmount(); world.dispose(); vi.unstubAllGlobals(); }
});

describe('Task Goal control', () => {
  it('moves or removes membership using the exact reviewed Task version', () => {
    const onSelect = vi.fn();
    const view = renderWithLocale(<TaskParentControl detail={detail} snapshot={snapshot} disabled={false} mutation={idle} onSelect={onSelect} onReconcile={vi.fn()} />, { locale: 'en' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Current Goal' }), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal membership' }));
    expect(onSelect).toHaveBeenLastCalledWith('b', 9007199254740993n);
    view.rerender(<TaskParentControl detail={detail} snapshot={snapshot} disabled={false} mutation={idle} onSelect={onSelect} onReconcile={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Current Goal' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal membership' }));
    expect(onSelect).toHaveBeenLastCalledWith(null, 9007199254740993n);
  });
  it('retains the selection on an unknown result and offers a read without replaying the write', () => {
    const onSelect = vi.fn(); const onReconcile = vi.fn();
    const unknown: TaskMutationState = { operation: { action: 'parent', parentId: 'b', version: detail.version }, phase: 'unknown', error: new Error('Connection lost'), reconciling: false, reconciliationError: null };
    const view = renderWithLocale(<TaskParentControl detail={detail} snapshot={snapshot} disabled={false} mutation={idle} onSelect={onSelect} onReconcile={onReconcile} />, { locale: 'en' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Current Goal' }), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal membership' }));
    view.rerender(<TaskParentControl detail={detail} snapshot={snapshot} disabled mutation={unknown} onSelect={onSelect} onReconcile={onReconcile} />);
    expect(screen.getByRole('combobox', { name: 'Current Goal' })).toHaveValue('b');
    expect(screen.getByRole('button', { name: 'Save Goal membership' })).toBeDisabled();
    expect(screen.getByText('Connection lost')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Check current state' }));
    expect(onReconcile).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledOnce();
  });
  it('updates the displayed Goal without a conflict when the user has not made a selection', () => {
    const view = renderWithLocale(<TaskParentControl detail={detail} snapshot={snapshot} disabled={false} mutation={idle} onSelect={vi.fn()} onReconcile={vi.fn()} />, { locale: 'en' });
    view.rerender(<TaskParentControl detail={{ ...detail, parentId: 'b', version: detail.version + 1n }} snapshot={snapshot} disabled={false} mutation={idle} onSelect={vi.fn()} onReconcile={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Current Goal' })).toHaveValue('b');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save Goal membership' })).toBeDisabled();
  });
  it('keeps a pending choice and blocks it when the reviewed version changes', () => {
    const onSelect = vi.fn();
    const view = renderWithLocale(<TaskParentControl detail={detail} snapshot={snapshot} disabled={false} mutation={idle} onSelect={onSelect} onReconcile={vi.fn()} />, { locale: 'en' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Current Goal' }), { target: { value: 'b' } });
    view.rerender(<TaskParentControl detail={{ ...detail, version: detail.version + 1n }} snapshot={snapshot} disabled={false} mutation={idle} onSelect={onSelect} onReconcile={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Current Goal' })).toHaveValue('b');
    expect(screen.getByRole('alert')).toHaveTextContent('The Task changed');
    expect(screen.getByRole('button', { name: 'Save Goal membership' })).toBeDisabled();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review current Task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal membership' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b', detail.version + 1n);
  });
  it('retains a new choice after a previous confirmed move when the Task changes again', () => {
    const confirmed: TaskMutationState = { ...idle, operation: { action: 'parent', parentId: 'b', version: detail.version }, phase: 'confirmed' };
    const moved = { ...detail, parentId: 'b', version: detail.version + 1n };
    const view = renderWithLocale(<TaskParentControl detail={moved} snapshot={snapshot} disabled={false} mutation={confirmed} onSelect={vi.fn()} onReconcile={vi.fn()} />, { locale: 'en' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Current Goal' }), { target: { value: 'a' } });
    view.rerender(<TaskParentControl detail={{ ...moved, version: moved.version + 1n }} snapshot={snapshot} disabled={false} mutation={confirmed} onSelect={vi.fn()} onReconcile={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Current Goal' })).toHaveValue('a');
    expect(screen.getByRole('alert')).toHaveTextContent('The Task changed');
    expect(screen.getByRole('button', { name: 'Save Goal membership' })).toBeDisabled();
  });
  it('keeps a later choice when a locally confirmed move is published after a pause', () => {
    const operation = { action: 'parent' as const, parentId: 'b', version: detail.version };
    const pending: TaskMutationState = { ...idle, operation, phase: 'confirmed', publicationPending: true };
    const onSelect = vi.fn();
    const view = renderWithLocale(<TaskParentControl detail={detail} snapshot={snapshot} disabled={false} mutation={idle} onSelect={onSelect} onReconcile={vi.fn()} />, { locale: 'en' });
    const choice = screen.getByRole('combobox', { name: 'Current Goal' });
    fireEvent.change(choice, { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal membership' }));
    view.rerender(<TaskParentControl detail={detail} snapshot={snapshot} disabled mutation={pending} onSelect={onSelect} onReconcile={vi.fn()} />);
    fireEvent.change(choice, { target: { value: '' } });
    view.rerender(<TaskParentControl detail={{ ...detail, parentId: 'b', version: detail.version + 1n }} snapshot={snapshot} disabled={false} mutation={{ ...pending, publicationPending: false }} onSelect={onSelect} onReconcile={vi.fn()} />);
    expect(choice).toHaveValue('');
    expect(screen.getByRole('alert')).toHaveTextContent('The Task changed');
    expect(onSelect).toHaveBeenCalledOnce();
  });
  it('retains a later choice of the original Goal when the submitted move publishes', () => {
    const operation = { action: 'parent' as const, parentId: 'b', version: detail.version };
    const pending: TaskMutationState = { ...idle, operation, phase: 'confirmed', publicationPending: true };
    const onSelect = vi.fn();
    const view = renderWithLocale(<TaskParentControl detail={detail} snapshot={snapshot} disabled={false} mutation={idle} onSelect={onSelect} onReconcile={vi.fn()} />, { locale: 'en' });
    const choice = screen.getByRole('combobox', { name: 'Current Goal' });
    fireEvent.change(choice, { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal membership' }));
    view.rerender(<TaskParentControl detail={detail} snapshot={snapshot} disabled mutation={pending} onSelect={onSelect} onReconcile={vi.fn()} />);
    fireEvent.change(choice, { target: { value: 'a' } });
    const published = { ...detail, parentId: 'b', version: detail.version + 1n };
    view.rerender(<TaskParentControl detail={published} snapshot={snapshot} disabled={false} mutation={{ ...pending, publicationPending: false }} onSelect={onSelect} onReconcile={vi.fn()} />);
    expect(choice).toHaveValue('a');
    expect(screen.getByRole('alert')).toHaveTextContent('The Task changed');
    expect(screen.getByRole('button', { name: 'Save Goal membership' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Review current Task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal membership' }));
    expect(onSelect).toHaveBeenLastCalledWith('a', published.version);
  });
  it('requires a new review if the selected Task changes Goal or version before submission', () => {
    const setParent = vi.fn();
    const source = { ...detail, title: 'Selected Task', parentId: 'a' };
    const state = { detail: source, canSetParent: true, mutation: idle, error: null, status: 'ready', setParent, retry: vi.fn() } as unknown as ReturnType<typeof taskDetailHook.useTaskDetail>;
    const hook = vi.spyOn(taskDetailHook, 'useTaskDetail').mockReturnValue(state);
    const view = renderWithLocale(<ExistingSelection projectId="project" taskId="task" goalId="target" snapshot={snapshot} onClose={vi.fn()} />, { locale: 'en' });
    expect(screen.getByText('Current Goal: Goal A (a)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add to Goal' })).toBeEnabled();
    hook.mockReturnValue({ ...state, detail: { ...source, parentId: 'b', version: source.version + 1n } });
    view.rerender(<ExistingSelection projectId="project" taskId="task" goalId="target" snapshot={snapshot} onClose={vi.fn()} />);
    expect(screen.getByText('Current Goal: Goal B (b)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add to Goal' })).toBeDisabled();
    expect(setParent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review current Task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Goal' }));
    expect(setParent).toHaveBeenCalledExactlyOnceWith('target', source.version + 1n);
    hook.mockRestore();
  });
  it('does not close a re-reviewed selection on a delayed confirmed move', () => {
    const setParent = vi.fn(); const onClose = vi.fn();
    const source = { ...detail, title: 'Selected Task', parentId: 'a' };
    const state = { detail: source, canSetParent: true, mutation: idle, error: null, status: 'ready', setParent, retry: vi.fn() } as unknown as ReturnType<typeof taskDetailHook.useTaskDetail>;
    const hook = vi.spyOn(taskDetailHook, 'useTaskDetail').mockReturnValue(state);
    const selection = () => <ExistingSelection projectId="project" taskId="task" goalId="target" snapshot={snapshot} onClose={onClose} />;
    const view = renderWithLocale(selection(), { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Goal' }));
    const pending: TaskMutationState = { ...idle, operation: { action: 'parent', parentId: 'target', version: source.version }, phase: 'confirmed', publicationPending: true };
    hook.mockReturnValue({ ...state, detail: { ...source, version: source.version + 1n }, mutation: pending });
    view.rerender(selection());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review current Task' }));
    hook.mockReturnValue({ ...state, detail: { ...source, version: source.version + 1n }, mutation: { ...pending, publicationPending: false } });
    view.rerender(selection());
    expect(onClose).not.toHaveBeenCalled();
    expect(setParent).toHaveBeenCalledOnce();
    hook.mockRestore();
  });
});
