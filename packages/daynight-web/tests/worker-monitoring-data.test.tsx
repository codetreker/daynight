import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import type { CacheEvent } from '../src/features/task-cache/project-cache';
import { monitoringSummaryAge, useWorkerMonitoring, useWorkerMonitoringSummaries } from '../src/features/workers/useWorkerMonitoring';
import { WORKER_TIME, WORKER_USER, workerError, workerId, workerResponse } from './helpers/workers';

let monotonic = 0, visible: DocumentVisibilityState = 'visible';
const scopes: TaskCacheScope[] = [];
const scope = () => { const result = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: vi.fn() }); vi.spyOn(result, 'prepareProjection').mockResolvedValue(new Map()); scopes.push(result); return result; };
const wrapper = (value: TaskCacheScope) => ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={value}>{children}</TaskCacheProvider>;
const flush = () => act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); });
const advance = async (ms: number) => { monotonic += ms; await act(async () => { vi.advanceTimersByTime(ms); for (let i = 0; i < 40; i++) await Promise.resolve(); }); };
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const time = '2026-10-29T12:00:00Z';
const detail = () => ({ observedAt: time, state: 'available', revision: workerId(10), runId: workerId(11), sequence: '1', receivedAt: time, expiresAt: '2026-10-29T13:00:00Z', detailCoverage: 'complete', permissionProjection: 'current', data: {
  runId: workerId(11), sequence: '1', capturedAt: time, lifecycle: 'running', scheduler: { phase: 'waiting-poll', coverage: 'complete', cycleId: null, lastCompletedAt: null, lastSuccessfulAt: null, lastOutcome: null, nextPollAt: null },
  capacity: { observedAt: time, quality: 'current', limit: 2, occupied: 2, available: 0, detailCoverage: 'complete' },
  admission: { observedAt: time, coverage: 'complete', reasons: [{ code: 'cleanup-capacity-blocked', scope: { kind: 'worker' }, observedAt: time, nextAttemptAt: null, association: null }] },
  reservations: [], activities: [{ kind: 'execution', phase: 'executing', operationId: workerId(20), status: 'running', scope: { kind: 'claim', projectId: workerId(30), taskId: workerId(31), claimId: workerId(32) }, startedAt: time, lastProgressAt: time, elapsedMs: 1, deadlineAt: null, waitReason: null, nextAttemptAt: null, association: { kind: 'task', projectName: 'Private project', title: 'Private task' } }],
  currentFailures: [], lastRecovery: null, detailCoverage: 'complete', delivery: { lastSucceededAt: null, lastFailure: null },
} });
const absent = (workerId: string) => ({ workerId, state: 'absent', revision: null, receivedAt: null, expiresAt: null, summary: null });
const absentDetail = (observedAt: string) => ({ observedAt, state: 'absent', revision: null, runId: null, sequence: null, receivedAt: null, expiresAt: null, data: null, detailCoverage: 'complete', permissionProjection: 'current' });
beforeEach(() => { monotonic = 0; visible = 'visible'; vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }); vi.spyOn(performance, 'now').mockImplementation(() => monotonic); vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible); });
afterEach(() => { for (const s of scopes.splice(0)) s.dispose(); invalidateAuthRequests(); vi.useRealTimers(); });

describe('Worker monitoring reads', () => {
  it('batches loaded IDs in request order and uses each Redis observation clock', async () => {
    const ids = Array.from({ length: 101 }, (_, index) => workerId(index + 1));
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const requested = (JSON.parse(String(init.body)) as { workerIds: string[] }).workerIds;
      const at = requested.length === 100 ? WORKER_TIME : '2026-10-29T12:00:01Z';
      return workerResponse({ observedAt: at, items: requested.map(absent) });
    }); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerMonitoringSummaries(ids, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)).workerIds.length)).toEqual([100, 1]);
    expect(result.current.snapshot?.items.map(entry => entry.item.workerId)).toEqual(ids);
    expect(result.current.snapshot?.items[0]?.observedAt).toBe(WORKER_TIME);
    expect(result.current.snapshot?.items[100]?.observedAt).toBe('2026-10-29T12:00:01Z');
    expect(monitoringSummaryAge(result.current.snapshot!.items[0]!, monotonic)).toBeNull();
    await advance(29_999); expect(fetch).toHaveBeenCalledTimes(2);
    await advance(1); expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('advances Redis age through failed reads and visibility changes without exposing a false zero', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(detail())).mockResolvedValue(workerError(503)); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerMonitoring(workerId(1), { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); expect(result.current.snapshot?.state).toBe('available');
    await advance(30_000); expect(result.current.error).not.toBeNull(); expect(result.current.snapshot?.state).toBe('available');
    await advance(60_000); expect(result.current.serverMilliseconds! - Date.parse(time)).toBe(90_000);
    visible = 'hidden'; act(() => document.dispatchEvent(new Event('visibilitychange')));
    const calls = fetch.mock.calls.length; await advance(3_510_000); expect(fetch).toHaveBeenCalledTimes(calls);
    visible = 'visible'; act(() => document.dispatchEvent(new Event('visibilitychange'))); await flush();
    expect(result.current.serverMilliseconds! - Date.parse(time)).toBe(3_600_000);
    await advance(1_000);
    expect(result.current.serverMilliseconds! - Date.parse(time)).toBe(3_601_000);
  });
  it('resumes at the 90-second boundary and schedules failed retries from the latest read', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(detail())).mockResolvedValue(workerError(503)); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerMonitoring(workerId(1), { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); await advance(89_999);
    visible = 'hidden'; act(() => document.dispatchEvent(new Event('visibilitychange'))); await advance(1);
    const before = fetch.mock.calls.length;
    visible = 'visible'; act(() => document.dispatchEvent(new Event('visibilitychange'))); await flush();
    expect(result.current.serverMilliseconds! - Date.parse(time)).toBe(90_000);
    expect(fetch).toHaveBeenCalledTimes(before + 1);
    await advance(29_999); expect(fetch).toHaveBeenCalledTimes(before + 1);
    act(() => result.current.refresh()); await flush(); expect(fetch).toHaveBeenCalledTimes(before + 2);
    await advance(29_999); expect(fetch).toHaveBeenCalledTimes(before + 2);
    await advance(1); expect(fetch).toHaveBeenCalledTimes(before + 3);
  });
  it('distinguishes confirmed expiry from initial and early absence without guessing from a later clock', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(absentDetail(time))).mockResolvedValueOnce(workerResponse(detail()))
      .mockResolvedValueOnce(workerResponse(absentDetail('2026-10-29T12:59:59.999Z')))
      .mockResolvedValueOnce(workerResponse(absentDetail('2026-10-29T13:00:01Z')))
      .mockResolvedValueOnce(workerResponse(detail())).mockResolvedValueOnce(workerResponse(absentDetail('2026-10-29T13:00:00Z')));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerMonitoring(workerId(1), { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); expect(result.current.expired).toBe(false);
    for (let n = 0; n < 4; n++) { act(() => result.current.refresh()); await flush(); expect(result.current.expired).toBe(false); }
    act(() => result.current.refresh()); await flush(); expect(result.current.snapshot?.state).toBe('absent'); expect(result.current.expired).toBe(true);
  });
  it('classifies absent summaries using each response Redis time and the previously observed expiry', async () => {
    const ids = [workerId(1), workerId(2)];
    const available = (workerId: string) => ({ workerId, state: 'available', revision: workerId, receivedAt: time, expiresAt: '2026-10-29T13:00:00Z', summary: { capturedAt: time, lifecycle: 'running', scheduler: { phase: 'waiting-poll', coverage: 'complete', lastSuccessfulAt: null, nextPollAt: null }, capacity: null, detailCoverage: 'complete', admission: { observedAt: time, coverage: 'complete', reasonCodes: ['no-ready-tasks'], permissionProjection: 'current' } } });
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse({ observedAt: time, items: ids.map(available) }))
      .mockResolvedValueOnce(workerResponse({ observedAt: '2026-10-29T13:00:00Z', items: ids.map(absent) }));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerMonitoringSummaries(ids, { readEnabled: true }), { wrapper: wrapper(scope()) });
    await flush(); expect(result.current.snapshot?.items.map(entry => entry.expired)).toEqual([false, false]);
    act(() => result.current.refresh()); await flush(); expect(result.current.snapshot?.items.map(entry => entry.expired)).toEqual([true, true]);
  });
  it('withdraws unscoped reason codes immediately and fences a late batch while retaining total capacity', async () => {
    const currentScope = scope(), project = workerId(30), id = workerId(1), old = deferred<Response>(), fresh = deferred<Response>(); let publish!: (event: CacheEvent) => void;
    vi.spyOn(currentScope, 'subscribeProjection').mockImplementation(listener => { publish = listener; return () => {}; });
    vi.mocked(currentScope.prepareProjection).mockResolvedValue(new Map([[project, 'a']]));
    const batch = (codes: string[], permissionProjection = 'current') => ({ observedAt: time, items: [{ workerId: id, state: 'available', revision: workerId(10), receivedAt: time, expiresAt: '2026-10-29T13:00:00Z', summary: {
      capturedAt: time, lifecycle: 'running', scheduler: { phase: 'waiting-poll', coverage: 'complete', lastSuccessfulAt: null, nextPollAt: null },
      capacity: { observedAt: time, quality: 'current', limit: 2, occupied: 2, available: 0 }, detailCoverage: 'complete',
      admission: { observedAt: time, coverage: 'complete', reasonCodes: codes, permissionProjection },
    } }] });
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(batch(['project-unavailable', 'cleanup-capacity-blocked'])))
      .mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerMonitoringSummaries([id], { readEnabled: true }), { wrapper: wrapper(currentScope) });
    await flush(); act(() => result.current.refresh()); await flush();
    act(() => publish({ projectId: project, accessRevoked: true, revokedGeneration: 'a' })); await flush();
    const withdrawn = result.current.snapshot?.items[0]?.item;
    expect(withdrawn?.state).toBe('available');
    if (withdrawn?.state !== 'available') throw new Error('expected available');
    expect(withdrawn.summary.admission).toBeNull(); expect(withdrawn.summary.capacity?.occupied).toBe(2);
    old.resolve(workerResponse(batch(['project-unavailable', 'cleanup-capacity-blocked']))); await flush();
    expect(result.current.snapshot?.items[0]?.item.state === 'available' && result.current.snapshot.items[0].item.summary.admission).toBeNull();
    fresh.resolve(workerResponse(batch(['cleanup-capacity-blocked'], 'restricted'))); await flush();
    const restored = result.current.snapshot?.items[0]?.item;
    expect(restored?.state === 'available' && restored.summary.admission?.reasonCodes).toEqual(['cleanup-capacity-blocked']);
  });
  it('withdraws private scope and ignores an earlier response while retaining total capacity and global blockage', async () => {
    const currentScope = scope(), project = workerId(30), old = deferred<Response>(), fresh = deferred<Response>(); let publish!: (event: CacheEvent) => void;
    vi.spyOn(currentScope, 'subscribeProjection').mockImplementation(listener => { publish = listener; return () => {}; });
    vi.mocked(currentScope.prepareProjection).mockResolvedValue(new Map([[project, 'a']]));
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(detail())).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerMonitoring(workerId(1), { readEnabled: true }), { wrapper: wrapper(currentScope) });
    await flush(); act(() => result.current.refresh()); await flush();
    act(() => publish({ projectId: project, accessRevoked: true, revokedGeneration: 'a' })); await flush();
    const snapshot = result.current.snapshot!; expect(snapshot.state).toBe('available');
    if (snapshot.state !== 'available') throw new Error('expected available');
    expect(snapshot.permissionProjection).toBe('restricted'); expect(snapshot.data.activities).toEqual([]);
    expect(snapshot.data.capacity?.occupied).toBe(2); expect(snapshot.data.admission.reasons[0]?.code).toBe('cleanup-capacity-blocked');
    old.resolve(workerResponse(detail())); await flush(); expect(result.current.snapshot?.state === 'available' && result.current.snapshot.data.activities).toEqual([]);
    const updated = detail(); updated.data.activities = []; updated.permissionProjection = 'restricted'; fresh.resolve(workerResponse(updated)); await flush();
    expect(result.current.snapshot?.state === 'available' && result.current.snapshot.data.activities).toEqual([]);
  });
});
