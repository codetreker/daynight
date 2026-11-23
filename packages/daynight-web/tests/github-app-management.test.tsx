import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { GitHubApp } from '../src/api/github-app-management';
import { GithubAppWorkspace } from '../src/features/github-app-management/GithubAppWorkspace';
import type { TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { createLocaleRender } from './helpers/renderWithLocale';

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), impact: vi.fn(), projects: vi.fn(), projectAccess: vi.fn(), remove: vi.fn(), navigate: vi.fn() }));
vi.mock('../src/api/github-app-management', () => ({ listGitHubApps: mocks.list, getGitHubApp: mocks.get, createGitHubApp: mocks.create, updateGitHubApp: mocks.update, getGitHubAppRemovalImpact: mocks.impact, listGitHubAppRemovalProjects: mocks.projects, removeGitHubApp: mocks.remove }));
vi.mock('../src/api/auth', () => ({ getProjectAccess: mocks.projectAccess }));
vi.mock('../src/app/router', () => ({ navigate: mocks.navigate }));
const id = '59cb4a41-9b96-43cd-8fe3-cbaf394a51e8', userId = 'c0d0a6d2-539a-4a14-87e0-e9c2de6bd058';
const app: GitHubApp = { id, githubAppId: '23', name: 'Release App', githubName: 'Release', githubSlug: 'release', version: '9007199254740993', administrators: '1', authorizedTeams: '0', connectedProjects: '0', webhookUrl: `https://daynight.example/api/v1/github/apps/${id}/webhook`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const render = createLocaleRender('en');
let scope: TaskCacheScope;
const mismatch = vi.fn();
const subject = (overrides: Partial<Parameters<typeof GithubAppWorkspace>[0]> = {}) => <GithubAppWorkspace appId={id} active admission={scope} admissionBlocked={false} onIdentityMismatch={mismatch} {...overrides} />;
beforeEach(() => {
  vi.clearAllMocks(); const controller = new AbortController();
  scope = { userId, signal: controller.signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() } as TaskCacheScope;
  mocks.list.mockResolvedValue({ items: [app], nextCursor: null }); mocks.get.mockResolvedValue(app);
  mocks.impact.mockResolvedValue({ appId: id, grantId: null, version: app.version, impactVersion: '4', totalProjects: '0', visibleProjects: '0', hiddenProjects: '0', teams: [], nextCursor: null });
  mocks.projects.mockResolvedValue({ items: [], hiddenProjects: '0', nextCursor: null }); mocks.projectAccess.mockResolvedValue({});
});

describe('GitHub App management', () => {
  it('does not read or expose retained content while admission is blocked on first entry', async () => {
    const view = render(subject({ admissionBlocked: true })); expect(mocks.get).not.toHaveBeenCalled(); expect(screen.queryByText('Release App')).toBeNull();
    view.rerender(subject()); expect(await screen.findByRole('heading', { name: 'Release App' })).toBeVisible(); expect(mocks.get).toHaveBeenCalledOnce();
  });
  it('discards credentials and isolates a late write after account replacement', async () => {
    const pending = deferred<GitHubApp>(); mocks.update.mockImplementation((_id, _input, _signal, admission) => { admission.onDispatch(); return pending.promise; });
    const view = render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Change private key' }));
    const dialog = screen.getByRole('dialog'); fireEvent.change(within(dialog).getByLabelText('Private key'), { target: { value: 'PRIVATE DRAFT' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save private key' })); await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    const replacement = { ...scope, userId: 'f9c9b0ee-8f25-4b89-a6a4-d75aee7dc633' } as TaskCacheScope;
    scope = replacement; view.rerender(subject()); await act(async () => pending.resolve({ ...app, version: '9007199254740994' }));
    expect(screen.queryByDisplayValue('PRIVATE DRAFT')).toBeNull(); expect(screen.queryByText('Private key saved.')).toBeNull();
  });
  it('omits blank secrets and submits the exact observed version', async () => {
    mocks.update.mockImplementation(async (_id, input, _signal, admission) => { admission.onDispatch(); return { ...app, name: input.name, version: '9007199254740994' }; });
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Edit name' }));
    const dialog = screen.getByRole('dialog'); expect(within(dialog).queryByLabelText('Private key')).toBeNull(); expect(within(dialog).queryByLabelText('Webhook secret')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Registration name'), { target: { value: 'Renamed' } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));
    await screen.findByText('Name saved.'); expect(mocks.update.mock.calls[0]![1]).toEqual({ version: '9007199254740993', name: 'Renamed' });
  });
  it('does not send an unchanged name', async () => {
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Edit name' }));
    const dialog = screen.getByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('isolates credential drafts, refuses blank input and submits only the selected field', async () => {
    mocks.update.mockImplementation(async (_id, _input, _signal, admission) => { admission.onDispatch(); return { ...app, version: '9007199254740994' }; });
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Change private key' }));
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Webhook secret')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save private key' })); expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Private key'), { target: { value: 'PRIVATE DRAFT' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change Webhook secret' })); dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Private key')).toBeNull(); expect(within(dialog).getByLabelText('Webhook secret')).toHaveValue('');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Webhook secret' })); expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Webhook secret'), { target: { value: '  secret  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Webhook secret' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.update.mock.calls[0]![1]).toEqual({ version: '9007199254740993', webhookSecret: '  secret  ' });
    expect(mocks.update.mock.calls[0]![3]).toEqual(expect.objectContaining({ userId }));
    fireEvent.click(screen.getByRole('button', { name: 'Change private key' })); dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Private key')).toHaveValue('');
    fireEvent.change(within(dialog).getByLabelText('Private key'), { target: { value: 'NEW KEY' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save private key' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls[1]![1]).toEqual({ version: '9007199254740994', privateKeyPem: 'NEW KEY' });
  });
  it('does not repeat a pending or unknown credential write or allow another editor to bypass it', async () => {
    const pending = deferred<GitHubApp>(); mocks.update.mockImplementation((_id, _input, _signal, admission) => { admission.onDispatch(); return pending.promise; });
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Change Webhook secret' }));
    const dialog = screen.getByRole('dialog'); fireEvent.change(within(dialog).getByLabelText('Webhook secret'), { target: { value: 'uncertain' } });
    const submit = within(dialog).getByRole('button', { name: 'Save Webhook secret' }); fireEvent.click(submit); fireEvent.click(submit);
    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce()); expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(async () => pending.reject(new ApiError('network'))); await within(dialog).findByText(/result is unknown/i);
    expect(within(dialog).getByLabelText('Webhook secret')).toHaveValue('uncertain');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.getByText(/result is unknown/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Change private key' }));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.update).toHaveBeenCalledOnce();
  });
  it('retains a confirmed receipt across dialog closure while admission recovery is pending', async () => {
    const recovery = deferred<void>(); let blocked = false;
    scope = { ...scope, ready: async (signal: AbortSignal) => { signal.throwIfAborted(); if (blocked) await recovery.promise; signal.throwIfAborted(); } } as TaskCacheScope;
    mocks.update.mockImplementation(async (_id, _input, _signal, admission) => {
      admission.onDispatch(); blocked = true; return { ...app, version: '9007199254740994' };
    });
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Change Webhook secret' }));
    const dialog = screen.getByRole('dialog'); fireEvent.change(within(dialog).getByLabelText('Webhook secret'), { target: { value: 'confirmed-secret' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Webhook secret' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })); expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Change private key' }));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.update).toHaveBeenCalledOnce();
    blocked = false; await act(async () => recovery.resolve());
    await screen.findByText('Webhook secret saved.');
    fireEvent.click(screen.getByRole('button', { name: 'Change private key' }));
    const next = screen.getByRole('dialog'); fireEvent.change(within(next).getByLabelText('Private key'), { target: { value: 'next key' } });
    fireEvent.click(within(next).getByRole('button', { name: 'Save private key' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls[1]![1]).toEqual({ version: '9007199254740994', privateKeyPem: 'next key' });
    await act(async () => recovery.resolve());
  });
  it('retains a draft after a version conflict and requires a fresh decision', async () => {
    const failure = new ApiError('server', 409, 'version_conflict');
    mocks.update.mockImplementation(async (_id, _input, _signal, admission) => { admission.onDispatch(); throw failure; });
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Change private key' }));
    const dialog = screen.getByRole('dialog'), key = within(dialog).getByLabelText('Private key'); fireEvent.change(key, { target: { value: 'Draft key' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save private key' }));
    expect(await within(dialog).findByRole('button', { name: 'Review current state' })).toBeVisible(); expect(key).toHaveValue('Draft key'); expect(mocks.update).toHaveBeenCalledOnce();
    mocks.get.mockResolvedValue({ ...app, version: '9007199254740994', name: 'Other name' }); fireEvent.click(within(dialog).getByRole('button', { name: 'Review current state' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save private key' })).toBeEnabled()); expect(key).toHaveValue('Draft key'); expect(mocks.update).toHaveBeenCalledOnce();
  });
  it('keeps an unknown registration distinct after checking its generated ID and never replays it', async () => {
    mocks.create.mockImplementation(async (_input, _signal, admission) => { admission.onDispatch(); throw new ApiError('network'); });
    mocks.get.mockRejectedValue(new ApiError('server', 404, 'not_found'));
    render(subject({ appId: null })); fireEvent.click(await screen.findByRole('button', { name: 'Register GitHub App' })); const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('App ID'), { target: { value: '23' } }); fireEvent.change(within(dialog).getByLabelText('Registration name'), { target: { value: 'New App' } });
    fireEvent.change(within(dialog).getByLabelText('Private key'), { target: { value: 'private' } }); fireEvent.change(within(dialog).getByLabelText('Webhook secret'), { target: { value: 'secret' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verify and register' })); await within(dialog).findByText(/result is unknown/i);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' })); await within(dialog).findByText(/cannot confirm the original operation/i);
    expect(mocks.get.mock.calls.at(-1)![0]).toBe(mocks.create.mock.calls[0]![0].id); expect(mocks.create).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish review and decide again' })); expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.create).toHaveBeenCalledOnce();
  });
  for (const lateResult of ['success', 'failure'] as const) {
    it(`does not apply an old registration check's late ${lateResult} to a new draft`, async () => {
      const old = deferred<GitHubApp>();
      mocks.create.mockImplementation(async (_input, _signal, admission) => { admission.onDispatch(); throw new ApiError('network'); });
      mocks.get.mockReturnValueOnce(old.promise).mockRejectedValueOnce(new ApiError('server', 404, 'not_found'));
      render(subject({ appId: null })); fireEvent.click(await screen.findByRole('button', { name: 'Register GitHub App' }));
      let dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('App ID'), { target: { value: '23' } }); fireEvent.change(within(dialog).getByLabelText('Registration name'), { target: { value: 'Old App' } });
      fireEvent.change(within(dialog).getByLabelText('Private key'), { target: { value: 'old key' } }); fireEvent.change(within(dialog).getByLabelText('Webhook secret'), { target: { value: 'old secret' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Verify and register' })); await within(dialog).findByText(/result is unknown/i);
      const check = within(dialog).getByRole('button', { name: 'Check current state' });
      fireEvent.click(check); await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
      const oldSignal = mocks.get.mock.calls[0]![1] as AbortSignal;
      fireEvent.click(check); await within(dialog).findByText(/cannot confirm the original operation/i); expect(oldSignal.aborted).toBe(true);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Finish review and decide again' }));
      fireEvent.click(screen.getByRole('button', { name: 'Register GitHub App' })); dialog = screen.getByRole('dialog');
      const name = within(dialog).getByLabelText('Registration name'), secret = within(dialog).getByLabelText('Webhook secret');
      fireEvent.change(name, { target: { value: 'New draft' } }); fireEvent.change(secret, { target: { value: 'new secret' } });
      await act(async () => { if (lateResult === 'success') old.resolve(app); else old.reject(new ApiError('network')); });
      expect(name).toHaveValue('New draft'); expect(secret).toHaveValue('new secret');
      expect(within(dialog).queryByText(/cannot confirm the original operation/i)).toBeNull();
      expect(within(dialog).queryByText('Release App')).toBeNull(); expect(within(dialog).queryByRole('button', { name: 'Finish review and decide again' })).toBeNull();
      expect(screen.queryByText('The operation failed.')).toBeNull(); expect(mocks.create).toHaveBeenCalledOnce();
    });
  }
  it('discards a project page if hidden counts change before publication', async () => {
    const project = { id: 'a7d416e6-fac3-4f72-a696-31c016bd90b8', name: 'Private project', repoUrl: 'https://example.test/private' };
    mocks.projects.mockResolvedValue({ items: [project], hiddenProjects: '0', nextCursor: null });
    const initial = { appId: id, grantId: null, version: app.version, impactVersion: '4', totalProjects: '1', visibleProjects: '1', hiddenProjects: '0', teams: [], nextCursor: null };
    mocks.impact.mockResolvedValueOnce(initial).mockResolvedValue({ ...initial, visibleProjects: '0', hiddenProjects: '1' });
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Delete App' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' }));
    await within(dialog).findByText(/Project access changed/); expect(within(dialog).queryByText(/Private project/)).toBeNull();
    expect(mocks.projectAccess).toHaveBeenCalledWith(project.id, expect.any(AbortSignal), expect.objectContaining({ userId }));
  });
  it('discards details on project access loss without declaring the App unavailable', async () => {
    const project = { id: 'a7d416e6-fac3-4f72-a696-31c016bd90b8', name: 'Private project', repoUrl: 'https://example.test/private' };
    mocks.projects.mockResolvedValue({ items: [project], hiddenProjects: '0', nextCursor: null }); mocks.projectAccess.mockRejectedValue(new ApiError('server', 404, 'not_found'));
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Delete App' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Project access changed/);
    expect(within(dialog).queryByText(/Private project/)).toBeNull(); expect(screen.queryByText('This App is unavailable or you do not have access.')).toBeNull();
  });

  it('ignores a late denial from an older failed Project check after a successful retry', async () => {
    const first = { id: 'a7d416e6-fac3-4f72-a696-31c016bd90b8', name: 'Private project', repoUrl: 'https://example.test/private' }, second = { id: 'a7d416e6-fac3-4f72-a696-31c016bd90b9', name: 'Second project', repoUrl: 'https://example.test/second' }, late = deferred<unknown>();
    mocks.projects.mockResolvedValue({ items: [first, second], hiddenProjects: '0', nextCursor: null });
    mocks.projectAccess.mockImplementation(projectId => projectId === first.id ? Promise.reject(new ApiError('network')) : late.promise);
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Delete App' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByRole('alert');
    expect(mocks.projectAccess).toHaveBeenCalledTimes(2); mocks.projectAccess.mockResolvedValue({});
    fireEvent.click(within(dialog).getByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/);
    await act(async () => late.reject(new ApiError('server', 403, 'forbidden')));
    expect(within(dialog).getByText(/Private project/)).toBeVisible(); expect(within(dialog).getByText(/Second project/)).toBeVisible();
  });

  it('cancels a pending project permission check when the dialog closes', async () => {
    const pending = deferred<unknown>(); const project = { id: 'a7d416e6-fac3-4f72-a696-31c016bd90b8', name: 'Private project', repoUrl: 'https://example.test/private' };
    mocks.projects.mockResolvedValue({ items: [project], hiddenProjects: '0', nextCursor: null }); mocks.projectAccess.mockReturnValue(pending.promise);
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Delete App' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await waitFor(() => expect(mocks.projectAccess).toHaveBeenCalledOnce());
    const signal = mocks.projectAccess.mock.calls[0]![1] as AbortSignal; fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({})); expect(screen.queryByText(/Private project/)).toBeNull();
  });

  it('keeps the editor and focus during a temporary admission block and its recovery read', async () => {
    const view = render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Change Webhook secret' }));
    const dialog = screen.getByRole('dialog'), secret = within(dialog).getByLabelText('Webhook secret') as HTMLInputElement;
    fireEvent.change(secret, { target: { value: 'retained-secret' } }); secret.focus(); secret.setSelectionRange(2, 6);
    const reads = mocks.get.mock.calls.length, pending = deferred<GitHubApp>(); mocks.get.mockReturnValue(pending.promise);
    view.rerender(subject({ admissionBlocked: true }));
    expect(screen.getByRole('dialog')).toBe(dialog); expect(secret).toBeVisible(); expect(secret).toBeEnabled(); expect(secret).toHaveFocus();
    expect(secret).toHaveValue('retained-secret'); expect([secret.selectionStart, secret.selectionEnd]).toEqual([2, 6]);
    expect(within(dialog).getByRole('button', { name: 'Save Webhook secret' })).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(within(dialog).getByRole('button', { name: 'Save Webhook secret' })); expect(mocks.get).toHaveBeenCalledTimes(reads); expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.change(secret, { target: { value: 'edited-locally' } });
    view.rerender(subject()); await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(reads + 1));
    expect(screen.getByRole('dialog')).toBe(dialog); expect(secret).toBeVisible(); expect(secret).toHaveFocus(); expect(secret).toHaveValue('edited-locally');
    expect(within(dialog).getByRole('button', { name: 'Save Webhook secret' })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => pending.resolve({ ...app }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save Webhook secret' })).toHaveAttribute('aria-disabled', 'false'));
    expect(secret).toHaveFocus(); expect(secret).toHaveValue('edited-locally'); expect(mocks.update).not.toHaveBeenCalled();
  });

  it('keeps expanded project details and focus while temporary admission blocks requests', async () => {
    const project = { id: 'a7d416e6-fac3-4f72-a696-31c016bd90b8', name: 'Private project', repoUrl: 'https://example.test/private' };
    mocks.impact.mockResolvedValue({ appId: id, grantId: null, version: app.version, impactVersion: '4', totalProjects: '1', visibleProjects: '1', hiddenProjects: '0', teams: [], nextCursor: null });
    mocks.projects.mockResolvedValue({ items: [project], hiddenProjects: '0', nextCursor: null });
    const view = render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Delete App' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' }));
    await within(dialog).findByText(/Private project/); const cancel = within(dialog).getByRole('button', { name: 'Cancel' }); cancel.focus();
    const counts = [mocks.get.mock.calls.length, mocks.impact.mock.calls.length, mocks.projects.mock.calls.length], pending = deferred<GitHubApp>(); mocks.get.mockReturnValue(pending.promise);
    view.rerender(subject({ admissionBlocked: true }));
    expect(screen.getByRole('dialog')).toBe(dialog); expect(within(dialog).getByText(/Private project/)).toBeVisible(); expect(cancel).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Delete App and stop connections' })).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(within(dialog).getByRole('button', { name: 'Delete App and stop connections' }));
    expect([mocks.get.mock.calls.length, mocks.impact.mock.calls.length, mocks.projects.mock.calls.length]).toEqual(counts); expect(mocks.remove).not.toHaveBeenCalled();
    view.rerender(subject()); await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(counts[0]! + 1));
    expect(screen.getByRole('dialog')).toBe(dialog); expect(within(dialog).getByText(/Private project/)).toBeVisible(); expect(cancel).toHaveFocus();
    await act(async () => pending.resolve({ ...app }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Delete App and stop connections' })).toHaveAttribute('aria-disabled', 'false'));
    expect(within(dialog).getByText(/Private project/)).toBeVisible(); expect(cancel).toHaveFocus(); expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('clears displayed projects as soon as the first refreshed Team page changes hidden counts', async () => {
    const project = { id: 'a7d416e6-fac3-4f72-a696-31c016bd90b8', name: 'Private project', repoUrl: 'https://example.test/private' };
    const initial = { appId: id, grantId: null, version: app.version, impactVersion: '4', totalProjects: '2', visibleProjects: '2', hiddenProjects: '0', teams: [], nextCursor: 'next' };
    const next = deferred<unknown>(); let refreshing = false;
    mocks.impact.mockImplementation((_id, cursor) => refreshing ? cursor ? next.promise : Promise.resolve({ ...initial, visibleProjects: '1', hiddenProjects: '1' }) : Promise.resolve({ ...initial, nextCursor: cursor ? null : 'next' }));
    mocks.projects.mockResolvedValue({ items: [project], hiddenProjects: '0', nextCursor: null });
    const view = render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Delete App' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Load more' })).toBeNull());
    fireEvent.click(within(dialog).getByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/);
    view.rerender(subject({ admissionBlocked: true })); refreshing = true; const reads = mocks.impact.mock.calls.length;
    view.rerender(subject());
    await waitFor(() => expect(mocks.impact.mock.calls.length).toBeGreaterThanOrEqual(reads + 2));
    expect(within(dialog).queryByText(/Private project/)).toBeNull(); expect(within(dialog).queryByText(/example.test\/private/)).toBeNull();
    await act(async () => next.resolve({ ...initial, visibleProjects: '1', hiddenProjects: '1', nextCursor: null }));
  });

  it('clears displayed projects on one denied check before another concurrent check finishes', async () => {
    const projects = [
      { id: 'a7d416e6-fac3-4f72-a696-31c016bd90b8', name: 'Private project', repoUrl: 'https://example.test/private' },
      { id: 'a7d416e6-fac3-4f72-a696-31c016bd90b9', name: 'Second project', repoUrl: 'https://example.test/second' },
    ];
    mocks.impact.mockResolvedValue({ appId: id, grantId: null, version: app.version, impactVersion: '4', totalProjects: '2', visibleProjects: '2', hiddenProjects: '0', teams: [], nextCursor: null });
    mocks.projects.mockResolvedValue({ items: projects, hiddenProjects: '0', nextCursor: null });
    const view = render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Delete App' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/);
    const denied = deferred<unknown>(), pending = deferred<unknown>();
    mocks.projectAccess.mockImplementation(projectId => projectId === projects[0]!.id ? denied.promise : pending.promise);
    view.rerender(subject({ admissionBlocked: true })); const reads = mocks.projectAccess.mock.calls.length; view.rerender(subject());
    await waitFor(() => expect(mocks.projectAccess).toHaveBeenCalledTimes(reads + 2));
    expect(within(dialog).getByText(/Private project/)).toBeVisible();
    await act(async () => denied.reject(new ApiError('server', 404, 'not_found')));
    await waitFor(() => expect(within(dialog).queryByText(/Private project/)).toBeNull());
    expect(within(dialog).queryByText(/Second project/)).toBeNull(); expect(within(dialog).queryByText(/example.test/)).toBeNull();
    await act(async () => pending.resolve({})); await within(dialog).findByText(/Project access changed/);
  });

  it('keeps registration and unknown-outcome check buttons focused while admission gates requests', async () => {
    mocks.create.mockImplementation(async (_input, _signal, admission) => { admission.onDispatch(); throw new ApiError('network'); });
    mocks.get.mockRejectedValue(new ApiError('server', 404, 'not_found'));
    const view = render(subject({ appId: null })); const opener = await screen.findByRole('button', { name: 'Register GitHub App' }); opener.focus();
    view.rerender(subject({ appId: null, admissionBlocked: true })); expect(opener).toHaveFocus(); expect(opener).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(opener); expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(subject({ appId: null })); fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('App ID'), { target: { value: '23' } }); fireEvent.change(within(dialog).getByLabelText('Registration name'), { target: { value: 'New App' } });
    fireEvent.change(within(dialog).getByLabelText('Private key'), { target: { value: 'private' } }); fireEvent.change(within(dialog).getByLabelText('Webhook secret'), { target: { value: 'secret' } });
    const submit = within(dialog).getByRole('button', { name: 'Verify and register' }); submit.focus(); view.rerender(subject({ appId: null, admissionBlocked: true }));
    expect(submit).toHaveFocus(); expect(submit).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(submit); expect(mocks.create).not.toHaveBeenCalled();
    view.rerender(subject({ appId: null })); fireEvent.click(submit); await within(dialog).findByText(/result is unknown/i);
    const check = within(dialog).getByRole('button', { name: 'Check current state' }); check.focus(); view.rerender(subject({ appId: null, admissionBlocked: true }));
    expect(check).toHaveFocus(); expect(check).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(check); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.create).toHaveBeenCalledOnce();
    view.rerender(subject({ appId: null })); fireEvent.click(check); await within(dialog).findByText(/cannot confirm the original operation/i);
    expect(mocks.get).toHaveBeenCalledOnce(); expect(mocks.create).toHaveBeenCalledOnce();
  });


  it('keeps the retry available when a foreground impact refresh fails with projects expanded', async () => {
    const project = { id: 'a7d416e6-fac3-4f72-a696-31c016bd90b8', name: 'Private project', repoUrl: 'https://example.test/private' };
    const impact = { appId: id, grantId: null, version: app.version, impactVersion: '4', totalProjects: '2', visibleProjects: '2', hiddenProjects: '0', teams: [], nextCursor: null };
    mocks.impact.mockResolvedValue(impact); mocks.projects.mockImplementation(async (_id, cursor) => cursor === null ? { items: [project], hiddenProjects: '0', nextCursor: 'next' } : { items: [{ ...project, id: 'a7d416e6-fac3-4f72-a696-31c016bd90b9', name: 'Second project' }], hiddenProjects: '0', nextCursor: null });
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Delete App' })); const dialog = screen.getByRole('dialog');
      fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/);
      const projectReads = mocks.projects.mock.calls.length; mocks.impact.mockRejectedValueOnce(new ApiError('network'));
      focus.mockReturnValue(false); fireEvent.blur(window); focus.mockReturnValue(true); fireEvent.focus(window);
      const retry = await within(dialog).findByRole('button', { name: 'Retry' });
      expect(within(dialog).getByText(/Private project/)).toBeVisible();
      const more = within(dialog).getByRole('button', { name: 'Load more' }); expect(more).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(more);
      expect(mocks.projects).toHaveBeenCalledTimes(projectReads); expect(retry).toBeVisible();
      expect(within(dialog).getByRole('button', { name: 'Delete App and stop connections' })).toHaveAttribute('aria-disabled', 'true'); expect(mocks.remove).not.toHaveBeenCalled();
      fireEvent.click(retry);
      await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Retry' })).toBeNull());
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Delete App and stop connections' })).toHaveAttribute('aria-disabled', 'false'));
      expect(within(dialog).getByText(/Private project/)).toBeVisible(); expect(more).toHaveAttribute('aria-disabled', 'false');
      fireEvent.click(more); await within(dialog).findByText(/Second project/); expect(mocks.projects).toHaveBeenCalledTimes(projectReads + 2); expect(mocks.remove).not.toHaveBeenCalled();
    } finally { focus.mockRestore(); }
  });

  it('rechecks expanded Project permissions after retrying a failed impact refresh', async () => {
    const project = { id: 'a7d416e6-fac3-4f72-a696-31c016bd90b8', name: 'Private project', repoUrl: 'https://example.test/private' };
    const impact = { appId: id, grantId: null, version: app.version, impactVersion: '4', totalProjects: '1', visibleProjects: '1', hiddenProjects: '0', teams: [], nextCursor: null };
    mocks.impact.mockResolvedValue(impact); mocks.projects.mockResolvedValue({ items: [project], hiddenProjects: '0', nextCursor: null });
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Delete App' })); const dialog = screen.getByRole('dialog');
      fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await within(dialog).findByText(/Private project/);
      const checks = mocks.projectAccess.mock.calls.length; mocks.impact.mockRejectedValueOnce(new ApiError('network'));
      focus.mockReturnValue(false); fireEvent.blur(window); focus.mockReturnValue(true); fireEvent.focus(window);
      const retry = await within(dialog).findByRole('button', { name: 'Retry' });
      mocks.projectAccess.mockRejectedValue(new ApiError('server', 403, 'forbidden')); fireEvent.click(retry);
      await within(dialog).findByText(/Project access changed/); expect(mocks.projectAccess).toHaveBeenCalledTimes(checks + 1);
      expect(within(dialog).queryByText(/Private project/)).toBeNull(); expect(within(dialog).queryByText(/example.test\/private/)).toBeNull();
      expect(mocks.remove).not.toHaveBeenCalled();
    } finally { focus.mockRestore(); }
  });

});
