import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError, pauseAuthRequests, waitForAuthRequests } from '../src/api/client';
import type { TeamInvitation } from '../src/api/auth';
import type { TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { TeamInvitations } from '../src/features/management/TeamInvitations';
import { createLocaleRender } from './helpers/renderWithLocale';

vi.mock('../src/api/auth', () => ({ listTeamInvitations: vi.fn(), createTeamInvitation: vi.fn(), revokeTeamInvitation: vi.fn() }));
import { listTeamInvitations, createTeamInvitation, revokeTeamInvitation } from '../src/api/auth';
const render = createLocaleRender('en');
const userId = '00000000-0000-4000-8000-000000000001', teamId = '00000000-0000-4000-8000-000000000002', id = '00000000-0000-4000-8000-000000000003';
const invitation: TeamInvitation = { id, teamId, createdBy: userId, createdAt: '2026-10-20T09:00:00Z', expiresAt: '2026-10-27T09:00:00Z', consumedBy: null, consumedAt: null, revokedAt: null };
const link = 'http://localhost:3000/team-invitations#dnteam_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
let scope: TaskCacheScope;
const mismatch = vi.fn(), permission = vi.fn(), guard = vi.fn();
const openInvite = async () => { const button = await screen.findByRole('button', { name: 'Invite member' }); await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button); };
const panel = (active = true, onRoute = true, editable = true, admissionBlocked = false, permissionReady = true) => <TeamInvitations teamId={teamId} teamName="Alpha" active={active} admissionBlocked={admissionBlocked} permissionReady={permissionReady} onRoute={onRoute} editable={editable} actorRole={editable ? 'admin' : null} unavailable={false} admission={scope} onIdentityMismatch={mismatch} onPermissionChange={permission} onGuardChange={guard} />;
beforeEach(() => {
  vi.clearAllMocks(); const controller = new AbortController();
  scope = { userId, signal: controller.signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  vi.mocked(listTeamInvitations).mockResolvedValue([invitation]);
});
it('shows metadata, confirms revocation once, and never shows a link in the list', async () => {
  vi.mocked(revokeTeamInvitation).mockImplementation(async (_team, _id, _user, _signal, _mismatch, dispatch) => { dispatch?.(); return { teamId, invitationId: id, changed: true }; });
  render(panel()); const revoke = await screen.findByRole('button', { name: `Revoke invitation ${id}` });
  expect(screen.getByText(id)).toBeInTheDocument(); expect(screen.queryByDisplayValue(link)).toBeNull();
  fireEvent.click(revoke); fireEvent.keyDown(document, { key: 'Escape' }); expect(revokeTeamInvitation).not.toHaveBeenCalled();
  fireEvent.click(revoke); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke invitation' }));
  await screen.findByText('Invitation revoked.'); expect(revokeTeamInvitation).toHaveBeenCalledTimes(1);
});
it('displays the secret once and retains a dispatched result across navigation', async () => {
  const pending = Promise.withResolvers<TeamInvitation & { link: string }>();
  vi.mocked(createTeamInvitation).mockImplementation(async (_team, _user, _signal, _mismatch, dispatch) => { dispatch?.(); return pending.promise; });
  const view = render(panel()); await openInvite();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation link' }));
  await waitFor(() => expect(createTeamInvitation).toHaveBeenCalledOnce());
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).queryByRole('combobox', { name: '语言 / Language' })).toBeNull();
  view.setLocale('zh-CN');
  expect(screen.getByRole('dialog', { name: '创建 Team 邀请链接' })).toBe(dialog);
  expect(within(dialog).getByRole('button', { name: '正在提交…' })).toBeDisabled();
  expect(createTeamInvitation).toHaveBeenCalledOnce();
  view.setLocale('en');
  view.rerender(panel(false, false));
  await act(async () => pending.resolve({ ...invitation, link })); expect(screen.getByDisplayValue(link)).not.toBeVisible();
  view.rerender(panel());
  expect(dialog).not.toBeVisible();
  expect(await screen.findByDisplayValue(link)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'I have saved it, close' })); expect(screen.queryByDisplayValue(link)).toBeNull();
});

it('preserves the confirmation when switching Team settings sections during creation', async () => {
  const pending = Promise.withResolvers<TeamInvitation & { link: string }>();
  vi.mocked(createTeamInvitation).mockImplementation(async (_team, _user, _signal, _mismatch, dispatch) => { dispatch?.(); return pending.promise; });
  const view = render(panel()); await openInvite();
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create invitation link' }));
  await waitFor(() => expect(createTeamInvitation).toHaveBeenCalledOnce());
  view.rerender(panel(false, true));
  await act(async () => pending.resolve({ ...invitation, link }));
  view.rerender(panel());
  expect(dialog).not.toBeVisible();
  expect(await screen.findByDisplayValue(link)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'I have saved it, close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('retains the original revoke dialog after leaving and returning before its receipt', async () => {
  const pending = Promise.withResolvers<{ teamId: string; invitationId: string; changed: boolean }>();
  vi.mocked(revokeTeamInvitation).mockImplementation(async (_team, _id, _user, _signal, _mismatch, dispatch) => { dispatch?.(); return pending.promise; });
  const view = render(panel());
  fireEvent.click(await screen.findByRole('button', { name: `Revoke invitation ${id}` }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke invitation' }));
  await waitFor(() => expect(revokeTeamInvitation).toHaveBeenCalledOnce());
  view.rerender(panel(false, false)); view.rerender(panel());
  await act(async () => pending.resolve({ teamId, invitationId: id, changed: true }));
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(screen.getByText('Invitation revoked.')).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Revoke invitation' })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await openInvite();
  expect(screen.getByRole('dialog', { name: 'Create Team invitation' })).toBeVisible();
  expect(revokeTeamInvitation).toHaveBeenCalledOnce();
});

it('does not deliver an old owner receipt to a replacement owner', async () => {
  const pending = Promise.withResolvers<TeamInvitation & { link: string }>();
  vi.mocked(createTeamInvitation).mockImplementation(async (_team, _user, _signal, _mismatch, dispatch) => { dispatch?.(); return pending.promise; });
  const old = render(panel()); await openInvite();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation link' }));
  await waitFor(() => expect(createTeamInvitation).toHaveBeenCalledOnce());
  old.unmount();
  render(panel()); await openInvite();
  const dialog = screen.getByRole('dialog', { name: 'Create Team invitation' });
  await act(async () => pending.resolve({ ...invitation, link }));
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(screen.queryByDisplayValue(link)).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await openInvite();
  expect(screen.getByRole('dialog', { name: 'Create Team invitation' })).toBeVisible();
});
it('keeps an unknown revoke from replaying even after reading current invitations', async () => {
  vi.mocked(revokeTeamInvitation).mockImplementation(async (_team, _id, _user, _signal, _mismatch, dispatch) => { dispatch?.(); throw new ApiError('network'); });
  render(panel()); fireEvent.click(await screen.findByRole('button', { name: `Revoke invitation ${id}` }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke invitation' }));
  const dialog = screen.getByRole('dialog'); expect(await within(dialog).findByRole('alert')).toHaveTextContent('not confirmed');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Read current invitations' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('button', { name: `Revoke invitation ${id}` })).toBeDisabled(); expect(revokeTeamInvitation).toHaveBeenCalledOnce();
});
it('does not render a management entry for an ineligible Team', () => {
  render(panel(true, true, false)); expect(screen.queryByRole('button', { name: 'Invite member' })).toBeNull(); expect(listTeamInvitations).not.toHaveBeenCalled();
});

it('discards a late secret when the identity scope ends', async () => {
  const pending = Promise.withResolvers<TeamInvitation & { link: string }>();
  vi.mocked(createTeamInvitation).mockImplementation(async (_team, _user, _signal, _mismatch, dispatch) => { dispatch?.(); return pending.promise; });
  const view = render(panel()); await openInvite();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation link' }));
  await waitFor(() => expect(createTeamInvitation).toHaveBeenCalledOnce()); view.unmount();
  await act(async () => pending.resolve({ ...invitation, link })); expect(screen.queryByDisplayValue(link)).toBeNull();
});

it('rejects a wrong-principal response without installing its secret', async () => {
  let invalidated = false;
  scope = { ...scope, get isInvalidated() { return invalidated; } } as TaskCacheScope;
  mismatch.mockImplementation(() => { invalidated = true; });
  vi.mocked(createTeamInvitation).mockImplementation(async (_team, _user, _signal, onMismatch, dispatch) => { dispatch?.(); onMismatch(); throw new ApiError('protocol', 201, 'principal_mismatch'); });
  render(panel()); await openInvite();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation link' }));
  await waitFor(() => expect(mismatch).toHaveBeenCalledOnce()); expect(screen.queryByDisplayValue(link)).toBeNull();
});
it.each([403, 404])('shows a persistent %s invitation denial without repeatedly refreshing Team permissions', async (status) => {
  vi.mocked(listTeamInvitations).mockRejectedValueOnce(new ApiError('server', status, status === 403 ? 'forbidden' : 'not_found'))
    .mockRejectedValueOnce(new ApiError('server', status, status === 403 ? 'forbidden' : 'not_found'))
    .mockResolvedValue([invitation]);
  const view = render(panel());
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to read invitations for this Team');
  expect(permission).toHaveBeenCalledOnce();
  view.rerender(panel(false)); view.rerender(panel());
  await waitFor(() => expect(listTeamInvitations).toHaveBeenCalledTimes(2));
  await screen.findByRole('alert'); expect(permission).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('button', { name: `Revoke invitation ${id}` });
  expect(screen.queryByRole('alert')).toBeNull(); expect(listTeamInvitations).toHaveBeenCalledTimes(3);
});
it('retains a displayed secret across navigation until it is explicitly closed', async () => {
  vi.mocked(createTeamInvitation).mockImplementation(async (_team, _user, _signal, _mismatch, dispatch) => { dispatch?.(); return { ...invitation, link }; });
  const view = render(panel()); await openInvite();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation link' }));
  expect(await screen.findByDisplayValue(link)).toBeVisible();
  view.rerender(panel(false, false)); expect(screen.getByDisplayValue(link)).not.toBeVisible();
  view.rerender(panel()); expect(screen.getByDisplayValue(link)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'I have saved it, close' }));
  expect(screen.queryByDisplayValue(link)).toBeNull();
  view.rerender(panel(false, false)); view.rerender(panel()); expect(screen.queryByDisplayValue(link)).toBeNull();
  expect(createTeamInvitation).toHaveBeenCalledOnce();
});
it('destroys a displayed secret when the identity owner unmounts', async () => {
  vi.mocked(createTeamInvitation).mockImplementation(async (_team, _user, _signal, _mismatch, dispatch) => { dispatch?.(); return { ...invitation, link }; });
  const view = render(panel()); await openInvite();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation link' }));
  expect(await screen.findByDisplayValue(link)).toBeVisible();
  view.rerender(panel(false, false)); view.unmount(); expect(screen.queryByDisplayValue(link)).toBeNull();
  render(panel()); await screen.findByRole('button', { name: 'Invite member' }); expect(screen.queryByDisplayValue(link)).toBeNull();
});

it('does not queue a submission or retain a guard during identity and invitation rechecks', async () => {
  const reread = Promise.withResolvers<readonly TeamInvitation[]>();
  vi.mocked(listTeamInvitations).mockResolvedValueOnce([invitation]).mockReturnValueOnce(reread.promise);
  vi.mocked(createTeamInvitation).mockImplementation(async (_team, _user, _signal, _mismatch, dispatch) => { dispatch?.(); return { ...invitation, link }; });
  const view = render(panel()); await openInvite();
  const item = screen.getByText(id);
  const dialog = screen.getByRole('dialog');
  const submit = within(dialog).getByRole('button', { name: 'Create invitation link' });
  const release = pauseAuthRequests();
  try {
    view.rerender(panel(true, true, true, true)); guard.mockClear();
    fireEvent.click(submit);
    expect(createTeamInvitation).not.toHaveBeenCalled(); expect(guard).not.toHaveBeenCalledWith(true, true);
    expect(screen.getByRole('dialog')).toBe(dialog);
    release(); view.rerender(panel());
    await waitFor(() => expect(listTeamInvitations).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('dialog')).toBe(dialog); expect(screen.getByText(id)).toBe(item);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(submit);
    expect(createTeamInvitation).not.toHaveBeenCalled(); expect(guard).not.toHaveBeenCalledWith(true, true);
    await act(async () => reread.resolve([{ ...invitation }]));
    expect(createTeamInvitation).not.toHaveBeenCalled();
    fireEvent.click(submit);
    await waitFor(() => expect(createTeamInvitation).toHaveBeenCalledOnce());
    await screen.findByDisplayValue(link);
  } finally { release(); }
});

it('holds a confirmed secret through identity checking and publishes it for the same principal', async () => {
  const pending = Promise.withResolvers<TeamInvitation & { link: string }>();
  vi.mocked(createTeamInvitation).mockImplementation(async (_team, _user, _signal, _mismatch, dispatch) => { dispatch?.(); return pending.promise; });
  scope = { ...scope, ready: waitForAuthRequests } as TaskCacheScope;
  const view = render(panel()); await openInvite();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation link' }));
  await waitFor(() => expect(createTeamInvitation).toHaveBeenCalledOnce());
  const release = pauseAuthRequests();
  try {
    view.rerender(panel(true, true, true, true, false));
    await act(async () => pending.resolve({ ...invitation, link }));
    expect(screen.queryByDisplayValue(link)).toBeNull();
    release(); view.rerender(panel(true, true, true, false, false));
    expect(await screen.findByDisplayValue(link)).toBeVisible();
    expect(createTeamInvitation).toHaveBeenCalledOnce();
  } finally { release(); }
});

it('publishes the confirmed link but defers invitation metadata until fresh admin access', async () => {
  const reread = Promise.withResolvers<readonly TeamInvitation[]>(), write = Promise.withResolvers<TeamInvitation & { link: string }>();
  const next = { ...invitation, id: '00000000-0000-4000-8000-000000000004' };
  vi.mocked(listTeamInvitations).mockResolvedValueOnce([invitation]).mockReturnValueOnce(reread.promise).mockResolvedValue([invitation, next]);
  vi.mocked(createTeamInvitation).mockImplementation(async (_team, _user, _signal, _mismatch, dispatch) => { dispatch?.(); return write.promise; });
  const view = render(panel()); await openInvite();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation link' }));
  await waitFor(() => expect(createTeamInvitation).toHaveBeenCalledOnce());
  view.rerender(panel(true, true, true, true, false));
  await act(async () => write.resolve({ ...next, link }));
  expect(await screen.findByDisplayValue(link)).toBeVisible();
  expect(screen.queryByText(next.id)).toBeNull();
  view.rerender(panel(true, true, true, false, false));
  await waitFor(() => expect(listTeamInvitations).toHaveBeenCalledTimes(2));
  await act(async () => reread.resolve([invitation, next]));
  expect(screen.queryByText(next.id)).toBeNull();
  view.rerender(panel(true, true, false, false, false));
  expect(screen.queryByText(next.id)).toBeNull();
  view.rerender(panel(true, true, true, false, true));
  await waitFor(() => expect(screen.getByText(next.id)).toBeInTheDocument());
  expect(createTeamInvitation).toHaveBeenCalledOnce();
});

it('retains the invitation list when an older permission read fails after a newer confirmation', async () => {
  const stale = Promise.withResolvers<readonly TeamInvitation[]>();
  const replacement = Promise.withResolvers<readonly TeamInvitation[]>();
  vi.mocked(listTeamInvitations).mockResolvedValueOnce([invitation]).mockReturnValueOnce(stale.promise).mockReturnValueOnce(replacement.promise);
  let revision = 1;
  const permissionRevision = () => revision;
  const view = render(<TeamInvitations teamId={teamId} teamName="Alpha" active onRoute editable actorRole="admin" unavailable={false} admission={scope} onIdentityMismatch={mismatch} onPermissionChange={permission} onGuardChange={guard} permissionRevision={revision} getPermissionRevision={permissionRevision} />);
  await screen.findByText(id);
  revision = 2;
  view.rerender(<TeamInvitations teamId={teamId} teamName="Alpha" active onRoute editable actorRole="admin" unavailable={false} admission={scope} onIdentityMismatch={mismatch} onPermissionChange={permission} onGuardChange={guard} permissionRevision={revision} getPermissionRevision={permissionRevision} />);
  await waitFor(() => expect(listTeamInvitations).toHaveBeenCalledTimes(2));
  // The next permission confirmation can precede its React render.
  revision = 3;
  await act(async () => stale.reject(new ApiError('server', 404, 'not_found')));
  await waitFor(() => expect(listTeamInvitations).toHaveBeenCalledTimes(3));
  expect(screen.getByText(id)).toBeInTheDocument(); expect(permission).not.toHaveBeenCalled();
  await act(async () => replacement.resolve([invitation]));
  expect(screen.getByText(id)).toBeInTheDocument();
});

it('starts only one invitation recovery read when admission and permission resume together', async () => {
  const recovery = Promise.withResolvers<readonly TeamInvitation[]>();
  vi.mocked(listTeamInvitations).mockResolvedValueOnce([invitation]).mockReturnValueOnce(recovery.promise);
  let revision = 1;
  const currentPermission = () => revision;
  const node = (blocked: boolean) => <TeamInvitations teamId={teamId} teamName="Alpha" active onRoute editable actorRole="admin" unavailable={false} admissionBlocked={blocked} admission={scope} onIdentityMismatch={mismatch} onPermissionChange={permission} onGuardChange={guard} permissionRevision={revision} getPermissionRevision={currentPermission} />;
  const view = render(node(false)); await screen.findByText(id);
  view.rerender(node(true)); revision = 2; view.rerender(node(false));
  await waitFor(() => expect(listTeamInvitations).toHaveBeenCalledTimes(2));
  await act(async () => {}); expect(listTeamInvitations).toHaveBeenCalledTimes(2);
  expect(screen.getByText(id)).toBeInTheDocument();
  await act(async () => recovery.resolve([invitation]));
});

it('rereads after a confirmed creation even when an older invitation read is in flight', async () => {
  const older = Promise.withResolvers<readonly TeamInvitation[]>(), newer = Promise.withResolvers<readonly TeamInvitation[]>();
  const write = Promise.withResolvers<TeamInvitation & { link: string }>();
  const staleItem = { ...invitation, id: '00000000-0000-4000-8000-000000000004' };
  const created = { ...invitation, id: '00000000-0000-4000-8000-000000000005' };
  vi.mocked(listTeamInvitations).mockResolvedValueOnce([invitation]).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  vi.mocked(createTeamInvitation).mockImplementation(async (_team, _user, _signal, _mismatch, dispatch) => { dispatch?.(); return write.promise; });
  let revision = 1;
  const currentPermission = () => revision;
  const node = () => <TeamInvitations teamId={teamId} teamName="Alpha" active onRoute editable actorRole="admin" unavailable={false} admission={scope} onIdentityMismatch={mismatch} onPermissionChange={permission} onGuardChange={guard} permissionRevision={revision} getPermissionRevision={currentPermission} />;
  const view = render(node()); await openInvite();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation link' }));
  await waitFor(() => expect(createTeamInvitation).toHaveBeenCalledOnce());
  revision = 2; view.rerender(node());
  await waitFor(() => expect(listTeamInvitations).toHaveBeenCalledTimes(2));
  const oldSignal = vi.mocked(listTeamInvitations).mock.calls[1]![1];
  await act(async () => write.resolve({ ...created, link }));
  await waitFor(() => expect(listTeamInvitations).toHaveBeenCalledTimes(3));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => older.resolve([staleItem]));
  expect(screen.queryByText(staleItem.id)).toBeNull();
  await act(async () => newer.resolve([invitation, created]));
  expect(await screen.findByText(created.id)).toBeInTheDocument();
  expect(screen.getByDisplayValue(link)).toBeVisible();
  expect(createTeamInvitation).toHaveBeenCalledOnce();
});
