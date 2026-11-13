import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { getPullRequestDetail, parsePullRequestDetail } from '../src/features/pull-request-detail/api';

const userId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const at = '2026-11-13T08:00:00Z';
const detail = () => ({ number: '9223372036854775807', id: '9007199254740993', url: 'https://github.com/o/r/pull/42', title: 'Title', author: null, state: 'unknown', draft: false, base: { repositoryId: '4', repositoryFullName: 'o/r', ref: 'main' }, head: { repositoryId: null, repositoryFullName: null, ref: null, sha: 'abc' }, createdAt: at, updatedAt: at, closedAt: null, mergedAt: null, observedAt: at, revision: '9007199254740993', description: '' });
const response = (body: unknown, principal = userId, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe('PR detail API', () => {
  it('retains exact large decimal strings, unknown states, null and empty description', () => {
    const value = detail();
    expect(parsePullRequestDetail(value, value.number)).toEqual(value);
    expect(parsePullRequestDetail({ ...value, description: null }, value.number).description).toBeNull();
  });
  it.each([
    { number: '01' }, { number: 123 }, { id: '9223372036854775808' }, { revision: '-1' },
    { author: { id: '0', login: 'test' } }, { base: { repositoryId: '1', repositoryFullName: 'x', ref: null } },
    { head: { repositoryId: '01', repositoryFullName: null, ref: null, sha: 'a' } },
    { description: 1 }, { createdAt: 'bad' },
  ])('rejects invalid DTO fields %#', value => {
    expect(() => parsePullRequestDetail({ ...detail(), ...value }, detail().number)).toThrow();
  });
  it('binds requested PR number and principal and observes auth pause', async () => {
    const gate = { userId, onPrincipalMismatch: vi.fn() }, fetch = vi.fn().mockResolvedValueOnce(response(detail())).mockResolvedValueOnce(response(detail(), projectId));
    vi.stubGlobal('fetch', fetch);
    const resume = pauseAuthRequests();
    const result = getPullRequestDetail(projectId, detail().number, new AbortController().signal, gate);
    expect(fetch).not.toHaveBeenCalled();
    resume();
    expect(await result).toEqual(detail());
    expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/projects/${projectId}/pull-requests/${detail().number}`);
    await expect(getPullRequestDetail(projectId, detail().number, new AbortController().signal, gate)).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(gate.onPrincipalMismatch).toHaveBeenCalledOnce();
    expect(() => parsePullRequestDetail(detail(), '42')).toThrow();
  });
  it('rejects invalid request numbers before making a request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(getPullRequestDetail(projectId, '01', new AbortController().signal, { userId, onPrincipalMismatch: vi.fn() })).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
