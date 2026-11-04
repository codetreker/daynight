import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateProjectDialog } from '../src/features/auth/CreateProjectDialog';
import { createLocaleRender } from './helpers/renderWithLocale';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { act } from '@testing-library/react';
import * as auth from '../src/api/auth';

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
    await act(async () => { if (outcome === 'changed') { void admission.invalidateScope(); invalidateAuthRequests(); } resume(); });
    if (outcome === 'same') await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(project));
    else expect(onCreated).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
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
});
