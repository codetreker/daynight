import { stringifyWireJson } from "./helpers/wireJson";
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createLocaleRender } from './helpers/renderWithLocale';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../src/api/types';
import { ProjectsPage } from '../src/features/projects/ProjectsPage';
import { ProjectsProvider } from '../src/features/projects/ProjectsProvider';

const render = createLocaleRender('zh-CN');

const project = (index: number, overrides: Partial<Project> = {}): Project => ({ settings: { version: 1n, executionWarningMinutes: 60 },
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  name: `项目 ${index}`,
  repoUrl: `https://github.com/example/project-${index}`,
  createdAt: '2026-10-20T09:00:00.123456789Z',
  updatedAt: '2026-10-20T09:00:00.123456789Z',
  ...overrides,
});

const response = (items: readonly Project[], nextCursor: string | null = null) =>
  new Response(stringifyWireJson({ items, nextCursor }), { headers: { 'Content-Type': 'application/json' } });

const failure = (requestId = 'request-123') => new Response(JSON.stringify({
  error: { code: 'internal_error', message: 'private database connection string', requestId },
}), { status: 500, headers: { 'Content-Type': 'application/json' } });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('project browsing', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/'); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('loads all projects across pages, preserves server order, and deduplicates shared page items', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.stubGlobal('fetch', fetch);
    render(<ProjectsProvider><ProjectsPage /></ProjectsProvider>);
    expect(screen.getByRole('status').textContent).toContain('正在加载项目');
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/projects?limit=50');
    await act(async () => { first.resolve(response(Array.from({ length: 50 }, (_, index) => project(index + 1)), 'next/+ cursor')); });
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(screen.queryByText(/项目总数/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect((screen.getByRole('button', { name: '正在加载更多…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    await act(async () => { second.resolve(response([project(50), project(51)])); });
    expect(screen.getByRole('heading', { name: '项目 51' })).toBeTruthy();
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/v1/projects?limit=50&cursor=next%2F%2B+cursor');
    expect(screen.getAllByRole('listitem')).toHaveLength(51);
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(
      Array.from({ length: 51 }, (_, index) => `项目 ${index + 1}`),
    );
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
    expect(screen.getByText('已加载全部项目')).toBeTruthy();
    for (const [index, heading] of headings.entries()) {
      expect(heading).toHaveAccessibleName(`项目 ${index + 1}`);
      expect(heading.closest('a')?.getAttribute('href')).toBe(`/projects/${project(index + 1).id}`);
    }
  });

  it('shows a safe first-load network error and retries into the empty state', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('private token')).mockResolvedValueOnce(response([]));
    vi.stubGlobal('fetch', fetch);
    render(<ProjectsProvider><ProjectsPage /></ProjectsProvider>);
    await screen.findByRole('alert');
    expect(screen.getByText('无法连接服务，请检查本地服务后重试。')).toBeTruthy();
    expect(screen.queryByText(/private token/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByRole('heading', { name: '还没有项目' });
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('exposes only a safe request ID for server errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failure()));
    render(<ProjectsProvider><ProjectsPage /></ProjectsProvider>);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('项目加载失败');
    expect(alert.textContent).toContain('request-123');
    expect(alert.textContent).not.toContain('private database');
  });

  it('shows malformed responses as a visible load failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
    render(<ProjectsProvider><ProjectsPage /></ProjectsProvider>);
    expect((await screen.findByRole('alert')).textContent).toContain('暂时无法读取项目，请重试。');
    expect(screen.queryByText('还没有项目')).toBeNull();
  });

  it('retains loaded cards when a continuation fails and retries the same cursor', async () => {
    const continuation = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response([project(1)], 'page-two'))
      .mockReturnValueOnce(continuation.promise).mockResolvedValueOnce(response([project(2)]));
    vi.stubGlobal('fetch', fetch);
    render(<ProjectsProvider><ProjectsPage /></ProjectsProvider>);
    await screen.findByRole('heading', { name: '项目 1' });
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect((screen.getByRole('button', { name: '正在加载更多…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { continuation.resolve(failure('continuation-456')); });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('已加载的项目仍可查看');
    expect(alert.textContent).toContain('continuation-456');
    expect(screen.getByRole('heading', { name: '项目 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试加载更多' }));
    await screen.findByRole('heading', { name: '项目 2' });
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/v1/projects?limit=50&cursor=page-two');
    expect(fetch.mock.calls[2]?.[0]).toBe(fetch.mock.calls[1]?.[0]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('refreshes from page one, cancels continuation, and ignores its late response', async () => {
    const oldPage = deferred<Response>();
    const freshPage = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response([project(1)], 'old-cursor'))
      .mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(freshPage.promise);
    vi.stubGlobal('fetch', fetch);
    render(<ProjectsProvider><ProjectsPage /></ProjectsProvider>);
    await screen.findByRole('heading', { name: '项目 1' });
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    const oldSignal = fetch.mock.calls[1]?.[1].signal as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(oldSignal.aborted).toBe(true);
    expect(screen.queryByRole('heading', { name: '项目 1' })).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(fetch.mock.calls[2]?.[0]).toBe('/api/v1/projects?limit=50');
    await act(async () => { freshPage.resolve(response([project(3)])); });
    await screen.findByRole('heading', { name: '项目 3' });
    await act(async () => { oldPage.resolve(response([project(2)])); });
    expect(screen.queryByRole('heading', { name: '项目 2' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('ignores a superseded first-page failure and keeps the newer result', async () => {
    const oldPage = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(oldPage.promise).mockResolvedValueOnce(response([project(4)]));
    vi.stubGlobal('fetch', fetch);
    render(<ProjectsProvider><ProjectsPage /></ProjectsProvider>);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('heading', { name: '项目 4' });
    await act(async () => { oldPage.reject(new Error('late failed request')); });
    expect(screen.getByRole('heading', { name: '项目 4' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cancels the active request on unmount without displaying a cancellation error', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal('fetch', fetch);
    const view = render(<ProjectsProvider><ProjectsPage /></ProjectsProvider>);
    const signal = fetch.mock.calls[0]?.[1].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(response([project(9)])); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('heading', { name: '项目 9' })).toBeNull();
  });

  it('renders untrusted names and repository addresses as plain text and preserves exact timestamp order', async () => {
    const name = '<img src=x onerror=alert(1)>'.repeat(10);
    const repo = 'javascript:alert(1)/'.repeat(20);
    const items = [
      project(2, { name, repoUrl: repo, createdAt: '2026-10-20T09:00:00.000000002Z' }),
      project(1, { createdAt: '2026-10-20T09:00:00.000000001Z' }),
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(items)));
    const view = render(<ProjectsProvider><ProjectsPage /></ProjectsProvider>);
    await screen.findByRole('heading', { name });
    expect(screen.getByText(repo)).toBeTruthy();
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('script')).toBeNull();
    const cards = screen.getAllByRole('listitem');
    expect(within(cards[0]!).getByRole('heading').textContent).toBe(name);
    expect(cards[0]!.querySelector('time')?.getAttribute('datetime')).toBe(items[0]!.createdAt);
    expect(cards[0]!.querySelector('a')?.getAttribute('href')).toBe(`/projects/${items[0]!.id}`);
    expect(cards[1]!.querySelector('a')?.getAttribute('href')).toBe(`/projects/${items[1]!.id}`);
  });

  it('keeps modified card clicks available to normal browser navigation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([project(1)])));
    render(<ProjectsProvider><ProjectsPage /></ProjectsProvider>);
    await screen.findByRole('heading', { name: '项目 1' });
    const card = screen.getByRole('heading', { name: '项目 1' }).closest('a')!;
    let intercepted = true;
    const preventNavigation = (event: Event) => { intercepted = event.defaultPrevented; event.preventDefault(); };
    document.addEventListener('click', preventNavigation);
    fireEvent.click(card, { ctrlKey: true });
    document.removeEventListener('click', preventNavigation);
    expect(intercepted).toBe(false);
    expect(window.location.pathname).toBe('/');
  });

  it('ignores repeated continuation clicks while the page is loading', async () => {
    const more = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response([project(1)], 'cursor')).mockReturnValueOnce(more.promise);
    vi.stubGlobal('fetch', fetch);
    render(<ProjectsProvider><ProjectsPage /></ProjectsProvider>);
    await screen.findByRole('heading', { name: '项目 1' });
    const button = screen.getByRole('button', { name: '加载更多' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => { more.resolve(response([project(2)])); });
    await waitFor(() => { expect(screen.getAllByRole('listitem')).toHaveLength(2); });
  });
});
