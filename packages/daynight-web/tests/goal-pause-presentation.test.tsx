import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TaskDetail } from '../src/api/types';
import { GoalDetailSurface } from '../src/features/goal-detail/GoalDetailSurface';
import type { useTaskDetail } from '../src/features/task-detail/useTaskDetail';
import { installGraphMeasurements } from './graph-measurements';
import { renderWithLocale } from './helpers/renderWithLocale';
import { detailFixture, snapshotFixture } from './helpers/taskDetail';

vi.mock('../src/features/task-detail/attachments/useAttachments', () => ({ useAttachments: () => ({ select: vi.fn() }) }));
vi.mock('../src/features/task-detail/attachments/TaskAttachments', () => ({ TaskAttachmentsPanel: () => null }));
vi.mock('../src/features/task-thread/TaskDiscussion', () => ({ TaskDiscussion: () => null }));
vi.mock('../src/features/task-detail/TaskOrganization', () => ({ TaskOrganization: () => null, FormDialog: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../src/features/task-assignment/TaskAssigneeSelect', () => ({ TaskAssigneeSelect: () => null }));
vi.mock('../src/features/task-assignment/TaskAssigneeIdentity', () => ({ TaskAssigneeIdentity: () => null }));

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const projectId = id(100), goalId = id(200);
const goal = detailFixture(projectId, goalId, { type: 'goal', title: 'Goal', ready: false });
const task = { detail: goal, mutation: { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null }, historyGeneration: 1,
  canEditGoal: false, canDisplayStatus: false, canSetStatus: false, canDisplayAssignee: false, canSetAssignedTo: false,
  canDisplayDelete: false, canDelete: false, assignmentUncertain: false,
} as unknown as ReturnType<typeof useTaskDetail>;
const initial = [
  goal,
  detailFixture(projectId, id(1), { parentId: goalId, title: 'Done task', status: 'done', properties: { paused: true } }),
  detailFixture(projectId, id(2), { parentId: goalId, title: 'Active task', status: 'in_progress', dependsOn: [id(1), id(4)], externalDependsOn: [id(4)], properties: { paused: true } }),
  detailFixture(projectId, id(3), { parentId: goalId, title: 'Cancelled task', status: 'cancelled', dependsOn: [id(1)], properties: { paused: true } }),
  detailFixture(projectId, id(4), { title: 'External task', status: 'cancelled', properties: { paused: true } }),
  detailFixture(projectId, id(5), { parentId: goalId, title: 'False task', properties: { paused: false } }),
  detailFixture(projectId, id(6), { parentId: goalId, title: 'Absent task', properties: {} }),
];
const change = (tasks: TaskDetail[], target: number, patch: Partial<TaskDetail>) => tasks.map(item => item.id === id(target) ? { ...item, ...patch } : item);
const noop = () => {};
const surface = (tasks: TaskDetail[], presentation: 'dialog' | 'page') => <GoalDetailSurface projectId={projectId} taskId={goalId} detail={goal} resourceState={task}
  snapshot={snapshotFixture(tasks)} presentation={presentation} fullscreen={{ active: false, onChange: noop }} onSelectTask={noop} onClose={noop} onRefreshGraph={noop} />;
const row = (n: number) => document.querySelector(`[data-goal-task-id="${id(n)}"]`)!;
const badge = (element: Element) => element.querySelector('.task-paused-badge');
let root: HTMLDivElement;
beforeEach(() => { root = document.createElement('div'); root.id = 'root'; document.body.append(root); });
afterEach(() => { root.remove(); });

it.each(['dialog', 'page'] as const)('shows Goal row and graph pauses from the current snapshot in %s presentation', async (presentation) => {
  installGraphMeasurements();
  const view = renderWithLocale(surface(initial, presentation), { locale: 'en', taskCache: true, container: root });
  fireEvent.click(document.querySelector('.goal-detail-disclosure')!);
  for (const n of [1, 2, 3]) expect(badge(row(n))).toHaveTextContent('Paused');
  for (const n of [5, 6]) expect(badge(row(n))).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'View dependencies' }));
  const graph = document.querySelector('.task-chain-dialog')!;
  await waitFor(() => expect(graph.querySelectorAll('.task-node-paused')).toHaveLength(4));
  expect(within(graph as HTMLElement).getByText('2 paused')).toBeVisible();
  const close = graph.querySelector<HTMLButtonElement>('.task-chain-close')!;
  close.focus();

  let next = change(initial, 2, { status: 'done' });
  view.rerender(surface(next, presentation));
  expect(document.querySelector('.task-chain-dialog')).toBe(graph);
  expect(within(graph as HTMLElement).getByText('1 paused')).toBeVisible();
  expect(badge(row(2))).toHaveTextContent('Paused');
  expect(close).toHaveFocus();
  next = change(next, 3, { properties: { paused: false } });
  view.rerender(surface(next, presentation));
  expect(graph.querySelector('.task-pause-count')).toBeNull();
  expect(badge(row(3))).toBeNull();
  expect(badge(row(1))).toHaveTextContent('Paused');
  next = change(next, 2, { status: 'todo' });
  view.rerender(surface(next, presentation));
  expect(within(graph as HTMLElement).getByText('1 paused')).toBeVisible();
  next = change(next, 2, { properties: {} });
  view.rerender(surface(next, presentation));
  expect(graph.querySelector('.task-pause-count')).toBeNull();
  expect(badge(row(2))).toBeNull();
  await waitFor(() => expect(graph.querySelectorAll('.task-node-paused')).toHaveLength(2));
  expect(document.querySelector('.goal-detail-disclosure')).toHaveAttribute('aria-expanded', 'true');
  expect(document.querySelector('.task-chain-dialog')).toBe(graph);
});
