import { TagFilter, useTagFilter } from '../src/features/task-tags/TagFilter';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TaskSummary } from '../src/api/types';
import { listProjectTags, resolveProjectTags } from '../src/api/task-tags';
import { projectSummaries } from '../src/features/task-cache/projection';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { TaskExecutionClockProvider } from '../src/features/task-execution/TaskExecutionClock';
import { ProjectTaskWorkspace } from '../src/features/projects/ProjectTaskWorkspace';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { TaskSessionSummaryStore } from '../src/features/task-session-summary/store';
import { renderWithLocale } from './helpers/renderWithLocale';
import { statesForSummaries, TEST_VIEWER_ID } from './helpers/taskSync';

vi.mock('../src/api/task-tags', async original => ({ ...await original<typeof import('../src/api/task-tags')>(), listProjectTags: vi.fn(), resolveProjectTags: vi.fn() }));
const time = '2026-10-20T12:00:00Z';
const projectId = '00000000-0000-4000-8000-000000000101';
const project = { id: projectId, name: 'Project', repoUrl: 'https://example.test/project', ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const summary = (id: string, type: 'task' | 'goal', parentId: string | null, status: TaskSummary['status'], changes: Partial<TaskSummary> = {}): TaskSummary => ({
  tags: [], id, type, parentId, status, titlePreview: id, titleTruncated: false, assignedTo: null, requiredPlatform: null, allowAgents: false,
  dependsOn: [], externalDependsOn: [], properties: {}, version: 1n, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, ...changes,
});
const snapshot = (tasks: TaskSummary[]): GraphSnapshot => ({ ...projectSummaries(project, tasks, statesForSummaries(tasks), time), summaries: new Map(tasks.map(task => [task.id, task])), observedAt: time, receivedMonotonic: 0, receivedAt: 0, revision: 1 });
let scope: TaskCacheScope;
let store: TaskSessionSummaryStore;
beforeEach(() => {
  scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  store = new TaskSessionSummaryStore(scope, projectId);
  vi.mocked(listProjectTags).mockReset().mockResolvedValue({ items: [{ id: 'tag-a', name: 'alpha', projectId, version: 1n, createdAt: time, updatedAt: time, usage: { tasks: 0, goals: 0 } }], catalogEpoch: 'epoch', nextCursor: null });
  vi.mocked(resolveProjectTags).mockReset().mockResolvedValue([{ id: 'tag-a', name: 'alpha' }]);
});
afterEach(() => { store.dispose(); scope.dispose(); });
const noop = () => {};
const ChildFilteredWorkspace = ({ items }: { readonly items: TaskSummary[] }) => {
  const filter = useTagFilter(projectId);
  const value = snapshot(items);
  return <TaskExecutionClockProvider projectId={projectId} snapshot={value}><ProjectTaskWorkspace snapshot={value} sessionStore={store} activeView="goals" pausedTaskCount={0} unfinishedStandaloneTaskCount={0} unfinishedChainTaskCount={0} goalCount={2} onViewChange={noop} filter={<TagFilter controller={filter} child />}
    goals={{ projectId, childTagFilter: filter, goals: [value.summaries.get('goal')!, value.summaries.get('other')!], summaries: value.summaries, total: 2, onOpenGoal: noop, onOpenGoalGraph: noop, onOpenGoalGraphTask: noop, openGraphTarget: null, onCloseChain: noop, onOpenTask: noop, onOpenListTask: noop, onOpenListChain: noop }}
    chains={{ projectId, representativeIds: [], allRepresentativeIds: [], openGraphTarget: null, onOpenChain: noop, onCloseChain: noop, onOpenTask: noop }}
    standalone={{ projectId, taskIds: [], allTaskIds: [], onSelectTask: noop }} /></TaskExecutionClockProvider>;
};

const workspace = (items: TaskSummary[]) => <ChildFilteredWorkspace items={items} />;

it('summarizes the complete direct scope through the workspace and follows snapshot updates', async () => {
  let items = [
    summary('goal', 'goal', null, 'done', { properties: { paused: true } }), summary('other', 'goal', null, 'todo'),
    summary('external', 'task', null, 'cancelled', { properties: { paused: true } }),
    summary('cross', 'task', 'other', 'todo', { dependsOn: ['child'], properties: { paused: true } }),
    summary('child', 'task', 'goal', 'in_progress', { dependsOn: ['external'], externalDependsOn: ['external'], properties: { paused: true }, tags: [{ id: 'tag-a', name: 'alpha' }] }),
    summary('member', 'task', 'goal', 'cancelled', { dependsOn: ['child'], properties: { paused: true } }),
    summary('standalone', 'task', 'goal', 'todo', { properties: { paused: true } }),
    summary('done', 'task', 'goal', 'done', { properties: { paused: true } }),
    summary('false', 'task', 'goal', 'todo', { properties: { paused: false } }),
    summary('missing', 'task', 'goal', 'todo'),
  ];
  const view = renderWithLocale(workspace(items), { locale: 'en', taskCache: true });
  const card = document.querySelector<HTMLElement>('[data-goal-id="goal"]')!;
  const toggle = card.querySelector<HTMLButtonElement>('.goal-list-toggle')!;
  const count = () => toggle.querySelector<HTMLElement>('.task-pause-count');
  const described = () => toggle.getAttribute('aria-describedby')!.split(/\s+/).every(id => document.getElementById(id) !== null);
  expect(count()).toHaveTextContent('3 paused');
  expect(toggle).toHaveAccessibleDescription(/1 in progress.*3 paused/);
  expect(described()).toBe(true);
  expect(toggle.querySelector('.goal-in-progress')!.nextElementSibling).toContainElement(count());
  fireEvent.click(toggle);
  expect(count()).toHaveTextContent('3 paused');
  fireEvent.click(screen.getByText('Child task tag filter', { selector: 'summary' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'alpha' })).toBeVisible());
  fireEvent.click(screen.getByRole('checkbox', { name: 'alpha' }));
  expect(card.querySelectorAll('.goal-task-row')).toHaveLength(1);
  expect(count()).toHaveTextContent('3 paused');
  toggle.focus();
  items = items.map(item => item.id === 'child' ? { ...item, properties: { paused: false } } : item.id === 'member' ? { ...item, status: 'done' as const, dependsOn: [] } : item.id === 'standalone' ? { ...item, parentId: 'other' } : item);
  view.rerender(workspace(items));
  expect(card.querySelector('.goal-list-toggle')).toBe(toggle);
  expect(toggle).toHaveFocus();
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(count()).toBeNull();
  expect(toggle).not.toHaveAccessibleDescription(/paused/);
  expect(described()).toBe(true);
  items = items.map(item => item.id === 'member' ? { ...item, status: 'cancelled' as const, dependsOn: ['child'] } : item);
  view.rerender(workspace(items));
  expect(count()).toHaveTextContent('1 paused');
  expect(toggle).toHaveAccessibleDescription(/1 paused/);
  view.setLocale('zh-CN');
  expect(count()).toHaveTextContent('1 已暂停');
  expect(toggle).toHaveAccessibleDescription(/1 已暂停/);
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(count()).toHaveTextContent('1 已暂停');
});
