import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, invalidateAuthRequests } from '../src/api/client';
import type { ScopeCatalog } from '../src/api/credential-scope';
import type { ScopedOwnerGrant } from '../src/api/scoped-credential-management';
import { ScopedOwnerGrantsPanel, type ScopedGrantApi } from '../src/features/management/ScopedOwnerGrantsPanel';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const user = { personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id: '00000000-0000-4000-8000-000000000001', name: 'Alice', email: 'alice@example.com', emailVerified: true, avatarUrl: null };
const grant: ScopedOwnerGrant = { id: '00000000-0000-4000-8000-000000000002', lastUsedAt: null, description: null, clientName: 'App', clientId: 'https://client.test', resource: 'https://daynight.cc/mcp', scope: 'daynight:mcp', createdAt: '2026-10-25T10:00:00Z', expiresAt: '2099-10-25T10:00:00Z', revokedAt: null, status: 'active', scopePolicy: { scopeVersion: '1', scopes: ['team:read'] } };
const catalog: ScopeCatalog = { catalogRevision: 'a'.repeat(64), groups: [{ id: 'team', scopeIds: ['team:read', 'team:write'] }], defaultScopes: ['team:read'] };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const fixture = (rows: readonly ScopedOwnerGrant[] = [grant]) => ({
  list: vi.fn<ScopedGrantApi['list']>().mockResolvedValue(rows), catalog: vi.fn<ScopedGrantApi['catalog']>().mockResolvedValue({ pat: catalog, mcp: catalog }),
  revoke: vi.fn<ScopedGrantApi['revoke']>().mockResolvedValue(true), describe: vi.fn<ScopedGrantApi['describe']>(),
  updateScopes: vi.fn<ScopedGrantApi['updateScopes']>().mockImplementation(async (_id, input, _signal, _mismatch, dispatch) => { dispatch?.(); return { ...grant, scopePolicy: { scopeVersion: '2', scopes: input.scopes } }; }),
});
const page = (transport: ScopedGrantApi, who = user) => <ScopedOwnerGrantsPanel user={who} transport={transport} onIdentityMismatch={() => {}} />;
const edit = () => fireEvent.click(screen.getByRole('button', { name: 'Edit permissions: App' }));
const expand = () => fireEvent.click(screen.getByText('Teams'));
const change = () => fireEvent.click(screen.getByRole('checkbox', { name: /Create and rename Teams/ }));
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save permissions' }));
beforeEach(() => sessionStorage.clear());
afterEach(() => invalidateAuthRequests());

describe('scoped application authorization editing', () => {
  it('starts collapsed, shows the difference, prevents an empty save and restores focus on Escape', async () => {
    const transport = fixture(); const view = render(page(transport));
    const button = await screen.findByRole('button', { name: 'Edit permissions: App' }); button.focus(); edit();
    const team = screen.getByText('Teams').closest('details')!; expect(team).not.toHaveAttribute('open');
    expect(within(team).getByText('1 / 2')).toBeInTheDocument(); expand();
    fireEvent.click(screen.getByRole('checkbox', { name: /View Teams/ }));
    expect(screen.getByText('Select at least one permission.')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Save permissions' })).toBeDisabled();
    change(); expect(within(screen.getByRole('region', { name: 'Permission changes' })).getByText('Create and rename Teams')).toBeInTheDocument();
    view.setLocale('zh-CN'); expect(screen.getByText('已选 1')).toBeInTheDocument(); expect(within(screen.getByRole('region', { name: '权限变更' })).getByText('创建和改名 Team')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull(); expect(button).toHaveFocus();
    view.setLocale('en'); edit(); expect(screen.getByText('Teams').closest('details')).not.toHaveAttribute('open');
    expect(transport.updateScopes).not.toHaveBeenCalled();
  });
  it('updates only the selected grant and does not expose edit on fixed or inactive grants', async () => {
    const fixed = { ...grant, id: '00000000-0000-4000-8000-000000000003', clientName: 'Fixed', scopePolicy: null };
    const expired = { ...grant, id: '00000000-0000-4000-8000-000000000004', clientName: 'Old', status: 'expired' as const };
    const transport = fixture([grant, fixed, expired]); render(page(transport)); await screen.findByText('Fixed');
    expect(screen.queryByRole('button', { name: 'Edit permissions: Fixed' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Edit permissions: Old' })).toBeNull();
    edit(); expand(); change(); save(); await screen.findByText('Permissions updated.');
    expect(transport.updateScopes).toHaveBeenCalledOnce(); expect(transport.updateScopes.mock.calls[0]?.[1]).toEqual({ expectedUserId: user.id, expectedScopeVersion: '1', catalogRevision: catalog.catalogRevision, scopes: ['team:read', 'team:write'] });
    expect(screen.getByText('Current permissions: team:read, team:write')).toBeInTheDocument();
  });
  it.each([['conflict', new ApiError('server', 409, 'version_conflict', null, undefined, undefined, undefined, 'not_committed')], ['unknown', new ApiError('network')]])('reads back %s without resending and retains the draft for review', async (_kind, failure) => {
    const transport = fixture(); transport.updateScopes.mockImplementation(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); throw failure; });
    transport.list.mockResolvedValueOnce([grant]).mockResolvedValueOnce([{ ...grant, scopePolicy: { scopeVersion: '2', scopes: ['team:write'] } }]);
    render(page(transport)); await screen.findByText('App'); edit(); expand(); change(); save();
    const read = await screen.findByRole('button', { name: 'Read current permissions' }); expect(transport.updateScopes).toHaveBeenCalledTimes(1); fireEvent.click(read);
    await screen.findByText(/Current permissions are shown and your draft is preserved/); expect(transport.updateScopes).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('checkbox', { name: /View Teams/ })).toBeChecked(); expect(screen.getByRole('checkbox', { name: /Create and rename Teams/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: 'I reviewed the permissions' })); expect(screen.getByRole('button', { name: 'Save permissions' })).toBeEnabled();
  });
  it('does not publish a delayed write to another account', async () => {
    const result = deferred<ScopedOwnerGrant>(); const transport = fixture(); transport.updateScopes.mockImplementation((_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); return result.promise; });
    const next = { ...user, id: '00000000-0000-4000-8000-000000000005', name: 'Bob' };
    const view = render(page(transport)); await screen.findByText('App'); edit(); expand(); change(); save();
    view.rerender(page(transport, next)); await screen.findByText('App');
    await act(async () => result.resolve({ ...grant, scopePolicy: { scopeVersion: '2', scopes: ['team:write'] } }));
    expect(screen.queryByText('Permissions updated.')).toBeNull(); expect(screen.getByText('Current permissions: team:read')).toBeInTheDocument();
  });
  it('keeps recovery across a closed editor and a failed read without resending', async () => {
    const transport = fixture(); transport.updateScopes.mockImplementation(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); throw new ApiError('network'); });
    transport.list.mockResolvedValueOnce([grant]).mockRejectedValueOnce(new ApiError('network')).mockResolvedValueOnce([grant]);
    render(page(transport)); await screen.findByText('App'); edit(); expand(); change(); save();
    await screen.findByRole('button', { name: 'Read current permissions' }); fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read current permissions' })); await screen.findByText('The operation could not be completed. Please try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Read current permissions' }));
    await screen.findByRole('button', { name: 'Edit permissions: App' }); edit();
    await screen.findByText(/Current permissions are shown and your draft is preserved/); expand();
    expect(screen.getByRole('checkbox', { name: /Create and rename Teams/ })).toBeChecked(); expect(transport.updateScopes).toHaveBeenCalledTimes(1);
  });
  it('reads a missing target after a 404 and removes its editor', async () => {
    const transport = fixture(); transport.updateScopes.mockImplementation(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); throw new ApiError('server', 404); });
    transport.list.mockResolvedValueOnce([grant]).mockResolvedValueOnce([]);
    render(page(transport)); await screen.findByText('App'); edit(); expand(); change(); save();
    fireEvent.click(await screen.findByRole('button', { name: 'Read current permissions' }));
    await screen.findByText('This authorization can no longer be edited.'); expect(screen.queryByRole('dialog')).toBeNull(); expect(transport.updateScopes).toHaveBeenCalledTimes(1);
  });
  it('retains dispatched recovery for the same account after unmount', async () => {
    const result = deferred<ScopedOwnerGrant>(); const transport = fixture();
    transport.updateScopes.mockImplementation((_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); return result.promise; });
    const first = render(page(transport)); await screen.findByText('App'); edit(); expand(); change(); save(); first.unmount();
    render(page(transport)); await screen.findByText('App');
    expect(screen.getByText('The save result is unknown. Read the current permissions and review them.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Read current permissions' })); await act(async () => {});
    edit(); await screen.findByText(/Current permissions are shown and your draft is preserved/); expand();
    expect(screen.getByRole('checkbox', { name: /Create and rename Teams/ })).toBeChecked();
    expect(transport.updateScopes).toHaveBeenCalledTimes(1); await act(async () => result.resolve(grant));
    expect(screen.queryByText('Permissions updated.')).toBeNull();
  });
  it.each(['I reviewed the permissions', 'Cancel'])('keeps the read-back draft across remount until %s', async decision => {
    const transport = fixture();
    transport.updateScopes.mockImplementation(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); throw new ApiError('network'); });
    const first = render(page(transport)); await screen.findByText('App'); edit(); expand(); change(); save();
    fireEvent.click(await screen.findByRole('button', { name: 'Read current permissions' }));
    await screen.findByText(/Current permissions are shown and your draft is preserved/); first.unmount();
    const second = render(page(transport)); await screen.findByText('App');
    expect(screen.getByText('The save result is unknown. Read the current permissions and review them.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Read current permissions' })); await act(async () => {}); edit();
    await screen.findByText(/Current permissions are shown and your draft is preserved/); expand();
    expect(screen.getByRole('checkbox', { name: /Create and rename Teams/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: decision })); second.unmount();
    render(page(transport)); await screen.findByText('App');
    expect(screen.queryByText('The save result is unknown. Read the current permissions and review them.')).toBeNull();
    expect(transport.updateScopes).toHaveBeenCalledTimes(1);
  });
  it('does not clear recovery after an older readback', async () => {
    const newer = { ...grant, scopePolicy: { scopeVersion: '3', scopes: ['team:read'] } };
    const stale = { ...grant, scopePolicy: { scopeVersion: '2', scopes: ['team:read'] } };
    const transport = fixture(); transport.updateScopes.mockImplementation(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); throw new ApiError('network'); });
    transport.list.mockResolvedValueOnce([newer]).mockResolvedValueOnce([stale]).mockResolvedValueOnce([newer]);
    render(page(transport)); await screen.findByText('App'); edit(); expand(); change(); save();
    fireEvent.click(await screen.findByRole('button', { name: 'Read current permissions' }));
    await screen.findByText('The operation could not be completed. Please try again.');
    expect(screen.getByRole('button', { name: 'Read current permissions' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Read current permissions' })); await screen.findByText(/Current permissions are shown and your draft is preserved/);
    expect(transport.updateScopes).toHaveBeenCalledTimes(1);
  });
  it('retains a newer confirmed scope policy when a later list is older', async () => {
    const transport = fixture(); render(page(transport)); await screen.findByText('App'); edit(); expand(); change(); save();
    await screen.findByText('Permissions updated.'); fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => {}); expect(screen.getByText('Current permissions: team:read, team:write')).toBeInTheDocument();
  });
  it('preserves unavailable saved permissions until explicitly removed', async () => {
    const transport = fixture([{ ...grant, scopePolicy: { scopeVersion: '1', scopes: ['team:read', 'task:read'] } }]); render(page(transport)); await screen.findByText('App'); edit();
    expect(screen.getByText('Permissions currently unavailable:')).toBeInTheDocument(); expand(); change();
    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeEnabled(); fireEvent.click(screen.getByRole('button', { name: 'Remove unavailable permissions' })); save();
    await screen.findByText('Permissions updated.'); expect(transport.updateScopes.mock.calls[0]?.[1].scopes).toEqual(['team:read', 'team:write']);
  });
});
