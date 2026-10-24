import { createGraphSyncFixture } from "./helpers/taskSync";
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getTask, getTaskSync } from '../src/api/client';
import type { GraphTask, TaskGraph } from '../src/api/types';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { installGraphMeasurements } from './graph-measurements';
import { createLocaleRender } from './helpers/renderWithLocale';

vi.mock('../src/api/client', async (original) => ({
  ...await original<typeof import('../src/api/client')>(), getTask: vi.fn(), getTaskSync: vi.fn(),
  listAttachments: vi.fn(async () => ({ items: [], nextCursor: null })),
}));

const graphRequest = vi.fn<(projectId: string, signal: AbortSignal) => Promise<TaskGraph>>();

const localeRender = createLocaleRender('zh-CN');
const render: typeof localeRender = (ui, options) => localeRender(ui, { ...options, taskCache: true });
const time = '2026-10-20T12:00:00Z';
const projectId = '10000000-0000-0000-0000-000000000001';
const [A, B, C, X] = [1, 2, 3, 4].map((value) => `20000000-0000-0000-0000-${String(value).padStart(12, '0')}`) as [string, string, string, string];
const node = (id: string, titlePreview: string, dependsOn: readonly string[]): GraphTask => ({
  id, titlePreview, titleTruncated: false, status: 'todo', dependsOn, externalDependsOn: [], blockedBy: dependsOn,
  ready: dependsOn.length === 0, requiredPlatform: null, allowAgents: false, startedAt: null, completedAt: null, createdAt: time, updatedAt: time,
});
const graph = (tasks: readonly GraphTask[]): TaskGraph => ({
  project: { id: projectId, name: 'Task repartition', repoUrl: 'https://github.com/example/repo', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time },
  observedAt: time, tasks,
  summary: { total: tasks.length, todo: tasks.length, inProgress: 0, done: 0,
    ready: tasks.filter((task) => task.ready).length, blocked: tasks.filter((task) => !task.ready).length },
});
let root: HTMLDivElement;
let overflow: string;

const syncFixture = createGraphSyncFixture();
beforeEach(() => {
  syncFixture.reset();
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (projectId, query, _userId, signal) => syncFixture.toSync(await graphRequest(projectId, signal), query));
});

beforeEach(() => {
  installGraphMeasurements();
  vi.mocked(getTask).mockReset();
  graphRequest.mockReset();
  root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  overflow = document.body.style.overflow;
  document.body.style.overflow = 'scroll';
});

afterEach(() => {
  cleanup();
  root.remove();
  document.body.style.overflow = overflow;
});

it('resets membership visibility and inspection while retaining fullscreen and active task details for the same representative', async () => {
  const before = [node(A, 'Root', []), node(B, 'Detached branch', [A]), node(C, 'Branch successor', [B]), node(X, 'Remaining branch', [A])];
  const after = before.map((task) => task.id === B ? { ...task, dependsOn: [], blockedBy: [], ready: true } : task);
  graphRequest.mockResolvedValueOnce(graph(before)).mockResolvedValueOnce(graph(after));
  const detached = after.find((task) => task.id === B)!;
  const initial = before.find((task) => task.id === B)!;
  vi.mocked(getTask).mockResolvedValueOnce({ ...initial, blockedBy: [], ready: true, projectId, title: initial.titlePreview, description: '', properties: { worker: null, pullRequests: [] }, version: 1n })
    .mockResolvedValue({ ...detached, projectId, title: detached.titlePreview, description: '', properties: { worker: null, pullRequests: [] }, version: 2n });
  const view = render(<ProjectPage projectId={projectId} />, { container: root });
  await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(4));
  fireEvent.click(screen.getByRole('button', { name: '全屏查看' }));
  const fullscreen = screen.getByRole('dialog', { name: '任务依赖图全屏查看' });
  const canvas = view.container.querySelector('.task-graph-canvas');
  const body = view.container.querySelector<HTMLButtonElement>(`.react-flow__node[data-id="${B}"] .task-node-body`)!;
  body.focus();
  fireEvent.click(body);
  expect(body).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(view.container.querySelector<HTMLButtonElement>(`.react-flow__node[data-id="${B}"] .task-node-details`)!);
  const dialog = await screen.findByRole('dialog', { name: 'Detached branch' });
  await within(dialog).findByRole('heading', { name: 'Detached branch' });
  const close = within(dialog).getByRole('button', { name: '关闭任务详情' });
  expect(close).toHaveFocus();
  fireEvent.click(within(dialog).getByRole('button', { name: '刷新任务图' }));
  await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(2));
  expect(fullscreen).toBeVisible();
  expect(view.container.querySelector('.task-graph-canvas')).toBe(canvas);
  expect(view.container.querySelectorAll('.task-node-selected')).toHaveLength(0);
  expect(dialog).toBeVisible();
  expect(close).toHaveFocus();
  expect(root).toHaveAttribute('inert');
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.keyDown(close, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Detached branch' })).toBeNull());
  expect(fullscreen).toBeVisible();
  const exit = within(fullscreen).getByRole('button', { name: '退出全屏' });
  expect(exit).toHaveFocus();
  expect(root).not.toHaveAttribute('inert');
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.keyDown(exit, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: '任务依赖图全屏查看' })).toBeNull();
  expect(document.body.style.overflow).toBe('scroll');
  expect(screen.getByRole('button', { name: '全屏查看' })).toHaveFocus();
});
