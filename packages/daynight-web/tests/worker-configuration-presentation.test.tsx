import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { pauseAuthRequests } from '../src/api/client';
import { browserNavigation } from '../src/app/navigation';
import { navigate } from '../src/app/router';
import type { WorkerConfigurationOutcome } from '../src/api/worker-configuration';
import { WorkerConfigurationPanel } from '../src/features/workers/configuration/WorkerConfigurationPanel';
import { useWorkerConfiguration } from '../src/features/workers/configuration/useWorkerConfiguration';
import { WorkerEditingPanels } from '../src/features/workers/configuration/WorkerEditingPanels';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { renderWithLocale } from './helpers/renderWithLocale';
import { configurationError, configurationResource, configurationResponse, configurationValue } from './helpers/worker-configuration';
import { wireResponse } from './helpers/wireJson';
import { WORKER_TIME, WORKER_USER, workerId, workerResponse } from './helpers/workers';

type ConfigurationFixtureProps = Omit<Parameters<typeof WorkerConfigurationPanel>[0], 'state' | 'confirming' | 'visible'>;
const ConfigurationFixture = (props: ConfigurationFixtureProps) => {
  const state = useWorkerConfiguration(props.workerId, { readEnabled: props.readEnabled });
  return <WorkerConfigurationPanel {...props} visible state={state} confirming={false} />;
};
const mount = () => renderWithLocale(<ConfigurationFixture workerId={workerId(1)} readEnabled online={null} tasks={[]} />, { locale: 'en', taskCache: { viewerId: WORKER_USER } });
const install = (response: () => Response) => {
  const fetch = vi.fn((url: string, _init: RequestInit = {}) => url.startsWith('/api/v1/projects?') ? wireResponse({ items: [], nextCursor: null }, { headers: { 'Daynight-User-ID': WORKER_USER } }) : url === `/api/v1/me/workers/${workerId(1)}/prompt` ? workerResponse({ scope: 'worker', scopeId: workerId(1), revision: '0', text: '', updatedAt: null }) : response());
  vi.stubGlobal('fetch', fetch); return fetch;
};

describe('configuration presentation', () => {
  it('holds a new save until the confirmed result is published and keeps the new edit', async () => {
    const put = Promise.withResolvers<Response>(), dispatched = Promise.withResolvers<void>();
    const enteringPublication = Promise.withResolvers<void>(), releasePublication = Promise.withResolvers<void>();
    const scope = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: vi.fn() });
    const ready = scope.ready.bind(scope), writes: Array<{ revision: string; value: { maxConcurrent: number } }> = [];
    const fetch = vi.fn((url: string, init: RequestInit = {}) => {
      if (url.startsWith('/api/v1/projects?')) return Promise.resolve(wireResponse({ items: [], nextCursor: null }, { headers: { 'Daynight-User-ID': WORKER_USER } }));
      if (url === `/api/v1/me/workers/${workerId(1)}/prompt`) return Promise.resolve(workerResponse({ scope: 'worker', scopeId: workerId(1), revision: '0', text: '', updatedAt: null }));
      if (init.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)) as { revision: string; value: { maxConcurrent: number } });
        if (writes.length === 1) { dispatched.resolve(); return put.promise; }
        return Promise.resolve(configurationResponse(configurationResource('3', { ...configurationValue(), maxConcurrent: 4 })));
      }
      return Promise.resolve(configurationResponse(configurationResource()));
    });
    vi.stubGlobal('fetch', fetch);
    const view = renderWithLocale(<ConfigurationFixture workerId={workerId(1)} readEnabled online={null} tasks={[]} />, { locale: 'en', taskCache: { scope } });
    try {
      const input = await screen.findByRole('textbox', { name: 'Concurrent task limit' });
      fireEvent.change(input, { target: { value: '3' } }); fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
      await act(async () => dispatched.promise);
      vi.spyOn(scope, 'ready').mockImplementationOnce(async signal => {
        enteringPublication.resolve();
        await Promise.race([releasePublication.promise, new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
      }).mockImplementation(ready);
      put.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 })));
      await act(async () => enteringPublication.promise);
      fireEvent.change(input, { target: { value: '4' } });
      const save = screen.getByRole('button', { name: 'Save configuration' });
      const discard = within(screen.getByRole('form', { name: 'Configuration' })).getByRole('button', { name: 'Discard changes' });
      expect(save).toBeDisabled(); expect(discard).toBeDisabled(); fireEvent.click(save); fireEvent.click(discard);
      expect(input).toHaveValue('4'); expect(writes).toHaveLength(1);
      await act(async () => { releasePublication.resolve(); for (let n = 0; n < 40; n++) await Promise.resolve(); });
      expect(input).toHaveValue('4'); expect(save).toBeEnabled();
      fireEvent.click(save);
      await act(async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); });
      expect(writes).toHaveLength(2); expect(writes[1]).toMatchObject({ revision: '2', value: { maxConcurrent: 4 } });
    } finally { view.unmount(); scope.dispose(); }
  });

  it('keeps an edit made after leaving while a confirmed save awaits publication', async () => {
    const put = Promise.withResolvers<Response>(), dispatched = Promise.withResolvers<void>();
    const enteringPublication = Promise.withResolvers<void>(), releasePublication = Promise.withResolvers<void>();
    const scope = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: vi.fn() });
    const ready = scope.ready.bind(scope), writes: Array<{ revision: string; value: { maxConcurrent: number } }> = [];
    const fetch = vi.fn((url: string, init: RequestInit = {}) => {
      if (url.startsWith('/api/v1/projects?')) return Promise.resolve(wireResponse({ items: [], nextCursor: null }, { headers: { 'Daynight-User-ID': WORKER_USER } }));
      if (url === `/api/v1/me/workers/${workerId(1)}/prompt`) return Promise.resolve(workerResponse({ scope: 'worker', scopeId: workerId(1), revision: '0', text: '', updatedAt: null }));
      if (init.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)) as { revision: string; value: { maxConcurrent: number } });
        if (writes.length === 1) { dispatched.resolve(); return put.promise; }
        return Promise.resolve(configurationResponse(configurationResource('3', { ...configurationValue(), maxConcurrent: 5 })));
      }
      return Promise.resolve(configurationResponse(configurationResource()));
    });
    vi.stubGlobal('fetch', fetch);
    act(() => browserNavigation().navigate(`/workers/${workerId(1)}`));
    const view = renderWithLocale(<WorkerEditingPanels id="worker-test" workerId={workerId(1)} section="configuration" readEnabled online={null} tasks={[]} onContinueEditing={() => {}} />, { locale: 'en', taskCache: { scope } });
    try {
      const input = await screen.findByRole('textbox', { name: 'Concurrent task limit' });
      fireEvent.change(input, { target: { value: '3' } }); fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
      await act(async () => dispatched.promise);
      vi.spyOn(scope, 'ready').mockImplementationOnce(async signal => {
        enteringPublication.resolve();
        await Promise.race([releasePublication.promise, new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
      }).mockImplementation(ready);
      put.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 })));
      await act(async () => enteringPublication.promise);
      fireEvent.change(input, { target: { value: '4' } });
      act(() => navigate('/projects')); expect(screen.getByRole('alertdialog')).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
      expect(input).toHaveValue('4');
      fireEvent.change(input, { target: { value: '5' } });
      await act(async () => { releasePublication.resolve(); for (let n = 0; n < 40; n++) await Promise.resolve(); });
      expect(input).toHaveValue('5');
      const save = screen.getByRole('button', { name: 'Save configuration' }); expect(save).toBeEnabled(); fireEvent.click(save);
      await act(async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); });
      expect(writes).toHaveLength(2); expect(writes[1]).toMatchObject({ revision: '2', value: { maxConcurrent: 5 } });
    } finally { view.unmount(); scope.dispose(); }
  });

  it('ends saving during a pause while retaining the editor and an unconfirmed result', async () => {
    const dispatched = Promise.withResolvers<void>();
    const fetch = vi.fn((url: string, init: RequestInit = {}) => {
      if (url.startsWith('/api/v1/projects?')) return Promise.resolve(wireResponse({ items: [], nextCursor: null }, { headers: { 'Daynight-User-ID': WORKER_USER } }));
      if (url === `/api/v1/me/workers/${workerId(1)}/prompt`) return Promise.resolve(workerResponse({ scope: 'worker', scopeId: workerId(1), revision: '0', text: '', updatedAt: null }));
      if (init.method === 'PUT') {
        dispatched.resolve();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal!;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return Promise.resolve(configurationResponse(configurationResource()));
    });
    vi.stubGlobal('fetch', fetch);
    const panel = (enabled: boolean) => <ConfigurationFixture workerId={workerId(1)} readEnabled={enabled} online={null} tasks={[]} />;
    const view = renderWithLocale(panel(true), { locale: 'en', taskCache: { viewerId: WORKER_USER } });
    const input = await screen.findByRole('textbox', { name: 'Concurrent task limit' });
    fireEvent.change(input, { target: { value: '3' } }); fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await act(async () => dispatched.promise); expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    const count = fetch.mock.calls.length; const resume = pauseAuthRequests(); view.rerender(panel(false));
    expect(await screen.findByText('The save result is not yet confirmed. Your draft has been kept.')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Concurrent task limit' })).toBe(input); expect(input).toHaveValue('3');
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled(); expect(fetch).toHaveBeenCalledTimes(count);
    fireEvent.change(input, { target: { value: '4' } }); expect(input).toHaveValue('4');
    resume(); view.rerender(panel(true));
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });

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
