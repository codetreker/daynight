import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorker, listWorkers, parseWorkerDetail, parseWorkerPage, type WorkerDetailResponse } from '../src/api/workers';
import { invalidateAuthRequests, subscribeUnauthorized } from '../src/api/client';
import { WORKER_TIME, WORKER_USER, workerDetail, workerError, workerId, workerPage, workerResponse, workerSummary } from './helpers/workers';

const admission = () => ({ userId: WORKER_USER, onPrincipalMismatch: vi.fn() });
const parse = (value: unknown) => parseWorkerDetail(value, workerId(1));
const changed = (path: readonly string[], value: unknown): unknown => {
  const result = structuredClone(workerDetail()) as unknown as Record<string, unknown>;
  let target = result;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[path.at(-1)!] = value;
  return result;
};
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe('Worker response contracts', () => {
  it('retains actual telemetry and complete snapshot fields without interpreting client clocks', () => {
    const value = workerDetail();
    expect(parse(value)).toEqual(value);
    value.worker.telemetry.sampledAt = '9999-12-31T23:59:59Z';
    value.worker.telemetry.versions.codex = { state: 'ok', checkedAt: '1970-01-01T00:00:00Z', value: 'development build' };
    value.worker.telemetry.memory = { state: 'ok', checkedAt: WORKER_TIME, value: { usedBytes: 0, totalBytes: 0 } };
    value.worker.telemetry.disk = { state: 'ok', checkedAt: WORKER_TIME, value: { availableBytes: 0, totalBytes: 0 } };
    value.worker.telemetry.versions.herdr = { state: 'ok', checkedAt: WORKER_TIME, value: 'daemon native build' };
    expect(parse(value)).toEqual(value);
  });
  it('distinguishes unavailable, known empty, and stale observations', () => {
    const value = workerDetail();
    const unavailable: WorkerDetailResponse = { ...value, worker: { ...value.worker, taskObservationState: 'unavailable', taskObservedAt: null, activeTaskCount: null, inventoryObservedAt: null, tasks: [] } };
    expect(parse(unavailable)).toEqual(unavailable);
    const stale: WorkerDetailResponse = { ...value, worker: { ...value.worker, taskObservationState: 'stale', taskObservedAt: WORKER_TIME, activeTaskCount: 0, tasks: [] } };
    expect(parse(stale)).toEqual(stale);
    const unavailableSummary = { ...workerSummary(), taskObservationState: 'unavailable' as const, taskObservedAt: null, activeTaskCount: null };
    const staleSummary = { ...workerSummary(2), taskObservationState: 'stale' as const, taskObservedAt: WORKER_TIME, activeTaskCount: 0 };
    expect(parseWorkerPage(workerPage([unavailableSummary, staleSummary]))).toEqual(workerPage([unavailableSummary, staleSummary]));
  });
  it.each(['codex', 'claude', 'copilot'] as const)('accepts current snapshot agent %s', agent => {
    const value = workerDetail();
    value.worker.tasks = [{ ...value.worker.tasks[0]!, agent }];
    expect(parse(value).worker.tasks[0]!.agent).toBe(agent);
  });
  it('accepts every defined probe error and keeps absent software distinct', () => {
    for (const code of ['not_found', 'permission_denied', 'timeout', 'command_failed', 'invalid_output', 'invalid_sample', 'out_of_range', 'io_error', 'unavailable'] as const) {
      const value = workerDetail();
      value.worker.telemetry.os = { state: 'error', checkedAt: WORKER_TIME, code };
      value.worker.telemetry.cpu = { state: 'error', checkedAt: WORKER_TIME, code };
      value.worker.telemetry.memory = { state: 'error', checkedAt: WORKER_TIME, code };
      value.worker.telemetry.disk = { state: 'error', checkedAt: WORKER_TIME, code };
      value.worker.telemetry.versions.codex = { state: 'error', checkedAt: WORKER_TIME, code };
      expect(parse(value)).toEqual(value);
    }
  });
  it.each([
    [[], []], [['worker'], null], [['worker', 'workerId'], 'bad'], [['worker', 'machine', 'id'], 'machine'],
    [['worker', 'machine', 'name'], '\u2003'], [['worker', 'machine', 'name'], '\ud800'], [['worker', 'machine', 'name'], '\0'],
    [['worker', 'platform'], 'win32'], [['observedAt'], '2026-02-30T00:00:00Z'], [['worker', 'lastReportedAt'], null],
    [['worker', 'taskObservationState'], 'unknown'], [['worker', 'activeTaskCount'], -1], [['worker', 'activeTaskCount'], Number.MAX_SAFE_INTEGER + 1],
    [['worker', 'activeTaskCount'], 0], [['worker', 'taskObservedAt'], null], [['worker', 'inventoryObservedAt'], null],
    [['worker', 'telemetry', 'machine', 'name'], 'Other machine'], [['worker', 'telemetry', 'platform'], 'windows'],
    [['worker', 'telemetry', 'workingDirectory'], ''], [['worker', 'telemetry', 'sampledAt'], '2026-10-29'],
    [['worker', 'telemetry', 'os', 'state'], 'not_running'], [['worker', 'telemetry', 'os', 'value', 'extra'], true],
    [['worker', 'telemetry', 'cpu', 'value', 'logicalProcessors'], 0], [['worker', 'telemetry', 'cpu', 'value', 'usagePercent'], Infinity],
    [['worker', 'telemetry', 'cpu', 'value', 'usagePercent'], -1], [['worker', 'telemetry', 'cpu', 'value', 'usagePercent'], 101],
    [['worker', 'telemetry', 'memory', 'value', 'usedBytes'], 32_001], [['worker', 'telemetry', 'disk', 'value', 'availableBytes'], 200_001],
    [['worker', 'telemetry', 'versions', 'daynight'], ''], [['worker', 'telemetry', 'versions', 'herdr', 'value'], 'extra'],
    [['worker', 'telemetry', 'versions', 'codex', 'code'], 'extra'], [['worker', 'telemetry', 'versions', 'copilot', 'state'], 'not_running'],
    [['worker', 'tasks'], null], [['worker', 'tasks', '0', 'status'], 'ready'], [['worker', 'tasks', '0', 'phase'], 'idle'], [['worker', 'tasks', '0', 'agent'], 'unknown'],
  ] as const)('rejects malformed or inconsistent detail %#', (path, value) => {
    if (path.length === 0) expect(() => parse(value)).toThrow('invalid response');
    else expect(() => parse(changed(path, value))).toThrow('invalid response');
  });
  it('rejects missing required fields, conflicting IDs and duplicate tasks', () => {
    for (const key of Object.keys(workerDetail().worker)) {
      const value = workerDetail() as unknown as { worker: Record<string, unknown> };
      delete value.worker[key];
      expect(() => parse(value)).toThrow('invalid response');
    }
    const value = workerDetail();
    expect(() => parseWorkerDetail(value, workerId(2))).toThrow('invalid response');
    expect(() => parse(changed(['worker', 'telemetry', 'machine', 'id'], workerId(8)))).toThrow('invalid response');
    expect(() => parse({ ...value, worker: { ...value.worker, activeTaskCount: 2, tasks: [value.worker.tasks[0], value.worker.tasks[0]] } })).toThrow('invalid response');
    expect(() => parse({ ...value, worker: { ...value.worker, taskObservationState: 'unavailable', taskObservedAt: null, activeTaskCount: null } })).toThrow('invalid response');
  });
  it('keeps Go-valid FEFF names and rejects non-protocol pages', () => {
    const value = workerDetail();
    value.worker.machine.name = '\uFEFF'; value.worker.telemetry.machine.name = '\uFEFF';
    expect(parse(value)).toEqual(value);
    for (const page of [null, {}, { ...workerPage(), extra: true }, workerPage([workerSummary(), workerSummary()]), workerPage(Array.from({ length: 101 }, (_, n) => workerSummary(n))), workerPage([], ''), workerPage([], '\n'), workerPage([], 'x'.repeat(4097)), { ...workerPage(), items: null }]) expect(() => parseWorkerPage(page)).toThrow('invalid response');
  });
});

describe('authenticated Worker reads', () => {
  it('uses the account API, cursor encoding and principal-admitted HTTP200 responses', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerPage())).mockResolvedValueOnce(workerResponse(workerDetail()));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal, gate = admission();
    expect(await listWorkers({ limit: 50, cursor: 'next/+ token' }, signal, gate)).toEqual(workerPage());
    expect(await getWorker(workerId(1).toUpperCase(), signal, gate)).toEqual(workerDetail());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/me/workers?limit=50&cursor=next%2F%2B+token', `/api/v1/me/workers/${workerId(1)}`]);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ signal, cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
  });
  it.each([200, 404])('rejects another principal before admitting a %s response', async status => {
    const gate = admission();
    vi.stubGlobal('fetch', vi.fn(async () => status === 200 ? workerResponse(workerDetail(), workerId(8)) : workerError(404, workerId(8))));
    await expect(getWorker(workerId(1), new AbortController().signal, gate)).rejects.toMatchObject({ kind: 'protocol', status, code: 'principal_mismatch' });
    expect(gate.onPrincipalMismatch).toHaveBeenCalledOnce();
  });
  it('keeps missing/malformed response principals distinct from an admitted404', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'not_found', message: 'Missing', requestId: 'r' } }), { status: 404, headers: { 'Content-Type': 'application/json' } })).mockResolvedValueOnce(workerError(404));
    vi.stubGlobal('fetch', fetch);
    await expect(getWorker(workerId(1), new AbortController().signal, admission())).rejects.toMatchObject({ kind: 'protocol', status: 404 });
    await expect(getWorker(workerId(1), new AbortController().signal, admission())).rejects.toMatchObject({ kind: 'server', status: 404, code: 'not_found', requestId: 'worker-request' });
  });
  it('rejects malformed successful responses, media and unexpected status', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse({})).mockResolvedValueOnce(workerResponse(workerPage(), WORKER_USER, 201)).mockResolvedValueOnce(new Response('{}', { headers: { 'Daynight-User-ID': WORKER_USER } }));
    vi.stubGlobal('fetch', fetch);
    for (let n = 0; n < 3; n++) await expect(listWorkers({}, new AbortController().signal, admission())).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('validates input without network, exposes server/network failures, and respects cancellation', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(workerError(500));
    vi.stubGlobal('fetch', fetch);
    for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: '' }]) await expect(listWorkers(query, new AbortController().signal, admission())).rejects.toThrow();
    await expect(getWorker('bad', new AbortController().signal, admission())).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
    await expect(listWorkers({}, new AbortController().signal, admission())).rejects.toMatchObject({ kind: 'network' });
    await expect(listWorkers({}, new AbortController().signal, admission())).rejects.toMatchObject({ kind: 'server', status: 500 });
    const controller = new AbortController(); controller.abort();
    await expect(listWorkers({}, controller.signal, admission())).rejects.toMatchObject({ name: 'AbortError' }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('uses the existing401 session-expiry notification', async () => {
    const unauthorized = vi.fn(), stop = subscribeUnauthorized(unauthorized);
    vi.stubGlobal('fetch', vi.fn(async () => workerError(401)));
    try { await expect(getWorker(workerId(1), new AbortController().signal, admission())).rejects.toMatchObject({ status: 401 }); expect(unauthorized).toHaveBeenCalledOnce(); }
    finally { stop(); }
  });
});
