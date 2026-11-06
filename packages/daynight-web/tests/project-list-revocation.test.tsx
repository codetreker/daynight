import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocaleRender } from './helpers/renderWithLocale';
import { stringifyWireJson } from './helpers/wireJson';
import { ProjectsProvider } from '../src/features/projects/ProjectsProvider';
import { ProjectsPage } from '../src/features/projects/ProjectsPage';
import { createTaskCacheScope } from '../src/features/task-cache/project-cache';
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Channel.channels.clear(); });

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
