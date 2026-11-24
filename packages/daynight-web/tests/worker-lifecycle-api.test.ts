import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import { getWorkerLifecycle, getWorkerLifecycleOperation, lifecycleIntentHash, parseLifecycleIntentRequest, parseLifecycleObservedEnvelope, parseLifecycleOperationResult, parseLifecycleResource, resolveWorkerLifecycleOperation, submitWorkerLifecycle, verifyLifecycleIntentResult, WORKER_LIFECYCLE_HEADER, type LifecycleIntentRequest } from '../src/api/worker-lifecycle';
import { WORKER_TIME, WORKER_USER, workerId, workerResponse } from './helpers/workers';

const worker = workerId(1), operation = workerId(2), instance = workerId(3);
const admission = { userId: WORKER_USER, onPrincipalMismatch: vi.fn() };
const signal = () => new AbortController().signal;
const request: LifecycleIntentRequest = { protocolVersion: 1, operationId: operation, action: 'disable', expectedVersion: '1', source: 'web', localEpoch: null, originOperationId: null };
const receipt = () => ({ protocolVersion: 1, workerId: worker, operationId: operation, action: 'disable', intentVersion: '2', desired: 'disabled', admission: 'closed', state: 'accepted', errorCode: null, observedAt: WORKER_TIME });
const observation = () => ({ protocolVersion: 1, instanceId: instance, intentVersion: '2', operationId: operation, localEpoch: '3', scopeGeneration: '2', reportSequence: '4', observation: {
  phase: 'disabled', stop: 'confirmed', save: 'durable', sync: 'pending', inventoryComplete: true, detailsComplete: true, inventoryRevision: '1', inventoryDigest: 'a'.repeat(64),
  resourceCount: 0, stoppedCount: 0, pendingCount: 0, blockedCount: 0, resources: [] as unknown[], recovery: [] as unknown[], errorCode: null,
  receivedAt: WORKER_TIME, freshUntil: '2026-10-29T12:01:00Z',
} });
const resource = () => ({ protocolVersion: 1, workerId: worker, intentVersion: '2', desired: 'disabled', admission: 'closed', operationId: operation,
  instance: { instanceId: instance }, capability: 'supported', observation: observation(), observedAt: WORKER_TIME });
const response = (value: unknown, status = 200) => { const result = workerResponse(value, WORKER_USER, status); result.headers.set(WORKER_LIFECYCLE_HEADER, '1'); return result; };
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Worker lifecycle v1 parsing', () => {
  it('retains the complete observation identity and exact int64 versions', () => {
    const data = resource(); data.intentVersion = '9223372036854775807';
    expect(parseLifecycleResource(data, worker)).toEqual(data);
    expect(parseLifecycleResource({ ...data, instance: null, observation: null, capability: 'unsupported' })).toMatchObject({ instance: null, observation: null, capability: 'unsupported' });
  });
  it.each(['0', '01', '-1', '9223372036854775808', 1, null])('rejects invalid versions %s', invalid => {
    expect(() => parseLifecycleResource({ ...resource(), intentVersion: invalid })).toThrow();
    expect(() => parseLifecycleObservedEnvelope({ ...observation(), reportSequence: invalid })).toThrow();
  });
  it('rejects missing nulls, unknown fields, foreign Workers and noncanonical identity', () => {
    const { operationId: omitted, ...missing } = resource(); void omitted;
    for (const data of [missing, { ...resource(), extra: true }, { ...resource(), protocolVersion: 2 }, { ...resource(), workerId: WORKER_USER.toUpperCase() }, { ...resource(), workerId: '00000000-0000-0000-0000-000000000000' }, { ...resource(), admission: 'open' }]) expect(() => parseLifecycleResource(data, worker)).toThrow();
    expect(() => parseLifecycleResource(resource(), workerId(7))).toThrow();
  });
  it('keeps unknown inventory distinct from an empty complete inventory', () => {
    const data = observation();
    Object.assign(data.observation, { phase: 'disabling', stop: 'unknown', save: 'pending', inventoryComplete: false, detailsComplete: false, resourceCount: null, stoppedCount: null, pendingCount: null, blockedCount: null });
    expect(parseLifecycleObservedEnvelope(data).observation.resourceCount).toBeNull();
    data.observation.stop = 'confirmed';
    expect(() => parseLifecycleObservedEnvelope(data)).toThrow();
  });
  it('accepts a complete aggregate proof with only a transmitted detail prefix', () => {
    const data = observation();
    Object.assign(data.observation, { detailsComplete: false, resourceCount: 900, stoppedCount: 900 });
    expect(parseLifecycleObservedEnvelope(data).observation).toMatchObject({ inventoryComplete: true, detailsComplete: false, resourceCount: 900 });
    data.observation.detailsComplete = true;
    expect(() => parseLifecycleObservedEnvelope(data)).toThrow();
  });
  it('refuses impossible aggregate stop/save claims, counters and timestamps', () => {
    for (const patch of [{ stoppedCount: -1 }, { resourceCount: Number.MAX_SAFE_INTEGER + 1 }, { pendingCount: 1 }, { stoppedCount: null }, { stop: 'stopping' }, { save: 'failed' }, { inventoryComplete: false }, { freshUntil: WORKER_TIME }, { receivedAt: '2026-02-30T00:00:00Z' }, { inventoryDigest: 'A'.repeat(64) }, { errorCode: '/private/path' }]) {
      const data = observation(); Object.assign(data.observation, patch);
      expect(() => parseLifecycleObservedEnvelope(data)).toThrow();
    }
  });
  it('validates detail identities, order, bounded lists and diagnostic codes', () => {
    const row = { resourceId: workerId(4), ownerKind: 'controller', projectId: null, taskId: null, botId: null, executionId: null, sessionId: null, executionGeneration: null, stage: 'stopped', stop: 'confirmed', save: 'durable', errorCode: null };
    const data = observation(); Object.assign(data.observation, { resourceCount: 1, stoppedCount: 1, resources: [row], recovery: [{ resourceId: row.resourceId, recoverability: 'blocked', reasonCode: 'native_unrecoverable' }] });
    expect(parseLifecycleObservedEnvelope(data).observation.resources).toEqual([row]);
    for (const patch of [{ resources: [{ ...row, ownerKind: 'shell' }] }, { resources: [{ ...row, stage: 'running' }] }, { resources: [{ ...row, save: 'failed' }] }, { resources: [{ ...row, executionGeneration: '0' }] }, { resources: [row, row], resourceCount: 2, stoppedCount: 2 }, { resources: Array(513).fill(row) }, { recovery: [{ resourceId: row.resourceId, recoverability: 'ready', reasonCode: null }] }]) {
      expect(() => parseLifecycleObservedEnvelope({ ...data, observation: { ...data.observation, ...patch } })).toThrow();
    }
  });
  it('parses every discriminated result and checks activation identities', () => {
    const activation = { protocolVersion: 1, workerId: worker, operationId: operation, action: 'resume', instanceId: instance, intentVersion: '2', localEpoch: '3', scopeGeneration: '2', admission: 'open', observedAt: WORKER_TIME };
    const resume = { ...receipt(), action: 'resume', desired: 'enabled' };
    const values = [
      { kind: 'intent', receipt: receipt(), activation: null, activationOutcome: 'not_started' },
      { kind: 'intent', receipt: resume, activation, activationOutcome: 'committed' },
      { kind: 'intent', receipt: resume, activation: null, activationOutcome: 'not_committed' },
      { kind: 'activation', receipt: activation },
      { kind: 'instance', receipt: { protocolVersion: 1, workerId: worker, operationId: operation, instanceId: instance, intentVersion: '2', desired: 'enabled', admission: 'closed', reconnectAllowed: false, observedAt: WORKER_TIME } },
      { kind: 'not_committed', receipt: { protocolVersion: 1, workerId: worker, operationId: operation, requestKind: 'intent', requestHash: 'a'.repeat(64), outcome: 'not_committed', observedAt: WORKER_TIME } },
    ];
    for (const value of values) expect(parseLifecycleOperationResult(value, worker, operation)).toEqual(value);
    for (const value of [{ kind: 'intent', receipt: receipt(), activation, activationOutcome: 'committed' }, { kind: 'intent', receipt: resume, activation, activationOutcome: 'not_started' }, { kind: 'intent', receipt: resume, activation: { ...activation, operationId: workerId(8) }, activationOutcome: 'committed' }, { ...values[0], unexpected: true }]) expect(() => parseLifecycleOperationResult(value)).toThrow();
  });
  it('validates exact Web intent variants before network dispatch', () => {
    expect(parseLifecycleIntentRequest(request)).toEqual(request);
    const resume = { protocolVersion: 1, operationId: operation, action: 'resume', expectedVersion: '2', source: 'web', localEpoch: '3', instanceId: instance };
    expect(parseLifecycleIntentRequest(resume)).toEqual(resume);
    for (const value of [{ ...request, source: 'local' }, { ...request, localEpoch: '1' }, { ...request, instanceId: instance }, { ...request, action: 'resume' }, { ...resume, instanceId: '1' }, { ...request, expectedVersion: '0' }]) expect(() => parseLifecycleIntentRequest(value)).toThrow();
  });
});

describe('Worker lifecycle HTTP and original-operation recovery', () => {
  it('negotiates the independent endpoint and binds the 202 receipt to its exact request', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(resource())).mockResolvedValueOnce(response(receipt(), 202)); vi.stubGlobal('fetch', fetch);
    expect(await getWorkerLifecycle(worker, signal(), admission)).toEqual(resource());
    const dispatched = vi.fn();
    expect(await submitWorkerLifecycle(worker, request, signal(), admission, dispatched)).toEqual(receipt());
    expect(dispatched).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/me/workers/${worker}/lifecycle`);
    expect(fetch.mock.calls[0]![1].headers[WORKER_LIFECYCLE_HEADER]).toBe('1');
    expect(fetch.mock.calls[1]![1].method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual(request);
  });
  it('does not interpret missing capability negotiation or a foreign principal as valid data', async () => {
    const wrongPrincipal = response(resource()); wrongPrincipal.headers.set('Daynight-User-ID', workerId(9));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(workerResponse(resource())).mockResolvedValueOnce(wrongPrincipal));
    await expect(getWorkerLifecycle(worker, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
    await expect(getWorkerLifecycle(worker, signal(), admission)).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(admission.onPrincipalMismatch).toHaveBeenCalledOnce();
  });
  it('rejects an unrelated or malformed intent receipt as unknown protocol output', async () => {
    const fetch = vi.fn();
    for (const patch of [{ operationId: workerId(9) }, { workerId: workerId(9) }, { intentVersion: '1' }, { action: 'resume', desired: 'enabled' }]) fetch.mockResolvedValueOnce(response({ ...receipt(), ...patch }, 202));
    vi.stubGlobal('fetch', fetch);
    for (let index = 0; index < 4; index++) await expect(submitWorkerLifecycle(worker, request, signal(), admission, vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('reads and resolves the original operation without replaying the business endpoint', async () => {
    const result = { kind: 'not_committed', receipt: { protocolVersion: 1, workerId: worker, operationId: operation, requestKind: 'intent', requestHash: await lifecycleIntentHash(request), outcome: 'not_committed', observedAt: WORKER_TIME } };
    const fetch = vi.fn().mockResolvedValueOnce(response(result)).mockResolvedValueOnce(response(result)); vi.stubGlobal('fetch', fetch);
    const observed = await getWorkerLifecycleOperation(worker, operation, signal(), admission);
    expect(await verifyLifecycleIntentResult(observed, worker, request)).toEqual(result);
    expect(await resolveWorkerLifecycleOperation(worker, request, signal(), admission, vi.fn())).toEqual(result);
    expect(fetch.mock.calls[0]![1].method).toBe('GET');
    expect(fetch.mock.calls[1]![0]).toBe(`/api/v1/me/workers/${worker}/lifecycle/operations/${operation}/resolve`);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ protocolVersion: 1, requestKind: 'intent', request });
    const invalid = parseLifecycleOperationResult({ ...result, receipt: { ...result.receipt, requestHash: 'b'.repeat(64) } });
    await expect(verifyLifecycleIntentResult(invalid, worker, request)).rejects.toThrow();
    await expect(verifyLifecycleIntentResult(parseLifecycleOperationResult({ ...result, receipt: { ...result.receipt, requestKind: 'activation' } }), worker, request)).rejects.toThrow();
  });
  it('hashes required nulls and sorted keys in the protocol intent domain', async () => {
    const canonical = '{"action":"disable","expectedVersion":"1","localEpoch":null,"operationId":"00000002-1111-4111-8111-111111111111","originOperationId":null,"protocolVersion":1,"source":"web"}';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`daynight.lifecycle.v1/intent\n${canonical}`));
    expect(await lifecycleIntentHash(request)).toBe(Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join(''));
  });
  it('preserves conflicts, revocation and unavailable authority without a retry', async () => {
    const fetch = vi.fn();
    for (const [status, code] of [[409, 'version_conflict'], [409, 'operation_conflict'], [401, 'unauthenticated'], [503, 'lifecycle_unavailable']] as const) fetch.mockResolvedValueOnce(response({ error: { code, message: 'Rejected', requestId: 'request' } }, status));
    vi.stubGlobal('fetch', fetch);
    for (const code of ['version_conflict', 'operation_conflict', 'unauthenticated', 'lifecycle_unavailable']) await expect(submitWorkerLifecycle(worker, request, signal(), admission, vi.fn())).rejects.toMatchObject({ kind: 'server', code });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('keeps an absent operation and a lost write response unresolved without replay', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ error: { code: 'not_found', message: 'No operation', requestId: 'query' } }, 404))
      .mockRejectedValueOnce(new TypeError('Connection lost'));
    vi.stubGlobal('fetch', fetch);
    await expect(getWorkerLifecycleOperation(worker, operation, signal(), admission)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(submitWorkerLifecycle(worker, request, signal(), admission, vi.fn())).rejects.toMatchObject({ kind: 'network' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(call => call[1].method)).toEqual(['GET', 'POST']);
  });
});
