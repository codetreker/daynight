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
  it('accepts only canonical claim worktree locations and preserves absence', () => {
    expect(parseWorkerMonitoringDetail(detail())).toEqual(detail());
    for (const worktree of [
      { kind: 'project-relative', path: '.' }, { kind: 'project-relative', path: '../retained/工作 区' },
      { kind: 'project-relative', path: 'a'.repeat(4096) },
      ...['different-volume', 'invalid-path', 'limit-exceeded'].map(reason => ({ kind: 'unavailable', reason })),
    ]) {
      const input = mutate(['data', 'currentFailures', '0', 'worktree'], worktree);
      expect(parseWorkerMonitoringDetail(input)).toEqual(input);
    }
  });
  it('rejects invalid worktree shapes, paths and non-claim scope', () => {
    for (const worktree of [null, {}, { kind: 'unknown' }, { kind: 'unavailable', reason: 'unknown' },
      { kind: 'unavailable', reason: 'invalid-path', extra: true }, { kind: 'project-relative', path: 'a', extra: true },
      ...['', '/a', '//server/share', 'C:folder', 'C:/folder', 'a\\b', 'a//b', './a', 'a/./b', 'a/../b', 'a/', '\u0000', '\u0085', '\ud800', 'é'.repeat(2049)].map(path => ({ kind: 'project-relative', path })),
    ]) expect(() => parseWorkerMonitoringDetail(mutate(['data', 'currentFailures', '0', 'worktree'], worktree))).toThrow();
    for (const [owner, label] of [[{ kind: 'worker' }, null], [{ kind: 'project', projectId }, { kind: 'project', projectName: 'Project' }]] as const) {
      const value = detail();
      Object.assign(value.data.currentFailures[0]!, { scope: owner, association: label, worktree: { kind: 'project-relative', path: 'ok' } });
      expect(() => parseWorkerMonitoringDetail(value)).toThrow();
    }
  });
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
  it('rejects duplicate decoded keys in the original GET and query response bytes', async () => {
    const admission = { userId: WORKER_USER, onPrincipalMismatch: vi.fn() }, signal = new AbortController().signal;
    const getBody = JSON.stringify(detail()).replace('"coverage":"complete"', String.raw`"coverage":"partial","cov\u0065rage":"complete"`);
    const queryBody = JSON.stringify(query()).replace('"permissionProjection":"current"', String.raw`"permissionProjection":"restricted","permissionProje\u0063tion":"current"`);
    const getPlain = JSON.stringify(detail()).replace('"state":"available"', '"state":"absent","state":"available"');
    const queryPlain = JSON.stringify(query()).replace('"reasonCodes":["no-ready-tasks"]', '"reasonCodes":[],"reasonCodes":["no-ready-tasks"]');
    const response = (body: string) => new Response(new TextEncoder().encode(body), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': WORKER_USER } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(getBody)).mockResolvedValueOnce(response(queryBody)).mockResolvedValueOnce(response(getPlain)).mockResolvedValueOnce(response(queryPlain))
      .mockResolvedValueOnce(response(JSON.stringify(detail()))).mockResolvedValueOnce(response(JSON.stringify(query()))));
    await expect(getWorkerMonitoring(id, signal, admission)).rejects.toMatchObject({ kind: 'protocol', status: 200 });
    await expect(queryWorkerMonitoring([id], signal, admission)).rejects.toMatchObject({ kind: 'protocol', status: 200 });
    await expect(getWorkerMonitoring(id, signal, admission)).rejects.toMatchObject({ kind: 'protocol', status: 200 });
    await expect(queryWorkerMonitoring([id], signal, admission)).rejects.toMatchObject({ kind: 'protocol', status: 200 });
    expect(await getWorkerMonitoring(id, signal, admission)).toEqual(detail());
    expect(await queryWorkerMonitoring([id], signal, admission)).toEqual(query());
  });
  it('preserves principal admission and the confirmed 503 error before decoding a success', async () => {
    const mismatch = vi.fn(), admission = { userId: WORKER_USER, onPrincipalMismatch: mismatch }, signal = new AbortController().signal;
    const headers = { 'Content-Type': 'application/json', 'Daynight-User-ID': WORKER_USER };
    const wrong = new Response(new Uint8Array([0xff]), { headers: { ...headers, 'Daynight-User-ID': workerId(90) } });
    const unavailable = new Response(JSON.stringify({ error: { code: 'monitoring_unavailable', message: 'Unavailable', requestId: 'worker-request', details: { sample: 0.1 } } }), { status: 503, headers });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(wrong).mockResolvedValueOnce(unavailable));
    await expect(getWorkerMonitoring(id, signal, admission)).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(mismatch).toHaveBeenCalledOnce();
    await expect(queryWorkerMonitoring([id], signal, admission)).rejects.toMatchObject({ kind: 'server', status: 503, code: 'monitoring_unavailable', requestId: 'worker-request' });
  });
  it('cancels the unread stream on principal rejection without replacing the admission error', async () => {
    const mismatch = vi.fn(), cancel = vi.fn(), admission = { userId: WORKER_USER, onPrincipalMismatch: mismatch }, signal = new AbortController().signal;
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': workerId(90) } })));
    await expect(queryWorkerMonitoring([id], signal, admission)).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(mismatch).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });
  it('validates original number values exactly before JavaScript can round them', async () => {
    const admission = { userId: WORKER_USER, onPrincipalMismatch: vi.fn() }, signal = new AbortController().signal;
    const getValue = detail(); getValue.data.capacity.occupied = Number.MAX_SAFE_INTEGER; getValue.data.capacity.available = 0;
    const queryValue = query(); queryValue.items[0]!.summary.capacity.occupied = Number.MAX_SAFE_INTEGER; queryValue.items[0]!.summary.capacity.available = 0;
    const getBody = JSON.stringify(getValue), queryBody = JSON.stringify(queryValue);
    const fractionalGet = getBody.replace('"occupied":9007199254740991', '"occupied":9007199254740990.9');
    const fractionalQuery = queryBody.replace('"occupied":9007199254740991', '"occupied":9007199254740990.9');
    const overflow = getBody.replace('"elapsedMs":100', '"elapsedMs":9007199254740992');
    const underflow = getBody.replace('"elapsedMs":100', '"elapsedMs":1e-4000');
    const integralGet = getBody.replace('"limit":2', '"limit":2.0').replace('"elapsedMs":100', '"elapsedMs":1e2').replace('"occurrencesInRun":1', '"occurrencesInRun":10e-1');
    const integralQuery = queryBody.replace('"limit":2', '"limit":20e-1').replace('"available":0', '"available":-0');
    const response = (body: string) => new Response(new TextEncoder().encode(body), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': WORKER_USER } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(fractionalGet)).mockResolvedValueOnce(response(fractionalQuery))
      .mockResolvedValueOnce(response(overflow)).mockResolvedValueOnce(response(underflow)).mockResolvedValueOnce(response(integralGet)).mockResolvedValueOnce(response(integralQuery)));
    await expect(getWorkerMonitoring(id, signal, admission)).rejects.toMatchObject({ kind: 'protocol', status: 200 });
    await expect(queryWorkerMonitoring([id], signal, admission)).rejects.toMatchObject({ kind: 'protocol', status: 200 });
    await expect(getWorkerMonitoring(id, signal, admission)).rejects.toMatchObject({ kind: 'protocol', status: 200 });
    await expect(getWorkerMonitoring(id, signal, admission)).rejects.toMatchObject({ kind: 'protocol', status: 200 });
    expect(await getWorkerMonitoring(id, signal, admission)).toEqual(getValue);
    expect(await queryWorkerMonitoring([id], signal, admission)).toEqual(queryValue);
  });
  it('enforces response byte limits and rejects malformed UTF-8', async () => {
    const admission = { userId: WORKER_USER, onPrincipalMismatch: vi.fn() }, signal = new AbortController().signal;
    const headers = { 'Content-Type': 'application/json', 'Daynight-User-ID': WORKER_USER };
    const source = JSON.stringify(absent());
    const atLimit = source + ' '.repeat(512 * 1024 - source.length);
    const tooLarge = JSON.stringify(query()) + ' '.repeat(256 * 1024);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(atLimit, { headers }))
      .mockResolvedValueOnce(new Response(tooLarge, { headers })).mockResolvedValueOnce(new Response(new Uint8Array([0xff]), { headers })));
    expect(await getWorkerMonitoring(id, signal, admission)).toEqual(absent());
    await expect(queryWorkerMonitoring([id], signal, admission)).rejects.toMatchObject({ kind: 'protocol', status: 200 });
    await expect(getWorkerMonitoring(id, signal, admission)).rejects.toMatchObject({ kind: 'protocol', status: 200 });
  });
  it('propagates cancellation while reading and cancels the owned response stream', async () => {
    const admission = { userId: WORKER_USER, onPrincipalMismatch: vi.fn() }, controller = new AbortController();
    const started = Promise.withResolvers<void>(), cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: () => { started.resolve(); return new Promise<void>(() => {}); }, cancel }, { highWaterMark: 0 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': WORKER_USER } })));
    const pending = getWorkerMonitoring(id, controller.signal, admission);
    await started.promise; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('retains the response-stream failure as the protocol error cause', async () => {
    const admission = { userId: WORKER_USER, onPrincipalMismatch: vi.fn() }, signal = new AbortController().signal;
    const failure = new Error('controlled stream failure');
    const body = new ReadableStream<Uint8Array>({ pull: controller => controller.error(failure) }, { highWaterMark: 0 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': WORKER_USER } })));
    await expect(getWorkerMonitoring(id, signal, admission)).rejects.toMatchObject({ kind: 'protocol', status: 200, cause: failure });
  });
});
