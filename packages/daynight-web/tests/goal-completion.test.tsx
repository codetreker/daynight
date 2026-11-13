import { fireEvent, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import type { TaskDetail } from '../src/api/types';
import { GoalDetailSurface } from '../src/features/goal-detail/GoalDetailSurface';
import { GoalList } from '../src/features/projects/GoalList';
import { TaskExecutionClockProvider } from '../src/features/task-execution/TaskExecutionClock';
import type { useTaskDetail } from '../src/features/task-detail/useTaskDetail';
import { detailFixture, snapshotFixture } from './helpers/taskDetail';
import { createLocaleRender } from './helpers/renderWithLocale';

vi.mock('../src/features/task-detail/attachments/useAttachments', () => ({ useAttachments: () => ({ select: vi.fn() }) }));
vi.mock('../src/features/task-detail/attachments/TaskAttachments', () => ({ TaskAttachmentsPanel: () => null }));
vi.mock('../src/features/task-thread/TaskDiscussion', () => ({ TaskDiscussion: () => null }));
vi.mock('../src/features/task-detail/TaskOrganization', () => ({ TaskOrganization: () => null, FormDialog: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../src/features/task-assignment/TaskAssigneeSelect', () => ({ TaskAssigneeSelect: () => null }));
vi.mock('../src/features/task-assignment/TaskAssigneeIdentity', () => ({ TaskAssigneeIdentity: () => null }));

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const projectId = id(100), goalId = id(200), otherId = id(201);
const firstAt = '2026-10-22T09:59:10Z', lastAt = '2026-10-22T09:59:30Z', goalAt = '2026-10-22T09:59:50Z';
const goal = detailFixture(projectId, goalId, { type: 'goal', title: 'Goal', status: 'done', completedAt: goalAt, ready: false });
const otherGoal = detailFixture(projectId, otherId, { type: 'goal', title: 'Other', ready: false });
const items = [goal, otherGoal,
  detailFixture(projectId, id(1), { title: 'Outside', parentId: otherId, status: 'done', completedAt: goalAt }),
  detailFixture(projectId, id(2), { title: 'First', parentId: goalId, status: 'done', completedAt: firstAt, dependsOn: [id(1)] }),
  detailFixture(projectId, id(3), { title: 'Second', parentId: goalId, status: 'done', completedAt: lastAt, dependsOn: [id(2)] }),
  detailFixture(projectId, id(4), { title: 'Unfinished', parentId: goalId, status: 'todo' }),
];
const noop = () => {};
const state = { detail: goal, mutation: { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null }, historyGeneration: 1,
  canEditGoal: false, canDisplayStatus: false, canSetStatus: false, canDisplayAssignee: false, canSetAssignedTo: false,
  canDisplayDelete: false, canDelete: false, assignmentUncertain: false,
} as unknown as ReturnType<typeof useTaskDetail>;
const view = (tasks: TaskDetail[], withSnapshot = true) => {
  const snapshot = snapshotFixture(tasks);
  const currentGoal = tasks.find(item => item.id === goalId)!;
  return <TaskExecutionClockProvider projectId={projectId} snapshot={withSnapshot ? snapshot : null}>
    <GoalList projectId={projectId} index={snapshot.index} goals={[snapshot.summaries.get(goalId)!]} total={1} workerMachines={snapshot.workerMachines} onOpenGoal={noop} onOpenGoalGraph={noop} onOpenGoalGraphTask={noop} onOpenListTask={noop} onOpenListChain={noop} openGraphTarget={null} onCloseChain={noop} onOpenTask={noop} />
    <GoalDetailSurface projectId={projectId} taskId={goalId} detail={currentGoal} resourceState={state} snapshot={withSnapshot ? snapshot : null} presentation="page" fullscreen={{ active: false, onChange: noop }} onSelectTask={noop} onRefreshGraph={noop} />
  </TaskExecutionClockProvider>;
};

it('keeps Goal facts independent of children and aggregates only scoped members across updates', () => {
  const render = createLocaleRender('en', { taskCache: true });
  const result = render(view(items));
  const card = document.querySelector<HTMLElement>('[data-goal-id]')!;
  const surface = document.querySelector<HTMLElement>('.goal-detail-surface')!;
  expect(card.querySelector(`time[datetime="${goalAt}"]`)).not.toBeNull();
  expect(surface.querySelector(`.goal-detail-meta time[datetime="${goalAt}"]`)).not.toBeNull();
  fireEvent.click(card.querySelector('.goal-list-toggle')!);
  expect(within(card).getByRole('button', { name: /Unfinished.*To do/ })).toBeVisible();
  const first = card.querySelector<HTMLButtonElement>(`#chain-task-goal-${goalId}-${id(2)}`)!;
  const second = card.querySelector<HTMLButtonElement>(`#chain-task-goal-${goalId}-${id(3)}`)!;
  expect(first.querySelector(`time[datetime="${firstAt}"]`)).not.toBeNull();
  expect(second.querySelector(`time[datetime="${lastAt}"]`)).not.toBeNull();
  first.focus();
  const changed = items.map(item => item.id === id(3) ? { ...item, completedAt: null } : item);
  result.rerender(view(changed));
  expect(second.querySelector('time')).toBeNull();
  expect(card.querySelector('.goal-list-toggle')).toHaveAttribute('aria-expanded', 'true');
  expect(first).toHaveFocus();
  expect(first.querySelector(`time[datetime="${firstAt}"]`)).not.toBeNull();
  result.rerender(view(items.map(item => item.id === id(3) ? { ...item, status: 'todo' as const, completedAt: null } : item)));
  expect(second.querySelector('time')).toBeNull();
  const allDoneGoalOpen = items.map(item => item.id === goalId ? { ...item, status: 'in_progress' as const, completedAt: null } : item.id === id(4) ? { ...item, status: 'done' as const, completedAt: firstAt } : item);
  result.rerender(view(allDoneGoalOpen));
  expect(card.querySelector('.goal-list-meta time')).toBeNull();
  expect(surface.querySelector('.goal-detail-meta time')).toBeNull();
  expect(second.querySelector(`time[datetime="${lastAt}"]`)).not.toBeNull();
  result.rerender(view(items.map(item => item.id === goalId ? { ...item, status: 'cancelled' as const } : item)));
  expect(card.querySelector('.goal-list-meta time')).toBeNull();
  result.rerender(view(items.map(item => item.id === goalId ? { ...item, completedAt: null } : item)));
  expect(card).toHaveTextContent('Done');
  expect(card.querySelector('.goal-list-meta time')).toBeNull();
  const newTime = '2026-10-22T10:00:00Z';
  result.rerender(view(items.map(item => item.id === goalId ? { ...item, completedAt: newTime } : item)));
  expect(card.querySelector(`time[datetime="${newTime}"]`)).not.toBeNull();
  expect(surface.querySelector(`.goal-detail-meta time[datetime="${newTime}"]`)).not.toBeNull();
});

it('reads the exact Goal fact before the shared clock has a sample', () => {
  createLocaleRender('en', { taskCache: true })(view(items, false));
  expect(document.querySelector(`.goal-detail-meta time[datetime="${goalAt}"]`)).toHaveTextContent('2026');
  expect(screen.getByText('Completion time:', { exact: false })).toBeVisible();
  expect(document.querySelector('.goal-list-meta time')).toBeNull();
});
