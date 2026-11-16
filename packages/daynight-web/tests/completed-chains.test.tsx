import { selectTaskList } from './helpers/projectViews';
import { taskSyncReadFixture, createGraphSyncFixture } from "./helpers/taskSync";
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createLocaleRender } from './helpers/renderWithLocale';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getTaskSync } from '../src/api/client';
import type { GraphTask, TaskGraph } from '../src/api/types';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { projectChain, type GraphIndex } from '../src/features/task-graph/model';

const localeRender = createLocaleRender('zh-CN');
const render: typeof localeRender = (ui, options) => localeRender(ui, { ...options, taskCache: true });

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), getTaskSync: vi.fn() }));
vi.mock('../src/features/task-graph/TaskGraph', () => ({ TaskGraph: ({ index, rootId, onOpenTask }: {
  index: GraphIndex; rootId: string; onOpenTask: (id: string, trigger: HTMLElement) => void;
}) => {
  const projection = projectChain(index, rootId);
  return <div data-testid="projection" data-root-id={rootId}>
    {[...projection.mainIds, ...projection.externalIds].map((id) => <button key={id} data-node-id={id} onClick={(event) => { onOpenTask(id, event.currentTarget); }}>{index.nodes.get(id)!.titlePreview}</button>)}
    {projection.edges.map(({ source, target }) => <span key={`${source}->${target}`} data-edge={`${source}->${target}`} />)}
  </div>;
} }));

const projectId = '10000000-0000-0000-0000-000000000001';
const time = '2026-10-20T12:00:00Z';
const task = (id: string, status: GraphTask['status'], dependsOn: string[] = [], externalDependsOn: string[] = []): GraphTask => ({ type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn, startedAt: null, completedAt: null, cancelledAt: null,
  id, titlePreview: `任务 ${id}`, titleTruncated: false, status, dependsOn, blockedBy: [], ready: false, createdAt: time, updatedAt: time,
});
const seeds = [task('00000000-0000-4000-8000-000000000001', 'done'), task('00000000-0000-4000-8000-000000000002', 'todo', ['00000000-0000-4000-8000-000000000001']), task('00000000-0000-4000-8000-000000000003', 'done'), task('00000000-0000-4000-8000-000000000004', 'done', ['00000000-0000-4000-8000-000000000003']), task('00000000-0000-4000-8000-000000000005', 'done'), task('00000000-0000-4000-8000-000000000006', 'todo'), task('00000000-0000-4000-8000-000000000007', 'todo', ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000006'], ['00000000-0000-4000-8000-000000000002']), task('00000000-0000-4000-8000-000000000008', 'done', ['00000000-0000-4000-8000-000000000005'])];
const graph = (items = seeds, id = projectId): TaskGraph => {
  const tasks = items.map((item) => {
    const blockedBy = item.dependsOn.filter((dependency) => items.find((candidate) => candidate.id === dependency)!.status !== 'done');
    return { ...item, blockedBy, ready: item.status === 'todo' && blockedBy.length === 0 };
  });
  return { observedAt: "2026-10-20T12:00:00Z", project: { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, id, name: `项目 ${id}`, repoUrl: 'https://github.com/example/repo', createdAt: time, updatedAt: time }, tasks,
    summary: { proposed: 0, total: tasks.length, todo: tasks.filter((item) => item.status === 'todo').length, done: tasks.filter((item) => item.status === 'done').length, cancelled: 0,
      inProgress: tasks.filter((item) => item.status === 'in_progress').length, ready: tasks.filter((item) => item.ready).length,
      blocked: tasks.filter((item) => item.status === 'todo' && !item.ready).length } };
};
const root = (id: string) => document.getElementById(`task-root-${id}`)!;
const graphButton = (id: string) => document.getElementById(`task-chain-graph-${id}`)!;
const roots = () => [...document.querySelectorAll('.root-toggle')].map((item) => item.id);
const graphRequest = vi.fn<(projectId: string, signal: AbortSignal) => Promise<TaskGraph>>();
const request = graphRequest;
const count = (label: string) => screen.getByText(label, { selector: '.stat-label' }).parentElement!.querySelector('.stat-number')!.textContent;
const closeGraph = () => fireEvent.click(document.querySelector<HTMLButtonElement>('.task-chain-close')!);

const replacementEpochs = new WeakMap<TaskGraph, string>();
const resetSnapshot = (value: TaskGraph): TaskGraph => { replacementEpochs.set(value, crypto.randomUUID()); return value; };
const syncFixture = createGraphSyncFixture();
beforeEach(() => {
  window.history.replaceState(null, "", `/projects/${projectId}`);
  syncFixture.reset();
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (projectId, query, _userId, signal) => {
    const value = await graphRequest(projectId, signal);
    return taskSyncReadFixture(syncFixture.toSync(value, query, replacementEpochs.get(value)));
  });
});

beforeEach(() => { request.mockReset(); request.mockResolvedValue(graph()); });

describe('task chain status filtering', () => {
  it('shows all chains by default, keeps full counts and projects ordinary dependencies', async () => {
    render(<ProjectPage projectId={projectId} />); await selectTaskList();
    const filter = await screen.findByRole('combobox', { name: '状态' });
    expect(filter).toHaveValue('all');
    expect(screen.queryByRole('checkbox', { name: '显示所有' })).toBeNull();
    expect(roots()).toEqual(['task-root-00000000-0000-4000-8000-000000000001', 'task-root-00000000-0000-4000-8000-000000000006', 'task-root-00000000-0000-4000-8000-000000000005', 'task-root-00000000-0000-4000-8000-000000000003']);
    expect([count('任务总数'), count('已完成'), count('待处理')]).toEqual(['8', '5', '3']);
    fireEvent.click(graphButton('00000000-0000-4000-8000-000000000001'));
    const projection = screen.getByTestId('projection');
    expect([...projection.querySelectorAll('[data-node-id]')].map((item) => item.getAttribute('data-node-id'))).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
    expect([...projection.querySelectorAll('[data-edge]')].map((item) => item.getAttribute('data-edge'))).toEqual(['00000000-0000-4000-8000-000000000001->00000000-0000-4000-8000-000000000002']);
    closeGraph();
    fireEvent.change(filter, { target: { value: 'todo' } });
    expect(roots()).toEqual(['task-root-00000000-0000-4000-8000-000000000001', 'task-root-00000000-0000-4000-8000-000000000006']);
    fireEvent.change(filter, { target: { value: 'done' } });
    expect(roots()).toEqual(['task-root-00000000-0000-4000-8000-000000000001', 'task-root-00000000-0000-4000-8000-000000000005', 'task-root-00000000-0000-4000-8000-000000000003']);
    expect([count('任务总数'), count('已完成'), count('待处理')]).toEqual(['8', '5', '3']);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('ignores obsolete visibility preferences and still distinguishes an empty project', async () => {
    window.localStorage.setItem(`daynight:completed-chains:${projectId}`, '{');
    request.mockResolvedValueOnce(graph([seeds[2]!, seeds[3]!])).mockResolvedValue(resetSnapshot(graph([])));
    render(<ProjectPage projectId={projectId} />); await selectTaskList();
    await screen.findByRole('combobox', { name: '状态' });
    expect(root('00000000-0000-4000-8000-000000000003')).toBeVisible();
    expect(screen.queryByText(/显示所有.*偏好/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('heading', { name: '暂无任务链' });
    expect(screen.getByRole('tab', { name: 'Goal' })).toBeVisible();
  });

  it('retains the selected filter and snapshot after a failed refresh', async () => {
    request.mockResolvedValueOnce(graph()).mockRejectedValueOnce(new ApiError('network'));
    render(<ProjectPage projectId={projectId} />); await selectTaskList();
    const filter = await screen.findByRole('combobox', { name: '状态' });
    fireEvent.change(filter, { target: { value: 'done' } });
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('heading', { name: '刷新失败' });
    expect(filter).toHaveValue('done');
    expect(roots()).toHaveLength(3);
    expect(count('任务总数')).toBe('8');
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });
});
