import { useRef, useState, type ReactElement } from 'react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphTask, TaskGraph } from '../src/api/types';
import { ChainList } from '../src/features/task-graph/ChainList';
import { TaskExecutionClockProvider } from '../src/features/task-execution/TaskExecutionClock';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { ScopedTaskChainRow } from '../src/features/task-graph/ScopedTaskChainRow';
import { scopedChainProgress } from '../src/features/task-graph/scoped-chain-progress';
import { createTaskCacheScope } from '../src/features/task-cache/project-cache';
import { TaskSessionSummaryProvider } from '../src/features/task-session-summary/TaskSessionSummaryProvider';
import { TaskSessionSummaryStore } from '../src/features/task-session-summary/store';
import { buildGraphIndex, type GraphIndex } from '../src/features/task-graph/model';
import { createLocaleRender } from './helpers/renderWithLocale';

vi.mock('../src/features/task-graph/TaskGraph', () => ({
  TaskGraph: () => <div>Dependency graph canvas</div>,
}));

const renderLocale = createLocaleRender('zh-CN', { taskCache: true });
const time = '2026-10-20T12:00:00Z';
const task = (id: string, status: GraphTask['status'], dependsOn: readonly string[] = [], externalDependsOn: readonly string[] = []): GraphTask => ({ type: 'task', parentId: null, assignedTo: null,
  id, titlePreview: id, titleTruncated: false, status, dependsOn, externalDependsOn, blockedBy: [], ready: false,
  requiredPlatform: null, allowAgents: false, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time,
});
const seeds = [
  task('Goal', 'done'), task('Other root', 'done'), task('Implementation', 'in_progress', ['Goal', 'Other root']),
  task('Acceptance', 'todo', ['Implementation', 'External'], ['External']), task('External', 'done'), task('Standalone', 'todo'),
];
const indexOf = (items = seeds): GraphIndex => {
  const tasks = items.map((item) => {
    const blockedBy = item.dependsOn.filter((id) => items.find((candidate) => candidate.id === id)!.status !== 'done');
    return { ...item, blockedBy, ready: item.status === 'todo' && blockedBy.length === 0 };
  });
  const graph: TaskGraph = {
    observedAt: time,
    project: { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, id: 'project', name: 'Project', repoUrl: 'https://github.com/example/repo', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time },
    tasks,
    summary: { proposed: 0,
      total: tasks.length, todo: tasks.filter((item) => item.status === 'todo').length,
      inProgress: tasks.filter((item) => item.status === 'in_progress').length, done: tasks.filter((item) => item.status === 'done').length, cancelled: tasks.filter((item) => item.status === 'cancelled').length,
      ready: tasks.filter((item) => item.ready).length, blocked: tasks.filter((item) => item.status === 'todo' && !item.ready).length,
    },
  };
  return buildGraphIndex(graph);
};
const clockGraph: TaskGraph = {
  observedAt: '2026-10-25T12:00:00Z',
  project: { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, id: 'project', name: 'Project', repoUrl: 'https://github.com/example/repo', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time },
  tasks: [], summary: { proposed: 0, total: 0, todo: 0, inProgress: 0, done: 0, cancelled: 0, ready: 0, blocked: 0 },
};
const clockSnapshot: GraphSnapshot = { graph: clockGraph, index: buildGraphIndex(clockGraph), summaries: new Map(), workerMachines: new Map(), pausedTaskIds: new Set(), observedAt: clockGraph.observedAt, receivedAt: 0, receivedMonotonic: performance.now(), revision: 1 };
const clock = (ui: ReactElement) => <TaskExecutionClockProvider projectId="project" snapshot={clockSnapshot}>{ui}</TaskExecutionClockProvider>;
const render = (ui: ReactElement) => {
  const view = renderLocale(clock(ui));
  return { ...view, rerender: (next: ReactElement) => view.rerender(clock(next)) };
};
const noop = () => {};
const list = (index: GraphIndex, onOpenTask = noop) => <ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={index} representativeIds={['Goal']} allRepresentativeIds={['Goal']}
  openGraphTarget={null} onOpenChain={noop} onCloseChain={noop} onOpenTask={onOpenTask} />;
const disclosure = () => document.getElementById('task-root-Goal')!;
const children = () => document.getElementById('goal-children-Goal')!;

describe('Goal task lists', () => {
  it('keeps cancelled chain members and terminal status while projecting completion', () => {
    const items = [task('Goal', 'done'), task('Done', 'done', ['Goal']), task('Cancelled', 'cancelled', ['Goal'])];
    const view = render(list(indexOf(items)));
    const header = disclosure().closest('.goal-header')!;
    expect(header).toHaveAttribute('data-task-status', 'ended');
    expect(disclosure()).toHaveAccessibleName(/2\/2 已完成/);
    expect(header.querySelector('.root-progress-track i')).toHaveStyle({ width: '100%' });
    fireEvent.click(disclosure());
    const member = document.getElementById('chain-task-Goal-Cancelled')!;
    expect(member).toBeVisible();
    member.focus();
    view.rerender(list(indexOf(items.map((item) => ({ ...item, status: 'cancelled' as const })))));
    expect(header).toHaveAttribute('data-task-status', 'cancelled');
    expect(disclosure()).toHaveAccessibleName(/0\/0 已完成/);
    expect(header.querySelector('.root-progress-track i')).toHaveStyle({ width: '0%' });
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    expect(member).toHaveFocus();
  });
  it('keeps a cross-scope chain but shows only the current scope and counts its representative once', () => {
    const items = [
      { ...task('Outside', 'done'), parentId: 'goal-a' },
      { ...task('Inside', 'todo', ['Outside']), parentId: null },
    ];
    const index = indexOf(items);
    const onOpenTask = vi.fn();
    render(<ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={index} representativeIds={['Outside']} allRepresentativeIds={['Outside']}
      scopedMembers={new Map([['Outside', ['Inside']]])} openGraphTarget={null} onOpenChain={noop} onCloseChain={noop} onOpenTask={onOpenTask} />);
    const header = document.getElementById('task-root-Outside')!;
    expect(header).toHaveTextContent('Outside');
    expect(header.closest('.goal-header')!.querySelector('.root-progress-label')).toHaveTextContent('0/1');
    expect(header.closest('.goal-header')).toHaveAttribute('data-task-status', 'todo');
    expect(header.querySelector('.task-assignee-identity')).toBeNull();
    fireEvent.click(header);
    const rows = document.querySelectorAll('.goal-task-main');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Inside');
    fireEvent.click(rows[0]!);
    expect(onOpenTask).toHaveBeenCalledWith('Inside', rows[0]);
  });

  it('uses the entire scoped member set, excluding the outside representative and external prerequisite', () => {
    const outside = { ...task('Outside', 'done'), completedAt: '2026-10-24T12:00:00Z' };
    const older = { ...task('Older', 'done', ['Outside']), completedAt: '2026-10-21T12:00:00Z' };
    const newer = { ...task('Newer', 'done', ['Older', 'External'], ['External']), completedAt: '2026-10-22T12:00:00Z' };
    const external = { ...task('External', 'done'), completedAt: '2026-10-25T10:00:00Z' };
    const scoped = new Map([['Outside', ['Older', 'Newer']]]);
    const tree = (last: GraphTask) => <ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={indexOf([outside, older, last, external])}
      representativeIds={['Outside']} allRepresentativeIds={['Outside']} scopedMembers={scoped} openGraphTarget={null} onOpenChain={noop} onCloseChain={noop} onOpenTask={noop} />;
    const view = render(tree(newer));
    const aggregate = () => screen.queryByRole('button', { name: '查看 Outside 的完成时间' });
    expect(aggregate()?.querySelector('time')).toHaveAttribute('datetime', newer.completedAt);
    fireEvent.click(document.getElementById('task-root-Outside')!);
    const known = () => document.getElementById('chain-task-Outside-Older')!;
    expect(known().querySelector('time.completion-time-label')).toHaveAttribute('datetime', older.completedAt);
    view.rerender(tree({ ...newer, completedAt: null }));
    expect(aggregate()).toBeNull();
    expect(known().querySelector('time.completion-time-label')).toHaveAttribute('datetime', older.completedAt);
    view.rerender(tree({ ...newer, status: 'in_progress' }));
    expect(aggregate()).toBeNull();
    expect(known().querySelector('time.completion-time-label')).toHaveAttribute('datetime', older.completedAt);
    expect(document.getElementById('chain-task-Outside-Newer')!.querySelector('time.completion-time-label')).toBeNull();
    expect(document.getElementById('task-root-Outside')).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows a complete chain aggregate separately from its representative task time', () => {
    const goal = { ...task('Goal', 'done'), completedAt: '2026-10-20T12:00:00Z' };
    const child = { ...task('Child', 'done', ['Goal', 'External'], ['External']), completedAt: '2026-10-22T12:00:00Z' };
    render(list(indexOf([goal, child, { ...task('External', 'done'), completedAt: '2026-10-25T10:00:00Z' }])));
    expect(screen.getByRole('button', { name: '查看 Goal 的完成时间' }).querySelector('time')).toHaveAttribute('datetime', child.completedAt);
    fireEvent.click(disclosure());
    const representative = document.getElementById('chain-task-Goal-Goal')!;
    expect(representative.querySelector('time.completion-time-label')).toHaveAttribute('datetime', goal.completedAt);
    expect(representative.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('reveals and focuses a scoped witness without resetting another expanded chain', () => {
    const index = indexOf([task('First', 'done'), task('Second', 'todo', ['First']), task('Other', 'done'), task('Last', 'todo', ['Other'])]);
    const scopedMembers = new Map([['First', ['First', 'Second']], ['Other', ['Other', 'Last']]]);
    const onRevealed = vi.fn();
    const tree = (revealTaskId: string | null) => <ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={index} representativeIds={['First', 'Other']} allRepresentativeIds={['First', 'Other']}
      scopedMembers={scopedMembers} revealTaskId={revealTaskId} onRevealed={onRevealed} openGraphTarget={null} onOpenChain={noop} onCloseChain={noop} onOpenTask={noop} />;
    const view = render(tree(null));
    fireEvent.click(document.getElementById('task-root-Other')!);
    view.rerender(tree('First'));
    expect(document.getElementById('task-root-First')).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('task-root-Other')).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('chain-task-First-First')).toHaveFocus();
    expect(onRevealed).toHaveBeenCalledOnce();
    expect(onRevealed).toHaveBeenCalledWith('First');
  });
  it('lists every member once across merged roots, with task statuses and no external or standalone context', () => {
    render(list(indexOf()));
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(children()).not.toBeVisible();
    fireEvent.click(disclosure());
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    expect(disclosure()).toHaveAttribute('aria-controls', children().id);
    const rows = within(children()).getAllByRole('button', { name: /已完成|进行中|待处理/ });
    expect(rows.map((row) => row.querySelector('.root-title')!.textContent)).toEqual(['Implementation', 'Acceptance', 'Other root']);
    expect(rows.map((row) => row.closest('.goal-task-row')!.querySelector('.root-status')!.textContent)).toEqual(['进行中', '待处理', '已完成']);
    expect(rows.map((row) => row.getAttribute('data-task-status'))).toEqual(['in_progress', 'todo', 'done']);
    expect(disclosure().closest('.goal-header')).toHaveAttribute('data-task-status', 'in_progress');
    expect(rows[1]!.closest('.goal-task-row')).toHaveTextContent('被阻塞');
    expect(within(children()).queryByText('External')).toBeNull();
    expect(within(children()).queryByText('Standalone')).toBeNull();
    expect(disclosure().closest('.goal-header')!.querySelector('.root-progress-label')).toHaveTextContent('2/4 已完成');
    expect(children()).toHaveTextContent('子任务 · 3');
    expect(document.querySelector('button button')).toBeNull();
  });

  it('counts only in-progress ordinary members including the representative and updates the collapsed header', () => {
    const items = [task('Goal', 'in_progress'), task('Second root', 'in_progress'),
      task('Join', 'todo', ['Goal', 'Second root', 'External'], ['External']), task('External', 'in_progress')];
    const view = render(list(indexOf(items)));
    expect(disclosure().querySelector('.goal-in-progress')).toHaveTextContent(/^2 进行中$/);
    expect(disclosure().querySelector('.goal-eyebrow, .root-meta')).toBeNull();
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    const remaining = items.map((item) => item.id === 'Second root' ? { ...item, status: 'done' as const } : item);
    view.rerender(list(indexOf(remaining)));
    expect(disclosure().querySelector('.goal-in-progress')).toHaveTextContent(/^1 进行中$/);
    view.rerender(list(indexOf(remaining.map((item) => item.id === 'Goal' ? { ...item, status: 'done' as const } : item))));
    expect(disclosure().querySelector('.goal-in-progress')).toHaveTextContent(/^0 进行中$/);
    expect(disclosure().closest('.goal-header')!.querySelector('.root-status')).toHaveTextContent('进行中');
    view.setLocale('en');
    expect(disclosure().querySelector('.goal-in-progress')).toHaveTextContent(/^0 in progress$/);
  });

  it('prioritizes status and sorts done children by completion rather than creation time', () => {
    const index = indexOf([
      task('Goal', 'done'),
      { ...task('Done first', 'done', ['Goal']), createdAt: '2026-10-19T12:00:00Z', completedAt: '2026-10-22T12:00:00Z' },
      task('Todo first', 'todo', ['Goal']), task('Active first', 'in_progress', ['Goal']),
      { ...task('Done second', 'done', ['Goal']), createdAt: '2026-10-20T12:00:00Z', completedAt: '2026-10-21T12:00:00Z' },
      { ...task('Done third', 'done', ['Goal']), createdAt: '2026-10-18T12:00:00Z', completedAt: '2026-10-23T12:00:00Z' },
      task('Active second', 'in_progress', ['Goal']), task('Todo second', 'todo', ['Goal']),
    ]);
    const snapshotOrder = [...index.nodes.keys()];
    render(list(index));
    fireEvent.click(disclosure());
    expect([...children().querySelectorAll('.goal-task-row .root-title')].map((title) => title.textContent)).toEqual([
      'Active first', 'Active second', 'Todo first', 'Todo second', 'Done third', 'Done first', 'Done second',
    ]);
    expect([...index.nodes.keys()]).toEqual(snapshotOrder);
  });

  it('compares all completion nanoseconds and keeps equal instants and nulls in snapshot order', () => {
    render(list(indexOf([
      task('Goal', 'done'), task('Unknown first', 'done', ['Goal']),
      { ...task('Earlier nanosecond', 'done', ['Goal']), completedAt: '2026-10-21T12:00:00.123456788Z' },
      { ...task('Equal first', 'done', ['Goal']), completedAt: '2026-10-21T12:00:00.1Z' },
      task('Unknown second', 'done', ['Goal']),
      { ...task('Later nanosecond', 'done', ['Goal']), completedAt: '2026-10-21T12:00:00.123456789Z' },
      { ...task('Equal second', 'done', ['Goal']), completedAt: '2026-10-21T12:00:00.100000000Z' },
    ])));
    fireEvent.click(disclosure());
    expect([...children().querySelectorAll('.goal-task-row .root-title')].map((title) => title.textContent)).toEqual([
      'Later nanosecond', 'Earlier nanosecond', 'Equal first', 'Equal second', 'Unknown first', 'Unknown second',
    ]);
  });

  it('reorders completed children from refreshed timestamps and snapshot order while staying expanded', () => {
    const first = { ...task('First', 'done', ['Goal']), completedAt: '2026-10-21T12:00:00Z' };
    const second = { ...task('Second', 'done', ['Goal']), completedAt: '2026-10-22T12:00:00Z' };
    const waiting = task('Waiting', 'todo', ['Goal']);
    const goal = task('Goal', 'done');
    const view = render(list(indexOf([goal, first, second, waiting])));
    fireEvent.click(disclosure());
    const titles = () => [...children().querySelectorAll('.goal-task-row .root-title')].map((title) => title.textContent);
    expect(titles()).toEqual(['Waiting', 'Second', 'First']);
    view.rerender(list(indexOf([
      goal, { ...first, completedAt: '2026-10-23T12:00:00Z' }, second,
      { ...waiting, status: 'done', completedAt: '2026-10-24T12:00:00Z' },
    ])));
    expect(titles()).toEqual(['Waiting', 'First', 'Second']);
    view.rerender(list(indexOf([goal, second, { ...first, completedAt: second.completedAt }, waiting])));
    expect(titles()).toEqual(['Waiting', 'Second', 'First']);
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps a partly completed chain in progress without any executing member', () => {
    const view = render(list(indexOf([task('Goal', 'done'), task('Waiting', 'todo', ['Goal'])])));
    expect(disclosure().closest('.goal-header')).toHaveAttribute('data-task-status', 'in_progress');
    expect(disclosure()).toHaveTextContent('进行中');
    view.rerender(list(indexOf([task('Goal', 'todo'), task('Waiting', 'todo', ['Goal'])])));
    expect(disclosure().closest('.goal-header')).toHaveAttribute('data-task-status', 'todo');
    view.rerender(list(indexOf([task('Goal', 'done'), task('Waiting', 'done', ['Goal'])])));
    expect(disclosure().closest('.goal-header')).toHaveAttribute('data-task-status', 'done');
  });

  it('opens graphs independently from keyboard disclosure and passes the correct task and trigger to details', async () => {
    const user = userEvent.setup();
    const onOpenTask = vi.fn();
    const index = indexOf();
    const Wrapper = () => {
      const [openChainId, setOpenChainId] = useState<string | null>(null);
      const opener = useRef<HTMLElement | null>(null);
      return <ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={index} representativeIds={['Goal']} allRepresentativeIds={['Goal']}
        openGraphTarget={openChainId === null ? null : { kind: 'chain', witnessTaskId: openChainId, rootId: openChainId }} onOpenChain={(id, trigger) => { opener.current = trigger; setOpenChainId(id); }} onCloseChain={() => setOpenChainId(null)}
        onRestoreGraphFocus={() => opener.current?.focus({ preventScroll: true })} onOpenTask={onOpenTask} />;
    };
    render(<Wrapper />);
    const graph = screen.getByRole('button', { name: 'Goal，查看依赖关系' });
    await user.click(graph);
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(graph).toHaveFocus();
    disclosure().focus();
    await user.keyboard('{Enter}');
    const child = screen.getByRole('button', { name: /Implementation.*进行中/ });
    await user.click(child);
    expect(onOpenTask).toHaveBeenLastCalledWith('Implementation', child);
    const goalDetails = screen.getByRole('button', { name: 'Goal，查看 Goal 详情' });
    await user.click(goalDetails);
    expect(onOpenTask).toHaveBeenLastCalledWith('Goal', goalDetails);
    await user.click(graph);
    await user.keyboard('{Escape}');
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    expect(children()).toBeVisible();
    expect(graph).toHaveFocus();
    disclosure().focus();
    await user.keyboard(' ');
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(children()).not.toBeVisible();
  });

  it('refreshes visible members and status while preserving disclosure and restoring focus after removal', () => {
    const view = render(list(indexOf()));
    fireEvent.click(disclosure());
    const removed = screen.getByRole('button', { name: /Acceptance.*待处理\s*被阻塞/ });
    removed.focus();
    const after = seeds.filter((item) => item.id !== 'Acceptance').map((item) => item.id === 'Implementation' ? { ...item, status: 'done' as const } : item);
    view.rerender(list(indexOf(after)));
    expect(removed.isConnected).toBe(false);
    expect(disclosure()).toHaveFocus();
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    expect(within(children()).getAllByRole('button')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /Implementation.*已完成/ })).toBeVisible();
    expect([...children().querySelectorAll('.goal-task-row .root-title')].map((title) => title.textContent)).toEqual(['Other root', 'Implementation']);
    expect(disclosure().closest('.goal-header')!.querySelector('.root-progress-label')).toHaveTextContent('3/3 已完成');
  });

  it('retranslates expanded controls and renders long titles as text without changing disclosure', () => {
    const titlePreview = '<img src=x onerror=alert(1)>'.repeat(8);
    const items = seeds.map((item) => item.id === 'Implementation' ? { ...item, titlePreview, titleTruncated: true } : item);
    const view = render(list(indexOf(items)));
    fireEvent.click(disclosure());
    expect(within(children()).getByText(`${titlePreview}…`)).toBeVisible();
    expect(view.container.querySelector('img')).toBeNull();
    view.setLocale('en');
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Goal, View dependencies' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Goal, View Goal details' })).toBeVisible();
    expect(children()).toHaveTextContent('Tasks · 3');
    expect(within(children()).getAllByText('Done')).toHaveLength(1);
  });
});


describe('shared scoped chain presentation', () => {
  afterEach(() => vi.unstubAllGlobals());

  const items = [
    task('Outside', 'done'),
    { ...task('Older', 'done', ['Outside']), completedAt: '2026-10-21T12:00:00.123456788Z' },
    { ...task('Newer', 'cancelled', ['Outside']), cancelledAt: '2026-10-21T12:00:00.123456789Z' },
    task('Unknown', 'done', ['Outside']),
  ];
  const index = indexOf(items);
  const members = ['Older', 'Newer', 'Unknown'];
  const progress = scopedChainProgress(index, members);
  const projectId = '00000000-0000-4000-8000-000000000101';
  const machines = new Map();
  const onOpenTask = vi.fn();
  const onOpenChain = vi.fn();

  const Instance = ({ id }: { readonly id: string }) => {
    const [expanded, setExpanded] = useState(false);
    return <ScopedTaskChainRow projectId={projectId} index={index} rootId="Outside" memberIds={members} progress={progress}
      workerMachines={machines} instanceId={id} expanded={expanded} onExpandedChange={setExpanded} open={false}
      onOpenTask={onOpenTask} onOpenChain={onOpenChain} />;
  };

  it('keeps duplicate resource instances independent and opens the graph at a scoped witness', () => {
    onOpenChain.mockClear(); onOpenTask.mockClear();
    render(<ul><Instance id="goal-a-chain" /><Instance id="goal-b-chain" /></ul>);
    const first = document.getElementById('task-root-goal-a-chain')!;
    const second = document.getElementById('task-root-goal-b-chain')!;
    const firstChildren = document.getElementById('goal-children-goal-a-chain')!;
    const secondChildren = document.getElementById('goal-children-goal-b-chain')!;
    expect(first).toHaveAttribute('aria-controls', firstChildren.id);
    expect(second).toHaveAttribute('aria-controls', secondChildren.id);
    expect(first).toHaveTextContent('Outside');
    expect(first.closest('.goal-header')!.querySelector('.root-progress-label')).toHaveTextContent('2/2 已完成');
    expect(first.closest('.goal-header')!.querySelector('.root-progress-track i')).toHaveStyle({ width: '100%' });
    expect(first.closest('.goal-header')).toHaveAttribute('data-task-status', 'ended');
    fireEvent.click(first);
    expect(firstChildren).toBeVisible();
    expect(secondChildren).not.toBeVisible();
    expect(second).toHaveAttribute('aria-expanded', 'false');
    expect([...firstChildren.querySelectorAll('.goal-task-main .root-title')].map((node) => node.textContent)).toEqual(['Newer', 'Older', 'Unknown']);
    expect(within(firstChildren).queryByText('Outside')).toBeNull();
    fireEvent.click(second);
    expect(secondChildren).toBeVisible();
    const firstTask = document.getElementById('chain-task-goal-a-chain-Older')!;
    const secondTask = document.getElementById('chain-task-goal-b-chain-Older')!;
    expect(firstTask).not.toBe(secondTask);
    const firstDescription = firstTask.getAttribute('aria-describedby');
    const secondDescription = secondTask.getAttribute('aria-describedby');
    expect(firstDescription).toBeTruthy();
    expect(secondDescription).toBeTruthy();
    expect(firstDescription).not.toBe(secondDescription);
    expect(document.getElementById(firstDescription!)?.textContent).toBe(document.getElementById(secondDescription!)?.textContent);
    fireEvent.click(secondTask);
    expect(onOpenTask).toHaveBeenLastCalledWith('Older', secondTask);
    const graph = document.getElementById('task-chain-graph-goal-b-chain')!;
    fireEvent.click(graph);
    expect(onOpenChain).toHaveBeenLastCalledWith('Older', graph);
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('registers each visible instance independently and does not observe without a provider', () => {
    const observers: { callback: IntersectionObserverCallback; element: Element | null; disconnect: ReturnType<typeof vi.fn<() => void>> }[] = [];
    class Observer {
      record: typeof observers[number];
      constructor(callback: IntersectionObserverCallback) { this.record = { callback, element: null, disconnect: vi.fn() }; observers.push(this.record); }
      observe(element: Element) { this.record.element = element; }
      disconnect() { this.record.disconnect(); }
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    const without = render(<ul><Instance id="plain" /></ul>);
    expect(observers).toHaveLength(0);
    without.unmount();

    const scope = createTaskCacheScope({ userId: '00000000-0000-4000-8000-000000000201', onIdentityMismatch: vi.fn() });
    const store = new TaskSessionSummaryStore(scope, projectId);
    const setChain = vi.spyOn(store, 'setChain');
    const removeChain = vi.spyOn(store, 'removeChain');
    const Host = ({ showFirst }: { readonly showFirst: boolean }) => <TaskSessionSummaryProvider store={store}><ul>
      {showFirst && <Instance id="goal-a-chain" />}<Instance id="goal-b-chain" />
    </ul></TaskSessionSummaryProvider>;
    const view = render(<Host showFirst />);
    expect(observers).toHaveLength(2);
    act(() => observers.forEach((record) => record.callback([{ target: record.element!, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)));
    expect(setChain).toHaveBeenCalledWith('goal-a-chain', members.toSorted(), true);
    expect(setChain).toHaveBeenCalledWith('goal-b-chain', members.toSorted(), true);
    removeChain.mockClear();
    view.rerender(<Host showFirst={false} />);
    expect(removeChain).toHaveBeenCalledWith('goal-a-chain');
    expect(removeChain).not.toHaveBeenCalledWith('goal-b-chain');
    expect(observers[0]!.disconnect).toHaveBeenCalled();
    expect(observers[1]!.disconnect).not.toHaveBeenCalled();
    view.unmount();
    expect(removeChain).toHaveBeenCalledWith('goal-b-chain');
    store.dispose(); scope.dispose();
  });

  it('retains the full chain visibility registration during disclosure and snapshot rerenders', () => {
    const observers: { callback: IntersectionObserverCallback; element: Element | null; disconnect: ReturnType<typeof vi.fn<() => void>> }[] = [];
    class Observer {
      record: typeof observers[number];
      constructor(callback: IntersectionObserverCallback) { this.record = { callback, element: null, disconnect: vi.fn() }; observers.push(this.record); }
      observe(element: Element) { this.record.element = element; }
      disconnect() { this.record.disconnect(); }
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    const scope = createTaskCacheScope({ userId: '00000000-0000-4000-8000-000000000201', onIdentityMismatch: vi.fn() });
    const store = new TaskSessionSummaryStore(scope, projectId);
    const setChain = vi.spyOn(store, 'setChain');
    const removeChain = vi.spyOn(store, 'removeChain');
    const Host = ({ graph }: { readonly graph: GraphIndex }) => <TaskSessionSummaryProvider store={store}>{list(graph)}</TaskSessionSummaryProvider>;
    const view = render(<Host graph={indexOf()} />);
    expect(observers).toHaveLength(1);
    const observer = observers[0]!;
    act(() => observer.callback([{ target: observer.element!, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(setChain).toHaveBeenCalledWith('Goal', ['Acceptance', 'Goal', 'Implementation', 'Other root'], true);
    removeChain.mockClear();
    fireEvent.click(disclosure());
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    view.rerender(<Host graph={indexOf(seeds.map((item) => item.id === 'Implementation' ? { ...item, titlePreview: 'Updated' } : item))} />);
    expect(within(children()).getByText('Updated')).toBeVisible();
    expect(observers).toHaveLength(1);
    expect(observer.disconnect).not.toHaveBeenCalled();
    expect(removeChain).not.toHaveBeenCalled();
    view.unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(removeChain).toHaveBeenCalledWith('Goal');
    store.dispose(); scope.dispose();
  });

});
