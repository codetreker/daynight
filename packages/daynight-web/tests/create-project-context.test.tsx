import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBObjectStore, IDBTransaction } from 'fake-indexeddb';
import { openDB } from 'idb';
import { CreateProjectDialog } from '../src/features/auth/CreateProjectDialog';
import { createLocaleRender } from './helpers/renderWithLocale';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from '../src/features/task-cache/database';
import { ApiError, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { act } from '@testing-library/react';
import * as auth from '../src/api/auth';
import { browserNavigation } from '../src/app/navigation';
import { directAccessFixture } from './helpers/taskSync';
import { stringifyWireJson } from './helpers/wireJson';
import { ProjectsProvider, useProjectList, type ProjectScope } from '../src/features/projects/ProjectsProvider';

const render = createLocaleRender('en');
const userId = '00000000-0000-4000-8000-000000000101';
const teamA = '00000000-0000-4000-8000-000000000701';
const teamB = '00000000-0000-4000-8000-000000000702';

describe('project creation context', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('captures the target at opening for both submission and unknown-outcome inspection', async () => {
    const fetch = vi.fn((url: string, options?: RequestInit) => options?.method === 'POST'
      ? Promise.reject(new Error('connection lost'))
      : Promise.resolve(new Response(JSON.stringify({ items: [], nextCursor: null }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } })));
    vi.stubGlobal('fetch', fetch);
    const props = { userId, onIdentityMismatch: vi.fn(), onClose: vi.fn(), onCreated: vi.fn() };
    const view = render(<CreateProjectDialog {...props} teamId={teamA} teamName="Team Alpha" teamPersonal={false} />);
    view.rerender(<CreateProjectDialog {...props} teamId={teamB} teamName="Team Beta" teamPersonal={false} />);
    expect(screen.getByText('Team Alpha')).toBeInTheDocument();
    expect(screen.getByText(/Team members can access this project/)).toBeInTheDocument();
    expect(screen.queryByText('Team Beta')).toBeNull();
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: '  raw name  ' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await screen.findByText(/creation result is unknown/i);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ name: '  raw name  ', repoUrl: 'git@example.test:repo.git', expectedUserId: userId, teamId: teamA });
    fireEvent.click(screen.getByRole('button', { name: 'Check projects' }));
    await waitFor(() => expect(fetch.mock.calls[1]?.[0]).toBe(`/api/v1/projects?limit=50&teamId=${teamA}`));
    await screen.findByText('No projects found.');
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('exposes a safe request ID when the unknown-outcome check fails', async () => {
    const fetch = vi.fn((_url: string, options?: RequestInit) => options?.method === 'POST'
      ? Promise.reject(new Error('connection lost'))
      : Promise.resolve(new Response(JSON.stringify({ error: { code: 'internal_error', message: 'private detail', requestId: 'team-check-123' } }), { status: 500, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } })));
    vi.stubGlobal('fetch', fetch);
    render(<CreateProjectDialog userId={userId} teamId={teamA} teamName="Alpha" teamPersonal={false} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Project' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await screen.findByText(/creation result is unknown/i);
    fireEvent.click(screen.getByRole('button', { name: 'Check projects' }));
    await screen.findByText('team-check-123');
    expect(screen.queryByText('private detail')).toBeNull();
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('does not publish an unknown-outcome check from a retired identity', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const page = Promise.withResolvers<Response>();
    const fetch = vi.fn((_url: string, options?: RequestInit) => options?.method === 'POST' ? Promise.reject(new Error('connection lost')) : page.promise);
    vi.stubGlobal('fetch', fetch);
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} teamName="Alpha" teamPersonal={false} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Project' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await screen.findByText(/creation result is unknown/i);
    fireEvent.click(screen.getByRole('button', { name: 'Check projects' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const resume = pauseAuthRequests();
    await act(async () => page.resolve(new Response(JSON.stringify({ items: [], nextCursor: null }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } })));
    expect(screen.queryByText('No projects found.')).toBeNull();
    await act(async () => { void admission.invalidateScope(); invalidateAuthRequests(); resume(); });
    expect(screen.queryByText('No projects found.')).toBeNull();
    view.unmount(); admission.dispose();
  });

  it.each([
    ['same', 'initial'], ['same', 'continuation'], ['invalidated', 'initial'], ['closed', 'initial'],
  ] as const)('settles an interrupted %s identity check during %s', async (identity, phase) => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    await admission.prepareProjection(new AbortController().signal);
    let reads = 0;
    const fetcher = vi.fn((_url: string, options?: RequestInit) => options?.method === 'POST'
      ? Promise.reject(new Error('connection lost'))
      : Promise.resolve(new Response(JSON.stringify({ items: [], nextCursor: phase === 'continuation' && ++reads === 1 ? 'next' : null }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } })));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Draft name' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:draft.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await screen.findByText(/creation result is unknown/i);
    if (phase === 'continuation') {
      fireEvent.click(screen.getByRole('button', { name: 'Check projects' }));
      await screen.findByRole('button', { name: 'Load more projects' });
    }
    const interruptions = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const resumes: Array<() => void> = [];
    const pauseCount = identity === 'same' && phase === 'initial' ? 2 : 1;
    let armed = pauseCount, aborted = 0;
    const get = IDBObjectStore.prototype.get, abort = IDBTransaction.prototype.abort;
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = get.apply(this, args);
      if (this.name === 'userScopes' && armed > 0) {
        armed--;
        request.addEventListener('success', () => { resumes.push(pauseAuthRequests()); }, { once: true });
      }
      return request;
    });
    vi.spyOn(IDBTransaction.prototype, 'abort').mockImplementation(function (this: IDBTransaction) {
      try { return abort.call(this); } finally { interruptions[aborted++]?.resolve(); }
    });
    try {
      fireEvent.click(screen.getByRole('button', { name: phase === 'continuation' ? 'Load more projects' : 'Check projects' }));
      await interruptions[0]!.promise;
      expect(fetcher).toHaveBeenCalledTimes(phase === 'continuation' ? 2 : 1);
      expect(screen.getByRole('button', { name: 'Check projects' })).toBeDisabled();
      if (identity === 'invalidated') await act(async () => { await admission.invalidateScope(); invalidateAuthRequests(); });
      if (identity === 'closed') view.unmount();
      await act(async () => { resumes[0]?.(); });
      if (pauseCount === 2) {
        await interruptions[1]!.promise;
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('button', { name: 'Check projects' })).toBeDisabled();
        await act(async () => { resumes[1]?.(); });
      }
      if (identity === 'same') {
        await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(phase === 'continuation' ? 3 : 2), { timeout: 3000 });
        await screen.findByText('No projects found.', {}, { timeout: 3000 });
        expect(screen.getByRole('button', { name: 'Check projects' })).toBeEnabled();
        if (phase === 'continuation') expect(fetcher.mock.calls[2]?.[0]).toContain('cursor=next');
        expect(screen.getByLabelText(/Project name/)).toHaveValue('Draft name');
      } else {
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(screen.queryByText('No projects found.')).toBeNull();
      }
    } finally { resumes.forEach((resume) => resume()); view.unmount(); admission.dispose(); }
  }, 10000);

  it('withdraws an unknown-outcome project list and rejects a late continuation', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const id = '10000000-0000-4000-8000-000000000035';
    const signal = new AbortController().signal;
    const ticket = await admission.beginSync(id, signal);
    const project = { id, name: 'Private project', repoUrl: 'git@example.test:private.git', ownership: { teamId: teamA, version: 1 }, settings: { version: 1, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };
    const page = (nextCursor: string | null) => new Response(JSON.stringify({ items: [project], nextCursor }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
    const late = Promise.withResolvers<Response>();
    const fetch = vi.fn((_url: string, options?: RequestInit) => options?.method === 'POST' ? Promise.reject(new Error('connection lost')) : fetch.mock.calls.filter(([, init]) => init?.method !== 'POST').length === 1 ? Promise.resolve(page('next')) : late.promise);
    vi.stubGlobal('fetch', fetch);
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Project' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await screen.findByText(/creation result is unknown/i);
    fireEvent.click(screen.getByRole('button', { name: 'Check projects' }));
    await screen.findByRole('link', { name: 'Private project' }, { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Load more projects' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await act(async () => { await admission.revokeProject(ticket, signal, false); });
    expect(screen.queryByRole('link', { name: 'Private project' })).toBeNull();
    await act(async () => late.resolve(page(null)));
    expect(screen.queryByText('git@example.test:private.git')).toBeNull();
    expect(screen.getByText(/creation result is unknown/i)).toBeTruthy();
    expect(screen.getByLabelText(/Project name/)).toHaveValue('Project');
    view.unmount(); admission.dispose();
  });

  it('refreshes a temporarily suspended project in the unknown-outcome check without losing the form', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const id = '10000000-0000-4000-8000-000000000036';
    const project = { id, name: 'Observed project', repoUrl: 'git@example.test:observed.git', ownership: { teamId: teamA, version: 1 }, settings: { version: 1, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };
    vi.stubGlobal('fetch', vi.fn((_url: string, options?: RequestInit) => options?.method === 'POST' ? Promise.reject(new Error('connection lost')) : Promise.resolve(new Response(JSON.stringify({ items: [project], nextCursor: null }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } }))));
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Draft name' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:draft.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await screen.findByText(/creation result is unknown/i);
    fireEvent.click(screen.getByRole('button', { name: 'Check projects' }));
    await screen.findByRole('link', { name: 'Observed project' }, { timeout: 10000 });
    await act(async () => admission.suspendProject(id));
    expect(screen.queryByRole('link', { name: 'Observed project' })).toBeNull();
    await act(async () => admission.resumeProject(id));
    await screen.findByRole('link', { name: 'Observed project' }, { timeout: 10000 });
    expect(screen.getByLabelText(/Project name/)).toHaveValue('Draft name');
    view.unmount(); admission.dispose();
  }, 20000);

  it('restores a project from a later inspected page without losing other projects or the form', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const project = (id: string, name: string) => ({ id, name, repoUrl: `git@example.test:${name}.git`, ownership: { teamId: teamA, version: 1 }, settings: { version: 1, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' });
    const healthy = project('10000000-0000-4000-8000-000000000037', 'Healthy');
    const affected = project('10000000-0000-4000-8000-000000000038', 'Restored');
    const page = (item: ReturnType<typeof project>, nextCursor: string | null) => new Response(JSON.stringify({ items: [item], nextCursor }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
    const later = Promise.withResolvers<Response>();
    let reads = 0;
    const fetcher = vi.fn((_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return Promise.reject(new Error('connection lost'));
      reads++;
      if (reads === 4) return later.promise;
      return Promise.resolve(reads % 2 === 1 ? page(healthy, 'next') : page(affected, null));
    });
    vi.stubGlobal('fetch', fetcher);
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />);
    const input = screen.getByLabelText(/Project name/);
    fireEvent.change(input, { target: { value: 'Draft name' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:draft.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await screen.findByText(/creation result is unknown/i);
    fireEvent.click(screen.getByRole('button', { name: 'Check projects' }));
    const healthyLink = await screen.findByRole('link', { name: 'Healthy' }, { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Load more projects' }));
    await screen.findByRole('link', { name: 'Restored' }, { timeout: 10000 });
    healthyLink.focus();
    await act(async () => admission.suspendProject(affected.id));
    expect(screen.queryByRole('link', { name: 'Restored' })).toBeNull();
    await act(async () => admission.resumeProject(affected.id));
    await waitFor(() => expect(reads).toBe(4), { timeout: 10000 });
    expect(screen.getByRole('link', { name: 'Healthy' })).toBe(healthyLink);
    expect(document.activeElement).toBe(healthyLink);
    await act(async () => later.resolve(page(affected, null)));
    await screen.findByRole('link', { name: 'Restored' }, { timeout: 10000 });
    expect(screen.queryByRole('button', { name: 'Load more projects' })).toBeNull();
    expect(input).toHaveValue('Draft name');
    expect(document.activeElement).toBe(healthyLink);
    view.unmount(); admission.dispose();
  }, 20000);

  it('keeps continuation usable during an automatic restoration reread', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const project = (id: string, name: string) => ({ id, name, repoUrl: `git@example.test:${name}.git`, ownership: { teamId: teamA, version: 1 }, settings: { version: 1, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' });
    const healthy = project('10000000-0000-4000-8000-000000000039', 'Healthy');
    const affected = project('10000000-0000-4000-8000-000000000040', 'Restored');
    const added = project('10000000-0000-4000-8000-000000000041', 'Later');
    const page = (items: ReturnType<typeof project>[], nextCursor: string | null) => new Response(JSON.stringify({ items, nextCursor }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
    const pending = Promise.withResolvers<Response>();
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn((_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return Promise.reject(new Error('connection lost'));
      reads++;
      if (reads === 2) return pending.promise;
      return Promise.resolve(reads === 1 || reads === 4 ? page([healthy, affected], 'next') : page([added], null));
    }));
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Draft name' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:draft.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await screen.findByText(/creation result is unknown/i);
    fireEvent.click(screen.getByRole('button', { name: 'Check projects' }));
    await screen.findByRole('link', { name: 'Restored' }, { timeout: 10000 });
    await act(async () => admission.suspendProject(affected.id));
    await act(async () => admission.resumeProject(affected.id));
    await waitFor(() => expect(reads).toBe(2), { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Load more projects' }));
    await screen.findByRole('link', { name: 'Later' }, { timeout: 10000 });
    await screen.findByRole('link', { name: 'Restored' }, { timeout: 10000 });
    await act(async () => pending.resolve(page([healthy, affected], 'next')));
    expect(screen.getByLabelText(/Project name/)).toHaveValue('Draft name');
    expect(reads).toBe(5);
    view.unmount(); admission.dispose();
  }, 20000);

  it('resumes an inspected-project restoration when another project is suspended mid-read', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const project = (id: string, name: string) => ({ id, name, repoUrl: `git@example.test:${name}.git`, ownership: { teamId: teamA, version: 1 }, settings: { version: 1, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' });
    const first = project('10000000-0000-4000-8000-000000000042', 'Restored');
    const second = project('10000000-0000-4000-8000-000000000043', 'Withdrawn');
    const page = (items: ReturnType<typeof project>[]) => new Response(JSON.stringify({ items, nextCursor: null }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
    const pending = Promise.withResolvers<Response>();
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn((_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return Promise.reject(new Error('connection lost'));
      reads++;
      if (reads === 2) return pending.promise;
      return Promise.resolve(page(reads === 1 ? [first, second] : [first]));
    }));
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Draft name' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:draft.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await screen.findByText(/creation result is unknown/i);
    fireEvent.click(screen.getByRole('button', { name: 'Check projects' }));
    await screen.findByRole('link', { name: 'Restored' }, { timeout: 10000 });
    await act(async () => admission.suspendProject(first.id));
    await act(async () => admission.resumeProject(first.id));
    await waitFor(() => expect(reads).toBe(2), { timeout: 10000 });
    await act(async () => admission.suspendProject(second.id));
    await screen.findByRole('link', { name: 'Restored' }, { timeout: 10000 });
    expect(screen.queryByRole('link', { name: 'Withdrawn' })).toBeNull();
    await act(async () => pending.resolve(page([first, second])));
    expect(screen.queryByRole('link', { name: 'Withdrawn' })).toBeNull();
    expect(screen.getByLabelText(/Project name/)).toHaveValue('Draft name');
    expect(reads).toBe(3);
    view.unmount(); admission.dispose();
  }, 20000);

  it.each([
    ['corrupt', 'continuation'], ['corrupt', 'restoration'], ['storage', 'continuation'], ['storage', 'restoration'],
  ] as const)('withdraws retained inspected projects on %s storage failure before a %s response', async (failure, mode) => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const project = (id: string, name: string) => ({ id, name, repoUrl: `git@example.test:${name}.git`, ownership: { teamId: teamA, version: 1 }, settings: { version: 1, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' });
    const lost = project('10000000-0000-4000-8000-000000000046', 'Private');
    const healthy = project('10000000-0000-4000-8000-000000000047', 'Healthy');
    const trigger = project('10000000-0000-4000-8000-000000000048', 'Trigger');
    await admission.beginSync(lost.id, new AbortController().signal);
    const pending = Promise.withResolvers<Response>();
    const response = new Response(JSON.stringify({ items: [lost, healthy, trigger], nextCursor: mode === 'continuation' ? 'next' : null }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
    let reads = 0;
    const fetcher = vi.fn((_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return Promise.reject(new Error('connection lost'));
      return ++reads === 1 ? Promise.resolve(response) : pending.promise;
    });
    vi.stubGlobal('fetch', fetcher);
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Draft name' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:draft.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await screen.findByText(/creation result is unknown/i);
    fireEvent.click(screen.getByRole('button', { name: 'Check projects' }));
    await screen.findByRole('link', { name: 'Private' }, { timeout: 10000 });
    const healthyLink = screen.getByRole('link', { name: 'Healthy' });
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
    if (mode === 'continuation') fireEvent.click(screen.getByRole('button', { name: 'Load more projects' }));
    else {
      await act(async () => admission.suspendProject(trigger.id));
      await act(async () => admission.resumeProject(trigger.id));
    }
    await waitFor(() => expect(reads).toBe(2), { timeout: 10000 });
    expect(screen.queryByRole('link', { name: 'Private' })).toBeNull();
    expect(screen.queryByText(lost.repoUrl)).toBeNull();
    if (failure === 'corrupt') {
      expect(screen.getByRole('link', { name: 'Healthy' })).toBe(healthyLink);
      expect(document.activeElement).toBe(healthyLink);
    }
    else expect(screen.queryByRole('link', { name: 'Healthy' })).toBeNull();
    expect(screen.getByText('Projects could not be loaded.')).toBeTruthy();
    if (failure === 'storage') {
      fault?.mockRestore();
      await admission.prepareProjection(new AbortController().signal);
      expect(admission.projectionError).toBeNull();
    }
    await act(async () => pending.reject(new Error('offline')));
    await waitFor(() => expect(screen.queryByText('Loading projects…')).toBeNull(), { timeout: 10000 });
    expect(screen.queryByText(lost.repoUrl)).toBeNull();
    if (failure === 'corrupt') {
      expect(screen.getByRole('link', { name: 'Healthy' })).toBe(healthyLink);
      expect(document.activeElement).toBe(healthyLink);
    }
    expect(screen.getByText('Projects could not be loaded.')).toBeTruthy();
    expect(screen.getByLabelText(/Project name/)).toHaveValue('Draft name');
    fault?.mockRestore(); view.unmount(); admission.dispose();
  }, 20000);

  it.each(['same', 'changed'] as const)('holds a successful creation until the %s identity is confirmed', async (outcome) => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof auth.createProject>>>();
    const create = vi.spyOn(auth, 'createProject').mockReturnValue(pending.promise);
    const onCreated = vi.fn();
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} teamName="Alpha" teamPersonal={false} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Project' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const resume = pauseAuthRequests();
    const project = { id: '00000000-0000-4000-8000-000000000201', name: 'Project', repoUrl: 'git@example.test:repo.git', ownership: { teamId: teamA, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };
    await act(async () => pending.resolve(project));
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Project name/)).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeDisabled();
    await act(async () => { if (outcome === 'changed') { void admission.invalidateScope(); invalidateAuthRequests(); } resume(); });
    if (outcome === 'same') await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(project));
    else expect(onCreated).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    view.unmount(); admission.dispose();
  });

  it('settles a real confirmed receipt during pause without another request', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const response = Promise.withResolvers<Response>();
    const fetcher = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetcher);
    const onCreated = vi.fn();
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Project' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const resume = pauseAuthRequests();
    const project = { id: '00000000-0000-4000-8000-000000000201', name: 'Project', repoUrl: 'git@example.test:repo.git', ownership: { teamId: teamA, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };
    const access = { ...directAccessFixture(project.id, userId, 'admin'), ownership: project.ownership, teamRole: 'admin', canTransfer: true };
    await act(async () => response.resolve(new Response(stringifyWireJson({ ...project, access }), { status: 201, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } })));
    await waitFor(() => expect(screen.getByLabelText(/Project name/)).not.toBeDisabled());
    expect(screen.getByLabelText(/Project name/)).toHaveValue('Project');
    expect(onCreated).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => resume());
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(project));
    expect(fetcher).toHaveBeenCalledTimes(1);
    view.unmount(); admission.dispose();
  });

  it('does not dispatch creation while identity revalidation is paused', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const create = vi.spyOn(auth, 'createProject').mockReturnValue(new Promise(() => {}));
    const resume = pauseAuthRequests();
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} teamName="Alpha" teamPersonal={false} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Project' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await act(async () => {});
    expect(create).not.toHaveBeenCalled();
    await act(async () => resume());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    view.unmount(); admission.dispose();
  });

  it('cancels a queued creation before dispatch', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const create = vi.spyOn(auth, 'createProject');
    const resume = pauseAuthRequests();
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} teamName="Alpha" teamPersonal={false} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Project' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    view.unmount();
    await act(async () => resume());
    expect(create).not.toHaveBeenCalled();
    admission.dispose();
  });

  it('settles cancelled preparation while retaining the dialog and never dispatches on resume', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const create = vi.spyOn(auth, 'createProject');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const resume = pauseAuthRequests();
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Draft name' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:draft.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    expect(screen.getByLabelText(/Project name/)).toBeDisabled();
    await act(async () => admission.dispose());
    await waitFor(() => expect(screen.getByLabelText(/Project name/)).not.toBeDisabled());
    expect(screen.getByLabelText(/Project name/)).toHaveValue('Draft name');
    expect(create).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => resume());
    expect(create).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    view.unmount();
  });

  it.each([['rejected', 'same'], ['unknown', 'same'], ['rejected', 'changed'], ['unknown', 'changed']] as const)('holds a %s creation result for the %s identity', async (outcome, identity) => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof auth.createProject>>>();
    const create = vi.spyOn(auth, 'createProject').mockReturnValue(pending.promise);
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} teamName="Alpha" teamPersonal={false} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Project' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const resume = pauseAuthRequests();
    const error = outcome === 'unknown' ? new auth.ProjectCreationUnknown(new Error('lost')) : new ApiError('server', 403, 'forbidden');
    await act(async () => pending.reject(error));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText(/Project name/)).not.toBeDisabled();
    await act(async () => { if (identity === 'changed') { void admission.invalidateScope(); invalidateAuthRequests(); } resume(); });
    if (identity === 'same') expect(await screen.findByRole('alert')).toHaveTextContent(outcome === 'unknown' ? /creation result is unknown/i : /project could not be created/i);
    else expect(screen.queryByRole('alert')).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    view.unmount(); admission.dispose();
  });

  it.each(['edit', 'route', 'reopen'] as const)('does not apply an old confirmed creation after %s', async (change) => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof auth.createProject>>>();
    const create = vi.spyOn(auth, 'createProject').mockReturnValue(pending.promise);
    const onCreated = vi.fn(), onClose = vi.fn(), onPublished = vi.fn();
    const props = { userId, teamId: teamA, admission, onIdentityMismatch: vi.fn(), onClose, onCreated, onPublished };
    const navigation = browserNavigation();
    navigation.navigate('/projects');
    let view = render(<CreateProjectDialog {...props} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Old draft' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:old.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const resume = pauseAuthRequests();
    const project = { id: '00000000-0000-4000-8000-000000000201', name: 'Old draft', repoUrl: 'git@example.test:old.git', ownership: { teamId: teamA, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };
    await act(async () => pending.resolve(project));
    expect(screen.getByLabelText(/Project name/)).not.toBeDisabled();
    expect(onCreated).not.toHaveBeenCalled();
    if (change === 'edit') {
      fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'New draft' } });
    } else if (change === 'route') {
      act(() => { navigation.navigate('/account'); navigation.navigate('/projects'); });
    } else {
      view.unmount();
      view = render(<CreateProjectDialog {...props} />);
      fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Reopened draft' } });
    }
    await act(async () => resume());
    if (change !== 'reopen') {
      await waitFor(() => expect(onPublished).toHaveBeenCalledExactlyOnceWith(project));
      expect(screen.getByRole('link', { name: 'Old draft' })).toHaveAttribute('href', `/projects/${project.id}`);
    } else expect(onPublished).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Project name/)).toHaveValue(change === 'edit' ? 'New draft' : change === 'reopen' ? 'Reopened draft' : 'Old draft');
    expect(create).toHaveBeenCalledTimes(1);
    view.unmount(); admission.dispose(); navigation.dispose();
  });

  it('lets a newer operation supersede a confirmed result awaiting publication', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const first = Promise.withResolvers<Awaited<ReturnType<typeof auth.createProject>>>();
    const second = Promise.withResolvers<Awaited<ReturnType<typeof auth.createProject>>>();
    const create = vi.spyOn(auth, 'createProject').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onCreated = vi.fn();
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={onCreated} />);
    const input = screen.getByLabelText(/Project name/);
    fireEvent.change(input, { target: { value: 'First' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const resume = pauseAuthRequests();
    const project = { id: '00000000-0000-4000-8000-000000000201', name: 'First', repoUrl: 'git@example.test:repo.git', ownership: { teamId: teamA, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };
    await act(async () => first.resolve(project));
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: 'Second' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => resume());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(onCreated).not.toHaveBeenCalled();
    const latest = { ...project, id: '00000000-0000-4000-8000-000000000202', name: 'Second' };
    await act(async () => second.resolve(latest));
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(latest));
    view.unmount(); admission.dispose();
  });

  it('does not publish when identity pauses again immediately after admission resolves', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const originalReady = admission.ready.bind(admission);
    const secondPause: { resume: (() => void) | null } = { resume: null };
    let armed = false;
    vi.spyOn(admission, 'ready').mockImplementation(async signal => {
      await originalReady(signal);
      if (armed) { armed = false; secondPause.resume = pauseAuthRequests(); }
    });
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof auth.createProject>>>();
    const create = vi.spyOn(auth, 'createProject').mockReturnValue(pending.promise);
    const onCreated = vi.fn(), onPublished = vi.fn();
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={onCreated} onPublished={onPublished} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Project' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const resume = pauseAuthRequests();
    const project = { id: '00000000-0000-4000-8000-000000000201', name: 'Project', repoUrl: 'git@example.test:repo.git', ownership: { teamId: teamA, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };
    await act(async () => pending.resolve(project));
    armed = true;
    await act(async () => resume());
    await waitFor(() => expect(secondPause.resume).not.toBeNull());
    expect(onPublished).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Project' })).toBeNull();
    await act(async () => secondPause.resume!());
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(project));
    expect(onPublished).toHaveBeenCalledExactlyOnceWith(project);
    expect(create).toHaveBeenCalledOnce();
    view.unmount(); admission.dispose();
  });

  it('settles locally but never publishes a receipt after generation changes and immediately pauses again', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof auth.createProject>>>();
    const create = vi.spyOn(auth, 'createProject').mockReturnValue(pending.promise);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const onCreated = vi.fn(), onPublished = vi.fn();
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={onCreated} onPublished={onPublished} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Project' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const resumeFirst = pauseAuthRequests();
    const project = { id: '00000000-0000-4000-8000-000000000201', name: 'Project', repoUrl: 'git@example.test:repo.git', ownership: { teamId: teamA, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };
    await act(async () => pending.resolve(project));
    expect(screen.getByLabelText(/Project name/)).not.toBeDisabled();
    let resumeSecond: () => void = () => {};
    await act(async () => { invalidateAuthRequests(); resumeSecond = pauseAuthRequests(); resumeFirst(); });
    expect(onPublished).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Project' })).toBeNull();
    await act(async () => resumeSecond());
    expect(onPublished).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Project' })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(screen.getByLabelText(/Project name/)).toHaveValue('Project');
    view.unmount(); admission.dispose();
  });

  it('refreshes the current project-list scope when a delayed receipt is published after navigation', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof auth.createProject>>>();
    const create = vi.spyOn(auth, 'createProject').mockReturnValue(pending.promise);
    const project = { id: '00000000-0000-4000-8000-000000000201', name: 'Created project', repoUrl: 'git@example.test:repo.git', ownership: { teamId: teamA, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };
    const shared = { ...project, id: '00000000-0000-4000-8000-000000000202', name: 'Shared project' };
    const fetcher = vi.fn((url: string) => Promise.resolve(new Response(stringifyWireJson({ items: url.includes('shared=true') ? [shared] : [], nextCursor: null }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } })));
    vi.stubGlobal('fetch', fetcher);
    const onCreated = vi.fn(), onPublished = vi.fn();
    const Content = ({ scopeKind }: { readonly scopeKind: ProjectScope['kind'] }) => {
      const projects = useProjectList();
      return <><div>List: {projects.status}</div>{projects.items.map(item => <div key={item.id}>{item.name}</div>)}
        <CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={onCreated} onPublished={item => { onPublished(item, scopeKind); projects.refresh(); }} /></>;
    };
    const tree = (scope: ProjectScope) => <ProjectsProvider scope={scope} admission={admission}><Content scopeKind={scope.kind} /></ProjectsProvider>;
    const navigation = browserNavigation();
    navigation.navigate('/projects');
    const view = render(tree({ kind: 'team', teamId: teamA }));
    await screen.findByText('List: ready');
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Created project' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const resume = pauseAuthRequests();
    await act(async () => pending.resolve(project));
    expect(screen.getByLabelText(/Project name/)).not.toBeDisabled();
    act(() => navigation.navigate('/shared-projects'));
    view.rerender(tree({ kind: 'shared' }));
    expect(screen.getByText('List: loading')).toBeInTheDocument();
    await act(async () => resume());
    await screen.findByText('Shared project');
    expect(screen.getByText('List: ready')).toBeInTheDocument();
    expect(onPublished).toHaveBeenCalledExactlyOnceWith(project, 'shared');
    expect(onCreated).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.some(([url]) => url.includes('shared=true'))).toBe(true);
    view.unmount(); admission.dispose(); navigation.dispose();
  });

  it('publishes the first confirmed project when a newer creation is refused', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const first = Promise.withResolvers<Awaited<ReturnType<typeof auth.createProject>>>();
    const second = Promise.withResolvers<Awaited<ReturnType<typeof auth.createProject>>>();
    const create = vi.spyOn(auth, 'createProject').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onCreated = vi.fn(), onPublished = vi.fn();
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={onCreated} onPublished={onPublished} />);
    const input = screen.getByLabelText(/Project name/);
    fireEvent.change(input, { target: { value: 'First' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const resume = pauseAuthRequests();
    const project = { id: '00000000-0000-4000-8000-000000000201', name: 'First', repoUrl: 'git@example.test:repo.git', ownership: { teamId: teamA, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };
    await act(async () => first.resolve(project));
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: 'Second' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => resume());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await act(async () => second.reject(new ApiError('server', 403, 'forbidden')));
    expect(await screen.findByRole('alert')).toHaveTextContent(/project could not be created/i);
    expect(await screen.findByRole('link', { name: 'First' })).toHaveAttribute('href', `/projects/${project.id}`);
    expect(onPublished).toHaveBeenCalledExactlyOnceWith(project);
    expect(onCreated).not.toHaveBeenCalled();
    expect(input).toHaveValue('Second');
    view.unmount(); admission.dispose();
  });

  it('keeps a confirmed result distinct when navigation publication throws', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const project = { id: '00000000-0000-4000-8000-000000000201', name: 'Project', repoUrl: 'git@example.test:repo.git', ownership: { teamId: teamA, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };
    const create = vi.spyOn(auth, 'createProject').mockResolvedValue(project);
    const onCreated = vi.fn(() => { throw new Error('navigation failed'); });
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Project' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('The project was created, but its result could not be displayed.');
    expect(screen.queryByText(/project could not be created/i)).toBeNull();
    expect(screen.queryByText(/creation result is unknown/i)).toBeNull();
    expect(screen.getByLabelText(/Project name/)).toHaveValue('Project');
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
    expect(create).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(project);
    view.unmount(); admission.dispose();
  });

  it('protects the dialog after a navigation decision is requested then cancelled', async () => {
    const admission = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof auth.createProject>>>();
    const create = vi.spyOn(auth, 'createProject').mockReturnValue(pending.promise);
    const navigation = browserNavigation();
    navigation.navigate('/projects');
    const unregister = navigation.register({ scope: { identity: {}, projectId: 'p', taskId: 't' }, isDirty: () => true, discard: vi.fn(), survives: () => false });
    const onCreated = vi.fn(), onClose = vi.fn();
    const view = render(<CreateProjectDialog userId={userId} teamId={teamA} admission={admission} onIdentityMismatch={vi.fn()} onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: 'Project' } });
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'git@example.test:repo.git' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const resume = pauseAuthRequests();
    const project = { id: '00000000-0000-4000-8000-000000000201', name: 'Project', repoUrl: 'git@example.test:repo.git', ownership: { teamId: teamA, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };
    await act(async () => pending.resolve(project));
    const location = navigation.snapshot();
    act(() => navigation.navigate('/account'));
    expect(navigation.decision()).not.toBeNull();
    act(() => navigation.cancel());
    expect(navigation.snapshot()).toBe(location);
    await act(async () => resume());
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/Project name/)).toHaveValue('Project');
    unregister(); view.unmount(); admission.dispose(); navigation.dispose();
  });
});
