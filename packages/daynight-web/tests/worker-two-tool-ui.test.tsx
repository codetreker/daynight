import { act, fireEvent, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WorkerEditingPanels } from '../src/features/workers/configuration/WorkerEditingPanels';
import { renderWithLocale } from './helpers/renderWithLocale';
import { toolPathTelemetry } from './helpers/worker-tool-paths';
import { WORKER_USER, workerId, workerResponse } from './helpers/workers';

const flush = () => act(async () => { for (let n = 0; n < 60; n++) { await Promise.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); } });
const time = '2026-10-29T12:00:00Z';
const tools = { codex: { kind: 'auto' }, copilot: { kind: 'auto' }, herdr: { kind: 'auto' } };
const initial = { maxConcurrent: 2, pollIntervalMs: 60000, recoveryLimit: 3, preferPlatformSpecificTasks: false,
  agentControlMode: 'herdr', toolPaths: tools, archiveSessions: true, enableSudoCleanup: false,
  native: { agent: 'codex', model: null, args: [] }, projects: [] };

it('shows unsupported raw fields, leaves them untouched on discard and replaces only on explicit save', async () => {
  let value: Record<string, unknown> = structuredClone(initial), revision = '1';
  const writes: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    if (url.startsWith('/api/v1/projects?')) return workerResponse({ items: [], nextCursor: null });
    if (url.endsWith('/prompt')) return workerResponse({ scope: 'worker', scopeId: workerId(1), revision: '0', text: '', updatedAt: null });
    if (init.method === 'PUT') { value = JSON.parse(String(init.body)).value; writes.push(value); revision = '2'; }
    return new Response(JSON.stringify({ desired: { revision, updatedAt: time, value }, observationRevision: '0', observation: null }), { headers: {
      'Content-Type': 'application/json', 'Daynight-User-ID': WORKER_USER, 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Tool-Paths': '2', 'Daynight-Worker-Archive-Sessions': '1',
    } });
  }));
  renderWithLocale(<WorkerEditingPanels id="config" workerId={workerId(1)} section="configuration" onContinueEditing={() => {}} readEnabled online tasks={[]} platform="linux" toolPaths={toolPathTelemetry()} />, { locale: 'en', taskCache: { viewerId: WORKER_USER } });
  await flush();
  expect(screen.getByText('The saved configuration contains unsupported or missing fields.')).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Control mode' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: 'Concurrent task limit' }), { target: { value: '4' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(writes).toHaveLength(0);
  expect(value).toEqual(initial);
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
  await flush();
  expect(writes).toEqual([{ ...initial, agentControlMode: undefined, toolPaths: { codex: tools.codex, copilot: tools.copilot } }].map(entry => JSON.parse(JSON.stringify(entry))));
  expect(screen.queryByText('The saved configuration contains unsupported or missing fields.')).toBeNull();
});
