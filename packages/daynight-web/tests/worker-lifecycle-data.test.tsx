import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import { lifecycleIntentHash, type LifecycleIntentRequest, type LifecycleResource } from '../src/api/worker-lifecycle';
import { lifecycleAdvances, useWorkerLifecycle } from '../src/features/workers/useWorkerLifecycle';
import { WorkerLifecyclePanel } from '../src/features/workers/WorkerLifecyclePanel';
import { renderWithLocale } from './helpers/renderWithLocale';
import { WORKER_TIME, WORKER_USER, workerId, workerResponse, workerSummary } from './helpers/workers';

const worker = workerId(1), original: LifecycleIntentRequest = { protocolVersion: 1, operationId: workerId(2), action: 'disable', expectedVersion: '1', source: 'web', localEpoch: null, originOperationId: null };
const resource = (): LifecycleResource => ({ protocolVersion: 1, workerId: worker, intentVersion: '1', desired: 'enabled', admission: 'open', operationId: null,
  instance: { instanceId: workerId(3) }, capability: 'supported', observation: null, observedAt: WORKER_TIME });
const stoppedResource = (desired: 'enabled' | 'disabled'): LifecycleResource => ({ ...resource(), desired, admission: 'closed', operationId: workerId(4),
  observation: { protocolVersion: 1, instanceId: workerId(3), intentVersion: '1', operationId: workerId(4), localEpoch: '2', scopeGeneration: '3', reportSequence: '4',
    observation: { phase: 'disabled', stop: 'confirmed', save: 'durable', sync: 'complete', inventoryComplete: true, detailsComplete: true, inventoryRevision: '1', inventoryDigest: 'a'.repeat(64),
      resourceCount: 0, stoppedCount: 0, pendingCount: 0, blockedCount: 0, resources: [], recovery: [], errorCode: desired === 'enabled' ? 'resume_interrupted' : null,
      receivedAt: WORKER_TIME, freshUntil: new Date(Date.parse(WORKER_TIME) + 5_000).toISOString() } },
});
const response = (value: unknown, status = 200) => { const result = workerResponse(value, WORKER_USER, status); result.headers.set('X-Daynight-Worker-Lifecycle', '1'); return result; };
const missing = () => response({ error: { code: 'not_found', message: 'Absent', requestId: 'data-test' } }, 404);
const key = () => `daynight.lifecycle.v1:${location.origin}:${WORKER_USER}:${worker}`;
const retain = async () => sessionStorage.setItem(key(), JSON.stringify({ origin: location.origin, userId: WORKER_USER, workerId: worker, request: original, hash: await lifecycleIntentHash(original) }));
const Host = ({ enabled = true, target = worker }: { readonly enabled?: boolean; readonly target?: string }) => {
  const state = useWorkerLifecycle(target, { readEnabled: enabled });
  return <><output data-testid="version">{state.snapshot?.intentVersion}</output><output data-testid="pending">{state.pending?.operationId}</output><output data-testid="error">{state.operationError}</output>
    <button disabled={state.busy || state.pending !== null} onClick={() => void state.submit('disable')}>Disable</button>
    <button disabled={state.busy} onClick={() => void state.check()}>Check</button></>;
};
const render = (ui = <Host />) => renderWithLocale(ui, { locale: 'en', taskCache: { viewerId: WORKER_USER } });
afterEach(() => { invalidateAuthRequests(); sessionStorage.clear(); });

describe('Worker lifecycle original operation continuity', () => {
  it('hydrates an unknown operation, resolves an absent original and never submits it again', async () => {
    await retain();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/resolve')) {
        expect(JSON.parse(init.body as string)).toEqual({ protocolVersion: 1, requestKind: 'intent', request: original });
        return response({ kind: 'not_committed', receipt: { protocolVersion: 1, workerId: worker, operationId: original.operationId, requestKind: 'intent', requestHash: await lifecycleIntentHash(original), outcome: 'not_committed', observedAt: WORKER_TIME } });
      }
      return url.includes('/operations/') ? missing() : response(resource());
    });
    vi.stubGlobal('fetch', fetch); render();
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('not_committed'));
    expect(screen.getByTestId('pending')).toBeEmptyDOMElement();
    expect(fetch.mock.calls.filter(([url, init]) => init.method === 'POST').map(([url]) => url)).toEqual([`/api/v1/me/workers/${worker}/lifecycle/operations/${original.operationId}/resolve`]);
    expect(sessionStorage.getItem(key())).toBeNull();
  });

  it('preserves one exact request on response loss and failed checks, including rerenders', async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') throw new TypeError('Response lost');
      if (url.includes('/operations/')) throw new TypeError('Read unavailable');
      return response(resource());
    });
    vi.stubGlobal('fetch', fetch); const view = render();
    await waitFor(() => expect(screen.getByTestId('version')).toHaveTextContent('1'));
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('unknown'));
    const saved = sessionStorage.getItem(key()); expect(saved).not.toBeNull();
    const request = JSON.parse(saved!).request as LifecycleIntentRequest;
    expect(screen.getByTestId('pending')).toHaveTextContent(request.operationId);
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith(`/operations/${request.operationId}`))).toBe(true));
    view.rerender(<Host enabled={false} />); view.rerender(<Host />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check' })).not.toBeDisabled());
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(sessionStorage.getItem(key())).toBe(saved);
  });

  it('treats a known semantic conflict as rejected and does not adopt an unrelated GET receipt', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => init.method === 'POST'
      ? response({ error: { code: 'operation_conflict', message: 'Different request', requestId: 'conflict' } }, 409) : response(resource()));
    vi.stubGlobal('fetch', fetch); render();
    await waitFor(() => expect(screen.getByTestId('version')).toHaveTextContent('1'));
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('operation_conflict'));
    expect(screen.getByTestId('pending')).toBeEmptyDOMElement();
    expect(sessionStorage.getItem(key())).toBeNull();
    expect(fetch.mock.calls.every(([url]) => !url.includes('/operations/'))).toBe(true);
  });

  it('does not send an operation when its journal cannot be persisted', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => response(resource())); vi.stubGlobal('fetch', fetch);
    render(); await waitFor(() => expect(screen.getByTestId('version')).toHaveTextContent('1'));
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage unavailable', 'QuotaExceededError'); });
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('storage'));
    expect(screen.getByTestId('pending')).not.toBeEmptyDOMElement();
    expect(fetch.mock.calls.every(([, init]) => init.method !== 'POST')).toBe(true);
    write.mockRestore();
  });

  it('rechecks storage after a temporary read failure without inventing a lifecycle request', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => response(resource())); vi.stubGlobal('fetch', fetch);
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Storage temporarily unavailable'); });
    render();
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('storage'));
    get.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(screen.getByTestId('error')).toBeEmptyDOMElement());
    expect(fetch.mock.calls.every(([, init]) => init.method !== 'POST')).toBe(true);
  });
});

describe('Worker lifecycle publication fences', () => {
  it('withdraws safe-stop and resume when the response expires in transit', async () => {
    let monotonic = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
      monotonic += 10_000;
      return response(stoppedResource('disabled'));
    });
    vi.stubGlobal('fetch', fetch);
    render(<WorkerLifecyclePanel worker={workerSummary()} readEnabled />);
    await waitFor(() => expect(screen.getByText('Observation stale')).toBeVisible());
    expect(screen.queryByText(/You can restart this computer/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume service' })).toBeDisabled();
    expect(fetch.mock.calls.every(([, init]) => init.method !== 'POST')).toBe(true);
  });

  it('submits explicit recovery from a fresh interrupted resume using the current instance and local epoch', async () => {
    const snapshot = stoppedResource('enabled');
    let submitted: LifecycleIntentRequest | null = null;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method !== 'POST') return response(snapshot);
      submitted = JSON.parse(init.body as string) as LifecycleIntentRequest;
      return response({ protocolVersion: 1, workerId: worker, operationId: submitted.operationId, action: 'resume', intentVersion: '2',
        desired: 'enabled', admission: 'closed', state: 'accepted', errorCode: null, observedAt: WORKER_TIME }, 202);
    });
    vi.stubGlobal('fetch', fetch);
    render(<WorkerLifecyclePanel worker={workerSummary()} readEnabled />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume service' })).toBeEnabled());
    expect(screen.queryByText('Resuming', { exact: true })).toBeNull();
    expect(screen.queryByText(/You can restart this computer/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resume service' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(submitted).toMatchObject({ action: 'resume', expectedVersion: '1', localEpoch: '2', instanceId: workerId(3), source: 'web' }));
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it('orders lifecycle snapshots by intent version and server observation time across instance changes', () => {
    const current = { ...resource(), intentVersion: '3' };
    expect(lifecycleAdvances(current, { ...current, intentVersion: '2' })).toBe(false);
    const replacement = { ...current, instance: { instanceId: workerId(4) }, observedAt: '2026-10-29T12:01:00Z' };
    expect(lifecycleAdvances(current, replacement)).toBe(true);
    expect(lifecycleAdvances(replacement, current)).toBe(false);
    expect(lifecycleAdvances(current, { ...current, instance: null })).toBe(false);
    expect(lifecycleAdvances(current, { ...current, observedAt: '2026-10-29T11:59:00Z' })).toBe(false);
    expect(lifecycleAdvances(current, { ...current, intentVersion: '4' })).toBe(true);
  });
});
