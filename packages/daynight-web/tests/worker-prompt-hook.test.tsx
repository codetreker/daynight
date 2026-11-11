import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import * as promptApi from '../src/api/worker-prompts';
import { PROMPT_REQUEST_BYTES, promptSubmissionBytes } from '../src/api/worker-prompts';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { TaskCacheLifecycleChanged } from '../src/features/task-cache/project-cache';
import { ProjectAccessSession } from '../src/features/projects/ProjectAccess';
import { useWorkerPrompt } from '../src/features/worker-prompts/useWorkerPrompt';
import { directAccessFixture } from './helpers/taskSync';

const project = vi.hoisted(() => ({ current: null as null | {
  snapshot: () => { status: string; refreshing: boolean };
  subscribe: (listener: () => void) => () => void;
  waitForFreshAccess: (signal: AbortSignal) => Promise<object | null>;
} }));
vi.mock('../src/features/projects/ProjectAccess', async importOriginal => ({ ...await importOriginal<typeof import('../src/features/projects/ProjectAccess')>(), useProjectAccessSession: () => project.current }));

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

afterEach(() => { project.current = null; for (const instance of scopes.splice(0)) instance.dispose(); invalidateAuthRequests(); vi.restoreAllMocks(); });

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
  it('settles a save started during identity pause without dispatch or replay', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old'))).mockResolvedValueOnce(response(value('2', 'mine')));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('mine'));
    const resume = pauseAuthRequests();
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    await act(async () => saving);
    expect(result.current.pending).toBe(false); expect(result.current.draft).toBe('mine'); expect(result.current.resource?.text).toBe('old'); expect(fetch).toHaveBeenCalledTimes(1);
    resume(); await flush(); expect(result.current.draft).toBe('mine'); expect(result.current.dirty).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('cancels a pre-dispatch save when the user abandons the draft', async () => {
    const gate = deferred<object | null>(); let calls = 0;
    project.current = { snapshot: () => ({ status: 'ready', refreshing: false }), subscribe: () => () => {}, waitForFreshAccess: async () => ++calls <= 2 ? {} : gate.promise };
    const fetch = vi.fn().mockResolvedValue(response(value('1', 'old', 'project')));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt({ scope: 'project', projectId }, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('mine'));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    expect(result.current.pending).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
    act(() => result.current.abandon());
    await act(async () => saving); gate.resolve({}); await flush();
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
    expect(result.current.pending).toBe(false); expect(result.current.dirty).toBe(false); expect(result.current.draft).toBe('old');
  });
  it('cancels project preparation on pause even if the access check does not settle', async () => {
    const gate = deferred<object | null>(); let calls = 0;
    project.current = { snapshot: () => ({ status: 'ready', refreshing: false }), subscribe: () => () => {}, waitForFreshAccess: async () => ++calls <= 2 ? {} : gate.promise };
    const fetch = vi.fn().mockResolvedValue(response(value('1', 'old', 'project'))); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt({ scope: 'project', projectId }, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('mine'));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    expect(calls).toBe(3); expect(result.current.pending).toBe(true);
    let resume!: () => void; act(() => { resume = pauseAuthRequests(); result.current.edit('newer'); });
    await act(async () => saving); expect(result.current.pending).toBe(false); expect(result.current.draft).toBe('newer');
    gate.resolve({}); await flush(); resume(); await flush(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('settles a dispatched write as unknown during pause without a GET or replay', async () => {
    const put = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old'))).mockImplementationOnce(() => put.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('submitted'));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    let resume!: () => void; act(() => { resume = pauseAuthRequests(); result.current.edit('newer'); });
    await act(async () => saving); await flush();
    expect(result.current.pending).toBe(false); expect(result.current.uncertain).toBe(true);
    expect(result.current.draft).toBe('newer'); expect(result.current.resource?.text).toBe('old');
    act(() => result.current.refresh()); await flush(); expect(fetch).toHaveBeenCalledTimes(2);
    put.resolve(response(value('2', 'submitted'))); await flush();
    expect(result.current.uncertain).toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
    resume(); await flush(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('publishes a confirmed project receipt after admission without erasing a newer draft', async () => {
    const gate = deferred<object | null>(); let calls = 0, resume!: () => void;
    project.current = { snapshot: () => ({ status: 'ready', refreshing: false }), subscribe: () => () => {}, waitForFreshAccess: async () => {
      if (++calls === 4) { resume = pauseAuthRequests(); return gate.promise; } return {};
    } };
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old', 'project'))).mockResolvedValueOnce(response(value('2', 'submitted', 'project')));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt({ scope: 'project', projectId }, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('submitted'));
    await act(async () => result.current.save()); await flush();
    expect(calls).toBe(4); expect(result.current.pending).toBe(false); expect(result.current.write).toBe('confirmed');
    expect(result.current.resource?.text).toBe('old'); act(() => result.current.edit('newer'));
    await act(async () => result.current.save()); expect(fetch).toHaveBeenCalledTimes(2);
    gate.resolve({}); await flush(); expect(result.current.resource?.text).toBe('old');
    resume(); await flush();
    expect(result.current.write).toBe('idle'); expect(result.current.resource?.text).toBe('submitted');
    expect(result.current.draft).toBe('newer'); expect(result.current.dirty).toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('retries a nested project access lifecycle interruption for the confirmed receipt', async () => {
    const instance = scope(), session = new ProjectAccessSession(projectId, instance);
    session.publishMutation(directAccessFixture(projectId, userId)); const cleanup = session.start(false);
    project.current = session;
    const ready = instance.ready.bind(instance); let calls = 0, resume!: () => void;
    vi.spyOn(instance, 'ready').mockImplementation(async signal => {
      if (++calls === 8) { resume = pauseAuthRequests(); throw new TaskCacheLifecycleChanged(); }
      await ready(signal);
    });
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old', 'project'))).mockResolvedValueOnce(response(value('2', 'saved', 'project'))); vi.stubGlobal('fetch', fetch);
    const { result, unmount } = renderHook(() => useWorkerPrompt({ scope: 'project', projectId }, { readEnabled: true }), { wrapper: wrapper(instance) });
    await flush(); act(() => result.current.edit('saved')); await act(async () => result.current.save()); await flush();
    expect(calls).toBeGreaterThanOrEqual(8); expect(result.current.write).toBe('confirmed'); expect(result.current.pending).toBe(false); expect(result.current.resource?.text).toBe('old');
    act(() => result.current.edit('newer')); resume(); await flush();
    expect(result.current.write).toBe('idle'); expect(result.current.resource?.text).toBe('saved'); expect(result.current.draft).toBe('newer'); expect(fetch).toHaveBeenCalledTimes(2);
    unmount(); cleanup();
  });
  it('retains a receipt when pause interrupts its delivery to the save caller', async () => {
    const fetch = vi.fn().mockResolvedValue(response(value('1', 'old'))); vi.stubGlobal('fetch', fetch);
    let resume!: () => void;
    vi.spyOn(promptApi, 'saveWorkerPrompt').mockImplementationOnce(async (_target, _input, _signal, admission) => {
      admission.onDispatch?.();
      const saved = value('2', 'saved'); admission.onReceipt?.(saved);
      resume = pauseAuthRequests();
      return saved;
    });
    const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('saved')); await act(async () => result.current.save()); await flush();
    expect(result.current.write).toBe('confirmed'); expect(result.current.pending).toBe(false); expect(result.current.resource?.text).toBe('old');
    act(() => result.current.edit('newer')); resume(); await flush();
    expect(result.current.write).toBe('idle'); expect(result.current.resource?.text).toBe('saved'); expect(result.current.draft).toBe('newer');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rechecks identity at the final publication boundary', async () => {
    let calls = 0, resume: (() => void) | null = null;
    project.current = { snapshot: () => {
      if (calls === 4 && resume === null) resume = pauseAuthRequests();
      return { status: 'ready', refreshing: false };
    }, subscribe: () => () => {}, waitForFreshAccess: async () => { ++calls; return {}; } };
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old', 'project'))).mockResolvedValueOnce(response(value('2', 'saved', 'project')));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt({ scope: 'project', projectId }, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('saved')); await act(async () => result.current.save()); await flush();
    expect(resume).not.toBeNull(); expect(result.current.write).toBe('confirmed'); expect(result.current.resource?.text).toBe('old');
    act(() => result.current.edit('newer')); (resume as unknown as () => void)(); await flush();
    expect(result.current.resource?.text).toBe('saved'); expect(result.current.draft).toBe('newer'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('retains a verified conflict when pause interrupts its delivery to the caller', async () => {
    const fetch = vi.fn().mockResolvedValue(response(value('1', 'old'))); vi.stubGlobal('fetch', fetch);
    let resume!: () => void;
    vi.spyOn(promptApi, 'saveWorkerPrompt').mockImplementationOnce(async (_target, _input, _signal, admission) => {
      admission.onDispatch?.();
      const conflict = new ApiError('server', 409, 'version_conflict'); admission.onRejection?.(conflict);
      resume = pauseAuthRequests(); throw conflict;
    });
    const { result } = renderHook(() => useWorkerPrompt(target, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('mine')); await act(async () => result.current.save()); await flush();
    expect(result.current.pending).toBe(false); expect(result.current.uncertain).toBe(false); expect(result.current.conflict).toBe(true);
    expect(result.current.draft).toBe('mine'); expect(fetch).toHaveBeenCalledTimes(1); resume();
  });
  it('keeps a verified resource denial across paused saves and visibility changes', async () => {
    const fetch = vi.fn().mockResolvedValue(response(value('1', 'old'))); vi.stubGlobal('fetch', fetch);
    let resume!: () => void;
    vi.spyOn(promptApi, 'saveWorkerPrompt').mockImplementationOnce(async (_target, _input, _signal, admission) => {
      admission.onDispatch?.(); const failure = new ApiError('server', 404, 'not_found'); admission.onRejection?.(failure);
      resume = pauseAuthRequests(); throw failure;
    });
    const { result, rerender } = renderHook(({ enabled }) => useWorkerPrompt(target, { readEnabled: enabled }), { wrapper: wrapper(scope()), initialProps: { enabled: true } });
    await flush(); act(() => result.current.edit('mine')); await act(async () => result.current.save()); await flush();
    act(() => result.current.edit('newer')); await act(async () => result.current.save());
    rerender({ enabled: false }); rerender({ enabled: true }); await flush();
    expect(result.current.resource?.text).toBe('old'); expect(result.current.draft).toBe('newer'); expect(fetch).toHaveBeenCalledTimes(1);
    resume(); await flush(); expect(result.current.unavailable).toBe(true); expect(result.current.resource).toBeNull();
  });
  it('does not clear a draft after a stale project admission denial is superseded', async () => {
    let calls = 0, current = { status: 'ready', refreshing: false }, resume!: () => void;
    const listeners = new Set<() => void>();
    project.current = { snapshot: () => current, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, waitForFreshAccess: async () => {
      if (++calls === 3) { current = { status: 'unavailable', refreshing: false }; resume = pauseAuthRequests(); return null; } return {};
    } };
    const fetch = vi.fn().mockResolvedValue(response(value('1', 'old', 'project'))); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt({ scope: 'project', projectId }, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => { result.current.edit('mine'); result.current.refresh(); }); await flush();
    expect(result.current.draft).toBe('mine');
    act(() => { current = { status: 'ready', refreshing: false }; for (const notify of listeners) notify(); });
    resume(); await flush(); expect(result.current.unavailable).toBe(false); expect(result.current.draft).toBe('mine'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('distinguishes a successful GET from a later superseded access denial', async () => {
    let calls = 0, current = { status: 'ready', refreshing: false }, resume!: () => void;
    const listeners = new Set<() => void>();
    project.current = { snapshot: () => current, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, waitForFreshAccess: async () => {
      if (++calls === 4) { current = { status: 'unavailable', refreshing: false }; resume = pauseAuthRequests(); return null; } return {};
    } };
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old', 'project'))).mockResolvedValueOnce(response(value('2', 'server', 'project'))); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt({ scope: 'project', projectId }, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => { result.current.edit('mine'); result.current.refresh(); }); await flush();
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.current.resource?.text).toBe('old');
    act(() => { current = { status: 'ready', refreshing: false }; for (const notify of listeners) notify(); });
    resume(); await flush(); expect(result.current.unavailable).toBe(false); expect(result.current.draft).toBe('mine');
  });
  it('rechecks identity at the final read publication boundary', async () => {
    let calls = 0, resume: (() => void) | null = null;
    project.current = { snapshot: () => {
      if (calls === 4 && resume === null) resume = pauseAuthRequests();
      return { status: 'ready', refreshing: false };
    }, subscribe: () => () => {}, waitForFreshAccess: async () => { ++calls; return {}; } };
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old', 'project'))).mockResolvedValueOnce(response(value('2', 'server', 'project'))); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt({ scope: 'project', projectId }, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.refresh()); await flush();
    expect(resume).not.toBeNull(); expect(result.current.resource?.text).toBe('old');
    act(() => result.current.edit('newer')); (resume as unknown as () => void)(); await flush();
    expect(result.current.resource?.text).toBe('server'); expect(result.current.draft).toBe('newer');
  });
  it('cancels a confirmed publication when its resource owner changes', async () => {
    const gate = deferred<object | null>(); let calls = 0;
    project.current = { snapshot: () => ({ status: 'ready', refreshing: false }), subscribe: () => () => {}, waitForFreshAccess: async () => ++calls === 4 ? gate.promise : {} };
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old', 'project'))).mockResolvedValueOnce(response(value('2', 'saved', 'project')))
      .mockResolvedValueOnce(response(value('1', 'user')));
    vi.stubGlobal('fetch', fetch);
    const instance = scope();
    const { result, rerender, unmount } = renderHook(({ selected }: { selected: 'project' | 'user' }) => useWorkerPrompt(selected === 'project' ? { scope: 'project', projectId } : target, { readEnabled: true }), { wrapper: wrapper(instance), initialProps: { selected: 'project' } });
    await flush(); act(() => result.current.edit('saved')); await act(async () => result.current.save()); await flush();
    expect(result.current.write).toBe('confirmed');
    rerender({ selected: 'user' }); await flush(); expect(result.current.resource?.text).toBe('user');
    gate.reject(new Error('retired admission')); await flush();
    expect(result.current.resource?.scope).toBe('user'); expect(result.current.draft).toBe('user');
    unmount();
  });
  it.each([true, false])('retains the editor through paused access withdrawal, restored=%s', async restored => {
    const gate = deferred<object | null>(); let calls = 0;
    let current = { status: 'ready', refreshing: false };
    const listeners = new Set<() => void>();
    project.current = { snapshot: () => current, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, waitForFreshAccess: async () => ++calls === 4 ? gate.promise : current.status === 'ready' ? {} : null };
    const fetch = vi.fn().mockResolvedValueOnce(response(value('1', 'old', 'project'))).mockResolvedValueOnce(response(value('2', 'saved', 'project')));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerPrompt({ scope: 'project', projectId }, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); act(() => result.current.edit('saved')); await act(async () => result.current.save()); await flush();
    expect(result.current.write).toBe('confirmed');
    let resume!: () => void;
    act(() => { resume = pauseAuthRequests(); result.current.edit('newer'); current = { status: 'unavailable', refreshing: false }; for (const notify of listeners) notify(); });
    await flush(); expect(result.current.resource?.text).toBe('old'); expect(result.current.draft).toBe('newer'); expect(result.current.write).toBe('confirmed');
    if (restored) act(() => { current = { status: 'ready', refreshing: false }; for (const notify of listeners) notify(); });
    gate.resolve(restored ? {} : null); await flush(); expect(fetch).toHaveBeenCalledTimes(2);
    resume(); await flush();
    if (restored) { expect(result.current.resource?.text).toBe('saved'); expect(result.current.draft).toBe('newer'); }
    else { expect(result.current.unavailable).toBe(true); expect(result.current.resource).toBeNull(); }
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
