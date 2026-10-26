import { selectTaskList } from './helpers/projectViews';
import { createGraphSyncFixture } from "./helpers/taskSync";
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
const otherProject = '10000000-0000-0000-0000-000000000002';
const time = '2026-10-20T12:00:00Z';
const task = (id: string, status: GraphTask['status'], dependsOn: string[] = [], externalDependsOn: string[] = []): GraphTask => ({ requiredPlatform: null, allowAgents: false, externalDependsOn, startedAt: null, completedAt: null,
  id, titlePreview: `任务 ${id}`, titleTruncated: false, status, dependsOn, blockedBy: [], ready: false, createdAt: time, updatedAt: time,
});
const seeds = [task('00000000-0000-4000-8000-000000000001', 'done'), task('00000000-0000-4000-8000-000000000002', 'todo', ['00000000-0000-4000-8000-000000000001']), task('00000000-0000-4000-8000-000000000003', 'done'), task('00000000-0000-4000-8000-000000000004', 'done', ['00000000-0000-4000-8000-000000000003']), task('00000000-0000-4000-8000-000000000005', 'done'), task('00000000-0000-4000-8000-000000000006', 'todo'), task('00000000-0000-4000-8000-000000000007', 'todo', ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000006'], ['00000000-0000-4000-8000-000000000002']), task('00000000-0000-4000-8000-000000000008', 'done', ['00000000-0000-4000-8000-000000000005'])];
const graph = (items = seeds, id = projectId): TaskGraph => {
  const tasks = items.map((item) => {
    const blockedBy = item.dependsOn.filter((dependency) => items.find((candidate) => candidate.id === dependency)!.status !== 'done');
    return { ...item, blockedBy, ready: item.status === 'todo' && blockedBy.length === 0 };
  });
  return { observedAt: "2026-10-20T12:00:00Z", project: { settings: { version: 1n, executionWarningMinutes: 60 }, id, name: `项目 ${id}`, repoUrl: 'https://github.com/example/repo', createdAt: time, updatedAt: time }, tasks,
    summary: { total: tasks.length, todo: tasks.filter((item) => item.status === 'todo').length, done: tasks.filter((item) => item.status === 'done').length,
      inProgress: tasks.filter((item) => item.status === 'in_progress').length, ready: tasks.filter((item) => item.ready).length,
      blocked: tasks.filter((item) => item.status === 'todo' && !item.ready).length } };
};
const allDone = () => seeds.map((item) => ({ ...item, status: 'done' as const }));
const visibilityKey = (id = projectId) => `daynight:completed-chains:${id}`;
const expansionKey = `daynight:project-view:${projectId}`;
const checkbox = () => screen.getByRole('checkbox', { name: /^显示已完成任务链/ });
const root = (id: string) => document.getElementById(`task-root-${id}`)!;
const graphButton = (id: string) => document.getElementById(`task-chain-graph-${id}`)!;
const roots = () => [...document.querySelectorAll('.root-toggle')].map((item) => item.id);
const graphRequest = vi.fn<(projectId: string, signal: AbortSignal) => Promise<TaskGraph>>();
const request = graphRequest;
const count = (label: string) => screen.getByText(label, { selector: '.stat-label' }).parentElement!.querySelector('.stat-number')!.textContent;
const savedExpansion = () => window.localStorage.getItem(expansionKey);
const closeGraph = () => fireEvent.click(document.querySelector<HTMLButtonElement>('.task-chain-close')!);

const replacementEpochs = new WeakMap<TaskGraph, string>();
const resetSnapshot = (value: TaskGraph): TaskGraph => { replacementEpochs.set(value, crypto.randomUUID()); return value; };
const syncFixture = createGraphSyncFixture();
beforeEach(() => {
  syncFixture.reset();
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (projectId, query, _userId, signal) => {
    const value = await graphRequest(projectId, signal);
    return syncFixture.toSync(value, query, replacementEpochs.get(value));
  });
});

beforeEach(() => { request.mockReset(); request.mockResolvedValue(graph()); });

describe('completed task chain visibility', () => {
  it('hides only complete chains while keeping done roots, explicit external dependencies and full project counts', async () => {
    render(<ProjectPage projectId={projectId} />); await selectTaskList();
    await screen.findByRole('checkbox', { name: '显示已完成任务链（2）' });
    expect(checkbox()).not.toBeChecked();
    expect(roots()).toEqual(['task-root-00000000-0000-4000-8000-000000000006', 'task-root-00000000-0000-4000-8000-000000000001']);
    expect(screen.getByLabelText('显示 2 条，共 4 条任务链')).toHaveTextContent('2 / 4');
    expect([count('任务总数'), count('已完成'), count('待处理')]).toEqual(['8', '5', '3']);
    fireEvent.click(graphButton('00000000-0000-4000-8000-000000000001'));
    expect(within(root('00000000-0000-4000-8000-000000000001')).getByText('进行中')).toBeVisible();
    expect(root('00000000-0000-4000-8000-000000000001').querySelector('.root-status')).toHaveClass('graph-status-in_progress');
    const projection = screen.getByTestId('projection');
    expect([...projection.querySelectorAll('[data-node-id]')].map((item) => item.getAttribute('data-node-id'))).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
    expect([...projection.querySelectorAll('[data-edge]')].map((item) => item.getAttribute('data-edge'))).toEqual(['00000000-0000-4000-8000-000000000001->00000000-0000-4000-8000-000000000002']);
    closeGraph();
    checkbox().focus();
    fireEvent.click(checkbox());
    expect(checkbox()).toHaveFocus();
    expect(roots()).toEqual(['task-root-00000000-0000-4000-8000-000000000006', 'task-root-00000000-0000-4000-8000-000000000005', 'task-root-00000000-0000-4000-8000-000000000003', 'task-root-00000000-0000-4000-8000-000000000001']);
    expect(graphButton('00000000-0000-4000-8000-000000000001')).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByTestId('projection')).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps the graph closed when completed-chain visibility changes', async () => {
    window.localStorage.setItem(visibilityKey(), 'true');
    render(<ProjectPage projectId={projectId} />); await selectTaskList();
    await screen.findByRole('checkbox');
    fireEvent.click(graphButton('00000000-0000-4000-8000-000000000005'));
    expect(screen.getByTestId('projection')).toHaveAttribute('data-root-id', '00000000-0000-4000-8000-000000000005');
    closeGraph();
    checkbox().focus(); fireEvent.click(checkbox());
    expect(checkbox()).toHaveFocus();
    expect(root('00000000-0000-4000-8000-000000000006')).toBeVisible();
    expect(screen.queryByTestId('projection')).toBeNull();
    fireEvent.click(checkbox());
    expect(screen.queryByTestId('projection')).toBeNull();
    expect(savedExpansion()).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('remembers visibility across remounts and projects while every graph starts closed', async () => {
    request.mockImplementation(async (id) => graph(seeds, id));
    let view = render(<ProjectPage projectId={projectId} />); await selectTaskList();
    await screen.findByRole('checkbox');
    fireEvent.click(checkbox()); fireEvent.click(graphButton('00000000-0000-4000-8000-000000000003'));
    expect(screen.getByTestId('projection')).toBeVisible();
    view.unmount(); view = render(<ProjectPage projectId={projectId} />); await selectTaskList();
    await screen.findByRole('checkbox');
    expect(checkbox()).toBeChecked();
    expect(screen.queryByTestId('projection')).toBeNull();
    expect(savedExpansion()).toBeNull();
    view.rerender(<ProjectPage projectId={otherProject} />); await selectTaskList();
    await screen.findByRole('checkbox'); expect(checkbox()).not.toBeChecked();
    fireEvent.click(checkbox()); fireEvent.click(checkbox());
    view.rerender(<ProjectPage projectId={projectId} />); await selectTaskList();
    await screen.findByRole('checkbox'); expect(checkbox()).toBeChecked();
    expect(screen.queryByTestId('projection')).toBeNull();
    expect(window.localStorage.getItem(visibilityKey(otherProject))).toBe('false');
  });

  it.each(['00000000-0000-4000-8000-000000000003', null])('distinguishes all-complete from empty and ignores a saved inline expansion (%s)', async (saved) => {
    const legacyValue = JSON.stringify({ expandedRootId: saved });
    window.localStorage.setItem(expansionKey, legacyValue);
    request.mockResolvedValue(graph([seeds[2]!, seeds[3]!, seeds[4]!, seeds[7]!]));
    render(<ProjectPage projectId={projectId} />); await selectTaskList();
    await screen.findByRole('heading', { name: '所有任务链已完成' });
    expect(screen.queryByText('还没有任务')).toBeNull();
    expect(count('任务总数')).toBe('4'); expect(count('已完成')).toBe('4');
    expect(screen.getByLabelText('显示 0 条，共 2 条任务链')).toBeVisible();
    expect(savedExpansion()).toBe(legacyValue);
    fireEvent.click(screen.getByRole('button', { name: '显示已完成任务链' }));
    expect(checkbox()).toBeChecked(); expect(checkbox()).toHaveFocus();
    expect(screen.queryByRole('heading', { name: '所有任务链已完成' })).toBeNull();
    expect(screen.queryByTestId('projection')).toBeNull();
    expect(document.querySelector('[aria-expanded="true"]')).toBeNull();
    fireEvent.click(checkbox()); expect(checkbox()).toHaveFocus();
    expect(savedExpansion()).toBe(legacyValue);
  });

  it('keeps a truly empty project distinct from an all-complete list', async () => {
    request.mockResolvedValue(graph([])); render(<ProjectPage projectId={projectId} />); await selectTaskList();
    await screen.findByRole('heading', { name: '还没有任务' });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('heading', { name: '所有任务链已完成' })).toBeNull();
  });

  it('closes a graph when refresh hides its completed chain and does not open a replacement', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    request.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph(allDone())).mockResolvedValueOnce(resetSnapshot(graph([task('00000000-0000-4000-8000-000000000011', 'todo'), task('00000000-0000-4000-8000-000000000012', 'todo', ['00000000-0000-4000-8000-000000000011'])])));
    render(<ProjectPage projectId={projectId} />); await selectTaskList(); await screen.findByRole('checkbox');
    fireEvent.click(graphButton('00000000-0000-4000-8000-000000000001'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await screen.findByRole('heading', { name: '所有任务链已完成' });
    expect(screen.queryByTestId('projection')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '显示已完成任务链' }));
    expect(root('00000000-0000-4000-8000-000000000001')).toBeVisible();
    expect(screen.queryByTestId('projection')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('checkbox', { name: '显示已完成任务链（0）' });
    expect(root('00000000-0000-4000-8000-000000000011')).toBeVisible();
    expect(screen.queryByTestId('projection')).toBeNull();
    expect(savedExpansion()).toBeNull();
  });

  it('keeps an explicitly closed graph closed while filtering and refreshing', async () => {
    render(<ProjectPage projectId={projectId} />); await selectTaskList(); await screen.findByRole('checkbox');
    fireEvent.click(graphButton('00000000-0000-4000-8000-000000000001'));
    closeGraph();
    fireEvent.click(checkbox()); fireEvent.click(checkbox()); fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('projection')).toBeNull(); expect(savedExpansion()).toBeNull();
  });

  it('does not save visibility while initial graph loading or an initial request failure is displayed', async () => {
    let reject!: (error: unknown) => void;
    request.mockReturnValue(new Promise((_resolve, rejectRequest) => { reject = rejectRequest; }));
    const write = vi.spyOn(Storage.prototype, 'setItem');
    render(<ProjectPage projectId={projectId} />);
    expect(write).not.toHaveBeenCalled();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await act(async () => { reject(new ApiError('network')); });
    await screen.findByRole('alert'); expect(write).not.toHaveBeenCalled();
  });

  it('retains the chosen visibility and complete snapshot when a refresh fails', async () => {
    request.mockResolvedValueOnce(graph()).mockRejectedValueOnce(new ApiError('network'));
    const read = vi.spyOn(Storage.prototype, 'getItem');
    render(<ProjectPage projectId={projectId} />); await selectTaskList(); await screen.findByRole('checkbox');
    fireEvent.click(checkbox()); fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('alert');
    expect(checkbox()).toBeChecked(); expect(roots()).toHaveLength(4);
    expect(count('任务总数')).toBe('8');
    expect(read.mock.calls.filter(([key]) => key === visibilityKey())).toHaveLength(1);
    expect(window.localStorage.getItem(visibilityKey())).toBe('true');
  });

  it.each(['{', 'null', '{}', '[]', '"true"', '1'])('reports invalid visibility data and keeps filtering usable (%s)', async (saved) => {
    window.localStorage.setItem(visibilityKey(), saved);
    render(<ProjectPage projectId={projectId} />); await selectTaskList(); await screen.findByRole('checkbox');
    expect(screen.getByText(/^浏览器保存的已完成任务链显示偏好无效/)).toBeVisible();
    expect(checkbox()).not.toBeChecked(); fireEvent.click(checkbox());
    expect(checkbox()).toBeChecked(); expect(window.localStorage.getItem(visibilityKey())).toBe('true');
  });

  it('reports read failures and retains usable default filtering', async () => {
    const original = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === visibilityKey()) throw new DOMException('Storage denied', 'SecurityError');
      return original.call(this, key);
    });
    render(<ProjectPage projectId={projectId} />); await selectTaskList(); await screen.findByRole('checkbox');
    expect(screen.getByText(/^无法读取浏览器保存的已完成任务链显示偏好/)).toBeVisible();
    fireEvent.click(checkbox()); expect(checkbox()).toBeChecked(); expect(roots()).toHaveLength(4);
  });

  it('reports write failures while applying the choice and clears them after a successful save', async () => {
    const original = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === visibilityKey()) throw new DOMException('Storage full', 'QuotaExceededError');
      original.call(this, key, value);
    });
    render(<ProjectPage projectId={projectId} />); await selectTaskList(); await screen.findByRole('checkbox');
    fireEvent.click(checkbox()); expect(checkbox()).toBeChecked(); expect(roots()).toHaveLength(4);
    expect(screen.getByText(/^已完成任务链显示偏好无法保存到浏览器/)).toBeVisible();
    write.mockRestore(); fireEvent.click(checkbox());
    expect(screen.queryByText(/^已完成任务链显示偏好无法保存到浏览器/)).toBeNull();
    expect(window.localStorage.getItem(visibilityKey())).toBe('false');
  });

  it('keeps visibility controls usable when browser storage access is entirely denied', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('Storage denied', 'SecurityError'); });
    render(<ProjectPage projectId={projectId} />); await selectTaskList(); await screen.findByRole('checkbox');
    expect(screen.getByText(/^无法读取浏览器保存的已完成任务链显示偏好/)).toBeVisible();
    fireEvent.click(checkbox()); expect(checkbox()).toBeChecked(); expect(roots()).toHaveLength(4);
    expect(screen.getByText(/^已完成任务链显示偏好无法保存到浏览器/)).toBeVisible();
  });
});
