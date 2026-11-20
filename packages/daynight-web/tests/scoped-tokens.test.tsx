import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, invalidateAuthRequests } from '../src/api/client';
import type { ScopedToken } from '../src/api/scoped-credential-management';
import { ScopedTokensPanel, type ScopedTokenManagementApi } from '../src/features/management/ScopedTokensPanel';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const user = { personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id: '00000000-0000-4000-8000-000000000001', name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const token: ScopedToken = { id: '00000000-0000-4000-8000-000000000002', name: 'CLI', description: null, createdAt: '2026-10-25T10:00:00Z', expiresAt: null, lastUsedAt: null, scopePolicy: { scopes: ['task:read'], scopeVersion: '1' } };
const revision = 'a'.repeat(64);
const catalog = { catalogRevision: revision, groups: [{ id: 'task', scopeIds: ['task:read', 'task:write'] }], defaultScopes: ['task:read'] };
const fixture = (items: readonly ScopedToken[] = [token]) => ({
  list: vi.fn<ScopedTokenManagementApi['list']>().mockResolvedValue(items),
  create: vi.fn<ScopedTokenManagementApi['create']>().mockResolvedValue({ ...token, token: 'one-time-secret' }),
  revoke: vi.fn<ScopedTokenManagementApi['revoke']>().mockResolvedValue(undefined),
  update: vi.fn<ScopedTokenManagementApi['update']>().mockResolvedValue(token),
  describe: vi.fn<ScopedTokenManagementApi['describe']>(),
  catalog: vi.fn<ScopedTokenManagementApi['catalog']>().mockResolvedValue({ pat: catalog, mcp: catalog }),
  scopes: vi.fn<ScopedTokenManagementApi['scopes']>().mockImplementation(async (_id, input, _signal, _mismatch, dispatch) => { dispatch?.(); return { ...token, scopePolicy: { scopes: input.scopes, scopeVersion: '2' } }; }),
});
const page = (transport: ScopedTokenManagementApi, person = user) => <ScopedTokensPanel user={person} onIdentityMismatch={vi.fn()} transport={transport} />;
const openScope = async () => { const trigger = await screen.findByRole('button', { name: 'Edit permissions: CLI' }); trigger.focus(); fireEvent.click(trigger); await screen.findByText(/Selected [12]/); };
const openGroup = () => fireEvent.click(screen.getByText('Tasks', { selector: 'summary span' }));
const selectWrite = () => { openGroup(); fireEvent.click(screen.getByRole('checkbox', { name: /Create tasks and edit basic details/ })); };
const saveScope = () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
afterEach(() => { invalidateAuthRequests(); sessionStorage.clear(); });

describe('scoped PAT management', () => {
  it('starts manual creation with CLI defaults and forbids an empty selection', async () => {
    const transport = fixture(); render(page(transport));
    fireEvent.click(await screen.findByRole('button', { name: 'Create token' }));
    await screen.findByText('Selected 1'); openGroup();
    const read = screen.getByRole('checkbox', { name: /View tasks and dependencies/ });
    expect(read).toBeChecked(); fireEvent.click(read);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Create token' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Token name/), { target: { value: 'Build' } });
    fireEvent.submit(document.getElementById('create-token-form')!); expect(transport.create).not.toHaveBeenCalled();
    fireEvent.click(read); fireEvent.submit(document.getElementById('create-token-form')!);
    await screen.findByLabelText('One-time access token');
    expect(transport.create.mock.calls[0]?.[0]).toMatchObject({ name: 'Build', expectedUserId: user.id, catalogRevision: revision, scopes: catalog.defaultScopes });
  });
  it('prevents saving an empty edit and restores the trigger focus after cancellation', async () => {
    const transport = fixture(); render(page(transport)); await openScope(); openGroup();
    fireEvent.click(screen.getByRole('checkbox', { name: /View tasks and dependencies/ }));
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Edit permissions: CLI' })).toHaveFocus();
    expect(transport.scopes).not.toHaveBeenCalled();
  });
  it.each([409, 503])('preserves the draft, reads back and requires confirmation after %s', async status => {
    const transport = fixture();
    const failure = status === 409 ? new ApiError('server', 409, 'version_conflict', null, undefined, undefined, undefined, 'not_committed') : new ApiError('network');
    transport.scopes.mockImplementationOnce(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); throw failure; });
    transport.list.mockResolvedValueOnce([token]).mockResolvedValue([{ ...token, scopePolicy: { scopes: ['task:write'], scopeVersion: '2' } }]);
    render(page(transport)); await openScope(); selectWrite(); saveScope();
    fireEvent.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'Read current state' }));
    await screen.findByText(/Current permissions are shown and your draft is preserved/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'I reviewed the permissions' })).toBeEnabled());
    expect(transport.scopes).toHaveBeenCalledTimes(1); expect(transport.list).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'I reviewed the permissions' }));
    saveScope(); await screen.findByText('Permissions updated.');
    expect(transport.scopes.mock.calls[1]?.[1]).toMatchObject({ expectedScopeVersion: '2', scopes: ['task:read', 'task:write'] });
  });
  it('reads back a token that became unavailable during a scope edit', async () => {
    const transport = fixture();
    transport.scopes.mockImplementationOnce(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); throw new ApiError('server', 404, 'not_found'); });
    transport.list.mockResolvedValueOnce([token]).mockResolvedValue([]);
    render(page(transport)); await openScope(); selectWrite(); saveScope();
    fireEvent.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'Read current state' }));
    await screen.findByText('This credential is no longer available.');
    expect(screen.queryByRole('button', { name: 'Edit permissions: CLI' })).not.toBeInTheDocument();
    expect(transport.scopes).toHaveBeenCalledOnce();
  });
  it('prevents creation from replacing an unresolved scope draft after closing the editor', async () => {
    const transport = fixture();
    transport.scopes.mockImplementationOnce(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); throw new ApiError('network'); });
    render(page(transport)); await openScope(); selectWrite(); saveScope();
    await screen.findByRole('button', { name: 'Read current state' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit permissions' }));
    await screen.findByText('Selected 2'); openGroup();
    expect(screen.getByRole('checkbox', { name: /Create tasks and edit basic details/ })).toBeChecked();
    expect(transport.create).not.toHaveBeenCalled();
  });
  it('retains unresolved recovery when a remounted panel reads a version older than the edit basis', async () => {
    const current = { ...token, scopePolicy: { ...token.scopePolicy, scopeVersion: '2' } };
    const transport = fixture([current]);
    transport.scopes.mockImplementationOnce(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); throw new ApiError('network'); });
    const view = render(page(transport)); await openScope(); selectWrite(); saveScope();
    await screen.findByRole('button', { name: 'Read current state' });
    transport.list.mockResolvedValue([token]);
    const next = { ...user, id: '00000000-0000-4000-8000-000000000003' };
    view.rerender(page(fixture([]), next));
    view.rerender(page(transport)); await screen.findByText('CLI');
    fireEvent.click(screen.getByRole('button', { name: 'Read current state' }));
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('button', { name: 'Read current state' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    expect(screen.queryByText(/Current permissions are shown and your draft is preserved/)).not.toBeInTheDocument();
    transport.list.mockResolvedValue([current]);
    fireEvent.click(screen.getByRole('button', { name: 'Read current state' }));
    await screen.findByText(/Current permissions are shown and your draft is preserved/);
    expect(transport.scopes).toHaveBeenCalledOnce();
  });
  it('retains the draft and review obligation across unmount after readback', async () => {
    const transport = fixture();
    transport.scopes.mockImplementationOnce(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); throw new ApiError('network'); });
    const view = render(page(transport)); await openScope(); selectWrite(); saveScope();
    fireEvent.click(await screen.findByRole('button', { name: 'Read current state' }));
    await screen.findByRole('button', { name: 'I reviewed the permissions' });
    const next = { ...user, id: '00000000-0000-4000-8000-000000000003' };
    view.rerender(page(fixture([]), next));
    view.rerender(page(transport)); await screen.findByText('CLI');
    fireEvent.click(screen.getByRole('button', { name: 'Read current state' }));
    await screen.findByText(/Current permissions are shown and your draft is preserved/);
    fireEvent.click(screen.getByRole('button', { name: 'Edit permissions' }));
    await screen.findByRole('button', { name: 'I reviewed the permissions' });
    openGroup();
    expect(screen.getByRole('checkbox', { name: /Create tasks and edit basic details/ })).toBeChecked();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' })).toBeDisabled();
  });
  it('uses the reviewed version when the target changes before its editor is reopened', async () => {
    const other = { ...token, id: '00000000-0000-4000-8000-000000000003', name: 'Other' };
    const observed = { ...token, scopePolicy: { scopes: ['task:read'], scopeVersion: '2' } };
    const newer = { ...token, scopePolicy: { scopes: ['task:write'], scopeVersion: '3' } };
    const transport = fixture();
    transport.list.mockResolvedValueOnce([token, other]).mockResolvedValueOnce([observed, other]).mockResolvedValue([newer]);
    transport.scopes.mockImplementation(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); throw new ApiError('network'); });
    render(page(transport)); await openScope(); selectWrite(); saveScope();
    await screen.findByRole('button', { name: 'Read current state' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read current state' }));
    await screen.findByText(/Current permissions are shown and your draft is preserved/);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke token Other' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke token' }));
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText('Other')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Edit permissions' }));
    await screen.findByRole('button', { name: 'I reviewed the permissions' });
    fireEvent.click(screen.getByRole('button', { name: 'I reviewed the permissions' }));
    saveScope();
    await waitFor(() => expect(transport.scopes).toHaveBeenCalledTimes(2));
    expect(transport.scopes.mock.calls[1]?.[1].expectedScopeVersion).toBe('2');
  });
  it.each(['removed', 'expired'] as const)('ends pending review when the target becomes %s during a later list refresh', async status => {
    const other = { ...token, id: '00000000-0000-4000-8000-000000000003', name: 'Other' };
    const remaining = { ...token, id: '00000000-0000-4000-8000-000000000004', name: 'Remaining' };
    const unavailable = { ...token, expiresAt: '2000-01-01T00:00:00Z' };
    const transport = fixture();
    transport.list.mockResolvedValueOnce([token, other, remaining]).mockResolvedValueOnce([token, other, remaining]).mockResolvedValue(status === 'removed' ? [remaining] : [unavailable, remaining]);
    transport.scopes.mockImplementationOnce(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); throw new ApiError('network'); });
    render(page(transport)); await openScope(); selectWrite(); saveScope();
    await screen.findByRole('button', { name: 'Read current state' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read current state' }));
    await screen.findByText(/Current permissions are shown and your draft is preserved/);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke token Other' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke token' }));
    await screen.findByText('This credential is no longer available.');
    expect(screen.queryByText(/Current permissions are shown and your draft is preserved/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit permissions: Remaining' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled();
    expect(transport.scopes).toHaveBeenCalledOnce();
  });
  it('preserves newly saved permissions when an expiry receipt contains old fields', async () => {
    const transport = fixture(); render(page(transport)); await openScope(); selectWrite(); saveScope();
    await screen.findByText('Permissions updated.');
    fireEvent.click(screen.getByRole('button', { name: 'Edit expiration for CLI' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Expiration' }), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Expiration date and time'), { target: { value: '2099-11-26T10:30' } });
    transport.update.mockResolvedValue({ ...token, expiresAt: new Date('2099-11-26T10:30').toISOString() });
    fireEvent.submit(document.getElementById('edit-token-expiry-form')!);
    await screen.findByText('Token expiration updated.');
    expect(screen.getByText(/task:read, task:write/)).toBeInTheDocument();
    await openScope(); openGroup();
    expect(screen.getByRole('checkbox', { name: /Create tasks and edit basic details/ })).toBeChecked();
  });
  it('discards late write results from a previous account', async () => {
    const gate = Promise.withResolvers<ScopedToken>();
    const transport = fixture();
    transport.scopes.mockImplementationOnce((_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); return gate.promise; });
    const view = render(page(transport)); await openScope(); selectWrite(); saveScope();
    const next = { ...token, id: '00000000-0000-4000-8000-000000000003', name: 'New account' };
    view.rerender(page(fixture([next]), { ...user, id: next.id }));
    await act(async () => gate.resolve({ ...token, scopePolicy: { scopes: ['task:read', 'task:write'], scopeVersion: '2' } }));
    await screen.findByText('New account');
    expect(screen.queryByText('Permissions updated.')).not.toBeInTheDocument();
    expect(screen.queryByText(/task:read, task:write/)).not.toBeInTheDocument();
  });
  it('retains a dispatched creation across unmount, isolating the next account until the original account reads back', async () => {
    const gate = Promise.withResolvers<ScopedToken & { readonly token: string }>();
    const transport = fixture();
    transport.create.mockImplementationOnce((_input, _signal, _mismatch, dispatch) => { dispatch?.(); return gate.promise; });
    const view = render(page(transport));
    fireEvent.click(await screen.findByRole('button', { name: 'Create token' }));
    await screen.findByText('Selected 1');
    fireEvent.change(screen.getByLabelText(/Token name/), { target: { value: 'Build' } });
    fireEvent.submit(document.getElementById('create-token-form')!);
    expect(transport.create).toHaveBeenCalledOnce();
    const next = { ...token, id: '00000000-0000-4000-8000-000000000003', name: 'New account' };
    view.rerender(page(fixture([next]), { ...user, id: next.id }));
    await screen.findByText('New account');
    expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled();
    await act(async () => gate.resolve({ ...token, token: 'late-secret' }));
    expect(screen.queryByLabelText('One-time access token')).not.toBeInTheDocument();
    view.rerender(page(transport));
    await screen.findByText('CLI');
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Read current state' }));
    await screen.findByText('The current token list is shown. Check whether a token was issued before creating another.');
    expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled();
    expect(transport.create).toHaveBeenCalledOnce();
  });
  it('retains a dispatched scope edit across unmount and requires original-account readback before another edit', async () => {
    const gate = Promise.withResolvers<ScopedToken>();
    const transport = fixture();
    transport.scopes.mockImplementationOnce((_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); return gate.promise; });
    const view = render(page(transport)); await openScope(); selectWrite(); saveScope();
    const next = { ...token, id: '00000000-0000-4000-8000-000000000003', name: 'New account' };
    view.rerender(page(fixture([next]), { ...user, id: next.id }));
    await screen.findByText('New account');
    expect(screen.getByRole('button', { name: 'Edit permissions: New account' })).toBeEnabled();
    await act(async () => gate.reject(new ApiError('network')));
    expect(screen.queryByText('Permissions updated.')).not.toBeInTheDocument();
    transport.list.mockResolvedValue([token]);
    view.rerender(page(transport));
    await screen.findByText('CLI');
    expect(screen.getByRole('button', { name: 'Edit permissions: CLI' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Read current state' }));
    await screen.findByText(/Current permissions are shown and your draft is preserved/);
    fireEvent.click(screen.getByRole('button', { name: 'Edit permissions' }));
    await screen.findByRole('button', { name: 'I reviewed the permissions' });
    openGroup();
    expect(screen.getByRole('checkbox', { name: /Create tasks and edit basic details/ })).toBeChecked();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'I reviewed the permissions' }));
    expect(transport.scopes).toHaveBeenCalledOnce();
  });
});
