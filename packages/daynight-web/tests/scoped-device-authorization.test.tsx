import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { ScopeCatalog } from '../src/api/credential-scope';
import { ScopedDeviceAuthorizationPage, type ScopedDeviceAuthorizationApi } from '../src/features/auth/ScopedDeviceAuthorizationPage';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const user = { personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id: '00000000-0000-4000-8000-000000000001', name: 'Alice', email: 'alice@example.com', emailVerified: true, avatarUrl: null };
const code = 'BCDFG-HJKLM', revision = 'a'.repeat(64), revision2 = 'b'.repeat(64);
const catalog = (rev = revision): ScopeCatalog => ({ catalogRevision: rev, groups: [{ id: 'team', scopeIds: ['team:read', 'team:write'] }], defaultScopes: ['team:read'] });
const inspection = (rev = revision) => ({ userCode: code, status: 'pending' as const, expiresAt: new Date(Date.now() + 600_000).toISOString(), catalogRevision: rev });
const fixture = () => ({ inspect: vi.fn<ScopedDeviceAuthorizationApi['inspect']>().mockResolvedValue(inspection()), decide: vi.fn<ScopedDeviceAuthorizationApi['decide']>().mockResolvedValue(undefined), catalog: vi.fn<ScopedDeviceAuthorizationApi['catalog']>().mockResolvedValue({ pat: catalog(), mcp: catalog() }) });
const mismatch = vi.fn(), switchAccount = vi.fn();
const page = (transport: ScopedDeviceAuthorizationApi) => <ScopedDeviceAuthorizationPage user={user} initialCode={code} transport={transport} onSwitchAccount={switchAccount} onIdentityMismatch={mismatch} />;
const match = async () => fireEvent.click(await screen.findByRole('checkbox', { name: 'This code matches the one in my terminal' }));
beforeEach(() => { sessionStorage.clear(); vi.clearAllMocks(); });

describe('scoped CLI authorization', () => {
  it('requires removing retired Steps selections when the pending catalog changes', async () => {
    const old: ScopeCatalog = { ...catalog(), groups: [...catalog().groups, { id: 'step', scopeIds: ['step:read', 'step:write'] }], defaultScopes: ['team:read', 'step:read', 'step:write'] };
    const transport = fixture();
    transport.inspect.mockResolvedValueOnce(inspection()).mockResolvedValue(inspection(revision2));
    transport.catalog.mockResolvedValueOnce({ pat: old, mcp: catalog() }).mockResolvedValue({ pat: catalog(revision2), mcp: catalog() });
    transport.decide.mockRejectedValueOnce(new ApiError('server', 409, 'version_conflict'));
    render(page(transport)); await match(); fireEvent.click(screen.getByRole('button', { name: 'Authorize CLI' }));
    await screen.findByRole('button', { name: 'Remove step:read' });
    fireEvent.click(screen.getByRole('button', { name: 'I reviewed the permissions' })); await match();
    expect(screen.getByRole('button', { name: 'Authorize CLI' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove step:read' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove step:write' }));
    expect(screen.queryByRole('checkbox', { name: /Steps/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Authorize CLI' }));
    await screen.findByRole('heading', { name: 'CLI authorized' });
    expect(transport.decide.mock.calls[1]?.[3]).toEqual({ catalogRevision: revision2, scopes: ['team:read'] });
  });
  it('approves explicit defaults only after comparing the code', async () => {
    const transport = fixture(); render(page(transport));
    const approve = await screen.findByRole('button', { name: 'Authorize CLI' });
    expect(approve).toBeDisabled(); await match(); expect(approve).toBeEnabled();
    fireEvent.click(approve);
    await screen.findByRole('heading', { name: 'CLI authorized' });
    expect(transport.decide).toHaveBeenCalledExactlyOnceWith(code, 'approve', user.id, { catalogRevision: revision, scopes: ['team:read'] }, expect.any(AbortSignal), mismatch, expect.any(Function), expect.any(Function));
  });
  it('allows denial without a catalog and never sends scope fields', async () => {
    const transport = fixture(); transport.catalog.mockRejectedValue(new ApiError('network')); render(page(transport));
    expect(await screen.findByText('The current permission catalog could not be read. Read it again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Deny request' }));
    await screen.findByRole('heading', { name: 'Request denied' });
    expect(transport.decide).toHaveBeenCalledExactlyOnceWith(code, 'deny', user.id, undefined, expect.any(AbortSignal), mismatch, expect.any(Function), expect.any(Function));
  });
  it('blocks approval when the catalog and inspection differ or labels are missing', async () => {
    const transport = fixture(); transport.catalog.mockResolvedValue({ pat: catalog(revision2), mcp: catalog() }); render(page(transport));
    await screen.findByText('The permission catalog changed. Read it again and review your selection.'); await match();
    expect(screen.getByRole('button', { name: 'Authorize CLI' })).toBeDisabled();
    expect(transport.decide).not.toHaveBeenCalled();
  });
  it('preserves the draft after a confirmed catalog conflict and requires comparison again', async () => {
    const transport = fixture();
    transport.decide.mockRejectedValueOnce(new ApiError('server', 409, 'version_conflict'));
    transport.inspect.mockResolvedValueOnce(inspection()).mockResolvedValueOnce(inspection(revision2));
    transport.catalog.mockResolvedValueOnce({ pat: catalog(), mcp: catalog() }).mockResolvedValueOnce({ pat: catalog(revision2), mcp: catalog() });
    render(page(transport)); await match(); fireEvent.click(screen.getByRole('button', { name: 'Authorize CLI' }));
    await screen.findByText('The request is still waiting. Review it before making another decision.');
    expect(screen.getByRole('checkbox', { name: 'This code matches the one in my terminal' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'I reviewed the permissions' }));
    await match(); fireEvent.click(screen.getByRole('button', { name: 'Authorize CLI' }));
    await screen.findByRole('heading', { name: 'CLI authorized' });
    expect(transport.decide.mock.calls[1]?.[3]).toEqual({ catalogRevision: revision2, scopes: ['team:read'] });
  });
  it('allows an explicit retry after a confirmed rate limit refusal', async () => {
    const transport = fixture(); transport.decide.mockRejectedValueOnce(new ApiError('server', 429, 'rate_limited')); render(page(transport));
    await match(); fireEvent.click(screen.getByRole('button', { name: 'Authorize CLI' }));
    await screen.findByText('Too many attempts. Wait a minute before checking the code again.');
    expect(screen.getByRole('button', { name: 'Authorize CLI' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Authorize CLI' }));
    await screen.findByRole('heading', { name: 'CLI authorized' });
    expect(transport.decide).toHaveBeenCalledTimes(2);
  });
  it('recovers the pending original request after a confirmed expired session and same-account sign-in', async () => {
    const transport = fixture();
    transport.decide.mockImplementationOnce(async (_code, _decision, _user, _selection, _signal, _mismatch, onDispatch, onUnauthorized) => {
      onDispatch?.(); onUnauthorized?.(); throw new ApiError('server', 401, 'unauthenticated');
    });
    const view = render(page(transport)); await match(); fireEvent.click(screen.getByRole('button', { name: 'Authorize CLI' }));
    await screen.findByText('Your decision could not be confirmed'); view.unmount();
    render(page(transport)); await match();
    expect(screen.getByRole('button', { name: 'Authorize CLI' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Authorize CLI' }));
    await screen.findByRole('heading', { name: 'CLI authorized' });
    expect(transport.inspect).toHaveBeenCalledTimes(2); expect(transport.decide).toHaveBeenCalledTimes(2);
  });
  it('does not replay an unknown result after refresh, and reads the original request', async () => {
    const transport = fixture(); transport.decide.mockRejectedValue(new ApiError('network')); const view = render(page(transport));
    await match(); fireEvent.click(screen.getByRole('button', { name: 'Authorize CLI' }));
    await screen.findByText('Your decision could not be confirmed'); view.unmount();
    render(page(transport)); await screen.findByText('Your decision could not be confirmed');
    expect(transport.decide).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Check actual result' }));
    await waitFor(() => expect(transport.inspect).toHaveBeenCalledTimes(3));
    expect(screen.getByText('Your decision could not be confirmed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Authorize CLI' })).toBeNull();
    expect(transport.decide).toHaveBeenCalledTimes(1);
  });
  it('ignores a late response after changing identity', async () => {
    const transport = fixture(); let finish!: (value: ReturnType<typeof inspection>) => void;
    transport.inspect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(page(transport)); await waitFor(() => expect(transport.inspect).toHaveBeenCalledTimes(1));
    const signal = transport.inspect.mock.calls[0]![2]; view.unmount(); expect(signal.aborted).toBe(true); finish(inspection());
    expect(transport.catalog).not.toHaveBeenCalled();
  });
});
