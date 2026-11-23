import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import { configurationBaseline, mergeConfigurationDraft, unsupportedConfigurationFields } from '../src/api/configuration-source';
import { getWorkerConfiguration, saveWorkerConfiguration, workerConfigurationBaseline } from '../src/api/worker-configuration';
import { parseToolPathTelemetry } from '../src/api/worker-tool-paths';

const worker = '00000001-1111-4111-8111-111111111111';
const user = 'ffffffff-1111-4111-8111-111111111111';
const time = '2026-10-29T12:00:00Z';
const tools = { codex: { kind: 'auto' }, copilot: { kind: 'auto' } } as const;
const original = { maxConcurrent: 2, pollIntervalMs: 60000, recoveryLimit: 3, preferPlatformSpecificTasks: false,
  agentControlMode: 'herdr', toolPaths: { ...tools, herdr: { kind: 'auto' } }, archiveSessions: true, enableSudoCleanup: false,
  native: { agent: 'codex', model: null, args: [] }, projects: [], future: { exact: 123 } };
const resource = (value: unknown, revision = '1') => ({ desired: { revision, updatedAt: time, value }, observationRevision: '0', observation: null });
const response = (value: unknown, toolVersion = '2') => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': user,
  'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Tool-Paths': toolVersion, 'Daynight-Worker-Archive-Sessions': '1' } });
const admission = { userId: user, onPrincipalMismatch: vi.fn() };
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe('two-tool Worker contract', () => {
  it('retains the raw target until explicit replacement and sends the corrected full candidate', async () => {
    const saved = { ...original, toolPaths: tools } as Record<string, unknown>;
    delete saved.agentControlMode;
    const fetch = vi.fn().mockResolvedValueOnce(response(resource(original))).mockResolvedValueOnce(response(resource(saved, '2')));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const read = await getWorkerConfiguration(worker, signal, admission);
    const baseline = workerConfigurationBaseline(read)!;
    expect(JSON.parse(baseline.valueSource)).toEqual(original);
    expect(unsupportedConfigurationFields(baseline.valueSource)).toEqual(['agentControlMode', 'toolPaths.herdr']);
    const candidate = mergeConfigurationDraft(baseline, read.desired!.value);
    expect(JSON.parse(candidate.valueSource)).toEqual(saved);
    await saveWorkerConfiguration(worker, '1', candidate, signal, { ...admission, toolPathsSupported: true, archiveSessionsSupported: true });
    const [get, put] = fetch.mock.calls;
    expect(new Headers(get![1].headers).get('Daynight-Worker-Tool-Paths')).toBe('2');
    expect(new Headers(put![1].headers).get('Daynight-Worker-Tool-Paths')).toBe('2');
    expect(new Headers(put![1].headers).has('Daynight-Worker-Control-Mode')).toBe(false);
    expect(JSON.parse(put![1].body).value).toEqual(saved);
  });
  it('presents missing legacy tool choices for explicit adoption without changing the saved source', async () => {
    const { toolPaths: _old, agentControlMode: _mode, ...old } = original;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(resource(old))));
    const read = await getWorkerConfiguration(worker, new AbortController().signal, admission);
    const baseline = configurationBaseline(read.document!)!;
    expect(JSON.parse(baseline.valueSource)).toEqual(old);
    expect(read.desired!.value.toolPaths).toEqual({ codex: null, copilot: null });
    expect(unsupportedConfigurationFields(baseline.valueSource)).toEqual(['toolPaths']);
    expect(JSON.parse(mergeConfigurationDraft(baseline, read.desired!.value).valueSource).toolPaths).toEqual({ codex: null, copilot: null });
  });
  it('requires an exact version echo and rejects former tool contexts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(resource(original), '1')));
    await expect(getWorkerConfiguration(worker, new AbortController().signal, admission)).rejects.toMatchObject({ kind: 'protocol', code: 'worker_tool_paths_upgrade' });
    const entry = { tool: 'codex', context: 'herdr', configurationSource: 'cloud', targetRevision: '1', target: { kind: 'auto' }, state: 'not_checked', reason: null, actual: null, candidate: null, activeSelectionCount: 0, activeSelectionsComplete: true, activeObservationError: null, activeSelections: [], error: null };
    expect(() => parseToolPathTelemetry({ schemaVersion: 1, observedAt: time, entries: [entry] })).toThrow();
  });
});
