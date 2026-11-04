import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { Project, TaskSummary } from '../src/api/types';
import { projectSummaries } from '../src/features/task-cache/projection';
import { ProjectOverview } from '../src/features/projects/ProjectOverview';
import { ProjectTaskWorkspace } from '../src/features/projects/ProjectTaskWorkspace';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { overviewProgress } from '../src/features/projects/overview-progress';
import type { TaskMutationState } from '../src/features/task-detail/TaskDetailSession';
import { TaskPauseControl, TaskPauseFeedback } from '../src/features/task-pause/TaskPauseControl';
import { renderWithLocale } from './helpers/renderWithLocale';
import { installGraphMeasurements } from './graph-measurements';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const time = '2026-11-04T00:00:00Z';
const project: Project = { id: id(100), name: 'Project', repoUrl: 'https://example.com/project', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const summary = (n: number, changes: Partial<TaskSummary> = {}): TaskSummary => ({
  id: id(n), titlePreview: `Task ${n}`, titleTruncated: false, assignedTo: null, requiredPlatform: null, allowAgents: true,
  version: 1n, properties: {}, status: 'todo', dependsOn: [], externalDependsOn: [], startedAt: null, completedAt: null,
  createdAt: time, updatedAt: time, ...changes,
});
const seeds = [summary(1, { status: 'done', properties: { paused: true } }), summary(2, { dependsOn: [id(1)], properties: { paused: true } }),
  summary(3, { status: 'in_progress', properties: { paused: true } }), summary(4, { properties: { paused: false } }), summary(5)];
const snapshot = (tasks = seeds): GraphSnapshot => ({ ...projectSummaries(project, tasks, time), observedAt: time, receivedMonotonic: 0, receivedAt: 0, revision: 1 });
const noop = () => {};
const mutation = (changes: Partial<TaskMutationState> = {}): TaskMutationState => ({ operation: { action: 'unpause', version: 1n }, phase: 'idle', error: null, reconciling: false, reconciliationError: null, ...changes });

const workspace = (value: GraphSnapshot, activeView: 'standalone' | 'chains', openChainId: string | null = null) => <ProjectTaskWorkspace projectId={project.id} snapshot={value} activeView={activeView}
  unfinishedStandaloneTaskCount={3} unfinishedChainTaskCount={1} onViewChange={noop}
  chains={{ projectId: project.id, representativeIds: [id(1)], allRepresentativeIds: [id(1)], openChainId, onOpenChain: noop, onCloseChain: noop, onOpenTask: noop, showAll: true, onShowAllChange: noop }}
  standalone={{ projectId: project.id, taskIds: [id(3), id(4), id(5)], allTaskIds: [id(3), id(4), id(5)], onSelectTask: noop, showAll: true, onShowAllChange: noop }} />;

describe('paused task discovery', () => {
  it('derives only true pause flags without changing status statistics or graph node shape', () => {
    const value = snapshot();
    expect(value.pausedTaskIds).toEqual(new Set([id(1), id(2), id(3)]));
    expect(value.graph.summary).toEqual({ total: 5, todo: 3, inProgress: 1, done: 1, ready: 3, blocked: 0 });
    expect(value.graph.tasks[0]).not.toHaveProperty('properties');
    expect(value.index.nodes.get(id(1))).not.toHaveProperty('paused');
    expect(snapshot(seeds.map((task) => ({ ...task, properties: { paused: false } }))).pausedTaskIds.size).toBe(0);
  });

  it('shows complete-project counts and each paused standalone row through the production provider', () => {
    const value = snapshot();
    const view = renderWithLocale(workspace(value, 'standalone'), { locale: 'zh-CN', taskCache: true });
    expect(screen.getByText('3 已暂停')).toBeVisible();
    const paused = document.getElementById(`standalone-task-${id(3)}`)!;
    expect(within(paused).getByText('已暂停')).toBeVisible();
    expect(document.getElementById(`standalone-task-${id(4)}`)).not.toHaveTextContent('已暂停');
    expect(document.getElementById(`standalone-task-${id(5)}`)).not.toHaveTextContent('已暂停');
    view.rerender(workspace(snapshot(seeds.map((task) => ({ ...task, properties: { paused: false } }))), 'standalone'));
    expect(view.container.querySelector('.task-paused-badge')).toBeNull();
    expect(view.container.querySelector('.task-pause-count')).toBeNull();
  });

  it('counts whole chains, identifies the paused representative and child, and passes pause data into the graph', async () => {
    installGraphMeasurements();
    const value = snapshot();
    const view = renderWithLocale(workspace(value, 'chains'), { locale: 'zh-CN', taskCache: true });
    const root = document.getElementById(`task-root-${id(1)}`)!;
    expect(within(root).getByText('2 已暂停')).toBeVisible();
    expect(within(root).getByText('已暂停')).toBeVisible();
    fireEvent.click(root);
    expect(document.getElementById(`chain-task-${id(1)}-${id(2)}`)).toHaveTextContent('已暂停');
    view.rerender(workspace(value, 'chains', id(1)));
    const graph = await screen.findByRole('dialog');
    expect(graph.querySelectorAll('.task-node-paused')).toHaveLength(2);
    expect(graph.querySelectorAll('.task-node .task-paused-badge')).toHaveLength(2);
    expect(within(graph).getByText('2 已暂停')).toBeVisible();
    for (const body of graph.querySelectorAll('.task-node-paused .task-node-body')) expect(body).toHaveAccessibleName(/已暂停/);
    view.setLocale('en');
    for (const body of graph.querySelectorAll('.task-node-paused .task-node-body')) expect(body).toHaveAccessibleName(/Paused/);
  });

  it('opens a specific paused task from the complete overview count without altering the six status cards', () => {
    const value = snapshot();
    const onOpenTask = vi.fn();
    renderWithLocale(<ProjectOverview snapshot={value} progress={overviewProgress(value.index, [id(1)], [id(3), id(4), id(5)], BigInt(Date.parse(time)) * 1_000_000n)}
      pagination={{ page: 1, pageCount: 1, total: 2, start: 1, end: 2, onPageChange: noop }} onNavigate={noop} onOpenTask={onOpenTask} />, { locale: 'en' });
    expect(document.querySelectorAll('.stats .stat')).toHaveLength(6);
    const open = screen.getByRole('button', { name: 'Open paused task: Task 1' });
    expect(open).toHaveTextContent('3 paused');
    fireEvent.click(open);
    expect(onOpenTask).toHaveBeenCalledWith(id(1), open);
  });
});

describe('unpause controls and outcomes', () => {
  it('keeps the paused state while busy, exposes an accessible disabled reason, and restores focus after success', () => {
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    document.body.append(heading);
    const fallbackFocus = { current: heading };
    const onUnpause = vi.fn();
    const props = { paused: true, disabled: false, mutation: mutation(), onUnpause, fallbackFocus };
    const view = renderWithLocale(<TaskPauseControl {...props} />, { locale: 'zh-CN' });
    const unpause = screen.getByRole('button', { name: '解除暂停' });
    unpause.focus();
    fireEvent.click(unpause);
    expect(onUnpause).toHaveBeenCalledOnce();
    view.rerender(<TaskPauseControl {...props} disabled mutation={mutation({ phase: 'pending' })} />);
    expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled();
    expect(screen.getByText('已暂停')).toBeVisible();
    view.rerender(<TaskPauseControl {...props} paused={false} disabled mutation={mutation({ phase: 'pending' })} />);
    expect(screen.queryByText('已暂停')).toBeNull();
    expect(heading).toHaveFocus();
    view.rerender(<TaskPauseControl {...props} paused={false} mutation={mutation({ phase: 'confirmed' })} />);
    expect(heading).toHaveFocus();
    view.rerender(<TaskPauseControl {...props} disabled />);
    const reason = screen.getByRole('group', { name: '解除暂停' });
    fireEvent.focus(reason);
    expect(screen.getByRole('tooltip')).toHaveTextContent('确认当前任务详情与访问权限前无法修改任务。');
    heading.remove();
  });

  it('preserves deliberate focus navigation after a disabled control loses focus to the body', () => {
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    const next = document.createElement('button');
    next.textContent = 'Other task action';
    document.body.append(heading, next);
    const props = { paused: true, disabled: false, mutation: mutation(), onUnpause: vi.fn(), fallbackFocus: { current: heading } };
    const view = renderWithLocale(<TaskPauseControl {...props} />, { locale: 'en' });
    const unpause = screen.getByRole('button', { name: 'Unpause' });
    unpause.focus();
    fireEvent.click(unpause);
    view.rerender(<TaskPauseControl {...props} disabled mutation={mutation({ phase: 'pending' })} />);
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute('tabindex');
    expect(document.body).toHaveFocus();
    next.focus();
    view.rerender(<TaskPauseControl {...props} paused={false} disabled mutation={mutation({ phase: 'pending' })} />);
    expect(next).toHaveFocus();
    view.rerender(<TaskPauseControl {...props} paused={false} mutation={mutation({ phase: 'confirmed' })} />);
    expect(next).toHaveFocus();
    heading.remove();
    next.remove();
  });

  it.each(['pending', 'confirmed', 'conflict', 'unknown', 'reconciled', 'refused'] as const)('presents %s outcomes without changing the property itself', (phase) => {
    const onReconcile = vi.fn();
    const error = phase === 'refused' ? new ApiError('network') : null;
    renderWithLocale(<TaskPauseFeedback mutation={mutation({ phase, error })} onReconcile={onReconcile} />, { locale: 'en' });
    if (phase === 'pending') expect(screen.queryByText('Submitting the unpause request.')).toBeNull();
    else if (phase === 'confirmed') expect(screen.queryByText('The task is unpaused.')).toBeNull();
    else if (phase === 'refused') expect(screen.getByRole('alert')).toHaveTextContent('The unpause request did not receive a confirmed response');
    else expect(screen.getByText(phase === 'conflict' ? 'The task changed. Check its current pause state before trying again.' : phase === 'unknown'
      ? 'The unpause result is not confirmed. Check the current task state before making another change.' : 'The current task state has been read. This does not establish the outcome of the earlier unpause request.')).toBeVisible();
    if (phase === 'unknown') { fireEvent.click(screen.getByRole('button', { name: 'Check task state' })); expect(onReconcile).toHaveBeenCalledOnce(); }
  });

  it('keeps failed reconciliation visible, translates protocol errors and hides unrelated mutation feedback', () => {
    const view = renderWithLocale(<TaskPauseFeedback mutation={mutation({ phase: 'unknown', reconciling: true })} onReconcile={noop} />, { locale: 'en' });
    expect(screen.getByRole('button', { name: 'Checking the current task state…' })).toBeDisabled();
    view.rerender(<TaskPauseFeedback mutation={mutation({ phase: 'unknown', reconciliationError: new ApiError('protocol') })} onReconcile={noop} />);
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent).join(' ')).toContain('The service response could not confirm the unpause request result.');
    view.rerender(<TaskPauseFeedback mutation={mutation({ operation: { action: 'status', status: 'done', version: 1n }, phase: 'confirmed' })} onReconcile={noop} />);
    expect(screen.queryByText('The task is unpaused.')).toBeNull();
  });
});
