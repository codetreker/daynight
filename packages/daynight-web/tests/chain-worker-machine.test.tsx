import { fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project, TaskSummary, WorkerClaim } from '../src/api/types';
import { projectSummaries } from '../src/features/task-cache/projection';
import { ProjectTaskWorkspace } from '../src/features/projects/ProjectTaskWorkspace';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { renderWithLocale } from './helpers/renderWithLocale';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const time = '2026-11-04T00:00:00Z';
const project: Project = { id: id(100), name: 'Project', repoUrl: 'https://example.com/project', ownership: { teamId: id(101), version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const task = (n: number, changes: Partial<TaskSummary> = {}): TaskSummary => ({ id: id(n), titlePreview: `Task ${n}`, titleTruncated: false, assignedTo: null, requiredPlatform: null, allowAgents: true, version: 1n, properties: {}, status: 'todo', dependsOn: [], externalDependsOn: [], startedAt: null, completedAt: null, createdAt: time, updatedAt: time, ...changes });
const claim = (name: string, state: WorkerClaim['state'], agentControlMode: WorkerClaim['agentControlMode'] = 'web'): WorkerClaim => ({
  claimId: id(201), state, userId: id(202), workerId: id(203), machine: { id: id(204), name }, platform: 'linux', agent: 'codex', agentControlMode, worktreeId: id(205), phase: 'executing', herdr: agentControlMode === 'web' ? null : { session: 'session', workspaceId: 'workspace', paneId: 'pane' }, nativeSessionId: null, claimedAt: time,
});
const root = task(1, { status: 'done' });
const child = (n: number, changes: Partial<TaskSummary> = {}) => task(n, { dependsOn: [root.id], ...changes });
const snapshot = (tasks: TaskSummary[]): GraphSnapshot => ({ ...projectSummaries(project, tasks, time), observedAt: time, receivedMonotonic: 0, receivedAt: 0, revision: 1 });
const noop = () => {};
const workspace = (value: GraphSnapshot, onOpenTask = noop) => <ProjectTaskWorkspace projectId={project.id} snapshot={value} activeView="chains" unfinishedStandaloneTaskCount={0} unfinishedChainTaskCount={1} onViewChange={noop}
  chains={{ projectId: project.id, representativeIds: [root.id], allRepresentativeIds: [root.id], openChainId: null, onOpenChain: noop, onCloseChain: noop, onOpenTask }}
  standalone={{ projectId: project.id, taskIds: [], allTaskIds: [], onSelectTask: noop }} />;
const row = (n: number) => document.getElementById(`chain-task-${root.id}-${id(n)}`)!;

describe('chain worker machine presentation', () => {
  it('projects every claim state and mode strictly without adding properties to graph tasks', () => {
    const value = snapshot([root, child(2), child(3, { properties: { worker: claim('active host', 'active') } }), child(4, { properties: { worker: claim('released host', 'released', 'herdr') } }), child(5, { properties: { worker: claim('completed host', 'completed') } })]);
    expect([...value.workerMachines].map(([key, entry]) => [key, entry.state, entry.machine.name])).toEqual([[id(3), 'active', 'active host'], [id(4), 'released', 'released host'], [id(5), 'completed', 'completed host']]);
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
    const changed = initial.map((item) => item.id === id(3) ? { ...item, allowAgents: true, properties: { worker: claim('replacement', 'released') } } : item.id === id(4) ? { ...item, properties: {} } : item);
    view.rerender(workspace(snapshot(changed), onOpenTask));
    expect(document.getElementById(`task-root-${root.id}`)).toHaveAttribute('aria-expanded', 'true');
    expect(row(3)).toHaveTextContent('Automatic execution on');
    expect(row(3)).toHaveTextContent('Recorded machine: replacement');
    expect(row(3)).not.toHaveTextContent(longName);
    expect(row(4)).toHaveTextContent('No machine record');
    expect(row(4)).not.toHaveTextContent('live host');
  });
});
