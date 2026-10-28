import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TestSessionListPage } from '../src/features/task-agent-session/TestSessionListPage';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { createLocaleRender } from './helpers/renderWithLocale';
import { pauseAuthRequests } from '../src/api/client';
const render = createLocaleRender('en');
const owner = '00000009-1111-4111-8111-111111111111';
const other = '00000008-1111-4111-8111-111111111111';
const id = (n: number) => `0000000${n}-1111-4111-8111-111111111111`;
const item = (n: number) => ({ sessionId: id(n), provider: n === 1 ? 'codex' : 'claude', lifecycle: 'active', connectionState: 'connected', createdAt: '2026-10-28T01:00:00Z', updatedAt: '2026-10-28T02:00:00Z' });
const response = (items: ReturnType<typeof item>[], nextCursor: string | null = null, user = owner) => new Response(JSON.stringify({ items, nextCursor }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': user } });
const scopes: TaskCacheScope[] = [];
const makeScope = (userId = owner) => { const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(scope); return scope; };
const show = (scope = makeScope()) => render(<TaskCacheProvider scope={scope}><TestSessionListPage /></TaskCacheProvider>);
afterEach(() => { vi.unstubAllGlobals(); for (const scope of scopes.splice(0)) scope.dispose(); });
it('requests online sessions on every page, merges updates, and refreshes from the first page', async () => {
  const fetch = vi.fn(async (url: string) => url.includes('cursor=next') ? response([{ ...item(1), connectionState: 'synchronizing', updatedAt: '2026-10-28T03:00:00Z' }, item(2)]) : response([item(1)], 'next'));
  vi.stubGlobal('fetch', fetch); show();
  const first = await screen.findByRole('link', { name: `Open session: codex ${id(1)}` });
  expect(first).toHaveAttribute('href', `/test-sessions/${id(1)}`);
  expect(screen.getByText('Connected')).toBeInTheDocument();
  expect(screen.queryByText('Stopped')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByRole('link', { name: `Open session: claude ${id(2)}` });
  expect(screen.getAllByRole('link')).toHaveLength(2);
  expect(within(first).getByText('Synchronizing')).toBeInTheDocument();
  expect(first.querySelector('time')).toHaveAttribute('datetime', '2026-10-28T03:00:00Z');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(1));
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/test-sessions?limit=50&online=true', '/api/v1/test-sessions?limit=50&online=true&cursor=next', '/api/v1/test-sessions?limit=50&online=true']);
});
it('shows a recoverable failure and then a useful empty state', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response([]));
  vi.stubGlobal('fetch', fetch); show();
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load test sessions.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('No online test sessions')).toBeInTheDocument();
  expect(screen.getByText('daynight controller codex')).toBeInTheDocument();
});
it('preserves listed rows when loading more fails and retries the same cursor', async () => {
  let calls = 0;
  const fetch = vi.fn(async () => { calls++; if (calls === 2) throw Error('offline'); return calls === 1 ? response([item(1)], 'next') : response([item(2)]); });
  vi.stubGlobal('fetch', fetch); show();
  await screen.findByRole('link'); fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByRole('alert'); expect(screen.getAllByRole('link')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(2));
});
it('drops the prior account rows and ignores its late response after the scope changes', async () => {
  const firstScope = makeScope(), secondScope = makeScope(other); let finish!: (value: Response) => void;
  const fetch = vi.fn().mockResolvedValueOnce(response([item(1)])).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })).mockResolvedValueOnce(response([item(2)], null, other));
  vi.stubGlobal('fetch', fetch); const view = show(firstScope);
  await screen.findByRole('link', { name: `Open session: codex ${id(1)}` });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  view.rerender(<TaskCacheProvider scope={secondScope}><TestSessionListPage /></TaskCacheProvider>);
  await screen.findByRole('link', { name: `Open session: claude ${id(2)}` });
  await act(async () => finish(response([item(1)])));
  expect(screen.queryByRole('link', { name: `Open session: codex ${id(1)}` })).toBeNull();
});
it('waits through identity revalidation instead of abandoning an initial list load', async () => {
  const resume = pauseAuthRequests(); const fetch = vi.fn(async () => response([item(1)])); vi.stubGlobal('fetch', fetch);
  try { show(); expect(screen.getByRole('status')).toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled(); await act(async () => resume()); await screen.findByRole('link'); }
  finally { resume(); }
});
