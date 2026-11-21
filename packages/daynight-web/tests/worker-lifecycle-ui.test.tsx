import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { LifecycleDiagnostic, LifecycleResource } from '../src/api/worker-lifecycle';
import { lifecycleFacts, WorkerLifecyclePanel } from '../src/features/workers/WorkerLifecyclePanel';
import { useWorkerLifecycle } from '../src/features/workers/useWorkerLifecycle';
import { renderWithLocale } from './helpers/renderWithLocale';
import { workerId, workerSummary, WORKER_TIME } from './helpers/workers';

vi.mock('../src/features/workers/useWorkerLifecycle', () => ({ useWorkerLifecycle: vi.fn() }));
const now = Date.parse(WORKER_TIME);
const resource = (): LifecycleResource => ({
  protocolVersion: 1, workerId: workerId(1), intentVersion: '2', desired: 'disabled', admission: 'closed', operationId: workerId(4),
  instance: { instanceId: workerId(2), instanceEpoch: '3' }, capability: 'supported', observedAt: WORKER_TIME,
  observation: { protocolVersion: 1, instanceId: workerId(2), instanceEpoch: '3', intentVersion: '2', operationId: workerId(4), localEpoch: '1', scopeGeneration: '2', reportSequence: '4',
    observation: { phase: 'disabled', stop: 'confirmed', save: 'durable', sync: 'complete', inventoryComplete: true, detailsComplete: true, inventoryRevision: '1', inventoryDigest: 'a'.repeat(64),
      resourceCount: 0, stoppedCount: 0, pendingCount: 0, blockedCount: 0, resources: [], recovery: [], errorCode: null, receivedAt: WORKER_TIME, freshUntil: '2026-10-29T12:01:00Z' } },
});
let state: ReturnType<typeof useWorkerLifecycle>;
beforeEach(() => {
  state = { snapshot: resource(), status: 'ready', stale: false, refreshing: false, serverMilliseconds: now, refresh: vi.fn(), error: null, pending: null, busy: false,
    submit: vi.fn(async () => {}), check: vi.fn(async () => {}), operationError: null };
  vi.mocked(useWorkerLifecycle).mockImplementation(() => state);
});
const show = (compact = false) => renderWithLocale(<WorkerLifecyclePanel worker={workerSummary()} readEnabled compact={compact} />, { locale: 'en' });

describe('Worker lifecycle evidence presentation', () => {
  it('requires current instance, intent, operation, freshness and complete stop/save evidence for a safe conclusion', () => {
    expect(lifecycleFacts(resource(), now, false).disabled).toBe(true);
    const original = resource();
    for (const change of [
      { instanceId: workerId(99) }, { instanceEpoch: '2' }, { intentVersion: '1' }, { operationId: workerId(99) },
    ]) expect(lifecycleFacts({ ...original, observation: { ...original.observation!, ...change } }, now, false).disabled).toBe(false);
    for (const change of [{ inventoryComplete: false }, { stop: 'unknown' as const }, { save: 'failed' as const }, { resourceCount: null }, { stoppedCount: 1 }, { pendingCount: 1 }, { blockedCount: 1 }]) {
      expect(lifecycleFacts({ ...original, observation: { ...original.observation!, observation: { ...original.observation!.observation, ...change } } }, now, false).disabled).toBe(false);
    }
    expect(lifecycleFacts(original, now + 60_000, false).disabled).toBe(false);
    expect(lifecycleFacts(original, now, true).disabled).toBe(false);
    expect(lifecycleFacts(original, null, false).disabled).toBe(false);
  });

  it.each<LifecycleDiagnostic>([
    'identity_mismatch', 'authority_unavailable', 'persistence_failed', 'inventory_incomplete',
    'stop_timeout', 'stop_unknown', 'save_failed', 'native_unrecoverable', 'ownership_changed',
    'independent_blocker', 'unsupported_provider',
  ])('withdraws safety and resume eligibility for %s despite complete stop/save counts', errorCode => {
    const data = resource();
    state.snapshot = { ...data, observation: { ...data.observation!, observation: { ...data.observation!.observation, errorCode } } };
    expect(lifecycleFacts(state.snapshot, now, false)).toMatchObject({ fresh: true, stopped: false, disabled: false, resumeEligible: false });
    expect(lifecycleFacts({ ...state.snapshot, desired: 'enabled' }, now, false).resumeEligible).toBe(false);
    show();
    expect(screen.queryByText('Disabled', { exact: true })).toBeNull();
    expect(screen.queryByText(/You can restart this computer/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume service' })).toBeDisabled();
  });

  it.each(['disabled', 'enabled'] as const)('allows interrupted recovery without safe-restart claims for desired=%s', desired => {
    const data = resource();
    state.snapshot = { ...data, desired, observation: { ...data.observation!, observation: { ...data.observation!.observation, errorCode: 'resume_interrupted' } } };
    expect(lifecycleFacts(state.snapshot, now, false)).toMatchObject({ stopped: false, disabled: false, resumeEligible: true });
    show();
    expect(screen.queryByText('Disabled', { exact: true })).toBeNull();
    expect(screen.queryByText(/You can restart this computer/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume service' })).toBeEnabled();
  });

  it.each([null, 'upload_failed'] as const)('keeps aggregate stop proof with partial details, failed synchronization and error=%s', errorCode => {
    const data = resource();
    state.snapshot = { ...data, observation: { ...data.observation!, observation: { ...data.observation!.observation, detailsComplete: false, sync: 'failed', errorCode } } };
    show();
    expect(screen.getByText('Disabled', { exact: true })).toBeVisible();
    expect(screen.getByText(/You can restart this computer/)).toBeVisible();
    expect(screen.getByText(/Only some resource details/)).toBeVisible();
    expect(screen.getByText(/Remote records are not fully synchronized/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resume service' })).toBeEnabled();
  });

  it('keeps interrupted-resume eligibility separate from disabled presentation and rejects incomplete evidence', () => {
    const data = resource();
    const original: LifecycleResource = { ...data, desired: 'enabled', observation: { ...data.observation!, observation: { ...data.observation!.observation, errorCode: 'resume_interrupted' } } };
    expect(lifecycleFacts(original, now, false)).toMatchObject({ disabled: false, resumeEligible: true, phase: 'blocked' });
    for (const change of [{ inventoryComplete: false }, { stop: 'unknown' as const }, { save: 'failed' as const }, { phase: 'resuming' as const }, { phase: 'blocked' as const }, { resourceCount: null }, { stoppedCount: 1 }, { pendingCount: 1 }, { blockedCount: 1 }]) {
      expect(lifecycleFacts({ ...original, observation: { ...original.observation!, observation: { ...original.observation!.observation, ...change } } }, now, false).resumeEligible).toBe(false);
    }
    expect(lifecycleFacts(original, now + 60_000, false).resumeEligible).toBe(false);
    expect(lifecycleFacts(original, now, true).resumeEligible).toBe(false);
    expect(lifecycleFacts({ ...original, observation: { ...original.observation!, intentVersion: '1' } }, now, false).resumeEligible).toBe(false);
    expect(lifecycleFacts({ ...original, admission: 'open' }, now, false).resumeEligible).toBe(false);
  });

  it('does not turn an accepted intent or an old observation into stopped execution', () => {
    const data = resource();
    state.snapshot = { ...data, intentVersion: '3', observation: data.observation };
    state.operationError = 'accepted';
    state.pending = { protocolVersion: 1, operationId: workerId(8), action: 'disable', expectedVersion: '2', source: 'web', localEpoch: null, originOperationId: null };
    show();
    expect(screen.getByText('Awaiting machine confirmation', { exact: true })).toBeVisible();
    expect(screen.getByText(/server accepted the intent/)).toBeVisible();
    expect(screen.queryByText(/You can restart this computer/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume service' })).toBeDisabled();
  });

  it('shows unknown inventory independently from a known zero inventory', () => {
    const data = resource();
    state.snapshot = { ...data, observation: { ...data.observation!, observation: { ...data.observation!.observation, inventoryComplete: false, resourceCount: null, stoppedCount: null, pendingCount: null, blockedCount: null, stop: 'unknown', save: 'pending', phase: 'blocked' } } };
    show();
    expect(screen.getByText('Managed resources: Unknown')).toBeVisible();
    expect(screen.getByText(/Resource inventory is incomplete/)).toBeVisible();
    expect(screen.queryByText('No managed execution in this complete observation.')).toBeNull();
    expect(screen.queryByText(/You can restart this computer/)).toBeNull();
  });

  it('retains explicit stale historical stages while withdrawing the current safe conclusion', () => {
    state.stale = true;
    show();
    expect(screen.getByText('Observation stale')).toBeVisible();
    expect(screen.getByText('Confirmed stopped')).toBeVisible();
    expect(screen.queryByText(/You can restart this computer/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume service' })).toBeDisabled();
  });

  it('checks an unknown operation without offering a second write', () => {
    state.pending = { protocolVersion: 1, operationId: workerId(8), action: 'disable', expectedVersion: '1', source: 'web', localEpoch: null, originOperationId: null };
    state.operationError = 'unknown';
    show(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check original operation' }));
    expect(state.check).toHaveBeenCalledOnce();
    expect(state.submit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Resume service' })).toBeDisabled();
  });

  it('withdraws the old disabled conclusion while a resume operation is pending or accepted', () => {
    state.pending = { protocolVersion: 1, operationId: workerId(8), action: 'resume', expectedVersion: '2', source: 'web', localEpoch: '1', instanceEpoch: '3' };
    state.operationError = 'accepted';
    const view = show();
    expect(screen.getByText('Resuming', { exact: true })).toBeVisible();
    expect(screen.queryByText('Disabled', { exact: true })).toBeNull();
    expect(screen.queryByText(/You can restart this computer/)).toBeNull();
    view.unmount(); state.operationError = 'unknown'; show();
    expect(screen.getByText('Awaiting machine confirmation', { exact: true })).toBeVisible();
    expect(screen.queryByText(/You can restart this computer/)).toBeNull();
  });

  it('distinguishes partial recovery from Worker availability', () => {
    const data = resource();
    state.snapshot = { ...data, desired: 'enabled', admission: 'open', observation: { ...data.observation!, observation: { ...data.observation!.observation, phase: 'accepting', recovery: [{ resourceId: workerId(33), recoverability: 'blocked', reasonCode: 'native_unrecoverable' }] } } };
    show();
    expect(screen.getByText('Accepting work', { exact: true })).toBeVisible();
    expect(screen.getByText(/Some executions remain blocked/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save and disable' })).toBeEnabled();
  });

  it('uses the shared confirmation dialog, describes scope and preserves cancel focus', () => {
    const data = resource();
    state.snapshot = { ...data, desired: 'enabled', admission: 'open' };
    show();
    const opener = screen.getByRole('button', { name: 'Save and disable' });
    opener.focus(); fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(dialog).getByText(/Task counts are not resource counts/)).toBeVisible();
    expect(within(dialog).getByText(/leases may expire/)).toBeVisible();
    expect(within(dialog).getByText(/does not shut down/)).toBeVisible();
    expect(within(dialog).getByText('Unknown', { exact: true })).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(state.submit).not.toHaveBeenCalled();
    fireEvent.click(opener); fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(state.submit).toHaveBeenCalledExactlyOnceWith('disable');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps both locale guarantees equivalent and requires confirmation for resume', () => {
    renderWithLocale(<WorkerLifecyclePanel worker={workerSummary()} readEnabled />, { locale: 'zh-CN' });
    fireEvent.click(screen.getByRole('button', { name: '恢复服务' }));
    expect(screen.getByRole('dialog', { name: '恢复服务' })).toBeVisible();
    expect(screen.getByText(/独立暂停、hold 和审批仍然有效/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(state.submit).toHaveBeenCalledExactlyOnceWith('resume');
  });

  it('withdraws write controls after confirmed access revocation or unavailable recovery storage', () => {
    state.error = new ApiError('server', 403, 'forbidden');
    const view = show();
    expect(screen.getByRole('button', { name: 'Resume service' })).toBeDisabled();
    expect(screen.queryByText(/You can restart this computer/)).toBeNull();
    view.unmount();
    state.error = null; state.operationError = 'storage';
    show();
    expect(screen.getByRole('button', { name: 'Resume service' })).toBeDisabled();
    expect(screen.getAllByText(/recovery storage is available/).length).toBeGreaterThan(0);
  });
});
