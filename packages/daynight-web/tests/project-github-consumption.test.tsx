import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { ProjectGitHubStatus } from '../src/api/github-consumption';
import { ProjectGitHubConsumption } from '../src/features/github-integration/ProjectGitHubConsumption';
import { useProjectManagementGuard } from '../src/features/management/ProjectManagementGuard';
import { createLocaleRender } from './helpers/renderWithLocale';

const mocks = vi.hoisted(() => ({
  status: vi.fn(), counts: vi.fn(), apps: vi.fn(), discover: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), save: vi.fn(), sync: vi.fn(), revalidate: vi.fn(),
  accessStatus: 'ready' as 'ready' | 'error',
  role: 'admin' as 'admin' | 'member', teamRole: 'admin' as 'admin' | 'member' | null, owner: '00000000-0000-4000-8000-000000000004', ownerVersion: 7n,
}));
vi.mock('../src/api/github-integration', () => ({ getGitHubPullRequestCounts: mocks.counts }));
vi.mock('../src/api/github-consumption', () => ({ getProjectGitHubStatus: mocks.status, listTeamGitHubApps: mocks.apps, discoverProjectGitHubInstallation: mocks.discover, connectProjectGitHub: mocks.connect, disconnectProjectGitHub: mocks.disconnect, saveProjectGitHubSettings: mocks.save, updateProjectGitHubSync: mocks.sync }));
vi.mock('../src/features/projects/ProjectAccess', () => {
  const scope = { signal: new AbortController().signal, mismatchSignal: new AbortController().signal, isInvalidated: false, hasIdentityMismatch: false, isProjectSuspended: () => false, ready: async () => {}, principalMismatch: () => {}, subscribe: () => () => {} };
  const access = () => ({ effectiveRole: mocks.role, teamRole: mocks.teamRole, ownership: { teamId: mocks.owner, version: mocks.ownerVersion } });
  const session = { scope, waitForFreshAccess: async () => access(), revalidate: mocks.revalidate };
  return { useProjectAccess: () => ({ session, ready: mocks.accessStatus === 'ready', status: mocks.accessStatus, access: access() }) };
});
const id = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000003';
const appId = '00000000-0000-4000-8000-000000000005';
const grantId = '00000000-0000-4000-8000-000000000006';
const base = (): ProjectGitHubStatus => ({ projectId: id, version: '9007199254740993', revision: '4', serviceAvailable: true, syncEnabled: false, connection: 'not_connected', repository: null, installation: null, app: null, grantId: null, canManageConnection: true, pollIntervalMinutes: 5, initializing: false, poll: { running: false, lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, error: null }, webhook: { running: false, lastReceivedAt: null, lastAttemptAt: null, lastSuccessAt: null, error: null } });
const grant = { grantId, app: { id: appId, githubAppId: '23', name: 'Release App', githubSlug: 'release-app', version: '9007199254740994' }, createdAt: '2026-01-01T10:00:00Z' };
const candidate = { repository: { id: '31', fullName: 'owner/private', private: true }, installation: { id: '42', accountLogin: 'different-account' } };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const render = createLocaleRender('en');
const Subject = () => { const guard = useProjectManagementGuard(); return <ProjectGitHubConsumption projectId={id} userId={userId} repoUrl="https://github.com/owner/private" active onRoute guard={guard} />; };
beforeEach(() => {
  vi.clearAllMocks(); mocks.accessStatus = 'ready'; mocks.role = 'admin'; mocks.teamRole = 'admin'; mocks.owner = '00000000-0000-4000-8000-000000000004'; mocks.ownerVersion = 7n;
  mocks.revalidate.mockImplementation(async () => ({ effectiveRole: mocks.role, teamRole: mocks.teamRole, ownership: { teamId: mocks.owner, version: mocks.ownerVersion } }));
  mocks.status.mockResolvedValue(base()); mocks.counts.mockResolvedValue({ projectId: id, revision: '4', total: '0', counts: { active: '0', closed: '0', merged: '0', all: '0' } });
  mocks.apps.mockResolvedValue({ items: [grant], nextCursor: null }); mocks.discover.mockResolvedValue(candidate);
});

describe('Project GitHub consumption', () => {
  it('uses the selected current grant and exact versions for discovery and connection', async () => {
    mocks.connect.mockImplementation(async (_project, _input, _signal, admission) => { admission.onDispatch(); return { ...base(), version: '9007199254740994', revision: '5', connection: 'connected', repository: candidate.repository, installation: candidate.installation, app: grant.app, grantId }; });
    render(<Subject />); fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub App' }));
    const dialog = await screen.findByRole('dialog'); fireEvent.change(await within(dialog).findByLabelText('Authorized App'), { target: { value: grantId } });
    expect(await within(dialog).findByText('different-account')).toBeVisible();
    expect(mocks.discover.mock.calls[0]![1]).toEqual({ appResourceId: appId, appVersion: '9007199254740994', grantId, ownershipVersion: '7' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect GitHub App' }));
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
    expect(mocks.connect.mock.calls[0]![1]).toEqual({ version: '9007199254740993', ownershipVersion: '7', appResourceId: appId, appVersion: '9007199254740994', grantId, installationId: '42' });
  });

  it('separates Team connection permission from Project sync permission', async () => {
    mocks.teamRole = null; mocks.status.mockResolvedValue({ ...base(), canManageConnection: false });
    render(<Subject />); await screen.findByDisplayValue('5');
    expect(screen.queryByRole('button', { name: 'Connect GitHub App' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '8' } });
    expect(screen.getByRole('button', { name: 'Save interval' })).toBeEnabled(); expect(mocks.apps).not.toHaveBeenCalled();
  });

  it('does not present a stale installation after transfer while discovery is pending', async () => {
    const pending = deferred<typeof candidate>(); mocks.discover.mockReturnValue(pending.promise);
    const view = render(<Subject />); fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub App' }));
    const dialog = await screen.findByRole('dialog'); fireEvent.change(await within(dialog).findByLabelText('Authorized App'), { target: { value: grantId } });
    await waitFor(() => expect(mocks.discover).toHaveBeenCalledOnce()); mocks.owner = '00000000-0000-4000-8000-000000000007'; mocks.ownerVersion = 8n; view.rerender(<Subject />);
    await act(async () => pending.resolve(candidate));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('retains a focused interval draft on a background version change', async () => {
    render(<Subject />); const input = await screen.findByLabelText('Poll interval'); fireEvent.change(input, { target: { value: '8' } }); input.focus();
    mocks.status.mockResolvedValue({ ...base(), version: '9007199254740994', revision: '5', pollIntervalMinutes: 9 }); fireEvent.focus(window);
    await screen.findByText('The configuration changed while you were editing. Review the current value before using the latest version.');
    expect(input).toHaveValue(8); expect(input).toHaveFocus(); expect(screen.getByRole('button', { name: 'Save interval' })).toBeDisabled();
  });

  it('keeps the interval editor during a temporary access check failure', async () => {
    const view = render(<Subject />);
    const interval = await screen.findByRole('spinbutton', { name: 'Poll interval' });
    interval.focus();
    fireEvent.change(interval, { target: { value: '8' } });

    mocks.accessStatus = 'error';
    view.rerender(<Subject />);
    expect(screen.getByRole('spinbutton', { name: 'Poll interval' })).toBe(interval);
    expect(interval).toHaveFocus();
    expect(interval).toHaveValue(8);
    expect(screen.getByRole('button', { name: 'Save interval' })).toBeDisabled();
    expect(screen.getByRole('switch')).toBeDisabled();

    mocks.accessStatus = 'ready';
    view.rerender(<Subject />);
    expect(interval).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Save interval' })).toBeEnabled();

    mocks.role = 'member';
    view.rerender(<Subject />);
    expect(screen.queryByRole('spinbutton', { name: 'Poll interval' })).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('reports an unknown write and does not replay it after observing current state', async () => {
    mocks.save.mockImplementation(async (_project, _input, _signal, admission) => { admission.onDispatch(); throw new ApiError('network'); });
    render(<Subject />); const input = await screen.findByLabelText('Poll interval'); fireEvent.change(input, { target: { value: '8' } }); fireEvent.click(screen.getByRole('button', { name: 'Save interval' }));
    await screen.findByText('The write outcome is unknown. Check the reread status before deciding whether to retry.');
    await waitFor(() => expect(mocks.status.mock.calls.length).toBeGreaterThan(1)); expect(mocks.save).toHaveBeenCalledOnce(); expect(input).toHaveValue(8);
  });
  it('keeps historical PR counts visible without a connection', async () => {
    mocks.counts.mockResolvedValue({ projectId: id, revision: '4', total: '12', counts: { active: '3', closed: '4', merged: '5', all: '12' } });
    render(<Subject />); expect(await screen.findByText('Retained records')).toBeVisible(); expect(screen.getByText('9')).toBeVisible();
  });

  it('clears the connection dialog when Team administration is withdrawn', async () => {
    const pending = deferred<typeof candidate>(); mocks.discover.mockReturnValue(pending.promise);
    const view = render(<Subject />); fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub App' }));
    const dialog = await screen.findByRole('dialog'); fireEvent.change(await within(dialog).findByLabelText('Authorized App'), { target: { value: grantId } });
    await waitFor(() => expect(mocks.discover).toHaveBeenCalledOnce()); mocks.teamRole = null; view.rerender(<Subject />);
    await act(async () => pending.resolve(candidate)); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Connect GitHub App' })).toBeNull(); expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('disconnects using the observed owner version and retains saved data', async () => {
    mocks.status.mockResolvedValue({ ...base(), connection: 'unavailable', app: grant.app, grantId, installation: candidate.installation, repository: candidate.repository });
    mocks.disconnect.mockImplementation(async (_project, _input, _signal, admission) => { admission.onDispatch(); return { ...base(), version: '9007199254740994', revision: '5', connection: 'disconnected' }; });
    render(<Subject />); fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = screen.getByRole('dialog'); expect(within(dialog).getByText(/Saved data is retained/)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' })); await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledOnce());
    expect(mocks.disconnect.mock.calls[0]![1]).toEqual({ version: '9007199254740993', ownershipVersion: '7' });
  });

  it('shows an empty authorized list and the current Team ID without making a discovery request', async () => {
    mocks.apps.mockResolvedValue({ items: [], nextCursor: null }); render(<Subject />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub App' })); const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(mocks.owner)).toBeVisible(); expect(mocks.discover).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Connect GitHub App' })).toBeDisabled();
  });

  it('keeps an unknown connection outcome distinct from a later read without replaying it', async () => {
    mocks.connect.mockImplementation(async (_project, _input, _signal, admission) => { admission.onDispatch(); throw new ApiError('network'); });
    render(<Subject />); fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub App' })); const dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Authorized App'), { target: { value: grantId } }); await within(dialog).findByText('different-account');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect GitHub App' }));
    expect((await screen.findAllByText('The write outcome is unknown. Check the reread status before deciding whether to retry.')).length).toBeGreaterThan(0);
    await waitFor(() => expect(mocks.status.mock.calls.length).toBeGreaterThan(1)); expect(mocks.connect).toHaveBeenCalledOnce();
  });

  it('clears a candidate when its Project configuration version changes', async () => {
    render(<Subject />); fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub App' })); const dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Authorized App'), { target: { value: grantId } }); await within(dialog).findByText('different-account');
    mocks.status.mockResolvedValue({ ...base(), version: '9007199254740994', revision: '5' }); fireEvent.focus(window);
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Connect GitHub App' })).toBeDisabled());
    expect(within(dialog).queryByText('different-account')).toBeNull(); expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([['discovery', 'github_grant_changed'], ['connect', 'github_grant_changed'], ['discovery', 'version_conflict'], ['connect', 'version_conflict']] as const)('refreshes authorization and requires a new selection after %s %s', async (phase, code) => {
    const replacement = { ...grant, grantId: '00000000-0000-4000-8000-000000000008', app: { ...grant.app, version: '9007199254740995' } };
    mocks.apps.mockResolvedValueOnce({ items: [grant], nextCursor: null }).mockResolvedValue({ items: [replacement], nextCursor: null });
    const conflict = new ApiError('server', 409, code);
    if (phase === 'discovery') mocks.discover.mockRejectedValueOnce(conflict);
    else mocks.connect.mockImplementation(async (_project, _input, _signal, admission) => { admission.onDispatch(); admission.onWriteRejected(conflict); throw conflict; });
    render(<Subject />); fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub App' })); const dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Authorized App'), { target: { value: grantId } });
    if (phase === 'connect') { await within(dialog).findByText('different-account'); fireEvent.click(within(dialog).getByRole('button', { name: 'Connect GitHub App' })); }
    await waitFor(() => expect(mocks.apps).toHaveBeenCalledTimes(2));
    const select = await within(dialog).findByLabelText('Authorized App'); await waitFor(() => expect(select).toHaveValue(''));
    expect(within(dialog).getByRole('button', { name: 'Connect GitHub App' })).toBeDisabled(); expect(within(dialog).queryByText('different-account')).toBeNull();
    fireEvent.change(select, { target: { value: replacement.grantId } }); await within(dialog).findByText('different-account');
    expect(mocks.discover.mock.calls.at(-1)![1]).toMatchObject({ grantId: replacement.grantId, appVersion: replacement.app.version });
    expect(mocks.connect).toHaveBeenCalledTimes(phase === 'connect' ? 1 : 0);
  });

  it.each([403, 404])('closes the dialog and revalidates access when Team authorization read returns %s', async status => {
    mocks.apps.mockRejectedValue(new ApiError('server', status, 'not_found')); render(<Subject />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub App' }));
    await waitFor(() => expect(mocks.revalidate).toHaveBeenCalled()); expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.discover).not.toHaveBeenCalled();
  });

  it('distinguishes no installation from a failed remote scan without exposing raw errors', async () => {
    mocks.discover.mockRejectedValueOnce(new ApiError('server', 409, 'github_installation_missing')).mockRejectedValueOnce(new ApiError('server', 502, 'github_unavailable'));
    render(<Subject />); fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub App' })); const dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Authorized App'), { target: { value: grantId } });
    expect(await within(dialog).findByText('No installation of this App can access this repository.')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByText('Unable to complete the installation scan. Try again later.')).toBeVisible(); expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(['discovery', 'connect'] as const)('rechecks ownership after a %s conflict and reads the destination Team grants', async phase => {
    const destination = '00000000-0000-4000-8000-000000000007';
    const replacement = { ...grant, grantId: '00000000-0000-4000-8000-000000000008' };
    const conflict = new ApiError('server', 409, 'version_conflict');
    mocks.apps.mockResolvedValueOnce({ items: [grant], nextCursor: null }).mockResolvedValue({ items: [replacement], nextCursor: null });
    mocks.revalidate.mockImplementation(async () => { mocks.owner = destination; mocks.ownerVersion = 8n; return { effectiveRole: 'admin', teamRole: 'admin', ownership: { teamId: destination, version: 8n } }; });
    if (phase === 'discovery') mocks.discover.mockRejectedValueOnce(conflict);
    else mocks.connect.mockImplementation(async (_project, _input, _signal, admission) => { admission.onDispatch(); admission.onWriteRejected(conflict); throw conflict; });
    render(<Subject />); fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub App' })); const dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Authorized App'), { target: { value: grantId } });
    if (phase === 'connect') { await within(dialog).findByText('different-account'); fireEvent.click(within(dialog).getByRole('button', { name: 'Connect GitHub App' })); }
    await waitFor(() => expect(mocks.apps).toHaveBeenCalledTimes(2)); expect(mocks.revalidate).toHaveBeenCalled();
    expect(mocks.apps.mock.calls[1]![0]).toBe(destination);
    const select = await within(dialog).findByLabelText('Authorized App'); expect(select).toHaveValue('');
    fireEvent.change(select, { target: { value: replacement.grantId } }); await within(dialog).findByText('different-account');
    expect(mocks.discover.mock.calls.at(-1)![1]).toMatchObject({ grantId: replacement.grantId, ownershipVersion: '8' });
  });

  it('closes the connection dialog when revalidation after a conflict removes Team administration', async () => {
    mocks.discover.mockRejectedValueOnce(new ApiError('server', 409, 'version_conflict'));
    mocks.revalidate.mockImplementation(async () => { mocks.teamRole = null; return { effectiveRole: 'admin', teamRole: null, ownership: { teamId: mocks.owner, version: 7n } }; });
    render(<Subject />); fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub App' })); const dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Authorized App'), { target: { value: grantId } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(mocks.apps).toHaveBeenCalledOnce(); expect(mocks.connect).not.toHaveBeenCalled();
  });

});
