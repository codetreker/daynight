import { act, fireEvent, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TaskDetail } from '../src/api/types';
import { ProjectListGraphHost } from '../src/features/task-graph/ProjectListGraphHost';
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
const projectId = id(100), goalId = id(200), otherGoalId = id(201);
const noop = () => {};
const goal = detailFixture(projectId, goalId, { type: 'goal', title: 'Goal', ready: false });
const resourceState = { detail: goal, mutation: { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null }, historyGeneration: 1,
  canEditGoal: false, canDisplayStatus: false, canSetStatus: false, canDisplayAssignee: false, canSetAssignedTo: false,
  canDisplayDelete: false, canDelete: false, assignmentUncertain: false,
} as unknown as ReturnType<typeof useTaskDetail>;
const tasks = () => [goal,
  detailFixture(projectId, id(0), { title: 'External prerequisite', status: 'done' }),
  detailFixture(projectId, id(2), { parentId: goalId, title: 'Root', status: 'done', dependsOn: [id(0)], externalDependsOn: [id(0)] }),
  detailFixture(projectId, id(3), { parentId: goalId, title: 'Member', dependsOn: [id(2)], ready: false }),
  detailFixture(projectId, id(4), { parentId: otherGoalId, title: 'Other Goal', dependsOn: [id(2)], ready: false }),
];
let root: HTMLDivElement;
beforeEach(() => { root = document.createElement('div'); root.id = 'root'; document.body.append(root); installGraphMeasurements(); });
afterEach(() => { root.remove(); vi.unstubAllGlobals(); });
const url = (taskId: string) => `${window.location.origin}/projects/${projectId}?tab=tasks&chain=${taskId}`;
const clickCopy = () => { fireEvent.click(screen.getByRole('button', { name: 'More task chain actions' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' })); };

it('copies the project witness in the graph, including fullscreen, with feedback and retry', async () => {
  const write = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: write } });
  const snapshot = snapshotFixture(tasks());
  const onClose = vi.fn();
  renderWithLocale(<ProjectListGraphHost projectId={projectId} index={snapshot.index} summaries={snapshot.summaries} target={{ kind: 'chain', rootId: id(2), witnessTaskId: id(3) }} onOpenTask={noop} onOpenChain={noop} onClose={onClose} onRestoreFocus={noop} />, { locale: 'en', taskCache: true, container: root });
  const dialog = screen.getByRole('dialog');
  const trigger = within(dialog).getByRole('button', { name: 'More task chain actions' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const item = screen.getByRole('menuitem', { name: 'Copy link' });
  expect(item).toHaveFocus();
  fireEvent.keyDown(item, { key: 'Escape' });
  expect(trigger).toHaveFocus();
  expect(onClose).not.toHaveBeenCalled();
  clickCopy();
  expect(write).toHaveBeenLastCalledWith(url(id(3)));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not copy');
  fireEvent.click(within(dialog).getByRole('button', { name: 'View fullscreen' }));
  expect(dialog).toHaveClass('task-chain-dialog-fullscreen');
  clickCopy();
  expect(await within(dialog).findByText('Link copied')).toBeVisible();
  expect(write).toHaveBeenCalledTimes(2);
  expect(dialog).toHaveClass('task-chain-dialog-fullscreen');
  expect(onClose).not.toHaveBeenCalled();
});

it('offers the Chinese action for a completed chain and removes it when the witness is no longer a member', async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: write } });
  const finished = tasks().map(task => task.type === 'task' ? { ...task, status: 'done' as const } : task);
  const snapshot = snapshotFixture(finished);
  const host = (witnessTaskId: string) => <ProjectListGraphHost projectId={projectId} index={snapshot.index} summaries={snapshot.summaries} target={{ kind: 'chain', rootId: id(2), witnessTaskId }} onOpenTask={noop} onOpenChain={noop} onClose={noop} onRestoreFocus={noop} />;
  const view = renderWithLocale(host(id(3)), { locale: 'zh-CN', taskCache: true, container: root });
  const trigger = screen.getByRole('button', { name: '更多任务链操作' });
  fireEvent.keyDown(trigger, { key: 'ArrowUp' });
  const item = screen.getByRole('menuitem', { name: '复制链接' });
  fireEvent.keyDown(item, { key: 'Home' });
  expect(item).toHaveFocus();
  fireEvent.keyDown(item, { key: 'End' });
  expect(item).toHaveFocus();
  fireEvent.click(item);
  expect(write).toHaveBeenCalledWith(url(id(3)));
  expect(await screen.findByText('已复制链接')).toBeVisible();
  view.rerender(host(id(0)));
  expect(screen.queryByRole('button', { name: '更多任务链操作' })).toBeNull();
});

it('uses and retains a readable Goal member, never an external or other Goal member, and isolates late results', async () => {
  const pending = Promise.withResolvers<void>();
  const write = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: write } });
  const surface = (members: TaskDetail[]) => <GoalDetailSurface projectId={projectId} taskId={goalId} detail={goal} resourceState={resourceState} snapshot={snapshotFixture(members)} presentation="page" goalChildren={{ graphRootId: id(2), task: null }} fullscreen={{ active: false, onChange: noop }} onSelectTask={noop} onRefreshGraph={noop} />;
  const view = renderWithLocale(surface(tasks()), { locale: 'en', taskCache: true, container: root });
  clickCopy();
  expect(write).toHaveBeenLastCalledWith(url(id(2)));
  const added = [...tasks(), detailFixture(projectId, id(1), { parentId: goalId, title: 'Earlier', dependsOn: [id(2)], ready: false })];
  view.rerender(surface(added));
  const trigger = screen.getByRole('button', { name: 'More task chain actions' });
  fireEvent.click(trigger);
  expect(screen.getByRole('menuitem', { name: 'Copy link' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Copy link' }), { key: 'Escape' });
  const changed = added.map(task => task.id === id(2) ? { ...task, parentId: otherGoalId } : task);
  view.rerender(surface(changed));
  await act(async () => pending.resolve());
  expect(screen.queryByText('Link copied')).toBeNull();
  clickCopy();
  expect(write).toHaveBeenLastCalledWith(url(id(1)));
  expect(await screen.findByText('Link copied')).toBeVisible();
  view.rerender(surface(changed.map(task => task.type === 'task' ? { ...task, parentId: otherGoalId } : task)));
  expect(screen.queryByRole('button', { name: 'More task chain actions' })).toBeNull();
});

it('retains the Goal anchor across a representative change, and chooses again after the graph closes', async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: write } });
  const surface = (members: TaskDetail[], graphRootId: string | null) => <GoalDetailSurface projectId={projectId} taskId={goalId} detail={goal} resourceState={resourceState} snapshot={snapshotFixture(members)} presentation="page" goalChildren={{ graphRootId, task: null }} fullscreen={{ active: false, onChange: noop }} onSelectTask={noop} onRefreshGraph={noop} />;
  const view = renderWithLocale(surface(tasks(), id(2)), { locale: 'en', taskCache: true, container: root });
  clickCopy();
  expect(write).toHaveBeenLastCalledWith(url(id(2)));
  const changed = [...tasks().map(task => task.id === id(2) ? { ...task, dependsOn: [id(0), id(1)], externalDependsOn: [id(0)] } : task),
    detailFixture(projectId, id(1), { parentId: goalId, title: 'New representative', status: 'done' })];
  view.rerender(surface(changed, id(2)));
  expect(screen.queryByRole('button', { name: 'More task chain actions' })).toBeNull();
  view.rerender(surface(changed, id(1)));
  clickCopy();
  expect(write).toHaveBeenLastCalledWith(url(id(2)));
  view.rerender(surface(changed, null));
  view.rerender(surface(changed, id(1)));
  clickCopy();
  expect(write).toHaveBeenLastCalledWith(url(id(1)));
});
