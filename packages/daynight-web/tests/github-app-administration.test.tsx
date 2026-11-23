import { useState } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { CurrentUser } from '../src/api/auth-types';
import { GitHubAppAdministration, type GitHubAppAdminUnknownReview } from '../src/features/github-app-administration/GitHubAppAdministration';
import { GitHubAppInvitation, GitHubInvitationHost, type GitHubInvitationActivity } from '../src/features/github-app-administration/GitHubAppInvitation';
import type { TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { createLocaleRender } from './helpers/renderWithLocale';

const mocks = vi.hoisted(() => ({ admins: vi.fn(), invites: vi.fn(), create: vi.fn(), remove: vi.fn(), revoke: vi.fn(), inspect: vi.fn(), accept: vi.fn() }));
vi.mock('../src/api/github-app-admin', () => ({ listGitHubAppAdmins: mocks.admins, listGitHubAppAdminInvitations: mocks.invites, createGitHubAppAdminInvitation: mocks.create, removeGitHubAppAdmin: mocks.remove, revokeGitHubAppAdminInvitation: mocks.revoke, inspectGitHubAppAdminInvitation: mocks.inspect, acceptGitHubAppAdminInvitation: mocks.accept }));
const appId = '59cb4a41-9b96-43cd-8fe3-cbaf394a51e8', userId = 'c0d0a6d2-539a-4a14-87e0-e9c2de6bd058', otherId = 'a7d416e6-fac3-4f72-a696-31c016bd90b8', token = 'dn_gai_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const member = (id: string, version = '1') => ({ appId, userId: id, membershipVersion: version, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', profile: { name: id === userId ? 'Current User' : 'Another User', email: null, avatarUrl: null } });
const invitation = { id: '60cfd127-69aa-4ac8-a804-4b771b677842', appId, createdBy: userId, issuerMembershipVersion: '1', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', revokedAt: null, consumedAt: null, consumedBy: null, available: true };
const inspection = { app: { id: appId, githubAppId: '23', name: 'Release App', githubName: 'Release', githubSlug: 'release' }, expiresAt: invitation.expiresAt, membership: null };
const user: CurrentUser = { id: userId, name: 'Current User', email: 'user@example.test', emailVerified: true, avatarUrl: null, personalTeam: { id: '77777777-7777-4777-8777-777777777777', kind: 'personal', name: null } };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const render = createLocaleRender('en');
let scope: TaskCacheScope;
const accessLost = vi.fn(), selfRemoved = vi.fn(), mismatch = vi.fn(), accepted = vi.fn(), unavailable = vi.fn();
const admin = (active = true, accessDenied = false) => <GitHubAppAdministration appId={appId} active={active} admission={scope} admissionBlocked={false} accessDenied={accessDenied} onIdentityMismatch={mismatch} onAccessLost={accessLost} onSelfRemoved={selfRemoved} />;
const receiver = (value: string | null = token) => <GitHubAppInvitation token={value} user={user} active admission={scope} admissionBlocked={false} onIdentityMismatch={mismatch} onAccepted={accepted} onUnavailable={unavailable} />;
beforeEach(() => {
  vi.clearAllMocks(); const controller = new AbortController(); scope = { userId, signal: controller.signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  mocks.admins.mockResolvedValue({ items: [member(userId), member(otherId)], nextCursor: null }); mocks.invites.mockResolvedValue({ items: [], nextCursor: null }); mocks.inspect.mockResolvedValue(inspection);
});

describe('GitHub App administrators', () => {
  it('displays the invitation link once and removes it when the dialog closes', async () => {
    mocks.create.mockImplementation(async (_id, _signal, admission) => { admission.onDispatch(); return { ...invitation, link: `https://daynight.example/github-app-admin-invitations#${token}` }; });
    render(admin()); fireEvent.click(await screen.findByRole('button', { name: 'Invite administrator' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create invitation' })); const link = await within(dialog).findByRole('textbox', { name: 'Copy invitation link' }); expect((link as HTMLTextAreaElement).value).toContain('#dn_gai_');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' })); expect(screen.queryByDisplayValue(/#dn_gai_/)).toBeNull();
  });
  it('preserves the visible link and its selection while returning to the same App', async () => {
    mocks.create.mockImplementation(async (_id, _signal, admission) => { admission.onDispatch(); return { ...invitation, link: `https://daynight.example/github-app-admin-invitations#${token}` }; });
    const view = render(admin()); fireEvent.click(await screen.findByRole('button', { name: 'Invite administrator' })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation' }));
    const field = await screen.findByRole('textbox', { name: 'Copy invitation link' }) as HTMLTextAreaElement; await waitFor(() => expect(mocks.admins.mock.calls.length).toBeGreaterThan(1));
    field.focus(); field.setSelectionRange(8, 24); const pending = deferred<{ items: ReturnType<typeof member>[]; nextCursor: null }>(); mocks.admins.mockReturnValue(pending.promise);
    view.rerender(admin(false)); view.rerender(admin(true)); expect(screen.getByRole('textbox', { name: 'Copy invitation link' })).toBeVisible(); expect(screen.getByText('Another User')).toBeVisible(); expect(field.value).toContain('#dn_gai_');
    await act(async () => {}); expect(field).toHaveFocus(); expect(field.selectionStart).toBe(8); expect(field.selectionEnd).toBe(24);
    await act(async () => pending.resolve({ items: [member(userId), member(otherId)], nextCursor: null })); expect(field).toBeVisible(); expect(field).toHaveFocus();
  });
  it('clears a one-time link if the issuer rejoins with a different membership version', async () => {
    const roster = deferred<{ items: ReturnType<typeof member>[]; nextCursor: null }>();
    mocks.admins.mockResolvedValueOnce({ items: [member(userId), member(otherId)], nextCursor: null }).mockReturnValue(roster.promise);
    mocks.create.mockImplementation(async (_id, _signal, admission) => { admission.onDispatch(); return { ...invitation, link: `https://daynight.example/github-app-admin-invitations#${token}` }; });
    render(admin()); fireEvent.click(await screen.findByRole('button', { name: 'Invite administrator' })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation' }));
    expect(await screen.findByRole('textbox', { name: 'Copy invitation link' })).toBeVisible(); await act(async () => roster.resolve({ items: [member(userId, '2'), member(otherId)], nextCursor: null }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Copy invitation link' })).toBeNull()); expect(screen.getByText(/link cannot be shown/)).toBeVisible();
  });
  it('clears a displayed link as soon as the roster shows a new issuer version, while invitations are pending', async () => {
    const invites = deferred<{ items: typeof invitation[]; nextCursor: null }>();
    mocks.create.mockImplementation(async (_id, _signal, admission) => { admission.onDispatch(); return { ...invitation, link: `https://daynight.example/github-app-admin-invitations#${token}` }; });
    render(admin()); fireEvent.click(await screen.findByRole('button', { name: 'Invite administrator' }));
    mocks.admins.mockResolvedValue({ items: [member(userId, '2'), member(otherId)], nextCursor: null }); mocks.invites.mockReturnValue(invites.promise);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation' }));
    await waitFor(() => expect(mocks.admins.mock.calls.length).toBeGreaterThan(1));
    expect(await screen.findByText(/link cannot be shown/)).toBeVisible(); expect(screen.queryByDisplayValue(/#dn_gai_/)).toBeNull();
    await act(async () => invites.resolve({ items: [], nextCursor: null }));
  });
  it('does not expose a late invitation receipt after roster version changes while invitations are pending', async () => {
    const pending = deferred<typeof invitation & { link: string }>(), invites = deferred<{ items: typeof invitation[]; nextCursor: null }>();
    mocks.create.mockImplementation((_id, _signal, admission) => { admission.onDispatch(); return pending.promise; });
    const view = render(admin()); fireEvent.click(await screen.findByRole('button', { name: 'Invite administrator' })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    mocks.admins.mockResolvedValue({ items: [member(userId, '2'), member(otherId)], nextCursor: null }); mocks.invites.mockReturnValue(invites.promise);
    view.rerender(admin(false)); view.rerender(admin(true)); await waitFor(() => expect(mocks.admins.mock.calls.length).toBeGreaterThan(1)); await act(async () => {});
    await act(async () => pending.resolve({ ...invitation, link: `https://daynight.example/github-app-admin-invitations#${token}` }));
    expect(await screen.findByText(/link cannot be shown/)).toBeVisible(); expect(screen.queryByDisplayValue(/#dn_gai_/)).toBeNull();
    await act(async () => invites.resolve({ items: [], nextCursor: null }));
  });
  it('clears administration immediately when the complete roster excludes the actor, without waiting for invitations', async () => {
    const invites = deferred<{ items: typeof invitation[]; nextCursor: null }>();
    mocks.create.mockImplementation(async (_id, _signal, admission) => { admission.onDispatch(); return { ...invitation, link: `https://daynight.example/github-app-admin-invitations#${token}` }; });
    const view = render(admin()); fireEvent.click(await screen.findByRole('button', { name: 'Invite administrator' })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation' }));
    await screen.findByRole('textbox', { name: 'Copy invitation link' });
    mocks.admins.mockResolvedValue({ items: [member(otherId)], nextCursor: null }); mocks.invites.mockReturnValue(invites.promise);
    view.rerender(admin(false)); view.rerender(admin(true));
    await waitFor(() => expect(accessLost).toHaveBeenCalledOnce()); expect(screen.queryByDisplayValue(/#dn_gai_/)).toBeNull(); expect(screen.queryByText('Another User')).toBeNull();
    expect(screen.getByText('This App is unavailable or you do not have access.')).toBeVisible();
    await act(async () => invites.resolve({ items: [], nextCursor: null })); expect(screen.queryByDisplayValue(/#dn_gai_/)).toBeNull();
  });
  it('aborts the old roster when invitation reading fails and ignores its late result after retry', async () => {
    const roster = deferred<{ items: ReturnType<typeof member>[]; nextCursor: null }>();
    const view = render(admin()); await screen.findByText('Another User');
    mocks.admins.mockReturnValue(roster.promise); mocks.invites.mockRejectedValue(new ApiError('network'));
    view.rerender(admin(false)); view.rerender(admin(true));
    await screen.findByText('Unable to read administrators or invitations. Try again.');
    const signal = mocks.admins.mock.calls.at(-1)![2] as AbortSignal; expect(signal.aborted).toBe(true);
    mocks.admins.mockResolvedValue({ items: [member(userId), member(otherId)], nextCursor: null }); mocks.invites.mockResolvedValue({ items: [], nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await waitFor(() => expect(screen.getByRole('button', { name: 'Invite administrator' })).toBeEnabled());
    await act(async () => roster.resolve({ items: [member(otherId)], nextCursor: null }));
    expect(accessLost).not.toHaveBeenCalled(); expect(screen.getByText('Another User')).toBeVisible(); expect(screen.getByRole('button', { name: 'Invite administrator' })).toBeEnabled();
  });
  it('finishes a delayed roster refresh after the invitation link dialog closes', async () => {
    const roster = deferred<{ items: ReturnType<typeof member>[]; nextCursor: null }>();
    mocks.create.mockImplementation(async (_id, _signal, admission) => { admission.onDispatch(); return { ...invitation, link: `https://daynight.example/github-app-admin-invitations#${token}` }; });
    render(admin()); fireEvent.click(await screen.findByRole('button', { name: 'Invite administrator' }));
    mocks.admins.mockReturnValue(roster.promise);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation' }));
    await screen.findByRole('textbox', { name: 'Copy invitation link' }); await waitFor(() => expect(mocks.admins.mock.calls.length).toBeGreaterThan(1));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await act(async () => roster.resolve({ items: [member(userId), member(otherId)], nextCursor: null }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Invite administrator' })).toBeEnabled());
    expect(screen.queryByDisplayValue(/#dn_gai_/)).toBeNull();
  });
  it('does not expose a created link after the issuer membership changed during the write', async () => {
    const pending = deferred<typeof invitation & { link: string }>();
    mocks.create.mockImplementation((_id, _signal, admission) => { admission.onDispatch(); return pending.promise; });
    const view = render(admin()); fireEvent.click(await screen.findByRole('button', { name: 'Invite administrator' })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce()); mocks.admins.mockResolvedValue({ items: [member(userId, '2'), member(otherId)], nextCursor: null });
    view.rerender(admin(false)); view.rerender(admin(true)); await waitFor(() => expect(mocks.admins.mock.calls.length).toBeGreaterThan(1)); await waitFor(() => expect(screen.getByText('Current User')).toBeVisible());
    await act(async () => pending.resolve({ ...invitation, link: `https://daynight.example/github-app-admin-invitations#${token}` }));
    expect(await screen.findByText(/Invitation created, but the link cannot be shown/)).toBeVisible(); expect(screen.queryByRole('textbox', { name: 'Copy invitation link' })).toBeNull();
  });
  it('does not expose a link whose receipt names a different issuer membership version', async () => {
    mocks.create.mockImplementation(async (_id, _signal, admission) => { admission.onDispatch(); return { ...invitation, issuerMembershipVersion: '2', link: `https://daynight.example/github-app-admin-invitations#${token}` }; });
    render(admin()); fireEvent.click(await screen.findByRole('button', { name: 'Invite administrator' })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation' }));
    expect(await screen.findByText(/Invitation created, but the link cannot be shown/)).toBeVisible(); expect(screen.queryByRole('textbox', { name: 'Copy invitation link' })).toBeNull();
  });
  it('honors a confirmed self-removal receipt even when access is lost before it arrives', async () => {
    const pending = deferred<{ appId: string; userId: string; removed: true; actorIsAdmin: false }>(); mocks.remove.mockImplementation((_app, _user, _version, _signal, admission) => { admission.onDispatch(); return pending.promise; });
    const view = render(admin()); await screen.findByText('Current User'); fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove administrator' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce()); mocks.admins.mockRejectedValue(new ApiError('server', 404, 'not_found')); view.rerender(admin(false)); view.rerender(admin(true));
    await waitFor(() => expect(accessLost).toHaveBeenCalled()); await act(async () => pending.resolve({ appId, userId, removed: true, actorIsAdmin: false }));
    await waitFor(() => expect(selfRemoved).toHaveBeenCalledOnce()); expect(mocks.remove.mock.calls[0]![2]).toBe('1');
  });
  it('disables removal of the last administrator without counting invitations', async () => {
    mocks.admins.mockResolvedValue({ items: [member(userId)], nextCursor: null }); mocks.invites.mockResolvedValue({ items: [invitation], nextCursor: null });
    render(admin()); const remove = await screen.findByRole('button', { name: 'Remove' });
    expect(remove).toBeDisabled(); expect(screen.getByRole('button', { name: 'Invite administrator' })).toBeEnabled();
    expect(screen.getByText(/At least one App administrator must remain/)).toBeVisible(); fireEvent.click(remove);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('updates removal availability after the roster changes', async () => {
    mocks.remove.mockImplementation(async (_app, _user, _version, _signal, admission) => {
      admission.onDispatch(); mocks.admins.mockResolvedValue({ items: [member(userId)], nextCursor: null });
      return { appId, userId: otherId, removed: true, actorIsAdmin: true };
    });
    const view = render(admin()); await screen.findByText('Another User');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })); expect(mocks.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove administrator' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()); expect(mocks.remove).toHaveBeenCalledOnce();
    mocks.admins.mockResolvedValue({ items: [member(userId), member(otherId)], nextCursor: null });
    view.rerender(admin(false)); view.rerender(admin(true));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2));
    expect(screen.getAllByRole('button', { name: 'Remove' })[0]).toBeEnabled();
  });
  it('does not treat a partially loaded roster as a sole administrator', async () => {
    mocks.admins.mockImplementation(async (_app, cursor) => cursor === null
      ? { items: [member(userId)], nextCursor: 'next' }
      : { items: [member(otherId)], nextCursor: null });
    render(admin()); expect(await screen.findByRole('button', { name: 'Remove' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2));
    expect(screen.getAllByRole('button', { name: 'Remove' })[1]).toBeEnabled();
  });
  it('does not replay an unknown invitation creation after a state check', async () => {
    mocks.create.mockImplementation(async (_id, _signal, admission) => { admission.onDispatch(); throw new ApiError('network'); });
    render(admin()); fireEvent.click(await screen.findByRole('button', { name: 'Invite administrator' })); const dialog = screen.getByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: 'Create invitation' }));
    await within(dialog).findByText(/result is unknown/); fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' })); await within(dialog).findByText(/cannot confirm the original operation/);
    expect(mocks.create).toHaveBeenCalledOnce(); fireEvent.click(within(dialog).getByRole('button', { name: 'Finish review and decide again' })); expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('handles a last-admin refusal from the server after the roster changed', async () => {
    mocks.remove.mockImplementation(async (_app, _user, _version, _signal, admission) => { admission.onDispatch(); throw new ApiError('server', 409, 'last_admin'); });
    render(admin()); await screen.findByText('Another User'); fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!); const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove administrator' })); expect(await within(dialog).findByText(/must retain at least one administrator/)).toBeVisible(); expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it('allows explicit dismissal of an unknown write after the App becomes inaccessible', async () => {
    mocks.create.mockImplementation(async (_app, _signal, admission) => { admission.onDispatch(); throw new ApiError('network'); });
    render(admin()); fireEvent.click(await screen.findByRole('button', { name: 'Invite administrator' })); const dialog = screen.getByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: 'Create invitation' }));
    await within(dialog).findByText(/result is unknown/); mocks.admins.mockRejectedValue(new ApiError('server', 404, 'not_found')); fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' }));
    expect(await screen.findByText('The current state was read; it cannot confirm the original operation.')).toBeVisible(); expect(accessLost).toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Finish review and decide again' })); expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('requires a fresh target selection after a membership version conflict', async () => {
    mocks.remove.mockImplementation(async (_app, _user, _version, _signal, admission) => { admission.onDispatch(); throw new ApiError('server', 409, 'github_admin_changed'); });
    render(admin()); await screen.findByText('Another User'); fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!); const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove administrator' })); await within(dialog).findByText(/relationship changed/); mocks.admins.mockResolvedValue({ items: [member(userId), member(otherId, '2')], nextCursor: null });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' })); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it('rechecks App access rather than treating a missing removal target as lost App access', async () => {
    mocks.remove.mockImplementation(async (_app, _user, _version, _signal, admission) => { admission.onDispatch(); throw new ApiError('server', 404, 'not_found'); });
    render(admin()); await screen.findByText('Another User'); fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove administrator' }));
    await waitFor(() => expect(mocks.admins.mock.calls.length).toBeGreaterThan(1)); expect(accessLost).not.toHaveBeenCalled(); expect(screen.getAllByText('Another User')[0]).toBeVisible();
  });

  it('clears a one-time link when the owning App host reports lost access', async () => {
    mocks.create.mockImplementation(async (_id, _signal, admission) => { admission.onDispatch(); return { ...invitation, link: `https://daynight.example/github-app-admin-invitations#${token}` }; });
    const view = render(admin()); fireEvent.click(await screen.findByRole('button', { name: 'Invite administrator' })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation' }));
    await screen.findByRole('textbox', { name: 'Copy invitation link' }); view.rerender(admin(true, true)); expect(screen.queryByRole('textbox', { name: 'Copy invitation link' })).toBeNull();
    expect(screen.queryByText('Another User')).toBeNull(); expect(accessLost).not.toHaveBeenCalled();
  });
  it('retains a self-removal receipt after the owning App host reports lost access', async () => {
    const pending = deferred<{ appId: string; userId: string; removed: true; actorIsAdmin: false }>(); mocks.remove.mockImplementation((_app, _user, _version, _signal, admission) => { admission.onDispatch(); return pending.promise; });
    const view = render(admin()); await screen.findByText('Current User'); fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove administrator' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce()); view.rerender(admin(true, true)); expect(screen.queryByText('Current User')).toBeNull();
    await act(async () => pending.resolve({ appId, userId, removed: true, actorIsAdmin: false })); await waitFor(() => expect(selfRemoved).toHaveBeenCalledOnce()); expect(accessLost).not.toHaveBeenCalled();
  });

  it.each(['invite', 'remove', 'revoke'] as const)('reports a confirmed %s without private data after the App becomes inaccessible', async kind => {
    const confirmed = vi.fn();
    const created = deferred<typeof invitation & { link: string }>();
    const removed = deferred<{ appId: string; userId: string; removed: true; actorIsAdmin: true }>();
    const revoked = deferred<{ appId: string; invitationId: string; changed: boolean }>();
    mocks.invites.mockResolvedValue({ items: [invitation], nextCursor: null });
    mocks.create.mockImplementation((_app, _signal, admission) => { admission.onDispatch(); return created.promise; });
    mocks.remove.mockImplementation((_app, _user, _version, _signal, admission) => { admission.onDispatch(); return removed.promise; });
    mocks.revoke.mockImplementation((_app, _invitation, _signal, admission) => { admission.onDispatch(); return revoked.promise; });
    const subject = (active: boolean, lost: boolean) => <GitHubAppAdministration appId={appId} active={active} admission={scope} admissionBlocked={false} accessDenied={lost} onIdentityMismatch={mismatch} onAccessLost={accessLost} onSelfRemoved={selfRemoved} onConfirmedResult={confirmed} />;
    const view = render(subject(true, false)); await screen.findByText('Another User');
    if (kind === 'invite') fireEvent.click(screen.getByRole('button', { name: 'Invite administrator' }));
    if (kind === 'remove') fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);
    if (kind === 'revoke') fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: kind === 'invite' ? 'Create invitation' : kind === 'remove' ? 'Remove administrator' : 'Revoke invitation' }));
    await waitFor(() => expect(mocks[kind === 'invite' ? 'create' : kind]).toHaveBeenCalledOnce());
    view.rerender(subject(false, true));
    await act(async () => {
      if (kind === 'invite') created.resolve({ ...invitation, link: `https://daynight.example/github-app-admin-invitations#${token}` });
      if (kind === 'remove') removed.resolve({ appId, userId: otherId, removed: true, actorIsAdmin: true });
      if (kind === 'revoke') revoked.resolve({ appId, invitationId: invitation.id, changed: true });
    });
    await waitFor(() => expect(confirmed).toHaveBeenCalledExactlyOnceWith(kind));
    expect(selfRemoved).not.toHaveBeenCalled(); expect(screen.queryByDisplayValue(/#dn_gai_/)).toBeNull();
  });

  it('reports a confirmed receipt after leaving, but does not publish to a different owner', async () => {
    const confirmed = vi.fn(), pending = deferred<{ appId: string; userId: string; removed: true; actorIsAdmin: true }>();
    mocks.remove.mockImplementation((_app, _user, _version, _signal, admission) => { admission.onDispatch(); return pending.promise; });
    const subject = (active: boolean) => <GitHubAppAdministration appId={appId} active={active} admission={scope} admissionBlocked={false} accessDenied={false} onIdentityMismatch={mismatch} onAccessLost={accessLost} onSelfRemoved={selfRemoved} onConfirmedResult={confirmed} />;
    const view = render(subject(true)); await screen.findByText('Another User'); fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove administrator' }));
    view.rerender(subject(false)); await act(async () => pending.resolve({ appId, userId: otherId, removed: true, actorIsAdmin: true })); await waitFor(() => expect(confirmed).toHaveBeenCalledExactlyOnceWith('remove'));
    view.rerender(subject(true)); await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove' })[1]).toBeEnabled());
    const next = deferred<{ appId: string; userId: string; removed: true; actorIsAdmin: true }>(); mocks.remove.mockImplementation((_app, _user, _version, _signal, admission) => { admission.onDispatch(); return next.promise; });
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove administrator' }));
    scope = { ...scope, userId: otherId } as TaskCacheScope; view.rerender(subject(false)); await act(async () => next.resolve({ appId, userId: otherId, removed: true, actorIsAdmin: true }));
    expect(confirmed).toHaveBeenCalledOnce();
  });

  it('lets the visible owner resolve unknown after the protected admin area is hidden', async () => {
    mocks.create.mockImplementation(async (_id, _signal, admission) => { admission.onDispatch(); throw new ApiError('network'); });
    const Host = () => { const [lost, setLost] = useState(false), [review, setReview] = useState<GitHubAppAdminUnknownReview | null>(null); return <><button onClick={() => setLost(true)}>Lose access</button><button onClick={() => setLost(false)}>Restore access</button><div hidden={lost}><GitHubAppAdministration appId={appId} active={!lost} admission={scope} admissionBlocked={false} accessDenied={lost} onIdentityMismatch={mismatch} onAccessLost={accessLost} onSelfRemoved={selfRemoved} onUnknownReviewChange={setReview} /></div>{lost && review && <div role="status">{review.state}<button onClick={review.check}>Review outcome</button>{review.finish && <button onClick={review.finish}>Finish review</button>}</div>}</>; };
    render(<Host />); fireEvent.click(await screen.findByRole('button', { name: 'Invite administrator' })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation' }));
    await within(screen.getByRole('dialog')).findByText(/result is unknown/); fireEvent.click(screen.getByRole('button', { name: 'Lose access' }));
    expect(await screen.findByText('app-unavailable')).toBeVisible(); expect(screen.queryByText('Another User')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Finish review' }));
    expect(screen.queryByText('app-unavailable')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Restore access' })); await waitFor(() => expect(screen.getByRole('button', { name: 'Invite administrator' })).toBeEnabled()); expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('invalidates owner review callbacks when the account changes', async () => {
    mocks.create.mockImplementation(async (_id, _signal, admission) => { admission.onDispatch(); throw new ApiError('network'); });
    const reviews: GitHubAppAdminUnknownReview[] = [], changed = (review: GitHubAppAdminUnknownReview | null) => { if (review) reviews.push(review); };
    const subject = () => <GitHubAppAdministration appId={appId} active admission={scope} admissionBlocked={false} accessDenied={false} onIdentityMismatch={mismatch} onAccessLost={accessLost} onSelfRemoved={selfRemoved} onUnknownReviewChange={changed} />;
    const view = render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Invite administrator' })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation' }));
    await waitFor(() => expect(reviews.length).toBeGreaterThan(0)); const old = reviews.at(-1)!;
    scope = { ...scope, userId: otherId } as TaskCacheScope; view.rerender(subject()); await waitFor(() => expect(mocks.admins.mock.calls.length).toBeGreaterThan(1));
    const reads = mocks.admins.mock.calls.length; old.check(); old.finish?.(); await act(async () => {}); expect(mocks.admins).toHaveBeenCalledTimes(reads); expect(mocks.create).toHaveBeenCalledOnce();
  });

});

describe('GitHub App invitation reception', () => {
  it('does not inspect a missing fragment and displays the actual accepting account', async () => {
    const view = render(receiver(null)); expect(screen.getByText(/invitation expired/)).toBeVisible(); expect(mocks.inspect).not.toHaveBeenCalled();
    view.rerender(receiver()); expect(await screen.findByText(/Current User · user@example.test/)).toBeVisible(); expect(mocks.inspect.mock.calls[0]![0]).toBe(token);
  });
  it('reports an unknown acceptance even when readback says invitation unavailable', async () => {
    mocks.accept.mockImplementation(async (_token, _app, _signal, admission) => { admission.onDispatch(); throw new ApiError('network'); });
    render(receiver()); fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' })); await screen.findByText(/Acceptance has not been confirmed/);
    mocks.inspect.mockRejectedValue(new ApiError('server', 404, 'invitation_unavailable')); fireEvent.click(screen.getByRole('button', { name: 'Check current state' }));
    expect(await screen.findByText(/cannot confirm the original operation/)).toBeVisible(); expect(screen.getByText(/invitation expired/)).toBeVisible(); expect(mocks.accept).toHaveBeenCalledOnce(); expect(accepted).not.toHaveBeenCalled(); expect(unavailable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish review and decide again' })); expect(unavailable).toHaveBeenCalledOnce(); expect(mocks.accept).toHaveBeenCalledOnce();
  });
  it('shows a confirmed acceptance before navigating only on explicit action', async () => {
    mocks.accept.mockImplementation(async (_token, _app, _signal, admission) => { admission.onDispatch(); return { appId, membership: member(userId), joined: true }; });
    render(receiver()); fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' })); await screen.findByText('You are now an administrator of this App.'); expect(accepted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open App management' })); expect(accepted).toHaveBeenCalledWith(appId); expect(mocks.accept.mock.calls[0]![1]).toBe(appId);
  });
  it('preserves a confirmed acceptance when a concurrent read observes an unavailable invitation', async () => {
    const pending = deferred<{ appId: string; membership: ReturnType<typeof member>; joined: true }>();
    mocks.accept.mockImplementation((_token, _app, _signal, admission) => { admission.onDispatch(); return pending.promise; });
    const view = render(receiver()); fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' })); await waitFor(() => expect(mocks.accept).toHaveBeenCalledOnce());
    mocks.inspect.mockRejectedValue(new ApiError('server', 404, 'invitation_unavailable')); view.rerender(<GitHubAppInvitation token={token} user={user} active={false} admission={scope} admissionBlocked={false} onIdentityMismatch={mismatch} onAccepted={accepted} onUnavailable={unavailable} />); view.rerender(receiver());
    await screen.findByText(/invitation expired/); expect(unavailable).not.toHaveBeenCalled(); await act(async () => pending.resolve({ appId, membership: member(userId), joined: true }));
    expect(await screen.findByText('You are now an administrator of this App.')).toBeVisible(); expect(unavailable).not.toHaveBeenCalled();
  });

});


describe('retained GitHub App invitation acceptance', () => {
  const retention = vi.fn<(activity: GitHubInvitationActivity) => void>(), consumed = vi.fn(), discarded = vi.fn();
  const Host = ({ currentUser = user, admission = scope, initial = token }: { currentUser?: CurrentUser; admission?: TaskCacheScope; initial?: string | null }) => {
    const [active, setActive] = useState(true), [secret, setSecret] = useState<string | null>(initial);
    return <><button type="button" onClick={() => setActive(false)}>Leave invitation</button><GitHubInvitationHost token={secret} user={currentUser} active={active} admission={admission} admissionBlocked={false} onIdentityMismatch={mismatch} onRetentionChange={retention} onTokenConsumed={() => { consumed(); setSecret(null); }} onDiscard={() => { discarded(); setSecret(null); }} onAccepted={accepted} onReturn={() => setActive(true)} /></>;
  };
  it('retains a dispatched acceptance across navigation and releases the token after a confirmed receipt', async () => {
    const pending = deferred<{ appId: string; membership: ReturnType<typeof member>; joined: boolean }>(); mocks.accept.mockImplementation((_token, _app, _signal, access) => { access.onDispatch(); return pending.promise; });
    render(<Host />); fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' })); await waitFor(() => expect(mocks.accept).toHaveBeenCalledOnce()); const signal = mocks.accept.mock.calls[0]![2] as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'Leave invitation' })); expect(screen.getByText('Accepting the App administrator invitation.')).toBeVisible(); expect(signal.aborted).toBe(false); expect(screen.queryByText('Release App')).toBeNull();
    await act(async () => pending.resolve({ appId, membership: member(userId), joined: true })); expect(await screen.findByText('The App administrator invitation was accepted.')).toBeVisible(); expect(consumed).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Return to invitation' })); expect(await screen.findByText('You are now an administrator of this App.')).toBeVisible(); expect(mocks.accept).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Open App management' })); expect(accepted).toHaveBeenCalledWith(appId); expect(discarded).toHaveBeenCalled();
  });
  it('retains an unknown outcome across navigation until explicit review without replay', async () => {
    const pending = deferred<never>(); mocks.accept.mockImplementation((_token, _app, _signal, access) => { access.onDispatch(); return pending.promise; });
    render(<Host />); fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' })); await waitFor(() => expect(mocks.accept).toHaveBeenCalledOnce()); fireEvent.click(screen.getByRole('button', { name: 'Leave invitation' }));
    await act(async () => pending.reject(new ApiError('network'))); expect(await screen.findByText(/invitation acceptance outcome is unknown/)).toBeVisible(); expect(consumed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Return to invitation' })); await screen.findByText(/Acceptance has not been confirmed/); fireEvent.click(screen.getByRole('button', { name: 'Check current state' })); await screen.findByText(/cannot confirm the original operation/);
    fireEvent.click(screen.getByRole('button', { name: 'Finish review and decide again' })); expect(discarded).toHaveBeenCalled(); expect(mocks.accept).toHaveBeenCalledOnce();
  });
  it('retains a definite rejection and releases the token after leaving', async () => {
    const pending = deferred<never>(); mocks.accept.mockImplementation((_token, _app, _signal, access) => { access.onDispatch(); return pending.promise; });
    render(<Host />); fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' })); await waitFor(() => expect(mocks.accept).toHaveBeenCalledOnce()); fireEvent.click(screen.getByRole('button', { name: 'Leave invitation' }));
    await act(async () => pending.reject(new ApiError('server', 409, 'conflict'))); expect(await screen.findByText('The App administrator invitation was not accepted.')).toBeVisible(); expect(consumed).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Return to invitation' })); expect(await screen.findByText(/operation failed/i)).toBeVisible(); expect(mocks.accept).toHaveBeenCalledOnce();
  });
  it('retains confirmed acceptance while result publication needs retry', async () => {
    let failPublication = false; const checkedScope = { ...scope, ready: async (signal: AbortSignal) => { signal.throwIfAborted(); if (failPublication) throw new Error('publication failed'); } } as TaskCacheScope;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {}); mocks.accept.mockImplementation(async (_token, _app, _signal, access) => { access.onDispatch(); failPublication = true; return { appId, membership: member(userId), joined: true }; });
    render(<Host admission={checkedScope} />); fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' })); await screen.findByText(/operation succeeded, but its result could not be displayed/i);
    fireEvent.click(screen.getByRole('button', { name: 'Leave invitation' })); expect(screen.getByText('The invitation was accepted. Return to finish displaying the result.')).toBeVisible(); expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Return to invitation' })); failPublication = false; fireEvent.click(screen.getByRole('button', { name: 'Retry showing result' })); expect(await screen.findByText('You are now an administrator of this App.')).toBeVisible(); expect(mocks.accept).toHaveBeenCalledOnce(); log.mockRestore();
  });
  it('destroys a retained dispatched request on identity replacement', async () => {
    const pending = deferred<{ appId: string; membership: ReturnType<typeof member>; joined: boolean }>(); mocks.accept.mockImplementation((_token, _app, _signal, access) => { access.onDispatch(); return pending.promise; });
    const view = render(<Host key="first" />); fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' })); await waitFor(() => expect(mocks.accept).toHaveBeenCalledOnce()); const signal = mocks.accept.mock.calls[0]![2] as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'Leave invitation' })); const otherScope = { ...scope, userId: otherId } as TaskCacheScope; view.rerender(<Host key="other" currentUser={{ ...user, id: otherId }} admission={otherScope} initial={null} />);
    expect(signal.aborted).toBe(true); await act(async () => pending.resolve({ appId, membership: member(userId), joined: true })); expect(screen.queryByText('The App administrator invitation was accepted.')).toBeNull(); expect(accepted).not.toHaveBeenCalled();
  });
});
