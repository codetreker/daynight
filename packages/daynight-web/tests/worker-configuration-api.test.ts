import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorkerConfiguration, listWorkerConfigurationProjects, parseConfigurationRevision, parseWorkerConfiguration, saveWorkerConfiguration, type WorkerConfigurationOutcome, type WorkerConfigurationResource } from '../src/api/worker-configuration';
import { invalidateAuthRequests } from '../src/api/client';
import { configurationError, configurationResource, configurationResponse, configurationValue, controlModeResponse } from './helpers/worker-configuration';
import { WORKER_TIME, WORKER_USER, workerId } from './helpers/workers';

const admission = () => ({ userId: WORKER_USER, onPrincipalMismatch: vi.fn() });
const outcome = (key: WorkerConfigurationOutcome['key'], appliedValue: WorkerConfigurationOutcome['appliedValue']): WorkerConfigurationOutcome => ({ key, appliedValue, targetRevision: '1', state: 'applied', error: null, lastFailure: null, nextAttemptAt: null });
const observed = (items: readonly WorkerConfigurationOutcome[]): WorkerConfigurationResource => ({ ...configurationResource(), observationRevision: '1', observation: { baseRevision: '0', desiredRevision: '1', items, reportedAt: WORKER_TIME } });
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe('Worker configuration wire format', () => {
  it('retains all kinds, removed project results and recovered failure diagnostics', () => {
    const failure = { code: 'permission_denied' as const, category: 'repository' as const, phase: 'stop' as const, occurredAt: WORKER_TIME };
    const resource = observed([
      outcome({ kind: 'maxConcurrent' }, 2), outcome({ kind: 'pollIntervalMs' }, 60_000), outcome({ kind: 'recoveryLimit' }, 0), outcome({ kind: 'preferPlatformSpecificTasks' }, false), outcome({ kind: 'native' }, configurationValue().native),
      outcome({ kind: 'projectPreparation', projectId: workerId(3) }, true), outcome({ kind: 'projectNative', projectId: workerId(3) }, configurationValue().native),
      { ...outcome({ kind: 'projectRemoval', projectId: workerId(9) }, true), lastFailure: failure },
    ]);
    expect(parseWorkerConfiguration(resource)).toEqual(resource);
    expect(parseWorkerConfiguration({ desired: null, observationRevision: '0', observation: null })).toEqual({ desired: null, observationRevision: '0', observation: null });
    expect(parseConfigurationRevision('9223372036854775807')).toBe('9223372036854775807');
    expect(parseConfigurationRevision('0', true)).toBe('0');
  });
  it('requires an explicit boolean preference and keeps both observed boolean values', () => {
    for (const enabled of [false, true]) {
      const value = { ...configurationValue(), preferPlatformSpecificTasks: enabled };
      expect(parseWorkerConfiguration(configurationResource('1', value)).desired!.value.preferPlatformSpecificTasks).toBe(enabled);
      const resource = observed([outcome({ kind: 'preferPlatformSpecificTasks' }, enabled)]);
      expect(parseWorkerConfiguration(resource).observation!.items[0]!.appliedValue).toBe(enabled);
    }
    const missing = { ...configurationValue() } as Record<string, unknown>;
    delete missing.preferPlatformSpecificTasks;
    expect(() => parseWorkerConfiguration({ ...configurationResource(), desired: { ...configurationResource().desired, value: missing } })).toThrow('invalid response');
    for (const invalid of [null, 0, 'false', undefined]) {
      const resource = { ...configurationResource(), desired: { ...configurationResource().desired, value: { ...configurationValue(), preferPlatformSpecificTasks: invalid } } };
      expect(() => parseWorkerConfiguration(resource)).toThrow('invalid response');
      expect(() => parseWorkerConfiguration(observed([{ ...outcome({ kind: 'preferPlatformSpecificTasks' }, false), appliedValue: invalid } as unknown as WorkerConfigurationOutcome]))).toThrow('invalid response');
    }
  });
  it('preserves inheritance, explicit null/empty args and canonical Project ordering', () => {
    const resource = configurationResource('1', { ...configurationValue(), native: { agent: 'claude', model: '\uFEFF', args: ['--a', 'spaces allowed'] }, projects: [
      { projectId: workerId(9).toUpperCase(), nativeOverrides: { args: [], model: null } }, { projectId: workerId(3), nativeOverrides: {} },
    ] });
    expect(parseWorkerConfiguration(resource).desired!.value.projects).toEqual([{ projectId: workerId(3), nativeOverrides: {} }, { projectId: workerId(9), nativeOverrides: { model: null, args: [] } }]);
  });
  it.each(['', '00', '01', '-1', '+1', '1e2', '1.0', '9223372036854775808', '0'])('rejects invalid positive revision %j', revision => {
    expect(() => parseConfigurationRevision(revision)).toThrow('invalid response');
  });
  it.each([
    { ...configurationResource(), supported: true },
    { ...configurationResource(), observationRevision: '1' },
    { ...configurationResource(), desired: { ...configurationResource().desired, revision: 1 } },
    configurationResource('1', { ...configurationValue(), maxConcurrent: 0 }),
    configurationResource('1', { ...configurationValue(), pollIntervalMs: 2_147_483_648 }),
    configurationResource('1', { ...configurationValue(), recoveryLimit: Number.MAX_SAFE_INTEGER + 1 }),
    configurationResource('1', { ...configurationValue(), native: { agent: 'codex', model: '\u0085', args: [] } }),
    configurationResource('1', { ...configurationValue(), native: { agent: 'codex', model: '\ud800', args: [] } }),
    configurationResource('1', { ...configurationValue(), native: { agent: 'codex', model: null, args: [''] } }),
    observed([outcome({ kind: 'projectRemoval', projectId: workerId(3) }, null)]),
    observed([{ ...outcome({ kind: 'maxConcurrent' }, 2), targetRevision: '2' }]),
    observed([outcome({ kind: 'maxConcurrent' }, 2), outcome({ kind: 'maxConcurrent' }, 3)]),
    observed([{ ...outcome({ kind: 'maxConcurrent' }, 2), state: 'error' }]),
    observed([{ ...outcome({ kind: 'maxConcurrent' }, 2), nextAttemptAt: WORKER_TIME }]),
  ])('rejects malformed or inconsistent configuration %#', resource => {
    expect(() => parseWorkerConfiguration(resource)).toThrow('invalid response');
  });
  it('rejects unknown diagnostics and false project success while allowing failed prior values', () => {
    const failure = { code: 'command_failed' as const, category: 'runtime' as const, phase: 'stop' as const, occurredAt: WORKER_TIME };
    const item = { ...outcome({ kind: 'projectRemoval', projectId: workerId(3) }, null), state: 'error' as const, error: failure, lastFailure: failure, nextAttemptAt: WORKER_TIME };
    expect(parseWorkerConfiguration(observed([item]))).toEqual(observed([item]));
    expect(() => parseWorkerConfiguration(observed([{ ...item, error: { ...failure, message: 'raw tool output' } } as unknown as WorkerConfigurationOutcome]))).toThrow('invalid response');
    expect(() => parseWorkerConfiguration(observed([{ ...item, appliedValue: false } as unknown as WorkerConfigurationOutcome]))).toThrow('invalid response');
    expect(() => parseWorkerConfiguration({ ...observed([item]), observation: { ...observed([item]).observation, baseRevision: '1' } })).toThrow('invalid response');
  });
});

describe('principal-admitted configuration API', () => {
  it('reads and saves decimal string CAS through the Worker-only API', async () => {
    const value = configurationValue(), fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource('9223372036854775806'))).mockResolvedValueOnce(configurationResponse(configurationResource('9223372036854775807', value)));
    vi.stubGlobal('fetch', fetch);
    const gate = { ...admission(), onDispatch: vi.fn() }, signal = new AbortController().signal;
    await getWorkerConfiguration(workerId(1).toUpperCase(), signal, gate);
    expect(await saveWorkerConfiguration(workerId(1), '9223372036854775806', value, signal, gate)).toEqual(configurationResource('9223372036854775807', value));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`/api/v1/me/workers/${workerId(1)}/configuration`, `/api/v1/me/workers/${workerId(1)}/configuration`]);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ revision: '9223372036854775806', value });
    expect(gate.onDispatch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[1]![1].headers).not.toHaveProperty('Daynight-Worker-Protocol');
  });
  it('rejects a foreign principal, missing capability and inconsistent successful PUT', async () => {
    const mismatch = admission(), fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource(), 200, workerId(99)))
      .mockResolvedValueOnce(new Response(JSON.stringify(configurationResource()), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': WORKER_USER } }))
      .mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 8 })));
    vi.stubGlobal('fetch', fetch); const signal = new AbortController().signal;
    await expect(getWorkerConfiguration(workerId(1), signal, mismatch)).rejects.toMatchObject({ kind: 'protocol', code: 'principal_mismatch' });
    expect(mismatch.onPrincipalMismatch).toHaveBeenCalledOnce();
    await expect(getWorkerConfiguration(workerId(1), signal, admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(saveWorkerConfiguration(workerId(1), '1', configurationValue(), signal, admission())).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('retains known CAS errors and validates Project page principals without config capability', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(configurationError(409, 'version_conflict'))
      .mockResolvedValueOnce(new Response('{"items":[],"nextCursor":null}', { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': WORKER_USER } }))
      .mockResolvedValueOnce(configurationResponse({ items: [], nextCursor: null }, 200, workerId(8)));
    vi.stubGlobal('fetch', fetch); const signal = new AbortController().signal;
    await expect(saveWorkerConfiguration(workerId(1), '1', configurationValue(), signal, admission())).rejects.toMatchObject({ kind: 'server', status: 409, code: 'version_conflict' });
    expect(await listWorkerConfigurationProjects({ limit: 50, cursor: 'next/+' }, signal, admission())).toEqual({ items: [], nextCursor: null });
    expect(fetch.mock.calls[1]![0]).toBe('/api/v1/projects?limit=50&cursor=next%2F%2B');
    await expect(listWorkerConfigurationProjects({}, signal, admission())).rejects.toMatchObject({ code: 'principal_mismatch' });
  });
});


describe('Worker control mode capability', () => {
  it('negotiates mode independently, preserving null until adoption and string observations', async () => {
    const value = { ...configurationValue(), agentControlMode: null };
    const fetch = vi.fn().mockResolvedValueOnce(controlModeResponse(configurationResource('1', value)))
      .mockResolvedValueOnce(controlModeResponse({ ...configurationResource('2', { ...value, agentControlMode: 'web' }), observationRevision: '1', observation: {
        baseRevision: '0', desiredRevision: '2', reportedAt: WORKER_TIME,
        items: [{ ...outcome({ kind: 'agentControlMode' }, 'herdr'), state: 'pending', targetRevision: '2' }],
      } }));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const first = await getWorkerConfiguration(workerId(1), signal, admission());
    expect(first.controlModeSupported).toBe(true);
    expect(first.desired!.value.agentControlMode).toBeNull();
    const saved = await saveWorkerConfiguration(workerId(1), '1', { ...value, agentControlMode: 'web' }, signal, { ...admission(), controlModeSupported: true });
    expect(saved.observation!.items[0]!.appliedValue).toBe('herdr');
    expect(saved.desired!.value.agentControlMode).toBe('web');
    for (const [, init] of fetch.mock.calls) expect(new Headers(init.headers).get('Daynight-Worker-Control-Mode')).toBe('1');
    expect(JSON.parse(fetch.mock.calls[1]![1].body).value.agentControlMode).toBe('web');
  });
  it('keeps old-service responses strict and saves other fields without mode', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource()))
      .mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), recoveryLimit: 5 })))
      .mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), agentControlMode: 'herdr' })));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const legacy = await getWorkerConfiguration(workerId(1), signal, admission());
    expect(legacy.controlModeSupported).not.toBe(true);
    expect(legacy.desired!.value).not.toHaveProperty('agentControlMode');
    await saveWorkerConfiguration(workerId(1), '1', { ...legacy.desired!.value, recoveryLimit: 5 }, signal, admission());
    expect(JSON.parse(fetch.mock.calls[1]![1].body).value).not.toHaveProperty('agentControlMode');
    await expect(getWorkerConfiguration(workerId(1), signal, admission())).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('requires an explicit mode field and refuses invalid modes, overrides and invented null success', () => {
    for (const mode of [undefined, '', 'native', 1, false, {}]) {
      const value = { ...configurationValue(), ...(mode === undefined ? {} : { agentControlMode: mode }) };
      expect(() => parseWorkerConfiguration({ ...configurationResource(), desired: { ...configurationResource().desired, value } }, true)).toThrow('invalid response');
    }
    for (const mode of ['herdr', 'web', null]) {
      const resource = configurationResource('1', { ...configurationValue(), agentControlMode: mode as 'herdr' | 'web' | null });
      expect(parseWorkerConfiguration(resource, true).desired!.value.agentControlMode).toBe(mode);
    }
    const resource = { ...observed([outcome({ kind: 'agentControlMode' }, null)]), desired: configurationResource('1', { ...configurationValue(), agentControlMode: null }).desired };
    expect(() => parseWorkerConfiguration(resource, true)).toThrow('invalid response');
    expect(() => parseWorkerConfiguration({ ...resource, observation: null, observationRevision: '0', desired: { ...resource.desired, value: { ...resource.desired!.value, projects: [{ projectId: workerId(3), nativeOverrides: { agentControlMode: 'web' } }] } } }, true)).toThrow('invalid response');
  });
  it('requires the capability echo when saving a mode', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(configurationResponse(configurationResource('2'))));
    await expect(saveWorkerConfiguration(workerId(1), '1', { ...configurationValue(), agentControlMode: 'web' }, new AbortController().signal, { ...admission(), controlModeSupported: true })).rejects.toMatchObject({ kind: 'protocol' });
  });
});
