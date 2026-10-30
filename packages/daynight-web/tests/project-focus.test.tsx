import { createGraphSyncFixture } from "./helpers/taskSync";
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createLocaleRender } from './helpers/renderWithLocale';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTask, getTaskSync } from '../src/api/client';
import type { GraphTask, TaskGraph } from '../src/api/types';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { projectChain, type GraphIndex } from '../src/features/task-graph/model';
import type { RefObject } from 'react';

const localeRender = createLocaleRender('zh-CN');
const render: typeof localeRender = (ui, options) => localeRender(ui, { ...options, taskCache: true });

vi.mock('../src/api/client', async (original) => ({
  ...await original<typeof import('../src/api/client')>(), getTask: vi.fn(), getTaskSync: vi.fn(),
  listAttachments: vi.fn(async () => ({ items: [], nextCursor: null })),
}));
vi.mock('../src/features/task-graph/TaskGraph', () => ({ TaskGraph: ({ index, rootId, onOpenTask, fullscreen }: {
  index: GraphIndex; rootId: string; onOpenTask: (id: string, trigger: HTMLElement) => void;
  fullscreen?: { readonly active: boolean; readonly onToggle: () => void; readonly buttonRef: RefObject<HTMLButtonElement | null> };
}) => <div className="task-graph" key={rootId}>
  {fullscreen !== undefined && <button type="button" className="graph-fullscreen-toggle" ref={fullscreen.buttonRef} onClick={fullscreen.onToggle}>{fullscreen.active ? '退出全屏' : '全屏查看'}</button>}
  {[...projectChain(index, rootId).mainIds].map((id) => <button key={id} type="button" onClick={(event) => onOpenTask(id, event.currentTarget)}>
    节点 {index.nodes.get(id)!.titlePreview}
  </button>)}
</div> }));

const projectId = '10000000-0000-0000-0000-000000000001';
const rootId = '20000000-0000-0000-0000-000000000001';
const selectedId = '20000000-0000-0000-0000-000000000002';
const remainingId = '20000000-0000-0000-0000-000000000003';
const timestamp = '2026-10-20T12:00:00.123456Z';
const task = (id: string, titlePreview: string, dependsOn: readonly string[] = []): GraphTask => ({ requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null,
  id, titlePreview, titleTruncated: false, status: 'todo', dependsOn, blockedBy: dependsOn,
  ready: dependsOn.length === 0, createdAt: timestamp, updatedAt: timestamp,
});
const remaining = task(remainingId, '保留任务链');
const remainingChain = [remaining, task('20000000-0000-0000-0000-000000000004', '保留后续任务', [remainingId])];
const graph = (tasks = [task(rootId, '原任务链'), task(selectedId, '所选任务', [rootId]), ...remainingChain]): TaskGraph => ({ observedAt: "2026-10-20T12:00:00Z",
  project: { settings: { version: 1n, executionWarningMinutes: 60 }, id: projectId, name: '核心项目', repoUrl: 'https://github.com/example/repo', createdAt: timestamp, updatedAt: timestamp },
  tasks,
  summary: {
    total: tasks.length, todo: tasks.filter((item) => item.status === 'todo').length, done: tasks.filter((item) => item.status === 'done').length, inProgress: tasks.filter((item) => item.status === 'in_progress').length,
    ready: tasks.filter((item) => item.ready).length, blocked: tasks.filter((item) => item.status === 'todo' && !item.ready).length,
  },
});
const graphRequest = vi.fn<(projectId: string, signal: AbortSignal) => Promise<TaskGraph>>();
const detailRequest = vi.mocked(getTask);
let root: HTMLDivElement;
let previousOverflow: string;

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
  root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'scroll';
  graphRequest.mockReset();
  detailRequest.mockReset();
  detailRequest.mockImplementation(async (project, id) => {
    const task = servedGraphs.get(project)!.tasks.find((item) => item.id === id)!;
    const blockedBy = task.blockedBy.length === 0 ? task.dependsOn : [];
    return { ...task, id, projectId: project, title: task.titlePreview, description: '', properties: { pullRequests: [] }, version: servedVersions.get(`${project}/${id}`)!,
      blockedBy, ready: task.status === 'todo' && blockedBy.length === 0 };
  });
});

afterEach(() => {
  cleanup();
  root.remove();
  document.body.style.overflow = previousOverflow;
});

const openDialog = async (fullscreen = false) => {
  render(<ProjectPage projectId={projectId} />, { container: root });
  fireEvent.click(screen.getByRole('tab', { name: '任务列表' }));
  await waitFor(() => expect(document.getElementById(`task-chain-graph-${rootId}`)).toBeVisible());
  fireEvent.click(document.getElementById(`task-chain-graph-${rootId}`)!);
  if (fullscreen) fireEvent.click(screen.getByRole('button', { name: '全屏查看' }));
  const trigger = await screen.findByRole('button', { name: '节点 所选任务' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '正在加载任务详情' });
  expect(root.contains(dialog)).toBe(false);
  expect(root).toHaveAttribute('inert');
  expect(document.body.style.overflow).toBe('hidden');
  expect(within(dialog).getByRole('button', { name: '关闭任务详情' })).toHaveFocus();
  await within(dialog).findByRole('heading', { name: '所选任务' });
  return { trigger, dialog };
};

const expectModalReleased = () => {
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(root).not.toHaveAttribute('inert');
  expect(document.body.style.overflow).toBe('scroll');
};

describe('project dialog focus restoration', () => {
  it('keeps active details focused when a merge replaces the open chain representative row', async () => {
    window.localStorage.setItem(`daynight:project-view:${projectId}`, JSON.stringify({ expandedRootId: remainingId }));
    const before = [...remainingChain, task(rootId, '原任务链'), task(selectedId, '所选任务', [rootId])].map((item, position) => ({ ...item, createdAt: `2026-10-20T11:59:0${position}Z` }));
    const after = before.map((item) => item.id === selectedId ? { ...item, dependsOn: [rootId, remainingId], blockedBy: [rootId, remainingId] } : item);
    graphRequest.mockResolvedValueOnce(graph(before)).mockResolvedValueOnce(graph(after));
    const { trigger, dialog } = await openDialog();
    const close = within(dialog).getByRole('button', { name: '关闭任务详情' });
    expect(close).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    await waitFor(() => expect(document.getElementById(`task-root-${rootId}`)).toBeNull());
    expect(trigger.isConnected).toBe(false);
    expect(dialog).toBeVisible();
    expect(close).toHaveFocus();
    expect(root).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(close);
    await waitFor(() => expect(document.querySelector('.task-chain-close')).toHaveFocus());
    expect(document.querySelector('.task-chain-dialog')).toBeVisible();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(document.querySelector('.task-chain-close')!);
    await waitFor(() => expect(document.getElementById(`task-root-${remainingId}`)).toHaveFocus());
    expectModalReleased();
  });

  it('returns focus to the graph close control when refresh removes the selected node but retains its fullscreen graph', async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(resetSnapshot(graph([task(rootId, '原任务链'), task('20000000-0000-0000-0000-000000000005', '保留图节点', [rootId]), ...remainingChain])));
    const { trigger, dialog } = await openDialog(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    const fullscreen = document.querySelector<HTMLElement>('.task-chain-dialog-fullscreen')!;
    await waitFor(() => expect(fullscreen.querySelector('.task-chain-close')).toHaveFocus());
    expect(trigger.isConnected).toBe(false);
    expect(document.querySelector('.task-detail-dialog')).toBeNull();
    expect(root).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.querySelector('.task-chain-dialog-fullscreen')).toBeNull();
    expect(document.querySelector('.task-chain-dialog')).toBeVisible();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expectModalReleased();
  });

  it('keeps scrolling locked when refresh unmounts fullscreen while the dialog stays open', async () => {
    const completed = [task(rootId, '原任务链'), task(selectedId, '所选任务', [rootId])].map((item) => ({
      ...item, status: 'done' as const, ready: false, blockedBy: [],
    }));
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph([...completed, ...remainingChain]));
    const { trigger, dialog } = await openDialog(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    await waitFor(() => expect(trigger.isConnected).toBe(false));
    expect(document.querySelector('.task-chain-dialog-fullscreen')).toBeNull();
    expect(dialog).toBeVisible();
    expect(root).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(document.getElementById(`task-root-${remainingId}`)!).toHaveFocus());
    expectModalReleased();
  });

  it.each([true, false])('retains details when completion hides their chain and restores visible focus (remaining=%s)', async (keepRemaining) => {
    const completed = [task(rootId, '原任务链'), task(selectedId, '所选任务', [rootId])].map((item) => ({
      ...item, status: 'done' as const, ready: false, blockedBy: [],
    }));
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(keepRemaining ? graph([...completed, ...remainingChain]) : resetSnapshot(graph(completed)));
    const { trigger, dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    await waitFor(() => expect(trigger.isConnected).toBe(false));
    expect(dialog).toBeVisible();
    expect(document.getElementById(`task-root-${rootId}`)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(keepRemaining ? document.getElementById(`task-root-${remainingId}`)! : screen.getByRole('tab', { name: '任务链' })).toHaveFocus());
    expectModalReleased();
    const checkbox = screen.getByRole('checkbox', { name: /^显示所有/ });
    if (!keepRemaining) {
      fireEvent.click(screen.getByRole('button', { name: '显示所有' }));
      expect(checkbox).toHaveFocus();
      expect(document.getElementById(`task-chain-graph-${rootId}`)).toHaveAttribute('aria-haspopup', 'dialog');
      expect(document.querySelector('.task-chain-dialog')).toBeNull();
    }
  });

  it('focuses the outer task tab after refresh removes the selected chain and every task', async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(resetSnapshot(graph([])));
    const { trigger, dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    await screen.findByRole('heading', { name: '还没有任务' });
    await waitFor(() => expect(screen.getByRole('tab', { name: '任务列表' })).toHaveFocus());
    expect(trigger.isConnected).toBe(false);
    expectModalReleased();
    expect(screen.getByText('所选任务已不在新的任务图中，详情已关闭。')).toBeVisible();
    expect(within(screen.getByRole('region', { name: '项目任务统计', hidden: true })).getAllByText('0', { selector: '.stat-number' })).toHaveLength(6);
    expect(screen.queryByRole('region', { name: '任务依赖链' })).toBeNull();
  });

  it('focuses a surviving row without opening its graph after refresh removes the selected chain', async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(resetSnapshot(graph(remainingChain)));
    const { trigger, dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    await waitFor(() => expect(document.getElementById(`task-root-${remainingId}`)).toBeVisible());
    const remainingRoot = document.getElementById(`task-root-${remainingId}`)!;
    await waitFor(() => expect(remainingRoot).toHaveFocus());
    expect(trigger.isConnected).toBe(false);
    expect(remainingRoot).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.task-chain-dialog')).toBeNull();
    expectModalReleased();
  });

  it('returns focus to a surviving task when the dialog closes normally', async () => {
    graphRequest.mockResolvedValueOnce(graph());
    const { trigger, dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(root).not.toHaveAttribute('inert');
    expect(document.querySelector('.task-chain-dialog')).toBeVisible();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(document.querySelector('.task-chain-close')!);
    await waitFor(() => expect(document.getElementById(`task-chain-graph-${rootId}`)).toHaveFocus());
    expectModalReleased();
  });

  it('handles one Escape layer at a time from a detail menu through both fullscreen views and the graph dialog', async () => {
    graphRequest.mockResolvedValue(graph());
    const { trigger, dialog } = await openDialog(true);
    const graphDialog = document.querySelector<HTMLElement>('.task-chain-dialog-fullscreen')!;
    fireEvent.click(within(dialog).getByRole('button', { name: '更多任务操作' }));
    expect(within(dialog).getByRole('menu')).toBeVisible();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(within(dialog).queryByRole('menu')).toBeNull();
    expect(dialog).toBeVisible();
    expect(graphDialog).toHaveClass('task-chain-dialog-fullscreen');
    fireEvent.click(within(dialog).getByRole('button', { name: '进入全屏' }));
    expect(dialog).toHaveClass('task-detail-fullscreen');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(dialog).not.toHaveClass('task-detail-fullscreen');
    expect(dialog).toBeVisible();
    expect(graphDialog).toHaveClass('task-chain-dialog-fullscreen');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('.task-detail-dialog')).toBeNull());
    expect(trigger).toHaveFocus();
    expect(graphDialog).toHaveClass('task-chain-dialog-fullscreen');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(graphDialog).not.toHaveClass('task-chain-dialog-fullscreen');
    expect(graphDialog).toBeVisible();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(document.getElementById(`task-chain-graph-${rootId}`)).toHaveFocus());
    expectModalReleased();
  });

});
