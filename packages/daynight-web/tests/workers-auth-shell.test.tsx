import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticatedApp } from '../src/app/AuthenticatedApp';
import { pauseAuthRequests } from '../src/api/client';
import { navigate } from '../src/app/router';
import { createLocaleRender } from './helpers/renderWithLocale';
import { mockSidebarMediaQuery } from './helpers/mediaQuery';
import { viewerHeaders } from './helpers/taskSync';
import { personalTeamPage } from './helpers/team';
import { configurationResource, configurationResponse } from './helpers/worker-configuration';

const render = createLocaleRender('en');
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const firstWorker = '00000000-0000-4000-8000-000000000003';
const secondWorker = '00000000-0000-4000-8000-000000000004';
const observedAt = '2026-10-29T11:00:00Z';
const reportedAt = '2026-10-29T10:59:40Z';
let focused = true;
let principal = owner;
const user = (id = owner) => ({ personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id, name: id === owner ? 'Alice' : 'Bob', email: id === owner ? 'alice@example.com' : 'bob@example.com', emailVerified: true, avatarUrl: null });
const json = (body: unknown, status = 200, viewer = principal) => new Response(JSON.stringify(body), { status, headers: viewerHeaders(viewer, { 'Content-Type': 'application/json' }) });
const summary = (workerId = firstWorker, name = 'Alice worker') => ({ workerId, machine: { id: workerId, name }, platform: 'linux', lastReportedAt: reportedAt, taskObservationState: 'unavailable', taskObservedAt: null, activeTaskCount: null });
const list = (name = 'Alice worker', viewer = principal) => json({ observedAt, items: [summary(firstWorker, name)], nextCursor: null }, 200, viewer);
const detail = (workerId = firstWorker, name = 'Alice worker', viewer = principal, observation = { observedAt, reportedAt, cpu: 34 }) => {
  const worker = summary(workerId, name);
  return json({ observedAt: observation.observedAt, worker: { ...worker, lastReportedAt: observation.reportedAt, inventoryObservedAt: null, tasks: [], telemetry: {
    machine: worker.machine, platform: worker.platform, workingDirectory: '/srv/workers', sampledAt: observedAt,
    os: { state: 'ok', checkedAt: observedAt, value: { type: 'Linux', release: '6.8.0', version: '#1', arch: 'x64' } },
    cpu: { state: 'ok', checkedAt: observation.observedAt, value: { model: 'Example CPU', logicalProcessors: 8, usagePercent: observation.cpu } },
    memory: { state: 'ok', checkedAt: observedAt, value: { usedBytes: 4 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 } },
    disk: { state: 'ok', checkedAt: observedAt, value: { availableBytes: 32 * 1024 ** 3, totalBytes: 64 * 1024 ** 3 } },
    versions: { daynight: '0.27.1', herdr: { state: 'not_running', checkedAt: observedAt }, codex: { state: 'not_installed', checkedAt: observedAt }, copilot: { state: 'not_installed', checkedAt: observedAt } },
  } } }, 200, viewer);
};
const failure = (status: number, code: string, viewer = principal) => json({ error: { code, message: 'Hidden server details', requestId: 'rq-worker-safe' } }, status, viewer);
const defaults = (url: string): Response => {
  if (url === '/api/v1/me') return json(user(principal));
  if (url.startsWith('/api/v1/teams?')) return json(personalTeamPage(principal));
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
  it('guards a configuration edited back to its original value while a save is in flight', async () => {
    window.history.replaceState(null, '', `/workers/${firstWorker}`);
    const pending = Promise.withResolvers<Response>();
    install((url, init) => {
      if (url === `/api/v1/me/workers/${firstWorker}/prompt`) return json({ scope: 'worker', scopeId: firstWorker, revision: '0', text: '', updatedAt: null });
      if (url === `/api/v1/me/workers/${firstWorker}/configuration`) return init?.method === 'PUT' ? pending.promise : configurationResponse(configurationResource(), 200, owner);
      if (url === `/api/v1/me/workers/${firstWorker}`) return detail();
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    await screen.findByRole('heading', { name: 'Alice worker' });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    const input = await screen.findByRole('textbox', { name: 'Concurrent task limit' });
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await screen.findByRole('button', { name: 'Saving…' });
    fireEvent.change(input, { target: { value: '2' } });
    act(() => navigate('/projects'));
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await act(async () => pending.resolve(configurationResponse(configurationResource('2', { ...configurationResource().desired!.value, maxConcurrent: 3 }), 200, owner)));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save configuration' })).toBeEnabled());
    expect(input).toHaveValue('2');
  });

  it('does not send an abandoned configuration while identity admission is waiting', async () => {
    window.history.replaceState(null, '', `/workers/${firstWorker}`);
    let writes = 0;
    install((url, init) => {
      if (url === `/api/v1/me/workers/${firstWorker}/prompt`) return json({ scope: 'worker', scopeId: firstWorker, revision: '0', text: '', updatedAt: null });
      if (url === `/api/v1/me/workers/${firstWorker}/configuration`) {
        if (init?.method === 'PUT') writes++;
        return configurationResponse(configurationResource(), 200, owner);
      }
      if (url === `/api/v1/me/workers/${firstWorker}`) return detail();
      if (url.startsWith('/api/v1/me/workers?')) return list();
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    await screen.findByRole('heading', { name: 'Alice worker' });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    const input = await screen.findByRole('textbox', { name: 'Concurrent task limit' });
    fireEvent.change(input, { target: { value: '3' } });
    const resume = pauseAuthRequests();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
      await screen.findByRole('button', { name: 'Saving…' });
      act(() => navigate('/workers'));
      fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
      expect(writes).toBe(0);
    } finally { resume(); }
    await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
    expect(writes).toBe(0);
    act(() => navigate(`/workers/${firstWorker}`));
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    expect(await screen.findByRole('textbox', { name: 'Concurrent task limit' })).toHaveValue('2');
    expect(writes).toBe(0);
  });

  it('abandons a pending configuration draft without blocking subsequent routes and keeps later edits', async () => {
    window.history.replaceState(null, '', `/workers/${firstWorker}`);
    const pending = Promise.withResolvers<Response>();
    let writeSignal: AbortSignal | undefined, writes = 0;
    install((url, init) => {
      if (url === `/api/v1/me/workers/${firstWorker}/prompt`) return json({ scope: 'worker', scopeId: firstWorker, revision: '0', text: '', updatedAt: null });
      if (url === `/api/v1/me/workers/${firstWorker}/configuration`) {
        if (init?.method === 'PUT') { writes++; writeSignal = init.signal as AbortSignal; return pending.promise; }
        return configurationResponse(configurationResource(), 200, owner);
      }
      if (url === `/api/v1/me/workers/${firstWorker}`) return detail();
      if (url.startsWith('/api/v1/me/workers?')) return list();
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    await screen.findByRole('heading', { name: 'Alice worker' });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    const input = await screen.findByRole('textbox', { name: 'Concurrent task limit' });
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(writes).toBe(1));
    act(() => navigate('/workers'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(writeSignal?.aborted).toBe(false);
    act(() => navigate('/projects')); expect(screen.queryByRole('alertdialog')).toBeNull();
    act(() => navigate(`/workers/${firstWorker}`));
    expect(await screen.findByRole('textbox', { name: 'Concurrent task limit' })).toBe(input);
    expect(input).toHaveValue('2');
    fireEvent.change(input, { target: { value: '4' } });
    await act(async () => pending.resolve(configurationResponse(configurationResource('2', { ...configurationResource().desired!.value, maxConcurrent: 3 }), 200, owner)));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save configuration' })).toBeEnabled());
    expect(input).toHaveValue('4'); expect(writes).toBe(1);
  });

  it('keeps an unknown configuration submission for a read-only reconciliation after abandonment', async () => {
    window.history.replaceState(null, '', `/workers/${firstWorker}`);
    const pending = Promise.withResolvers<Response>();
    let failReads = false, writes = 0;
    install((url, init) => {
      if (url === `/api/v1/me/workers/${firstWorker}/prompt`) return json({ scope: 'worker', scopeId: firstWorker, revision: '0', text: '', updatedAt: null });
      if (url === `/api/v1/me/workers/${firstWorker}/configuration`) {
        if (init?.method === 'PUT') { writes++; return pending.promise; }
        if (failReads) return Promise.reject(new TypeError('offline'));
        return configurationResponse(configurationResource(writes === 0 ? '1' : '2', { ...configurationResource().desired!.value, maxConcurrent: writes === 0 ? 2 : 3 }), 200, owner);
      }
      if (url === `/api/v1/me/workers/${firstWorker}`) return detail();
      if (url.startsWith('/api/v1/me/workers?')) return list();
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    await screen.findByRole('heading', { name: 'Alice worker' });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    const input = await screen.findByRole('textbox', { name: 'Concurrent task limit' });
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(writes).toBe(1)); failReads = true;
    await act(async () => pending.reject(new TypeError('lost response')));
    await screen.findByText('The save result is not yet confirmed. Your draft has been kept.');
    act(() => navigate('/workers'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    act(() => navigate('/projects')); expect(screen.queryByRole('alertdialog')).toBeNull();
    act(() => navigate(`/workers/${firstWorker}`));
    expect(await screen.findByRole('textbox', { name: 'Concurrent task limit' })).toBe(input);
    expect(input).toHaveValue('2');
    failReads = false;
    fireEvent.click(screen.getByRole('button', { name: 'Check save result' }));
    await waitFor(() => expect(input).toHaveValue('3'));
    expect(writes).toBe(1);
  });

  it('keeps the account prompt draft through tab changes and a pending write through navigation', async () => {
    window.history.replaceState(null, '', '/account');
    const pending = Promise.withResolvers<Response>();
    let writeSignal: AbortSignal | undefined, writes = 0;
    install((url, init) => {
      if (url === '/api/v1/me/worker-prompt') {
        if (init?.method === 'PUT') { writes++; writeSignal = init.signal as AbortSignal; return pending.promise; }
        return json({ scope: 'user', scopeId: owner, revision: '0', text: '', updatedAt: null });
      }
      if (url.startsWith('/api/v1/me/workers?')) return list();
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    fireEvent.click(await screen.findByRole('button', { name: 'User prompt' }));
    const field = await screen.findByRole('textbox', { name: 'Prompt text' });
    fireEvent.change(field, { target: { value: 'account instructions' } });
    fireEvent.click(screen.getByRole('button', { name: 'Profile' }));
    expect(field).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'User prompt' }));
    expect(screen.getByRole('textbox', { name: 'Prompt text' })).toBe(field);
    fireEvent.click(within(field.closest('form')!).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toBe(1));
    act(() => navigate('/workers'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(writeSignal?.aborted).toBe(false);
    act(() => navigate('/account'));
    expect(await screen.findByRole('textbox', { name: 'Prompt text' })).toBe(field);
    await act(async () => pending.resolve(json({ scope: 'user', scopeId: owner, revision: '1', text: 'account instructions', updatedAt: observedAt })));
    expect(writes).toBe(1);
  });

  it('retains a dispatched Worker prompt across departure and re-entry without replaying it', async () => {
    window.history.replaceState(null, '', `/workers/${firstWorker}`);
    const pending = Promise.withResolvers<Response>();
    let writeSignal: AbortSignal | undefined, writes = 0;
    install((url, init) => {
      if (url === `/api/v1/me/workers/${firstWorker}/prompt`) {
        if (init?.method === 'PUT') { writes++; writeSignal = init.signal as AbortSignal; return pending.promise; }
        return json({ scope: 'worker', scopeId: firstWorker, revision: '0', text: '', updatedAt: null });
      }
      if (url === `/api/v1/me/workers/${firstWorker}/configuration`) return configurationResponse(configurationResource(), 200, owner);
      if (url === `/api/v1/me/workers/${firstWorker}`) return detail();
      if (url.startsWith('/api/v1/me/workers?')) return list();
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    await screen.findByRole('heading', { name: 'Alice worker' });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    const field = await screen.findByRole('textbox', { name: 'Prompt text' });
    fireEvent.change(field, { target: { value: 'instructions' } });
    fireEvent.click(within(field.closest('form')!).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toBe(1));
    act(() => navigate('/workers'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(writeSignal?.aborted).toBe(false);
    act(() => navigate(`/workers/${firstWorker}`));
    expect(await screen.findByRole('textbox', { name: 'Prompt text' })).toBe(field);
    await act(async () => pending.resolve(json({ scope: 'worker', scopeId: firstWorker, revision: '1', text: 'instructions', updatedAt: observedAt })));
    expect(writes).toBe(1);
  });

  it('quietly retains Worker details through foreground identity checks and replaces the confirmed report afterward', async () => {
    window.history.replaceState(null, '', `/workers/${firstWorker}`);
    const identity = Promise.withResolvers<Response>(), replacement = Promise.withResolvers<Response>();
    let identityReads = 0, workerReads = 0;
    install(url => {
      if (url === '/api/v1/me' && ++identityReads === 2) return identity.promise;
      if (url === `/api/v1/me/workers/${firstWorker}`) return ++workerReads === 1 ? detail() : replacement.promise;
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    const heading = await screen.findByRole('heading', { name: 'Alice worker' }), cpu = screen.getByRole('meter', { name: 'CPU usage' });
    const content = document.querySelector('.worker-page')!, sections = [...content.children];
    heading.focus(); returnToWorkspace();
    await screen.findByText('online · last confirmed');
    expect(workerReads).toBe(1); expect(cpu).toHaveAttribute('aria-valuenow', '34'); expect(heading).toHaveFocus();
    expect(document.querySelector('.worker-sync-notice')).toBeNull(); expect([...content.children]).toEqual(sections);
    await act(async () => identity.resolve(json(user())));
    await waitFor(() => expect(workerReads).toBe(2));
    expect(screen.getByText('online · last confirmed')).toBeInTheDocument(); expect(cpu).toHaveAttribute('aria-valuenow', '34');
    expect(document.querySelector('.worker-sync-notice')).toBeNull(); expect([...content.children]).toEqual(sections);
    const freshTime = '2026-10-29T11:01:00Z';
    await act(async () => replacement.resolve(detail(firstWorker, 'Alice worker', owner, { observedAt: freshTime, reportedAt: freshTime, cpu: 67 })));
    await screen.findByText('online');
    expect(screen.getByRole('meter', { name: 'CPU usage' })).toBe(cpu); expect(cpu).toHaveAttribute('aria-valuenow', '67');
    expect(content.querySelector(`.worker-description time[datetime="${freshTime}"]`)).toBeInTheDocument();
    expect(document.querySelector('.worker-sync-notice')).toBeNull(); expect([...content.children]).toEqual(sections); expect(heading).toHaveFocus();
  });

  it('retains the configuration editor and unapplied Project selection throughout identity and recovery reads', async () => {
    window.history.replaceState(null, '', `/workers/${firstWorker}`);
    const identity = Promise.withResolvers<Response>(), configurationRead = Promise.withResolvers<Response>(), projectsRead = Promise.withResolvers<Response>();
    const project = (id: string, name: string) => ({ id, name, repoUrl: `https://example.test/${name}.git`, settings: { version: 1, executionWarningMinutes: 60 }, ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1 }, createdAt: observedAt, updatedAt: observedAt });
    const projects = () => json({ items: [project('00000000-0000-4000-8000-000000000010', 'Project One'), project('00000000-0000-4000-8000-000000000011', 'Project Two')], nextCursor: null });
    const config = () => configurationResponse(configurationResource(), 200, owner);
    let identityReads = 0, configurationReads = 0, projectReads = 0, recovery = false;
    const fetcher = install((url) => {
      if (url === '/api/v1/me' && ++identityReads === 2) return identity.promise;
      if (url === `/api/v1/me/workers/${firstWorker}/configuration`) { configurationReads++; return recovery ? configurationRead.promise : config(); }
      if (url === '/api/v1/projects?limit=100') { projectReads++; return recovery ? projectsRead.promise : projects(); }
      if (url === `/api/v1/me/workers/${firstWorker}`) return detail();
      return defaults(url);
    });
    render(<AuthenticatedApp />);
    await screen.findByRole('heading', { name: 'Alice worker' });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    const args = await screen.findByRole('textbox', { name: 'Startup arguments' });
    fireEvent.change(args, { target: { value: '[invalid JSON' } });
    await waitFor(() => expect(projectReads).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: /Choose projects/ })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Choose projects' });
    await within(dialog).findByRole('checkbox', { name: /Project Two/ });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Project Two/ }));
    const search = within(dialog).getByRole('searchbox') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'Project Two' } }); search.focus(); search.setSelectionRange(2, 7);
    const selected = within(dialog).getByRole('checkbox', { name: /Project Two/ });
    const assertRetained = () => {
      expect(screen.getByRole('dialog', { name: 'Choose projects' })).toBe(dialog);
      expect(within(dialog).getByRole('searchbox')).toBe(search); expect(search).toHaveValue('Project Two');
      expect(search).toHaveFocus(); expect(search.selectionStart).toBe(2); expect(search.selectionEnd).toBe(7);
      expect(within(dialog).getByRole('checkbox', { name: /Project Two/ })).toBe(selected); expect(selected).toBeChecked();
      expect(args).toHaveValue('[invalid JSON'); expect(args).toBeInTheDocument();
      expect(within(dialog).queryByRole('status')).toBeNull();
    };
    const initialConfigReads = configurationReads, initialProjectReads = projectReads;
    recovery = true; returnToWorkspace();
    await waitFor(() => expect(identityReads).toBe(2)); assertRetained();
    expect(configurationReads).toBe(initialConfigReads); expect(projectReads).toBe(initialProjectReads);
    await act(async () => identity.resolve(json(user())));
    await waitFor(() => { expect(configurationReads).toBeGreaterThan(initialConfigReads); expect(projectReads).toBeGreaterThan(initialProjectReads); });
    assertRetained();
    await act(async () => configurationRead.resolve(config())); assertRetained();
    await act(async () => projectsRead.resolve(projects())); assertRetained();
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('heading', { name: 'Project Two' })).toBeInTheDocument(); expect(args).toHaveValue('[invalid JSON');
  });

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
