import { statesForSummaries } from './helpers/taskSync';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { TaskSessionSummaryStore } from '../src/features/task-session-summary/store';
import { TEST_VIEWER_ID } from './helpers/taskSync';
import { fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, TaskSummary, WorkerClaim } from '../src/api/types';
import { projectSummaries } from '../src/features/task-cache/projection';
import { TaskExecutionClockProvider } from '../src/features/task-execution/TaskExecutionClock';
import { ProjectTaskWorkspace } from '../src/features/projects/ProjectTaskWorkspace';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { renderWithLocale } from './helpers/renderWithLocale';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const time = '2026-11-04T00:00:00Z';
const project: Project = { id: id(100), name: 'Project', repoUrl: 'https://example.com/project', ownership: { teamId: id(101), version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const task = (n: number, changes: Partial<TaskSummary> = {}): TaskSummary => ({ tags: [], type: 'task', parentId: null, id: id(n), titlePreview: `Task ${n}`, titleTruncated: false, assignedTo: null, requiredPlatform: null, allowAgents: true, version: 1n, properties: {}, status: 'todo', dependsOn: [], externalDependsOn: [], startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, ...changes });
const claim = (name: string, state: WorkerClaim['state'], agentControlMode: WorkerClaim['agentControlMode'] = 'web'): WorkerClaim => ({
  claimId: id(201), state, userId: id(202), workerId: id(203), machine: { id: id(204), name }, platform: 'linux', agent: 'codex', agentControlMode, worktreeId: id(205), phase: 'executing', herdr: agentControlMode === 'web' ? null : { session: 'session', workspaceId: 'workspace', paneId: 'pane' }, nativeSessionId: null, claimedAt: time,
});
const root = task(1, { status: 'done' });
const child = (n: number, changes: Partial<TaskSummary> = {}) => task(n, { dependsOn: [root.id], ...changes });
const snapshot = (tasks: TaskSummary[]): GraphSnapshot => ({ ...projectSummaries(project, tasks, statesForSummaries(tasks), time), summaries: new Map(tasks.map((task) => [task.id, task])), observedAt: time, receivedMonotonic: 0, receivedAt: 0, revision: 1 });
let sessionScope: TaskCacheScope;
let sessionStore: TaskSessionSummaryStore;
beforeEach(() => { sessionScope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); sessionStore = new TaskSessionSummaryStore(sessionScope, project.id); });
afterEach(() => { sessionStore.dispose(); sessionScope.dispose(); });
const noop = () => {};
const workspace = (value: GraphSnapshot, onOpenTask = noop, scopedMembers?: ReadonlyMap<string, readonly string[]>) => <TaskExecutionClockProvider projectId={project.id} snapshot={value}><ProjectTaskWorkspace pausedTasks={[]} onOpenPausedTask={() => {}} onPausedFocusFallback={() => {}} sessionStore={sessionStore} snapshot={value} activeView="chains" unfinishedStandaloneTaskCount={0} unfinishedChainCount={1} onViewChange={noop}
  goalCount={0} goals={{ projectId: project.id, goals: [], total: 0, onOpenGoal: noop, onOpenGoalGraph: noop, onOpenGoalGraphTask: noop, openGraphTarget: null, onCloseChain: noop, onOpenTask: noop, onOpenListTask: noop, onOpenListChain: noop }}
  chains={{ projectId: project.id, representativeIds: [root.id], allRepresentativeIds: [root.id], ...(scopedMembers === undefined ? {} : { scopedMembers }), openGraphTarget: null, onOpenChain: noop, onCloseChain: noop, onOpenTask }}
  standalone={{ projectId: project.id, taskIds: [], allTaskIds: [], onSelectTask: noop }} /></TaskExecutionClockProvider>;
const row = (n: number) => document.getElementById(`chain-task-${root.id}-${id(n)}`)!;

describe('chain worker machine presentation', () => {
  it('projects every claim state and mode strictly without adding properties to graph tasks', () => {
    const value = snapshot([root, child(2), child(3, { properties: { worker: claim('active host', 'active') } }), child(4), child(5, { properties: { worker: claim('completed host', 'completed') } })]);
    expect([...value.workerMachines].map(([key, entry]) => [key, entry.state, entry.machine.name])).toEqual([[id(3), 'active', 'active host'], [id(5), 'completed', 'completed host']]);
    expect(value.graph.tasks[1]).not.toHaveProperty('properties');
    expect(() => snapshot([root, child(2, { properties: { worker: null } })])).toThrow();
  });

  it('keeps permission and recorded machine independent and updates the same expanded rows', () => {
    const longName = 'host-'.repeat(50);
    const initial = [root, child(2), child(3, { allowAgents: false, properties: { worker: claim(longName, 'completed', 'herdr') } }), child(4, { properties: { worker: claim('live host', 'active') } })];
    const onOpenTask = vi.fn();
    const view = renderWithLocale(workspace(snapshot(initial), onOpenTask), { locale: 'zh-CN', taskCache: true });
    fireEvent.click(document.getElementById(`task-root-${root.id}`)!);
    expect(row(2)).toHaveTextContent('自动执行已开启');
    expect(row(2)).toHaveTextContent('暂无执行机器记录');
    expect(row(3)).toHaveTextContent('自动执行已关闭');
    expect(row(3)).toHaveTextContent(`执行机器记录：${longName}`);
    expect(row(4)).toHaveTextContent('认领机器：live host');
    expect(within(row(3)).queryByRole('button')).toBeNull();
    row(3).focus();
    expect(row(3)).toHaveAccessibleName(new RegExp(longName));
    fireEvent.click(row(3));
    expect(onOpenTask).toHaveBeenCalledWith(id(3), row(3));
    view.setLocale('en');
    expect(row(3)).toHaveTextContent(`Recorded machine: ${longName}`);
    expect(row(4)).toHaveTextContent('Claim machine: live host');
    const changed = initial.map((item) => item.id === id(3) ? { ...item, allowAgents: true, properties: { worker: claim('replacement', 'completed') } } : item.id === id(4) ? { ...item, properties: {} } : item);
    view.rerender(workspace(snapshot(changed), onOpenTask));
    expect(document.getElementById(`task-root-${root.id}`)).toHaveAttribute('aria-expanded', 'true');
    expect(row(3)).toHaveTextContent('Automatic execution on');
    expect(row(3)).toHaveTextContent('Recorded machine: replacement');
    expect(row(3)).not.toHaveTextContent(longName);
    expect(row(4)).toHaveTextContent('No machine record');
    expect(row(4)).not.toHaveTextContent('live host');
  });

  it('shows only active claims in the root accessible name and preserves keyboard disclosure', async () => {
    const user = userEvent.setup();
    const items = [root, child(2)];
    const view = renderWithLocale(workspace(snapshot(items)), { locale: 'zh-CN', taskCache: true });
    const header = document.getElementById(`task-root-${root.id}`)!;
    expect(header).not.toHaveAccessibleName(/自动执行中/);
    expect(header).toHaveAttribute('aria-expanded', 'false');

    view.rerender(workspace(snapshot([{ ...root, status: 'in_progress', properties: { worker: claim('root', 'active') } }, child(2)])));
    expect(header).toHaveAccessibleName(/自动执行中/);
    expect(within(header).queryByRole('button')).toBeNull();
    header.focus();
    await user.keyboard('{Enter}');
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(header).toHaveAccessibleName(/自动执行中/);

    view.rerender(workspace(snapshot([root, child(2, { status: 'in_progress', properties: { worker: claim('child', 'active') } })])));
    expect(header).toHaveAccessibleName(/自动执行中/);
    view.setLocale('en');
    expect(header).toHaveAccessibleName(/Automatic execution active/);
    await user.keyboard(' ');
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(header).toHaveAccessibleName(/Automatic execution active/);

    for (const state of ['completed'] as const) {
      view.rerender(workspace(snapshot([root, child(2, { status: 'done', properties: { worker: claim('historical', state) } })])));
      expect(header).not.toHaveAccessibleName(/Automatic execution active/);
    }
    view.rerender(workspace(snapshot(items)));
    expect(header).not.toHaveAccessibleName(/Automatic execution active/);
  });

  it('ignores external claims and Session working, while following member and claim changes', () => {
    const external = task(9, { status: 'in_progress', properties: { worker: claim('outside', 'active') } });
    const inside = child(2, { dependsOn: [root.id, external.id], externalDependsOn: [external.id] });
    const remaining = child(3, { status: 'in_progress' });
    vi.spyOn(sessionStore, 'snapshot').mockReturnValue(new Map([[remaining.id, { indicator: 'working' }]]));
    const view = renderWithLocale(workspace(snapshot([root, inside, remaining, external])), { locale: 'zh-CN', taskCache: true });
    const header = document.getElementById(`task-root-${root.id}`)!;
    expect(header).not.toHaveAccessibleName(/自动执行中/);
    expect(header.closest('.goal-header')!.querySelector('[data-session-indicator]')).toHaveAttribute('data-session-indicator', 'working');

    const active = { ...inside, status: 'in_progress' as const, dependsOn: [root.id], externalDependsOn: [], properties: { worker: claim('inside', 'active') } };
    view.rerender(workspace(snapshot([root, active, remaining, external])));
    expect(header).toHaveAccessibleName(/自动执行中/);
    view.rerender(workspace(snapshot([root, { ...active, status: 'todo', properties: {} }, remaining, external])));
    expect(header).not.toHaveAccessibleName(/自动执行中/);
    view.rerender(workspace(snapshot([root, active, remaining, external])));
    expect(header).toHaveAccessibleName(/自动执行中/);
    view.rerender(workspace(snapshot([root, { ...active, dependsOn: [], externalDependsOn: [] }, remaining, external])));
    expect(header).not.toHaveAccessibleName(/自动执行中/);
  });

  it('aggregates the full ordinary component when the displayed chain has a narrower scope', () => {
    const hiddenRoot = { ...root, status: 'in_progress' as const, parentId: id(50), properties: { worker: claim('other scope', 'active') } };
    const inScope = child(2);
    const scope = new Map([[root.id, [inScope.id]]]);
    const view = renderWithLocale(workspace(snapshot([hiddenRoot, inScope]), noop, scope), { locale: 'zh-CN', taskCache: true });
    const header = document.getElementById(`task-root-${root.id}`)!;
    expect(header).toHaveAccessibleName(/自动执行中/);
    expect(header.closest('.goal-header')!.querySelector('.root-meta')).toHaveTextContent('子任务 · 1');
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(header).toHaveAccessibleName(/自动执行中/);
    expect(row(2)).toBeVisible();
    view.rerender(workspace(snapshot([{ ...hiddenRoot, properties: {} }, inScope]), noop, scope));
    expect(header).not.toHaveAccessibleName(/自动执行中/);
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });

});
