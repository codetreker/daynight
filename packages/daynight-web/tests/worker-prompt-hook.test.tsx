import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertResponsePrincipal, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import * as promptApi from '../src/api/worker-prompts';
import { getWorkerPrompt, PROMPT_REQUEST_BYTES, promptSubmissionBytes } from '../src/api/worker-prompts';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { useWorkerPrompt } from '../src/features/worker-prompts/useWorkerPrompt';

const project = vi.hoisted(() => ({ current: null as null | {
  snapshot: () => { status: string; refreshing: boolean };
  subscribe: (listener: () => void) => () => void;
  waitForFreshAccess: (signal: AbortSignal) => Promise<object | null>;
} }));
vi.mock('../src/features/projects/ProjectAccess', () => ({ useProjectAccessSession: () => project.current }));

const userId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const scopes: TaskCacheScope[] = [];
const scope = () => { const instance = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(instance); return instance; };
const wrapper = (instance: TaskCacheScope) => ({ children }: { readonly children: ReactNode }) => <TaskCacheProvider scope={instance}>{children}</TaskCacheProvider>;
const flush = () => act(async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); });
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
};
const value = (revision: string, text: string, kind: 'user' | 'project' = 'user') => ({ scope: kind, scopeId: kind === 'user' ? userId : projectId, revision, text, updatedAt: revision === '0' ? null : '2026-11-09T10:00:00Z' });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
const error = (status: number, code: string) => response({ error: { code, message: 'safe', requestId: 'test-1' } }, status);
const target = { scope: 'user' } as const;

afterEach(() => { vi.restoreAllMocks(); project.current = null; for (const instance of scopes.splice(0)) instance.dispose(); invalidateAuthRequests(); });

describe('prompt editor lifecycle', () => {
  it('freezes the submission and preserves edits while its PUT is pending', async () => {
    const put = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old'))).mockImplementationOnce(() => put.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('submitted'));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    expect(result.current.pending).toBe(true);
    act(() => result.current.edit('continued'));
    put.resolve(response(value('2', 'submitted'))); await act(async () => saving);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ expectedUserId: userId, revision: '1', text: 'submitted' });
    expect(result.current.draft).toBe('continued'); expect(result.current.baseline?.revision).toBe('2'); expect(result.current.dirty).toBe(true);
  });
  it('admits a valid request exactly at the complete JSON byte limit', async () => {
    const overhead = promptSubmissionBytes({ expectedUserId: userId, revision: '0', text: '' });
    const text = 'a'.repeat(PROMPT_REQUEST_BYTES - overhead);
    const fetch = vi.fn().mockResolvedValueOnce(response(value('0', ''))).mockResolvedValueOnce(response(value('1', text)));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit(text));
    expect(result.current.tooLarge).toBe(false);
    await act(async () => result.current.save());
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.current.baseline?.revision).toBe('1'); expect(result.current.dirty).toBe(false);
  });
  it('keeps a return to the original text dirty through pending and unknown reconciliation', async () => {
    const put = deferred<Response>(), reconciliation = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old')))
      .mockImplementationOnce(() => put.promise).mockImplementationOnce(() => reconciliation.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('submitted'));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    act(() => result.current.edit('old'));
    expect(result.current.pending).toBe(true); expect(result.current.dirty).toBe(true);
    put.reject(new Error('response lost')); await act(async () => saving); await flush();
    expect(result.current.uncertain).toBe(true); expect(result.current.dirty).toBe(true);
    reconciliation.resolve(response(value('2', 'other'))); await flush();
    expect(result.current.draft).toBe('old'); expect(result.current.resource?.text).toBe('other');
    expect(result.current.conflict).toBe(true); expect(result.current.dirty).toBe(true);
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });
  it('retains the draft after a CAS conflict and requires an explicit choice', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old'))).mockResolvedValueOnce(error(409, 'version_conflict'))
      .mockResolvedValueOnce(response(value('2', 'other')));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('mine')); await act(async () => result.current.save()); await flush();
    expect(result.current.conflict).toBe(true); expect(result.current.draft).toBe('mine'); expect(result.current.resource?.text).toBe('other');
    await act(async () => result.current.save()); expect(fetch).toHaveBeenCalledTimes(3);
    act(() => result.current.useLatest()); expect(result.current.draft).toBe('other'); expect(result.current.dirty).toBe(false);
  });
  it('blocks replay while outcome and reconciliation are unknown and resolves only by a GET', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old'))).mockRejectedValueOnce(new Error('lost'))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response(value('2', 'mine')));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('mine')); await act(async () => result.current.save()); await flush();
    expect(result.current.uncertain).toBe(true); expect(result.current.draft).toBe('mine'); expect(result.current.read).toBe('error');
    await act(async () => result.current.save()); expect(fetch).toHaveBeenCalledTimes(3);
    act(() => result.current.refresh()); await flush();
    expect(result.current.uncertain).toBe(false); expect(result.current.reconciled).toBe(true); expect(result.current.draft).toBe('mine');
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });
  it('keeps the existing draft and delays dispatch during background identity admission', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old'))).mockResolvedValueOnce(response(value('2', 'mine')));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('mine'));
    const resume = pauseAuthRequests();
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    expect(result.current.pending).toBe(true); expect(result.current.draft).toBe('mine'); expect(result.current.resource?.text).toBe('old'); expect(fetch).toHaveBeenCalledTimes(1);
    resume(); await act(async () => saving); expect(result.current.draft).toBe('mine'); expect(result.current.dirty).toBe(false);
  });
  it('cancels a pre-dispatch save when the user abandons the draft', async () => {
    const fetch = vi.fn().mockResolvedValue(response(value('1', 'old')));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('mine'));
    const resume = pauseAuthRequests();
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    expect(result.current.pending).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
    act(() => result.current.abandon());
    resume(); await act(async () => saving); await flush();
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
    expect(result.current.pending).toBe(false); expect(result.current.dirty).toBe(false); expect(result.current.draft).toBe('old');
  });
  it('fences a late read when authenticated scope is invalidated', async () => {
    const later = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'private'))).mockImplementationOnce(() => later.promise);
    vi.stubGlobal('fetch', fetch);
    const instance = scope();
    const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(instance) });
    await flush(); act(() => { result.current.edit('private draft'); result.current.refresh(); }); await flush();
    await act(async () => { await instance.invalidateScope(); }); await flush();
    expect(result.current.draft).toBe(''); expect(result.current.resource).toBeNull();
    later.resolve(response(value('2', 'stale private'))); await flush();
    expect(result.current.draft).toBe(''); expect(result.current.resource).toBeNull();
  });
  it('retains the draft and allows retry when project admission fails before dispatch', async () => {
    let current = { status: 'ready', refreshing: false }, allowed: object | null = {};
    project.current = { snapshot: () => current, subscribe: () => () => {}, waitForFreshAccess: async () => allowed };
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old', 'project')))
      .mockResolvedValueOnce(response(value('2', 'mine', 'project')));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt({ scope: 'project', projectId }, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('mine'));
    current = { status: 'error', refreshing: false }; allowed = null;
    await act(async () => result.current.save());
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.current.pending).toBe(false);
    expect(result.current.writeError).toBe('write'); expect(result.current.draft).toBe('mine'); expect(result.current.dirty).toBe(true);
    current = { status: 'ready', refreshing: false }; allowed = {};
    await act(async () => result.current.save());
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[1]![1].method).toBe('PUT');
    expect(result.current.draft).toBe('mine'); expect(result.current.dirty).toBe(false); expect(result.current.writeError).toBeNull();
  });
  it('clears a project draft on revoked access and reloads cleanly after access returns', async () => {
    let current = { status: 'ready', refreshing: false }, allowed: object | null = {};
    const listeners = new Set<() => void>();
    project.current = { snapshot: () => current, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, waitForFreshAccess: async () => allowed };
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'private', 'project')))
      .mockResolvedValueOnce(response(value('2', 'restored', 'project')));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt({ scope: 'project', projectId }, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('draft'));
    current = { status: 'ready', refreshing: true }; allowed = null;
    act(() => result.current.refresh()); await flush();
    expect(result.current.draft).toBe('draft'); expect(result.current.resource?.text).toBe('private'); expect(fetch).toHaveBeenCalledTimes(1);
    current = { status: 'unavailable', refreshing: false };
    act(() => { for (const notify of listeners) notify(); }); await flush();
    expect(result.current.unavailable).toBe(true); expect(result.current.resource).toBeNull(); expect(result.current.draft).toBe('');
    current = { status: 'ready', refreshing: false }; allowed = {};
    act(() => { for (const notify of listeners) notify(); result.current.refresh(); }); await flush();
    expect(result.current.unavailable).toBe(false); expect(result.current.resource?.revision).toBe('2');
    expect(result.current.draft).toBe('restored'); expect(result.current.dirty).toBe(false);
  });
});

describe('prompt identity mismatch settlement', () => {
  it.each(['confirmed', 'conflict', 'unknown'] as const)('settles a dispatched %s without publishing or replaying it', async (outcome) => {
    const put = deferred<Response>(), mismatch = deferred<Response>(); let resume = () => {};
    const instance = createTaskCacheScope({ userId, onIdentityMismatch: () => { resume = pauseAuthRequests(); } }); scopes.push(instance);
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old'))).mockImplementationOnce(() => put.promise).mockImplementationOnce(() => mismatch.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(instance) });
    await flush(); act(() => result.current.edit('submitted'));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    act(() => result.current.edit('continued'));
    const observation = getWorkerPrompt(target, new AbortController().signal, { userId, onPrincipalMismatch: instance.principalMismatch });
    const mismatchResult = expect(observation).rejects.toMatchObject({ code: 'principal_mismatch' });
    const foreground = pauseAuthRequests();
    if (outcome === 'confirmed') put.resolve(response(value('2', 'submitted')));
    else if (outcome === 'conflict') put.resolve(error(409, 'version_conflict'));
    else put.reject(new Error('lost'));
    await flush();
    try {
      mismatch.resolve(new Response(JSON.stringify(value('1', 'other')), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': '99999999-9999-4999-8999-999999999999' } }));
      await act(async () => { await mismatchResult; await saving; });
      expect(result.current.pending).toBe(false); expect(result.current.confirmed).toBe(outcome === 'confirmed');
      expect(result.current.uncertain).toBe(outcome === 'unknown'); expect(result.current.conflict).toBe(outcome === 'conflict');
      expect(result.current.resource?.text).toBe('old'); expect(result.current.baseline?.revision).toBe('1'); expect(result.current.draft).toBe('continued');
      expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
    } finally { foreground(); resume(); }
    await act(async () => result.current.save()); expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });
  it('settles an unanswered dispatched save as unknown when mismatch cancels admission', async () => {
    const put = deferred<Response>(); let resume = () => {};
    const instance = createTaskCacheScope({ userId, onIdentityMismatch: () => { resume = pauseAuthRequests(); } }); scopes.push(instance);
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old'))).mockImplementationOnce(() => put.promise)
      .mockResolvedValueOnce(new Response('{}', { headers: { 'Daynight-User-ID': '99999999-9999-4999-8999-999999999999' } }));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(instance) });
    await flush(); act(() => result.current.edit('mine'));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    try {
      await act(async () => { await expect(getWorkerPrompt(target, new AbortController().signal, { userId, onPrincipalMismatch: instance.principalMismatch })).rejects.toMatchObject({ code: 'principal_mismatch' }); await saving; });
      expect(result.current.pending).toBe(false); expect(result.current.uncertain).toBe(true); expect(result.current.draft).toBe('mine');
      put.resolve(response(value('2', 'mine'))); await flush(); expect(result.current.uncertain).toBe(true);
    } finally { resume(); }
  });
});

it('ends an undispatched prompt save after a retaining owner detects mismatch', async () => {
  let resume = () => {}; const instance = createTaskCacheScope({ userId, onIdentityMismatch: () => { resume = pauseAuthRequests(); } }); scopes.push(instance);
  const mismatch = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old'))).mockImplementationOnce(() => mismatch.promise);
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(instance) });
  await flush(); act(() => result.current.edit('mine'));
  const observation = getWorkerPrompt(target, new AbortController().signal, { userId, onPrincipalMismatch: instance.principalMismatch });
  const mismatchResult = expect(observation).rejects.toMatchObject({ code: 'principal_mismatch' });
  const foreground = pauseAuthRequests(); let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
  expect(result.current.pending).toBe(true);
  try {
    mismatch.resolve(new Response('{}', { headers: { 'Daynight-User-ID': '99999999-9999-4999-8999-999999999999' } }));
    await act(async () => { await mismatchResult; await saving; });
    expect(result.current.pending).toBe(false); expect(result.current.uncertain).toBe(false); expect(result.current.draft).toBe('mine');
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
  } finally { foreground(); resume(); }
});


it.each(['confirmed', 'conflict'] as const)('retains a verified %s even if mismatch arrives before promise settlement', async outcome => {
  const put = deferred<Response>(); let resume = () => {};
  const instance = createTaskCacheScope({ userId, onIdentityMismatch: () => { resume = pauseAuthRequests(); } }); scopes.push(instance);
  const mismatchResponse = new Response('{}', { headers: { 'Daynight-User-ID': '99999999-9999-4999-8999-999999999999' } });
  const trigger = () => { try { assertResponsePrincipal(mismatchResponse, userId, instance.principalMismatch); } catch { /* The other response is rejected. */ } };
  const save = promptApi.saveWorkerPrompt;
  vi.spyOn(promptApi, 'saveWorkerPrompt').mockImplementation((target, submission, signal, admission) => save(target, submission, signal, {
    ...admission, onConfirmed: receipt => { admission.onConfirmed?.(receipt); trigger(); },
    onRejected: error => { admission.onRejected?.(error); trigger(); },
  }));
  const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old'))).mockImplementationOnce(() => put.promise); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(instance) });
  await flush(); act(() => result.current.edit('mine'));
  let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
  try {
    put.resolve(outcome === 'confirmed' ? response(value('2', 'mine')) : error(409, 'version_conflict'));
    await act(async () => saving);
    expect(result.current.pending).toBe(false); expect(result.current.confirmed).toBe(outcome === 'confirmed');
    expect(result.current.conflict).toBe(outcome === 'conflict'); expect(result.current.uncertain).toBe(false);
    expect(result.current.resource?.text).toBe('old'); expect(result.current.draft).toBe('mine');
  } finally { resume(); }
});
