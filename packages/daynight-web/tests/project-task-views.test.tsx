import { createGraphSyncFixture } from "./helpers/taskSync";
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createLocaleRender } from './helpers/renderWithLocale';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getTask, getTaskSync } from '../src/api/client';
import type { GraphTask, TaskGraph } from '../src/api/types';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import type { GraphIndex } from '../src/features/task-graph/model';

const localeRender = createLocaleRender('zh-CN');
const render: typeof localeRender = (ui, options) => localeRender(ui, { ...options, taskCache: true });

vi.mock('../src/api/client', async (original) => ({
  ...await original<typeof import('../src/api/client')>(), getTask: vi.fn(), getTaskSync: vi.fn(),
  listAttachments: vi.fn(async () => ({ items: [], nextCursor: null })),
  attachmentPreviewRoot: (projectId: string, taskId: string) => `/fixtures/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/preview/`,
}));
vi.mock('../src/features/task-graph/TaskGraph', () => ({ TaskGraph: ({ index, rootId, onOpenTask }: {
  index: GraphIndex; rootId: string; onOpenTask: (id: string, trigger: HTMLElement) => void;
}) => <button data-testid="graph-node" onClick={(event) => { onOpenTask(rootId, event.currentTarget); }}>图节点 {index.nodes.get(rootId)!.titlePreview}</button> }));

const project = '00000000-0000-4000-8000-000000000100';
const otherProject = '00000000-0000-4000-8000-000000000200';
const canonicalTask = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const timestamp = '2026-10-20T12:00:00.123456Z';
const seed = (id: string, status: GraphTask['status'] = 'todo', dependsOn: string[] = [], externalDependsOn: string[] = []): GraphTask => ({ requiredPlatform: null, allowAgents: false, externalDependsOn, startedAt: null, completedAt: null,
  id, titlePreview: `任务 ${id}`, titleTruncated: false, status, dependsOn, blockedBy: [], ready: false,
  createdAt: timestamp, updatedAt: timestamp,
});
const seeds = [seed('00000000-0000-4000-8000-000000000001', 'done'), seed('00000000-0000-4000-8000-000000000002', 'todo', ['00000000-0000-4000-8000-000000000001']), seed('00000000-0000-4000-8000-000000000003'), seed('00000000-0000-4000-8000-000000000004', 'done'), seed('00000000-0000-4000-8000-000000000005', 'in_progress')];
const snapshot = (items = seeds, id = project): TaskGraph => {
  const tasks = items.map((item) => {
    const blockedBy = item.dependsOn.filter((dependency) => items.find((candidate) => candidate.id === dependency)!.status !== 'done');
    return { ...item, blockedBy, ready: item.status === 'todo' && blockedBy.length === 0 };
  });
  return { observedAt: "2026-10-20T12:00:00Z", project: { settings: { version: 1n, executionWarningMinutes: 60 }, id, name: id, repoUrl: 'https://github.com/example/repo', createdAt: timestamp, updatedAt: timestamp }, tasks,
    summary: { total: tasks.length, todo: tasks.filter((item) => item.status === 'todo').length,
      done: tasks.filter((item) => item.status === 'done').length, inProgress: tasks.filter((item) => item.status === 'in_progress').length,
      ready: tasks.filter((item) => item.ready).length, blocked: tasks.filter((item) => item.status === 'todo' && !item.ready).length } };
};
const graphRequest = vi.fn<(projectId: string, signal: AbortSignal) => Promise<TaskGraph>>();
const tab = (view: 'chains' | 'standalone') => screen.getByRole('tab', { name: view === 'chains' ? '任务链' : '独立任务' });
const expectUnfinishedCounts = (chains: number, standalone: number) => {
  expect(tab('chains').querySelector('.graph-count-pill')).toHaveTextContent(new RegExp(`^${chains}$`));
  expect(tab('standalone').querySelector('.graph-count-pill')).toHaveTextContent(new RegExp(`^${standalone}$`));
};
const row = (id: string) => document.getElementById(`standalone-task-${id}`)!;
const chainRow = (id = canonicalTask(1)) => document.getElementById(`task-root-${id}`)!;
const findChainRow = async (id = canonicalTask(1)) => {
  await waitFor(() => expect(chainRow(id)).toBeVisible());
  return chainRow(id);
};
const openChain = async (id = canonicalTask(1)) => {
  fireEvent.click(await findChainRow(id));
  return screen.findByTestId('graph-node');
};
const closeChain = () => fireEvent.click(document.querySelector<HTMLButtonElement>('.task-chain-close')!);
const key = (kind: string, id = project) => `daynight:${kind}:${id}`;
let root: HTMLDivElement;

const replacementEpochs = new WeakMap<TaskGraph, string>();
const resetSnapshot = (value: TaskGraph): TaskGraph => { replacementEpochs.set(value, crypto.randomUUID()); return value; };
const syncFixture = createGraphSyncFixture();
const servedGraphs = new Map<string, TaskGraph>();
const servedVersions = new Map<string, bigint>();
beforeEach(() => {
  syncFixture.reset();
  servedGraphs.clear(); servedVersions.clear();
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (projectId, query, _userId, signal) => {
    const value = await graphRequest(projectId, signal);
    const sync = syncFixture.toSync(value, query, replacementEpochs.get(value));
    servedGraphs.set(projectId, value);
    for (const task of sync.tasks) servedVersions.set(`${projectId}/${task.id}`, task.version);
    return sync;
  });
});

beforeEach(() => {
  root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  graphRequest.mockReset(); graphRequest.mockImplementation(async (id) => snapshot(seeds, id));
  vi.mocked(getTask).mockReset();
  vi.mocked(getTask).mockImplementation(async (projectId, id) => {
    const task = servedGraphs.get(projectId)!.tasks.find((item) => item.id === id)!;
    return { ...task, id, projectId, title: task.titlePreview, description: '', properties: { worker: null, pullRequests: [] }, version: servedVersions.get(`${projectId}/${id}`)! };
  });
});
afterEach(() => { cleanup(); root.remove(); });
const selectTasks = () => { fireEvent.click(screen.getByRole('tab', { name: '任务列表' })); };
const mount = () => {
  if (!root.isConnected) document.body.append(root);
  const view = render(<ProjectPage projectId={project} />, { container: root });
  selectTasks();
  return view;
};

const openStandalone = async (id: string) => {
  fireEvent.click(tab('standalone'));
  const trigger = row(id); trigger.focus(); fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog');
  await within(dialog).findByRole('heading', { name: `任务 ${id}` });
  return { trigger, dialog };
};

describe('project task views', () => {
  it('shows waiting tasks in unfinished counts, chain summaries, statistics and standalone rows', async () => {
    graphRequest.mockResolvedValue(snapshot([
      seed('00000000-0000-4000-8000-000000000001', 'todo'), seed('00000000-0000-4000-8000-000000000002', 'todo', ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003']), seed('00000000-0000-4000-8000-000000000003'), seed('00000000-0000-4000-8000-000000000004', 'todo'),
      seed('00000000-0000-4000-8000-000000000005', 'done'), seed('00000000-0000-4000-8000-000000000006', 'todo', ['00000000-0000-4000-8000-000000000005']), seed('00000000-0000-4000-8000-000000000007', 'done'),
    ]));
    mount(); await screen.findByRole('tab', { name: '任务链' });
    expectUnfinishedCounts(4, 1);
    const stats = screen.getByRole('region', { name: '项目任务统计', hidden: true });
    expect(stats.querySelectorAll('.stat')).toHaveLength(6);
    expect(stats).toHaveTextContent('待处理5等待开始');
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000001')?.querySelector('.root-status')).toHaveTextContent('待处理');
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000001')?.querySelector('.root-progress-label')).toHaveTextContent('0/3 已完成');
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000003')).toBeNull();
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000005')?.querySelector('.root-status')).toHaveTextContent('进行中');
    fireEvent.click(tab('standalone'));
    expect(row('00000000-0000-4000-8000-000000000004')).toHaveTextContent('待处理');
    expect(row('00000000-0000-4000-8000-000000000004').querySelector('.root-status')).toHaveClass('graph-status-todo');
    expect(row('00000000-0000-4000-8000-000000000004')).toHaveTextContent('可开始');
    expect(document.getElementById('standalone-task-00000000-0000-4000-8000-000000000007')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '显示已完成独立任务（1）' }));
    expect(row('00000000-0000-4000-8000-000000000007')).toBeVisible();
    expectUnfinishedCounts(4, 1);
  });

  it('shows confirmed platform requirements in standalone rows without changing readiness', async () => {
    graphRequest.mockResolvedValue(snapshot(seeds.map((task) => ({ ...task, requiredPlatform: task.id === '00000000-0000-4000-8000-000000000003' ? 'linux' : task.id === '00000000-0000-4000-8000-000000000005' ? 'windows' : null }))));
    mount(); await screen.findByRole('tab', { name: '独立任务' }); fireEvent.click(tab('standalone'));
    expect(row('00000000-0000-4000-8000-000000000003').querySelector('.task-platform')).toHaveTextContent('Linux');
    expect(row('00000000-0000-4000-8000-000000000005').querySelector('.task-platform')).toHaveTextContent('Windows');
    expect(row('00000000-0000-4000-8000-000000000003')).toHaveTextContent('可开始'); expect(row('00000000-0000-4000-8000-000000000005')).toHaveTextContent('进行中');
  });

  it('classifies complete dependencies independently from status and keeps summary and API order intact', async () => {
    const complete = snapshot(); graphRequest.mockResolvedValue(complete);
    mount(); await screen.findByRole('tab', { name: '任务链' });
    expect(tab('chains')).toHaveAttribute('aria-selected', 'true');
    expectUnfinishedCounts(1, 2);
    expect(document.querySelectorAll('.root-toggle')).toHaveLength(1);
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000001')).toBeVisible();
    expect(screen.getByLabelText('显示 1 条，共 1 条任务链')).toHaveTextContent('1 / 1');
    fireEvent.click(tab('standalone'));
    expect([...document.querySelectorAll('.standalone-row')].map((item) => item.id)).toEqual(['standalone-task-00000000-0000-4000-8000-000000000005', 'standalone-task-00000000-0000-4000-8000-000000000003']);
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(row('00000000-0000-4000-8000-000000000003')).toHaveTextContent('可开始'); expect(row('00000000-0000-4000-8000-000000000005')).toHaveTextContent('进行中');
    expect(document.getElementById('standalone-task-00000000-0000-4000-8000-000000000002')).toBeNull();
    expect(screen.getByRole('checkbox', { name: '显示已完成独立任务（1）' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    expect(within(screen.getByRole('region', { name: '项目任务统计' })).getByText('5')).toBeVisible();
    selectTasks();
    expect(complete.tasks.map(({ id }) => id)).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005']);
    expect(graphRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps an externally blocked singleton outside ordinary chains', async () => {
    graphRequest.mockResolvedValue(snapshot([
      seed('00000000-0000-4000-8000-000000000001'), seed('00000000-0000-4000-8000-000000000002', 'todo', ['00000000-0000-4000-8000-000000000001'], ['00000000-0000-4000-8000-000000000001']),
    ]));
    mount(); await screen.findByRole('tab', { name: '任务链' });
    expect(screen.getByRole('heading', { name: '暂无任务链' })).toBeVisible();
    expectUnfinishedCounts(0, 2);
    fireEvent.click(tab('standalone'));
    expect(row('00000000-0000-4000-8000-000000000001')).toBeVisible(); expect(row('00000000-0000-4000-8000-000000000002')).toBeVisible();
    expect(row('00000000-0000-4000-8000-000000000001').querySelector('.task-ready')).toHaveTextContent('可开始');
    expect(row('00000000-0000-4000-8000-000000000002').querySelector('.graph-blocked-badge')).toHaveTextContent('被阻塞');
    expect(row('00000000-0000-4000-8000-000000000002').querySelector('.task-ready')).toBeNull();
    expect(row('00000000-0000-4000-8000-000000000002').querySelector('.root-status')).toHaveTextContent('待处理');
  });

  it('counts unfinished tasks once across ordinary components and keeps both counts independent of visible rows', async () => {
    graphRequest.mockResolvedValue(snapshot([
      seed('00000000-0000-4000-8000-000000000001', 'done'), seed('00000000-0000-4000-8000-000000000002', 'done'), seed('00000000-0000-4000-8000-000000000003', 'in_progress', ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']), seed('00000000-0000-4000-8000-000000000004', 'todo', ['00000000-0000-4000-8000-000000000003']),
      seed('00000000-0000-4000-8000-000000000005'), seed('00000000-0000-4000-8000-000000000006', 'todo', ['00000000-0000-4000-8000-000000000005']), seed('00000000-0000-4000-8000-000000000007'), seed('00000000-0000-4000-8000-000000000008', 'in_progress'), seed('00000000-0000-4000-8000-000000000009', 'done'),
      seed('00000000-0000-4000-8000-000000000010', 'done'), seed('00000000-0000-4000-8000-000000000011', 'done', ['00000000-0000-4000-8000-000000000010']),
    ]));
    mount(); await screen.findByRole('tab', { name: '任务链' });
    expectUnfinishedCounts(4, 2);
    expect(tab('chains').querySelector('.graph-count-pill')).toHaveAttribute('title', '未完成任务数');
    expect(document.querySelectorAll('.root-toggle')).toHaveLength(2);
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000001')).toBeVisible();
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000002')).toBeNull();
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000010')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '显示已完成任务链（1）' }));
    expect(document.querySelectorAll('.root-toggle')).toHaveLength(3);
    expectUnfinishedCounts(4, 2);
    fireEvent.click(tab('standalone'));
    expect([...document.querySelectorAll('.standalone-row')].map((item) => item.id)).toEqual(['standalone-task-00000000-0000-4000-8000-000000000008', 'standalone-task-00000000-0000-4000-8000-000000000007']);
    expect(tab('standalone').querySelector('.graph-count-pill')).toHaveAttribute('title', '未完成任务数');
    fireEvent.click(screen.getByRole('checkbox', { name: '显示已完成独立任务（1）' }));
    expect(row('00000000-0000-4000-8000-000000000009')).toBeVisible();
    expectUnfinishedCounts(4, 2);
    fireEvent.click(tab('chains'));
    expectUnfinishedCounts(4, 2);
    expect(graphRequest).toHaveBeenCalledTimes(1);
  });

  it('shows zero unfinished tasks for completed chains and standalone tasks with either filter setting', async () => {
    graphRequest.mockResolvedValue(snapshot([seed('00000000-0000-4000-8000-000000000001', 'done'), seed('00000000-0000-4000-8000-000000000002', 'done', ['00000000-0000-4000-8000-000000000001']), seed('00000000-0000-4000-8000-000000000004', 'done')]));
    mount(); await screen.findByRole('heading', { name: '所有任务链已完成' });
    expectUnfinishedCounts(0, 0);
    fireEvent.click(screen.getByRole('button', { name: '显示已完成任务链' }));
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000001')).toBeVisible();
    expectUnfinishedCounts(0, 0);
    fireEvent.click(tab('standalone'));
    expect(await screen.findByRole('heading', { name: '所有独立任务已完成' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '显示已完成独立任务' }));
    expect(row('00000000-0000-4000-8000-000000000004')).toBeVisible();
    expectUnfinishedCounts(0, 0);
  });

  it('updates counts and categories from one successful snapshot and retains them while refreshing or after failure', async () => {
    let resolve!: (value: TaskGraph) => void;
    const refreshed = new Promise<TaskGraph>((done) => { resolve = done; });
    graphRequest.mockResolvedValueOnce(snapshot()).mockReturnValueOnce(refreshed).mockRejectedValueOnce(new Error('Refresh failed'));
    mount(); await screen.findByRole('tab', { name: '独立任务' });
    fireEvent.click(tab('standalone'));
    expectUnfinishedCounts(1, 2);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(screen.getByRole('button', { name: '正在刷新…' })).toBeDisabled();
    expect(row('00000000-0000-4000-8000-000000000003')).toBeVisible(); expect(row('00000000-0000-4000-8000-000000000005')).toBeVisible();
    expectUnfinishedCounts(1, 2);
    await act(async () => { resolve(snapshot([
      seed('00000000-0000-4000-8000-000000000001', 'done'), seed('00000000-0000-4000-8000-000000000002', 'todo', ['00000000-0000-4000-8000-000000000001']), seed('00000000-0000-4000-8000-000000000003', 'todo', ['00000000-0000-4000-8000-000000000001']), seed('00000000-0000-4000-8000-000000000004', 'done'), seed('00000000-0000-4000-8000-000000000005', 'in_progress', ['00000000-0000-4000-8000-000000000001']),
    ])); });
    expect(await screen.findByRole('heading', { name: '所有独立任务已完成' })).toBeVisible();
    expect(document.getElementById('standalone-task-00000000-0000-4000-8000-000000000003')).toBeNull();
    expect(document.getElementById('standalone-task-00000000-0000-4000-8000-000000000005')).toBeNull();
    expectUnfinishedCounts(3, 0);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('heading', { name: '刷新失败' });
    expect(await screen.findByRole('heading', { name: '所有独立任务已完成' })).toBeVisible();
    expectUnfinishedCounts(3, 0);
    fireEvent.click(tab('chains'));
    expect(document.getElementById('task-root-00000000-0000-4000-8000-000000000001')).toBeVisible();
    expectUnfinishedCounts(3, 0);
  });

  it('opens the real dialog directly and returns focus to its standalone row', async () => {
    graphRequest.mockResolvedValue(snapshot([seed(canonicalTask(3))]));
    mount(); await screen.findByRole('tab', { name: '独立任务' });
    const { trigger, dialog } = await openStandalone(canonicalTask(3));
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(root).toHaveAttribute('inert');
    expect(within(dialog).getByRole('button', { name: '关闭任务详情' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(root).not.toHaveAttribute('inert');
  });

  it('uses roving tab focus with wrapping arrows, Home and End without requesting another snapshot', async () => {
    mount(); await screen.findByRole('tab', { name: '任务链' }); tab('chains').focus();
    fireEvent.keyDown(tab('chains'), { key: 'ArrowRight' });
    expect(tab('standalone')).toHaveFocus(); expect(tab('standalone')).toHaveAttribute('tabindex', '0');
    expect(tab('chains')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel', { name: '独立任务' })).toBeVisible();
    fireEvent.keyDown(tab('standalone'), { key: 'ArrowLeft' }); expect(tab('chains')).toHaveFocus();
    fireEvent.keyDown(tab('chains'), { key: 'Home' }); expect(tab('standalone')).toHaveFocus();
    fireEvent.keyDown(tab('standalone'), { key: 'End' }); expect(tab('chains')).toHaveFocus();
    fireEvent.keyDown(tab('chains'), { key: 'ArrowDown' }); expect(tab('chains')).toHaveFocus();
    expect(graphRequest).toHaveBeenCalledTimes(1);
  });

  it('remembers filters and selected view while chain graphs reopen only after a click', async () => {
    let view = mount(); await screen.findByRole('tab', { name: '任务链' });
    await openChain();
    closeChain();
    fireEvent.click(screen.getByRole('checkbox', { name: /^显示已完成任务链/ }));
    fireEvent.click(tab('standalone')); fireEvent.click(screen.getByRole('checkbox', { name: /^显示已完成独立任务/ }));
    expect(row('00000000-0000-4000-8000-000000000004')).toBeVisible();
    cleanup(); view = mount(); await screen.findByRole('tab', { name: '独立任务' });
    expect(tab('standalone')).toHaveAttribute('aria-selected', 'true'); expect(row('00000000-0000-4000-8000-000000000004')).toBeVisible();
    fireEvent.click(tab('chains')); expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(screen.getByRole('checkbox', { name: /^显示已完成任务链/ })).toBeChecked();
    expect(window.localStorage.getItem(key('project-view'))).toBeNull();
    expect(window.localStorage.getItem(key('completed-chains'))).toBe('true');
    view.rerender(<ProjectPage projectId={otherProject} />); selectTasks(); await screen.findByRole('heading', { name: otherProject });
    expect(tab('chains')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tab('standalone')); expect(screen.getByRole('checkbox', { name: /^显示已完成独立任务/ })).not.toBeChecked();
    view.rerender(<ProjectPage projectId={project} />); selectTasks(); await screen.findByRole('heading', { name: project });
    expect(tab('chains')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tab('standalone')); expect(screen.getByRole('checkbox', { name: /^显示已完成独立任务/ })).toBeChecked();
  });

  it('saves separate scroll positions, restores on switching and reload, and isolates another project', async () => {
    let scroll = 0;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
    vi.mocked(window.scrollTo).mockImplementation((options) => { scroll = (options as ScrollToOptions).top!; });
    let view = mount(); await screen.findByRole('tab', { name: '任务链' });
    scroll = 320; fireEvent.scroll(window); fireEvent.click(tab('standalone'));
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' });
    scroll = 540; fireEvent.scroll(window); fireEvent.click(tab('chains'));
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 320, behavior: 'instant' });
    fireEvent.click(tab('standalone')); expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 540, behavior: 'instant' });
    expect(JSON.parse(window.localStorage.getItem(key('task-view-scroll'))!)).toEqual({ chains: 320, standalone: 540 });
    cleanup(); view = mount(); await screen.findByRole('tab', { name: '独立任务' });
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 540, behavior: 'instant' });
    view.rerender(<ProjectPage projectId={otherProject} />); selectTasks(); await screen.findByRole('heading', { name: otherProject });
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' });
  });

  it('distinguishes absent categories, hidden completed rows and an entirely empty project', async () => {
    graphRequest.mockResolvedValueOnce(snapshot([seed('00000000-0000-4000-8000-000000000004', 'done')])).mockResolvedValueOnce(resetSnapshot(snapshot([])));
    mount(); await screen.findByRole('heading', { name: '暂无任务链' });
    expectUnfinishedCounts(0, 0);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(tab('standalone')); expect(await screen.findByRole('heading', { name: '所有独立任务已完成' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '显示已完成独立任务' }));
    expect(screen.getByRole('checkbox')).toHaveFocus(); expect(row('00000000-0000-4000-8000-000000000004')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '刷新' })); await screen.findByRole('heading', { name: '还没有任务' });
    expect(screen.queryByRole('tab', { name: '任务链' })).toBeNull(); expect(screen.getByRole('tab', { name: '任务列表' })).toHaveAttribute('aria-selected', 'true'); expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('keeps details when refresh adds an edge and returns focus to the active category tab when its row vanishes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    graphRequest.mockResolvedValueOnce(snapshot([seed(canonicalTask(3))])).mockResolvedValueOnce(snapshot([seed(canonicalTask(3)), seed(canonicalTask(4), 'todo', [canonicalTask(3)])]));
    mount(); await screen.findByRole('tab', { name: '独立任务' }); const { trigger, dialog } = await openStandalone(canonicalTask(3));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await screen.findByRole('heading', { name: '暂无独立任务' });
    expectUnfinishedCounts(2, 0);
    expect(trigger.isConnected).toBe(false); expect(dialog).toBeVisible();
    expect(getTask).toHaveBeenCalledOnce();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(tab('standalone')).toHaveFocus());
    fireEvent.click(tab('chains'));
    expect(chainRow(canonicalTask(3))).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByTestId('graph-node')).toBeNull();
  });

  it('keeps details while refresh removes an edge and falls back to the still-active chain tab', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    graphRequest.mockResolvedValueOnce(snapshot([seed(canonicalTask(1)), seed(canonicalTask(2), 'todo', [canonicalTask(1)])])).mockResolvedValueOnce(snapshot([seed(canonicalTask(1)), seed(canonicalTask(2))]));
    mount(); fireEvent.click(await openChain());
    await waitFor(() => expect(document.querySelector('.task-detail-dialog')).toBeVisible());
    const dialog = document.querySelector<HTMLElement>('.task-detail-dialog')!;
    await within(dialog).findByRole('heading', { name: `任务 ${canonicalTask(1)}` });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await screen.findByRole('heading', { name: '暂无任务链' }); expect(dialog).toBeVisible();
    expectUnfinishedCounts(0, 2);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); await waitFor(() => expect(tab('chains')).toHaveFocus());
    fireEvent.click(tab('standalone')); expect(row(canonicalTask(1))).toBeVisible(); expect(row(canonicalTask(2))).toBeVisible();
  });
});

const newPreferences = [
  ['task-view', '"invalid"', /^浏览器保存的任务页签无效/],
  ['completed-standalone-tasks', '{}', /^浏览器保存的已完成独立任务显示偏好无效/],
  ['task-view-scroll', '{"chains":-1,"standalone":0}', /^浏览器保存的任务浏览位置无效/],
] as const;

describe('task view storage failures', () => {
  it.each(newPreferences)('rejects invalid %s data while preserving usable defaults', async (kind, value, notice) => {
    window.localStorage.setItem(key(kind), value); mount(); await screen.findByRole('tab', { name: '任务链' });
    expect(screen.getByText(notice)).toBeVisible(); expect(tab('chains')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tab('standalone')); expect(row('00000000-0000-4000-8000-000000000003')).toBeVisible();
  });

  it('reports each unreadable preference independently and keeps all controls usable', async () => {
    const read = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
      if (newPreferences.some(([kind]) => name === key(kind))) throw new DOMException('Denied', 'SecurityError');
      return read.call(this, name);
    });
    mount(); await screen.findByRole('tab', { name: '任务链' });
    expect(screen.getByText(/^无法读取浏览器保存的任务页签/)).toBeVisible();
    expect(screen.getByText(/^无法读取浏览器保存的已完成独立任务显示偏好/)).toBeVisible();
    expect(screen.getByText(/^无法读取浏览器保存的任务浏览位置/)).toBeVisible();
    fireEvent.click(tab('standalone')); fireEvent.click(screen.getByRole('checkbox'));
    expect(row('00000000-0000-4000-8000-000000000004')).toBeVisible();
  });

  it('applies choices after failed writes and clears each write notice when persistence recovers', async () => {
    let scroll = 0; vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
    const write = Storage.prototype.setItem;
    const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
      if (newPreferences.some(([kind]) => name === key(kind))) throw new DOMException('Full', 'QuotaExceededError');
      write.call(this, name, value);
    });
    mount(); await screen.findByRole('tab', { name: '任务链' });
    scroll = 100; fireEvent.scroll(window); fireEvent.click(tab('standalone')); fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText(/^任务页签无法保存到浏览器/)).toBeVisible();
    expect(screen.getByText(/^任务浏览位置无法保存到浏览器/)).toBeVisible();
    expect(screen.getByText(/^已完成独立任务显示偏好无法保存到浏览器/)).toBeVisible(); expect(row('00000000-0000-4000-8000-000000000004')).toBeVisible();
    fail.mockRestore(); scroll = 200; fireEvent.scroll(window); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(tab('chains'));
    expect(screen.queryByText(/^任务页签无法保存到浏览器/)).toBeNull();
    expect(screen.queryByText(/^任务浏览位置无法保存到浏览器/)).toBeNull();
    expect(screen.queryByText(/^已完成独立任务显示偏好无法保存到浏览器/)).toBeNull();
  });
});


describe('project overview and task workspace', () => {
  const mountOverview = () => {
    if (!root.isConnected) document.body.append(root);
    return render(<ProjectPage projectId={project} />, { container: root });
  };
  const sectionTab = (section: 'overview' | 'tasks') => within(screen.getByRole('tablist', { name: '项目视图' })).getByRole('tab', { name: section === 'overview' ? '概览' : '任务列表' });

  it('defaults to Overview and restores Tasks directly on remount with its separate scroll position', async () => {
    window.localStorage.setItem(key('task-view-scroll'), JSON.stringify({ chains: 320, standalone: 540 }));
    let scroll = 80;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
    vi.mocked(window.scrollTo).mockImplementation((options) => { scroll = (options as ScrollToOptions).top!; });
    mountOverview();
    await screen.findByRole('heading', { name: project });
    expect(sectionTab('overview')).toHaveAttribute('aria-selected', 'true');
    expect(window.localStorage.getItem(key('project-section'))).toBeNull();
    expect(screen.getByRole('region', { name: '项目任务统计' })).toBeVisible();
    expect(screen.queryByRole('tab', { name: '任务链' })).toBeNull();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(scroll).toBe(0);
    scroll = 90; fireEvent.scroll(window); fireEvent(window, new Event('pagehide'));
    expect(JSON.parse(window.localStorage.getItem(key('task-view-scroll'))!)).toEqual({ chains: 320, standalone: 540 });
    fireEvent.click(sectionTab('tasks'));
    const chain = await findChainRow();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(scroll).toBe(320);
    scroll = 400; fireEvent.scroll(window);
    fireEvent.click(sectionTab('overview'));
    expect(scroll).toBe(90);
    expect(chain.isConnected).toBe(true);
    expect(chain).not.toBeVisible();
    expect(document.getElementById('project-section-panel-tasks')).toHaveAttribute('inert');
    scroll = 120; fireEvent.scroll(window); fireEvent(window, new Event('pagehide'));
    expect(JSON.parse(window.localStorage.getItem(key('task-view-scroll'))!)).toEqual({ chains: 400, standalone: 540 });
    fireEvent.click(sectionTab('tasks'));
    expect(await findChainRow()).toBe(chain);
    expect(scroll).toBe(400);
    fireEvent.click(sectionTab('tasks'));
    expect(graphRequest).toHaveBeenCalledOnce();
    cleanup();
    mountOverview();
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('heading', { name: project });
    expect(await findChainRow()).toBeVisible();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(scroll).toBe(400);
  });

  it('mounts a task workspace only after its first visible usable snapshot', async () => {
    let resolve!: (value: TaskGraph) => void;
    let scroll = 64;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
    vi.mocked(window.scrollTo).mockImplementation((options) => { scroll = (options as ScrollToOptions).top!; });
    graphRequest.mockReturnValueOnce(new Promise<TaskGraph>((done) => { resolve = done; }));
    mountOverview();
    fireEvent.click(sectionTab('tasks'));
    fireEvent.click(sectionTab('overview'));
    await act(async () => { resolve(snapshot()); });
    await screen.findByRole('heading', { name: project });
    expect(scroll).toBe(0);
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(screen.queryByRole('tab', { name: '任务链', hidden: true })).toBeNull();
    fireEvent.click(sectionTab('tasks'));
    expect(await findChainRow()).toBeVisible();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(graphRequest).toHaveBeenCalledOnce();
  });

  it('updates Overview from the same synchronization while Tasks are hidden and clears private children on trusted removal', async () => {
    graphRequest.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot([...seeds, seed(canonicalTask(9))]))
      .mockRejectedValueOnce(new ApiError('server', 404, 'not_found', 'missing-project')).mockResolvedValueOnce(snapshot());
    mountOverview();
    await screen.findByRole('heading', { name: project });
    fireEvent.click(sectionTab('tasks'));
    const chain = await findChainRow();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    fireEvent.click(sectionTab('overview'));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(screen.getByRole('region', { name: '项目任务统计' }).querySelector('.stat-number')).toHaveTextContent('6'));
    expect(chainRow()).toBe(chain);
    expect(chain).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('heading', { name: '项目不存在' });
    expect(chain.isConnected).toBe(false);
    expect(screen.queryByRole('tab', { name: '任务链', hidden: true })).toBeNull();
    expect(screen.queryByRole('region', { name: '项目任务统计', hidden: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByRole('heading', { name: project });
    expect(screen.queryByTestId('graph-node')).toBeNull();
    fireEvent.click(sectionTab('tasks'));
    expect(await findChainRow()).toBeVisible();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(graphRequest).toHaveBeenCalledTimes(4);
  });

  it('returns detail focus to the visible outer view instead of a retained hidden task trigger', async () => {
    mountOverview();
    await screen.findByRole('heading', { name: project });
    fireEvent.click(sectionTab('tasks'));
    const { trigger, dialog } = await openStandalone(canonicalTask(3));
    fireEvent.click(sectionTab('overview'));
    expect(trigger.isConnected).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(sectionTab('overview')).toHaveFocus());
    expect(trigger).not.toHaveFocus();
    expect(screen.getByRole('region', { name: '项目任务统计' })).toBeVisible();
  });

  it('keeps each project selection independent and restores a saved Overview on remount', async () => {
    graphRequest.mockImplementation(async (id) => snapshot([], id));
    const view = mountOverview();
    await screen.findByRole('heading', { name: project });
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    fireEvent.click(sectionTab('tasks'));
    expect(screen.getByRole('heading', { name: '还没有任务' })).toBeVisible();
    view.rerender(<ProjectPage projectId={otherProject} />);
    await screen.findByRole('heading', { name: otherProject });
    expect(sectionTab('overview')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('heading', { name: '还没有任务' })).toBeNull();
    expect(screen.getByRole('region', { name: '项目任务统计' })).toBeVisible();
    expect(window.localStorage.getItem(key('project-section', otherProject))).toBeNull();
    view.rerender(<ProjectPage projectId={project} />);
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('heading', { name: project });
    expect(screen.getByRole('heading', { name: '还没有任务' })).toBeVisible();
    fireEvent.click(sectionTab('overview'));
    expect(window.localStorage.getItem(key('project-section'))).toBe('"overview"');
    cleanup();
    mountOverview();
    expect(sectionTab('overview')).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('heading', { name: project });
    expect(screen.queryByRole('heading', { name: '还没有任务' })).toBeNull();
  });

  it.each(['"standalone"', 'null', '{}', '["tasks"]', 'tasks'])('rejects invalid outer section %s and remains usable', async (value) => {
    window.localStorage.setItem(key('project-section'), value);
    mountOverview();
    expect(sectionTab('overview')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/^浏览器保存的项目视图无效，已默认显示概览/)).toBeVisible();
    await screen.findByRole('heading', { name: project });
    fireEvent.click(sectionTab('tasks'));
    expect(await findChainRow()).toBeVisible();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(window.localStorage.getItem(key('project-section'))).toBe('"tasks"');
    cleanup();
    mountOverview();
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText(/^浏览器保存的项目视图无效/)).toBeNull();
    await screen.findByRole('heading', { name: project });
  });

  it('reports an unreadable outer section and recovers from the next successful read', async () => {
    window.localStorage.setItem(key('project-section'), '"tasks"');
    const read = Storage.prototype.getItem;
    const failedRead = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
      if (name === key('project-section')) throw new DOMException('Denied', 'SecurityError');
      return read.call(this, name);
    });
    mountOverview();
    expect(sectionTab('overview')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/^无法读取浏览器保存的项目视图/)).toBeVisible();
    await screen.findByRole('heading', { name: project });
    fireEvent.click(sectionTab('tasks'));
    expect(await findChainRow()).toBeVisible();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    failedRead.mockRestore();
    cleanup();
    mountOverview();
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText(/^无法读取浏览器保存的项目视图/)).toBeNull();
    await screen.findByRole('heading', { name: project });
  });

  it('keeps the current outer section after a failed write and clears its notice after a successful save', async () => {
    const write = Storage.prototype.setItem;
    const failedWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
      if (name === key('project-section')) throw new DOMException('Full', 'QuotaExceededError');
      write.call(this, name, value);
    });
    mountOverview();
    await screen.findByRole('heading', { name: project });
    fireEvent.click(sectionTab('tasks'));
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    expect(await findChainRow()).toBeVisible();
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(screen.getByText(/^项目视图无法保存到浏览器/)).toBeVisible();
    expect(window.localStorage.getItem(key('project-section'))).toBeNull();
    failedWrite.mockRestore();
    fireEvent.click(sectionTab('overview'));
    expect(screen.queryByText(/^项目视图无法保存到浏览器/)).toBeNull();
    expect(window.localStorage.getItem(key('project-section'))).toBe('"overview"');
    fireEvent.click(sectionTab('tasks'));
    cleanup();
    mountOverview();
    expect(sectionTab('tasks')).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('heading', { name: project });
  });
});
