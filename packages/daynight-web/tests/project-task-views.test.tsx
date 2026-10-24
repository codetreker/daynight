import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createLocaleRender } from './helpers/renderWithLocale';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTask, getTaskGraph } from '../src/api/client';
import type { GraphTask, TaskGraph } from '../src/api/types';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import type { GraphIndex } from '../src/features/task-graph/model';

const render = createLocaleRender('zh-CN');

vi.mock('../src/api/client', async (original) => ({
  ...await original<typeof import('../src/api/client')>(), getTask: vi.fn(), getTaskGraph: vi.fn(),
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
const seeds = [seed('A', 'done'), seed('B', 'todo', ['A']), seed('C'), seed('D', 'done'), seed('E', 'in_progress')];
const snapshot = (items = seeds, id = project): TaskGraph => {
  const tasks = items.map((item) => {
    const blockedBy = item.dependsOn.filter((dependency) => items.find((candidate) => candidate.id === dependency)!.status !== 'done');
    return { ...item, blockedBy, ready: item.status === 'todo' && blockedBy.length === 0 };
  });
  return { observedAt: "2026-10-20T12:00:00Z", project: { settings: { version: 1n, executionWarningMinutes: 60 }, id, name: id, repoUrl: '', createdAt: timestamp, updatedAt: timestamp }, tasks,
    summary: { total: tasks.length, todo: tasks.filter((item) => item.status === 'todo').length,
      done: tasks.filter((item) => item.status === 'done').length, inProgress: tasks.filter((item) => item.status === 'in_progress').length,
      ready: tasks.filter((item) => item.ready).length, blocked: tasks.filter((item) => item.status === 'todo' && !item.ready).length } };
};
const graphRequest = vi.mocked(getTaskGraph);
const tab = (view: 'chains' | 'standalone') => screen.getByRole('tab', { name: view === 'chains' ? '任务链' : '独立任务' });
const expectUnfinishedCounts = (chains: number, standalone: number) => {
  expect(tab('chains').querySelector('.graph-count-pill')).toHaveTextContent(new RegExp(`^${chains}$`));
  expect(tab('standalone').querySelector('.graph-count-pill')).toHaveTextContent(new RegExp(`^${standalone}$`));
};
const row = (id: string) => document.getElementById(`standalone-task-${id}`)!;
const key = (kind: string, id = project) => `daynight:${kind}:${id}`;
let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  graphRequest.mockReset(); graphRequest.mockImplementation(async (id) => snapshot(seeds, id));
  vi.mocked(getTask).mockReset();
  vi.mocked(getTask).mockImplementation(async (projectId, id) => ({ requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null,
    id, projectId, title: `详情 ${id}`, description: '', properties: { worker: null, pullRequests: [] }, status: 'todo', version: 1n, dependsOn: [], blockedBy: [], ready: true,
    createdAt: timestamp, updatedAt: timestamp,
  }));
});
afterEach(() => { cleanup(); root.remove(); });
const mount = () => {
  if (!root.isConnected) document.body.append(root);
  return render(<ProjectPage projectId={project} />, { container: root });
};

const openStandalone = async (id: string) => {
  fireEvent.click(tab('standalone'));
  const trigger = row(id); trigger.focus(); fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog');
  await within(dialog).findByRole('heading', { name: `详情 ${id}` });
  return { trigger, dialog };
};

describe('project task views', () => {
  it('shows waiting tasks in unfinished counts, chain summaries, statistics and standalone rows', async () => {
    graphRequest.mockResolvedValue(snapshot([
      seed('A', 'todo'), seed('B', 'todo', ['A', 'C']), seed('C'), seed('D', 'todo'),
      seed('E', 'done'), seed('F', 'todo', ['E']), seed('G', 'done'),
    ]));
    mount(); await screen.findByRole('tab', { name: '任务链' });
    expectUnfinishedCounts(4, 1);
    const stats = screen.getByRole('region', { name: '项目任务统计' });
    expect(stats.querySelectorAll('.stat')).toHaveLength(6);
    expect(stats).toHaveTextContent('待处理5等待开始');
    expect(document.getElementById('task-root-A')?.querySelector('.root-status')).toHaveTextContent('待处理');
    expect(document.getElementById('task-root-A')?.querySelector('.root-progress-label')).toHaveTextContent('0/3 已完成');
    expect(document.getElementById('task-root-C')).toBeNull();
    expect(document.getElementById('task-root-E')?.querySelector('.root-status')).toHaveTextContent('进行中');
    fireEvent.click(tab('standalone'));
    expect(row('D')).toHaveTextContent('待处理');
    expect(row('D').querySelector('.root-status')).toHaveClass('graph-status-todo');
    expect(row('D')).toHaveTextContent('可开始');
    expect(document.getElementById('standalone-task-G')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '显示已完成独立任务（1）' }));
    expect(row('G')).toBeVisible();
    expectUnfinishedCounts(4, 1);
  });

  it('shows confirmed platform requirements in standalone rows without changing readiness', async () => {
    graphRequest.mockResolvedValue(snapshot(seeds.map((task) => ({ ...task, requiredPlatform: task.id === 'C' ? 'linux' : task.id === 'E' ? 'windows' : null }))));
    mount(); await screen.findByRole('tab', { name: '独立任务' }); fireEvent.click(tab('standalone'));
    expect(row('C').querySelector('.task-platform')).toHaveTextContent('Linux');
    expect(row('E').querySelector('.task-platform')).toHaveTextContent('Windows');
    expect(row('C')).toHaveTextContent('可开始'); expect(row('E')).toHaveTextContent('进行中');
  });

  it('classifies complete dependencies independently from status and keeps summary and API order intact', async () => {
    const complete = snapshot(); graphRequest.mockResolvedValue(complete);
    mount(); await screen.findByRole('tab', { name: '任务链' });
    expect(tab('chains')).toHaveAttribute('aria-selected', 'true');
    expectUnfinishedCounts(1, 2);
    expect(document.querySelectorAll('.root-toggle')).toHaveLength(1);
    expect(document.getElementById('task-root-A')).toBeVisible();
    expect(screen.getByLabelText('显示 1 条，共 1 条任务链')).toHaveTextContent('1 / 1');
    fireEvent.click(tab('standalone'));
    expect([...document.querySelectorAll('.standalone-row')].map((item) => item.id)).toEqual(['standalone-task-E', 'standalone-task-C']);
    expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(row('C')).toHaveTextContent('可开始'); expect(row('E')).toHaveTextContent('进行中');
    expect(document.getElementById('standalone-task-B')).toBeNull();
    expect(screen.getByRole('checkbox', { name: '显示已完成独立任务（1）' })).not.toBeChecked();
    expect(within(screen.getByRole('region', { name: '项目任务统计' })).getByText('5')).toBeVisible();
    expect(complete.tasks.map(({ id }) => id)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(graphRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps an externally blocked singleton outside ordinary chains', async () => {
    graphRequest.mockResolvedValue(snapshot([
      seed('A'), seed('B', 'todo', ['A'], ['A']),
    ]));
    mount(); await screen.findByRole('tab', { name: '任务链' });
    expect(screen.getByRole('heading', { name: '暂无任务链' })).toBeVisible();
    expectUnfinishedCounts(0, 2);
    fireEvent.click(tab('standalone'));
    expect(row('A')).toBeVisible(); expect(row('B')).toBeVisible();
    expect(row('A').querySelector('.task-ready')).toHaveTextContent('可开始');
    expect(row('B').querySelector('.graph-blocked-badge')).toHaveTextContent('被阻塞');
    expect(row('B').querySelector('.task-ready')).toBeNull();
    expect(row('B').querySelector('.root-status')).toHaveTextContent('待处理');
  });

  it('counts unfinished tasks once across ordinary components and keeps both counts independent of visible rows', async () => {
    graphRequest.mockResolvedValue(snapshot([
      seed('A', 'done'), seed('B', 'done'), seed('C', 'in_progress', ['A', 'B']), seed('D', 'todo', ['C']),
      seed('E'), seed('F', 'todo', ['E']), seed('G'), seed('H', 'in_progress'), seed('I', 'done'),
      seed('J', 'done'), seed('K', 'done', ['J']),
    ]));
    mount(); await screen.findByRole('tab', { name: '任务链' });
    expectUnfinishedCounts(4, 2);
    expect(tab('chains').querySelector('.graph-count-pill')).toHaveAttribute('title', '未完成任务数');
    expect(document.querySelectorAll('.root-toggle')).toHaveLength(2);
    expect(document.getElementById('task-root-A')).toBeVisible();
    expect(document.getElementById('task-root-B')).toBeNull();
    expect(document.getElementById('task-root-J')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '显示已完成任务链（1）' }));
    expect(document.querySelectorAll('.root-toggle')).toHaveLength(3);
    expectUnfinishedCounts(4, 2);
    fireEvent.click(tab('standalone'));
    expect([...document.querySelectorAll('.standalone-row')].map((item) => item.id)).toEqual(['standalone-task-H', 'standalone-task-G']);
    expect(tab('standalone').querySelector('.graph-count-pill')).toHaveAttribute('title', '未完成任务数');
    fireEvent.click(screen.getByRole('checkbox', { name: '显示已完成独立任务（1）' }));
    expect(row('I')).toBeVisible();
    expectUnfinishedCounts(4, 2);
    fireEvent.click(tab('chains'));
    expectUnfinishedCounts(4, 2);
    expect(graphRequest).toHaveBeenCalledTimes(1);
  });

  it('shows zero unfinished tasks for completed chains and standalone tasks with either filter setting', async () => {
    graphRequest.mockResolvedValue(snapshot([seed('A', 'done'), seed('B', 'done', ['A']), seed('D', 'done')]));
    mount(); await screen.findByRole('heading', { name: '所有任务链已完成' });
    expectUnfinishedCounts(0, 0);
    fireEvent.click(screen.getByRole('button', { name: '显示已完成任务链' }));
    expect(document.getElementById('task-root-A')).toBeVisible();
    expectUnfinishedCounts(0, 0);
    fireEvent.click(tab('standalone'));
    expect(screen.getByRole('heading', { name: '所有独立任务已完成' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '显示已完成独立任务' }));
    expect(row('D')).toBeVisible();
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
    expect(row('C')).toBeVisible(); expect(row('E')).toBeVisible();
    expectUnfinishedCounts(1, 2);
    await act(async () => { resolve(snapshot([
      seed('A', 'done'), seed('B', 'todo', ['A']), seed('C', 'todo', ['A']), seed('D', 'done'), seed('E', 'in_progress', ['A']),
    ])); });
    expect(screen.getByRole('heading', { name: '所有独立任务已完成' })).toBeVisible();
    expect(document.getElementById('standalone-task-C')).toBeNull();
    expect(document.getElementById('standalone-task-E')).toBeNull();
    expectUnfinishedCounts(3, 0);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('heading', { name: '刷新失败' });
    expect(screen.getByRole('heading', { name: '所有独立任务已完成' })).toBeVisible();
    expectUnfinishedCounts(3, 0);
    fireEvent.click(tab('chains'));
    expect(document.getElementById('task-root-A')).toBeVisible();
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

  it('remembers each filter, selected view and explicit chain collapse across remounts and project navigation', async () => {
    let view = mount(); await screen.findByRole('tab', { name: '任务链' });
    fireEvent.click(document.getElementById('task-root-A')!);
    fireEvent.click(screen.getByRole('checkbox', { name: /^显示已完成任务链/ }));
    fireEvent.click(tab('standalone')); fireEvent.click(screen.getByRole('checkbox', { name: /^显示已完成独立任务/ }));
    expect(row('D')).toBeVisible();
    cleanup(); view = mount(); await screen.findByRole('tab', { name: '独立任务' });
    expect(tab('standalone')).toHaveAttribute('aria-selected', 'true'); expect(row('D')).toBeVisible();
    fireEvent.click(tab('chains')); expect(screen.queryByTestId('graph-node')).toBeNull();
    expect(screen.getByRole('checkbox', { name: /^显示已完成任务链/ })).toBeChecked();
    expect(JSON.parse(window.localStorage.getItem(key('project-view'))!)).toEqual({ expandedRootId: null });
    expect(window.localStorage.getItem(key('completed-chains'))).toBe('true');
    view.rerender(<ProjectPage projectId={otherProject} />); await screen.findByRole('heading', { name: otherProject });
    expect(tab('chains')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tab('standalone')); expect(screen.getByRole('checkbox', { name: /^显示已完成独立任务/ })).not.toBeChecked();
    view.rerender(<ProjectPage projectId={project} />); await screen.findByRole('heading', { name: project });
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
    view.rerender(<ProjectPage projectId={otherProject} />); await screen.findByRole('heading', { name: otherProject });
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' });
  });

  it('distinguishes absent categories, hidden completed rows and an entirely empty project', async () => {
    graphRequest.mockResolvedValueOnce(snapshot([seed('D', 'done')])).mockResolvedValueOnce(snapshot([]));
    mount(); await screen.findByRole('heading', { name: '暂无任务链' });
    expectUnfinishedCounts(0, 0);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(tab('standalone')); expect(screen.getByRole('heading', { name: '所有独立任务已完成' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '显示已完成独立任务' }));
    expect(screen.getByRole('checkbox')).toHaveFocus(); expect(row('D')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '刷新' })); await screen.findByRole('heading', { name: '还没有任务' });
    expect(screen.queryByRole('tab')).toBeNull(); expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('keeps details when refresh adds an edge and returns focus to the active category tab when its row vanishes', async () => {
    graphRequest.mockResolvedValueOnce(snapshot([seed(canonicalTask(3))])).mockResolvedValueOnce(snapshot([seed(canonicalTask(3)), seed(canonicalTask(4), 'todo', [canonicalTask(3)])]));
    mount(); await screen.findByRole('tab', { name: '独立任务' }); const { trigger, dialog } = await openStandalone(canonicalTask(3));
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    await screen.findByRole('heading', { name: '暂无独立任务' });
    expectUnfinishedCounts(2, 0);
    expect(trigger.isConnected).toBe(false); expect(dialog).toBeVisible();
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(tab('standalone')).toHaveFocus());
    fireEvent.click(tab('chains')); expect(document.getElementById(`task-root-${canonicalTask(3)}`)).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps details while refresh removes an edge and falls back to the still-active chain tab', async () => {
    graphRequest.mockResolvedValueOnce(snapshot([seed(canonicalTask(1)), seed(canonicalTask(2), 'todo', [canonicalTask(1)])])).mockResolvedValueOnce(snapshot([seed(canonicalTask(1)), seed(canonicalTask(2))]));
    mount(); fireEvent.click(await screen.findByTestId('graph-node'));
    const dialog = await screen.findByRole('dialog'); await within(dialog).findByRole('heading', { name: `详情 ${canonicalTask(1)}` });
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
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
    fireEvent.click(tab('standalone')); expect(row('C')).toBeVisible();
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
    expect(row('D')).toBeVisible();
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
    expect(screen.getByText(/^已完成独立任务显示偏好无法保存到浏览器/)).toBeVisible(); expect(row('D')).toBeVisible();
    fail.mockRestore(); scroll = 200; fireEvent.scroll(window); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(tab('chains'));
    expect(screen.queryByText(/^任务页签无法保存到浏览器/)).toBeNull();
    expect(screen.queryByText(/^任务浏览位置无法保存到浏览器/)).toBeNull();
    expect(screen.queryByText(/^已完成独立任务显示偏好无法保存到浏览器/)).toBeNull();
  });
});
