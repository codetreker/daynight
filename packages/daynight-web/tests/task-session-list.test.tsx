import { act, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { TaskDetail, TaskSync, WorkerClaim } from '../src/api/types';
import { TaskExecutionClockProvider } from '../src/features/task-execution/TaskExecutionClock';
import { ProjectTaskWorkspace } from '../src/features/projects/ProjectTaskWorkspace';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { deriveTaskSyncBindings } from '../src/features/task-cache/execution-binding';
import { TaskSessionSummaryStore } from '../src/features/task-session-summary/store';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { renderWithLocale } from './helpers/renderWithLocale';
import { taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';

const id = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const projectId = id(100);
const rootId = id(1);
const childId = id(2);
const otherId = id(3);
const externalId = id(4);
const bridgeId = id(5);
const goalId = id(10);
const otherGoalId = id(11);
const worker: WorkerClaim = { claimId: id(201), state: 'active', userId: TEST_VIEWER_ID, workerId: id(202), worktreeId: id(203),
  machine: { id: id(202), name: 'Test host' }, platform: 'linux', agent: 'codex', agentControlMode: 'web',
  phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: '2026-10-22T10:00:00Z' };
const task = (taskId: string, changes: Partial<TaskDetail> = {}): TaskDetail => detailFixture(projectId, taskId, {
  title: `Task ${taskId.slice(-1)}`, status: 'in_progress', startedAt: '2026-10-22T10:00:00Z', properties: { worker: { ...worker } }, ...changes,
});

const scopes: TaskCacheScope[] = [];
const stores: TaskSessionSummaryStore[] = [];
afterEach(() => { stores.splice(0).forEach((store) => store.dispose()); scopes.splice(0).forEach((scope) => scope.dispose()); });
async function fixture(sessions: TaskSync['sessions'], rootActive = false, goalMode = false) {
  const tasks = [task(rootId, { ...(rootActive ? {} : { status: 'done', completedAt: '2026-10-22T10:00:01Z', properties: {} }), ...(goalMode ? { parentId: goalId } : {}) }),
    task(childId, { dependsOn: [rootId], ...(goalMode ? { parentId: goalId } : {}), ...(rootActive ? { status: 'todo' as const, startedAt: null, properties: {} } : {}) }),
    task(otherId, { dependsOn: [rootId], ...(goalMode ? { parentId: otherGoalId } : {}), ...(rootActive ? { status: 'todo' as const, startedAt: null, properties: {} } : {}) }),
    task(externalId), task(bridgeId, { status: 'todo', startedAt: null, properties: {}, dependsOn: [childId, externalId], externalDependsOn: [externalId] })];
  if (goalMode) tasks.push(task(goalId, { type: 'goal', status: 'todo', startedAt: null, properties: {} }), task(otherGoalId, { type: 'goal', status: 'todo', startedAt: null, properties: {} }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    disconnect() {}
  });
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const signal = new AbortController().signal;
  const ticket = await scope.beginSync(projectId, signal);
  const sync = taskSyncFromGraph(graphFixture(tasks), { sessions, versionForTask: () => 1n, propertiesForTask: (node) => tasks.find((item) => item.id === node.id)!.properties });
  const result = await scope.applySync(ticket, sync, signal);
  const store = new TaskSessionSummaryStore(scope, projectId); stores.push(store); store.start();
  store.replace({ project: result.project, observedBindings: deriveTaskSyncBindings(ticket, sync), sessions, receivedMonotonic: performance.now() });
  const snapshot: GraphSnapshot = { graph: result.project.graph, index: result.project.index, summaries: result.project.summaries, pausedTaskIds: result.project.pausedTaskIds,
    workerMachines: result.project.workerMachines, observedAt: sync.observedAt, receivedMonotonic: performance.now(), receivedAt: Date.now(), revision: 1 };
  const onOpenTask = vi.fn(); const onOpenSession = vi.fn(); const onOpenChain = vi.fn(); const noop = () => {};
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const workspace = (active = true) => <TaskExecutionClockProvider projectId={projectId} snapshot={snapshot}><ProjectTaskWorkspace pausedTaskCount={0} snapshot={snapshot} sessionStore={store} active={active}
    goalCount={goalMode ? 2 : 0} goals={{ projectId, goals: goalMode ? [result.project.summaries.get(goalId)!, result.project.summaries.get(otherGoalId)!] : [], total: goalMode ? 2 : 0, onOpenGoal: noop, onOpenGoalGraph: noop, onOpenGoalGraphTask: noop, openGraphTarget: null, onCloseChain: noop, onOpenTask: noop, onOpenListTask: onOpenTask, onOpenListChain: noop, onOpenSession }}
    activeView={goalMode ? 'goals' : 'chains'} unfinishedStandaloneTaskCount={0} unfinishedChainTaskCount={1} onViewChange={noop}
    chains={{ projectId, representativeIds: [rootId], allRepresentativeIds: [rootId], openGraphTarget: null, onOpenChain, onCloseChain: noop, onOpenTask, onOpenSession }}
    standalone={{ projectId, taskIds: [], allTaskIds: [], onSelectTask: noop }} /></TaskExecutionClockProvider>;
  const view = renderWithLocale(workspace(), { taskCache: { scope }, locale: 'zh-CN' });
  const replace = (next: TaskSync['sessions']) => act(() => store.replace({ project: result.project,
    observedBindings: deriveTaskSyncBindings(ticket, sync), sessions: next, receivedMonotonic: performance.now() }));
  const header = () => document.querySelector<HTMLElement>(`[data-chain-id="${rootId}"] > .goal-header`)!;
  return { view, workspace, store, fetch, replace, header, onOpenTask, onOpenSession, onOpenChain };
}

it('includes an active root in its collapsed chain aggregate', async () => {
  const value = await fixture({ [rootId]: 'warning', [externalId]: 'notice' }, true);
  expect(document.getElementById(`task-root-${rootId}`)).toHaveAttribute('aria-expanded', 'false');
  expect(value.header().querySelector('[data-session-indicator]')).toHaveAttribute('data-session-indicator', 'warning');
  expect(value.fetch).not.toHaveBeenCalled();
});

it('aggregates all collapsed members with warning > notice > working and no external contribution', async () => {
  const value = await fixture({ [childId]: 'warning', [otherId]: 'working', [externalId]: 'warning' });
  const toggle = document.getElementById(`task-root-${rootId}`)!;
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(value.header().querySelector('[data-session-indicator]')).toHaveAttribute('data-session-indicator', 'warning');
  value.replace({ [childId]: 'notice', [otherId]: 'working', [externalId]: 'warning' });
  expect(value.header().querySelector('[data-session-indicator]')).toHaveAttribute('data-session-indicator', 'notice');
  value.replace({ [otherId]: 'working', [externalId]: 'warning' });
  expect(value.header().querySelector('[data-session-indicator]')).toHaveAttribute('data-session-indicator', 'working');
  value.replace({ [externalId]: 'warning' });
  expect(value.header().querySelector('[data-session-indicator]')).toBeNull();
  expect(toggle).toHaveAttribute('aria-expanded', 'false'); expect(value.fetch).not.toHaveBeenCalled();
});

it('keeps chain expansion, Task details and pending Session shortcuts as separate actions', async () => {
  const value = await fixture({ [otherId]: 'working', [childId]: 'pending' });
  fireEvent.click(value.header().querySelector<HTMLButtonElement>('.session-status-action')!);
  expect(document.getElementById(`task-root-${rootId}`)).toHaveAttribute('aria-expanded', 'true');
  expect(value.onOpenTask).not.toHaveBeenCalled(); expect(value.onOpenSession).not.toHaveBeenCalled();
  const main = document.getElementById(`chain-task-${rootId}-${childId}`)!;
  fireEvent.click(main); expect(value.onOpenTask).toHaveBeenCalledWith(childId, main);
  const row = main.closest('.goal-task-row')!;
  const shortcut = within(row as HTMLElement).getByRole('button', { name: /当前会话可访问.*打开 Session/ });
  expect(shortcut.querySelector('.session-status-annotation')).toBeNull();
  fireEvent.pointerDown(shortcut, { pointerType: 'touch' }); fireEvent.click(shortcut);
  expect(value.onOpenSession).toHaveBeenCalledWith(childId, shortcut); expect(value.onOpenTask).toHaveBeenCalledTimes(1);
  fireEvent.click(document.querySelector<HTMLButtonElement>('.goal-detail-link')!);
  expect(value.onOpenTask).toHaveBeenLastCalledWith(rootId, expect.any(HTMLElement));
  expect(value.onOpenChain).not.toHaveBeenCalled(); expect(value.fetch).not.toHaveBeenCalled();
});

it('keeps focused shortcut nodes and expanded state through Session updates, with accessible tooltip dismissal', async () => {
  const value = await fixture({ [childId]: 'notice' });
  fireEvent.click(document.getElementById(`task-root-${rootId}`)!);
  const row = document.getElementById(`chain-task-${rootId}-${childId}`)!.closest<HTMLElement>('.goal-task-row')!;
  const shortcut = row.querySelector<HTMLButtonElement>('.session-status-action')!;
  const user = userEvent.setup();
  act(() => shortcut.focus());
  expect(within(document.body).getByRole('tooltip')).toHaveTextContent('会话需要响应');
  await user.keyboard('{Escape}'); expect(within(document.body).queryByRole('tooltip')).toBeNull();
  value.replace({ [childId]: 'working' });
  expect(row.querySelector('.session-status-action')).toBe(shortcut); expect(shortcut).toHaveFocus();
  expect(shortcut).toHaveAccessibleName(/会话工作中/);
  expect(document.getElementById(`task-root-${rootId}`)).toHaveAttribute('aria-expanded', 'true');
  await user.keyboard('{Enter}'); expect(value.onOpenSession).toHaveBeenCalledWith(childId, shortcut);
  value.replace({}); expect(row.querySelector('.session-status-action')).toBeNull();
  expect(document.getElementById(`task-root-${rootId}`)).toHaveAttribute('aria-expanded', 'true'); expect(value.fetch).not.toHaveBeenCalled();
});

it('projects Session observations into independent Goal members and hides them with the workspace', async () => {
  const value = await fixture({ [childId]: 'warning', [otherId]: 'working', [externalId]: 'warning' }, false, true);
  const firstGoal = document.querySelector<HTMLElement>(`[data-goal-id="${goalId}"]`)!;
  const secondGoal = document.querySelector<HTMLElement>(`[data-goal-id="${otherGoalId}"]`)!;
  const firstToggle = firstGoal.querySelector<HTMLButtonElement>('.goal-list-toggle')!;
  const secondToggle = secondGoal.querySelector<HTMLButtonElement>('.goal-list-toggle')!;
  fireEvent.click(firstToggle); fireEvent.click(secondToggle);
  const indicator = (goal: HTMLElement) => goal.querySelector('.goal-task-row [data-session-indicator]');
  expect(indicator(firstGoal)).toHaveAttribute('data-session-indicator', 'warning');
  expect(indicator(secondGoal)).toHaveAttribute('data-session-indicator', 'working');
  value.replace({ [childId]: 'notice', [otherId]: 'working', [externalId]: 'warning' });
  expect(indicator(firstGoal)).toHaveAttribute('data-session-indicator', 'notice');
  value.replace({ [childId]: 'working', [otherId]: 'warning' });
  expect(indicator(firstGoal)).toHaveAttribute('data-session-indicator', 'working');
  expect(indicator(secondGoal)).toHaveAttribute('data-session-indicator', 'warning');
  value.replace({ [childId]: 'pending', [otherId]: 'working' });
  const row = firstGoal.querySelector<HTMLElement>(`.goal-task-main[id$="-${childId}"]`)!.closest<HTMLElement>('.goal-task-row')!;
  const shortcut = within(row).getByRole('button', { name: /当前会话可访问.*打开 Session/ });
  fireEvent.click(shortcut);
  expect(value.onOpenSession).toHaveBeenCalledWith(childId, shortcut);
  expect(value.onOpenTask).not.toHaveBeenCalled();
  fireEvent.click(firstToggle);
  expect(value.store.snapshot().has(childId)).toBe(false);
  expect(indicator(secondGoal)).toHaveAttribute('data-session-indicator', 'working');
  expect(value.store.snapshot().has(otherId)).toBe(true);
  fireEvent.click(firstToggle);
  expect(value.store.snapshot().has(childId)).toBe(true);
  value.view.rerender(value.workspace(false));
  expect(value.store.snapshot().size).toBe(0);
  expect(secondGoal.querySelector('[data-session-indicator]')).toBeNull();
  value.view.rerender(value.workspace());
  expect(indicator(secondGoal)).toHaveAttribute('data-session-indicator', 'working');
  expect(value.fetch).not.toHaveBeenCalled();
});
