import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { cancelAuthNetworkRequests, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { usePullRequestDetail } from '../src/features/pull-request-detail/usePullRequestDetail';

const userId = '11111111-1111-4111-8111-111111111111';
const otherUser = '33333333-3333-4333-8333-333333333333';
const projectId = '22222222-2222-4222-8222-222222222222';
const at = '2026-11-13T08:00:00Z';
const detail = (revision: string, title = revision, number = '42') => ({ number, id: '123', url: 'https://github.com/o/r/pull/42', title, author: null, state: 'open', draft: false, base: { repositoryId: '4', repositoryFullName: 'o/r', ref: 'main' }, head: { repositoryId: null, repositoryFullName: null, ref: null, sha: 'abc' }, createdAt: at, updatedAt: at, closedAt: null, mergedAt: null, observedAt: at, revision, description: '' });
const response = (body: unknown, status = 200, principal = userId) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
const gate = () => ({ userId, projectId, number: '42', canRead: true, active: true, onPrincipalMismatch: vi.fn(), onAccessError: vi.fn() });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

it('prevents older generations and lower exact revisions from replacing the current detail', async () => {
  const late = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(response(detail('9007199254740993', 'current'))).mockReturnValueOnce(late.promise).mockResolvedValueOnce(response(detail('9007199254740992', 'older')));
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequestDetail(gate()));
  await waitFor(() => expect(result.current.detail?.title).toBe('current'));
  act(() => result.current.refresh());
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.detail?.title).toBe('current');
  await act(async () => { late.resolve(response(detail('9007199254740994', 'obsolete generation'))); await late.promise; });
  expect(result.current.detail?.title).toBe('current');
});

it('cancels and isolates identity changes and access withdrawal without losing data on suspension', async () => {
  const pending = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(response(detail('1', 'first'))).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response(detail('2', 'second'), 200, otherUser));
  vi.stubGlobal('fetch', fetch);
  const original = gate();
  const { result, rerender } = renderHook(props => usePullRequestDetail(props), { initialProps: original });
  await waitFor(() => expect(result.current.detail?.title).toBe('first'));
  act(() => result.current.refresh());
  rerender({ ...original, active: false });
  expect(result.current.detail?.title).toBe('first');
  rerender({ ...original, userId: otherUser });
  expect(result.current.detail).toBeNull();
  await act(async () => { pending.resolve(response(detail('3', 'stale'))); await pending.promise; });
  await waitFor(() => expect(result.current.detail?.title).toBe('second'));
  rerender({ ...original, userId: otherUser, canRead: false });
  expect(result.current.detail).toBeNull();
});

it('retains detail on network failure but clears it on a principal-bound refusal', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(detail('1', 'readable'))).mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(response({ error: { code: 'not_found', message: 'missing', requestId: 'x' } }, 404));
  vi.stubGlobal('fetch', fetch);
  const options = gate();
  const { result } = renderHook(() => usePullRequestDetail(options));
  await waitFor(() => expect(result.current.detail?.title).toBe('readable'));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.error?.kind).toBe('network'));
  expect(result.current.detail?.title).toBe('readable');
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.error?.status).toBe(404));
  expect(result.current.detail).toBeNull();
  expect(options.onAccessError).toHaveBeenCalledOnce();
});

it('recovers after the global identity pause cancels an in-flight request', async () => {
  const initial = deferred<Response>();
  const fetch = vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValueOnce(response(detail('1', 'recovered')));
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequestDetail(gate()));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const resume = pauseAuthRequests();
  cancelAuthNetworkRequests();
  await act(async () => { initial.resolve(response(detail('9', 'old'))); await initial.promise; });
  expect(result.current.detail).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  act(resume);
  await waitFor(() => expect(result.current.detail?.title).toBe('recovered'));
  expect(result.current.loading).toBe(false);
});

it('quarantines detail on principal mismatch and reports the identity change', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(detail('1', 'private'))).mockResolvedValueOnce(response(detail('2', 'other'), 200, otherUser));
  vi.stubGlobal('fetch', fetch);
  const options = gate();
  const { result } = renderHook(() => usePullRequestDetail(options));
  await waitFor(() => expect(result.current.detail?.title).toBe('private'));
  act(() => result.current.refresh());
  await waitFor(() => expect(options.onPrincipalMismatch).toHaveBeenCalledOnce());
  expect(result.current.detail).toBeNull();
  expect(result.current.error?.code).toBe('principal_mismatch');
});

it('does not reissue or retain a result when the account generation changes during a pause', async () => {
  const initial = deferred<Response>();
  const fetch = vi.fn().mockReturnValueOnce(initial.promise);
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequestDetail(gate()));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const resume = pauseAuthRequests();
  cancelAuthNetworkRequests();
  await act(async () => { initial.resolve(response(detail('1', 'old'))); await initial.promise; });
  act(() => { invalidateAuthRequests(); resume(); });
  await waitFor(() => expect(result.current.detail).toBeNull());
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(['principal', 'denial'] as const)('does not publish an old %s while identity is being checked', async kind => {
  let resume!: () => void;
  const fetch = vi.fn().mockResolvedValueOnce(response(detail('1', 'current'))).mockImplementationOnce(async () => {
    resume = pauseAuthRequests();
    return kind === 'principal' ? response(detail('2', 'wrong'), 200, otherUser) : response({ error: { code: 'not_found', message: 'missing', requestId: 'x' } }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  const options = gate();
  const { result } = renderHook(() => usePullRequestDetail(options));
  await waitFor(() => expect(result.current.detail?.title).toBe('current'));
  act(() => result.current.refresh());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(options.onPrincipalMismatch).not.toHaveBeenCalled();
  expect(options.onAccessError).not.toHaveBeenCalled();
  expect(result.current.detail?.title).toBe('current');
  act(() => { invalidateAuthRequests(); resume(); });
  await waitFor(() => expect(result.current.detail).toBeNull());
  expect(options.onPrincipalMismatch).not.toHaveBeenCalled();
  expect(options.onAccessError).not.toHaveBeenCalled();
});

it.each([null, 'invalid'])('retains existing detail when a refusal has an invalid principal header: %s', async principal => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (principal !== null) headers['Daynight-User-ID'] = principal;
  const fetch = vi.fn().mockResolvedValueOnce(response(detail('1', 'current'))).mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing', requestId: 'x' } }), { status: 404, headers }),
  );
  vi.stubGlobal('fetch', fetch);
  const options = gate();
  const { result } = renderHook(() => usePullRequestDetail(options));
  await waitFor(() => expect(result.current.detail?.title).toBe('current'));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.error?.kind).toBe('protocol'));
  expect(result.current.detail?.title).toBe('current');
  expect(options.onAccessError).not.toHaveBeenCalled();
  expect(options.onPrincipalMismatch).not.toHaveBeenCalled();
});
