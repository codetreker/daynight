import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TaskSummary } from '../src/api/types';
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
  id, type, parentId, status, titlePreview: id, titleTruncated: false, assignedTo: null, requiredPlatform: null, allowAgents: false,
  dependsOn: [], externalDependsOn: [], properties: {}, version: 1n, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, ...changes,
});
const snapshot = (tasks: TaskSummary[]): GraphSnapshot => ({ ...projectSummaries(project, tasks, statesForSummaries(tasks), time), summaries: new Map(tasks.map((task) => [task.id, task])), observedAt: time, receivedMonotonic: 0, receivedAt: 0, revision: 1 });
const goal = summary('goal', 'goal', null, 'todo');
const other = summary('other', 'goal', null, 'done');
const empty = summary('empty', 'goal', null, 'todo');
const tasks = [goal, other, empty, summary('root', 'task', other.id, 'done'), summary('child', 'task', goal.id, 'in_progress', { dependsOn: ['root'], startedAt: '2026-10-20T11:50:00Z' }), summary('standalone', 'task', goal.id, 'cancelled'), summary('solo-other', 'task', other.id, 'todo')];
const noop = () => {};
const list = (value: GraphSnapshot, onOpenGoal = vi.fn(), onOpenListTask = vi.fn(), onOpenListChain = vi.fn(), onOpenGoalGraph = vi.fn()) => <TaskPauseProvider taskIds={new Set(['child'])}><TaskExecutionClockProvider projectId={projectId} snapshot={value}>
  <GoalList projectId={projectId} index={value.index} goals={[value.summaries.get(goal.id)!, value.summaries.get(other.id)!, value.summaries.get(empty.id)!]} total={3} workerMachines={value.workerMachines} onOpenGoal={onOpenGoal} onOpenGoalGraph={onOpenGoalGraph} onOpenGoalGraphTask={noop} onOpenListTask={onOpenListTask} onOpenListChain={onOpenListChain} openGraphTarget={null} onCloseChain={noop} onOpenTask={noop} />
</TaskExecutionClockProvider></TaskPauseProvider>;

describe('Goal list', () => {
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

  it('keeps expansion independent and restores nested selection while exposing separate read actions', () => {
    const value = snapshot(tasks);
    const openGoal = vi.fn(); const openTask = vi.fn(); const openChain = vi.fn();
    createLocaleRender('zh-CN', { taskCache: true })(list(value, openGoal, openTask, openChain));
    const first = document.querySelector<HTMLElement>('[data-goal-id="goal"]')!;
    const second = document.querySelector<HTMLElement>('[data-goal-id="other"]')!;
    const toggle = within(first).getByRole('button', { name: '展开 Goal：goal' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(first.querySelector('.goal-list-progress')).toHaveTextContent('0/1 已完成');
    expect(first).toHaveTextContent('待处理');
    fireEvent.click(toggle);
    fireEvent.click(within(second).getByRole('button', { name: '展开 Goal：other' }));
    const chain = within(first).getByRole('button', { name: /root.*1 进行中/ });
    const secondChain = within(second).getByRole('button', { name: /root.*0 进行中/ });
    expect(chain).toHaveAttribute('aria-expanded', 'false');
    expect(chain.getAttribute('aria-controls')).not.toBe(secondChain.getAttribute('aria-controls'));
    fireEvent.click(chain); fireEvent.click(secondChain);
    expect(within(first).getByText('child')).toBeVisible();
    expect(within(first).getByText('已暂停')).toBeVisible();
    expect(first.querySelector('.task-duration')).toHaveTextContent('10 分钟');
    expect(within(first).queryByText('root', { selector: '.goal-task-main .root-title' })).toBeNull();
    const child = document.getElementById('chain-task-goal-goal-chain-root-child')!;
    fireEvent.click(child);
    expect(openTask).toHaveBeenCalledWith('child', child, goal.id);
    const graph = within(first).getByRole('button', { name: /root，查看依赖关系/ });
    fireEvent.click(graph);
    expect(openChain).toHaveBeenCalledWith('child', graph, goal.id);
    const title = within(first).getByRole('button', { name: 'goal' });
    fireEvent.click(title); expect(openGoal).toHaveBeenCalledWith('goal', title);
    fireEvent.click(toggle);
    expect(within(first).queryByText('child')).toBeNull();
    fireEvent.click(toggle);
    expect(within(first).getByRole('button', { name: /root.*1 进行中/ })).toHaveAttribute('aria-expanded', 'true');
    expect(secondChain).toHaveAttribute('aria-expanded', 'true');
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

  it('updates membership without resetting surviving groups and discards removed group state', () => {
    const render = createLocaleRender('en', { taskCache: true });
    const view = render(list(snapshot(tasks)));
    const first = document.querySelector<HTMLElement>('[data-goal-id="goal"]')!;
    fireEvent.click(within(first).getByRole('button', { name: 'Expand Goal: goal' }));
    fireEvent.click(within(first).getByRole('button', { name: /root.*1 in progress/ }));
    view.rerender(list(snapshot(tasks.map((task) => task.id === 'standalone' ? { ...task, status: 'done' } : task))));
    expect(within(first).getByRole('button', { name: /root.*1 in progress/ })).toHaveAttribute('aria-expanded', 'true');
    document.getElementById('chain-task-goal-goal-chain-root-child')!.focus();
    view.rerender(list(snapshot(tasks.map((task) => task.id === 'child' ? { ...task, parentId: other.id } : task))));
    expect(within(first).getByRole('button', { name: 'Collapse Goal: goal' })).toHaveFocus();
    expect(within(first).queryByRole('button', { name: /root.*in progress/ })).toBeNull();
    view.rerender(list(snapshot(tasks)));
    expect(within(first).getByRole('button', { name: /root.*1 in progress/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps two chains independent across an unchanged snapshot and resets a removed group after merge and split', () => {
    const twoChains = [...tasks, summary('alpha', 'task', goal.id, 'todo'), summary('beta', 'task', goal.id, 'todo', { dependsOn: ['alpha'] })];
    const view = createLocaleRender('en', { taskCache: true })(list(snapshot(twoChains)));
    const first = document.querySelector<HTMLElement>('[data-goal-id="goal"]')!;
    fireEvent.click(within(first).getByRole('button', { name: 'Expand Goal: goal' }));
    const rootToggle = document.getElementById('task-root-goal-goal-chain-root')!;
    const alphaToggle = document.getElementById('task-root-goal-goal-chain-alpha')!;
    expect(rootToggle).toHaveAttribute('aria-expanded', 'false');
    expect(alphaToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(rootToggle);
    expect(rootToggle).toHaveAttribute('aria-expanded', 'true');
    expect(alphaToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(alphaToggle);
    fireEvent.click(rootToggle);
    expect(rootToggle).toHaveAttribute('aria-expanded', 'false');
    expect(alphaToggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(rootToggle);
    const child = document.getElementById('chain-task-goal-goal-chain-root-child')!;
    child.focus();
    view.rerender(list(snapshot(twoChains)));
    expect(child).toHaveFocus();
    expect(document.getElementById('chain-task-goal-goal-chain-root-child')).toBe(child);
    expect(rootToggle).toHaveAttribute('aria-expanded', 'true');
    expect(alphaToggle).toHaveAttribute('aria-expanded', 'true');

    const merged = twoChains.map((task) => task.id === 'alpha' ? { ...task, dependsOn: ['root'] } : task);
    view.rerender(list(snapshot(merged)));
    expect(document.getElementById('task-root-goal-goal-chain-alpha')).toBeNull();
    expect(document.getElementById('task-root-goal-goal-chain-root')).toHaveAttribute('aria-expanded', 'true');
    expect(within(first).getByText('alpha', { selector: '.goal-task-main .root-title' })).toBeVisible();
    view.rerender(list(snapshot(twoChains)));
    expect(document.getElementById('task-root-goal-goal-chain-root')).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('task-root-goal-goal-chain-alpha')).toHaveAttribute('aria-expanded', 'false');
  });

});
