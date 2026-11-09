import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerConfigurationOutcome } from '../src/api/worker-configuration';
import { WorkerConfigurationPanel } from '../src/features/workers/configuration/WorkerConfigurationPanel';
import { renderWithLocale } from './helpers/renderWithLocale';
import { configurationError, configurationResource, configurationResponse, configurationValue } from './helpers/worker-configuration';
import { wireResponse } from './helpers/wireJson';
import { WORKER_TIME, WORKER_USER, workerId, workerResponse } from './helpers/workers';

const mount = () => renderWithLocale(<WorkerConfigurationPanel workerId={workerId(1)} readEnabled online={null} tasks={[]} />, { locale: 'en', taskCache: { viewerId: WORKER_USER } });
const install = (response: () => Response) => {
  const fetch = vi.fn((url: string, _init: RequestInit = {}) => url.startsWith('/api/v1/projects?') ? wireResponse({ items: [], nextCursor: null }, { headers: { 'Daynight-User-ID': WORKER_USER } }) : url === `/api/v1/me/workers/${workerId(1)}/prompt` ? workerResponse({ scope: 'worker', scopeId: workerId(1), revision: '0', text: '', updatedAt: null }) : response());
  vi.stubGlobal('fetch', fetch); return fetch;
};

describe('configuration presentation', () => {
  it('keeps uninitialized configuration read-only without inventing target settings', async () => {
    const fetch = install(() => configurationResponse({ desired: null, observationRevision: '0', observation: null }));
    mount();
    expect(await screen.findByText('Configuration management is not connected')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Concurrent task limit' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Save configuration' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(fetch.mock.calls.every(([, options]) => options?.method === undefined)).toBe(true);
  });

  it('does not claim a retained draft on initial read failure and recovers through a deliberate refresh', async () => {
    let failed = true;
    install(() => failed ? configurationError(500, 'internal_error') : configurationResponse(configurationResource()));
    mount();
    expect(await screen.findByText('Configuration could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('Your draft has been kept.')).toBeNull(); expect(screen.queryByRole('textbox', { name: 'Concurrent task limit' })).toBeNull();
    failed = false; fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('textbox', { name: 'Concurrent task limit' })).toHaveValue('2');
  });

  it('retains the invalid raw draft, focused node and selection across locale changes', async () => {
    const fetch = install(() => configurationResponse(configurationResource()));
    const view = mount();
    const input = await screen.findByRole('textbox', { name: 'Startup arguments' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '["unfinished' } }); input.focus(); input.setSelectionRange(2, 6);
    const count = fetch.mock.calls.length; view.setLocale('zh-CN');
    expect(screen.getByRole('textbox', { name: '启动参数' })).toBe(input); expect(input).toHaveValue('["unfinished'); expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(6); expect(fetch.mock.calls).toHaveLength(count);
    expect(screen.getByRole('button', { name: '保存配置' })).toBeDisabled();
    expect(screen.getByText('请输入 JSON 字符串数组；每个参数必须非空且不含控制字符。')).toBeInTheDocument();
  });

  it('keeps a new empty-project target awaiting observation even when global actual values are unchanged', async () => {
    const value = configurationValue();
    const items: readonly WorkerConfigurationOutcome[] = [
      { key: { kind: 'maxConcurrent' }, appliedValue: value.maxConcurrent },
      { key: { kind: 'pollIntervalMs' }, appliedValue: value.pollIntervalMs },
      { key: { kind: 'recoveryLimit' }, appliedValue: value.recoveryLimit },
      { key: { kind: 'native' }, appliedValue: value.native },
    ].map(item => ({ ...item, targetRevision: '1', state: 'applied', error: null, lastFailure: null, nextAttemptAt: null } as WorkerConfigurationOutcome));
    install(() => configurationResponse({ ...configurationResource('2'), observationRevision: '1', observation: { baseRevision: '0', desiredRevision: '1', items, reportedAt: WORKER_TIME } }));
    mount();
    const summary = (await screen.findByRole('heading', { name: 'Configuration status' })).closest('section')!;
    expect(within(summary).getByText('Awaiting application')).toBeInTheDocument(); expect(within(summary).queryByText('Applied')).toBeNull();
  });

  it('keeps the actual native failure visible while editing a replacement draft', async () => {
    const value = configurationValue();
    const error = { code: 'invalid_configuration' as const, category: 'agent' as const, phase: 'validate' as const, occurredAt: WORKER_TIME };
    install(() => configurationResponse({ ...configurationResource(), observationRevision: '1', observation: { baseRevision: '0', desiredRevision: '1', reportedAt: WORKER_TIME, items: [{ key: { kind: 'native' }, targetRevision: '1', appliedValue: value.native, state: 'error', error, lastFailure: null, nextAttemptAt: WORKER_TIME }] } }));
    mount();
    const model = await screen.findByRole('textbox', { name: 'Model' });
    expect(screen.getByText(/Validation · Invalid configuration/)).toBeInTheDocument();
    fireEvent.change(model, { target: { value: 'replacement-model' } });
    expect(screen.getByText(/Validation · Invalid configuration/)).toBeInTheDocument(); expect(screen.getByText('Unsaved')).toBeInTheDocument();
  });
});
