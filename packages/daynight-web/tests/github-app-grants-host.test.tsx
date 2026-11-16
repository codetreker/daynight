import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { GitHubAppGrantsProps } from '../src/features/github-app-grants/GitHubAppGrants';
import type { TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { GithubAppWorkspace } from '../src/features/github-app-management/GithubAppWorkspace';
import { createLocaleRender } from './helpers/renderWithLocale';

const mocks = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), grants: null as GitHubAppGrantsProps | null, navigate: vi.fn() }));
vi.mock('../src/api/github-app-management', () => ({ getGitHubApp: mocks.get, listGitHubApps: mocks.list, createGitHubApp: vi.fn(), updateGitHubApp: vi.fn(), getGitHubAppRemovalImpact: vi.fn(), listGitHubAppRemovalProjects: vi.fn(), removeGitHubApp: vi.fn() }));
vi.mock('../src/app/router', () => ({ navigate: mocks.navigate }));
vi.mock('../src/features/github-app-grants/GitHubAppGrants', () => ({ GitHubAppGrants: (props: GitHubAppGrantsProps) => { mocks.grants = props; return <><p>Team child</p>{props.active && props.receipt && <p>{props.receipt.result === 'granted' ? 'Team access granted.' : 'Team access revoked and affected connections stopped.'}<button onClick={props.receipt.dismiss}>Dismiss</button></p>}</>; } }));
const appId = '59cb4a41-9b96-43cd-8fe3-cbaf394a51e8', userId = 'c0d0a6d2-539a-4a14-87e0-e9c2de6bd058';
const render = createLocaleRender('en');
const scope = (id = userId) => ({ userId: id, signal: new AbortController().signal, isInvalidated: false, ready: async (signal: AbortSignal) => signal.throwIfAborted() }) as TaskCacheScope;
const admission = scope();
const subject = (overrides: Partial<Parameters<typeof GithubAppWorkspace>[0]> = {}) => <GithubAppWorkspace appId={appId} section="teams" active admission={admission} admissionBlocked={false} onIdentityMismatch={() => {}} {...overrides} />;
beforeEach(() => {
  vi.clearAllMocks(); mocks.grants = null;
  mocks.list.mockResolvedValue({ items: [], nextCursor: null });
  mocks.get.mockResolvedValue({ id: appId, githubAppId: '23', name: 'Release App', githubName: 'Release', githubSlug: 'release', version: '1', administrators: '1', authorizedTeams: '0', connectedProjects: '0', webhookUrl: 'https://example.test', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
});

it('retains a late confirmation across sections but does not duplicate a visible child receipt', async () => {
  const view = render(subject()); await screen.findByText('Team child');
  act(() => mocks.grants!.onResult!('granted')); expect(screen.getAllByText('Team access granted.')).toHaveLength(1);
  view.rerender(subject({ section: 'configuration' })); act(() => mocks.grants!.onResult!('revoked'));
  expect(screen.getByText(/Team access revoked and affected connections stopped/)).toBeVisible();
});

it('retains an unknown outcome after access loss and lets the user finish without replay', async () => {
  render(subject()); await screen.findByText('Team child'); const finish = vi.fn(() => mocks.grants!.onUnknownReviewChange!(null));
  act(() => { mocks.grants!.onUnknownReviewChange!({ state: 'app-unavailable', check: vi.fn(), finish }); mocks.grants!.onUnavailable(); });
  expect(screen.getByText(/Team access operation outcome is unknown/)).toBeVisible(); expect(screen.getByText('This App is currently unavailable.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Finish review' })); expect(finish).toHaveBeenCalledOnce(); expect(screen.queryByText(/Team access operation outcome is unknown/)).toBeNull();
});

it('discards retained results and ignores old callbacks when the admission identity changes', async () => {
  const view = render(subject()); await screen.findByText('Team child'); const old = mocks.grants!;
  view.rerender(subject({ section: 'configuration' })); act(() => old.onResult!('granted')); expect(screen.getByText('Team access granted.')).toBeVisible();
  view.rerender(subject({ admission: scope('f9c9b0ee-8f25-4b89-a6a4-d75aee7dc633'), section: 'configuration' }));
  act(() => { old.onResult!('revoked'); old.onUnknownReviewChange!({ state: 'unknown', check: vi.fn(), finish: null }); });
  expect(screen.queryByText('Team access granted.')).toBeNull(); expect(screen.queryByText(/Team access revoked and affected connections stopped/)).toBeNull(); expect(screen.queryByText(/Team access operation outcome is unknown/)).toBeNull();
});

it('exposes a publication failure and retry after leaving the Team section or losing App access', async () => {
  const view = render(subject()); await screen.findByText('Team child'); const retry = vi.fn();
  act(() => mocks.grants!.onPublicationErrorChange!({ confirmed: true, unavailable: false, retry }));
  expect(screen.queryByText('The operation succeeded, but its result could not be displayed.')).toBeNull();
  view.rerender(subject({ section: 'configuration' }));
  expect(screen.getByText('The operation succeeded, but its result could not be displayed.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Retry showing result' })); expect(retry).toHaveBeenCalledOnce();
  view.rerender(subject()); act(() => { mocks.grants!.onPublicationErrorChange!({ confirmed: true, unavailable: true, retry }); mocks.grants!.onUnavailable(); });
  expect(screen.getByText('The operation succeeded, but its result could not be displayed.')).toBeVisible();
  act(() => mocks.grants!.onPublicationErrorChange!(null)); expect(screen.queryByText('The operation succeeded, but its result could not be displayed.')).toBeNull();
});

it('keeps publication retry visible if a list refresh clears the shared denial while detail remains unavailable', async () => {
  const view = render(subject()); await screen.findByText('Team child'); const retry = vi.fn();
  act(() => { mocks.grants!.onPublicationErrorChange!({ confirmed: true, unavailable: true, retry }); mocks.grants!.onUnavailable(); });
  view.rerender(subject({ appId: null })); await screen.findByText('No GitHub Apps to administer');
  mocks.get.mockReturnValue(new Promise(() => {})); view.rerender(subject());
  expect(screen.getByText('The operation succeeded, but its result could not be displayed.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Retry showing result' })); expect(retry).toHaveBeenCalledOnce();
});

it('routes a confirmation to the host when access loss and publication occur before the next render', async () => {
  render(subject()); await screen.findByText('Team child'); let local: boolean | void;
  act(() => { mocks.grants!.onUnavailable(); local = mocks.grants!.onResult!('granted'); });
  expect(local!).toBe(false); expect(screen.getByText('Team access granted.')).toBeVisible();
});

it('retains the receipt when confirmation precedes access loss in the same batch', async () => {
  render(subject()); await screen.findByText('Team child');
  act(() => { mocks.grants!.onResult!('granted'); mocks.grants!.onUnavailable(); });
  expect(screen.getAllByText('Team access granted.').filter(node => node.closest('[hidden]') === null)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); expect(screen.queryByText('Team access granted.')).toBeNull();
});
