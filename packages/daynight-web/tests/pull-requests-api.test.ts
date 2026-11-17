import { afterEach, expect, it, vi } from 'vitest';
import { invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { comparePullRequestAuthors, getGitHubStatus, getPullRequestAuthors, getPullRequests, parseGitHubStatus, parsePullRequestAuthorsPage, parsePullRequestPage } from '../src/features/pull-requests/api';
import { prPage, prProjectId, prResponse, prStatus, prUserId } from './pull-requests-fixtures';

afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });
const admission = () => ({ userId: prUserId, onPrincipalMismatch: vi.fn() });

it('retains exact counts and summaries without requesting or retaining descriptions', () => {
  const page = { ...prPage(['9007199254740993']), total: '9007199254740993', revision: '9007199254740993' };
  expect(parsePullRequestPage(page, prProjectId)).toEqual({ ...page, authorId: null, projectTotal: page.counts.all });
  const extra = { ...page, items: [{ ...page.items[0], description: 'not a summary field' }] };
  expect(parsePullRequestPage(extra, prProjectId).items[0]).not.toHaveProperty('description');
});

it('binds author pages to the exact account and requires the independent project total', () => {
  const authorId = '9007199254740997';
  const page = { ...prPage(), authorId, projectTotal: '9007199254740998', items: [{ ...prPage().items[0], author: { id: authorId, login: 'example' } }] };
  expect(parsePullRequestPage(page, prProjectId, authorId)).toEqual(page);
  expect(() => parsePullRequestPage({ ...page, authorId: '4' }, prProjectId, authorId)).toThrow();
  expect(() => parsePullRequestPage({ ...page, authorId: undefined }, prProjectId, authorId)).toThrow();
  expect(() => parsePullRequestPage({ ...page, projectTotal: undefined }, prProjectId, authorId)).toThrow();
  expect(() => parsePullRequestPage({ ...page, projectTotal: '01' }, prProjectId, authorId)).toThrow();
  expect(() => parsePullRequestPage({ ...page, items: prPage().items }, prProjectId, authorId)).toThrow();
});

it('validates bounded directory pages with PostgreSQL C ordering and exact account IDs', () => {
  const page = { projectId: prProjectId, revision: '9007199254740997', items: [
    { id: '2', login: 'ALICE', loginAmbiguous: true },
    { id: '9007199254740997', login: 'alice', loginAmbiguous: true },
    { id: '3', login: 'é', loginAmbiguous: false },
  ], nextCursor: 'next' };
  expect(parsePullRequestAuthorsPage(page, prProjectId)).toEqual(page);
  expect(comparePullRequestAuthors(page.items[1]!, page.items[2]!)).toBeLessThan(0);
  expect(() => parsePullRequestAuthorsPage({ ...page, projectId: prUserId }, prProjectId)).toThrow();
  expect(() => parsePullRequestAuthorsPage({ ...page, items: [...page.items].reverse() }, prProjectId)).toThrow();
  expect(() => parsePullRequestAuthorsPage({ ...page, items: [page.items[0], { ...page.items[2], id: '2' }] }, prProjectId)).toThrow();
  expect(() => parsePullRequestAuthorsPage({ ...page, items: [{ ...page.items[0], loginAmbiguous: null }] }, prProjectId)).toThrow();
  expect(() => parsePullRequestAuthorsPage({ ...page, items: [{ ...page.items[0], id: '9223372036854775808' }] }, prProjectId)).toThrow();
  expect(() => parsePullRequestAuthorsPage({ ...page, items: [], nextCursor: 'next' }, prProjectId)).toThrow();
  expect(() => parsePullRequestAuthorsPage({ ...page, items: Array.from({ length: 51 }, (_, i) => ({ id: String(i + 1), login: 'a', loginAmbiguous: true })) }, prProjectId)).toThrow();
});

it('sends an author-bound list and an independently searched directory', async () => {
  const authorId = '9007199254740997';
  const page = { ...prPage([]), authorId, projectTotal: '9' };
  const directory = { projectId: prProjectId, revision: '7', items: [], nextCursor: null };
  const fetch = vi.fn().mockResolvedValueOnce(prResponse(page)).mockResolvedValueOnce(prResponse(directory)); vi.stubGlobal('fetch', fetch);
  await getPullRequests(prProjectId, { state: 'merged', q: 'feature', cursor: 'next', authorId }, new AbortController().signal, admission());
  await getPullRequestAuthors(prProjectId, { q: 'bot 中', cursor: 'authors-next' }, new AbortController().signal, admission());
  const listUrl = new URL(fetch.mock.calls[0]![0] as string, 'https://daynight.test');
  expect(Object.fromEntries(listUrl.searchParams)).toEqual({ state: 'merged', q: 'feature', limit: '6', cursor: 'next', authorId });
  const authorsUrl = new URL(fetch.mock.calls[1]![0] as string, 'https://daynight.test');
  expect(authorsUrl.pathname).toBe(`/api/v1/projects/${prProjectId}/pull-request-authors`);
  expect(Object.fromEntries(authorsUrl.searchParams)).toEqual({ q: 'bot 中', limit: '50', cursor: 'authors-next' });
  expect(() => getPullRequests(prProjectId, { state: 'all', q: '', cursor: null, authorId: '01' }, new AbortController().signal, admission())).toThrow();
  expect(() => getPullRequestAuthors(prProjectId, { q: '中'.repeat(342), cursor: null }, new AbortController().signal, admission())).toThrow();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  { total: '01' }, { revision: 1 }, { projectId: prUserId }, { counts: { active: '0', closed: '0', merged: '0', all: '-1' } },
  { items: prPage(['1', '2']).items }, { items: prPage(['2', '2']).items }, { items: prPage(['7', '6', '5', '4', '3', '2', '1']).items },
  { nextCursor: '' }, { previousCursor: undefined }, { items: [{ ...prPage().items[0], id: '0' }] },
])('rejects malformed, unordered and cross-project pages %#', changed => {
  expect(() => parsePullRequestPage({ ...prPage(), ...changed }, prProjectId)).toThrow();
});

it('parses independent sync state including unavailable installations and nullable timestamps', () => {
  expect(parseGitHubStatus(prStatus(), prProjectId)).toEqual(prStatus());
  const status = { ...prStatus(), repository: null, installation: null, connection: 'not_connected', initializing: true, poll: { ...prStatus().poll, error: { code: 'offline', message: 'Temporary failure', at: null } } };
  expect(parseGitHubStatus(status, prProjectId)).toEqual(status);
});

it.each([{ syncEnabled: undefined }, { syncEnabled: null }, { syncEnabled: 'false' }, { connection: 'bad' }, { version: '0' }, { pollIntervalMinutes: 0 }, { pollIntervalMinutes: 2_147_483_648 }, { initializing: null }, { repository: { id: '4', fullName: 'o/r' } }, { poll: { ...prStatus().poll, lastSuccessAt: 'bad' } }])('rejects malformed status fields %#', changed => {
  expect(() => parseGitHubStatus({ ...prStatus(), ...changed }, prProjectId)).toThrow();
});

it('sends real state/query/cursor reads with six summaries and principal admission', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(prResponse(prPage())).mockResolvedValueOnce(prResponse(prStatus())); vi.stubGlobal('fetch', fetch);
  const resume = pauseAuthRequests();
  const pending = getPullRequests(prProjectId, { state: 'all', q: '#中文_%', cursor: 'next-token' }, new AbortController().signal, admission());
  expect(fetch).not.toHaveBeenCalled(); resume(); await pending;
  const url = new URL(fetch.mock.calls[0]![0] as string, 'https://daynight.test');
  expect(url.pathname).toBe(`/api/v1/projects/${prProjectId}/pull-requests`);
  expect(Object.fromEntries(url.searchParams)).toEqual({ state: 'all', q: '#中文_%', limit: '6', cursor: 'next-token' });
  await getGitHubStatus(prProjectId, new AbortController().signal, admission());
  expect(fetch.mock.calls[1]![0]).toBe(`/api/v1/projects/${prProjectId}/github`);
});

it('refuses oversized UTF-8 search and invalid scope before dispatch and rejects principal mismatch', async () => {
  const fetch = vi.fn().mockResolvedValue(prResponse(prPage(), 200, prProjectId)); vi.stubGlobal('fetch', fetch);
  expect(() => getPullRequests(prProjectId, { state: 'active', q: '中'.repeat(342), cursor: null }, new AbortController().signal, admission())).toThrow();
  expect(() => getPullRequests(prProjectId, { state: 'active', q: '', cursor: '' }, new AbortController().signal, admission())).toThrow();
  expect(fetch).not.toHaveBeenCalled();
  const gate = admission(); await expect(getPullRequests(prProjectId, { state: 'active', q: '', cursor: null }, new AbortController().signal, gate)).rejects.toMatchObject({ code: 'principal_mismatch' });
  expect(gate.onPrincipalMismatch).toHaveBeenCalledOnce();
});
