import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TaskDetail, TaskSummary } from '../src/api/types';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { ExistingSelection } from '../src/features/task-detail/TaskOrganization';
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

it('keeps the existing Task selection open until a confirmed Parent write is published', async () => {
  const projectId = '10000000-0000-4000-8000-000000000001'; const taskId = '20000000-0000-4000-8000-000000000001'; const goalId = '20000000-0000-4000-8000-000000000002';
  const original = detailFixture(projectId, taskId, { title: 'Task' }); const target = detailFixture(projectId, goalId, { type: 'goal', title: 'Target Goal', ready: false });
  const saved = { ...original, parentId: goalId, version: original.version + 1n };
  const world = createTaskSessionWorld(); await world.sync([original, target]); let snapshot = snapshotFixture([original, target]); const onClose = vi.fn();
  const response = (value: unknown) => wireResponse(value, { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': fixtureTaskEpoch(projectId) }) });
  let resolveWrite!: (value: Response) => void; const writeResponse = new Promise<Response>((resolve) => { resolveWrite = resolve; });
  let reads = 0; let writes = 0; let sessions!: TaskDetailSessions; let resume: (() => void) | null = null;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === 'PATCH') { writes++; expect(JSON.parse(String(init.body))).toEqual({ parentId: goalId, version: 1 }); return writeResponse; }
    reads++; return reads === 1 ? Promise.resolve(response(original)) : reads === 2 ? Promise.reject(new Error('Offline')) : Promise.resolve(response(saved));
  }));
  const Workspace = () => {
    sessions = useTaskDetailSessions();
    return <ExistingSelection projectId={projectId} taskId={taskId} goalId={goalId} snapshot={snapshot} onClose={onClose} />;
  };
  const tree = () => <TaskCacheProvider scope={world.scope}><TaskDetailSessionProvider><Workspace /></TaskDetailSessionProvider></TaskCacheProvider>;
  const view = renderWithLocale(tree(), { locale: 'en' });
  try {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to Goal' })).toBeEnabled());
    expect(screen.getByText('Current Goal: No Goal')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Goal' }));
    await waitFor(() => expect(writes).toBe(1)); resume = pauseAuthRequests();
    await act(async () => { resolveWrite(response({ invalid: true })); });
    await waitFor(() => expect(sessions.snapshot(projectId, taskId).mutation).toMatchObject({ phase: 'confirmed', publicationPending: true }));
    const operation = sessions.snapshot(projectId, taskId).mutation.operation;
    expect(reads).toBe(1); (resume as (() => void) | null)?.(); resume = null;
    await waitFor(() => expect(sessions.snapshot(projectId, taskId).mutation).toMatchObject({ operation, phase: 'confirmed', publicationPending: true, reconciliationError: { kind: 'network' } }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add to Goal' })).toBeDisabled();
    const refreshed = vi.fn(); sessions.subscribeProject(projectId, refreshed);
    await act(async () => { sessions.load(projectId, taskId, 1, 'refresh'); });
    await waitFor(() => { expect(reads).toBeGreaterThanOrEqual(3); expect(refreshed).toHaveBeenCalled(); });
    expect(sessions.snapshot(projectId, taskId)).toMatchObject({ detail: original, mutation: { operation, phase: 'confirmed', publicationPending: true } });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add to Goal' })).toBeDisabled();
    await act(async () => { await world.sync([saved]); snapshot = snapshotFixture([saved, target], 2); view.rerender(tree()); });
    await waitFor(() => expect(sessions.snapshot(projectId, taskId)).toMatchObject({ detail: saved, requiresFreshRead: false, mutation: { operation, phase: 'confirmed', publicationPending: false } }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(screen.getByText(`Current Goal: Target Goal (${goalId})`)).toBeVisible();
    expect(writes).toBe(1);
  } finally { (resume as (() => void) | null)?.(); view.unmount(); world.dispose(); vi.unstubAllGlobals(); }
});

describe('Task Goal control', () => {
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
