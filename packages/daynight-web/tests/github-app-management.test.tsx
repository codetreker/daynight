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
    const view = render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Edit configuration' }));
    const dialog = screen.getByRole('dialog'); fireEvent.change(within(dialog).getByLabelText('Private key'), { target: { value: 'PRIVATE DRAFT' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verify and save' })); await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    const replacement = { ...scope, userId: 'f9c9b0ee-8f25-4b89-a6a4-d75aee7dc633' } as TaskCacheScope;
    scope = replacement; view.rerender(subject()); await act(async () => pending.resolve({ ...app, version: '9007199254740994' }));
    expect(screen.queryByDisplayValue('PRIVATE DRAFT')).toBeNull(); expect(screen.queryByText('Configuration saved.')).toBeNull();
  });
  it('omits blank secrets and submits the exact observed version', async () => {
    mocks.update.mockImplementation(async (_id, input, _signal, admission) => { admission.onDispatch(); return { ...app, name: input.name, version: '9007199254740994' }; });
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Edit configuration' }));
    const dialog = screen.getByRole('dialog'); expect(within(dialog).getByLabelText('Private key')).toHaveValue(''); expect(within(dialog).getByLabelText('Webhook secret')).toHaveValue('');
    fireEvent.change(within(dialog).getByLabelText('Registration name'), { target: { value: 'Renamed' } }); fireEvent.click(within(dialog).getByRole('button', { name: 'Verify and save' }));
    await screen.findByText('Configuration saved.'); expect(mocks.update.mock.calls[0]![1]).toEqual({ version: '9007199254740993', name: 'Renamed' });
  });
  it('retains a draft after a version conflict and requires a fresh decision', async () => {
    const failure = new ApiError('server', 409, 'version_conflict');
    mocks.update.mockImplementation(async (_id, _input, _signal, admission) => { admission.onDispatch(); throw failure; });
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Edit configuration' }));
    const dialog = screen.getByRole('dialog'), name = within(dialog).getByLabelText('Registration name'); fireEvent.change(name, { target: { value: 'Draft name' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verify and save' }));
    expect(await within(dialog).findByRole('button', { name: 'Review current state' })).toBeVisible(); expect(name).toHaveValue('Draft name'); expect(mocks.update).toHaveBeenCalledOnce();
    mocks.get.mockResolvedValue({ ...app, version: '9007199254740994', name: 'Other name' }); fireEvent.click(within(dialog).getByRole('button', { name: 'Review current state' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Verify and save' })).toBeEnabled()); expect(name).toHaveValue('Draft name'); expect(mocks.update).toHaveBeenCalledOnce();
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

  it('cancels a pending project permission check when the dialog closes', async () => {
    const pending = deferred<unknown>(); const project = { id: 'a7d416e6-fac3-4f72-a696-31c016bd90b8', name: 'Private project', repoUrl: 'https://example.test/private' };
    mocks.projects.mockResolvedValue({ items: [project], hiddenProjects: '0', nextCursor: null }); mocks.projectAccess.mockReturnValue(pending.promise);
    render(subject()); fireEvent.click(await screen.findByRole('button', { name: 'Delete App' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View accessible projects' })); await waitFor(() => expect(mocks.projectAccess).toHaveBeenCalledOnce());
    const signal = mocks.projectAccess.mock.calls[0]![1] as AbortSignal; fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({})); expect(screen.queryByText(/Private project/)).toBeNull();
  });

});
