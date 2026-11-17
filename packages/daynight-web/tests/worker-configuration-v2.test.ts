import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeConfigurationDraft } from '../src/api/configuration-source';
import { getWorkerConfiguration, saveWorkerConfiguration, workerConfigurationBaseline } from '../src/api/worker-configuration';
import { configurationResource, configurationResponse, configurationValue } from './helpers/worker-configuration';
import { WORKER_USER, workerId } from './helpers/workers';

const admission = { userId: WORKER_USER, onPrincipalMismatch: vi.fn() };
afterEach(() => vi.unstubAllGlobals());

describe('Worker configuration v2', () => {
  it('retains the old target for inspection and replaces it only on an explicit complete save', async () => {
    const value = configurationValue();
    const old = { ...value, agentControlMode: 'herdr', toolPaths: { ...value.toolPaths, herdr: { kind: 'auto' } } };
    const current = configurationResource();
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse({ ...current, desired: { ...current.desired, value: old } }))
      .mockResolvedValueOnce(configurationResponse(configurationResource('2', value)));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const resource = await getWorkerConfiguration(workerId(1), signal, admission);
    expect(resource.desired?.unsupportedFields).toEqual(['agentControlMode', 'toolPaths.herdr']);
    const baseline = workerConfigurationBaseline(resource)!;
    expect(JSON.parse(baseline.valueSource)).toEqual(old);
    expect(fetch).toHaveBeenCalledTimes(1);
    const submission = mergeConfigurationDraft(baseline, resource.desired!.value);
    const saved = await saveWorkerConfiguration(workerId(1), '1', submission, signal, admission);
    expect(saved.desired?.value).toEqual(value);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ revision: '1', value });
    for (const [, init] of fetch.mock.calls) expect(new Headers(init.headers).get('Daynight-Worker-Tool-Paths')).toBe('2');
  });

  it('requires the version 2 echo and does not retry an old projection', async () => {
    const response = configurationResponse(configurationResource());
    response.headers.set('Daynight-Worker-Tool-Paths', '1');
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    await expect(getWorkerConfiguration(workerId(1), new AbortController().signal, admission)).rejects.toMatchObject({ kind: 'protocol', code: 'worker_tool_protocol' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
