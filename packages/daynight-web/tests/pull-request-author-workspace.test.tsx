import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import { PullRequestWorkspace } from '../src/features/pull-requests/PullRequestWorkspace';
import { renderWithLocale } from './helpers/renderWithLocale';
import { prPage, prProjectId, prResponse, prStatus, prUserId } from './pull-requests-fixtures';

afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('reports an empty combination and clears only the author while preserving status and query', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'https://test'); requests.push(url);
    if (url.pathname.endsWith('/github')) return prResponse(prStatus());
    if (url.pathname.endsWith('/pull-request-authors')) return prResponse({ projectId: prProjectId, revision: '1', items: [{ id: '42', login: 'author', loginAmbiguous: false }], nextCursor: null });
    const authorId = url.searchParams.get('authorId');
    const selected = authorId !== null;
    return prResponse({ ...prPage(url.searchParams.get('q') ? [] : ['42']), counts: selected ? { active: '3', merged: '2', closed: '1', all: '6' } : { active: '5', merged: '4', closed: '2', all: '11' }, ...(selected ? { authorId, projectTotal: '11' } : {}) });
  }));
  renderWithLocale(<PullRequestWorkspace userId={prUserId} projectId={prProjectId} active canRead onPrincipalMismatch={vi.fn()} />, { locale: 'en' });
  await screen.findByRole('button', { name: '#42 PR 42, Open' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Pull request status' }), { target: { value: 'merged' } });
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search pull request title or number' }), { target: { value: 'needle' } });
  fireEvent.click(screen.getByRole('button', { name: 'Creator: All' }));
  const dialog = await screen.findByRole('dialog', { name: 'Choose PR creator' });
  fireEvent.click(await within(dialog).findByRole('option', { name: 'author' }));
  await screen.findByRole('heading', { name: 'No matching pull requests' });
  expect(screen.getByText('Try a different creator, status, or search.')).toBeVisible();
  await waitFor(() => expect(screen.getByRole('option', { name: 'Merged · 2' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Clear creator' }));
  expect(screen.getByRole('combobox', { name: 'Pull request status' })).toHaveValue('merged');
  expect(screen.getByRole('searchbox', { name: 'Search pull request title or number' })).toHaveValue('needle');
  expect(screen.getByRole('button', { name: 'Creator: All' })).toBeVisible();
  await waitFor(() => expect(requests.some(url => url.pathname.endsWith('/pull-requests') && url.searchParams.get('authorId') === null && url.searchParams.get('state') === 'merged' && url.searchParams.get('q') === 'needle')).toBe(true));
});

it('disables status and search after a trusted denial while retaining retry', async () => {
  let deny = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'https://test');
    if (url.pathname.endsWith('/github')) return prResponse(prStatus());
    if (deny) return prResponse({ error: { code: 'forbidden', message: 'Forbidden', requestId: 'test' } }, 403);
    return prResponse(prPage());
  }));
  renderWithLocale(<PullRequestWorkspace userId={prUserId} projectId={prProjectId} active canRead onPrincipalMismatch={vi.fn()} onAccessError={vi.fn()} />, { locale: 'en' });
  await screen.findByRole('button', { name: '#42 PR 42, Open' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  deny = true;
  fireEvent.focus(window);
  await screen.findByRole('heading', { name: 'Could not read pull requests. Previously saved data has not been deleted.' });
  expect(screen.getByRole('combobox', { name: 'Pull request status' })).toBeDisabled();
  expect(screen.getByRole('searchbox', { name: 'Search pull request title or number' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
});

it('offers recovery after an authentication generation change without an API error', async () => {
  const { pauseAuthRequests } = await import('../src/api/client');
  const { prDeferred } = await import('./pull-requests-fixtures');
  const pending = prDeferred<Response>();
  let checking = false, checkingDispatched = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'https://test');
    if (checking && url.pathname.endsWith('/github')) { checkingDispatched = true; return pending.promise; }
    return prResponse(url.pathname.endsWith('/github') ? prStatus() : prPage());
  }));
  renderWithLocale(<PullRequestWorkspace userId={prUserId} projectId={prProjectId} active canRead onPrincipalMismatch={vi.fn()} />, { locale: 'en' });
  await screen.findByRole('button', { name: '#42 PR 42, Open' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  checking = true; fireEvent.focus(window);
  await waitFor(() => expect(checkingDispatched).toBe(true));
  act(() => pauseAuthRequests());
  await act(async () => { pending.resolve(prResponse(prStatus())); for (let i = 0; i < 20; i++) await Promise.resolve(); });
  act(() => invalidateAuthRequests());
  await screen.findByRole('heading', { name: 'Could not read pull requests. Previously saved data has not been deleted.' });
  expect(screen.queryByRole('button', { name: '#42 PR 42, Open' })).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Pull request status' })).toBeDisabled();
  expect(screen.getByRole('searchbox', { name: 'Search pull request title or number' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Creator: All' })).toBeDisabled();
  checking = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('button', { name: '#42 PR 42, Open' });
});
