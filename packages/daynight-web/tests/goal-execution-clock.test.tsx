import { act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TaskDetail } from '../src/api/types';
import { TaskExecutionClockProvider } from '../src/features/task-execution/TaskExecutionClock';
import { GoalDetailSurface } from '../src/features/goal-detail/GoalDetailSurface';
import type { useTaskDetail } from '../src/features/task-detail/useTaskDetail';
import { installGraphMeasurements } from './graph-measurements';
import { detailFixture, snapshotFixture } from './helpers/taskDetail';
import { renderWithLocale } from './helpers/renderWithLocale';

vi.mock('../src/features/task-detail/attachments/useAttachments', () => ({ useAttachments: () => ({ select: vi.fn() }) }));
vi.mock('../src/features/task-detail/attachments/TaskAttachments', () => ({ TaskAttachmentsPanel: () => null }));
vi.mock('../src/features/task-thread/TaskDiscussion', () => ({ TaskDiscussion: () => null }));
vi.mock('../src/features/task-detail/TaskOrganization', () => ({ TaskOrganization: () => null, FormDialog: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../src/features/task-assignment/TaskAssigneeSelect', () => ({ TaskAssigneeSelect: () => null }));
vi.mock('../src/features/task-assignment/TaskAssigneeIdentity', () => ({ TaskAssigneeIdentity: () => null }));

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const projectId = id(100), goalId = id(200);
const startedAt = '2026-10-22T10:00:00Z';
const at = (milliseconds: number) => new Date(Date.parse(startedAt) + milliseconds).toISOString();
const goal = detailFixture(projectId, goalId, { type: 'goal', title: 'Timed Goal', ready: false });
const resourceState = { detail: goal, mutation: { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null }, historyGeneration: 1,
  canEditGoal: false, canDisplayStatus: false, canSetStatus: false, canDisplayAssignee: false, canSetAssignedTo: false,
  canDisplayDelete: false, canDelete: false, assignmentUncertain: false,
} as unknown as ReturnType<typeof useTaskDetail>;
const tasks = [goal,
  detailFixture(projectId, id(1), { parentId: goalId, title: 'Completed member', status: 'done', startedAt, completedAt: at(30_000) }),
  detailFixture(projectId, id(2), { parentId: goalId, title: 'Running member', status: 'in_progress', startedAt,
    dependsOn: [id(1), id(3)], externalDependsOn: [id(3)], ready: false }),
  detailFixture(projectId, id(3), { title: 'Timed external prerequisite', status: 'done', startedAt: at(-60_000), completedAt: at(-10_000) }),
];
const noop = () => {};
const surface = (items: TaskDetail[], presentation: 'dialog' | 'page', observed = 59_000) => {
  const snapshot = snapshotFixture(items);
  const sample = { ...snapshot, observedAt: at(observed), receivedMonotonic: 0, receivedAt: Date.parse(at(observed)) };
  return <TaskExecutionClockProvider projectId={projectId} snapshot={sample}><GoalDetailSurface projectId={projectId} taskId={goalId} detail={goal} resourceState={resourceState}
    snapshot={sample} presentation={presentation} goalChildren={{ graphRootId: id(1), task: null }}
    fullscreen={{ active: false, onChange: noop }} onSelectTask={noop} onClose={noop} onRefreshGraph={noop} /></TaskExecutionClockProvider>;
};
const duration = (n: number) => document.querySelector(`[data-id="${id(n)}"] .task-duration`)!;
let root: HTMLDivElement;
let monotonic = 0;
beforeEach(() => {
  root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  monotonic = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  installGraphMeasurements();
});
afterEach(() => { root.remove(); });

it.each(['dialog', 'page'] as const)('restores a Goal graph with timed members and external prerequisites in %s presentation', async (presentation) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const view = renderWithLocale(surface(tasks, presentation), { locale: 'en', taskCache: true, container: root });
  const graph = document.querySelector('.task-chain-dialog')!;
  await waitFor(() => expect(graph.querySelectorAll('.task-node')).toHaveLength(3));
  expect(duration(1)).toHaveAttribute('datetime', 'PT30.000S');
  expect(duration(2)).toHaveAttribute('datetime', 'PT59.000S');
  expect(duration(3)).toHaveAttribute('datetime', 'PT50.000S');
  expect(duration(3).closest('.task-node')).toHaveClass('task-node-external');
  const completed = duration(1), external = duration(3);
  const close = graph.querySelector<HTMLButtonElement>('.task-chain-close')!;
  close.focus();

  monotonic = 2_000;
  act(() => { vi.advanceTimersByTime(1_000); });
  expect(duration(2)).toHaveAttribute('datetime', 'PT61.000S');
  expect(duration(1)).toBe(completed);
  expect(duration(1)).toHaveAttribute('datetime', 'PT30.000S');
  expect(duration(3)).toBe(external);
  expect(close).toHaveFocus();

  const finished = tasks.map(item => item.id === id(2) ? { ...item, status: 'done' as const, completedAt: at(90_000) } : item);
  view.rerender(surface(finished, presentation, 120_000));
  expect(document.querySelector('.task-chain-dialog')).toBe(graph);
  await waitFor(() => expect(duration(2)).toHaveAttribute('datetime', 'PT90.000S'));
  expect(close).toHaveFocus();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
