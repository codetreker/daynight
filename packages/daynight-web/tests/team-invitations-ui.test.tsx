import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
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
const panel = (active = true, onRoute = true, editable = true) => <TeamInvitations teamId={teamId} teamName="Alpha" active={active} onRoute={onRoute} editable={editable} actorRole={editable ? 'admin' : null} unavailable={false} admission={scope} onIdentityMismatch={mismatch} onPermissionChange={permission} onGuardChange={guard} />;
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
  view.rerender(panel()); expect(await screen.findByDisplayValue(link)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'I have saved it, close' })); expect(screen.queryByDisplayValue(link)).toBeNull();
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
