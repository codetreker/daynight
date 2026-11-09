import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorkerMonitoring, parseWorkerMonitoringDetail, parseWorkerMonitoringQuery, queryWorkerMonitoring } from '../src/api/worker-monitoring';
import { invalidateAuthRequests } from '../src/api/client';
import { WORKER_TIME, WORKER_USER, workerError, workerId, workerResponse } from './helpers/workers';

const id = workerId(1), projectId = workerId(2), taskId = workerId(3), claimId = workerId(4);
const scope = { kind: 'claim', projectId, taskId, claimId };
const association = { kind: 'task', projectName: 'Project', title: 'Task' };
const cause = { type: 'operation', code: 'timeout', cause: 'The operation timed out.', causeTruncated: false };
const sample = () => ({
  runId: id, sequence: '1', capturedAt: WORKER_TIME, lifecycle: 'running',
  scheduler: { phase: 'waiting-poll', coverage: 'complete', cycleId: null, lastCompletedAt: WORKER_TIME, lastSuccessfulAt: WORKER_TIME, lastOutcome: 'completed', nextPollAt: null },
  capacity: { observedAt: WORKER_TIME, quality: 'current', limit: 2, occupied: 1, available: 1, detailCoverage: 'complete' },
  admission: { observedAt: WORKER_TIME, coverage: 'complete', reasons: [{ code: 'no-ready-tasks', scope: { kind: 'worker' }, observedAt: WORKER_TIME, nextAttemptAt: null, association: null }] },
  reservations: [{ reservationId: workerId(5), scope, roles: ['active-task'], occupied: true, observedAt: WORKER_TIME, association }],
  activities: [{ kind: 'execution', phase: 'executing', operationId: workerId(6), status: 'running', scope, startedAt: WORKER_TIME, lastProgressAt: null, elapsedMs: 100, deadlineAt: null, waitReason: null, nextAttemptAt: null, association }],
  currentFailures: [{ operationId: workerId(6), component: 'execution', phase: 'executing', scope, error: cause, firstObservedAt: WORKER_TIME, lastObservedAt: WORKER_TIME, occurrencesInRun: 1, retryState: 'scheduled', nextAttemptAt: WORKER_TIME, association }],
  lastRecovery: { operationId: workerId(6), component: 'execution', scope, observedAt: WORKER_TIME, explanation: 'The operation recovered.', explanationTruncated: false, association },
  detailCoverage: 'complete', delivery: { lastSucceededAt: WORKER_TIME, lastFailure: { observedAt: WORKER_TIME, phase: 'write', error: cause, requestId: null } },
});
const detail = () => ({ observedAt: WORKER_TIME, state: 'available', revision: workerId(7), runId: id, sequence: '1', receivedAt: WORKER_TIME, expiresAt: WORKER_TIME, data: sample(), detailCoverage: 'complete', permissionProjection: 'current' });
const absent = () => ({ observedAt: WORKER_TIME, state: 'absent', revision: null, runId: null, sequence: null, receivedAt: null, expiresAt: null, data: null, detailCoverage: 'complete', permissionProjection: 'current' });
const query = () => ({ observedAt: WORKER_TIME, items: [{ workerId: id, state: 'available', revision: workerId(7), receivedAt: WORKER_TIME, expiresAt: WORKER_TIME, summary: { capturedAt: WORKER_TIME, lifecycle: 'running', scheduler: { phase: 'waiting-poll', coverage: 'complete', lastSuccessfulAt: WORKER_TIME, nextPollAt: null }, capacity: { observedAt: WORKER_TIME, quality: 'current', limit: 2, occupied: 1, available: 1 }, detailCoverage: 'complete', admission: { observedAt: WORKER_TIME, coverage: 'complete', reasonCodes: ['no-ready-tasks'], permissionProjection: 'current' } } }] });
const mutate = (path: readonly string[], value: unknown): unknown => {
  const result = structuredClone(detail()) as unknown as Record<string, unknown>;
  let cursor = result;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  cursor[path.at(-1)!] = value;
  return result;
};
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe('Worker monitoring response contracts', () => {
  it('accepts available observations and absent state without fabricating data', () => {
    expect(parseWorkerMonitoringDetail(detail())).toEqual(detail());
    expect(parseWorkerMonitoringDetail(absent())).toEqual(absent());
    expect(parseWorkerMonitoringQuery(query(), [id])).toEqual(query());
    const missing = { observedAt: WORKER_TIME, items: [{ workerId: id, state: 'absent', revision: null, receivedAt: null, expiresAt: null, summary: null }] };
    expect(parseWorkerMonitoringQuery(missing, [id])).toEqual(missing);
  });
  it('accepts restricted and budgeted associations, preserving permitted capacity', () => {
    const value = detail(); value.permissionProjection = 'restricted'; value.detailCoverage = 'partial'; value.data.detailCoverage = 'partial';
    value.data.activities[0]!.association = { kind: 'labels-omitted' } as typeof association;
    expect(parseWorkerMonitoringDetail(value)).toEqual(value);
    const project = { kind: 'project', projectId };
    value.data.admission.reasons = [{ code: 'project-unavailable', scope: project, observedAt: WORKER_TIME, nextAttemptAt: null, association: { kind: 'project', projectName: 'Project' } }] as never;
    expect(parseWorkerMonitoringDetail(value).state).toBe('available');
  });
  it.each([
    [['state'], 'unknown'], [['revision'], null], [['runId'], workerId(9)], [['sequence'], '01'], [['sequence'], '9223372036854775808'],
    [['data', 'scheduler', 'phase'], 'other'], [['data', 'scheduler', 'coverage'], 'other'], [['data', 'scheduler', 'cycleId'], 'BAD'],
    [['data', 'capacity', 'available'], 2], [['data', 'capacity', 'limit'], 0], [['data', 'capacity', 'occupied'], -1],
    [['data', 'admission', 'coverage'], 'unknown'], [['data', 'admission', 'reasons', '0', 'code'], 'missing'],
    [['data', 'reservations', '0', 'reservationId'], workerId(9).replace('-4111-', '-1111-')], [['data', 'reservations', '0', 'roles'], []],
    [['data', 'activities', '0', 'phase'], 'archive'], [['data', 'activities', '0', 'waitReason'], 'waiting-for-ci'],
    [['data', 'activities', '0', 'association'], null], [['data', 'activities', '0', 'scope', 'taskId'], 'BAD'],
    [['data', 'currentFailures', '0', 'error', 'cause'], 'free text'], [['data', 'currentFailures', '0', 'error', 'code'], 'invented'],
    [['data', 'currentFailures', '0', 'retryState'], 'none'], [['data', 'lastRecovery', 'explanationTruncated'], true],
    [['data', 'delivery', 'lastFailure', 'phase'], 'invented'], [['data', 'detailCoverage'], 'partial'], [['data', 'capturedAt'], 'yesterday'],
    [['data', 'extra'], true], [['data', 'activities'], null], [['permissionProjection'], 'unknown'],
  ] as const)('rejects malformed or contradictory fields %#', (path, value) => expect(() => parseWorkerMonitoringDetail(mutate(path, value))).toThrow('invalid response'));
  it('rejects missing and extra fields, duplicate reservations, and inconsistent absent states', () => {
    for (const key of Object.keys(detail())) { const d = detail() as unknown as Record<string, unknown>; delete d[key]; expect(() => parseWorkerMonitoringDetail(d)).toThrow(); }
    const duplicate = detail(); duplicate.data.reservations.push(duplicate.data.reservations[0]!);
    expect(() => parseWorkerMonitoringDetail(duplicate)).toThrow();
    expect(() => parseWorkerMonitoringDetail({ ...absent(), permissionProjection: 'restricted' })).toThrow();
    expect(() => parseWorkerMonitoringDetail({ ...absent(), data: sample() })).toThrow();
    expect(() => parseWorkerMonitoringQuery(query(), [workerId(9)])).toThrow();
    expect(() => parseWorkerMonitoringQuery({ ...query(), items: [{ ...query().items[0], unexpected: 1 }] }, [id])).toThrow();
    expect(() => parseWorkerMonitoringQuery({ ...query(), items: [{ ...query().items[0], state: 'absent' }] }, [id])).toThrow();
  });
  it('requires closed admission, fixed reason order and consistent coverage', () => {
    const withAdmission = (admission: unknown) => {
      const value = query();
      return { ...value, items: [{ ...value.items[0]!, summary: { ...value.items[0]!.summary, admission } }] };
    };
    const valid = { observedAt: WORKER_TIME, coverage: 'complete', reasonCodes: ['configuration-unavailable', 'cleanup-capacity-blocked', 'no-ready-tasks', 'stopping'], permissionProjection: 'restricted' };
    expect(parseWorkerMonitoringQuery(withAdmission(valid), [id]).items[0]?.state).toBe('available');
    for (const admission of [
      null, { ...valid, extra: true }, { ...valid, observedAt: 'yesterday' }, { ...valid, permissionProjection: 'unknown' },
      { ...valid, coverage: 'invalid' }, { ...valid, reasonCodes: ['missing'] }, { ...valid, reasonCodes: ['no-ready-tasks', 'cleanup-capacity-blocked'] },
      { ...valid, reasonCodes: ['stopping', 'stopping'] }, { ...valid, coverage: 'partial' }, { ...valid, coverage: 'unknown' },
    ]) expect(() => parseWorkerMonitoringQuery(withAdmission(admission), [id])).toThrow();
    const missing = query(); delete (missing.items[0]!.summary as { admission?: unknown }).admission;
    expect(() => parseWorkerMonitoringQuery(missing, [id])).toThrow();
  });
  it('validates request identity, batching, response principal and server errors', async () => {
    const mismatch = vi.fn(), admission = { userId: WORKER_USER, onPrincipalMismatch: mismatch }, signal = new AbortController().signal;
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(detail())).mockResolvedValueOnce(workerResponse(query())).mockResolvedValueOnce(workerError(503)).mockResolvedValueOnce(workerResponse(absent(), workerId(90)));
    vi.stubGlobal('fetch', fetch);
    expect(await getWorkerMonitoring(id, signal, admission)).toEqual(detail());
    expect(await queryWorkerMonitoring([id], signal, admission)).toEqual(query());
    expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/me/workers/${id}/monitoring`);
    expect(fetch.mock.calls[1]![0]).toBe('/api/v1/me/workers/monitoring/query');
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ workerIds: [id] });
    await expect(getWorkerMonitoring(id, signal, admission)).rejects.toMatchObject({ kind: 'server', status: 503 });
    await expect(getWorkerMonitoring(id, signal, admission)).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(mismatch).toHaveBeenCalledOnce();
    for (const ids of [[], [id, id], Array.from({ length: 101 }, (_, i) => workerId(i))]) await expect(queryWorkerMonitoring(ids, signal, admission)).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
