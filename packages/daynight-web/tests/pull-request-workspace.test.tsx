import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PullRequestWorkspace, type PullRequestWorkspaceProps } from '../src/features/pull-requests/PullRequestWorkspace';
import type { GitHubStatus, PullRequestPage, PullRequestSummary } from '../src/features/pull-requests/api';
import { renderWithLocale } from './helpers/renderWithLocale';

const userId = '6153d2b9-82b1-4589-9107-8f6fc78b5da7', projectId = 'fb1a3e30-f945-4c48-ab0f-55be117e098e';
const time = '2026-11-13T10:00:00Z';
const summary = (number = '123', changes: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  number, id: number, url: `https://github.com/example/repo/pull/${number}`, title: `Preserve ${number}`, author: { id: '42', login: 'author' },
  state: 'open', draft: false, base: { repositoryId: '4', repositoryFullName: 'example/repo', ref: 'main' },
  head: { repositoryId: '8', repositoryFullName: 'fork/repo', ref: 'feature/full-branch', sha: '1234567890abcdef' },
  createdAt: time, updatedAt: time, observedAt: time, closedAt: null, mergedAt: null, revision: '4', ...changes,
});
const status = (changes: Partial<GitHubStatus> = {}): GitHubStatus => ({
  projectId, version: '2', revision: '4', serviceAvailable: true, syncEnabled: true, connection: 'connected', repository: { id: '4', fullName: 'example/repo', private: true },
  installation: { id: '12', accountLogin: 'owner' }, pollIntervalMinutes: 5, initializing: false,
  poll: { running: false, lastAttemptAt: time, lastSuccessAt: time, nextAttemptAt: time, error: null },
  webhook: { running: false, lastReceivedAt: time, lastAttemptAt: time, lastSuccessAt: time, error: null }, ...changes,
});
const page = (items: readonly PullRequestSummary[], changes: Partial<PullRequestPage> = {}): PullRequestPage => ({
  projectId, revision: '4', items, total: String(items.length), counts: { active: String(items.length), merged: '0', closed: '0', all: String(items.length) }, nextCursor: null, previousCursor: null, ...changes,
});
const options = (changes: Partial<PullRequestWorkspaceProps> = {}): PullRequestWorkspaceProps => ({ userId, projectId, active: true, canRead: true, onPrincipalMismatch: vi.fn(), ...changes });
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
const mockReads = (read: (url: URL) => unknown | Promise<unknown>) => {
  const fetch = vi.fn(async (input: string) => response(await read(new URL(input, 'https://daynight.cc'))));
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

describe('pull request workspace', () => {
  it('renders summaries, Draft, missing metadata, filters and full cursor pagination', async () => {
    const records = [summary('123', { draft: true }), summary('122', { author: null, head: { repositoryId: null, repositoryFullName: null, ref: null, sha: 'a' } })];
    const requests: URL[] = [];
    mockReads(url => {
      requests.push(url);
      if (url.pathname.endsWith('/github')) return status();
      if (url.searchParams.get('cursor') === 'second-page') return page([summary('117', { state: 'merged' })], { total: '7', previousCursor: 'first-page' });
      if (url.searchParams.get('q')) return page([]);
      return page(records, { total: '7', nextCursor: 'second-page', counts: { active: '7', merged: '2', closed: '1', all: '10' } });
    });
    renderWithLocale(<PullRequestWorkspace {...options()} />, { locale: 'en' });
    expect(await screen.findByRole('button', { name: '#123 Preserve 123, Draft' })).toBeVisible();
    expect(screen.getByText('Author unavailable')).toBeVisible();
    expect(screen.getByText('Source repository or branch unavailable')).toBeVisible();
    expect(screen.getByText('fork/repo:feature/full-branch')).toBeVisible();
    expect(screen.getByRole('option', { name: 'Active · 7' })).toBeInTheDocument();
    expect(screen.getByText('Includes Draft · 7 pull requests')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('button', { name: '#117 Preserve 117, Merged' })).toBeVisible();
    expect(screen.getByText('Page 2 of 2')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByRole('button', { name: '#123 Preserve 123, Draft' })).toBeVisible();
    fireEvent.change(screen.getByRole('combobox', { name: 'Pull request status' }), { target: { value: 'all' } });
    await waitFor(() => expect(requests.some(url => url.searchParams.get('state') === 'all')).toBe(true));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '#999' } });
    expect(await screen.findByRole('heading', { name: 'No matching pull requests' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByRole('button', { name: '#123 Preserve 123, Draft' })).toBeVisible();
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(requests.filter(url => url.pathname.endsWith('/pull-requests')).every(url => url.searchParams.get('limit') === '6')).toBe(true);
  });

  it('keeps Next available on an empty earlier page when only its return cursor remains', async () => {
    const cursor = (anchorNumber: string, direction: 'next' | 'previous') => btoa(JSON.stringify({ v: 1, projectId, state: 'active', q: '', limit: 6, upperNumber: '12', anchorNumber, direction })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const next = cursor('7', 'next'), previous = cursor('6', 'previous');
    const later = Array.from({ length: 6 }, (_, index) => summary(String(6 - index)));
    let earlierRemoved = false;
    mockReads(url => {
      if (url.pathname.endsWith('/github')) return status();
      const requested = url.searchParams.get('cursor');
      const counts = { active: earlierRemoved ? '6' : '12', merged: '0', closed: '0', all: earlierRemoved ? '6' : '12' };
      if (requested === previous) return page([], { revision: '5', total: '6', counts, nextCursor: next });
      if (requested === next) return page(later, { revision: earlierRemoved ? '5' : '4', total: earlierRemoved ? '6' : '12', counts, previousCursor: earlierRemoved ? null : previous });
      return earlierRemoved ? page(later, { revision: '5' }) : page(Array.from({ length: 6 }, (_, index) => summary(String(12 - index))), { total: '12', counts, nextCursor: next });
    });
    renderWithLocale(<PullRequestWorkspace {...options()} />, { locale: 'en' });
    await screen.findByRole('button', { name: '#12 Preserve 12, Open' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('button', { name: '#6 Preserve 6, Open' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled());
    earlierRemoved = true;
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByRole('heading', { name: 'No saved pull requests in this view' });
    expect(screen.getByText('Page 1 of 1')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    fireEvent.focus(window);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('button', { name: '#6 Preserve 6, Open' });
    expect(screen.getAllByRole('button', { name: /^#[1-6] Preserve/ })).toHaveLength(6);
  });

  it.each(['not_connected', 'initializing', 'empty', 'disconnected', 'unavailable', 'service-unavailable', 'errors'] as const)('presents the %s state without inventing unknown zero counts', async scene => {
    const syncError = { code: 'network', message: 'safe diagnostic', at: time };
    const base = status();
    const state = status({
      connection: scene === 'not_connected' ? 'not_connected' : scene === 'disconnected' ? 'disconnected' : scene === 'unavailable' ? 'unavailable' : 'connected',
      initializing: scene === 'initializing', serviceAvailable: scene !== 'service-unavailable',
      poll: { ...base.poll, lastSuccessAt: scene === 'not_connected' || scene === 'initializing' ? null : time, error: scene === 'errors' ? syncError : null },
      webhook: { ...base.webhook, error: scene === 'errors' ? syncError : null },
    });
    mockReads(url => url.pathname.endsWith('/github') ? state : page([]));
    renderWithLocale(<PullRequestWorkspace {...options()} />, { locale: 'en' });
    const heading = scene === 'not_connected' ? 'GitHub is not connected' : scene === 'initializing' ? 'Initial synchronization in progress' : 'No pull requests';
    expect(await screen.findByRole('heading', { name: heading })).toBeVisible();
    if (scene === 'not_connected' || scene === 'initializing') expect(screen.getByRole('option', { name: 'Active' })).toBeInTheDocument();
    else expect(screen.getByRole('option', { name: 'Active · 0' })).toBeInTheDocument();
    if (scene === 'errors') {
      expect(screen.getByText(/Polling temporarily failed/)).toBeVisible();
      expect(screen.getByText(/Webhook processing temporarily failed/)).toBeVisible();
    }
    if (scene === 'unavailable') expect(screen.getByText(/GitHub access is unavailable/)).toBeVisible();
    if (scene === 'disconnected') expect(screen.getByText(/GitHub is disconnected/)).toBeVisible();
    if (scene === 'service-unavailable') expect(screen.getByText(/not configured on this service/)).toBeVisible();
  });

  it.each([
    ['off and service unavailable', { syncEnabled: false, serviceAvailable: false }, 'Sync is off', false],
    ['off and unavailable', { syncEnabled: false, connection: 'unavailable' }, 'Sync is off', false],
    ['off and disconnected', { syncEnabled: false, connection: 'disconnected' }, 'Sync is off', false],
    ['off and initializing', { syncEnabled: false, initializing: true }, 'Sync is off', false],
    ['service unavailable and unavailable', { serviceAvailable: false, connection: 'unavailable', initializing: true }, 'GitHub integration is not configured', false],
    ['unavailable and initializing', { connection: 'unavailable', initializing: true }, 'GitHub access is unavailable', true],
    ['disconnected and initializing', { connection: 'disconnected', initializing: true }, 'GitHub is disconnected', false],
    ['initializing', { initializing: true }, 'Initial synchronization is in progress', false],
    ['healthy', {}, null, false],
    ['not connected', { connection: 'not_connected', initializing: true }, null, false],
  ] satisfies readonly [string, Partial<GitHubStatus>, string | null, boolean][])('selects one primary notice for %s', async (_scene, changes, expected, danger) => {
    mockReads(url => url.pathname.endsWith('/github') ? status(changes) : page([summary()]));
    const { container } = renderWithLocale(<PullRequestWorkspace {...options()} />, { locale: 'en' });
    await screen.findByRole('button', { name: '#123 Preserve 123, Open' });
    await screen.findByText(/Last complete sync/);
    await waitFor(() => {
      const notices = container.querySelectorAll('.pr-sync-status .pr-status-note');
      expect(notices).toHaveLength(expected === null ? 0 : 1);
      if (expected !== null) {
        expect(notices[0]).toHaveTextContent(expected);
        expect(notices[0]).toHaveAttribute('role', 'status');
        expect(notices[0]).toHaveClass('pr-status-note');
        expect(notices[0]?.classList.contains('danger')).toBe(danger);
        expect(within(notices[0] as HTMLElement).getAllByRole('link', { name: 'View sync settings' })).toHaveLength(1);
      }
    });
  });

  it('keeps independent historical diagnostics alongside the single primary notice', async () => {
    const error = { code: 'network', message: 'safe diagnostic', at: time }, base = status();
    mockReads(url => url.pathname.endsWith('/github') ? status({ syncEnabled: false, serviceAvailable: false, connection: 'unavailable', poll: { ...base.poll, error }, webhook: { ...base.webhook, error } }) : page([summary()]));
    renderWithLocale(<PullRequestWorkspace {...options()} />, { locale: 'en' });
    expect(await screen.findByText(/Sync is off/)).toBeVisible();
    expect(screen.getByText(/The last polling attempt failed/)).toBeVisible();
    expect(screen.getByText(/The last webhook update failed/)).toBeVisible();
    expect(screen.queryByText(/GitHub integration is not configured/)).toBeNull();
    expect(screen.queryByText(/GitHub access is unavailable/)).toBeNull();
  });

  it('shows no primary notice before status has been read', async () => {
    const pending = new Promise<GitHubStatus>(() => {});
    mockReads(url => url.pathname.endsWith('/github') ? pending : page([summary()]));
    const { container } = renderWithLocale(<PullRequestWorkspace {...options()} />, { locale: 'en' });
    await screen.findByRole('button', { name: '#123 Preserve 123, Open' });
    expect(container.querySelector('.pr-sync-status .pr-status-note')).toBeNull();
  });

  it('keeps saved records during list failure, retries status separately, and retains the return cursor on an empty page', async () => {
    let failed = false;
    const fetch = mockReads(url => {
      if (failed) throw new TypeError('network');
      return url.pathname.endsWith('/github') ? status() : url.searchParams.get('cursor') === 'second-page'
        ? page([summary('117')], { total: '7', previousCursor: 'first-page' })
        : page([summary()], { total: '7', nextCursor: 'second-page' });
    });
    renderWithLocale(<PullRequestWorkspace {...options()} />, { locale: 'en' });
    await screen.findByRole('button', { name: '#123 Preserve 123, Open' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('button', { name: '#117 Preserve 117, Open' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    failed = true;
    fireEvent.focus(window);
    expect(await screen.findByText('Could not read pull requests. Previously saved data has not been deleted.')).toBeVisible();
    expect(screen.getByRole('button', { name: '#117 Preserve 117, Open' })).toBeVisible();
    expect(screen.getByText('Could not read synchronization status.')).toBeVisible();
    failed = false;
    fetch.mockImplementation(async (input: string) => response(input.endsWith('/github') ? status() : page([], { previousCursor: 'first-page' })));
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
    await waitFor(() => expect(screen.queryByText('Could not read synchronization status.')).toBeNull());
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
  });

  it('opens the actual detail, preserves raw selection across reads and tab hiding, then clears on identity revocation', async () => {
    let revision = '4';
    mockReads(url => url.pathname.endsWith('/github') ? status() : url.pathname.endsWith('/123') ? { ...summary(), revision, description: `## Detail ${revision}` } : page([summary()], { revision }));
    const props = options(), view = renderWithLocale(<PullRequestWorkspace {...props} />, { locale: 'en' });
    fireEvent.click(await screen.findByRole('button', { name: '#123 Preserve 123, Open' }));
    const dialog = await screen.findByRole('dialog', { name: 'Preserve 123' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Raw Markdown' }));
    view.rerender(<PullRequestWorkspace {...props} active={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    revision = '5';
    view.rerender(<PullRequestWorkspace {...props} />);
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'Raw Markdown' })).toBeChecked());
    await waitFor(() => expect(screen.getByRole('dialog').querySelector('.pr-description-source')).toHaveTextContent('Detail 5'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '#123 Preserve 123, Open' }));
    await screen.findByRole('dialog');
    act(() => view.rerender(<PullRequestWorkspace {...props} canRead={false} />));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Pull request status' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '#123 Preserve 123, Open' })).toBeNull();
  });

  it('retains the open detail and search while a background check observes sync being disabled', async () => {
    let enabled = true; const error = { code: 'timeout', message: 'Timeout', at: time };
    const fetch = mockReads(url => url.pathname.endsWith('/github')
      ? status({ syncEnabled: enabled, poll: { ...status().poll, error } })
      : url.pathname.endsWith('/123') ? { ...summary(), description: 'Saved description' } : page([summary()]));
    renderWithLocale(<PullRequestWorkspace {...options()} />, { locale: 'en' });
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'Preserve' } });
    fireEvent.click(await screen.findByRole('button', { name: '#123 Preserve 123, Open' }));
    expect(await screen.findByText('Saved description')).toBeVisible();
    const raw = within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'Raw Markdown' });
    fireEvent.click(raw); enabled = false; fireEvent.focus(window);
    expect(await screen.findByText(/Sync is off/)).toBeVisible();
    expect(screen.getByText(/The last polling attempt failed/)).toBeVisible();
    expect(screen.queryByText(/Polling temporarily failed/)).toBeNull();
    expect(raw).toBeChecked(); expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByRole('searchbox', { hidden: true })).toHaveValue('Preserve');
    expect(fetch.mock.calls.every(([url]) => !String(url).endsWith('/github/sync'))).toBe(true);
  });

  it('announces new records without replacing the current page until explicit refresh', async () => {
    let updated = false;
    mockReads(url => url.pathname.endsWith('/github') ? status() : page([summary(updated && !url.searchParams.has('cursor') ? '124' : '123')], { revision: updated ? '5' : '4' }));
    renderWithLocale(<PullRequestWorkspace {...options()} />, { locale: 'zh-CN' });
    await screen.findByRole('button', { name: '#123 Preserve 123, Open' });
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled());
    updated = true;
    fireEvent.focus(window);
    expect(await screen.findByText('有新的 PR，刷新后可纳入当前列表。')).toBeVisible();
    expect(screen.getByRole('button', { name: '#123 Preserve 123, Open' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '#124 Preserve 124, Open' })).toBeNull();
    await waitFor(() => expect(screen.getAllByRole('button', { name: '刷新' })[0]).toBeEnabled());
    fireEvent.click(screen.getAllByRole('button', { name: '刷新' })[0]!);
    expect(await screen.findByRole('button', { name: '#124 Preserve 124, Open' })).toBeVisible();
    expect(screen.queryByText('有新的 PR，刷新后可纳入当前列表。')).toBeNull();
  });

  it.each([
    ['list', 403], ['status', 404], ['list', 401], ['status', 'principal'],
  ] as const)('withdraws an open detail immediately after %s denial %s while Project access revalidation remains pending', async (source, denial) => {
    let deny = false, details = 0, releaseDetail!: (value: Response) => void;
    const lateDetail = new Promise<Response>(resolve => { releaseDetail = resolve; });
    const onAccessError = vi.fn(), onPrincipalMismatch = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input, 'https://daynight.cc');
      if (url.pathname.endsWith('/123')) {
        details += 1;
        return details === 1 ? response({ ...summary(), description: 'Private description' }) : lateDetail;
      }
      const isStatus = url.pathname.endsWith('/github');
      if (deny && (source === 'status' ? isStatus : !isStatus)) return new Response(JSON.stringify(denial === 'principal' ? status() : { error: { code: 'not_found', message: 'Unavailable', requestId: 'denial' } }), {
        status: denial === 'principal' ? 200 : denial, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': denial === 'principal' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : userId },
      });
      return response(isStatus ? status() : page([summary()]));
    }));
    renderWithLocale(<PullRequestWorkspace {...options({ onAccessError, onPrincipalMismatch })} />, { locale: 'en' });
    fireEvent.click(await screen.findByRole('button', { name: '#123 Preserve 123, Open' }));
    expect(await screen.findByText('Private description')).toBeVisible();
    fireEvent.focus(window);
    await waitFor(() => expect(details).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    deny = true;
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Private description')).toBeNull();
    if (denial === 403 || denial === 404) expect(onAccessError).toHaveBeenCalled();
    if (denial === 'principal') expect(onPrincipalMismatch).toHaveBeenCalled();
    await act(async () => { releaseDetail(response({ ...summary(), revision: '5', description: 'Late private description' })); await lateDetail; });
    expect(screen.queryByText('Late private description')).toBeNull();
    deny = false;
    fireEvent.focus(window);
    await screen.findByRole('button', { name: '#123 Preserve 123, Open' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
