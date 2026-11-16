import { afterEach, expect, it, vi } from 'vitest';
import { invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { getGitHubStatus, getPullRequests, parseGitHubStatus, parsePullRequestPage } from '../src/features/pull-requests/api';
import { prPage, prProjectId, prResponse, prStatus, prUserId } from './pull-requests-fixtures';

afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });
const admission = () => ({ userId: prUserId, onPrincipalMismatch: vi.fn() });

it('retains exact counts and summaries without requesting or retaining descriptions', () => {
  const page = { ...prPage(['9007199254740993']), total: '9007199254740993', revision: '9007199254740993' };
  expect(parsePullRequestPage(page, prProjectId)).toEqual(page);
  const extra = { ...page, items: [{ ...page.items[0], description: 'not a summary field' }] };
  expect(parsePullRequestPage(extra, prProjectId).items[0]).not.toHaveProperty('description');
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
