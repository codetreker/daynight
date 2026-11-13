import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerConfigurationResource, WorkerConfigurationValue } from '../src/api/worker-configuration';
import { WorkerEditingPanels } from '../src/features/workers/configuration/WorkerEditingPanels';
import { renderWithLocale } from './helpers/renderWithLocale';
import { configurationResponse } from './helpers/worker-configuration';
import { toolPathConfiguration, toolPathTelemetry } from './helpers/worker-tool-paths';
import { WORKER_USER, workerId, workerResponse } from './helpers/workers';

const flush = () => act(async () => { for (let n = 0; n < 60; n++) { await Promise.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); } });
const setup = (initial = toolPathConfiguration()) => {
  let resource: WorkerConfigurationResource = initial;
  const writes: WorkerConfigurationValue[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    if (url.startsWith('/api/v1/projects?')) return workerResponse({ items: [], nextCursor: null });
    if (url.endsWith('/prompt')) return workerResponse({ scope: 'worker', scopeId: workerId(1), revision: '0', text: '', updatedAt: null });
    if (init.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { value: WorkerConfigurationValue };
      writes.push(body.value);
      resource = { ...resource, desired: { ...resource.desired!, revision: '2', value: body.value } };
    }
    const { controlModeSupported: _mode, toolPathsSupported: _tools, ...wire } = resource;
    const response = configurationResponse(wire);
    response.headers.set('Daynight-Worker-Control-Mode', '1');
    response.headers.set('Daynight-Worker-Tool-Paths', '1');
    return response;
  }));
  return writes;
};
const mount = (supported = true) => renderWithLocale(<WorkerEditingPanels id="worker-tool-path-test" workerId={workerId(1)} section="configuration" onContinueEditing={() => {}} readEnabled online tasks={[]} platform="macos" {...(supported ? { toolPaths: toolPathTelemetry() } : {})} />, { locale: 'en', taskCache: { viewerId: WORKER_USER } });
const expand = () => {
  const summary = screen.getByText('Tool paths', { selector: 'summary' });
  fireEvent.click(summary);
  const details = summary.closest('details')!;
  details.open = true;
  return within(details);
};

describe('Worker tool path configuration fields', () => {
  it('starts collapsed, preserves unadopted tools and saves an explicit path through the existing form', async () => {
    const writes = setup(toolPathConfiguration('1', { codex: null, copilot: null, herdr: null }));
    mount(); await flush();
    expect(screen.getByText('Tool paths', { selector: 'summary' }).closest('details')).not.toHaveAttribute('open');
    const fields = expand();
    expect(fields.getByRole('textbox', { name: 'Codex' })).toHaveAttribute('placeholder', 'Waiting for Worker import');
    fireEvent.change(fields.getByRole('textbox', { name: 'Codex' }), { target: { value: '/opt/My Tools/工具/codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' })); await flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.toolPaths).toEqual({ codex: { kind: 'path', path: '/opt/My Tools/工具/codex' }, copilot: null, herdr: null });
    expect(fields.queryByText('Applied', { selector: '.status-chip' })).not.toBeInTheDocument();
  });
  it('requires an explicit reset for auto and keeps an emptied path invalid until cancelled', async () => {
    setup(); mount(); await flush(); const fields = expand();
    const input = fields.getByRole('textbox', { name: 'Codex' });
    fireEvent.change(input, { target: { value: '/tools/new-codex' } });
    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
    fireEvent.click(fields.getAllByRole('button', { name: 'Restore automatic' })[0]!);
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '/tools/new-codex' } });
    fireEvent.click(within(document.querySelector<HTMLElement>('.config-save-bar')!).getByRole('button', { name: 'Discard changes' }));
    expect(input).toHaveValue('');
    expect(input.closest('details')).toHaveAttribute('open');
  });
  it('disables path editing when the Worker has not reported the capability', async () => {
    setup(); mount(false); await flush(); const fields = expand();
    for (const name of ['Codex', 'Copilot', 'Herdr']) expect(fields.getByRole('textbox', { name })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Concurrent task limit' })).toBeEnabled();
  });
});
