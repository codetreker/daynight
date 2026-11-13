import { expect, type Page } from '@playwright/test';
import type { WorkerConfigurationOutcome, WorkerConfigurationResource, WorkerConfigurationValue } from '../../src/api/worker-configuration';
import type { Tool, ToolContext, ToolPathActual, ToolPathChoice, ToolPathObservation, ToolPathTelemetry } from '../../src/api/worker-tool-paths';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId, workerPage } from '../helpers/workers';
import { configurationResource, configurationValue } from '../helpers/worker-configuration';

export const targetWorker = workerId(1);
export const toolPaths = { codex: { kind: 'auto' }, copilot: { kind: 'auto' }, herdr: { kind: 'auto' } } as const;
export const toolActual = (tool: Tool, context: ToolContext, overrides: Partial<ToolPathActual> = {}): ToolPathActual => ({
  selection: { kind: 'auto' }, selectionKey: (tool === 'codex' ? '1' : tool === 'copilot' ? '2' : '3').repeat(64),
  entryPath: tool === 'copilot' && context === 'web' ? '/opt/daynight/runtime/copilot' : `/opt/installed/bin/${tool}`,
  executablePath: tool === 'copilot' && context === 'web' ? '/opt/daynight/runtime/copilot' : `/opt/installed/bin/${tool}`,
  interpreterPath: null, source: tool === 'copilot' && context === 'web' ? 'bundled' : 'path',
  version: tool === 'codex' ? '0.166.0' : tool === 'copilot' ? '1.0.105' : '0.9.5', checkedAt: WORKER_TIME, ...overrides,
});
export const toolObservation = (tool: Tool, context: ToolContext, overrides: Partial<ToolPathObservation> = {}): ToolPathObservation => ({
  tool, context, configurationSource: 'cloud', targetRevision: '1', target: { kind: 'auto' }, state: 'applied', reason: null,
  actual: toolActual(tool, context), candidate: null, activeSelectionCount: 0, activeSelectionsComplete: true, activeObservationError: null, activeSelections: [], error: null, ...overrides,
});
export const toolReport = (entries = [toolObservation('codex', 'web'), toolObservation('codex', 'herdr'), toolObservation('copilot', 'web'), toolObservation('copilot', 'herdr'), toolObservation('herdr', 'herdr')]): ToolPathTelemetry => ({ schemaVersion: 1, observedAt: WORKER_TIME, entries });
export const observedConfiguration = (revision = '1', value: WorkerConfigurationValue = { ...configurationValue(), agentControlMode: 'web', toolPaths }): WorkerConfigurationResource => {
  const items = (['maxConcurrent', 'pollIntervalMs', 'recoveryLimit', 'preferPlatformSpecificTasks', 'native', 'agentControlMode'] as const)
    .map(kind => ({ key: { kind }, appliedValue: value[kind], targetRevision: revision, state: 'applied', error: null, lastFailure: null, nextAttemptAt: null }) as WorkerConfigurationOutcome);
  return { ...configurationResource(revision, value), observationRevision: '1', observation: { baseRevision: '0', desiredRevision: revision, reportedAt: WORKER_TIME, items } };
};
export const pathChoice = (path: string): Extract<ToolPathChoice, { kind: 'path' }> => ({ kind: 'path', path });
export const reportedDetail = (report: ToolPathTelemetry | undefined = toolReport()) => {
  const detail = workerDetail();
  return { ...detail, worker: { ...detail.worker, telemetry: { ...detail.worker.telemetry, ...(report === undefined ? {} : { toolPaths: report }) } } };
};
export const deferredRead = () => {
  let release = () => {}, started = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { started = resolve; });
  return { promise, observed, release, started };
};
export const installTools = async (page: Page, options: { service?: boolean; worker?: boolean; resource?: WorkerConfigurationResource; locale?: 'zh-CN' | 'en' } = {}) => {
  const service = options.service !== false;
  const state = {
    resource: options.resource ?? observedConfiguration(), detail: options.worker === false ? workerDetail() : reportedDetail(),
    writes: [] as { revision: string; value: WorkerConfigurationValue }[], events: [] as string[],
    configurationGate: null as ReturnType<typeof deferredRead> | null,
    workerGate: null as ReturnType<typeof deferredRead> | null,
    mode: 'success' as 'success' | 'conflict' | 'unknown', unknownReads: false,
    configurationReads: 0, workerReads: 0,
  };
  const personal = { id: workerId(90), kind: 'personal', name: null };
  await page.addInitScript(locale => localStorage.setItem('daynight.web.locale', locale), options.locale ?? 'zh-CN');
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': WORKER_USER, ...headers } });
    if (path === '/api/v1/me') return send({ id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects' || path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/workers') return send(workerPage());
    if (path === '/api/v1/me/workers/monitoring/query') {
      const { workerIds } = request.postDataJSON() as { workerIds: string[] };
      return send({ observedAt: WORKER_TIME, items: workerIds.map(workerId => ({ workerId, state: 'absent', revision: null, receivedAt: null, expiresAt: null, summary: null })) });
    }
    if (path === `/api/v1/me/workers/${targetWorker}`) {
      state.workerReads++;
      if (state.workerGate !== null) { state.workerGate.started(); await state.workerGate.promise; }
      const detail = structuredClone(state.detail);
      if (!service) delete (detail.worker.telemetry as { toolPaths?: unknown }).toolPaths;
      return send(detail, 200, service ? { 'Daynight-Worker-Tool-Paths': '1' } : {});
    }
    if (path === `/api/v1/me/workers/${targetWorker}/prompt`) return send({ scope: 'worker', scopeId: targetWorker, revision: '0', text: '', updatedAt: null });
    if (path === `/api/v1/me/workers/${targetWorker}/configuration`) {
      const toolsNegotiated = service && request.headers()['daynight-worker-tool-paths'] === '1';
      state.events.push(request.method());
      if (request.method() === 'PUT') {
        state.writes.push(request.postDataJSON());
        if (state.mode === 'conflict') {
          state.resource = observedConfiguration('2', { ...state.resource.desired!.value, recoveryLimit: 9 });
          return send({ error: { code: 'version_conflict', message: 'Changed', requestId: 'tool-paths' } }, 409);
        }
        const value = request.postDataJSON().value as WorkerConfigurationValue;
        state.resource = { ...state.resource, desired: { revision: String(BigInt(state.resource.desired!.revision) + 1n), value: toolsNegotiated ? value : { ...value, ...(state.resource.desired!.value.toolPaths === undefined ? {} : { toolPaths: state.resource.desired!.value.toolPaths }) }, updatedAt: WORKER_TIME } };
        if (state.mode === 'unknown') { state.unknownReads = true; return route.abort('failed'); }
      } else {
        state.configurationReads++;
        if (state.unknownReads) return route.abort('failed');
        if (state.configurationGate !== null) { state.configurationGate.started(); await state.configurationGate.promise; }
      }
      const resource = structuredClone(state.resource);
      if (!toolsNegotiated && resource.desired !== null) delete (resource.desired.value as { toolPaths?: unknown }).toolPaths;
      return send(resource, 200, { 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Control-Mode': '1', ...(toolsNegotiated ? { 'Daynight-Worker-Tool-Paths': '1' } : {}) });
    }
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'tool-paths' } }, 404);
  });
  return state;
};
export const openToolConfiguration = async (page: Page) => {
  await page.goto(`/workers/${targetWorker}`);
  await page.locator('[data-worker-tab="configuration"]:visible').click();
  await expect(page.locator('#config-maxConcurrent')).toHaveValue('2');
};
