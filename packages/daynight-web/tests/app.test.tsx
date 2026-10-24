import { TEST_VIEWER_ID, taskSyncResponse, taskSyncQuery } from "./helpers/taskSync";
import { withDetailResources } from './helpers/taskDetail';
import { stringifyWireJson } from "./helpers/wireJson";
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { createLocaleRender } from './helpers/renderWithLocale';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/App';

const localeRender = createLocaleRender('zh-CN');
const render: typeof localeRender = (ui, options) => localeRender(ui, { ...options, taskCache: true });

const projectId = '00000000-0000-4000-8000-000000000001';
const projectPage = () => new Response(stringifyWireJson({ items: [{ settings: { version: 1n, executionWarningMinutes: 60 },
  id: projectId, name: '真实项目', repoUrl: 'https://github.com/example/repo',
  createdAt: '2026-10-20T09:00:00Z', updatedAt: '2026-10-20T09:00:00Z',
}], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });

const taskGraph = (url: string) => taskSyncResponse({ observedAt: "2026-10-20T12:00:00Z",
  project: { settings: { version: 1n, executionWarningMinutes: 60 }, id: projectId, name: '项目任务页面', repoUrl: 'https://github.com/example/repo',
    createdAt: '2026-10-20T09:00:00Z', updatedAt: '2026-10-20T09:00:00Z' },
  tasks: [], summary: { total: 0, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 },
}, { viewerId: TEST_VIEWER_ID, versionForTask: () => 1n, query: taskSyncQuery(new URL(url, location.origin)) });

describe('application navigation', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => new URL(url, location.origin).pathname.endsWith('/task-sync') ? taskGraph(url) : projectPage()));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('navigates via real card hrefs, focuses the main content, and restores the list through browser back and forward', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: '真实项目' });
    expect(document.title).toBe('项目 · Daynight');
    expect(screen.getByRole('link', { name: '项目' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('heading', { name: '真实项目' }).closest('a')!);
    expect(window.location.pathname).toBe(`/projects/${projectId}`);
    await screen.findByRole('heading', { name: '项目任务页面' });
    expect(document.title).toBe('项目任务 · Daynight');
    expect(document.activeElement).toBe(screen.getByRole('main'));
    expect(screen.queryByRole('heading', { name: '真实项目' })).toBeNull();
    await act(async () => { window.history.back(); });
    await screen.findByRole('heading', { name: '真实项目' });
    expect(window.location.pathname).toBe('/');
    await act(async () => { window.history.forward(); });
    await screen.findByRole('heading', { name: '项目任务页面' });
    expect(window.location.pathname).toBe(`/projects/${projectId}`);
  });

  it.each(['/unknown', '/projects/not-a-uuid'])('returns from an unregistered route %s through the visible list link', async (path) => {
    window.history.replaceState(null, '', path);
    render(<App />);
    expect(screen.getByRole('heading', { name: '页面不存在' })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('link', { name: '返回项目列表' }));
    await screen.findByRole('heading', { name: '真实项目' });
    expect(window.location.pathname).toBe('/');
  });

  it('loads a valid project deep link through the summary sync API', async () => {
    window.history.replaceState(null, '', `/projects/${projectId}`);
    render(<App />);
    await screen.findByRole('heading', { name: '项目任务页面' });
    expect(fetch).toHaveBeenCalledWith(`/api/v1/projects/${projectId}/task-sync`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByRole('heading', { name: '还没有任务' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '项目' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('link', { name: '← 项目' }));
    await screen.findByRole('heading', { name: '真实项目' });
  });

  it('opens a standalone attachment route outside workspace chrome and the task dialog', async () => {
    const taskId = '00000000-0000-4000-8000-000000000002';
    window.history.replaceState(null, '', `/projects/${projectId}/tasks/${taskId}/attachments/docs/guide.md`);
    const list = { items: [{ path: 'docs/guide.md', contentType: 'text/markdown', sizeBytes: 12, createdAt: '2026-10-20T09:00:00Z', updatedAt: '2026-10-20T09:00:00Z' }], nextCursor: null };
    vi.stubGlobal('fetch', vi.fn(withDetailResources(projectId, taskId, async (url: string) => url.includes('/attachments?') ? new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json' } }) : new Response('# Standalone document'))));
    render(<App />);
    await screen.findByRole('heading', { name: 'Standalone document' });
    expect(document.title).toBe('任务详情 · Daynight');
    expect(screen.getByRole('main')).toHaveFocus();
    expect(document.querySelector('.shell')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('combobox', { name: '语言 / Language' })).toBeVisible();
    fireEvent.change(screen.getByRole('combobox', { name: '语言 / Language' }), { target: { value: 'en' } });
    expect(document.title).toBe('Task details · Daynight');
    expect(screen.getByRole('link', { name: 'Download' })).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('keeps the standalone panel and draft mounted through selection and browser history', async () => {
    const taskId = '00000000-0000-4000-8000-000000000002';
    const address = (path: string) => `/projects/${projectId}/tasks/${taskId}/attachments/${path}`;
    window.history.replaceState(null, '', address('docs/guide.md'));
    const items = ['docs/guide.md', 'other/next.txt'].map((path) => ({ path, contentType: 'text/plain', sizeBytes: 12, createdAt: '2026-10-20T09:00:00Z', updatedAt: '2026-10-20T09:00:00Z' }));
    const list = { items, nextCursor: null };
    const requests = vi.fn(withDetailResources(projectId, taskId, async (url: string) => url.includes('/attachments?') ? new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json' } }) : new Response(url.endsWith('guide.md') ? 'Initial document' : 'Next document')));
    vi.stubGlobal('fetch', requests);
    render(<App />);
    await screen.findByText('Initial document');
    const panel = document.querySelector('.task-attachments');
    const directory = screen.getByText('docs', { selector: 'summary' }).parentElement!;
    fireEvent.click(screen.getByText('docs', { selector: 'summary' }));
    const upload = screen.getByText('上传文件', { selector: 'summary' });
    fireEvent.click(upload);
    const target = screen.getByLabelText('目标相对路径');
    fireEvent.change(target, { target: { value: 'unsent/draft.txt' } });
    fireEvent.click(screen.getByRole('button', { name: /^next\.txt/ }));
    await screen.findByText('Next document');
    expect(window.location.pathname).toBe(address('other/next.txt'));
    expect(document.querySelector('.task-attachments')).toBe(panel);
    expect(directory).not.toHaveAttribute('open');
    expect(screen.getByLabelText('目标相对路径')).toBe(target);
    expect(target).toHaveValue('unsent/draft.txt');
    await act(async () => { window.history.back(); });
    await screen.findByText('Initial document');
    expect(window.location.pathname).toBe(address('docs/guide.md'));
    expect(document.querySelector('.task-attachments')).toBe(panel);
    expect(target).toHaveValue('unsent/draft.txt');
    await act(async () => { window.history.forward(); });
    await screen.findByText('Next document');
    expect(requests.mock.calls.filter(([url]) => url.includes('/attachments?'))).toHaveLength(1);
  });

  it('uses the sidebar and breadcrumb as keyboard-accessible navigation controls', async () => {
    window.history.replaceState(null, '', '/unknown');
    render(<App />);
    const sidebar = screen.getByRole('link', { name: '项目' });
    sidebar.focus();
    expect(document.activeElement).toBe(sidebar);
    fireEvent.click(sidebar);
    await screen.findByRole('heading', { name: '真实项目' });
    window.history.pushState(null, '', '/another');
    fireEvent.popState(window);
    fireEvent.click(screen.getByRole('link', { name: '工作空间' }));
    await screen.findByRole('heading', { name: '真实项目' });
    expect(screen.getByRole('link', { name: '跳到主要内容' }).getAttribute('href')).toBe('#main-content');
  });

  it('cancels list requests when navigation unmounts the list and ignores late data', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    window.history.pushState(null, '', '/unknown');
    fireEvent.popState(window);
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve(projectPage()); });
    expect(screen.getByRole('heading', { name: '页面不存在' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '真实项目' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('preserves modified clicks on global navigation links', async () => {
    window.history.replaceState(null, '', '/unknown');
    render(<App />);
    const brand = screen.getByRole('link', { name: 'Daynight 项目首页' });
    let intercepted = true;
    const preventNavigation = (event: Event) => { intercepted = event.defaultPrevented; event.preventDefault(); };
    document.addEventListener('click', preventNavigation);
    fireEvent.click(brand, { metaKey: true });
    document.removeEventListener('click', preventNavigation);
    expect(intercepted).toBe(false);
    await waitFor(() => { expect(window.location.pathname).toBe('/unknown'); });
  });
});
