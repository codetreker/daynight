import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createLocaleRender } from './helpers/renderWithLocale';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTask, getTaskGraph } from '../src/api/client';
import type { GraphTask, TaskGraph } from '../src/api/types';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { projectChain, type GraphIndex } from '../src/features/task-graph/model';

const render = createLocaleRender('zh-CN');

vi.mock('../src/api/client', async (original) => ({
  ...await original<typeof import('../src/api/client')>(), getTask: vi.fn(), getTaskGraph: vi.fn(),
  listAttachments: vi.fn(async () => ({ items: [], nextCursor: null })),
}));
vi.mock('../src/features/task-graph/TaskGraph', async () => {
  const { useGraphFullscreen } = await import('../src/features/task-graph/useGraphFullscreen');
  return { TaskGraph: ({ index, rootId, onOpenTask }: {
    index: GraphIndex; rootId: string; onOpenTask: (id: string, trigger: HTMLElement) => void;
  }) => {
    const { fullscreen, containerRef, toggleRef, onKeyDown, toggle } = useGraphFullscreen();
    return <div className={`task-graph${fullscreen ? ' task-graph-fullscreen' : ''}`} ref={containerRef} onKeyDown={onKeyDown} role={fullscreen ? 'dialog' : undefined} aria-label={fullscreen ? '任务依赖图全屏查看' : undefined}>
      <button type="button" className="graph-fullscreen-toggle" ref={toggleRef} onClick={toggle}>{fullscreen ? '退出全屏' : '全屏查看'}</button>
      {[...projectChain(index, rootId).mainIds].map((id) => (
    <button key={id} type="button" onClick={(event) => onOpenTask(id, event.currentTarget)}>
      节点 {index.nodes.get(id)!.titlePreview}
    </button>
      ))}</div>;
  } };
});

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
const remainingChain = [remaining, task('remaining-child', '保留后续任务', [remainingId])];
const graph = (tasks = [task(rootId, '原任务链'), task(selectedId, '所选任务', [rootId]), ...remainingChain]): TaskGraph => ({ observedAt: "2026-10-20T12:00:00Z",
  project: { settings: { version: 1n, executionWarningMinutes: 60 }, id: projectId, name: '核心项目', repoUrl: '', createdAt: timestamp, updatedAt: timestamp },
  tasks,
  summary: {
    total: tasks.length, todo: tasks.filter((item) => item.status === 'todo').length, done: tasks.filter((item) => item.status === 'done').length, inProgress: tasks.filter((item) => item.status === 'in_progress').length,
    ready: tasks.filter((item) => item.ready).length, blocked: tasks.filter((item) => item.status === 'todo' && !item.ready).length,
  },
});
const graphRequest = vi.mocked(getTaskGraph);
const detailRequest = vi.mocked(getTask);
let root: HTMLDivElement;
let previousOverflow: string;

beforeEach(() => {
  root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'scroll';
  graphRequest.mockReset();
  detailRequest.mockReset();
  detailRequest.mockImplementation(async (project, id) => ({ requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null,
    id, projectId: project, title: '所选任务详情', description: '', properties: { worker: null, pullRequests: [] }, status: 'done', version: 1n,
    dependsOn: [rootId], blockedBy: [], ready: false, createdAt: timestamp, updatedAt: timestamp,
  }));
});

afterEach(() => {
  cleanup();
  root.remove();
  document.body.style.overflow = previousOverflow;
});

const openDialog = async (fullscreen = false) => {
  render(<ProjectPage projectId={projectId} />, { container: root });
  fireEvent.click(await screen.findByRole('button', { name: /^原任务链/ }));
  if (fullscreen) fireEvent.click(screen.getByRole('button', { name: '全屏查看' }));
  const trigger = await screen.findByRole('button', { name: '节点 所选任务' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '正在加载任务详情' });
  expect(root.contains(dialog)).toBe(false);
  expect(root).toHaveAttribute('inert');
  expect(document.body.style.overflow).toBe('hidden');
  expect(within(dialog).getByRole('button', { name: '关闭任务详情' })).toHaveFocus();
  await within(dialog).findByRole('heading', { name: '所选任务详情' });
  return { trigger, dialog };
};

const expectModalReleased = () => {
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(root).not.toHaveAttribute('inert');
  expect(document.body.style.overflow).toBe('scroll');
};

describe('project dialog focus restoration', () => {
  it('keeps active details focused when a merge replaces their expanded representative row', async () => {
    window.localStorage.setItem(`daynight:project-view:${projectId}`, JSON.stringify({ expandedRootId: remainingId }));
    const before = [...remainingChain, task(rootId, '原任务链'), task(selectedId, '所选任务', [rootId])];
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
    await waitFor(() => expect(document.getElementById(`task-root-${remainingId}`)).toHaveFocus());
    expectModalReleased();
  });

  it('returns focus to fullscreen exit when refresh removes the selected node but retains its graph', async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph([task(rootId, '原任务链'), task('surviving-child', '保留图节点', [rootId]), ...remainingChain]));
    const { trigger, dialog } = await openDialog(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    const fullscreen = await screen.findByRole('dialog', { name: '任务依赖图全屏查看' });
    await waitFor(() => expect(within(fullscreen).getByRole('button', { name: '退出全屏' })).toHaveFocus());
    expect(trigger.isConnected).toBe(false);
    expect(document.querySelector('.task-detail-dialog')).toBeNull();
    expect(root).not.toHaveAttribute('inert');
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
    expect(screen.queryByRole('dialog', { name: '任务依赖图全屏查看' })).toBeNull();
    expect(dialog).toBeVisible();
    expect(root).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^保留任务链/ })).toHaveFocus());
    expectModalReleased();
  });

  it.each([true, false])('retains details when completion hides their chain and restores visible focus (remaining=%s)', async (keepRemaining) => {
    const completed = [task(rootId, '原任务链'), task(selectedId, '所选任务', [rootId])].map((item) => ({
      ...item, status: 'done' as const, ready: false, blockedBy: [],
    }));
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph(keepRemaining ? [...completed, ...remainingChain] : completed));
    const { trigger, dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    await waitFor(() => expect(trigger.isConnected).toBe(false));
    expect(dialog).toBeVisible();
    expect(document.getElementById(`task-root-${rootId}`)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(keepRemaining ? screen.getByRole('button', { name: /^保留任务链/ }) : screen.getByRole('tab', { name: '任务链' })).toHaveFocus());
    expectModalReleased();
    const checkbox = screen.getByRole('checkbox', { name: /^显示已完成任务链/ });
    if (!keepRemaining) {
      fireEvent.click(screen.getByRole('button', { name: '显示已完成任务链' }));
      expect(checkbox).toHaveFocus();
      expect(screen.getByRole('button', { name: /^原任务链/ })).toHaveAttribute('aria-expanded', 'true');
    }
  });

  it('focuses the page heading after refresh removes the selected chain and every task', async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph([]));
    const { trigger, dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    await screen.findByRole('heading', { name: '还没有任务' });
    await waitFor(() => expect(screen.getByRole('heading', { name: '核心项目' })).toHaveFocus());
    expect(trigger.isConnected).toBe(false);
    expectModalReleased();
    expect(screen.getByText('所选任务已不在新的任务图中，详情已关闭。')).toBeVisible();
    expect(within(screen.getByRole('region', { name: '项目任务统计' })).getAllByText('0', { selector: '.stat-number' })).toHaveLength(6);
    expect(screen.queryByRole('region', { name: '任务依赖链' })).toBeNull();
  });

  it('focuses the newly expanded root after refresh removes the selected chain', async () => {
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph(remainingChain));
    const { trigger, dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
    const remainingRoot = await screen.findByRole('button', { name: /^保留任务链/ });
    await waitFor(() => expect(remainingRoot).toHaveFocus());
    expect(trigger.isConnected).toBe(false);
    expect(remainingRoot).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: '保留任务链 的任务依赖图' })).toBeVisible();
    expectModalReleased();
  });

  it('returns focus to a surviving task when the dialog closes normally', async () => {
    graphRequest.mockResolvedValueOnce(graph());
    const { trigger, dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expectModalReleased();
  });
});
