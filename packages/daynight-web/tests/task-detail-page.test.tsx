import * as client from '../src/api/client';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { saveDetail } from '../src/features/task-detail/detail-cache';
import { TaskDetailPage } from '../src/features/task-detail/TaskDetailPage';
import { ProjectAccessBoundary, useProjectAccess, type ProjectAccessSession } from '../src/features/projects/ProjectAccess';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { taskSyncReadFixture, TEST_VIEWER_ID, taskSyncFromGraph, taskSyncResponse, taskSyncQuery, fixtureTaskEpoch, rememberTaskEpoch, viewerHeaders } from "./helpers/taskSync";
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/App';
import { AuthenticatedApp } from '../src/app/AuthenticatedApp';
import { navigateTaskDetail, replaceRoute, taskDetailUrl } from '../src/app/router';
import { TaskDetailDialog } from '../src/features/task-detail/TaskDetailDialog';
import type { TaskDetail, TaskSync } from '../src/api/types';
import { detailFixture, graphFixture, resourceResponse, snapshotFixture } from './helpers/taskDetail';
import { createLocaleRender } from './helpers/renderWithLocale';

const localeRender = createLocaleRender('zh-CN');
const render: typeof localeRender = (ui, options) => localeRender(ui, { taskCache: true, ...options });
const projectId = '00000000-0000-4000-8000-000000000100';
const taskId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const root = `/api/v1/projects/${projectId}`;
const address = (tab: 'overview' | 'attachments' = 'overview', path: string | null = null, id = taskId) => taskDetailUrl(projectId, id, { tab, path });
const files = ['docs/guide.md', 'data/next.txt'];
const installed = (initial?: TaskDetail) => {
  const first = initial === undefined ? detailFixture(projectId, taskId, { title: '独立任务', description: '# 完整说明\n\n[阅读方案](docs/guide.md)' }) : initial;
  const tasks = new Map([[taskId, first], [otherId, detailFixture(projectId, otherId, { title: '后续任务', dependsOn: [taskId], blockedBy: [taskId], ready: false })]]);
  const paths = new Set(files);
  const handler = (url: string, options?: RequestInit): Response => {
    if (new URL(url, location.origin).pathname === `${root}/task-sync`) return taskSyncResponse(graphFixture([...tasks.values()]), { viewerId: TEST_VIEWER_ID, query: taskSyncQuery(new URL(url, location.origin)), versionForTask: (task) => tasks.get(task.id)!.version, propertiesForTask: (task) => tasks.get(task.id)!.properties });
    if (new URL(url, location.origin).pathname === `${root}/task-assignees`) return resourceResponse({ items: [{ userId: TEST_VIEWER_ID, version: 'a'.repeat(64), name: 'Owner', avatarUrl: null, hasProjectAccess: true }], unresolvedUserIds: [] }, TEST_VIEWER_ID);
    if (new URL(url, location.origin).pathname === `${root}/task-graph`) return resourceResponse(graphFixture([...tasks.values()]), TEST_VIEWER_ID);
    const match = new RegExp(`^${root}/tasks/([^/]+)(?:/(status))?$`).exec(url);
    if (match !== null) {
      const task = tasks.get(match[1]!)!;
      if (options?.method === 'PUT' || options?.method === 'PATCH') {
        const body = JSON.parse(String(options.body));
        expect(BigInt(body.version)).toBe(task.version);
        const target = body.status as TaskDetail['status'];
        const changedStatus = match[2] === 'status' && target !== task.status;
        const timing = target === 'todo' ? { startedAt: null, completedAt: null } : target === 'in_progress' ? { startedAt: '2026-10-24T11:00:00Z', completedAt: null } : { startedAt: task.status === 'in_progress' ? task.startedAt : null, completedAt: '2026-10-24T11:05:00Z' };
        const next = { ...task, ...(match[2] === 'status' ? changedStatus ? { status: target, ready: target === 'todo' && task.blockedBy.length === 0, ...timing } : {} : Object.hasOwn(body, 'allowAgents') ? { allowAgents: body.allowAgents as boolean } : { requiredPlatform: body.requiredPlatform as TaskDetail['requiredPlatform'] }), version: task.version + (match[2] === 'status' && !changedStatus ? 0n : 1n) };
        tasks.set(task.id, next);
        return resourceResponse(next, TEST_VIEWER_ID);
      }
      const response = resourceResponse(task, TEST_VIEWER_ID);
      response.headers.set('Daynight-Task-Epoch', fixtureTaskEpoch(projectId));
      return response;
    }
    if (new URL(url, location.origin).pathname.endsWith('/sessions')) return resourceResponse({ items: [], nextCursor: null }, TEST_VIEWER_ID);
    if (url.includes('/attachments?')) return resourceResponse({ items: [...paths].map((path) => ({ path, contentType: 'text/plain', sizeBytes: 12, createdAt: first.createdAt, updatedAt: first.updatedAt })), nextCursor: null });
    if (url.includes('/attachments/files/')) {
      if (options?.method === 'DELETE') { paths.delete(url.split('/attachments/files/')[1]!.split('/').map(decodeURIComponent).join('/')); return new Response(null, { status: 204 }); }
      return new Response(url.endsWith('guide.md') ? '方案正文' : '下一份正文');
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => handler(url, options));
  vi.stubGlobal('fetch', fetcher);
  return { first, tasks, handler, fetcher };
};

const moveHistory = async (direction: 'back' | 'forward') => {
  await act(async () => { await new Promise<void>((resolve) => { window.addEventListener('popstate', () => resolve(), { once: true }); window.history[direction](); }); });
};

describe('standalone full task details', () => {
  it('keeps a cold cached private body unavailable when a trusted access denial precedes an older delta', async () => {
    const detail = detailFixture(projectId, taskId, { title: 'Cached private task', description: 'COLD_PRIVATE_DESCRIPTION_MARKER', version: 5n });
    const graph = graphFixture([detail]);
    const warm = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    try {
      const ticket = await warm.beginSync(projectId, warm.signal);
      await warm.applySync(ticket, taskSyncFromGraph(graph, { versionForTask: () => detail.version, propertiesForTask: () => detail.properties }), warm.signal);
      await saveDetail(warm, await warm.beginSync(projectId, warm.signal), detail, warm.signal);
    } finally { warm.dispose(); }
    const cold = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const oldDelta = Promise.withResolvers<TaskSync>();
    const freshDetail = Promise.withResolvers<TaskDetail>();
    const applied = Promise.withResolvers<void>();
    const readSync = vi.spyOn(client, 'getTaskSync').mockImplementation(async () => taskSyncReadFixture(await oldDelta.promise));
    const readDetail = vi.spyOn(client, 'getTask').mockReturnValue(freshDetail.promise);
    const apply = cold.applySync.bind(cold);
    vi.spyOn(cold, 'applySync').mockImplementation(async (...args) => { try { return await apply(...args); } finally { applied.resolve(); } });
    const fetcher = vi.fn(async (url: string) => {
      if (url === `${root}/access`) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Denied', requestId: 'trusted-cold-denial' } }), {
        status: 404, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID },
      });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    let access!: ProjectAccessSession;
    const CaptureAccess = () => { access = useProjectAccess(projectId).session; return null; };
    const view = render(<ProjectAccessBoundary projectId={projectId}><CaptureAccess /><TaskDetailPage projectId={projectId} taskId={taskId} navigation={{ tab: 'overview', path: null }} /></ProjectAccessBoundary>, { taskCache: { scope: cold } });
    try {
      await waitFor(() => expect(readSync).toHaveBeenCalledOnce());
      expect(cold.getAuthorizedProject(projectId)).toBeNull();
      expect(screen.queryByText(detail.description)).toBeNull();
      await act(async () => { fireEvent(window, new Event('focus')); await access.revalidate(); });
      expect(fetcher).toHaveBeenCalledWith(`${root}/access`, expect.anything());
      expect(access.snapshot().status).toBe('unavailable');
      const query = readSync.mock.calls[0]![1];
      expect(query.epoch).toBeDefined();
      await act(async () => {
        oldDelta.resolve(taskSyncFromGraph(graph, { query, versionForTask: () => detail.version, propertiesForTask: () => detail.properties }));
        await applied.promise;
      });
      await waitFor(() => {
        expect(screen.queryByText(detail.description)).toBeNull();
        expect(screen.getByRole('heading', { name: '项目不存在或你没有访问权限' })).toBeVisible();
        expect(screen.getByRole('link', { name: '返回项目列表' })).toHaveAttribute('href', '/projects');
      });
      expect(screen.queryByText(detail.description)).toBeNull();
      expect(cold.getAuthorizedProject(projectId)).toBeNull();
      expect(readDetail).not.toHaveBeenCalled();
    } finally { view.unmount(); cold.dispose(); freshDetail.resolve(detail); }
  });

  it('copies the title from the shared header while reading an attachment', async () => {
    const { first } = installed();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    window.history.replaceState(null, '', address('attachments', 'docs/guide.md'));
    render(<App />);
    await screen.findByText('方案正文');
    fireEvent.click(screen.getByRole('button', { name: '复制任务标题' }));
    expect(await screen.findByText('已复制')).toBeVisible();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(first.title);
    expect(location.pathname + location.search).toBe(address('attachments', 'docs/guide.md'));
  });

  it('focuses the same page without history changes or refetch and keeps ordinary Escape native', async () => {
    const { fetcher } = installed();
    window.history.replaceState(null, '', address('attachments', 'docs/guide.md'));
    render(<App />);
    await screen.findByText('方案正文');
    const main = screen.getByRole('main');
    const panel = document.querySelector('.task-attachments');
    const fileInput = document.querySelector('input[type="file"]');
    const historyLength = history.length;
    const requestCount = fetcher.mock.calls.length;
    fireEvent.click(screen.getByText('上传文件', { selector: 'summary' }));
    const draft = screen.getByLabelText('目标相对路径');
    fireEvent.change(draft, { target: { value: 'retained/page.txt' } });
    const toggle = screen.getByRole('button', { name: '进入全屏' });
    fireEvent.click(toggle);
    expect(screen.getByRole('main')).toBe(main);
    expect(main).toHaveClass('task-detail-fullscreen');
    expect(screen.queryByRole('combobox', { name: '语言 / Language' })).toBeNull();
    expect(screen.getByRole('link', { name: '返回任务所在项目' })).toHaveAttribute('href', `/projects/${projectId}`);
    expect(document.querySelector('.task-attachments')).toBe(panel);
    expect(document.querySelector('input[type="file"]')).toBe(fileInput);
    expect(draft).toHaveValue('retained/page.txt');
    expect(fetcher.mock.calls).toHaveLength(requestCount);
    expect(location.pathname).toBe(address('attachments', 'docs/guide.md'));
    expect(history.length).toBe(historyLength);
    expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(false);
    expect(main).not.toHaveClass('task-detail-fullscreen');
    expect(toggle).toHaveFocus();
    expect(screen.getByRole('combobox', { name: '语言 / Language' })).toBeVisible();
    expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true);
    expect(screen.getByRole('main')).toBe(main);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    fireEvent.click(await screen.findByRole('button', { name: '后续任务，普通依赖' }));
    await screen.findByRole('heading', { name: '后续任务' });
    expect(screen.getByRole('main')).toHaveClass('task-detail-fullscreen');
  });

  it('retains an in-flight exact-version write when entering and leaving fullscreen', async () => {
    const fixture = installed();
    let complete!: () => void;
    fixture.fetcher.mockImplementation(async (url, options) => {
      if (options?.method === 'PUT') await new Promise<void>((resolve) => { complete = resolve; });
      return fixture.handler(url, options);
    });
    window.history.replaceState(null, '', address());
    render(<App />);
    await screen.findByRole('heading', { name: '独立任务' });
    const main = screen.getByRole('main');
    fireEvent.click(screen.getByRole('button', { name: '待处理' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '进行中' }));
    fireEvent.click(screen.getByRole('button', { name: '确认设置' }));
    await waitFor(() => expect(fixture.fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '进入全屏' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('main')).toBe(main);
    expect(screen.getByRole('button', { name: '待处理' })).toBeDisabled();
    await act(async () => { complete(); });
    await waitFor(() => expect(screen.getByRole('button', { name: '进行中' })).toBeEnabled());
    expect(fixture.fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
    expect(fixture.fetcher.mock.calls.find(([, options]) => options?.method === 'PUT')?.[1]?.body).toBe('{"version":1,"status":"in_progress"}');
    expect(screen.getByRole('main')).toBe(main);
  });

  it('keeps full details, hidden file selection and upload drafts through search-only tab and file history', async () => {
    const { fetcher } = installed();
    window.history.replaceState(null, '', address('attachments'));
    render(<App />);
    await screen.findByRole('heading', { name: '独立任务' });
    expect(screen.getByRole('tab', { name: '附件' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('main')).toHaveFocus();
    expect(document.querySelector('.task-detail-dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    const panel = document.querySelector('.task-attachments');
    fireEvent.click(await screen.findByText('docs', { selector: 'summary' }));
    fireEvent.click(await screen.findByRole('button', { name: /^guide\.md/ }));
    await screen.findByText('方案正文');
    expect(window.location.pathname).toBe(address('attachments', 'docs/guide.md'));
    fireEvent.click(screen.getByText('上传文件', { selector: 'summary' }));
    const draft = screen.getByLabelText('目标相对路径');
    fireEvent.change(draft, { target: { value: 'unsent/draft.txt' } });
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    expect(window.location.search).toBe('?tab=overview');
    expect(screen.getByRole('heading', { name: '完整说明' })).toBeVisible();
    expect(document.querySelector('.task-attachments')).toBe(panel);
    expect(draft).toHaveValue('unsent/draft.txt');
    await moveHistory('back');
    expect(await screen.findByText('方案正文')).toBeVisible();
    expect(screen.getByRole('tab', { name: '附件' })).toHaveAttribute('aria-selected', 'true');
    await moveHistory('forward');
    expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
    expect(fetcher.mock.calls.filter(([url]) => new URL(url, location.origin).pathname.endsWith('/task-sync'))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/attachments?'))).toHaveLength(1);
  });

  it('treats explicit default tabs as the same navigation state and isolates related task changes', async () => {
    const { fetcher } = installed();
    window.history.replaceState(null, '', address() + '?tab=overview');
    render(<App />);
    await screen.findByRole('heading', { name: '独立任务' });
    const count = window.history.length;
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    expect(window.history.length).toBe(count);
    fireEvent.click(await screen.findByRole('button', { name: '后续任务，普通依赖' }));
    await screen.findByRole('heading', { name: '后续任务' });
    expect(window.location.pathname).toBe(address('overview', null, otherId));
    expect(fetcher.mock.calls.filter(([url]) => new URL(url, location.origin).pathname.endsWith('/task-sync'))).toHaveLength(1);
    await moveHistory('back');
    await screen.findByRole('heading', { name: '独立任务' });
    act(() => navigateTaskDetail(projectId, taskId, { tab: 'attachments', path: 'docs/guide.md' }));
    await screen.findByText('方案正文');
    window.history.replaceState(null, '', address('attachments', 'docs/guide.md') + '?tab=attachments');
    const fileCount = window.history.length;
    fireEvent.click(screen.getByRole('button', { name: /^guide\.md/ }));
    expect(window.history.length).toBe(fileCount);
  });

  it('clears transient invalid Markdown feedback when history restores a valid file selection', async () => {
    installed(detailFixture(projectId, taskId, { title: '独立任务', description: '[越界引用](../outside.txt)' }));
    window.history.replaceState(null, '', address('attachments', 'docs/guide.md'));
    render(<App />);
    await screen.findByText('方案正文');
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    fireEvent.click(screen.getByText('越界引用'));
    expect(await screen.findByRole('alert')).toHaveTextContent('此附件引用无效或超出了任务附件根目录');
    expect(screen.getByRole('tab', { name: '附件' })).toHaveAttribute('aria-selected', 'true');
    await moveHistory('back');
    expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
    await moveHistory('back');
    expect(screen.getByRole('tab', { name: '附件' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('方案正文')).toBeVisible();
    expect(screen.queryByText('此附件引用无效或超出了任务附件根目录。')).toBeNull();
    expect(screen.getByRole('button', { name: /^guide\.md/ })).toHaveAttribute('aria-pressed', 'true');
    await moveHistory('forward');
    await moveHistory('forward');
    expect(screen.getByRole('tab', { name: '附件' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('选择文件查看预览或下载。')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('loads details when project synchronization fails and reports relation failures independently', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const fixture = installed();
    let failRelations = true;
    fixture.fetcher.mockImplementation(async (url, options) => {
      const path = new URL(url, location.origin).pathname;
      if (path === `${root}/task-sync` || path === `${root}/task-graph` && failRelations) return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'private error', requestId: 'graph-failure' } }), { status: 503, headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) });
      return fixture.handler(url, options);
    });
    window.history.replaceState(null, '', address());
    render(<App />);
    await screen.findByRole('heading', { name: '独立任务' });
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('private error');
    expect(screen.queryByText('无后续任务')).toBeNull();
    expect(screen.getByRole('button', { name: '待处理' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '负责人：未分配' }));
    expect(await screen.findByRole('option', { name: 'Owner' })).toBeVisible();
    fireEvent.keyDown(screen.getByRole('dialog', { name: '负责人' }), { key: 'Escape' });
    failRelations = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试详情' }));
    await screen.findByRole('button', { name: '后续任务，普通依赖' });
  });

  it('refreshes direct details every fifteen seconds while retaining the mounted view', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fixture = installed();
    window.history.replaceState(null, '', address());
    render(<App />);
    const title = await screen.findByRole('heading', { name: '独立任务' });
    const body = document.querySelector('.task-detail-body');
    expect(fixture.fetcher.mock.calls.filter(([url]) => url === `${root}/tasks/${taskId}`)).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await waitFor(() => expect(fixture.fetcher.mock.calls.filter(([url]) => url === `${root}/tasks/${taskId}`)).toHaveLength(2));
    expect(screen.getByRole('heading', { name: '独立任务' })).toBe(title);
    expect(document.querySelector('.task-detail-body')).toBe(body);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('immediately reobserves direct details when the page becomes visible', async () => {
    const fixture = installed();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    window.history.replaceState(null, '', address());
    render(<App />);
    await screen.findByRole('heading', { name: '独立任务' });
    expect(fixture.fetcher.mock.calls.filter(([url]) => url === `${root}/tasks/${taskId}`)).toHaveLength(1);
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    const previous = fixture.tasks.get(taskId)!;
    fixture.tasks.set(taskId, { ...previous, title: '更新后的任务', version: previous.version + 1n });
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(await screen.findByRole('heading', { name: '更新后的任务' })).toBeVisible();
    expect(fixture.fetcher.mock.calls.filter(([url]) => url === `${root}/tasks/${taskId}`)).toHaveLength(2);
    expect(fixture.fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT' || options?.method === 'PATCH' || options?.method === 'DELETE')).toHaveLength(0);
  });

  it('keeps page keys ordinary and uses current exact-version status confirmations, including cancel and no-op', async () => {
    const { fetcher, tasks } = installed();
    window.history.replaceState(null, '', address());
    render(<App />);
    await screen.findByRole('heading', { name: '独立任务' });
    expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true);
    expect(screen.getByRole('main')).toBeInTheDocument();
    const chooseStatus = (label: string) => {
      fireEvent.click(document.querySelector('.task-status-trigger')!);
      fireEvent.click(screen.getByRole('menuitemradio', { name: label }));
      return screen.getByRole('alertdialog', { name: '设置任务状态' });
    };
    let confirmation = chooseStatus('进行中');
    fireEvent.click(within(confirmation).getByRole('button', { name: '取消' }));
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
    confirmation = chooseStatus('进行中');
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认设置' }));
    await waitFor(() => expect(document.querySelector('.task-status-trigger')).toHaveTextContent('进行中'));
    expect(fetcher.mock.calls.find(([, options]) => options?.method === 'PUT')?.[1]?.body).toBe('{"version":1,"status":"in_progress"}');
    await waitFor(() => expect(document.querySelector('.task-status-trigger')).toBeEnabled());
    const active = tasks.get(taskId)!;
    confirmation = chooseStatus('进行中');
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认设置' }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(2));
    await waitFor(() => expect(document.querySelector('.task-status-trigger')).toBeEnabled());
    expect(tasks.get(taskId)).toEqual(active);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('reviews status-row platform changes on the attachment tab and submits only the confirmed exact version', async () => {
    const { fetcher } = installed();
    window.history.replaceState(null, '', address('attachments', 'docs/guide.md'));
    render(<App />);
    await screen.findByText('方案正文');
    const platform = screen.getByRole('combobox', { name: '执行平台' });
    expect(platform.closest('.task-detail-status-row')).not.toBeNull();
    expect(document.querySelector('.task-status-trigger')!.closest('.task-detail-state-controls')).toContainElement(platform);
    expect(document.querySelector('.task-status-trigger')!.closest('.task-detail-header')).toBeNull();
    expect(screen.queryByRole('button', { name: '保存平台' })).toBeNull();
    const panel = document.querySelector('.task-attachments');
    platform.focus();
    fireEvent.change(platform, { target: { value: 'linux' } });
    expect(platform).toHaveValue('');
    let confirmation = screen.getByRole('alertdialog', { name: '修改执行平台？' });
    expect(within(confirmation).getByText('当前平台：不限平台。目标平台：Linux。')).toBeVisible();
    fireEvent.click(within(confirmation).getByRole('button', { name: '取消' }));
    expect(platform).toHaveFocus();
    expect(platform).toHaveValue('');
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(0);
    fireEvent.change(platform, { target: { value: 'linux' } });
    confirmation = screen.getByRole('alertdialog', { name: '修改执行平台？' });
    fireEvent.click(within(confirmation).getByRole('button', { name: '修改平台' }));
    await screen.findByText('执行平台已更新。');
    await waitFor(() => expect(platform).toHaveValue('linux'));
    expect(fetcher.mock.calls.find(([, options]) => options?.method === 'PATCH')?.[1]?.body).toBe('{"version":1,"requiredPlatform":"linux"}');
    expect(document.querySelector('.task-attachments')).toBe(panel);
    expect(screen.getByText('方案正文')).toBeVisible();
    expect(window.location.pathname).toBe(address('attachments', 'docs/guide.md'));
    fireEvent.change(platform, { target: { value: 'linux' } });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(1);
  });

  it.each(['conflict', 'unknown'] as const)('reconciles a standalone status %s without resubmitting the write', async (failure) => {
    const fixture = installed();
    fixture.fetcher.mockImplementation(async (url, options) => {
      if (options?.method === 'PUT') {
        const task = fixture.tasks.get(taskId)!;
        fixture.tasks.set(taskId, { ...task, version: task.version + 1n });
        if (failure === 'unknown') throw new TypeError('Lost response');
        return new Response(JSON.stringify({ error: { code: 'version_conflict', message: 'Task changed', requestId: 'status-conflict' } }), { status: 409, headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) });
      }
      return fixture.handler(url, options);
    });
    window.history.replaceState(null, '', address());
    render(<App />);
    await screen.findByRole('heading', { name: '独立任务' });
    fireEvent.click(document.querySelector('.task-status-trigger')!);
    fireEvent.click(screen.getByRole('menuitemradio', { name: '已完成' }));
    const confirmation = screen.getByRole('alertdialog', { name: '设置任务状态' });
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认设置' }));
    await screen.findByText(failure === 'conflict' ? '任务已变化。请检查重新读取的内容，再次操作需要重新确认。' : '已读取当前任务状态；这不能证明先前请求的结果。');
    await waitFor(() => expect(document.querySelector('.task-status-trigger')).toBeEnabled());
    expect(fixture.fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
    expect(fixture.tasks.get(taskId)!.version).toBe(2n);
    expect(document.querySelector('.task-status-trigger')).toHaveTextContent('待处理');
  });

  it('keeps the embedded popout bound to current tab and file without writing the project address', async () => {
    const fixture = installed();
    const application = document.createElement('div');
    application.id = 'root';
    document.body.append(application);
    window.history.replaceState(null, '', `/projects/${projectId}`);
    const historyLength = window.history.length;
    const world = createTaskSessionWorld();
    await world.sync([...fixture.tasks.values()]);
    const view = render(<TaskDetailDialog projectId={projectId} taskId={taskId} snapshot={snapshotFixture([...fixture.tasks.values()])} onSelectTask={vi.fn()} onClose={vi.fn()} onRestoreFocus={vi.fn()} onRefreshGraph={vi.fn()} />, { container: application, taskCache: { scope: world.scope } });
    try {
      const dialog = await screen.findByRole('dialog', { name: '独立任务' });
      const popout = () => {
        const more = within(dialog).getByRole('button', { name: '更多任务操作' });
        if (more.getAttribute('aria-expanded') !== 'true') fireEvent.click(more);
        return within(dialog).getByRole('menuitem', { name: '在新标签页打开' });
      };
      expect(popout()).toHaveAttribute('href', address());
      expect(popout()).toHaveAttribute('target', '_blank');
      expect(popout()).toHaveAttribute('rel', 'noopener noreferrer');
      fireEvent.click(within(dialog).getByRole('tab', { name: '附件' }));
      fireEvent.click(await within(dialog).findByText('docs', { selector: 'summary' }));
      fireEvent.click(await within(dialog).findByRole('button', { name: /^guide\.md/ }));
      await within(dialog).findByText('方案正文');
      expect(popout()).toHaveAttribute('href', address('attachments', 'docs/guide.md'));
      fireEvent.click(within(dialog).getByRole('tab', { name: '概览' }));
      expect(popout()).toHaveAttribute('href', address('overview', 'docs/guide.md'));
      fireEvent.click(within(dialog).getByRole('tab', { name: '附件' }));
      fireEvent.click(within(dialog).getByRole('button', { name: '更多操作：docs/guide.md' }));
      fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
      const deletion = screen.getByRole('dialog', { name: '删除附件？' });
      fireEvent.click(within(deletion).getByRole('button', { name: '删除附件' }));
      await within(dialog).findByText('选择文件查看预览或下载。');
      expect(popout()).toHaveAttribute('href', address('attachments'));
      expect(window.location.pathname).toBe(`/projects/${projectId}`);
      expect(window.history.length).toBe(historyLength);
    } finally { view.unmount(); world.dispose(); application.remove(); }
  });

  it('rejects invalid tabs and preserves a requested tab in the login return address', async () => {
    window.history.replaceState(null, '', address() + '?tab=invalid');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const view = render(<App />);
    expect(screen.getByRole('heading', { name: '页面不存在' })).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
    view.unmount();
    replaceRoute(address('overview', 'docs/guide.md') + '&authError=login_failed');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/v1/me' ? new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }) : resourceResponse({ providers: ['github'] })));
    const login = vi.fn();
    localeRender(<AuthenticatedApp navigateToLogin={login} />);
    fireEvent.click(await screen.findByRole('button', { name: '使用 GitHub 登录' }));
    const parameters = new URL(login.mock.calls[0]![0], window.location.origin).searchParams;
    expect(parameters.get('returnPath')).toBe(address('overview', 'docs/guide.md'));
  });
});

describe('typed Goal routes', () => {
  it('restores focus inside the Goal when the child moves and its opener disappears', async () => {
    const goal = detailFixture(projectId, taskId, { type: 'goal', title: 'Release goal', ready: false });
    const child = detailFixture(projectId, otherId, { title: 'Goal child', parentId: taskId });
    const fixture = installed(goal); fixture.tasks.set(otherId, child);
    const graph = graphFixture([goal, child]);
    const sync = taskSyncFromGraph(graph, { versionForTask: () => 1n, propertiesForTask: (task) => fixture.tasks.get(task.id)!.properties });
    const { [taskId]: _goalState, ...dependencyStates } = sync.dependencyStates;
    vi.spyOn(client, 'getTaskSync').mockImplementation(async (_projectId, query) => taskSyncReadFixture({ ...sync, mode: query.epoch === sync.epoch ? 'delta' : 'snapshot', dependencyStates }));
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const view = render(<TaskDetailPage projectId={projectId} taskId={taskId} navigation={{ tab: 'overview', path: null }} />, { taskCache: { scope } });
    try {
      const opener = await screen.findByRole('button', { name: /Goal child/ }, { timeout: 10000 });
      fireEvent.click(opener);
      const dialog = await screen.findByRole('dialog', { name: child.title }, { timeout: 10000 });
      const moved = { ...child, parentId: null, version: 2n, updatedAt: '2026-10-23T10:00:00Z' };
      fixture.tasks.set(otherId, moved);
      const update = taskSyncFromGraph(graphFixture([goal, moved]), { query: { epoch: sync.epoch }, epoch: sync.epoch, versionForTask: (task) => task.id === otherId ? 2n : 1n, propertiesForTask: (task) => fixture.tasks.get(task.id)!.properties });
      const { [taskId]: _goalUpdate, ...updatedStates } = update.dependencyStates;
      const ticket = await scope.beginSync(projectId, scope.signal);
      await act(async () => { await scope.applySync(ticket, { ...update, dependencyStates: updatedStates }, scope.signal); });
      await waitFor(() => expect(opener.isConnected).toBe(false), { timeout: 10000 });
      fireEvent.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
      await waitFor(() => expect(screen.getByRole('heading', { name: goal.title })).toHaveFocus(), { timeout: 10000 });
    } finally { view.unmount(); scope.dispose(); }
  }, 20000);

  it('starts a new Goal with fullscreen off', async () => {
    const first = detailFixture(projectId, taskId, { type: 'goal', title: 'First Goal', ready: false });
    const second = detailFixture(projectId, otherId, { type: 'goal', title: 'Second Goal', ready: false });
    const fixture = installed(first); fixture.tasks.set(otherId, second);
    const graph = graphFixture([first, second]);
    const sync = taskSyncFromGraph(graph, { versionForTask: () => 1n, propertiesForTask: () => first.properties });
    vi.spyOn(client, 'getTaskSync').mockImplementation(async (_projectId, query) => taskSyncReadFixture({ ...sync, mode: query.epoch === sync.epoch ? 'delta' : 'snapshot', dependencyStates: {} }));
    const view = render(<TaskDetailPage projectId={projectId} taskId={taskId} navigation={{ tab: 'overview', path: null }} />);
    try {
      await screen.findByRole('heading', { name: first.title }, { timeout: 10000 });
      fireEvent.click(screen.getByRole('button', { name: '进入全屏' }));
      expect(screen.getByRole('button', { name: '退出全屏' })).toHaveAttribute('aria-pressed', 'true');
      view.rerender(<TaskDetailPage projectId={projectId} taskId={otherId} navigation={{ tab: 'overview', path: null }} />);
      await screen.findByRole('heading', { name: second.title }, { timeout: 10000 });
      expect(screen.getByRole('button', { name: '进入全屏' })).toHaveAttribute('aria-pressed', 'false');
    } finally { view.unmount(); }
  }, 20000);

  it('does not start a Task controller when a Goal summary disappears', async () => {
    const goal = detailFixture(projectId, taskId, { type: 'goal', title: 'Release goal', ready: false });
    const child = detailFixture(projectId, otherId);
    const fixture = installed(goal);
    const initial = snapshotFixture([child]);
    const summary = taskSyncFromGraph(graphFixture([goal]), { versionForTask: () => goal.version, propertiesForTask: () => goal.properties }).tasks[0]!;
    const withGoal = { ...initial, summaries: new Map([...initial.summaries, [taskId, summary]]) };
    const rootElement = document.createElement('div'); rootElement.id = 'root'; document.body.append(rootElement);
    const onRestoreFocus = vi.fn();
    const props = { projectId, taskId, snapshot: withGoal, observation: { kind: 'project-summary' as const, revision: 1, task: undefined }, onClose: vi.fn(), onRestoreFocus, onRefreshGraph: vi.fn(), onSelectTask: vi.fn() };
    const view = render(<TaskDetailDialog {...props} />, { container: rootElement });
    try {
      await screen.findByRole('dialog', { name: goal.title }, { timeout: 10000 });
      view.rerender(<TaskDetailDialog {...props} snapshot={initial} observation={{ kind: 'project-summary', revision: initial.revision, task: undefined }} />);
      expect(screen.queryByRole('dialog', { name: goal.title })).toBeNull();
      expect(onRestoreFocus).not.toHaveBeenCalled();
      expect(fixture.fetcher.mock.calls.some(([url]) => /\/(sessions|steps)(?:\?|$)/.test(url))).toBe(false);
      view.unmount();
      expect(onRestoreFocus).toHaveBeenCalledOnce();
    } finally { view.unmount(); rootElement.remove(); }
  }, 20000);

  it('restores focus on final close after a loaded Goal history is retired', async () => {
    const goal = detailFixture(projectId, taskId, { type: 'goal', title: 'Release goal', ready: false });
    installed(goal);
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const rootElement = document.createElement('div'); rootElement.id = 'root'; document.body.append(rootElement);
    const restore = vi.fn();
    const view = render(<TaskDetailDialog projectId={projectId} taskId={taskId} observation={{ kind: 'direct' }} onClose={vi.fn()} onRestoreFocus={restore} onRefreshGraph={vi.fn()} onSelectTask={vi.fn()} />, { container: rootElement, taskCache: { scope } });
    try {
      await screen.findByRole('dialog', { name: goal.title }, { timeout: 10000 });
      const fence = await scope.beginTaskRead(projectId, taskId, 0, 0, scope.signal);
      await act(async () => { expect(await scope.observeHistory(fence, '40000000-0000-4000-8000-000000000001', scope.signal)).toBe('retired'); });
      expect(screen.queryByRole('dialog', { name: goal.title })).toBeNull();
      expect(restore).not.toHaveBeenCalled();
      view.unmount();
      expect(restore).toHaveBeenCalledOnce();
    } finally { view.unmount(); scope.dispose(); rootElement.remove(); }
  }, 20000);

  it('retains a discussion draft on a detail refresh failure and retires it on scope loss', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const goal = detailFixture(projectId, taskId, { type: 'goal', title: 'Release goal', ready: false });
    const fixture = installed(goal);
    const graph = graphFixture([goal]);
    const sync = taskSyncFromGraph(graph, { versionForTask: () => goal.version, propertiesForTask: () => goal.properties });
    vi.spyOn(client, 'getTaskSync').mockImplementation(async (_projectId, query) => taskSyncReadFixture({ ...sync, mode: query.epoch === sync.epoch ? 'delta' : 'snapshot', dependencyStates: {} }));
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => url.includes('/thread/messages?')
      ? resourceResponse({ items: [], hasMoreBefore: false, hasMoreAfter: false }, TEST_VIEWER_ID) : fixture.handler(url, options)));
    const deniedRetry = Promise.withResolvers<client.TaskObservation>();
    const acceptedRetry = Promise.withResolvers<client.TaskObservation>();
    const read = vi.spyOn(client, 'getTaskObservation').mockResolvedValueOnce({ epoch: fixtureTaskEpoch(projectId), detail: goal })
      .mockRejectedValueOnce(new client.ApiError('network')).mockRejectedValueOnce(new client.ApiError('server', 403, 'forbidden'))
      .mockReturnValueOnce(deniedRetry.promise).mockReturnValueOnce(acceptedRetry.promise);
    const view = render(<TaskDetailPage projectId={projectId} taskId={taskId} navigation={{ tab: 'discussion', path: null }} />);
    try {
      const draft = await screen.findByRole('textbox', { name: '讨论消息' }, { timeout: 10000 });
      await waitFor(() => expect(draft).toBeEnabled(), { timeout: 10000 });
      fireEvent.change(draft, { target: { value: 'preserved draft' } });
      fireEvent(document, new Event('visibilitychange'));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2), { timeout: 10000 });
      expect(await screen.findByRole('alert')).toHaveTextContent('任务详情更新失败');
      expect(draft).toHaveValue('preserved draft');
      fireEvent(document, new Event('visibilitychange'));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(3), { timeout: 10000 });
      await waitFor(() => expect(screen.queryByRole('heading', { name: goal.title })).toBeNull(), { timeout: 10000 });
      expect(screen.queryByRole('textbox', { name: '讨论消息' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '重试详情' }));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(4), { timeout: 10000 });
      expect(screen.queryByRole('heading', { name: goal.title })).toBeNull();
      expect(screen.queryByRole('textbox', { name: '讨论消息' })).toBeNull();
      await act(async () => { deniedRetry.reject(new client.ApiError('server', 403, 'forbidden')); await deniedRetry.promise.catch(() => {}); });
      await waitFor(() => expect(screen.getByRole('button', { name: '重试详情' })).toBeEnabled(), { timeout: 10000 });
      expect(screen.queryByRole('heading', { name: goal.title })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '重试详情' }));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(5), { timeout: 10000 });
      expect(screen.queryByRole('heading', { name: goal.title })).toBeNull();
      await act(async () => { acceptedRetry.resolve({ epoch: fixtureTaskEpoch(projectId), detail: goal }); await acceptedRetry.promise; });
      await screen.findByRole('heading', { name: goal.title }, { timeout: 10000 });
      expect(await screen.findByRole('textbox', { name: '讨论消息' }, { timeout: 10000 })).toHaveValue('');
    } finally { view.unmount(); }
  }, 20000);

  it('does not reopen a child Task when the Goal returns in a new epoch', async () => {
    const goal = detailFixture(projectId, taskId, { type: 'goal', title: 'Release goal', ready: false });
    const child = detailFixture(projectId, otherId, { title: 'Goal child', parentId: taskId });
    const fixture = installed(goal);
    fixture.tasks.set(otherId, child);
    const graph = graphFixture([goal, child]);
    const original = taskSyncFromGraph(graph, { versionForTask: () => 1n, propertiesForTask: (task) => fixture.tasks.get(task.id)!.properties });
    const { [taskId]: _goalState, ...dependencyStates } = original.dependencyStates;
    const replacement = '40000000-0000-4000-8000-000000000001';
    let epoch = original.epoch;
    vi.spyOn(client, 'getTaskSync').mockImplementation(async (_projectId, query) => taskSyncReadFixture({ ...original, epoch,
      mode: query.epoch === epoch ? 'delta' : 'snapshot', dependencyStates }));
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const view = render(<TaskDetailPage projectId={projectId} taskId={taskId} navigation={{ tab: 'overview', path: null }} />, { taskCache: { scope } });
    try {
      const opener = await screen.findByRole('button', { name: /Goal child/ }, { timeout: 10000 });
      fireEvent.click(opener);
      await screen.findByRole('dialog', { name: child.title }, { timeout: 10000 });
      const fence = await scope.beginTaskRead(projectId, taskId, 0, 0, scope.signal);
      epoch = replacement;
      rememberTaskEpoch(projectId, replacement);
      await act(async () => { expect(await scope.observeHistory(fence, replacement, scope.signal)).toBe('retired'); });
      await screen.findByRole('heading', { name: goal.title }, { timeout: 10000 });
      await screen.findByRole('button', { name: /Goal child/ }, { timeout: 10000 });
      expect(screen.queryByRole('dialog', { name: child.title })).toBeNull();
    } finally { view.unmount(); scope.dispose(); }
  }, 20000);

  it('does not render a delayed Goal detail after its epoch is retired', async () => {
    const goal = detailFixture(projectId, taskId, { type: 'goal', title: 'Obsolete Goal', ready: false });
    const fixture = installed(goal);
    const graph = graphFixture([goal]);
    const sync = taskSyncFromGraph(graph, { versionForTask: () => goal.version, propertiesForTask: () => goal.properties });
    vi.spyOn(client, 'getTaskSync').mockResolvedValue(taskSyncReadFixture({ ...sync, dependencyStates: {} }));
    const delayed = Promise.withResolvers<client.TaskObservation>();
    const read = vi.spyOn(client, 'getTaskObservation').mockReturnValueOnce(delayed.promise).mockRejectedValue(new client.ApiError('network'));
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const view = render(<TaskDetailPage projectId={projectId} taskId={taskId} navigation={{ tab: 'overview', path: null }} />, { taskCache: { scope } });
    try {
      await waitFor(() => expect(read).toHaveBeenCalled(), { timeout: 10000 });
      await waitFor(() => expect(scope.getAuthorizedProject(projectId)).not.toBeNull(), { timeout: 10000 });
      const fence = await scope.beginTaskRead(projectId, taskId, 0, 0, scope.signal);
      await act(async () => { expect(await scope.observeHistory(fence, '40000000-0000-4000-8000-000000000001', scope.signal)).toBe('retired'); });
      await act(async () => { delayed.resolve({ epoch: fixtureTaskEpoch(projectId), detail: goal }); await delayed.promise; });
      expect(screen.queryByRole('heading', { name: goal.title })).toBeNull();
      expect(fixture.fetcher.mock.calls.some(([url]) => url.includes('/attachments?'))).toBe(false);
    } finally { view.unmount(); scope.dispose(); }
  });

  it('retires the Goal and ignores late attachment and discussion responses after a new epoch', async () => {
    const goal = detailFixture(projectId, taskId, { type: 'goal', title: 'Private old Goal', ready: false });
    const fixture = installed(goal);
    const graph = graphFixture([goal]);
    const sync = taskSyncFromGraph(graph, { versionForTask: () => goal.version, propertiesForTask: () => goal.properties });
    vi.spyOn(client, 'getTaskSync').mockResolvedValue(taskSyncReadFixture({ ...sync, dependencyStates: {} }));
    const pending = Promise.withResolvers<Response>();
    const pendingThread = Promise.withResolvers<Response>();
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => url.includes('/attachments?') ? pending.promise : url.includes('/thread/messages?') ? pendingThread.promise : fixture.handler(url, options));
    vi.stubGlobal('fetch', fetcher);
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const view = render(<TaskDetailPage projectId={projectId} taskId={taskId} navigation={{ tab: 'discussion', path: null }} />, { taskCache: { scope } });
    try {
      await screen.findByRole('heading', { name: goal.title }, { timeout: 10000 });
      await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('/attachments?'))).toBe(true), { timeout: 10000 });
      await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('/thread/messages?'))).toBe(true), { timeout: 10000 });
      const fence = await scope.beginTaskRead(projectId, taskId, 0, 0, scope.signal);
      await act(async () => { expect(await scope.observeHistory(fence, '40000000-0000-4000-8000-000000000001', scope.signal)).toBe('retired'); });
      expect(screen.queryByRole('heading', { name: goal.title })).toBeNull();
      await act(async () => { pending.resolve(resourceResponse({ items: [{ path: 'old-private.txt', contentType: 'text/plain', sizeBytes: 1, createdAt: goal.createdAt, updatedAt: goal.updatedAt }], nextCursor: null })); await pending.promise; });
      await act(async () => { pendingThread.resolve(resourceResponse({ items: [{ id: otherId, author: { userId: TEST_VIEWER_ID, displayName: 'Alice', Agent: false }, body: 'old-private-discussion', createdAt: goal.createdAt }], hasMoreBefore: false, hasMoreAfter: false }, TEST_VIEWER_ID)); await pendingThread.promise; });
      expect(screen.queryByText('old-private.txt')).toBeNull();
      expect(screen.queryByText('old-private-discussion')).toBeNull();
      expect(screen.queryByRole('heading', { name: goal.title })).toBeNull();
    } finally { view.unmount(); scope.dispose(); }
  });

  it('opens a direct Goal without starting Task session or Steps requests', async () => {
    const goal = detailFixture(projectId, taskId, { type: 'goal', title: 'Release goal', ready: false });
    const fixture = installed(goal);
    const graph = graphFixture([goal]);
    const sync = taskSyncFromGraph(graph, { versionForTask: () => goal.version, propertiesForTask: () => goal.properties });
    vi.spyOn(client, 'getTaskSync').mockResolvedValue(taskSyncReadFixture({ ...sync, dependencyStates: {} }));
    const view = render(<TaskDetailPage projectId={projectId} taskId={taskId} navigation={{ tab: 'overview', path: null }} />);
    try {
      await screen.findByRole('heading', { name: goal.title });
      expect(screen.getByRole('tab', { name: 'Task' })).toBeVisible();
      expect(fixture.fetcher.mock.calls.some(([url]) => /\/(sessions|steps)(?:\?|$)/.test(url))).toBe(false);
    } finally { view.unmount(); }
  });
});
