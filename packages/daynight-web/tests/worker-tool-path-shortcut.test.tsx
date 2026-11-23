import { act, fireEvent, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserNavigation } from '../src/app/navigation';
import { WorkerDetailPage } from '../src/features/workers/WorkerDetailPage';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { renderWithLocale } from './helpers/renderWithLocale';
import { configurationResource, configurationResponse } from './helpers/worker-configuration';
import { toolPathConfiguration, toolPathTelemetry } from './helpers/worker-tool-paths';
import { WORKER_USER, workerDetail, workerId, workerResponse } from './helpers/workers';

vi.mock('../src/features/workers/WorkerLifecyclePanel', () => ({ WorkerLifecyclePanel: () => null }));

const target = workerId(1), other = workerId(2);
const scopes: TaskCacheScope[] = [];
const flush = () => act(async () => { for (let n = 0; n < 30; n++) { await Promise.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); } });
// JSDOM has no scrolling; the browser suite verifies focus and viewport placement.
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { for (const scope of scopes.splice(0)) scope.dispose(); });
const mount = async ({ delayed = false, supported = true, telemetry = true } = {}) => {
  const gate = Promise.withResolvers<void>();
  const writes: string[] = [];
  let requested = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method !== undefined && init.method !== 'GET' && !url.endsWith('/monitoring/query')) writes.push(`${init.method} ${url}`);
    if (url.startsWith('/api/v1/projects?')) return workerResponse({ items: [], nextCursor: null });
    if (url.endsWith('/review-participation')) return workerResponse(init.method === 'PUT' ? { enabled: true, version: '2' } : { enabled: false, version: '1' });
    if (url.endsWith('/configuration')) {
      if (url.includes(target) && delayed) { requested = true; await gate.promise; }
      const { toolPathsSupported: _tools, controlModeSupported: _mode, ...resource } = supported ? toolPathConfiguration() : configurationResource();
      const response = configurationResponse(resource);
      if (supported) { response.headers.set('Daynight-Worker-Tool-Paths', '2'); response.headers.set('Daynight-Worker-Control-Mode', '1'); }
      return response;
    }
    if (url.endsWith('/prompt')) return workerResponse({ scope: 'worker', scopeId: target, revision: '0', text: '', updatedAt: null });
    if (url.endsWith('/monitoring/query')) return workerResponse({ observedAt: workerDetail().observedAt, items: [] });
    const detail = workerDetail(url.includes(other) ? 2 : 1);
    if (telemetry) detail.worker.telemetry.toolPaths = toolPathTelemetry();
    const response = workerResponse(detail); response.headers.set('Daynight-Worker-Tool-Paths', '2'); return response;
  }));
  const scope = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const view = (id: string, active = true) => <StrictMode><TaskCacheProvider scope={scope}><WorkerDetailPage workerId={id} userId={WORKER_USER} readEnabled active={active} /></TaskCacheProvider></StrictMode>;
  browserNavigation().navigate(`/workers/${target}`);
  const rendered = renderWithLocale(view(target), { locale: 'en' }); await flush();
  fireEvent.click(screen.getByRole('tab', { name: 'System monitoring' }));
  return { writes, setActive: async (active: boolean) => { rendered.rerender(view(target, active)); await flush(); }, requested: () => requested, resolve: async () => { gate.resolve(); await flush(); }, switchWorker: async (id: string, active = true) => {
    act(() => { browserNavigation().navigate(`/workers/${id}`); rendered.rerender(view(id, active)); }); await flush();
  } };
};
const shortcut = () => screen.getByRole('button', { name: 'Tool paths' });
const summary = () => screen.getByText('Tool paths', { selector: 'summary' });

describe('Worker software tool path shortcut', () => {
  it('waits for the first configuration read, then opens the actual fields', async () => {
    const state = await mount({ delayed: true });
    fireEvent.click(shortcut()); await flush();
    expect(screen.getByRole('tab', { name: 'Configuration' })).toHaveAttribute('aria-selected', 'true');
    expect(state.requested()).toBe(true); expect(screen.queryByText('Tool paths', { selector: 'summary' })).toBeNull();
    await state.resolve();
    expect(summary().closest('details')).toHaveAttribute('open');
    expect(screen.getByRole('textbox', { name: 'Codex' })).toBeVisible();
    expect(state.writes).toEqual([]);
  });

  it('preserves raw drafts and does not reopen a manually collapsed section after refresh', async () => {
    const state = await mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' })); await flush();
    const prompt = screen.getByRole('textbox', { name: 'Prompt text' });
    fireEvent.change(prompt, { target: { value: 'unsaved Worker instructions' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    const input = screen.getByRole('textbox', { name: 'Concurrent task limit' });
    fireEvent.change(input, { target: { value: '-' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime monitoring' }));
    fireEvent.click(screen.getByRole('tab', { name: 'System monitoring' }));
    fireEvent.click(shortcut()); await flush();
    expect(screen.getByRole('textbox', { name: 'Concurrent task limit' })).toBe(input);
    expect(input).toHaveValue('-'); expect(summary().closest('details')).toHaveAttribute('open');
    summary().closest('details')!.open = false;
    fireEvent.click(within(screen.getByRole('tabpanel', { name: 'Configuration' })).getByRole('button', { name: 'Refresh' })); await flush();
    expect(summary().closest('details')).not.toHaveAttribute('open'); expect(input).toHaveValue('-');
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime monitoring' })); fireEvent.click(screen.getByRole('tab', { name: 'System monitoring' })); fireEvent.click(shortcut()); await flush();
    expect(summary().closest('details')).toHaveAttribute('open'); expect(state.writes).toEqual([]);
    fireEvent.click(screen.getByRole('tab', { name: 'Prompts' })); await flush();
    expect(screen.getByRole('textbox', { name: 'Prompt text' })).toBe(prompt); expect(prompt).toHaveValue('unsaved Worker instructions');
  });

  it.each([{ supported: true, telemetry: false }])('reveals existing capability explanations for %j', async options => {
    const state = await mount(options); fireEvent.click(shortcut()); await flush();
    const details = summary().closest('details')!;
    expect(details).toHaveAttribute('open');
    expect(details.querySelector('#config-tool-paths-unavailable')).toBeVisible();
    expect(within(details).getByRole('textbox', { name: 'Codex' })).toBeDisabled();
    expect(state.writes).toEqual([]);
  });

  it('retires an outstanding request across Worker changes, including a return to the original Worker', async () => {
    const state = await mount({ delayed: true }); fireEvent.click(shortcut()); await flush(); expect(state.requested()).toBe(true);
    await state.switchWorker(other);
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    expect(summary().closest('details')).not.toHaveAttribute('open');
    await state.resolve(); expect(summary().closest('details')).not.toHaveAttribute('open');
    await state.switchWorker(target); fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    expect(summary().closest('details')).not.toHaveAttribute('open'); expect(state.writes).toEqual([]);
  });

  it('does not reveal a retained inactive Worker when its delayed configuration arrives', async () => {
    const state = await mount({ delayed: true }); fireEvent.click(shortcut()); await flush();
    await state.setActive(false); await state.resolve();
    expect(summary().closest('details')).not.toHaveAttribute('open');
    await state.setActive(true); expect(summary().closest('details')).not.toHaveAttribute('open');
    expect(state.writes).toEqual([]);
  });

  it('pauses review participation on an inactive retained Worker without affecting configuration', async () => {
    const state = await mount(); fireEvent.click(shortcut()); await flush();
    const control = screen.getByRole('switch', { name: 'Participate in PR review' });
    expect(control).toHaveAttribute('aria-disabled', 'false');
    await state.setActive(false);
    expect(control).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(control); await flush(); expect(state.writes).toEqual([]);
    expect(summary().closest('details')).toBeInTheDocument();
    await state.setActive(true); expect(control).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(control); await flush();
    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(state.writes).toEqual([`PUT /api/v1/me/workers/${target}/review-participation`]);
  });

  it('cancels delayed navigation when the user chooses another tab', async () => {
    const state = await mount({ delayed: true }); fireEvent.click(shortcut()); await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime monitoring' })); await state.resolve();
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' })); await flush();
    expect(summary().closest('details')).not.toHaveAttribute('open');
  });
});
