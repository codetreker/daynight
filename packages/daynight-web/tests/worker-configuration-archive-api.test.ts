import { afterEach, describe, expect, it, vi } from 'vitest';
import { configurationBaselinesCompatible, enrichConfigurationBaseline, mergeConfigurationDraft } from '../src/api/configuration-source';
import { getWorkerConfiguration, parseWorkerConfiguration, saveWorkerConfiguration, workerConfigurationBaseline } from '../src/api/worker-configuration';
import { invalidateAuthRequests } from '../src/api/client';
import { configurationResource, configurationValue } from './helpers/worker-configuration';
import { WORKER_TIME, WORKER_USER, workerId } from './helpers/workers';

const admission = { userId: WORKER_USER, onPrincipalMismatch: vi.fn() };
const signal = () => new AbortController().signal;
const capability = { controlMode: false, toolPaths: false, archiveSessions: true };
const response = (resource: unknown, archiveHeader?: string) => new Response(JSON.stringify(resource), { headers: {
  'Content-Type': 'application/json', 'Daynight-User-ID': WORKER_USER, 'Daynight-Worker-Configuration': '1',
  ...(archiveHeader === undefined ? {} : { 'Daynight-Worker-Archive-Sessions': archiveHeader }),
} });
const resource = (archiveSessions: boolean, revision = '1') => configurationResource(revision, { ...configurationValue(), archiveSessions });
const observed = (appliedValue: unknown, state = 'applied') => ({ ...resource(false), observationRevision: '1', observation: {
  baseRevision: '0', desiredRevision: '1', items: [{ key: { kind: 'archiveSessions' }, targetRevision: '1', appliedValue, state, error: null, lastFailure: null, nextAttemptAt: null }], reportedAt: WORKER_TIME,
} });
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe('archive configuration negotiation', () => {
  it('strictly parses both booleans, nullable pending observations and negotiated projection', () => {
    for (const value of [true, false]) {
      expect(parseWorkerConfiguration(observed(value), capability).desired?.value.archiveSessions).toBe(false);
      expect(parseWorkerConfiguration(observed(value), capability).observation?.items[0]?.appliedValue).toBe(value);
    }
    expect(parseWorkerConfiguration(observed(null, 'pending'), capability).observation?.items[0]?.appliedValue).toBeNull();
    for (const value of [null, 0, 'false', undefined]) {
      expect(() => parseWorkerConfiguration({ ...resource(false), desired: { ...resource(false).desired, value: { ...configurationValue(), archiveSessions: value } } }, capability)).toThrow();
      if (value !== null) expect(() => parseWorkerConfiguration(observed(value), capability)).toThrow();
    }
    expect(() => parseWorkerConfiguration(observed(null), capability)).toThrow();
    expect(() => parseWorkerConfiguration(resource(false))).toThrow();
    expect(() => parseWorkerConfiguration({ ...observed(false), desired: configurationResource().desired })).toThrow();
  });

  it('requests a capability and preserves false in read and full PUT', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(observed(false), '1')).mockResolvedValueOnce(response(resource(false, '2'), '1'));
    vi.stubGlobal('fetch', fetch);
    const current = await getWorkerConfiguration(workerId(1), signal(), admission);
    expect(current.archiveSessionsSupported).toBe(true);
    const baseline = workerConfigurationBaseline(current)!;
    const submission = mergeConfigurationDraft(baseline, { ...baseline.known, maxConcurrent: 3 });
    // The response must match the complete submitted value, including false.
    fetch.mockReset().mockResolvedValue(response(configurationResource('2', { ...configurationValue(), maxConcurrent: 3, archiveSessions: false }), '1'));
    const saved = await saveWorkerConfiguration(workerId(1), '1', submission, signal(), { ...admission, archiveSessionsSupported: true });
    expect(saved.desired?.value.archiveSessions).toBe(false);
    const init = fetch.mock.calls[0]![1];
    expect(new Headers(init.headers).get('Daynight-Worker-Archive-Sessions')).toBe('1');
    expect(JSON.parse(init.body).value.archiveSessions).toBe(false);
  });

  it('handles unsupported service and rejects inconsistent capability replies', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(configurationResource())).mockResolvedValueOnce(response(configurationResource(), 'bad'));
    vi.stubGlobal('fetch', fetch);
    const old = await getWorkerConfiguration(workerId(1), signal(), admission);
    expect(new Headers(fetch.mock.calls[0]![1].headers).get('Daynight-Worker-Archive-Sessions')).toBe('1');
    expect(old.archiveSessionsSupported).toBeUndefined();
    await expect(getWorkerConfiguration(workerId(1), signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
    fetch.mockReset().mockResolvedValue(response(configurationResource('2')));
    await expect(saveWorkerConfiguration(workerId(1), '1', { ...configurationValue(), archiveSessions: false }, signal(), { ...admission, archiveSessionsSupported: true })).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('enriches same-revision projections and omits the extension for an unsupported write', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(configurationResource())).mockResolvedValueOnce(response(resource(false), '1'));
    vi.stubGlobal('fetch', fetch);
    const old = workerConfigurationBaseline(await getWorkerConfiguration(workerId(1), signal(), admission))!;
    const current = workerConfigurationBaseline(await getWorkerConfiguration(workerId(1), signal(), admission))!;
    expect(configurationBaselinesCompatible(old, current)).toBe(true);
    const enriched = enrichConfigurationBaseline(old, current);
    expect(enriched.known.archiveSessions).toBe(false);
    expect(JSON.parse(mergeConfigurationDraft(enriched, { ...enriched.known, maxConcurrent: 4 }).valueSource).archiveSessions).toBe(false);
    fetch.mockReset().mockResolvedValue(response(configurationResource('2', { ...configurationValue(), maxConcurrent: 4 })));
    await saveWorkerConfiguration(workerId(1), '1', mergeConfigurationDraft(enriched, { ...enriched.known, maxConcurrent: 4 }), signal(), admission);
    const init = fetch.mock.calls[0]![1];
    expect(new Headers(init.headers).has('Daynight-Worker-Archive-Sessions')).toBe(false);
    expect(JSON.parse(init.body).value).not.toHaveProperty('archiveSessions');
    expect(configurationBaselinesCompatible(current, { ...current, valueSource: current.valueSource.replace('"archiveSessions":false', '"archiveSessions":true'), known: { ...current.known, archiveSessions: true } })).toBe(false);
  });
});
