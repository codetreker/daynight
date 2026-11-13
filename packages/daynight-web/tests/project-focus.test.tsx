import { taskSyncReadFixture, createGraphSyncFixture } from "./helpers/taskSync";
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createLocaleRender } from './helpers/renderWithLocale';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTask, getTaskSync } from '../src/api/client';
import type { GraphTask, TaskGraph } from '../src/api/types';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { buildGraphIndex, projectChain, type GraphIndex } from '../src/features/task-graph/model';
import { focusProjectList } from '../src/features/projects/project-list-focus';
import type { RefObject } from 'react';

const localeRender = createLocaleRender('zh-CN');
const render: typeof localeRender = (ui, options) => localeRender(ui, { ...options, taskCache: true });

vi.mock('../src/api/client', async (original) => { const actual = await original<typeof import('../src/api/client')>(); const { fixtureTaskEpoch } = await import('./helpers/taskSync'); const read = vi.fn(); return { ...actual, getTask: read, getTaskObservation: async (...args: Parameters<typeof actual.getTask>) => ({ detail: await read(...(args[4] === undefined ? args.slice(0, 4) : args)), epoch: fixtureTaskEpoch(args[0]) }), getTaskSync: vi.fn(),
  listAttachments: vi.fn(async () => ({ items: [], nextCursor: null })), }; });
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
const task = (id: string, titlePreview: string, dependsOn: readonly string[] = []): GraphTask => ({ type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, cancelledAt: null,
  id, titlePreview, titleTruncated: false, status: 'todo', dependsOn, blockedBy: dependsOn,
  ready: dependsOn.length === 0, createdAt: timestamp, updatedAt: timestamp,
});
const remaining = task(remainingId, '保留任务链');
const remainingChain = [remaining, task('20000000-0000-0000-0000-000000000004', '保留后续任务', [remainingId])];
const graph = (tasks = [task(rootId, '原任务链'), task(selectedId, '所选任务', [rootId]), ...remainingChain]): TaskGraph => ({ observedAt: "2026-10-20T12:00:00Z",
  project: { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, id: projectId, name: '核心项目', repoUrl: 'https://github.com/example/repo', createdAt: timestamp, updatedAt: timestamp },
  tasks,
  summary: { proposed: 0,
    total: tasks.length, todo: tasks.filter((item) => item.status === 'todo').length, done: tasks.filter((item) => item.status === 'done').length, cancelled: 0, inProgress: tasks.filter((item) => item.status === 'in_progress').length,
    ready: tasks.filter((item) => item.ready).length, blocked: tasks.filter((item) => item.status === 'todo' && !item.ready).length,
  },
});
const graphRequest = vi.fn<(projectId: string, signal: AbortSignal) => Promise<TaskGraph>>();
const detailRequest = vi.mocked(getTask);
let root: HTMLDivElement;
let previousOverflow: string;

const replacementEpochs = new WeakMap<TaskGraph, string>();
const resetSnapshot = (value: TaskGraph): TaskGraph => { replacementEpochs.set(value, crypto.randomUUID()); return value; };
const syncFixture = createGraphSyncFixture({ propertiesForTask: () => ({ pullRequests: [] }) });
const servedGraphs = new Map<string, TaskGraph>();
const servedVersions = new Map<string, bigint>();
beforeEach(() => {
  window.history.replaceState(null, "", `/projects/${projectId}`);
  syncFixture.reset();
  servedGraphs.clear(); servedVersions.clear();
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (projectId, query, _userId, signal) => {
    const value = await graphRequest(projectId, signal);
    const sync = syncFixture.toSync(value, query, replacementEpochs.get(value));
    servedGraphs.set(projectId, value);
    for (const task of sync.tasks) servedVersions.set(`${projectId}/${task.id}`, task.version);
    return taskSyncReadFixture(sync);
  });
});

beforeEach(() => {
  root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'scroll';
  graphRequest.mockReset().mockImplementation(async (id) => servedGraphs.get(id)!);
  detailRequest.mockReset();
  detailRequest.mockImplementation(async (project, id) => {
    const task = servedGraphs.get(project)!.tasks.find((item) => item.id === id)!;
    const blockedBy = task.blockedBy.length === 0 ? task.dependsOn : [];
    return { ...task, tags: [], id, projectId: project, title: task.titlePreview, description: '', properties: { pullRequests: [] }, version: servedVersions.get(`${project}/${id}`)!,
      blockedBy, ready: task.status === 'todo' && blockedBy.length === 0 };
  });
});

afterEach(() => {
  cleanup();
  root.remove();
  document.body.style.overflow = previousOverflow;
});

const openDialog = async (fullscreen = false, filterTodo = false) => {
  render(<ProjectPage projectId={projectId} />, { container: root });
  fireEvent.click(screen.getByRole('tab', { name: '任务列表' }));
  await waitFor(() => expect(document.getElementById(`task-chain-graph-${rootId}`)).toBeVisible());
  if (filterTodo) fireEvent.change(screen.getByRole('combobox', { name: '状态' }), { target: { value: 'todo' } });
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
  it('uses the visible Goal of a historical graph witness when there is no runtime opener', () => {
    const goalId = '30000000-0000-0000-0000-000000000001';
    const index = buildGraphIndex(graph([{ ...task(rootId, '原任务链'), parentId: goalId }]));
    root.innerHTML = `<section id="project-goal-list" tabindex="-1"><div data-goal-id="${goalId}"><button class="goal-list-toggle">展开</button></div></section>`;
    const toggle = root.querySelector<HTMLButtonElement>('.goal-list-toggle')!;
    const target = { kind: 'chain' as const, witnessTaskId: rootId, rootId };
    expect(focusProjectList('goals', null, target, index)).toBe(true);
    expect(toggle).toHaveFocus();
    toggle.closest('[data-goal-id]')!.remove();
    expect(focusProjectList('goals', null, target, index)).toBe(true);
    expect(root.querySelector('#project-goal-list')).toHaveFocus();
  });
  it('restores a historical Goal member when its opener is no longer retained, then uses visible fallbacks', () => {
    const goalId = '30000000-0000-0000-0000-000000000001';
    const index = buildGraphIndex(graph([{ ...task(rootId, '原任务'), parentId: goalId }]));
    root.innerHTML = `<section id="project-goal-list" tabindex="-1"><div data-goal-id="${goalId}"><button class="goal-list-toggle">展开</button><button id="chain-task-goal-${goalId}-${rootId}">任务</button></div></section>`;
    const entry = root.querySelector<HTMLButtonElement>(`[id="chain-task-goal-${goalId}-${rootId}"]`)!;
    const toggle = root.querySelector<HTMLButtonElement>('.goal-list-toggle')!;
    expect(focusProjectList('goals', null, null, index, null, rootId)).toBe(true);
    expect(entry).toHaveFocus();
    entry.hidden = true;
    expect(focusProjectList('goals', null, null, index, null, rootId)).toBe(true);
    expect(toggle).toHaveFocus();
    toggle.closest('[data-goal-id]')!.remove();
    expect(focusProjectList('goals', null, null, index, null, rootId)).toBe(true);
    expect(root.querySelector('#project-goal-list')).toHaveFocus();
  });

  it('restores focus to the graph trigger on Back and opens the detail on Forward', async () => {
    graphRequest.mockResolvedValue(graph());
    const { trigger } = await openDialog();
    act(() => history.back());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '所选任务' })).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    act(() => history.forward());
    const restored = await screen.findByRole('dialog', { name: '所选任务' });
    expect(within(restored).getByRole('button', { name: '关闭任务详情' })).toHaveFocus();
  });

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

  it('retires the old graph and restores focus when history replacement removes the selected node', async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(resetSnapshot(graph([task(rootId, '原任务链'), task('20000000-0000-0000-0000-000000000005', '保留图节点', [rootId]), ...remainingChain])));
    const { trigger, dialog } = await openDialog(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    await waitFor(() => expect(document.getElementById(`task-root-${remainingId}`)).toHaveFocus());
    expect(trigger.isConnected).toBe(false);
    expect(document.querySelector('.task-detail-dialog')).toBeNull();
    expect(document.querySelector('.task-chain-dialog')).toBeNull();
    expectModalReleased();
  });

  it('keeps scrolling locked when a Goal split unmounts its fullscreen graph while task details remain open', async () => {
    const split = [task(rootId, '原任务链'), task(selectedId, '所选任务')];
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph([...split, ...remainingChain]));
    const { trigger, dialog } = await openDialog(true, true);
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    await waitFor(() => expect(trigger.isConnected).toBe(false));
    expect(document.querySelector('.task-chain-dialog-fullscreen')).toBeNull();
    expect(document.querySelector('.task-chain-dialog')).toBeNull();
    expect(dialog).toBeVisible();
    expect(root).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(document.getElementById(`task-root-${remainingId}`)!).toHaveFocus());
    expectModalReleased();
  });

  it.each([true, false])('retains both dialog layers when completion filters their Goal from the list and restores visible focus (remaining=%s)', async (keepRemaining) => {
    const completed = [task(rootId, '原任务链'), task(selectedId, '所选任务', [rootId])].map((item) => ({
      ...item, status: 'done' as const, ready: false, blockedBy: [],
    }));
    const initial = [task(rootId, '原任务链'), task(selectedId, '所选任务', [rootId]), ...(keepRemaining ? remainingChain : [])];
    graphRequest.mockResolvedValueOnce(graph(initial)).mockResolvedValueOnce(graph([...completed, ...(keepRemaining ? remainingChain : [])]));
    const { trigger, dialog } = await openDialog(false, true);
    const graphDialog = document.querySelector<HTMLElement>('.task-chain-dialog')!;
    const graphClose = graphDialog.querySelector<HTMLButtonElement>('.task-chain-close')!;
    const listOpener = document.getElementById(`task-chain-graph-${rootId}`)!;
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    await waitFor(() => expect(listOpener.isConnected).toBe(false));
    expect(trigger.isConnected).toBe(true);
    expect(dialog).toBeVisible();
    expect(document.querySelector('.task-chain-dialog')).toBe(graphDialog);
    expect(document.getElementById(`task-root-${rootId}`)).toBeNull();
    expect(within(dialog).getByRole('button', { name: '关闭任务详情' })).toHaveFocus();
    expect(root).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.querySelector('.task-chain-dialog')).toBe(graphDialog);
    expect(root).toHaveAttribute('inert');
    expect(graphDialog).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(graphClose);
    await waitFor(() => expect(document.getElementById(keepRemaining ? `task-root-${remainingId}` : 'project-chain-list')).toHaveFocus());
    expectModalReleased();
    expect(screen.getByRole('combobox', { name: '状态' })).toHaveValue('todo');
    if (!keepRemaining) {
      fireEvent.change(await screen.findByRole('combobox', { name: '状态' }), { target: { value: 'all' } });
      expect(document.getElementById(`task-chain-graph-${rootId}`)).toHaveAttribute('aria-haspopup', 'dialog');
      expect(document.querySelector('.task-chain-dialog')).toBeNull();
    }
  });

  it('focuses the outer task tab after refresh removes the selected chain and every task', async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(resetSnapshot(graph([])));
    const { trigger, dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    await screen.findByRole('heading', { name: '暂无任务链' });
    await waitFor(() => expect(screen.getByRole('tab', { name: '任务链' })).toHaveFocus());
    expect(trigger.isConnected).toBe(false);
    expectModalReleased();
    expect(screen.getByText('所选任务已不在新的任务图中，详情已关闭。')).toBeVisible();
    expect(within(screen.getByRole('region', { name: '项目任务统计', hidden: true })).getAllByText('0', { selector: '.stat-number' })).toHaveLength(7);
    expect(screen.getByRole('region', { name: '任务依赖链' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Goal' })).toBeVisible();
  });

  it('focuses a surviving row without opening its graph after refresh removes the selected chain', async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(resetSnapshot(graph(remainingChain)));
    const { trigger, dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    await waitFor(() => expect(document.getElementById(`task-root-${remainingId}`)).toBeVisible());
    await waitFor(() => expect(document.getElementById(`task-root-${remainingId}`)).toHaveFocus());
    expect(trigger.isConnected).toBe(false);
    expect(document.getElementById(`task-root-${remainingId}`)).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.task-chain-dialog')).toBeNull();
    expectModalReleased();
  });

  it('returns focus to a surviving task when the dialog closes normally', async () => {
    graphRequest.mockResolvedValueOnce(graph());
    const { trigger, dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(root).toHaveAttribute('inert');
    expect(document.querySelector('.task-chain-dialog')).toBeVisible();
    expect(document.querySelector('.task-chain-dialog')).not.toHaveAttribute('inert');
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
