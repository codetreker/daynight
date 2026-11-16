import { useState } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { GitHubAppGrants, type GitHubAppGrantUnknownReview } from '../src/features/github-app-grants/GitHubAppGrants';
import type { TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { createLocaleRender } from './helpers/renderWithLocale';

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), preview: vi.fn(), create: vi.fn(), impact: vi.fn(), projects: vi.fn(), revoke: vi.fn(), projectAccess: vi.fn(), app: vi.fn() }));
vi.mock('../src/api/github-app-grants', () => ({ listGitHubAppGrants: mocks.list, getGitHubAppGrant: mocks.get, previewGitHubAppGrant: mocks.preview, createGitHubAppGrant: mocks.create, getGitHubAppGrantImpact: mocks.impact, listGitHubAppGrantImpactProjects: mocks.projects, revokeGitHubAppGrant: mocks.revoke }));
vi.mock('../src/api/auth', () => ({ getProjectAccess: mocks.projectAccess }));
vi.mock('../src/api/github-app-management', () => ({ getGitHubApp: mocks.app }));
const appId = '59cb4a41-9b96-43cd-8fe3-cbaf394a51e8', userId = 'c0d0a6d2-539a-4a14-87e0-e9c2de6bd058', teamId = 'a7d416e6-fac3-4f72-a696-31c016bd90b8', other = '30000000-0000-4000-8000-000000000003', grantId = '30000000-0000-4000-8000-000000000004';
const stamp = '2026-01-01T00:00:00Z', version = '9007199254740993', impactVersion = '9007199254740994';
const team = { id: teamId, kind: 'personal' as const, name: null, version }, grant = { id: grantId, appId, team, createdAt: stamp };
const preview = { appId, version, targetTeam: team, grant: null };
const impact = { appId, grantId, version, impactVersion, totalProjects: '1', visibleProjects: '0', hiddenProjects: '1', teams: [{ team: { id: teamId, kind: 'personal' as const, name: null }, projects: '1' }], nextCursor: null };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const render = createLocaleRender('en');
let scope: TaskCacheScope; const unavailable = vi.fn(), mismatch = vi.fn(), onResult = vi.fn();
const subject = (overrides: Partial<Parameters<typeof GitHubAppGrants>[0]> = {}) => <GitHubAppGrants appId={appId} active admission={scope} admissionBlocked={false} accessDenied={false} onIdentityMismatch={mismatch} onUnavailable={unavailable} onResult={onResult} {...overrides} />;
const openAuthorization = async () => { const button = await screen.findByRole('button', { name: 'Authorize Team' }); await waitFor(() => { expect(button).toBeEnabled(); expect(button).toHaveAttribute('aria-disabled', 'false'); }); fireEvent.click(button); };
beforeEach(() => {
  vi.clearAllMocks(); const controller = new AbortController();
  scope = { userId, signal: controller.signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  mocks.list.mockResolvedValue({ items: [grant], nextCursor: null }); mocks.impact.mockResolvedValue(impact); mocks.preview.mockResolvedValue(preview); mocks.get.mockResolvedValue(grant); mocks.projects.mockResolvedValue({ items: [], hiddenProjects: '1', nextCursor: null }); mocks.projectAccess.mockResolvedValue({}); mocks.app.mockResolvedValue({});
});

describe('GitHub App Team access', () => {
  it('requires a verified target, preserves typed UUID, and submits frozen versions', async () => {
    mocks.create.mockImplementation(async (_app, input, _signal, access) => { access.onDispatch(); return { ...grant, id: input.id }; });
    render(subject()); await openAuthorization();
    const dialog = screen.getByRole('dialog'), field = within(dialog).getByLabelText('Team ID'), confirm = within(dialog).getByRole('button', { name: 'Grant access' });
    expect(confirm).toBeDisabled(); fireEvent.change(field, { target: { value: teamId.toUpperCase() } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' }));
    await within(dialog).findByText('Personal Team', { selector: 'strong' }); expect(field).toHaveValue(teamId.toUpperCase()); expect(confirm).toBeEnabled();
    fireEvent.click(confirm); await screen.findByText('Team access granted.');
    expect(mocks.preview.mock.calls[0]![1]).toBe(teamId); expect(mocks.create.mock.calls[0]![1]).toMatchObject({ version, teamId, teamVersion: version }); expect(mocks.create.mock.calls[0]![1].id).toMatch(/^[a-f0-9-]{36}$/); expect(onResult).toHaveBeenCalledWith('granted');
  });
  it.each(['grant', 'revoke'] as const)('retains the %s receipt after closing while publication is pending', async kind => {
    const pending = deferred<void>(); let hold = false;
    scope = { ...scope, ready: async (signal: AbortSignal) => { signal.throwIfAborted(); if (hold) await pending.promise; signal.throwIfAborted(); } } as TaskCacheScope;
    mocks.create.mockImplementation(async (_app, input, _signal, access) => { access.onDispatch(); hold = true; return { ...grant, id: input.id }; });
    mocks.revoke.mockImplementation(async (_app, id, _input, _signal, access) => { access.onDispatch(); hold = true; return { appId, grantId: id, revoked: true }; });
    render(subject());
    if (kind === 'grant') { await openAuthorization(); const dialog = screen.getByRole('dialog'); fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await within(dialog).findByText('Personal Team', { selector: 'strong' }); fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access' })); }
    else { fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog'); fireEvent.click(await within(dialog).findByRole('button', { name: 'Revoke access and disconnect' })); }
    const dialog = screen.getByRole('dialog'); await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })); expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Authorize Team' })).toBeDisabled(); hold = false; await act(async () => pending.resolve());
    expect(await screen.findByText(kind === 'grant' ? 'Team access granted.' : /Team access revoked and affected connections stopped/)).toBeVisible(); expect(onResult).toHaveBeenCalledOnce();
  });
  it.each(['inactive', 'denied'] as const)('reports a delayed confirmation after the component becomes %s', async mode => {
    const pending = deferred<void>(); let hold = false;
    scope = { ...scope, ready: async (signal: AbortSignal) => { signal.throwIfAborted(); if (hold) await pending.promise; signal.throwIfAborted(); } } as TaskCacheScope;
    mocks.create.mockImplementation(async (_app, input, _signal, access) => { access.onDispatch(); hold = true; return { ...grant, id: input.id }; });
    const view = render(subject()); await openAuthorization(); const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await within(dialog).findByText('Personal Team', { selector: 'strong' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access' })); await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled());
    view.rerender(subject(mode === 'inactive' ? { active: false } : { active: false, accessDenied: true }));
    hold = false; await act(async () => pending.resolve()); expect(onResult).toHaveBeenCalledOnce(); expect(onResult).toHaveBeenCalledWith('granted'); expect(screen.queryByText('Team access granted.')).toBeNull();
  });
  it('keeps publication failure and retry available after closing the dialog', async () => {
    let fail = false; const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    scope = { ...scope, ready: async (signal: AbortSignal) => { signal.throwIfAborted(); if (fail) throw new Error('admission unavailable'); } } as TaskCacheScope;
    mocks.create.mockImplementation(async (_app, input, _signal, access) => { access.onDispatch(); fail = true; return { ...grant, id: input.id }; });
    render(subject()); await openAuthorization(); const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await within(dialog).findByText('Personal Team', { selector: 'strong' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access' })); await within(dialog).findByText('The operation succeeded, but its result could not be displayed.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })); expect(screen.getByText('The operation succeeded, but its result could not be displayed.')).toBeVisible();
    fail = false; fireEvent.click(screen.getByRole('button', { name: 'Retry showing result' })); expect(await screen.findByText('Team access granted.')).toBeVisible(); expect(mocks.create).toHaveBeenCalledOnce(); log.mockRestore();
  });
  it('invalidates a preview immediately on input revision and ignores the late response', async () => {
    const pending = deferred<typeof preview>(); mocks.preview.mockReturnValue(pending.promise);
    render(subject()); await openAuthorization(); const dialog = screen.getByRole('dialog'), field = within(dialog).getByLabelText('Team ID');
    fireEvent.change(field, { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await waitFor(() => expect(mocks.preview).toHaveBeenCalledOnce());
    fireEvent.change(field, { target: { value: other } }); await act(async () => pending.resolve(preview));
    expect(within(dialog).getByRole('button', { name: 'Grant access' })).toBeDisabled(); expect(within(dialog).queryByText('Personal Team', { selector: 'strong' })).toBeNull();
  });
  it('keeps unknown creation tied to its exact generated ID without replay', async () => {
    mocks.create.mockImplementation(async (_app, _input, _signal, access) => { access.onDispatch(); throw new ApiError('network'); }); mocks.get.mockRejectedValue(new ApiError('server', 404, 'not_found'));
    render(subject()); await openAuthorization(); const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await within(dialog).findByText('Personal Team', { selector: 'strong' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access' })); await within(dialog).findByText(/outcome is unknown/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' })); await within(dialog).findByText(/does not establish the original operation/);
    expect(mocks.get.mock.calls[0]![1]).toBe(mocks.create.mock.calls[0]![1].id); expect(mocks.create).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish review and decide again' })); expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('discards a late unknown check after finishing and starting a new unknown operation', async () => {
    const stale = deferred<typeof grant>(); mocks.create.mockImplementation(async (_app, _input, _signal, access) => { access.onDispatch(); throw new ApiError('network'); }); mocks.get.mockResolvedValueOnce(grant).mockReturnValueOnce(stale.promise);
    render(subject()); await openAuthorization(); let dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await within(dialog).findByText('Personal Team', { selector: 'strong' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access' })); await within(dialog).findByText(/outcome is unknown/); fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' })); await within(dialog).findByText(/does not establish the original operation/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' })); await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2)); const signal = mocks.get.mock.calls[1]![2] as AbortSignal;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish review and decide again' })); expect(signal.aborted).toBe(true); await openAuthorization(); dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await within(dialog).findByText('Personal Team', { selector: 'strong' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access' })); await within(dialog).findByText(/outcome is unknown/); await act(async () => stale.resolve(grant));
    expect(within(dialog).queryByText(/does not establish the original operation/)).toBeNull(); expect(within(dialog).queryByRole('button', { name: 'Finish review and decide again' })).toBeNull(); expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it('cancels a check on close and ignores its late denial during a later check', async () => {
    const stale = deferred<typeof grant>(), next = deferred<typeof grant>(); mocks.create.mockImplementation(async (_app, _input, _signal, access) => { access.onDispatch(); throw new ApiError('network'); }); mocks.get.mockReturnValueOnce(stale.promise).mockReturnValueOnce(next.promise);
    render(subject()); await openAuthorization(); const dialog = screen.getByRole('dialog'); fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await within(dialog).findByText('Personal Team', { selector: 'strong' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access' })); await within(dialog).findByText(/outcome is unknown/); fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' })); await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce()); const signal = mocks.get.mock.calls[0]![2] as AbortSignal;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' })); expect(signal.aborted).toBe(true); fireEvent.click(screen.getByRole('button', { name: 'Check current state' })); await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    await act(async () => stale.reject(new ApiError('server', 404, 'not_found'))); expect(mocks.app).not.toHaveBeenCalled(); expect(screen.queryByText(/does not establish the original operation/)).toBeNull();
    await act(async () => next.resolve(grant)); expect(await screen.findByText(/does not establish the original operation/)).toBeVisible(); expect(unavailable).not.toHaveBeenCalled();
  });
  it('cancels an unknown check on host access denial', async () => {
    const stale = deferred<typeof grant>(); mocks.create.mockImplementation(async (_app, _input, _signal, access) => { access.onDispatch(); throw new ApiError('network'); }); mocks.get.mockReturnValue(stale.promise);
    const view = render(subject()); await openAuthorization(); const dialog = screen.getByRole('dialog'); fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await within(dialog).findByText('Personal Team', { selector: 'strong' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access' })); await within(dialog).findByText(/outcome is unknown/); fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' })); await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce()); const signal = mocks.get.mock.calls[0]![2] as AbortSignal;
    view.rerender(subject({ accessDenied: true })); expect(signal.aborted).toBe(true); await act(async () => stale.resolve(grant)); expect(screen.queryByText(/does not establish the original operation/)).toBeNull(); expect(screen.queryByText(/Currently accessible grant/)).toBeNull();
  });

  it('uses the exact grant and impact versions for revocation and preserves the receipt', async () => {
    mocks.revoke.mockImplementation(async (_app, id, _input, _signal, access) => { access.onDispatch(); return { appId, grantId: id, revoked: true }; });
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog');
    await within(dialog).findByText('Affected connections: 1'); expect(within(dialog).getByText(/Existing PRs are retained/)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke access and disconnect' })); await screen.findByText(/Team access revoked and affected connections stopped/);
    expect(mocks.revoke.mock.calls[0]![1]).toBe(grantId); expect(mocks.revoke.mock.calls[0]![2]).toEqual({ version, impactVersion }); expect(onResult).toHaveBeenCalledWith('revoked');
  });
  it('does not expose project details when Project access was lost', async () => {
    const project = { id: other, name: 'Private project', repoUrl: 'https://example.test/private' };
    mocks.projects.mockResolvedValue({ items: [project], hiddenProjects: '0', nextCursor: null }); mocks.projectAccess.mockRejectedValue(new ApiError('server', 404, 'not_found'));
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Project access or impact changed/);
    expect(within(dialog).queryByText(/Private project/)).toBeNull(); expect(unavailable).not.toHaveBeenCalled(); expect(mocks.app).toHaveBeenCalledOnce(); expect(within(dialog).queryByText('Affected connections: 1')).toBeNull(); expect(within(dialog).queryByRole('button', { name: 'Revoke access and disconnect' })).toBeNull();
  });
  it('ignores a late denial from an older failed Project check after a successful retry', async () => {
    const first = { id: other, name: 'Private project', repoUrl: 'https://example.test/private' }, second = { id: '40000000-0000-4000-8000-000000000004', name: 'Second project', repoUrl: 'https://example.test/second' }, late = deferred<unknown>();
    mocks.projects.mockResolvedValue({ items: [first, second], hiddenProjects: '1', nextCursor: null });
    mocks.projectAccess.mockImplementation(id => id === first.id ? Promise.reject(new ApiError('network')) : late.promise);
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Project access or impact changed/);
    expect(mocks.projectAccess).toHaveBeenCalledTimes(2); mocks.projectAccess.mockResolvedValue({});
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/);
    await act(async () => late.reject(new ApiError('server', 403, 'forbidden')));
    expect(within(dialog).getByText(/Private project/)).toBeVisible(); expect(within(dialog).getByText(/Second project/)).toBeVisible();
  });
  it('discards the visible Project page if hidden counts change during verification', async () => {
    const project = { id: other, name: 'Private project', repoUrl: 'https://example.test/private' };
    mocks.projects.mockResolvedValue({ items: [project], hiddenProjects: '0', nextCursor: null });
    mocks.impact.mockResolvedValueOnce(impact).mockResolvedValueOnce({ ...impact, visibleProjects: '1', hiddenProjects: '0' }).mockResolvedValue(impact);
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Project access or impact changed/);
    expect(within(dialog).queryByText(/Private project/)).toBeNull();
  });
  it('lets an unknown revocation be reviewed after the original grant becomes unavailable', async () => {
    mocks.revoke.mockImplementation(async (_app, _id, _input, _signal, access) => { access.onDispatch(); throw new ApiError('network'); });
    mocks.get.mockRejectedValue(new ApiError('server', 404, 'not_found'));
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Revoke access and disconnect' })); await within(dialog).findByText(/outcome is unknown/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' })); await within(dialog).findByText(/does not establish the original operation/);
    expect(mocks.get.mock.calls[0]![1]).toBe(grantId); expect(mocks.revoke).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish review and decide again' })); expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.revoke).toHaveBeenCalledOnce();
  });
  it('rechecks the App when grant impact disappears during listing', async () => {
    mocks.impact.mockRejectedValue(new ApiError('server', 404, 'not_found')); mocks.app.mockRejectedValue(new ApiError('server', 404, 'not_found'));
    render(subject()); await waitFor(() => expect(unavailable).toHaveBeenCalled());
    expect(screen.queryByText('Personal Team')).toBeNull();
  });
  it('keeps confirmed permission loss and late results isolated across account change', async () => {
    const pending = deferred<typeof grant>(); mocks.create.mockImplementation((_app, _input, _signal, access) => { access.onDispatch(); return pending.promise; });
    const view = render(subject()); await openAuthorization(); const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await within(dialog).findByText('Personal Team', { selector: 'strong' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access' })); await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    scope = { ...scope, userId: other } as TaskCacheScope; view.rerender(subject()); await act(async () => pending.resolve(grant));
    expect(onResult).not.toHaveBeenCalled(); expect(screen.queryByText('Team access granted.')).toBeNull();
  });
  it('keeps the retained list visible but gates actions until route reentry is admitted', async () => {
    const view = render(subject()); await screen.findByText('1 connections'); view.rerender(subject({ active: false }));
    const pending = deferred<{ items: typeof grant[]; nextCursor: null }>(); mocks.list.mockReturnValueOnce(pending.promise);
    view.rerender(subject()); expect(screen.getByText('1 connections')).toBeVisible(); expect(screen.getByRole('button', { name: 'Authorize Team' })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => pending.reject(new ApiError('server', 404, 'not_found'))); await waitFor(() => expect(unavailable).toHaveBeenCalled());
    expect(screen.queryByText('1 connections')).toBeNull();
  });
  it('retains the verified draft during a temporary admission check', async () => {
    const view = render(subject()); await openAuthorization();
    const dialog = screen.getByRole('dialog'); fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await within(dialog).findByText('Personal Team', { selector: 'strong' });
    view.rerender(subject({ admissionBlocked: true })); expect(within(dialog).getByLabelText('Team ID')).toHaveValue(teamId); expect(within(dialog).getByText('Personal Team', { selector: 'strong' })).toBeVisible(); expect(within(dialog).getByRole('button', { name: 'Grant access' })).toHaveAttribute('aria-disabled', 'true');
    view.rerender(subject()); expect(within(dialog).getByLabelText('Team ID')).toHaveValue(teamId); expect(within(dialog).getByText('Personal Team', { selector: 'strong' })).toBeVisible();
  });
  it('clears protected data on host denial and publishes a later confirmed receipt', async () => {
    const pending = deferred<typeof grant>(); mocks.create.mockImplementation((_app, _input, _signal, access) => { access.onDispatch(); return pending.promise; });
    const view = render(subject()); await openAuthorization(); const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await within(dialog).findByText('Personal Team', { selector: 'strong' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access' })); await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    view.rerender(subject({ active: false, accessDenied: true })); expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByText('Personal Team')).toBeNull();
    await act(async () => pending.resolve(grant)); expect(onResult).toHaveBeenCalledWith('granted'); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it.each([true, false])('rechecks App after inaccessible Team preview (app accessible: %s)', async (appAccessible) => {
    mocks.preview.mockRejectedValue(new ApiError('server', 404, 'not_found')); if (!appAccessible) mocks.app.mockRejectedValue(new ApiError('server', 404, 'not_found'));
    render(subject()); const open = await screen.findByRole('button', { name: 'Authorize Team' }); await waitFor(() => expect(open).toBeEnabled()); fireEvent.click(open); const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' }));
    if (appAccessible) { await within(dialog).findByText(/Team or App is unavailable/); expect(unavailable).not.toHaveBeenCalled(); } else await waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
    expect(mocks.app).toHaveBeenCalledOnce();
  });
  it.each([true, false])('rechecks App after an inaccessible revocation preview (app accessible: %s)', async (appAccessible) => {
    mocks.impact.mockResolvedValueOnce(impact).mockRejectedValue(new ApiError('server', 404, 'not_found')); if (!appAccessible) mocks.app.mockRejectedValue(new ApiError('server', 404, 'not_found'));
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' }));
    if (appAccessible) { await screen.findByText(/Team or App is unavailable/); expect(unavailable).not.toHaveBeenCalled(); expect(screen.queryByText('Affected connections: 1')).toBeNull(); } else await waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
    expect(mocks.app).toHaveBeenCalledOnce();
  });
  it('does not classify an unknown grant as absent when App access is lost', async () => {
    mocks.create.mockImplementation(async (_app, _input, _signal, access) => { access.onDispatch(); throw new ApiError('network'); }); mocks.get.mockRejectedValue(new ApiError('server', 404, 'not_found')); mocks.app.mockRejectedValue(new ApiError('server', 404, 'not_found'));
    render(subject()); await openAuthorization(); const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await within(dialog).findByText('Personal Team', { selector: 'strong' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access' })); await within(dialog).findByText(/outcome is unknown/); fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' }));
    await waitFor(() => expect(unavailable).toHaveBeenCalledOnce()); expect(screen.queryByText(/does not establish the original operation/)).toBeNull();
    expect(await screen.findByText('This App is currently unavailable; the original outcome remains unknown.')).toBeVisible(); expect(screen.queryByText(/original grant is currently unavailable or absent/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Finish review and decide again' })); expect(screen.queryByText(/outcome is unknown/)).toBeNull(); expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('retains the unknown observation across host permission loss and allows a new decision after recovery', async () => {
    mocks.create.mockImplementation(async (_app, _input, _signal, access) => { access.onDispatch(); throw new ApiError('network'); }); mocks.get.mockRejectedValue(new ApiError('server', 404, 'not_found')); mocks.app.mockRejectedValue(new ApiError('server', 404, 'not_found'));
    const view = render(subject()); await openAuthorization(); const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await within(dialog).findByText('Personal Team', { selector: 'strong' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access' })); await within(dialog).findByText(/outcome is unknown/); fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' }));
    await screen.findByText('This App is currently unavailable; the original outcome remains unknown.'); view.rerender(subject({ active: false, accessDenied: true }));
    mocks.app.mockResolvedValue({}); view.rerender(subject()); await screen.findByText('This App is currently unavailable; the original outcome remains unknown.');
    fireEvent.click(screen.getByRole('button', { name: 'Finish review and decide again' })); await waitFor(() => expect(screen.getByRole('button', { name: 'Authorize Team' })).toBeEnabled()); expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('clears an old revoke summary when grant-scoped Project reading loses access', async () => {
    mocks.projects.mockRejectedValue(new ApiError('server', 404, 'not_found')); mocks.app.mockRejectedValue(new ApiError('server', 404, 'not_found'));
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
    expect(screen.queryByText('Affected connections: 1')).toBeNull(); expect(screen.queryByRole('button', { name: 'Revoke access and disconnect' })).toBeNull();
  });
  it('keeps the expanded Project page and its focus during foreground revalidation', async () => {
    const project = { id: other, name: 'Private project', repoUrl: 'https://example.test/private' }, page = { items: [project], hiddenProjects: '1', nextCursor: 'next-page' }; const pending = deferred<typeof impact>(), pendingPage = deferred<typeof page>();
    mocks.projects.mockResolvedValue(page); const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/); const more = within(dialog).getByRole('button', { name: 'Load more' }); more.focus();
    const impactCalls = mocks.impact.mock.calls.length, projectCalls = mocks.projects.mock.calls.length; mocks.impact.mockReturnValue(pending.promise); mocks.projects.mockReturnValue(pendingPage.promise); focus.mockReturnValue(false); fireEvent.blur(window); focus.mockReturnValue(true); fireEvent.focus(window);
    await waitFor(() => expect(mocks.impact.mock.calls.length).toBeGreaterThan(impactCalls)); expect(within(dialog).getByText(/Private project/)).toBeVisible(); expect(more).toHaveFocus(); expect(within(dialog).getByRole('button', { name: 'Revoke access and disconnect' })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => pending.resolve(impact)); await waitFor(() => expect(mocks.projects.mock.calls.length).toBeGreaterThan(projectCalls)); expect(within(dialog).getByText(/Private project/)).toBeVisible(); expect(more).toHaveFocus(); expect(more).toHaveAttribute('aria-disabled', 'true');
    await act(async () => pendingPage.resolve(page)); expect(within(dialog).getByText(/Private project/)).toBeVisible(); expect(more).toHaveFocus();
  });
  it('clears the expanded Project page after foreground revalidation confirms Project access was lost', async () => {
    const project = { id: other, name: 'Private project', repoUrl: 'https://example.test/private' }, pending = deferred<unknown>(); mocks.projects.mockResolvedValue({ items: [project], hiddenProjects: '1', nextCursor: null });
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true); render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/);
    const calls = mocks.projectAccess.mock.calls.length; mocks.projectAccess.mockReturnValue(pending.promise); focus.mockReturnValue(false); fireEvent.blur(window); focus.mockReturnValue(true); fireEvent.focus(window);
    await waitFor(() => expect(mocks.projectAccess.mock.calls.length).toBeGreaterThan(calls)); expect(within(dialog).getByText(/Private project/)).toBeVisible();
    await act(async () => pending.reject(new ApiError('server', 404, 'not_found'))); await within(dialog).findByText(/Project access or impact changed/);
    expect(within(dialog).queryByText(/Private project/)).toBeNull(); expect(unavailable).not.toHaveBeenCalled(); expect(mocks.app).toHaveBeenCalled(); expect(within(dialog).queryByRole('button', { name: 'Revoke access and disconnect' })).toBeNull();
  });

  it('clears the Project page as soon as one concurrent access check is denied', async () => {
    const first = { id: other, name: 'Private project', repoUrl: 'https://example.test/private' }, second = { id: '40000000-0000-4000-8000-000000000004', name: 'Second project', repoUrl: 'https://example.test/second' }, deniedAccess = deferred<unknown>(), pendingAccess = deferred<unknown>();
    mocks.projects.mockResolvedValue({ items: [first, second], hiddenProjects: '1', nextCursor: null }); const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog'); fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/);
    const calls = mocks.projectAccess.mock.calls.length; mocks.projectAccess.mockImplementation(id => id === first.id ? deniedAccess.promise : pendingAccess.promise); focus.mockReturnValue(false); fireEvent.blur(window); focus.mockReturnValue(true); fireEvent.focus(window);
    await waitFor(() => expect(mocks.projectAccess.mock.calls.length).toBe(calls + 2)); await act(async () => deniedAccess.reject(new ApiError('server', 404, 'not_found')));
    await waitFor(() => expect(within(dialog).queryByText(/Private project/)).toBeNull()); expect(within(dialog).queryByText(/Second project/)).toBeNull();
    await act(async () => pendingAccess.resolve({})); expect(within(dialog).queryByText(/Private project/)).toBeNull();
  });

  it('retains the expanded Project page after a transient foreground revalidation error', async () => {
    const project = { id: other, name: 'Private project', repoUrl: 'https://example.test/private' }; mocks.projects.mockResolvedValue({ items: [project], hiddenProjects: '1', nextCursor: null });
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true); render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/);
    mocks.projectAccess.mockRejectedValue(new ApiError('network')); focus.mockReturnValue(false); fireEvent.blur(window); focus.mockReturnValue(true); fireEvent.focus(window);
    await within(dialog).findByText(/Project access or impact changed/); expect(within(dialog).getByText(/Private project/)).toBeVisible(); expect(within(dialog).queryByRole('button', { name: 'Revoke access and disconnect' })).toBeNull(); expect(unavailable).not.toHaveBeenCalled();
  });

  it.each(['hiddenProjects', 'impactVersion'] as const)('clears stale Project details when foreground impact observes %s changed', async (field) => {
    const project = { id: other, name: 'Private project', repoUrl: 'https://example.test/private' }, pending = deferred<typeof impact>(); mocks.projects.mockResolvedValue({ items: [project], hiddenProjects: '1', nextCursor: null });
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true); render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/); const calls = mocks.projects.mock.calls.length;
    mocks.impact.mockReturnValue(pending.promise); focus.mockReturnValue(false); fireEvent.blur(window); focus.mockReturnValue(true); fireEvent.focus(window);
    expect(within(dialog).getByText(/Private project/)).toBeVisible(); await act(async () => pending.resolve({ ...impact, [field]: field === 'hiddenProjects' ? '2' : '9007199254740995' }));
    await waitFor(() => expect(within(dialog).queryByText(/Private project/)).toBeNull()); expect(mocks.projects).toHaveBeenCalledTimes(calls); expect(within(dialog).queryByRole('button', { name: 'Revoke access and disconnect' })).toBeNull();
  });

  it.each(['hiddenProjects', 'impactVersion', 'denied'] as const)('clears Project details when the list observes %s before the modal response', async (kind) => {
    const project = { id: other, name: 'Private project', repoUrl: 'https://example.test/private' }, modal = deferred<typeof impact>(), count = deferred<typeof impact>(); mocks.projects.mockResolvedValue({ items: [project], hiddenProjects: '1', nextCursor: null });
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true); render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/);
    const calls = mocks.impact.mock.calls.length, projectCalls = mocks.projects.mock.calls.length; mocks.impact.mockReturnValueOnce(modal.promise).mockReturnValueOnce(count.promise);
    focus.mockReturnValue(false); fireEvent.blur(window); focus.mockReturnValue(true); fireEvent.focus(window); await waitFor(() => expect(mocks.impact.mock.calls.length).toBe(calls + 2));
    expect(within(dialog).getByText(/Private project/)).toBeVisible();
    if (kind === 'denied') await act(async () => count.reject(new ApiError('server', 404, 'not_found'))); else await act(async () => count.resolve({ ...impact, [kind]: kind === 'hiddenProjects' ? '2' : '9007199254740995' }));
    await waitFor(() => expect(within(dialog).queryByText(/Private project/)).toBeNull()); expect(mocks.projects).toHaveBeenCalledTimes(projectCalls);
    expect(within(dialog).queryByRole('button', { name: 'Revoke access and disconnect' })).toBeNull();
    await act(async () => modal.resolve(impact)); expect(within(dialog).queryByText(/Private project/)).toBeNull(); expect(within(dialog).queryByRole('button', { name: 'Revoke access and disconnect' })).toBeNull();
  });
  it('ignores a stale Project page response after the list observes a changed impact', async () => {
    const project = { id: other, name: 'Private project', repoUrl: 'https://example.test/private' }, page = { items: [project], hiddenProjects: '1', nextCursor: null }, modal = deferred<typeof impact>(), count = deferred<typeof impact>(), pendingPage = deferred<typeof page>(); mocks.projects.mockResolvedValue(page);
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true); render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/);
    const calls = mocks.impact.mock.calls.length, projectCalls = mocks.projects.mock.calls.length; mocks.impact.mockReturnValueOnce(modal.promise).mockReturnValueOnce(count.promise); mocks.projects.mockReturnValue(pendingPage.promise);
    focus.mockReturnValue(false); fireEvent.blur(window); focus.mockReturnValue(true); fireEvent.focus(window); await waitFor(() => expect(mocks.impact.mock.calls.length).toBe(calls + 2));
    await act(async () => modal.resolve(impact)); await waitFor(() => expect(mocks.projects.mock.calls.length).toBeGreaterThan(projectCalls));
    await act(async () => count.resolve({ ...impact, hiddenProjects: '2' })); await waitFor(() => expect(within(dialog).queryByText(/Private project/)).toBeNull());
    await act(async () => pendingPage.resolve(page)); expect(within(dialog).queryByText(/Private project/)).toBeNull(); expect(within(dialog).queryByRole('button', { name: 'Revoke access and disconnect' })).toBeNull();
  });

  it('restores a retained dialog and focused Project control while route admission is pending', async () => {
    const project = { id: other, name: 'Private project', repoUrl: 'https://example.test/private' }; mocks.projects.mockResolvedValue({ items: [project], hiddenProjects: '1', nextCursor: 'next-page' });
    const view = render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog'); fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/);
    const more = within(dialog).getByRole('button', { name: 'Load more' }); more.focus(); view.rerender(subject({ active: false })); const pending = deferred<{ items: typeof grant[]; nextCursor: null }>(); mocks.list.mockReturnValueOnce(pending.promise);
    view.rerender(subject()); expect(screen.getByRole('dialog')).toBe(dialog); expect(within(dialog).getByText(/Private project/)).toBeVisible(); expect(more).toHaveFocus(); expect(more).toHaveAttribute('aria-disabled', 'true'); expect(within(dialog).getByRole('button', { name: 'Revoke access and disconnect' })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => pending.resolve({ items: [grant], nextCursor: null })); await waitFor(() => expect(more).toHaveAttribute('aria-disabled', 'false'));
  });

  it('restores a focused confirmation without permitting a write before route admission', async () => {
    const view = render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog'), confirm = await within(dialog).findByRole('button', { name: 'Revoke access and disconnect' });
    await waitFor(() => expect(confirm).toHaveAttribute('aria-disabled', 'false')); confirm.focus(); view.rerender(subject({ active: false })); const pending = deferred<{ items: typeof grant[]; nextCursor: null }>(); mocks.list.mockReturnValueOnce(pending.promise);
    view.rerender(subject()); expect(confirm).toHaveFocus(); expect(confirm).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(confirm); expect(mocks.revoke).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ items: [grant], nextCursor: null })); await waitFor(() => expect(confirm).toHaveAttribute('aria-disabled', 'false')); expect(confirm).toHaveFocus();
  });

  it.each(['admission', 'route'] as const)('restores the same expanded Project page after %s revalidation', async (kind) => {
    const first = { id: other, name: 'First project', repoUrl: 'https://example.test/first' }, second = { id: '40000000-0000-4000-8000-000000000004', name: 'Second project', repoUrl: 'https://example.test/second' };
    const secondPage = { items: [second], hiddenProjects: '1', nextCursor: null }; const pending = deferred<typeof secondPage>();
    mocks.projects.mockImplementation(async (_app, _grant, cursor) => cursor === null ? { items: [first], hiddenProjects: '1', nextCursor: 'next-page' } : secondPage);
    const view = render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/First project/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Load more' })); await within(dialog).findByText(/Second project/);
    const before = mocks.projects.mock.calls.length; mocks.projects.mockReturnValue(pending.promise);
    view.rerender(subject(kind === 'admission' ? { admissionBlocked: true } : { active: false })); view.rerender(subject());
    await waitFor(() => expect(mocks.projects.mock.calls.length).toBeGreaterThan(before)); expect(mocks.projects.mock.calls.at(-1)![2]).toBe('next-page');
    expect(within(dialog).getByText(/Second project/)).toBeVisible(); await act(async () => pending.resolve(secondPage));
    expect(await within(dialog).findByText(/Second project/)).toBeVisible(); expect(within(dialog).queryByText(/First project/)).toBeNull();
  });

  it('keeps expanded Project content and its focused control through temporary admission revalidation', async () => {
    const project = { id: other, name: 'Private project', repoUrl: 'https://example.test/private' }, page = { items: [project], hiddenProjects: '1', nextCursor: 'next-page' }, pending = deferred<typeof page>();
    mocks.projects.mockResolvedValue(page); const view = render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/);
    const more = within(dialog).getByRole('button', { name: 'Load more' }); more.focus(); expect(more).toHaveFocus(); const before = mocks.projects.mock.calls.length;
    view.rerender(subject({ admissionBlocked: true })); expect(within(dialog).getByText(/Private project/)).toBeVisible(); expect(more).toHaveFocus(); expect(more).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(more); expect(mocks.projects).toHaveBeenCalledTimes(before);
    mocks.projects.mockReturnValue(pending.promise); view.rerender(subject()); await waitFor(() => expect(mocks.projects.mock.calls.length).toBeGreaterThan(before));
    expect(within(dialog).getByText(/Private project/)).toBeVisible(); expect(more).toHaveFocus(); expect(more).toHaveAttribute('aria-disabled', 'true'); expect(within(dialog).getByRole('button', { name: 'Revoke access and disconnect' })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => pending.resolve(page)); expect(within(dialog).getByText(/Private project/)).toBeVisible(); expect(more).toHaveFocus();
  });
  it('lets the visible host finish an unknown review while the protected component is hidden', async () => {
    mocks.create.mockImplementation(async (_app, _input, _signal, access) => { access.onDispatch(); throw new ApiError('network'); });
    const Host = () => { const [lost, setLost] = useState(false), [review, setReview] = useState<GitHubAppGrantUnknownReview | null>(null); return <><button onClick={() => setLost(true)}>Lose access</button><button onClick={() => setLost(false)}>Restore access</button><div hidden={lost}>{subject({ accessDenied: lost, onUnknownReviewChange: setReview })}</div>{lost && review && <div role="status">{review.state}<button onClick={review.check}>Review outcome</button>{review.finish && <button onClick={review.finish}>Finish review</button>}</div>}</>; };
    render(<Host />); await openAuthorization(); const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Team ID'), { target: { value: teamId } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Team' })); await within(dialog).findByText('Personal Team', { selector: 'strong' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access' })); await within(dialog).findByText(/outcome is unknown/); fireEvent.click(screen.getByRole('button', { name: 'Lose access' }));
    expect(await screen.findByText('app-unavailable')).toBeVisible(); expect(screen.queryByText('Personal Team')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Finish review' }));
    expect(screen.queryByText('app-unavailable')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Restore access' })); await waitFor(() => expect(screen.getByRole('button', { name: 'Authorize Team' })).toBeEnabled()); expect(mocks.create).toHaveBeenCalledOnce();
  });

});
