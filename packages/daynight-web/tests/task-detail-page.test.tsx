import { createTaskSessionWorld } from './helpers/taskSessions';
import { TEST_VIEWER_ID, taskSyncResponse, taskSyncQuery, viewerHeaders } from "./helpers/taskSync";
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/App';
import { AuthenticatedApp } from '../src/app/AuthenticatedApp';
import { navigateTaskDetail, taskDetailUrl } from '../src/app/router';
import { TaskDetailDialog } from '../src/features/task-detail/TaskDetailDialog';
import type { TaskDetail } from '../src/api/types';
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
    if (new URL(url, location.origin).pathname === `${root}/task-sync`) return taskSyncResponse(graphFixture([...tasks.values()]), { viewerId: TEST_VIEWER_ID, query: taskSyncQuery(new URL(url, location.origin)), versionForTask: (task) => tasks.get(task.id)!.version });
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
      return resourceResponse(task, TEST_VIEWER_ID);
    }
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
    fireEvent.click(screen.getByRole('button', { name: '后续任务，普通依赖' }));
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
    fireEvent.click(screen.getByRole('button', { name: '后续任务，普通依赖' }));
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

  it('exposes real graph failures without loading fabricated task relationships and retries the graph owner', async () => {
    const fixture = installed();
    fixture.fetcher.mockImplementationOnce(async () => resourceResponse({ error: { code: 'internal_error', message: 'private error', requestId: 'graph-failure' } }));
    fixture.fetcher.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: 'internal_error', message: 'private error', requestId: 'graph-failure' } }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
    window.history.replaceState(null, '', address());
    render(<App />);
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('private error');
    expect(screen.queryByText('无后续任务')).toBeNull();
    expect(fixture.fetcher.mock.calls.some(([url]) => url === `${root}/tasks/${taskId}`)).toBe(false);
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByRole('heading', { name: '独立任务' });
  });

  it('reuses full details after an unchanged five-second graph receipt while retaining the mounted view', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fixture = installed();
    window.history.replaceState(null, '', address());
    render(<App />);
    const title = await screen.findByRole('heading', { name: '独立任务' });
    const body = document.querySelector('.task-detail-body');
    expect(fixture.fetcher.mock.calls.filter(([url]) => url === `${root}/tasks/${taskId}`)).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(fixture.fetcher.mock.calls.filter(([url]) => new URL(url, location.origin).pathname.endsWith('/task-sync'))).toHaveLength(2));
    expect(fixture.fetcher.mock.calls.filter(([url]) => url === `${root}/tasks/${taskId}`)).toHaveLength(1);
    expect(screen.getByRole('heading', { name: '独立任务' })).toBe(title);
    expect(document.querySelector('.task-detail-body')).toBe(body);
    expect(screen.queryByRole('status')).toBeNull();
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
    expect(platform).toHaveValue('linux');
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
      const popout = within(dialog).getByRole('link', { name: '在新标签页打开' });
      expect(popout).toHaveAttribute('href', address());
      expect(popout).toHaveAttribute('target', '_blank');
      expect(popout).toHaveAttribute('rel', 'noopener noreferrer');
      fireEvent.click(within(dialog).getByRole('tab', { name: '附件' }));
      fireEvent.click(await within(dialog).findByRole('button', { name: /^guide\.md/ }));
      await within(dialog).findByText('方案正文');
      expect(popout).toHaveAttribute('href', address('attachments', 'docs/guide.md'));
      fireEvent.click(within(dialog).getByRole('tab', { name: '概览' }));
      expect(popout).toHaveAttribute('href', address('overview', 'docs/guide.md'));
      fireEvent.click(within(dialog).getByRole('tab', { name: '附件' }));
      fireEvent.click(within(dialog).getByRole('button', { name: '更多操作：docs/guide.md' }));
      fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
      const deletion = screen.getByRole('dialog', { name: '删除附件？' });
      fireEvent.click(within(deletion).getByRole('button', { name: '删除附件' }));
      await within(dialog).findByText('选择文件查看预览或下载。');
      expect(popout).toHaveAttribute('href', address('attachments'));
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
    window.history.replaceState(null, '', address('overview', 'docs/guide.md') + '&authError=login_failed');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/v1/me' ? new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }) : resourceResponse({ providers: ['github'] })));
    const login = vi.fn();
    localeRender(<AuthenticatedApp navigateToLogin={login} />);
    fireEvent.click(await screen.findByRole('button', { name: '使用 GitHub 登录' }));
    const parameters = new URL(login.mock.calls[0]![0], window.location.origin).searchParams;
    expect(parameters.get('returnPath')).toBe(address('overview', 'docs/guide.md'));
  });
});
