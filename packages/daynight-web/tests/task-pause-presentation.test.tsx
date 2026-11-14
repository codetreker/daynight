import { statesForSummaries } from './helpers/taskSync';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { TaskSessionSummaryStore } from '../src/features/task-session-summary/store';
import { TEST_VIEWER_ID } from './helpers/taskSync';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { Project, TaskSummary } from '../src/api/types';
import { pausedSummaryTaskIds } from '../src/features/task-pause/paused-summary';
import { projectSummaries } from '../src/features/task-cache/projection';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { ProjectOverview } from '../src/features/projects/ProjectOverview';
import { TaskExecutionClockProvider } from '../src/features/task-execution/TaskExecutionClock';
import { ProjectTaskWorkspace } from '../src/features/projects/ProjectTaskWorkspace';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { overviewProgress } from '../src/features/projects/overview-progress';
import type { TaskMutationState } from '../src/features/task-detail/TaskDetailSession';
import { TaskPauseControl, TaskPauseFeedback } from '../src/features/task-pause/TaskPauseControl';
import { renderWithLocale } from './helpers/renderWithLocale';
import { detailFixture, graphFixture, resourceResponse } from './helpers/taskDetail';
import { taskSyncQuery, taskSyncResponse } from './helpers/taskSync';
import { installGraphMeasurements } from './graph-measurements';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const time = '2026-11-04T00:00:00Z';
const project: Project = { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, id: id(100), name: 'Project', repoUrl: 'https://example.com/project', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const summary = (n: number, changes: Partial<TaskSummary> = {}): TaskSummary => ({
  tags: [], type: 'task', parentId: null, id: id(n), titlePreview: `Task ${n}`, titleTruncated: false, assignedTo: null, requiredPlatform: null, allowAgents: true,
  version: 1n, properties: {}, status: 'todo', dependsOn: [], externalDependsOn: [], startedAt: null, completedAt: null, cancelledAt: null,
  createdAt: time, updatedAt: time, ...changes,
});
const seeds = [summary(1, { status: 'done', properties: { paused: true } }), summary(2, { dependsOn: [id(1)], properties: { paused: true } }),
  summary(3, { status: 'in_progress', properties: { paused: true } }), summary(4, { properties: { paused: false } }), summary(5)];
const snapshot = (tasks = seeds): GraphSnapshot => ({ ...projectSummaries(project, tasks, statesForSummaries(tasks), time), summaries: new Map(tasks.map((task) => [task.id, task])), observedAt: time, receivedMonotonic: 0, receivedAt: 0, revision: 1 });
let sessionScope: TaskCacheScope;
let sessionStore: TaskSessionSummaryStore;
beforeEach(() => { sessionScope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); sessionStore = new TaskSessionSummaryStore(sessionScope, project.id); });
afterEach(() => { sessionStore.dispose(); sessionScope.dispose(); });
const noop = () => {};
const mutation = (changes: Partial<TaskMutationState> = {}): TaskMutationState => ({ operation: { action: 'unpause', version: 1n }, phase: 'idle', error: null, reconciling: false, reconciliationError: null, ...changes });

const workspace = (value: GraphSnapshot, activeView: 'standalone' | 'chains', openChainId: string | null = null) => <TaskExecutionClockProvider projectId={project.id} snapshot={value}><ProjectTaskWorkspace sessionStore={sessionStore} snapshot={value} pausedTaskCount={pausedSummaryTaskIds(value.graph.tasks, value.pausedTaskIds).size} activeView={activeView}
  unfinishedGoalCount={0} goals={{ projectId: project.id, goals: [], total: 0, onOpenGoal: noop, onOpenGoalGraph: noop, onOpenGoalGraphTask: noop, openGraphTarget: null, onCloseChain: noop, onOpenTask: noop, onOpenListTask: noop, onOpenListChain: noop }}
  unfinishedStandaloneTaskCount={3} unfinishedChainTaskCount={1} onViewChange={noop}
  chains={{ projectId: project.id, representativeIds: [id(1)], allRepresentativeIds: [id(1)], openGraphTarget: openChainId === null ? null : { kind: 'chain', witnessTaskId: openChainId, rootId: openChainId }, onOpenChain: noop, onCloseChain: noop, onOpenTask: noop }}
  standalone={{ projectId: project.id, taskIds: [id(3), id(4), id(5)], allTaskIds: [id(3), id(4), id(5)], onSelectTask: noop }} /></TaskExecutionClockProvider>;

describe('paused task discovery', () => {
  it('derives only true pause flags without changing status statistics or graph node shape', () => {
    const value = snapshot();
    expect(value.pausedTaskIds).toEqual(new Set([id(1), id(2), id(3)]));
    expect(value.graph.summary).toEqual({ proposed: 0, total: 5, todo: 3, inProgress: 1, done: 1, cancelled: 0, ready: 3, blocked: 0 });
    expect(value.graph.tasks[0]).not.toHaveProperty('properties');
    expect(value.index.nodes.get(id(1))).not.toHaveProperty('paused');
    expect(snapshot(seeds.map((task) => ({ ...task, properties: { paused: false } }))).pausedTaskIds.size).toBe(0);
    expect(() => snapshot([summary(1, { properties: { paused: 'true' } })])).toThrow('The server returned an invalid response.');
  });

  it('shows complete-project counts and each paused standalone row through the production provider', () => {
    const value = snapshot();
    const view = renderWithLocale(workspace(value, 'standalone'), { locale: 'zh-CN', taskCache: true });
    expect(screen.getByText('2 已暂停')).toBeVisible();
    const paused = document.getElementById(`standalone-task-${id(3)}`)!;
    expect(within(paused).getByText('已暂停')).toBeVisible();
    expect(document.getElementById(`standalone-task-${id(4)}`)).not.toHaveTextContent('已暂停');
    expect(document.getElementById(`standalone-task-${id(5)}`)).not.toHaveTextContent('已暂停');
    view.rerender(workspace(snapshot(seeds.map((task) => ({ ...task, properties: { paused: false } }))), 'standalone'));
    expect(view.container.querySelector('.task-paused-badge')).toBeNull();
    expect(view.container.querySelector('.task-pause-count')).toBeNull();
  });

  it('keeps project count across filtered and paginated lists', () => {
    const value = snapshot();
    const view = renderWithLocale(<TaskExecutionClockProvider projectId={project.id} snapshot={value}><ProjectTaskWorkspace sessionStore={sessionStore} snapshot={value} pausedTaskCount={pausedSummaryTaskIds(value.graph.tasks, value.pausedTaskIds).size} activeView="standalone"
      unfinishedGoalCount={0} goals={{ projectId: project.id, goals: [], total: 0, onOpenGoal: noop, onOpenGoalGraph: noop, onOpenGoalGraphTask: noop, openGraphTarget: null, onCloseChain: noop, onOpenTask: noop, onOpenListTask: noop, onOpenListChain: noop }}
      unfinishedStandaloneTaskCount={3} unfinishedChainTaskCount={1} onViewChange={noop}
      chains={{ projectId: project.id, representativeIds: [], allRepresentativeIds: [id(1)], openGraphTarget: null, onOpenChain: noop, onCloseChain: noop, onOpenTask: noop }}
      standalone={{ projectId: project.id, taskIds: [id(4)], allTaskIds: [id(3), id(4), id(5)], onSelectTask: noop,
        pagination: { page: 1, pageCount: 1, total: 1, start: 1, end: 1, onPageChange: noop } }} /></TaskExecutionClockProvider>, { locale: 'en', taskCache: true });
    expect(view.container.querySelector('.project-section-heading .task-pause-count')).toHaveTextContent('2 paused');
    expect(document.getElementById(`standalone-task-${id(3)}`)).toBeNull();
    expect(document.getElementById(`standalone-task-${id(4)}`)).toBeVisible();
  });

  it('filters the task heading by assignee while preserving project and chain scopes', async () => {
    const other = id(202);
    const person = { version: 'a'.repeat(64), userId: other, name: 'Other person', avatarUrl: null, hasProjectAccess: true };
    const people = [person, { ...person, userId: TEST_VIEWER_ID, name: 'Current person' }];
    const task = (n: number, assignedTo: string | null, changes: Parameters<typeof detailFixture>[2] = {}) =>
      detailFixture(project.id, id(n), { title: `Task ${n}`, assignedTo, ...changes });
    const paused = { paused: true };
    const tasks = [
      task(1, TEST_VIEWER_ID, { properties: paused }),
      task(2, other, { dependsOn: [id(1), id(3)], externalDependsOn: [id(3)], properties: paused }),
      task(3, other, { properties: paused }),
      task(4, null, { status: 'cancelled', cancelledAt: time, properties: paused }),
      task(5, TEST_VIEWER_ID, { status: 'done', properties: paused }),
      task(6, TEST_VIEWER_ID, { parentId: id(7), properties: paused }),
      task(7, TEST_VIEWER_ID, { type: 'goal', properties: paused }),
      ...Array.from({ length: 21 }, (_, n) => task(100 + n, TEST_VIEWER_ID, n === 0 ? { properties: paused } : {})),
    ];
    window.history.replaceState(null, '', `/projects/${project.id}`);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async (address: string) => {
      const url = new URL(address, location.origin);
      if (url.pathname === `/api/v1/projects/${project.id}/task-sync`) return taskSyncResponse(graphFixture(tasks), {
        assigneeVersions: [TEST_VIEWER_ID, other].map((userId) => ({ userId, version: person.version, hasProjectAccess: true })), viewerId: TEST_VIEWER_ID,
        query: taskSyncQuery(url), versionForTask: (item) => tasks.find((task) => task.id === item.id)!.version,
        propertiesForTask: (item) => tasks.find((task) => task.id === item.id)!.properties,
      });
      if (url.pathname === `/api/v1/projects/${project.id}/task-assignees`) {
        const requested = url.searchParams.getAll('userId');
        return resourceResponse({ items: people.filter((item) => requested.length === 0 || requested.includes(item.userId)), unresolvedUserIds: requested.filter((userId) => !people.some((item) => item.userId === userId)) }, TEST_VIEWER_ID);
      }
      throw new Error(`Unexpected request ${address}`);
    }));
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    const view = renderWithLocale(<ProjectPage projectId={project.id} />, { container: root, locale: 'zh-CN', taskCache: true });
    const headingCount = () => view.container.querySelector('#project-section-panel-tasks .project-section-heading .task-pause-count');
    await waitFor(() => expect(screen.getByRole('button', { name: /查看暂停任务/ })).toHaveTextContent('6 已暂停'));
    fireEvent.click(screen.getByRole('tab', { name: '任务列表' }));
    await waitFor(() => expect(headingCount()).toHaveTextContent('6 已暂停'));
    const selectAssignee = async (label: string | RegExp) => {
      fireEvent.click(screen.getByRole('button', { name: /^负责人:/ }));
      fireEvent.click(await screen.findByRole('option', { name: label }));
    };
    await selectAssignee('分配给我');
    expect(headingCount()).toHaveTextContent('3 已暂停');
    const chain = document.getElementById(`task-root-${id(1)}`)!;
    expect(within(chain).getByText('2 已暂停')).toBeVisible();
    fireEvent.click(chain);
    expect(within(chain).getByText('2 已暂停')).toBeVisible();
    expect(document.getElementById(`chain-task-${id(1)}-${id(2)}`)!.closest('.goal-task-row')).toHaveTextContent('已暂停');
    fireEvent.change(screen.getByRole('combobox', { name: '状态' }), { target: { value: 'done' } });
    expect(headingCount()).toHaveTextContent('3 已暂停');
    fireEvent.change(screen.getByRole('combobox', { name: '状态' }), { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('tab', { name: '独立任务' }));
    expect(headingCount()).toHaveTextContent('3 已暂停');
    const pagination = screen.getByRole('navigation', { name: '独立任务列表分页' });
    fireEvent.click(within(pagination).getByRole('button', { name: '下一页' }));
    expect(pagination).toHaveTextContent('第 2 / 2 页');
    expect(headingCount()).toHaveTextContent('3 已暂停');
    fireEvent.click(screen.getByRole('tab', { name: 'Goal' }));
    expect(headingCount()).toHaveTextContent('3 已暂停');
    await selectAssignee('未分配');
    expect(headingCount()).toHaveTextContent('1 已暂停');
    await selectAssignee(/^Other person/);
    expect(headingCount()).toHaveTextContent('2 已暂停');
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    expect(screen.getByRole('button', { name: /查看暂停任务/ })).toHaveTextContent('6 已暂停');
    fireEvent.click(screen.getByRole('tab', { name: '任务列表' }));
    await selectAssignee('所有负责人');
    expect(headingCount()).toHaveTextContent('6 已暂停');
  });

  it('counts whole chains, identifies the paused representative and child, and passes pause data into the graph', async () => {
    installGraphMeasurements();
    const value = snapshot();
    const view = renderWithLocale(workspace(value, 'chains'), { locale: 'zh-CN', taskCache: true });
    const root = document.getElementById(`task-root-${id(1)}`)!;
    expect(within(root).getByText('1 已暂停')).toBeVisible();
    expect(within(root).getByText('已暂停')).toBeVisible();
    fireEvent.click(root);
    expect(document.getElementById(`chain-task-${id(1)}-${id(2)}`)!.closest('.goal-task-row')).toHaveTextContent('已暂停');
    view.rerender(workspace(value, 'chains', id(1)));
    const graph = await screen.findByRole('dialog');
    expect(graph.querySelectorAll('.task-node-paused')).toHaveLength(2);
    expect(graph.querySelectorAll('.task-node .task-paused-badge')).toHaveLength(2);
    expect(within(graph).getByText('1 已暂停')).toBeVisible();
    for (const body of graph.querySelectorAll('.task-node-paused .task-node-body')) expect(body).toHaveAccessibleName(/已暂停/);
    view.setLocale('en');
    for (const body of graph.querySelectorAll('.task-node-paused .task-node-body')) expect(body).toHaveAccessibleName(/Paused/);
  });

  it('hides summary counts for done-only pause while retaining its raw badge', async () => {
    installGraphMeasurements();
    const value = snapshot([summary(1, { status: 'done', properties: { paused: true } }), summary(2, { dependsOn: [id(1)] })]);
    const onOpenTask = vi.fn();
    const view = renderWithLocale(<ProjectOverview snapshot={value} progress={overviewProgress(value.index, [id(1)], [], BigInt(Date.parse(time)) * 1_000_000n)}
      pagination={{ page: 1, pageCount: 1, total: 1, start: 1, end: 1, onPageChange: noop }} onNavigate={noop} onOpenTask={onOpenTask} />, { locale: 'en', taskCache: true });
    expect(view.container.querySelector('.task-pause-count')).toBeNull();
    view.rerender(workspace(value, 'chains', id(1)));
    expect(view.container.querySelectorAll('.task-pause-count')).toHaveLength(0);
    expect(document.getElementById(`task-root-${id(1)}`)).toHaveTextContent('Paused');
    const graph = await screen.findByRole('dialog');
    expect(graph.querySelectorAll('.task-node-paused')).toHaveLength(1);
    expect(graph.querySelectorAll('.task-node .task-paused-badge')).toHaveLength(1);
  });

  it.each(['proposed', 'todo'] as const)('updates project and chain counts on status-only completion and reopening to %s', async (reopenedStatus) => {
    installGraphMeasurements();
    const tasks = [summary(1, { status: 'done', properties: { paused: true } }), summary(2, { status: 'in_progress', dependsOn: [id(1)], properties: { paused: true } })];
    const view = renderWithLocale(workspace(snapshot(tasks), 'chains', id(1)), { locale: 'en', taskCache: true });
    const counts = () => [...document.querySelectorAll('.task-pause-count')].map((element) => element.textContent);
    await screen.findByRole('dialog');
    expect(counts()).toEqual(['1 paused', '1 paused', '1 paused']);
    view.rerender(workspace(snapshot(tasks.map((task) => task.id === id(2) ? { ...task, status: 'done' } : task)), 'chains', id(1)));
    expect(counts()).toEqual([]);
    expect(screen.getByRole('dialog').querySelectorAll('.task-node-paused')).toHaveLength(2);
    view.rerender(workspace(snapshot(tasks.map((task) => task.id === id(2) ? { ...task, status: reopenedStatus } : task)), 'chains', id(1)));
    expect(counts()).toEqual(['1 paused', '1 paused', '1 paused']);
  });

  it.each(['proposed', 'todo'] as const)('updates the overview entry when status alone completes and reopens its target to %s', (reopenedStatus) => {
    const tasks = [summary(1, { status: 'done', properties: { paused: true } }), summary(2, { status: 'in_progress', dependsOn: [id(1)], properties: { paused: true } })];
    const onOpenTask = vi.fn();
    const overview = (items: TaskSummary[]) => {
      const value = snapshot(items);
      return <ProjectOverview snapshot={value} progress={overviewProgress(value.index, [id(1)], [], BigInt(Date.parse(time)) * 1_000_000n)}
        pagination={{ page: 1, pageCount: 1, total: 1, start: 1, end: 1, onPageChange: noop }} onNavigate={noop} onOpenTask={onOpenTask} />;
    };
    const view = renderWithLocale(overview(tasks), { locale: 'en' });
    expect(screen.getByRole('button', { name: 'Open paused task: Task 2' })).toHaveTextContent('1 paused');
    view.rerender(overview(tasks.map((task) => task.id === id(2) ? { ...task, status: 'done' } : task)));
    expect(view.container.querySelector('.task-pause-count')).toBeNull();
    view.rerender(overview(tasks.map((task) => task.id === id(2) ? { ...task, status: reopenedStatus } : task)));
    const entry = screen.getByRole('button', { name: 'Open paused task: Task 2' });
    fireEvent.click(entry);
    expect(onOpenTask).toHaveBeenCalledWith(id(2), entry);
  });

  it('counts the complete ordinary chain but excludes a visible external prerequisite', async () => {
    installGraphMeasurements();
    const value = snapshot([summary(1, { status: 'done', properties: { paused: true } }),
      summary(2, { dependsOn: [id(1), id(3)], externalDependsOn: [id(3)], properties: { paused: true } }),
      summary(3, { status: 'cancelled', properties: { paused: true } })]);
    const view = renderWithLocale(workspace(value, 'chains', id(1)), { locale: 'en', taskCache: true });
    expect(view.container.querySelector('.project-section-heading .task-pause-count')).toHaveTextContent('2 paused');
    const root = document.getElementById(`task-root-${id(1)}`)!;
    expect(within(root).getByText('1 paused')).toBeVisible();
    const graph = await screen.findByRole('dialog');
    expect(within(graph).getByText('1 paused')).toBeVisible();
    expect(graph.querySelectorAll('.task-node-paused')).toHaveLength(3);
    fireEvent.click(root);
    expect(within(root).getByText('1 paused')).toBeVisible();
  });

  it('opens a specific paused task from the complete overview count without altering the seven status cards', () => {
    const value = snapshot();
    const onOpenTask = vi.fn();
    renderWithLocale(<ProjectOverview snapshot={value} progress={overviewProgress(value.index, [id(1)], [id(3), id(4), id(5)], BigInt(Date.parse(time)) * 1_000_000n)}
      pagination={{ page: 1, pageCount: 2, total: 2, start: 1, end: 1, onPageChange: noop }} onNavigate={noop} onOpenTask={onOpenTask} />, { locale: 'en' });
    expect(document.querySelectorAll('.stats .stat')).toHaveLength(7);
    const open = screen.getByRole('button', { name: 'Open paused task: Task 2' });
    expect(open).toHaveTextContent('2 paused');
    fireEvent.click(open);
    expect(onOpenTask).toHaveBeenCalledWith(id(2), open);
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
