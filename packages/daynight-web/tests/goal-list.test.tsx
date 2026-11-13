import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TaskSummary, WorkerClaim } from '../src/api/types';
import { createTaskCacheScope } from '../src/features/task-cache/project-cache';
import { deriveTaskSyncBindings } from '../src/features/task-cache/execution-binding';
import { TaskSessionSummaryProvider } from '../src/features/task-session-summary/TaskSessionSummaryProvider';
import { TaskSessionSummaryStore } from '../src/features/task-session-summary/store';
import { detailFixture, graphFixture, snapshotFixture } from './helpers/taskDetail';
import { taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';
import { buildGraphIndex } from '../src/features/task-graph/model';
import { projectSummaries } from '../src/features/task-cache/projection';
import { GoalList } from '../src/features/projects/GoalList';
import { TaskPauseProvider } from '../src/features/task-pause/TaskPause';
import { TaskExecutionClockProvider } from '../src/features/task-execution/TaskExecutionClock';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { createLocaleRender } from './helpers/renderWithLocale';
import { statesForSummaries } from './helpers/taskSync';

const time = '2026-10-20T12:00:00Z';
const projectId = '00000000-0000-4000-8000-000000000101';
const project = { id: projectId, name: 'Project', repoUrl: 'https://example.test/project', ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const summary = (id: string, type: 'task' | 'goal', parentId: string | null, status: TaskSummary['status'], changes: Partial<TaskSummary> = {}): TaskSummary => ({
  tags: [], id, type, parentId, status, titlePreview: id, titleTruncated: false, assignedTo: null, requiredPlatform: null, allowAgents: false,
  dependsOn: [], externalDependsOn: [], properties: {}, version: 1n, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, ...changes,
});
const snapshot = (tasks: TaskSummary[]): GraphSnapshot => ({ ...projectSummaries(project, tasks, statesForSummaries(tasks), time), summaries: new Map(tasks.map((task) => [task.id, task])), observedAt: time, receivedMonotonic: 0, receivedAt: 0, revision: 1 });
const goal = summary('goal', 'goal', null, 'todo');
const other = summary('other', 'goal', null, 'done');
const empty = summary('empty', 'goal', null, 'todo');
const tasks = [goal, other, empty, summary('root', 'task', other.id, 'done'), summary('child', 'task', goal.id, 'in_progress', { dependsOn: ['root'], startedAt: '2026-10-20T11:50:00Z' }), summary('standalone', 'task', goal.id, 'cancelled'), summary('solo-other', 'task', other.id, 'todo')];
const claim = (state: WorkerClaim['state']): WorkerClaim => ({
  claimId: '00000000-0000-4000-8000-000000000201', state, userId: '00000000-0000-4000-8000-000000000202',
  workerId: '00000000-0000-4000-8000-000000000203', machine: { id: '00000000-0000-4000-8000-000000000204', name: 'host' },
  platform: 'linux', agent: 'codex', agentControlMode: 'web', worktreeId: '00000000-0000-4000-8000-000000000205',
  phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: time,
});
const noop = () => {};
const list = (value: GraphSnapshot, onOpenGoal = vi.fn(), onOpenListTask = vi.fn(), onOpenListChain = vi.fn(), onOpenGoalGraph = vi.fn()) => <TaskPauseProvider taskIds={new Set(['child'])}><TaskExecutionClockProvider projectId={projectId} snapshot={value}>
  <GoalList projectId={projectId} index={value.index} goals={[value.summaries.get(goal.id)!, value.summaries.get(other.id)!, value.summaries.get(empty.id)!]} total={3} workerMachines={value.workerMachines} onOpenGoal={onOpenGoal} onOpenGoalGraph={onOpenGoalGraph} onOpenGoalGraphTask={noop} onOpenListTask={onOpenListTask} onOpenListChain={onOpenListChain} openGraphTarget={null} onCloseChain={noop} onOpenTask={noop} />
</TaskExecutionClockProvider></TaskPauseProvider>;

describe('Goal list', () => {
  it('toggles from each part of the header and keeps detail and graph actions separate', () => {
    const openGoal = vi.fn(); const openGraph = vi.fn();
    const assigned = tasks.map(task => task.id === goal.id ? { ...task, assignedTo: '12345678-0000-4000-8000-000000000001' } : task);
    createLocaleRender('en', { taskCache: true })(list(snapshot(assigned), openGoal, vi.fn(), vi.fn(), openGraph));
    const card = document.querySelector<HTMLElement>('[data-goal-id="goal"]')!;
    const toggle = card.querySelector<HTMLButtonElement>('.goal-list-toggle')!;
    const detail = document.getElementById('project-goal-detail-goal')!;
    const graph = document.getElementById('project-goal-graph-goal')!;
    const content = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(toggle).toHaveAccessibleDescription(/Assignee: 12345678.*2 tasks.*0\/1 completed.*To do/);
    expect(content).not.toBeVisible();
    expect(toggle.contains(detail)).toBe(false);
    expect(toggle.contains(graph)).toBe(false);
    for (const selector of ['.goal-disclosure', '.goal-list-icon', '.goal-list-title', '.goal-list-meta', '.goal-list-progress', '.root-status']) {
      const target = toggle.querySelector(selector)!;
      fireEvent.click(target);
      expect(toggle, selector).toHaveAttribute('aria-expanded', 'true');
      expect(content).toBeVisible();
      fireEvent.click(target);
      expect(toggle, selector).toHaveAttribute('aria-expanded', 'false');
      expect(content).not.toBeVisible();
    }
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    for (const expanded of [true, false]) {
      fireEvent.click(detail);
      expect(openGoal).toHaveBeenLastCalledWith(goal.id, detail);
      fireEvent.click(graph);
      expect(openGraph).toHaveBeenLastCalledWith(goal.id, graph);
      expect(toggle).toHaveAttribute('aria-expanded', String(expanded));
      if (expanded) fireEvent.click(toggle);
    }
    expect(openGoal).toHaveBeenCalledTimes(2);
    expect(openGraph).toHaveBeenCalledTimes(2);
  });

  it('opens the overall graph independently of the title and disclosure, including an empty Goal', () => {
    const openGoal = vi.fn(); const openGraph = vi.fn();
    createLocaleRender('en', { taskCache: true })(list(snapshot(tasks), openGoal, vi.fn(), vi.fn(), openGraph));
    for (const id of ['goal', 'empty']) {
      const card = document.querySelector<HTMLElement>(`[data-goal-id="${id}"]`)!;
      const button = within(card).getByRole('button', { name: `${id}, View Goal dependency graph` });
      fireEvent.click(button);
      expect(openGraph).toHaveBeenLastCalledWith(id, button);
      expect(card.querySelector('.goal-list-toggle')).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(card.querySelector('.goal-list-toggle')!);
      fireEvent.click(button);
      expect(openGraph).toHaveBeenLastCalledWith(id, button);
      expect(card.querySelector('.goal-list-toggle')).toHaveAttribute('aria-expanded', 'true');
    }
    expect(openGoal).not.toHaveBeenCalled();
  });

  it('summarizes only direct children and follows status, claim and parent changes', () => {
    const source = [
      { ...goal, status: 'in_progress' as const, properties: { worker: claim('active') } }, other, empty,
      summary('outside', 'task', other.id, 'done', { properties: { worker: claim('active') } }),
      summary('external', 'task', null, 'in_progress', { properties: { worker: claim('active') } }),
      summary('child', 'task', goal.id, 'in_progress', { dependsOn: ['outside'], properties: { paused: true } }),
      summary('pending', 'task', goal.id, 'todo', { dependsOn: ['external'], externalDependsOn: ['external'] }),
      summary('anchor', 'task', goal.id, 'done'),
      summary('cancelled', 'task', goal.id, 'cancelled'),
      summary('cross-running', 'task', other.id, 'in_progress', { dependsOn: ['anchor'] }),
      summary('standalone', 'task', goal.id, 'todo', { allowAgents: true }),
    ];
    const view = createLocaleRender('en', { taskCache: true })(list(snapshot(source)));
    const card = document.querySelector<HTMLElement>('[data-goal-id="goal"]')!;
    const otherCard = document.querySelector<HTMLElement>('[data-goal-id="other"]')!;
    const emptyCard = document.querySelector<HTMLElement>('[data-goal-id="empty"]')!;
    const toggle = card.querySelector<HTMLButtonElement>('.goal-list-toggle')!;
    const header = (element: HTMLElement) => element.querySelector<HTMLElement>('.goal-list-toggle')!;
    expect(toggle).toHaveAccessibleDescription(/1 in progress.*1\/4 completed/);
    expect(toggle).not.toHaveAccessibleDescription(/Automatic execution active/);
    expect(header(otherCard)).toHaveAccessibleDescription(/1 in progress.*Automatic execution active/);
    expect(header(emptyCard)).toHaveAccessibleDescription(/0 in progress/);
    expect(card.querySelector('.chain-worker-active')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    toggle.focus();

    const active = source.map(task => task.id === 'child' ? { ...task, properties: { paused: true, worker: claim('active') } } : task.id === 'standalone' ? { ...task, status: 'in_progress' as const } : task);
    view.rerender(list(snapshot(active)));
    expect(card.querySelector('.goal-list-toggle')).toBe(toggle);
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAccessibleDescription(/2 in progress.*Automatic execution active.*1\/4 completed/);
    const indicator = toggle.querySelector('.chain-worker-active')!;
    expect(indicator.querySelector('.chain-worker-active-dot')).toHaveAttribute('aria-hidden', 'true');
    expect(within(indicator as HTMLElement).queryByRole('button')).toBeNull();

    const moved = active.map(task => task.id === 'child' ? { ...task, parentId: other.id } : task);
    view.rerender(list(snapshot(moved)));
    expect(toggle).toHaveAccessibleDescription(/1 in progress.*1\/3 completed/);
    expect(toggle).not.toHaveAccessibleDescription(/Automatic execution active/);
    expect(header(otherCard)).toHaveAccessibleDescription(/2 in progress.*Automatic execution active/);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    for (const properties of [{}, { worker: claim('completed') }]) {
      const inactive = active.map(task => task.id === 'child' ? { ...task, properties } : task);
      view.rerender(list(snapshot(inactive)));
      expect(toggle).toHaveAccessibleDescription(/2 in progress/);
      expect(toggle).not.toHaveAccessibleDescription(/Automatic execution active/);
    }
    view.rerender(list(snapshot(source)));
    expect(toggle).toHaveAccessibleDescription(/1 in progress/);
    expect(toggle).not.toHaveAccessibleDescription(/Automatic execution active/);
  });

  it('updates the Goal surface from its own status without changing child progress', () => {
    const render = createLocaleRender('en', { taskCache: true });
    const view = render(list(snapshot(tasks)));
    const card = document.querySelector<HTMLElement>('[data-goal-id="goal"]')!;
    const row = card.querySelector('.goal-list-row')!;
    const progress = row.querySelector('.goal-list-progress')!.textContent;
    for (const status of ['todo', 'in_progress', 'done', 'cancelled'] as const) {
      view.rerender(list(snapshot(tasks.map((task) => task.id === goal.id ? { ...task, status } : task))));
      expect(card).toHaveAttribute('data-task-status', status);
      expect(row).toHaveClass('task-status-surface');
      expect(row).toHaveAttribute('data-task-status', status);
      expect(row.querySelector('.goal-list-progress')).toHaveTextContent(progress!);
    }
  });

  it('shows each direct member once with independent Goal disclosure and read actions', () => {
    const value = snapshot(tasks);
    const openGoal = vi.fn(); const openTask = vi.fn(); const openChain = vi.fn();
    createLocaleRender('zh-CN', { taskCache: true })(list(value, openGoal, openTask, openChain));
    const first = document.querySelector<HTMLElement>('[data-goal-id="goal"]')!;
    const second = document.querySelector<HTMLElement>('[data-goal-id="other"]')!;
    const toggle = within(first).getByRole('button', { name: '展开 Goal：goal' });
    expect(toggle).toHaveAccessibleDescription(/负责人：未分配.*共 2 个任务.*0\/1 已完成.*待处理/);
    expect(first.querySelector('.goal-list-progress')).toHaveTextContent('0/1 已完成');
    fireEvent.click(toggle);
    fireEvent.click(within(second).getByRole('button', { name: '展开 Goal：other' }));
    expect([...first.querySelectorAll('.goal-task-main .root-title')].map(node => node.textContent)).toEqual(['child', 'standalone']);
    expect([...second.querySelectorAll('.goal-task-main .root-title')].map(node => node.textContent)).toEqual(['solo-other', 'root']);
    expect(first.querySelector('.root-toggle')).toBeNull();
    expect(within(first).getByText('已暂停')).toBeVisible();
    expect(first.querySelector('.task-duration')).toHaveTextContent('10 分钟');
    const child = document.getElementById('chain-task-goal-goal-child')!;
    fireEvent.click(child);
    expect(openTask).toHaveBeenCalledWith('child', child, goal.id);
    expect(openChain).not.toHaveBeenCalled();
    const detail = document.getElementById('project-goal-detail-goal')!;
    fireEvent.click(detail); expect(openGoal).toHaveBeenCalledWith('goal', detail);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(within(first).queryByText('child')).toBeNull();
    expect(within(second).getByText('root')).toBeVisible();
    fireEvent.click(toggle);
    expect(within(first).getByText('child')).toBeVisible();
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-goal-id="empty"]')!).getByRole('button', { name: '展开 Goal：empty' }));
    expect(screen.getByText('此 Goal 暂无子任务。')).toBeVisible();
  });

  it('projects cancelled children out of progress while retaining members and focus across updates', () => {
    const members = [summary('done', 'task', goal.id, 'done'), summary('waiting', 'task', goal.id, 'todo'), summary('cancelled', 'task', goal.id, 'cancelled')];
    const current = [goal, other, empty, ...members];
    const view = createLocaleRender('en', { taskCache: true })(list(snapshot(current)));
    const card = document.querySelector<HTMLElement>('[data-goal-id="goal"]')!;
    const toggle = within(card).getByRole('button', { name: 'Expand Goal: goal' });
    const progress = card.querySelector('.goal-list-progress')!;
    expect(progress).toHaveTextContent('1/2 completed');
    expect(progress.querySelectorAll('i')).toHaveLength(1);
    expect(progress.querySelector('i')).toHaveStyle({ width: '50%' });
    fireEvent.click(toggle);
    const done = within(card).getByRole('button', { name: /done.*Done/ });
    done.focus();
    view.rerender(list(snapshot(current.map((item) => item.id === 'done' ? { ...item, status: 'cancelled' } : item))));
    expect(progress).toHaveTextContent('0/1 completed');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(done).toHaveFocus();
    view.rerender(list(snapshot(current.map((item) => item.type === 'task' ? { ...item, status: 'cancelled' } : item))));
    expect(progress).toHaveTextContent('0/0 completed');
    expect(progress.querySelector('i')).toHaveStyle({ width: '0%' });
    expect(within(card).queryByText('This Goal has no child tasks yet.')).toBeNull();
    expect(within(card).getByText('cancelled', { selector: '.root-title' })).toBeVisible();
  });

  it('updates membership and dependency changes without losing surviving rows or expansion', () => {
    const twoChains = [...tasks, summary('alpha', 'task', goal.id, 'todo'), summary('beta', 'task', goal.id, 'todo', { dependsOn: ['alpha'] })];
    const view = createLocaleRender('en', { taskCache: true })(list(snapshot(twoChains)));
    const card = document.querySelector<HTMLElement>('[data-goal-id="goal"]')!;
    const toggle = within(card).getByRole('button', { name: 'Expand Goal: goal' });
    fireEvent.click(toggle);
    const child = document.getElementById('chain-task-goal-goal-child')!;
    child.focus();
    view.rerender(list(snapshot(twoChains)));
    expect(child).toHaveFocus();
    expect(document.getElementById(child.id)).toBe(child);
    const merged = twoChains.map(task => task.id === 'alpha' ? { ...task, dependsOn: ['root'] } : task);
    view.rerender(list(snapshot(merged)));
    expect(document.getElementById(child.id)).toBe(child);
    expect(child).toHaveFocus();
    expect(card.querySelectorAll('.goal-task-main')).toHaveLength(4);
    expect(card.querySelector('.root-toggle')).toBeNull();
    const moved = merged.map(task => task.id === 'child' ? { ...task, parentId: other.id } : task);
    view.rerender(list(snapshot(moved)));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveFocus();
    expect(document.getElementById(child.id)).toBeNull();
    view.rerender(list(snapshot(twoChains)));
    expect(document.getElementById(child.id)).toBeVisible();
  });

  it('sorts the complete direct member set in snapshot order with precise terminal times', () => {
    const members = [
      summary('todo-a', 'task', goal.id, 'todo'),
      summary('done-a', 'task', goal.id, 'done', { completedAt: '2026-10-20T12:00:00.12345678Z' }),
      summary('running', 'task', goal.id, 'in_progress'),
      summary('todo-b', 'task', goal.id, 'todo', { dependsOn: ['todo-a'] }),
      summary('cancelled-newer', 'task', goal.id, 'cancelled', { cancelledAt: '2026-10-20T12:00:00.123456781Z' }),
      summary('proposed', 'task', goal.id, 'proposed'),
      summary('done-equal', 'task', goal.id, 'done', { completedAt: '2026-10-20T12:00:00.123456780Z' }),
      summary('done-unknown', 'task', goal.id, 'done'),
      summary('outside', 'task', other.id, 'todo', { dependsOn: ['todo-a'] }),
    ];
    const ordered = (items: TaskSummary[]) => {
      const value = snapshot(items);
      return { ...value, index: buildGraphIndex({ ...value.graph, tasks: items.filter(item => item.type === 'task').map(item => value.index.nodes.get(item.id)!) }) };
    };
    const view = createLocaleRender('en', { taskCache: true })(list(ordered([goal, other, empty, ...members])));
    const card = document.querySelector<HTMLElement>('[data-goal-id="goal"]')!;
    const toggle = card.querySelector<HTMLButtonElement>('.goal-list-toggle')!;
    expect(toggle).toHaveAccessibleDescription(/8 tasks/);
    fireEvent.click(toggle);
    const titles = () => [...card.querySelectorAll('.goal-task-main .root-title')].map(node => node.textContent);
    expect(titles()).toEqual(['running', 'todo-a', 'todo-b', 'proposed', 'cancelled-newer', 'done-a', 'done-equal', 'done-unknown']);
    const first = document.getElementById('chain-task-goal-goal-todo-a')!;
    view.rerender(list(ordered([goal, other, empty, ...members.toReversed().map(task => task.id === 'running' ? { ...task, status: 'todo' as const } : task)])));
    expect(titles()).toEqual(['todo-b', 'running', 'todo-a', 'proposed', 'cancelled-newer', 'done-equal', 'done-a', 'done-unknown']);
    expect(document.getElementById(first.id)).toBe(first);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('publishes Session controls only for visible expanded Goals and restores focus on Session-only withdrawal', async () => {
    const firstGoal = '00000000-0000-4000-8000-000000000301';
    const secondGoal = '00000000-0000-4000-8000-000000000302';
    const firstTask = '00000000-0000-4000-8000-000000000303';
    const secondTask = '00000000-0000-4000-8000-000000000304';
    const worker = { ...claim('active'), userId: TEST_VIEWER_ID };
    const details = [detailFixture(projectId, firstGoal, { type: 'goal', title: 'First Goal' }),
      detailFixture(projectId, secondGoal, { type: 'goal', title: 'Second Goal' }),
      detailFixture(projectId, firstTask, { title: 'First Task', parentId: firstGoal, status: 'in_progress', properties: { worker } }),
      detailFixture(projectId, secondTask, { title: 'Second Task', parentId: secondGoal, status: 'in_progress', properties: { worker } })];
    const graph = graphFixture(details); const value = snapshotFixture(details);
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const signal = new AbortController().signal; const ticket = await scope.beginSync(projectId, signal);
    const sync = taskSyncFromGraph(graph, { sessions: { [firstTask]: 'notice', [secondTask]: 'working' }, versionForTask: () => 1n,
      propertiesForTask: (task) => details.find(item => item.id === task.id)!.properties });
    const result = await scope.applySync(ticket, sync, signal);
    const store = new TaskSessionSummaryStore(scope, projectId); store.start();
    store.replace({ project: result.project, observedBindings: deriveTaskSyncBindings(ticket, sync), sessions: sync.sessions, receivedMonotonic: performance.now() });
    const records: { callback: IntersectionObserverCallback; element: Element | null; disconnect: ReturnType<typeof vi.fn<() => void>> }[] = [];
    class Observer {
      record: typeof records[number];
      constructor(callback: IntersectionObserverCallback) { this.record = { callback, element: null, disconnect: vi.fn() }; records.push(this.record); }
      observe(element: Element) { this.record.element = element; }
      disconnect() { this.record.disconnect(); }
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const openSession = vi.fn();
    const view = createLocaleRender('en', { taskCache: true })(<TaskSessionSummaryProvider store={store}>
      <TaskExecutionClockProvider projectId={projectId} snapshot={value}><GoalList projectId={projectId} index={value.index} summaries={value.summaries}
        goals={[value.summaries.get(firstGoal)!, value.summaries.get(secondGoal)!]} total={2} workerMachines={value.workerMachines}
        onOpenGoal={noop} onOpenGoalGraph={noop} onOpenGoalGraphTask={noop} onOpenListTask={noop} onOpenListChain={noop}
        openGraphTarget={null} onCloseChain={noop} onOpenTask={noop} onOpenSession={openSession} /></TaskExecutionClockProvider>
      <button type="button">Outside</button>
    </TaskSessionSummaryProvider>);
    try {
      expect(records).toHaveLength(0);
      const firstCard = document.querySelector<HTMLElement>(`[data-goal-id="${firstGoal}"]`)!;
      const secondCard = document.querySelector<HTMLElement>(`[data-goal-id="${secondGoal}"]`)!;
      const firstToggle = firstCard.querySelector<HTMLButtonElement>('.goal-list-toggle')!;
      fireEvent.click(firstToggle); fireEvent.click(secondCard.querySelector('.goal-list-toggle')!);
      expect(records).toHaveLength(2);
      const visible = (record: typeof records[number], isIntersecting: boolean) => act(() => record.callback([{ target: record.element!, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver));
      expect(firstCard.querySelector('.session-status-action')).toBeNull();
      visible(records[0]!, true);
      const session = firstCard.querySelector<HTMLButtonElement>('.session-status-action')!;
      expect(session).toHaveAttribute('data-session-indicator', 'notice');
      expect(secondCard.querySelector('.session-status-action')).toBeNull();
      fireEvent.click(session); expect(openSession).toHaveBeenCalledWith(firstTask, session);
      visible(records[1]!, true);
      expect(secondCard.querySelector('.session-status-action')).toHaveAttribute('data-session-indicator', 'working');
      session.focus();
      visible(records[0]!, false);
      expect(firstCard.querySelector('.session-status-action')).toBeNull();
      expect(firstCard.querySelector('.goal-task-main')).toHaveFocus();
      expect(secondCard.querySelector('.session-status-action')).toBeVisible();
      visible(records[0]!, true);
      screen.getByRole('button', { name: 'Outside' }).focus();
      visible(records[0]!, false);
      expect(screen.getByRole('button', { name: 'Outside' })).toHaveFocus();
      fireEvent.click(firstToggle);
      expect(records[0]!.disconnect).toHaveBeenCalled();
      visible(records[0]!, true);
      expect(store.snapshot().has(firstTask)).toBe(false);
      expect(store.snapshot().has(secondTask)).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally { view.unmount(); store.dispose(); scope.dispose(); vi.unstubAllGlobals(); }
  });

});
