import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { GitHubSettings } from '../src/features/github-integration/GitHubSettings';
import { useProjectManagementGuard } from '../src/features/management/ProjectManagementGuard';
import { createLocaleRender } from './helpers/renderWithLocale';
import type { GitHubStatus } from '../src/api/github-integration';

const mocks = vi.hoisted(() => ({
  status: vi.fn(), counts: vi.fn(), discover: vi.fn(), save: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), sync: vi.fn(),
  role: 'admin' as 'admin' | 'member', available: true, mismatch: false, invalidated: false, listener: null as null | ((event: { projectId: string; accessRevoked?: boolean }) => void),
}));
vi.mock('../src/api/github-integration', () => ({ getGitHubStatus: mocks.status, getGitHubPullRequestCounts: mocks.counts, discoverGitHubInstallation: mocks.discover, saveGitHubSettings: mocks.save, connectGitHub: mocks.connect, disconnectGitHub: mocks.disconnect, updateGitHubSync: mocks.sync }));
vi.mock('../src/features/projects/ProjectAccess', () => {
  const scope = {
    signal: new AbortController().signal, mismatchSignal: new AbortController().signal,
    get isInvalidated() { return mocks.invalidated; }, get hasIdentityMismatch() { return mocks.mismatch; },
    isProjectSuspended: () => false, ready: async () => {}, principalMismatch: () => { mocks.mismatch = true; },
    subscribe: (listener: typeof mocks.listener) => { mocks.listener = listener; return () => { mocks.listener = null; }; },
  };
  const session = { scope, waitForFreshAccess: async () => mocks.available ? ({ effectiveRole: mocks.role }) : null, revalidate: async () => null };
  return { useProjectAccess: () => ({ session, ready: true, status: 'ready', access: { effectiveRole: mocks.role } }) };
});
const id = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000003';
const base = (): GitHubStatus => ({ projectId: id, version: '9007199254740993', revision: '4', serviceAvailable: true, syncEnabled: true, connection: 'connected', repository: { id: '31', fullName: 'owner/private', private: true }, installation: { id: '42', accountLogin: 'different-account' }, pollIntervalMinutes: 5, initializing: false, poll: { running: false, lastAttemptAt: null, lastSuccessAt: '2026-01-01T10:00:00Z', nextAttemptAt: null, error: null }, webhook: { running: false, lastReceivedAt: null, lastAttemptAt: null, lastSuccessAt: null, error: null } });
const count = (revision = '4', active = '0') => ({ projectId: id, revision, total: active, counts: { active, closed: '0', merged: '0', all: active } });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const render = createLocaleRender('en');
const Subject = ({ active = true, onRoute = true, retain, peers = false, generation, observe }: { active?: boolean; onRoute?: boolean; retain?: (value: boolean) => void; peers?: boolean; generation?: number; observe?: (state: { dirty: boolean; pending: boolean; needsAttention: boolean }) => void }) => {
  const guard = useProjectManagementGuard();
  return <><GitHubSettings projectId={id} userId={userId} repoUrl="https://github.com/owner/private" active={active} onRoute={onRoute} onRetentionChange={retain} onStateChange={observe} presentationGeneration={generation} guard={guard} />{peers && (['settings', 'transfer', 'delete'] as const).map(owner => <button key={owner} type="button" disabled={guard.isBlocked(owner)} onClick={() => guard.tryAcquire(owner)}>{owner}</button>)}</>;
};
const ready = async () => { await screen.findByDisplayValue('5'); };
beforeEach(() => {
  vi.clearAllMocks(); mocks.role = 'admin'; mocks.available = true; mocks.mismatch = false; mocks.invalidated = false;
  mocks.status.mockResolvedValue(base()); mocks.counts.mockResolvedValue(count());
});

describe('GitHub settings', () => {
  it('distinguishes channels, initialization, full empty and retained data', async () => {
    const failed = { ...base(), poll: { ...base().poll, error: { code: 'timeout', message: 'Timed out', at: null } }, webhook: { ...base().webhook, error: { code: 'failed', message: 'Event failed', at: null } } };
    mocks.status.mockResolvedValue(failed); render(<Subject />); await ready();
    expect(screen.getAllByText('Polling temporarily failed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Webhook update temporarily failed').length).toBeGreaterThan(0);
    expect(screen.getByText('The last complete sync found no open PRs.')).toBeVisible();
    const initial = { ...base(), initializing: true, poll: { ...base().poll, lastSuccessAt: null } };
    mocks.status.mockResolvedValue(initial); fireEvent.focus(window);
    await screen.findByText('The active PR collection is unknown until a full sync completes.');
    expect(screen.queryByText('Active PRs')).toBeNull();
    const disconnected = { ...base(), connection: 'disconnected' as const };
    mocks.status.mockResolvedValue(disconnected); fireEvent.focus(window);
    expect(await screen.findByText('Previously saved data is retained.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  });

  it.each(['', '0', '-1', '1.5', '2147483648'])('rejects invalid interval %j', async value => {
    render(<Subject />); await ready(); fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value } });
    expect(screen.getByText('Enter a whole number from 1 to 2147483647 minutes.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save interval' })).toBeDisabled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it('preserves a draft on background version change and requires an explicit rebase', async () => {
    render(<Subject />); await ready(); const input = screen.getByLabelText('Poll interval');
    fireEvent.change(input, { target: { value: '7' } }); input.focus();
    mocks.status.mockResolvedValue({ ...base(), version: '9007199254740994', revision: '5', pollIntervalMinutes: 9 }); mocks.counts.mockResolvedValue(count('5'));
    fireEvent.focus(window);
    await screen.findByText('The configuration changed while you were editing. Review the current value before using the latest version.');
    expect(input).toHaveValue(7); expect(input).toHaveFocus(); expect(screen.getByRole('button', { name: 'Save interval' })).toBeDisabled();
    mocks.save.mockImplementation(async (_project, input, _signal, admission) => { admission.onDispatch(); return { ...base(), version: '9007199254740995', revision: '6', pollIntervalMinutes: input.pollIntervalMinutes }; });
    fireEvent.click(screen.getByRole('button', { name: 'Use latest version and keep draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save interval' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.save.mock.calls[0]![1]).toEqual({ version: '9007199254740994', pollIntervalMinutes: 7 });
  });

  it('blocks connection management during a save and restores it afterward', async () => {
    const write = deferred<GitHubStatus>(); mocks.save.mockImplementation((_project, _input, _signal, admission) => { admission.onDispatch(); return write.promise; });
    render(<Subject />); await ready(); fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '7' } }); fireEvent.click(screen.getByRole('button', { name: 'Save interval' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce()); expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    await act(async () => write.resolve({ ...base(), version: '9007199254740994', revision: '5', pollIntervalMinutes: 7 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).not.toBeDisabled());
  });

  it('holds management exclusion while reconciliation is delayed or fails, and releases only after an admitted read', async () => {
    const read = deferred<GitHubStatus>();
    mocks.status.mockResolvedValueOnce(base()).mockImplementation(() => read.promise);
    mocks.save.mockImplementation(async (_project, _input, _signal, admission) => { admission.onDispatch(); throw new ApiError('network'); });
    render(<Subject peers />); await ready();
    fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '8' } }); fireEvent.click(screen.getByRole('button', { name: 'Save interval' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    for (const owner of ['settings', 'transfer', 'delete']) expect(screen.getByRole('button', { name: owner })).toBeDisabled();
    await act(async () => read.reject(new ApiError('network')));
    const error = await screen.findByText('Unable to read GitHub sync status.');
    for (const owner of ['settings', 'transfer', 'delete']) expect(screen.getByRole('button', { name: owner })).toBeDisabled();
    mocks.status.mockResolvedValue(base());
    fireEvent.click(within(error.closest('[role=alert]')!).getByRole('button', { name: 'Retry' }));
    for (const owner of ['settings', 'transfer', 'delete']) await waitFor(() => expect(screen.getByRole('button', { name: owner })).not.toBeDisabled());
    expect(mocks.save).toHaveBeenCalledOnce(); expect(screen.getByLabelText('Poll interval')).toHaveValue(8);
  });

  it('releases management exclusion when the authenticated scope ends', async () => {
    const read = deferred<GitHubStatus>(); mocks.status.mockResolvedValueOnce(base()).mockImplementation(() => read.promise);
    mocks.save.mockImplementation(async (_project, _input, _signal, admission) => { admission.onDispatch(); throw new ApiError('network'); });
    const view = render(<Subject peers />); await ready();
    fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '8' } }); fireEvent.click(screen.getByRole('button', { name: 'Save interval' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce()); expect(screen.getByRole('button', { name: 'settings' })).toBeDisabled();
    mocks.invalidated = true; view.rerender(<Subject peers />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings' })).not.toBeDisabled());
  });

  it.each(['connected', 'unavailable'] as const)('permits disconnect while %s and the service App is unavailable', async connection => {
    mocks.status.mockResolvedValue({ ...base(), connection, serviceAvailable: false });
    mocks.disconnect.mockImplementation(async (_project, _input, _signal, admission) => { admission.onDispatch(); return { ...base(), connection: 'disconnected', serviceAvailable: false, version: '9007199254740994', revision: '5' }; });
    render(<Subject />); await ready();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = screen.getByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledOnce());
    expect(mocks.disconnect.mock.calls[0]![1]).toEqual({ version: '9007199254740993' }); expect(mocks.discover).not.toHaveBeenCalled();
  });

  it('offers both reconnect and disconnect for an unavailable binding when the App is configured', async () => {
    mocks.status.mockResolvedValue({ ...base(), connection: 'unavailable' }); render(<Subject />); await ready();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled(); expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
  });

  it.each(['not_connected', 'disconnected'] as const)('does not offer discovery while %s and the service App is unavailable', async connection => {
    mocks.status.mockResolvedValue({ ...base(), connection, serviceAvailable: false, ...(connection === 'not_connected' ? { installation: null, repository: null } : {}) });
    render(<Subject />); await ready(); expect(screen.queryByRole('button', { name: 'Connect GitHub App' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });

  it('rereads an unknown write without replay and retains its draft', async () => {
    mocks.save.mockImplementation(async (_project, _input, _signal, admission) => { admission.onDispatch(); throw new ApiError('network'); });
    render(<Subject />); await ready(); fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '8' } }); fireEvent.click(screen.getByRole('button', { name: 'Save interval' }));
    await screen.findByText('The write outcome is unknown. Check the reread status before deciding whether to retry.');
    await waitFor(() => expect(mocks.status.mock.calls.length).toBeGreaterThan(1)); expect(mocks.save).toHaveBeenCalledOnce(); expect(screen.getByLabelText('Poll interval')).toHaveValue(8);
  });

  it('treats a 5xx response as an unknown outcome and preserves the draft', async () => {
    mocks.save.mockImplementation(async (_project, _input, _signal, admission) => { admission.onDispatch(); const error = new ApiError('server', 503, 'internal_error'); admission.onWriteRejected(error); throw error; });
    render(<Subject />); await ready(); fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '8' } }); fireEvent.click(screen.getByRole('button', { name: 'Save interval' }));
    await screen.findByText('The write outcome is unknown. Check the reread status before deciding whether to retry.');
    expect(screen.getByLabelText('Poll interval')).toHaveValue(8); expect(mocks.save).toHaveBeenCalledOnce();
  });

  it('accepts a candidate owned by another account and lets members read without controls', async () => {
    mocks.status.mockResolvedValue({ ...base(), connection: 'not_connected', repository: null, installation: null });
    mocks.discover.mockResolvedValue({ repository: { id: '31', fullName: 'owner/private', private: true }, installation: { id: '42', accountLogin: 'different-account' } });
    mocks.connect.mockImplementation(async (_project, input, _signal, admission) => { admission.onDispatch(); return { ...base(), installation: { id: input.installationId, accountLogin: 'different-account' } }; });
    const view = render(<Subject />); await ready(); fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub App' }));
    const dialog = await screen.findByRole('dialog'); await within(dialog).findByText('different-account'); expect(within(dialog).getByText(/shared under this Project/)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect GitHub App' })); await waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
    expect(mocks.connect.mock.calls[0]![1]).toEqual({ version: '9007199254740993', installationId: '42' });
    mocks.role = 'member'; view.rerender(<Subject />); await waitFor(() => expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()); expect(screen.queryByRole('button', { name: 'Save interval' })).toBeNull();
  });

  it('retains a dispatched write across route departure and reconciles on return', async () => {
    const write = deferred<GitHubStatus>(); const retain = vi.fn();
    mocks.save.mockImplementation((_project, _input, _signal, admission) => { admission.onDispatch(); return write.promise; });
    const view = render(<Subject retain={retain} />); await ready(); fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '8' } }); fireEvent.click(screen.getByRole('button', { name: 'Save interval' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce()); expect(retain).toHaveBeenLastCalledWith(true);
    view.rerender(<Subject active={false} onRoute={false} retain={retain} />);
    expect((mocks.save.mock.calls[0]![2] as AbortSignal).aborted).toBe(false);
    await act(async () => write.reject(new ApiError('network')));
    expect(retain).toHaveBeenLastCalledWith(true); expect(mocks.save).toHaveBeenCalledOnce();
    view.rerender(<Subject active onRoute retain={retain} />);
    await screen.findByText('The write outcome is unknown. Check the reread status before deciding whether to retry.');
    expect(screen.getByLabelText('Poll interval')).toHaveValue(8);
    await waitFor(() => expect(retain).toHaveBeenLastCalledWith(false));
  });

  it('retains a confirmed save while off route and requires a current read on return', async () => {
    const write = deferred<GitHubStatus>(); const retain = vi.fn();
    mocks.save.mockImplementation((_project, _input, _signal, admission) => { admission.onDispatch(); return write.promise.then(value => { admission.onWriteConfirmed(); return value; }); });
    const view = render(<Subject retain={retain} />); await ready(); fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '8' } }); fireEvent.click(screen.getByRole('button', { name: 'Save interval' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce()); view.rerender(<Subject active={false} onRoute={false} retain={retain} />);
    await act(async () => write.resolve({ ...base(), version: '9007199254740994', revision: '5', pollIntervalMinutes: 8 }));
    expect(retain).toHaveBeenLastCalledWith(true); view.rerender(<Subject active onRoute retain={retain} />);
    await screen.findByText('Unable to read GitHub sync status.'); expect(retain).toHaveBeenLastCalledWith(true);
    mocks.status.mockResolvedValue({ ...base(), version: '9007199254740994', revision: '5', pollIntervalMinutes: 8 }); mocks.counts.mockResolvedValue(count('5'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await waitFor(() => expect(retain).toHaveBeenLastCalledWith(false));
    expect(screen.getByLabelText('Poll interval')).toHaveValue(8);
  });

  it('retains unresolved outcome across repeated project revocation until reread', async () => {
    const write = deferred<GitHubStatus>(); const retain = vi.fn();
    mocks.save.mockImplementation((_project, _input, _signal, admission) => { admission.onDispatch(); return write.promise; });
    render(<Subject retain={retain} />); await ready(); fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '8' } }); fireEvent.click(screen.getByRole('button', { name: 'Save interval' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    mocks.available = false; act(() => mocks.listener?.({ projectId: id, accessRevoked: true }));
    await act(async () => write.reject(new ApiError('network')));
    act(() => mocks.listener?.({ projectId: id, accessRevoked: true }));
    expect(retain).toHaveBeenLastCalledWith(true); expect(screen.queryByDisplayValue('8')).toBeNull(); expect(mocks.save).toHaveBeenCalledOnce();
    mocks.available = true; fireEvent.focus(window); await waitFor(() => expect(retain).toHaveBeenLastCalledWith(false));
    expect(await screen.findByText('The write outcome is unknown. Check the reread status before deciding whether to retry.')).toBeVisible();
  });

  it('keeps a draft while identity admission is paused, and clears private values on project revocation', async () => {
    const view = render(<Subject />); await ready(); fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '8' } });
    mocks.mismatch = true; view.rerender(<Subject />); expect(screen.getByLabelText('Poll interval')).toHaveValue(8); expect(screen.getByRole('button', { name: 'Save interval' })).toBeDisabled();
    mocks.mismatch = false; act(() => mocks.listener?.({ projectId: id, accessRevoked: true })); expect(screen.queryByText('owner/private')).toBeNull(); expect(screen.queryByDisplayValue('8')).toBeNull();
  });
});


it('reports draft, invalid and pending states independently', async () => {
  const observe = vi.fn(), write = deferred<GitHubStatus>();
  mocks.save.mockImplementation((_project, _input, _signal, admission) => { admission.onDispatch(); return write.promise; });
  render(<Subject observe={observe} />); await ready();
  expect(observe).toHaveBeenLastCalledWith({ dirty: false, pending: false, needsAttention: false });
  fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '' } });
  expect(observe).toHaveBeenLastCalledWith({ dirty: true, pending: false, needsAttention: true });
  fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save interval' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  expect(observe).toHaveBeenLastCalledWith({ dirty: true, pending: true, needsAttention: false });
  await act(async () => write.resolve({ ...base(), version: '9007199254740994', revision: '5', pollIntervalMinutes: 7 }));
});

it('keeps the original disconnect dialog when its result arrives after leaving and returning', async () => {
  const write = deferred<GitHubStatus>();
  mocks.disconnect.mockImplementation((_project, _input, _signal, admission) => { admission.onDispatch(); return write.promise; });
  const view = render(<Subject generation={0} />); await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
  await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledOnce());
  view.rerender(<Subject active={false} generation={1} />);
  view.rerender(<Subject generation={1} />);
  await act(async () => write.resolve({ ...base(), connection: 'disconnected', version: '9007199254740994', revision: '5' }));
  expect(screen.getByRole('dialog', { name: 'Disconnect GitHub?' })).toBeVisible();
  expect(mocks.disconnect).toHaveBeenCalledOnce();
});

it('keeps later input while a confirmed save is reconciled after a section change', async () => {
  const write = deferred<GitHubStatus>(), read = deferred<GitHubStatus>();
  mocks.status.mockResolvedValueOnce(base()).mockImplementation(() => read.promise);
  mocks.save.mockImplementation((_project, _input, _signal, admission) => {
    admission.onDispatch(); return write.promise.then(value => { admission.onWriteConfirmed(); return value; });
  });
  const view = render(<Subject generation={0} />); await ready();
  const input = screen.getByLabelText('Poll interval');
  fireEvent.change(input, { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save interval' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  view.rerender(<Subject active={false} generation={1} />);
  view.rerender(<Subject generation={1} />);
  fireEvent.change(input, { target: { value: '9' } });
  await act(async () => write.resolve({ ...base(), version: '9007199254740994', revision: '5', pollIntervalMinutes: 7 }));
  expect(input).toHaveValue(9);
  mocks.counts.mockResolvedValue(count('5'));
  await act(async () => read.resolve({ ...base(), version: '9007199254740994', revision: '5', pollIntervalMinutes: 7 }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save interval' })).toBeEnabled());
  expect(input).toHaveValue(9);
  expect(screen.queryByText('The configuration changed while you were editing. Review the current value before using the latest version.')).toBeNull();
  expect(mocks.save).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Save interval' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
  expect(mocks.save.mock.calls[1]![1]).toEqual({ version: '9007199254740994', pollIntervalMinutes: 9 });
});

it.each(['connect', 'disconnect'] as const)('does not repeat a confirmed %s from a retained dialog after reconciliation', async kind => {
  const write = deferred<GitHubStatus>(), read = deferred<GitHubStatus>(), observe = vi.fn(), retain = vi.fn();
  const initial: GitHubStatus = kind === 'connect' ? { ...base(), connection: 'not_connected', repository: null, installation: null } : base();
  const updated: GitHubStatus = { ...base(), connection: kind === 'connect' ? 'connected' : 'disconnected', version: '9007199254740994', revision: '5' };
  mocks.status.mockResolvedValueOnce(initial).mockImplementation(() => read.promise);
  mocks.discover.mockResolvedValue({ repository: { id: '31', fullName: 'owner/private', private: true }, installation: { id: '42', accountLogin: 'different-account' } });
  const mutation = kind === 'connect' ? mocks.connect : mocks.disconnect;
  mutation.mockImplementation((_project, _input, _signal, admission) => { admission.onDispatch(); return write.promise.then(value => { admission.onWriteConfirmed(); return value; }); });
  const view = render(<Subject generation={0} observe={observe} retain={retain} />); await ready();
  fireEvent.click(screen.getByRole('button', { name: kind === 'connect' ? 'Connect GitHub App' : 'Disconnect' }));
  let dialog = screen.getByRole('dialog');
  if (kind === 'connect') await within(dialog).findByText('different-account');
  fireEvent.click(within(dialog).getByRole('button', { name: kind === 'connect' ? 'Connect GitHub App' : 'Disconnect' }));
  await waitFor(() => expect(mutation).toHaveBeenCalledOnce());
  view.rerender(<Subject active={false} generation={1} observe={observe} retain={retain} />);
  await act(async () => write.resolve(updated));
  expect(observe).toHaveBeenLastCalledWith({ dirty: false, pending: true, needsAttention: false });
  view.rerender(<Subject generation={1} observe={observe} retain={retain} />);
  mocks.counts.mockResolvedValue(count('5'));
  await act(async () => read.resolve(updated));
  dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('Connection settings updated.');
  await waitFor(() => expect(observe).toHaveBeenLastCalledWith({ dirty: false, pending: false, needsAttention: false }));
  const confirm = within(dialog).getByRole('button', { name: kind === 'connect' ? 'Connect GitHub App' : 'Disconnect' });
  expect(confirm).toBeDisabled(); fireEvent.click(confirm); expect(mutation).toHaveBeenCalledOnce();
  expect(retain).toHaveBeenLastCalledWith(true);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(retain).toHaveBeenLastCalledWith(false));
  expect(screen.queryByText('Poll interval saved.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: kind === 'connect' ? 'Disconnect' : 'Reconnect' }));
  const next = screen.getByRole('dialog');
  if (kind === 'disconnect') await within(next).findByText('different-account');
  expect(within(next).getByRole('button', { name: kind === 'connect' ? 'Disconnect' : 'Connect GitHub App' })).toBeEnabled();
});


describe('Project PR sync switch', () => {
  it('submits only the confirmed version and switch value while retaining the interval draft', async () => {
    const write = deferred<GitHubStatus>();
    mocks.status.mockResolvedValue({ ...base(), syncEnabled: false });
    mocks.sync.mockImplementation((_project, _input, _signal, admission) => { admission.onDispatch(); return write.promise; });
    render(<Subject peers />); await ready();
    fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '8' } });
    const toggle = screen.getByRole('switch', { name: 'PR sync' });
    expect(toggle).not.toBeChecked(); fireEvent.click(toggle);
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledOnce());
    expect(mocks.sync.mock.calls[0]![1]).toEqual({ version: '9007199254740993', syncEnabled: true });
    expect(toggle).not.toBeChecked(); expect(toggle).toHaveAttribute('aria-disabled', 'true'); expect(toggle).toHaveAttribute('aria-busy', 'true'); fireEvent.click(toggle); expect(mocks.sync).toHaveBeenCalledOnce();
    for (const owner of ['settings', 'transfer', 'delete']) expect(screen.getByRole('button', { name: owner })).toBeDisabled();
    const updated = { ...base(), version: '9007199254740994', revision: '5' };
    mocks.status.mockResolvedValue(updated); mocks.counts.mockResolvedValue(count('5'));
    await act(async () => write.resolve(updated));
    await waitFor(() => expect(toggle).toBeChecked());
    expect(screen.getByLabelText('Poll interval')).toHaveValue(8);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save interval' })).toBeEnabled();
  });

  it.each([
    [{ ...base(), syncEnabled: false, connection: 'not_connected' as const }, 'Connect a repository to enable sync.'],
    [{ ...base(), syncEnabled: false, serviceAvailable: false }, 'Configure the GitHub App on this service to enable sync.'],
    [{ ...base(), syncEnabled: false, connection: 'unavailable' as const }, 'Restore repository access to enable sync.'],
  ])('explains why enabling is unavailable', async (status, reason) => {
    mocks.status.mockResolvedValue(status); render(<Subject />); await ready();
    expect(screen.getByRole('switch', { name: 'PR sync' })).toBeDisabled();
    expect(screen.getByText(reason)).toBeVisible();
  });

  it.each([{ ...base(), serviceAvailable: false }, { ...base(), connection: 'unavailable' as const }])('allows turning off despite unavailable service or access', async status => {
    mocks.status.mockResolvedValue(status);
    mocks.sync.mockImplementation(async (_project, _input, _signal, admission) => { admission.onDispatch(); return { ...status, syncEnabled: false, version: '9007199254740994', revision: '5' }; });
    render(<Subject />); await ready();
    fireEvent.click(screen.getByRole('switch', { name: 'PR sync' }));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledOnce());
    expect(mocks.sync.mock.calls[0]![1]).toEqual({ version: '9007199254740993', syncEnabled: false });
  });

  it('shows members the confirmed configuration without allowing writes', async () => {
    mocks.role = 'member'; render(<Subject />);
    expect(await screen.findByText('Enabled', { selector: '.github-sync-readonly' })).toBeVisible();
    expect(screen.queryByRole('switch', { name: 'PR sync' })).toBeNull(); expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('retains management exclusion and the draft through an unknown result until an admitted read', async () => {
    const read = deferred<GitHubStatus>(); const retain = vi.fn();
    mocks.status.mockResolvedValueOnce(base()).mockImplementation(() => read.promise);
    mocks.sync.mockImplementation(async (_project, _input, _signal, admission) => { admission.onDispatch(); throw new ApiError('network'); });
    render(<Subject peers retain={retain} />); await ready();
    fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('switch', { name: 'PR sync' }));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'transfer' })).toBeDisabled();
    expect(retain).toHaveBeenLastCalledWith(true);
    await act(async () => read.reject(new ApiError('network')));
    const error = await screen.findByText('Unable to read GitHub sync status.');
    expect(screen.getByRole('button', { name: 'delete' })).toBeDisabled();
    mocks.status.mockResolvedValue(base());
    fireEvent.click(within(error.closest('[role=alert]')!).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'delete' })).toBeEnabled());
    expect(screen.getByLabelText('Poll interval')).toHaveValue(8); expect(mocks.sync).toHaveBeenCalledOnce();
  });

  it('keeps a confirmed off-route switch guarded until a sufficiently recent read preserves the draft', async () => {
    const write = deferred<GitHubStatus>(); const retain = vi.fn();
    mocks.sync.mockImplementation((_project, _input, _signal, admission) => { admission.onDispatch(); return write.promise.then(value => { admission.onWriteConfirmed(); return value; }); });
    const view = render(<Subject retain={retain} />); await ready();
    fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('switch', { name: 'PR sync' }));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledOnce());
    view.rerender(<Subject active={false} onRoute={false} retain={retain} />);
    const next = { ...base(), syncEnabled: false, version: '9007199254740994', revision: '5' };
    await act(async () => write.resolve(next));
    view.rerender(<Subject active onRoute retain={retain} />);
    const error = await screen.findByText('Unable to read GitHub sync status.');
    expect(retain).toHaveBeenLastCalledWith(true);
    mocks.status.mockResolvedValue(next); mocks.counts.mockResolvedValue(count('5'));
    fireEvent.click(within(error.closest('[role=alert]')!).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retain).toHaveBeenLastCalledWith(false));
    expect(screen.getByLabelText('Poll interval')).toHaveValue(8);
    expect(screen.getByRole('button', { name: 'Save interval' })).toBeEnabled();
    expect(mocks.sync).toHaveBeenCalledOnce();
  });

  it('rereads a conflict without replaying and keeps the interval draft', async () => {
    mocks.sync.mockImplementation(async (_project, _input, _signal, admission) => { admission.onDispatch(); admission.onWriteRejected(); throw new ApiError('server', 409, 'version_conflict'); });
    const newer = { ...base(), version: '9007199254740994', revision: '5' };
    mocks.status.mockResolvedValueOnce(base()).mockResolvedValue(newer); mocks.counts.mockResolvedValue(count('5'));
    render(<Subject />); await ready(); fireEvent.change(screen.getByLabelText('Poll interval'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('switch', { name: 'PR sync' }));
    expect(await screen.findByText('The configuration changed. Check the reread status; your draft is retained.')).toBeVisible();
    expect(screen.getByLabelText('Poll interval')).toHaveValue(8); expect(mocks.sync).toHaveBeenCalledOnce();
  });

  it('presents old errors as history and never as an active sync while disabled', async () => {
    mocks.status.mockResolvedValue({ ...base(), syncEnabled: false, initializing: true, poll: { ...base().poll, running: true, error: { code: 'timeout', message: 'Timed out', at: null } } });
    render(<Subject />); await ready();
    expect(screen.getByText('Sync off')).toBeVisible(); expect(screen.getByText('Last polling attempt failed')).toBeVisible();
    expect(screen.queryByText('First sync')).toBeNull(); expect(screen.queryByText('Polling temporarily failed')).toBeNull();
  });
});
