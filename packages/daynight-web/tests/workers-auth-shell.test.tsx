import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticatedApp } from '../src/app/AuthenticatedApp';
import { navigate } from '../src/app/router';
import { createLocaleRender } from './helpers/renderWithLocale';
import { mockSidebarMediaQuery } from './helpers/mediaQuery';
import { viewerHeaders } from './helpers/taskSync';

const render = createLocaleRender('en');
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const firstWorker = '00000000-0000-4000-8000-000000000003';
const secondWorker = '00000000-0000-4000-8000-000000000004';
const observedAt = '2026-10-29T11:00:00Z';
const reportedAt = '2026-10-29T10:59:40Z';
let focused = true;
let principal = owner;
const user = (id = owner) => ({ id, name: id === owner ? 'Alice' : 'Bob', email: id === owner ? 'alice@example.com' : 'bob@example.com', emailVerified: true, avatarUrl: null });
const json = (body: unknown, status = 200, viewer = principal) => new Response(JSON.stringify(body), { status, headers: viewerHeaders(viewer, { 'Content-Type': 'application/json' }) });
const summary = (workerId = firstWorker, name = 'Alice worker') => ({ workerId, machine: { id: workerId, name }, platform: 'linux', lastReportedAt: reportedAt, taskObservationState: 'unavailable', taskObservedAt: null, activeTaskCount: null });
const list = (name = 'Alice worker', viewer = principal) => json({ observedAt, items: [summary(firstWorker, name)], nextCursor: null }, 200, viewer);
const detail = (workerId = firstWorker, name = 'Alice worker', viewer = principal) => {
  const worker = summary(workerId, name);
  return json({ observedAt, worker: { ...worker, inventoryObservedAt: null, tasks: [], telemetry: {
    machine: worker.machine, platform: worker.platform, workingDirectory: '/srv/workers', sampledAt: observedAt,
    os: { state: 'ok', checkedAt: observedAt, value: { type: 'Linux', release: '6.8.0', version: '#1', arch: 'x64' } },
    cpu: { state: 'ok', checkedAt: observedAt, value: { model: 'Example CPU', logicalProcessors: 8, usagePercent: 34 } },
    memory: { state: 'ok', checkedAt: observedAt, value: { usedBytes: 4 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 } },
    disk: { state: 'ok', checkedAt: observedAt, value: { availableBytes: 32 * 1024 ** 3, totalBytes: 64 * 1024 ** 3 } },
    versions: { daynight: '0.27.1', herdr: { state: 'not_running', checkedAt: observedAt }, codex: { state: 'not_installed', checkedAt: observedAt }, copilot: { state: 'not_installed', checkedAt: observedAt } },
  } } }, 200, viewer);
};
const failure = (status: number, code: string, viewer = principal) => json({ error: { code, message: 'Hidden server details', requestId: 'rq-worker-safe' } }, status, viewer);
const defaults = (url: string): Response => {
  if (url === '/api/v1/me') return json(user(principal));
  if (url.startsWith('/api/v1/projects?')) return json({ items: [], nextCursor: null });
  throw new Error(`Unexpected request ${url}`);
};
const install = (handler: (url: string, options?: RequestInit) => Response | Promise<Response>) => {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => handler(url, options));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};
const returnToWorkspace = () => {
  focused = false; fireEvent(window, new Event('blur'));
  focused = true; fireEvent(window, new Event('focus'));
};

beforeEach(() => {
  window.sessionStorage.clear();
  focused = true; principal = owner;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});

describe('Worker pages in the authenticated workspace', () => {
  it('reads account Workers when project navigation fails and browser storage is unavailable', async () => {
    window.history.replaceState(null, '', '/workers');
    vi.stubGlobal('indexedDB', undefined);
    const fetcher = install((url) => url.startsWith('/api/v1/me/workers?') ? list() : url.startsWith('/api/v1/projects?') ? failure(500, 'internal') : defaults(url));
    render(<AuthenticatedApp />);
    await screen.findByRole('heading', { name: 'Alice worker' });
    const sidebar = within(screen.getByRole('complementary', { name: 'Workspace navigation' }));
    expect(sidebar.getByRole('link', { name: 'My Workers' })).toHaveAttribute('aria-current', 'page');
    expect(sidebar.getByRole('alert')).toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith('/api/v1/me/workers?'))).toHaveLength(1);
    expect(document.title).toBe('My Workers · Daynight');
  });

  it('cancels a pending read during same-account revalidation and starts a fresh observation afterward', async () => {
    window.history.replaceState(null, '', '/workers');
    const pending = Promise.withResolvers<Response>();
    const identity = Promise.withResolvers<Response>();
    let workerReads = 0, identityReads = 0;
    let oldSignal: AbortSignal | undefined;
    install((url, options) => {
      if (url === '/api/v1/me' && ++identityReads === 2) return identity.promise;
      if (url.startsWith('/api/v1/me/workers?')) {
        workerReads++;
        if (workerReads === 2) { oldSignal = options?.signal as AbortSignal; return pending.promise; }
        return list(workerReads === 1 ? 'Initial observation' : 'Fresh observation');
      }
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    await screen.findByRole('heading', { name: 'Initial observation' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(workerReads).toBe(2));
    returnToWorkspace();
    await waitFor(() => expect(oldSignal?.aborted).toBe(true));
    expect(screen.getByRole('heading', { name: 'Initial observation' })).toBeInTheDocument();
    expect(workerReads).toBe(2);
    await act(async () => identity.resolve(json(user())));
    await screen.findByRole('heading', { name: 'Fresh observation' });
    await act(async () => pending.resolve(list('Late superseded observation')));
    expect(screen.queryByRole('heading', { name: 'Late superseded observation' })).toBeNull();
  });

  it('destroys the prior account snapshot and ignores its late response after an account switch', async () => {
    window.history.replaceState(null, '', '/workers');
    const pending = Promise.withResolvers<Response>();
    let oldReads = 0;
    install((url) => {
      if (url.startsWith('/api/v1/me/workers?')) {
        if (principal === other) return list('Bob worker', other);
        oldReads++;
        return oldReads === 1 ? list('Alice private worker', owner) : pending.promise;
      }
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    await screen.findByRole('heading', { name: 'Alice private worker' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(oldReads).toBe(2));
    principal = other;
    returnToWorkspace();
    await screen.findByRole('heading', { name: 'Bob worker' });
    expect(screen.queryByRole('heading', { name: 'Alice private worker' })).toBeNull();
    await act(async () => pending.resolve(list('Late Alice private worker', owner)));
    expect(screen.queryByRole('heading', { name: 'Late Alice private worker' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Bob worker' })).toBeInTheDocument();
  });

  it.each([200, 404])('discards the rendered identity before an unadmitted %s detail response can publish', async (status) => {
    window.history.replaceState(null, '', `/workers/${firstWorker}`);
    const identity = Promise.withResolvers<Response>();
    let identityReads = 0, workerReads = 0;
    install((url) => {
      if (url === '/api/v1/me' && ++identityReads === 2) return identity.promise;
      if (url === `/api/v1/me/workers/${firstWorker}`) {
        workerReads++;
        if (workerReads === 2) return status === 200 ? detail(firstWorker, 'Other account secret', other) : failure(404, 'not_found', other);
        return detail(firstWorker, workerReads === 1 ? 'Alice private worker' : 'Revalidated worker', owner);
      }
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    await screen.findByRole('heading', { name: 'Alice private worker' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(identityReads).toBe(2));
    expect(screen.queryByRole('heading', { name: 'Alice private worker' })).toBeNull();
    expect(screen.queryByText('Other account secret')).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Workspace navigation' })).toBeNull();
    await act(async () => identity.resolve(json(user())));
    await screen.findByRole('heading', { name: 'Revalidated worker' });
  });

  it('closes the mobile drawer, clears the prior resource and focuses content on Worker A to B navigation', async () => {
    window.history.replaceState(null, '', `/workers/${firstWorker}`);
    mockSidebarMediaQuery(true);
    const second = Promise.withResolvers<Response>();
    install((url) => url === `/api/v1/me/workers/${firstWorker}` ? detail(firstWorker, 'Worker A') : url === `/api/v1/me/workers/${secondWorker}` ? second.promise : defaults(url));
    render(<AuthenticatedApp />);
    await screen.findByRole('heading', { name: 'Worker A' });
    const main = screen.getByRole('main');
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => navigate(`/workers/${secondWorker}`));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Worker A' })).toBeNull();
    expect(document.activeElement).toBe(main);
    expect(document.body.style.overflow).not.toBe('hidden');
    await act(async () => second.resolve(detail(secondWorker, 'Worker B')));
    await screen.findByRole('heading', { name: 'Worker B' });
    const breadcrumb = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(breadcrumb.getByRole('link', { name: 'My Workers' })).toHaveAttribute('href', '/workers');
    expect(breadcrumb.getByText('Worker')).toHaveAttribute('aria-current', 'page');
    expect(document.title).toBe('Worker · Daynight');
    expect(within(screen.getByRole('complementary', { name: 'Workspace navigation' })).getByRole('link', { name: 'My Workers' })).toHaveAttribute('aria-current', 'page');
  });
});
