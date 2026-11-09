import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { openDB } from 'idb';
import { createLocaleRender } from './helpers/renderWithLocale';
import { stringifyWireJson } from './helpers/wireJson';
import { ProjectsProvider } from '../src/features/projects/ProjectsProvider';
import { ProjectsPage } from '../src/features/projects/ProjectsPage';
import { createTaskCacheScope } from '../src/features/task-cache/project-cache';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from '../src/features/task-cache/database';
import type { Project } from '../src/api/types';

const render = createLocaleRender('zh-CN');
const userId = '00000000-0000-4000-8000-000000000221';
const project = (id: string, name: string): Project => ({ id, name, repoUrl: `https://example.com/${name}`, createdAt: '2026-10-20T09:00:00Z', updatedAt: '2026-10-20T09:00:00Z', ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 } });
const lost = project('10000000-0000-4000-8000-000000000021', 'Lost project');
const healthy = project('10000000-0000-4000-8000-000000000022', 'Healthy project');
const page = (items: Project[], nextCursor: string | null = null) => new Response(stringifyWireJson({ items, nextCursor }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
class Channel {
  static channels = new Set<Channel>();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(readonly name: string) { Channel.channels.add(this); }
  postMessage(data: unknown) { for (const peer of Channel.channels) if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data } as MessageEvent<unknown>)); }
  close() { Channel.channels.delete(this); }
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Channel.channels.clear(); });

it('withdraws a cold peer directory, fences a late page and accepts a fresh regrant without accepting an old hint', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const owner = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const peer = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const signal = new AbortController().signal;
  const ticket = await owner.beginSync(lost.id, signal);
  let resolvePage!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { resolvePage = resolve; });
  const fetcher = vi.fn().mockResolvedValueOnce(page([lost, healthy], 'next')).mockReturnValueOnce(pending).mockResolvedValueOnce(page([lost, healthy]));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<ProjectsProvider admission={peer}><ProjectsPage /></ProjectsProvider>);
  await screen.findByRole('heading', { name: 'Lost project' }, { timeout: 10000 });
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  await act(async () => { await owner.revokeProject(ticket, signal); });
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Lost project' })).toBeNull());
  expect(screen.getByRole('heading', { name: 'Healthy project' })).toBeTruthy();
  await act(async () => { resolvePage(page([lost])); });
  expect(screen.queryByRole('heading', { name: 'Lost project' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByRole('heading', { name: 'Lost project' }, { timeout: 10000 });
  const injector = new Channel('daynight-task-cache');
  await act(async () => { injector.postMessage({ userId, projectId: lost.id, userFence: ticket.userFence, revokedGeneration: ticket.cacheGeneration }); await Promise.resolve(); });
  expect(screen.getByRole('heading', { name: 'Lost project' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Healthy project' })).toBeTruthy();
  injector.close(); view.unmount(); owner.dispose(); peer.dispose();
}, 20000);

it('keeps the affected project hidden and exposes cleanup failure while healthy projects remain usable', async () => {
  const { IDBObjectStore } = await import('fake-indexeddb');
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const signal = new AbortController().signal;
  const ticket = await scope.beginSync(lost.id, signal);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(page([lost, healthy]))));
  const view = render(<ProjectsProvider admission={scope}><ProjectsPage /></ProjectsProvider>);
  await screen.findByRole('heading', { name: 'Lost project' }, { timeout: 10000 });
  const original = IDBObjectStore.prototype.put;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'projects' && (args[0] as { state?: string }).state === 'invalidated') throw new DOMException('Injected storage failure', 'QuotaExceededError');
    return original.apply(this, args);
  });
  await act(async () => { await expect(scope.revokeProject(ticket, signal, false)).rejects.toMatchObject({ category: 'storage' }); });
  expect(screen.queryByRole('heading', { name: 'Lost project' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Healthy project' })).toBeTruthy();
  expect(screen.getByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Healthy project' })).toBeTruthy());
  expect(screen.queryByRole('heading', { name: 'Lost project' })).toBeNull();
  expect(screen.getByRole('alert')).toBeTruthy();
  fault.mockRestore();
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByRole('heading', { name: 'Lost project' }, { timeout: 10000 });
  expect(screen.queryByRole('alert')).toBeNull();
  view.unmount(); scope.dispose();
});

it('withdraws a suspended project and refreshes it after access is restored without removing healthy entries', async () => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(page([lost, healthy]))));
  const view = render(<ProjectsProvider admission={scope}><ProjectsPage /></ProjectsProvider>);
  await screen.findByRole('heading', { name: 'Lost project' }, { timeout: 10000 });
  await act(async () => scope.suspendProject(lost.id));
  expect(screen.queryByRole('heading', { name: 'Lost project' })).toBeNull();
  const retained = screen.getByRole('heading', { name: 'Healthy project' });
  await act(async () => scope.resumeProject(lost.id));
  await screen.findByRole('heading', { name: 'Lost project' }, { timeout: 10000 });
  expect(screen.getByRole('heading', { name: 'Healthy project' })).toBe(retained);
  expect(screen.getAllByRole('listitem').map(item => item.querySelector('h2')?.textContent)).toEqual(['Lost project', 'Healthy project']);
  view.unmount(); scope.dispose();
}, 20000);

it('rechecks all loaded pages on access restoration and preserves unrelated focus', async () => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const second = Promise.withResolvers<Response>();
  const added = project('10000000-0000-4000-8000-000000000023', 'New project');
  const fetcher = vi.fn().mockResolvedValueOnce(page([healthy], 'next')).mockResolvedValueOnce(page([lost]))
    .mockResolvedValueOnce(page([healthy], 'next')).mockReturnValueOnce(second.promise).mockResolvedValueOnce(page([added]));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<ProjectsProvider admission={scope}><ProjectsPage /></ProjectsProvider>);
  const heading = await screen.findByRole('heading', { name: 'Healthy project' }, { timeout: 10000 });
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await screen.findByRole('heading', { name: 'Lost project' }, { timeout: 10000 });
  const link = heading.closest('a')!; link.focus();
  await act(async () => scope.suspendProject(lost.id));
  expect(screen.queryByRole('heading', { name: 'Lost project' })).toBeNull();
  await act(async () => scope.resumeProject(lost.id));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4), { timeout: 10000 });
  expect(screen.getByRole('heading', { name: 'Healthy project' })).toBe(heading);
  expect(document.activeElement).toBe(link);
  await act(async () => second.resolve(page([lost], 'third')));
  await screen.findByRole('heading', { name: 'Lost project' }, { timeout: 10000 });
  expect(screen.getByRole('button', { name: '加载更多' })).toBeTruthy();
  expect(document.activeElement).toBe(link);
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await screen.findByRole('heading', { name: 'New project' }, { timeout: 10000 });
  expect(String(fetcher.mock.calls[4]?.[0])).toContain('cursor=third');
  view.unmount(); scope.dispose();
}, 20000);

it('keeps loading more usable while a restoration reread is pending', async () => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const pending = Promise.withResolvers<Response>();
  const added = project('10000000-0000-4000-8000-000000000024', 'Later project');
  const fetcher = vi.fn().mockResolvedValueOnce(page([healthy, lost], 'next')).mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(page([added])).mockResolvedValueOnce(page([healthy, lost], 'next')).mockResolvedValueOnce(page([added]));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<ProjectsProvider admission={scope}><ProjectsPage /></ProjectsProvider>);
  await screen.findByRole('heading', { name: 'Lost project' }, { timeout: 10000 });
  await act(async () => scope.suspendProject(lost.id));
  await act(async () => scope.resumeProject(lost.id));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), { timeout: 10000 });
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await screen.findByRole('heading', { name: 'Later project' }, { timeout: 10000 });
  await screen.findByRole('heading', { name: 'Lost project' }, { timeout: 10000 });
  await act(async () => pending.resolve(page([healthy, lost], 'next')));
  expect(screen.getByRole('heading', { name: 'Healthy project' })).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(5);
  view.unmount(); scope.dispose();
}, 20000);

it('resumes an access restoration after another project is withdrawn during its read', async () => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn().mockResolvedValueOnce(page([lost, healthy])).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page([lost]));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<ProjectsProvider admission={scope}><ProjectsPage /></ProjectsProvider>);
  await screen.findByRole('heading', { name: 'Lost project' }, { timeout: 10000 });
  await act(async () => scope.suspendProject(lost.id));
  await act(async () => scope.resumeProject(lost.id));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), { timeout: 10000 });
  await act(async () => scope.suspendProject(healthy.id));
  await screen.findByRole('heading', { name: 'Lost project' }, { timeout: 10000 });
  expect(screen.queryByRole('heading', { name: 'Healthy project' })).toBeNull();
  await act(async () => pending.resolve(page([lost, healthy])));
  expect(screen.queryByRole('heading', { name: 'Healthy project' })).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);
  view.unmount(); scope.dispose();
}, 20000);

it.each([
  ['corrupt', 'continuation'], ['corrupt', 'restoration'], ['storage', 'continuation'], ['storage', 'restoration'],
] as const)('withdraws retained projections on %s storage failure before a %s response', async (failure, mode) => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const signal = new AbortController().signal;
  await scope.beginSync(lost.id, signal);
  const trigger = project('10000000-0000-4000-8000-000000000025', 'Restoration trigger');
  const pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn().mockResolvedValueOnce(page([lost, healthy, trigger], mode === 'continuation' ? 'next' : null)).mockReturnValueOnce(pending.promise);
  vi.stubGlobal('fetch', fetcher);
  const view = render(<ProjectsProvider admission={scope}><ProjectsPage /></ProjectsProvider>);
  await screen.findByRole('heading', { name: 'Lost project' }, { timeout: 10000 });
  const healthyHeading = screen.getByRole('heading', { name: 'Healthy project' });
  const healthyLink = healthyHeading.closest('a')!;
  healthyLink.focus();
  let fault: ReturnType<typeof vi.spyOn> | undefined;
  if (failure === 'corrupt') {
    const db = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
    const row = await db.get('projects', [userId, lost.id]);
    await db.put('projects', { ...row!, cacheGeneration: 'invalid' });
    db.close();
  } else {
    const original = IDBObjectStore.prototype.get;
    fault = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'userScopes') throw new DOMException('Injected storage failure', 'QuotaExceededError');
      return original.apply(this, args);
    });
  }
  if (mode === 'continuation') fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  else {
    await act(async () => scope.suspendProject(trigger.id));
    await act(async () => scope.resumeProject(trigger.id));
  }
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), { timeout: 10000 });
  expect(screen.queryByRole('heading', { name: 'Lost project' })).toBeNull();
  expect(screen.queryByText(lost.repoUrl)).toBeNull();
  if (failure === 'corrupt') {
    expect(screen.getByRole('heading', { name: 'Healthy project' })).toBe(healthyHeading);
    expect(document.activeElement).toBe(healthyLink);
  }
  else expect(screen.queryByRole('heading', { name: 'Healthy project' })).toBeNull();
  expect(screen.getByRole('alert')).toBeTruthy();
  if (failure === 'storage') {
    fault?.mockRestore();
    await scope.prepareProjection(signal);
    expect(scope.projectionError).toBeNull();
  }
  await act(async () => pending.reject(new Error('offline')));
  await waitFor(() => expect(screen.queryByRole('button', { name: '正在加载更多…' })).toBeNull(), { timeout: 10000 });
  expect(screen.queryByText(lost.repoUrl)).toBeNull();
  if (failure === 'corrupt') {
    expect(screen.getByRole('heading', { name: 'Healthy project' })).toBe(healthyHeading);
    expect(document.activeElement).toBe(healthyLink);
  }
  expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  fault?.mockRestore(); view.unmount(); scope.dispose();
}, 20000);
