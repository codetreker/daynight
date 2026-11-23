import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorkerConfiguration, listWorkerConfigurationProjects, parseConfigurationRevision, parseWorkerConfiguration, saveWorkerConfiguration, workerConfigurationBaseline, type WorkerConfigurationOutcome, type WorkerConfigurationResource } from '../src/api/worker-configuration';
import { mergeConfigurationDraft } from '../src/api/configuration-source';
import { mergeConfigurationResources } from '../src/features/workers/configuration/model';
import { cancelAuthNetworkRequests, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { configurationError, configurationResource, configurationResponse, configurationValue } from './helpers/worker-configuration';
import { WORKER_TIME, WORKER_USER, workerId } from './helpers/workers';

const admission = () => ({ userId: WORKER_USER, onPrincipalMismatch: vi.fn() });
const outcome = (key: WorkerConfigurationOutcome['key'], appliedValue: WorkerConfigurationOutcome['appliedValue']): WorkerConfigurationOutcome => ({ key, appliedValue, targetRevision: '1', state: 'applied', error: null, lastFailure: null, nextAttemptAt: null });
const observed = (items: readonly WorkerConfigurationOutcome[]): WorkerConfigurationResource => ({ ...configurationResource(), observationRevision: '1', observation: { baseRevision: '0', desiredRevision: '1', items, reportedAt: WORKER_TIME } });
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe('Worker configuration wire format', () => {
  it('reads historical desired and applied numbers outside current write ranges unchanged', () => {
    const value = { ...configurationValue(), maxConcurrent: 65, pollIntervalMs: 100_000, recoveryLimit: 11 };
    const resource = { ...observed([outcome({ kind: 'maxConcurrent' }, 65), outcome({ kind: 'pollIntervalMs' }, 100_000), outcome({ kind: 'recoveryLimit' }, 11)]), desired: configurationResource('1', value).desired };
    const parsed = parseWorkerConfiguration(resource);
    expect(parsed.desired!.value).toEqual(value);
    expect(parsed.observation!.items.map(item => item.appliedValue)).toEqual([65, 100_000, 11]);
  });
  it('retains all kinds, removed project results and recovered failure diagnostics', () => {
    const failure = { code: 'permission_denied' as const, category: 'repository' as const, phase: 'stop' as const, occurredAt: WORKER_TIME };
    const resource = observed([
      outcome({ kind: 'maxConcurrent' }, 2), outcome({ kind: 'pollIntervalMs' }, 60_000), outcome({ kind: 'recoveryLimit' }, 0), outcome({ kind: 'preferPlatformSpecificTasks' }, false), outcome({ kind: 'native' }, configurationValue().native),
      outcome({ kind: 'projectPreparation', projectId: workerId(3) }, true), outcome({ kind: 'projectNative', projectId: workerId(3) }, configurationValue().native),
      { ...outcome({ kind: 'projectRemoval', projectId: workerId(9) }, true), lastFailure: failure },
    ]);
    expect(parseWorkerConfiguration(resource)).toEqual({ ...resource, toolPathsSupported: true });
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
  it('parses negotiated modes and never treats a legacy observation as strict application', () => {
    const { preferPlatformSpecificTasks: _legacy, ...base } = configurationValue();
    for (const mode of ['all', 'prefer', 'only'] as const) {
      const target = { desired: { revision: '1', updatedAt: WORKER_TIME, value: { ...base, platformTaskMode: mode } }, observationRevision: '1', observation: { baseRevision: '0', desiredRevision: '1', items: [outcome({ kind: 'platformTaskMode' }, mode)], reportedAt: WORKER_TIME } };
      const resource = parseWorkerConfiguration(target);
      expect(resource.desired!.value.platformTaskMode).toBe(mode); expect(resource.observation!.items[0]!.appliedValue).toBe(mode);
      expect(() => parseWorkerConfiguration({ ...target, observation: { ...target.observation, items: [outcome({ kind: 'preferPlatformSpecificTasks' }, true)] } })).toThrow();
    }
    expect(() => parseWorkerConfiguration({ desired: { revision: '1', updatedAt: WORKER_TIME, value: { ...base, platformTaskMode: 'future' } }, observationRevision: '0', observation: null })).toThrow();
  });
  it('recognizes optional sudo target and strictly validates its observation', () => {
    expect(parseWorkerConfiguration(configurationResource()).desired!.value).not.toHaveProperty('enableSudoCleanup');
    for (const enabled of [false, true]) {
      expect(parseWorkerConfiguration(configurationResource('1', { ...configurationValue(), enableSudoCleanup: enabled })).desired!.value.enableSudoCleanup).toBe(enabled);
      expect(parseWorkerConfiguration(observed([outcome({ kind: 'enableSudoCleanup' }, enabled)])).observation!.items[0]!.appliedValue).toBe(enabled);
    }
    for (const invalid of [null, 0, 'false']) {
      expect(() => parseWorkerConfiguration({ ...configurationResource(), desired: { ...configurationResource().desired, value: { ...configurationValue(), enableSudoCleanup: invalid } } })).toThrow();
      expect(() => parseWorkerConfiguration(observed([outcome({ kind: 'enableSudoCleanup' }, invalid as unknown as boolean)]))).toThrow();
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
    observed([{ ...outcome({ kind: 'maxConcurrent' }, 2), key: { kind: 'maxConcurrent', projectId: workerId(3) } } as WorkerConfigurationOutcome]),
    observed([outcome({ kind: 'agentControlMode' }, 'web')]),
    observed([{ ...outcome({ kind: 'maxConcurrent' }, 2), state: 'error' }]),
    observed([{ ...outcome({ kind: 'maxConcurrent' }, 2), nextAttemptAt: WORKER_TIME }]),
  ])('rejects malformed or inconsistent configuration %#', resource => {
    expect(() => parseWorkerConfiguration(resource)).toThrow('invalid response');
  });
  it('ignores unknown diagnostics and rejects false project success while allowing failed prior values', () => {
    const failure = { code: 'command_failed' as const, category: 'runtime' as const, phase: 'stop' as const, occurredAt: WORKER_TIME };
    const item = { ...outcome({ kind: 'projectRemoval', projectId: workerId(3) }, null), state: 'error' as const, error: failure, lastFailure: failure, nextAttemptAt: WORKER_TIME };
    expect(parseWorkerConfiguration(observed([item]))).toEqual({ ...observed([item]), toolPathsSupported: true });
    expect(parseWorkerConfiguration(observed([{ ...item, error: { ...failure, message: 'raw tool output' } } as unknown as WorkerConfigurationOutcome])).observation!.items[0]!.error).toEqual(failure);
    expect(() => parseWorkerConfiguration(observed([{ ...item, appliedValue: false } as unknown as WorkerConfigurationOutcome]))).toThrow('invalid response');
    expect(() => parseWorkerConfiguration({ ...observed([item]), observation: { ...observed([item]).observation, baseRevision: '1' } })).toThrow('invalid response');
  });
});

describe('principal-admitted configuration API', () => {
  it('negotiates mode on GET and writes only the selected protocol', async () => {
    const { preferPlatformSpecificTasks: _legacy, ...base } = configurationValue();
    const wire = { ...base, platformTaskMode: 'prefer' };
    const response = (revision: string, value: unknown) => { const r = configurationResponse({ desired: { revision, updatedAt: WORKER_TIME, value }, observationRevision: '0', observation: null }); r.headers.set('Daynight-Worker-Platform-Task-Mode', '1'); return r; };
    const fetch = vi.fn().mockResolvedValueOnce(response('1', wire)).mockImplementationOnce((_url, init) => response('2', JSON.parse(String(init.body)).value)); vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal, resource = await getWorkerConfiguration(workerId(1), signal, admission());
    expect(fetch.mock.calls[0]![1].headers).toHaveProperty('Daynight-Worker-Platform-Task-Mode', '1');
    const baseline = workerConfigurationBaseline(resource)!;
    const submission = mergeConfigurationDraft(baseline, { ...baseline.known, platformTaskMode: 'only', preferPlatformSpecificTasks: true });
    const result = await saveWorkerConfiguration(workerId(1), '1', submission, signal, { ...admission(), platformTaskModeSupported: true });
    const sent = JSON.parse(String(fetch.mock.calls[1]![1].body)).value;
    expect(sent).toHaveProperty('platformTaskMode', 'only'); expect(sent).not.toHaveProperty('preferPlatformSpecificTasks'); expect(result.desired!.value.platformTaskMode).toBe('only');
  });
  it('retains the response document even for an uninitialized target', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(configurationResponse({ desired: null, observationRevision: '0', observation: null, future: { n: 9 } })));
    const resource = await getWorkerConfiguration(workerId(1), new AbortController().signal, admission());
    expect(resource.desired).toBeNull(); expect(resource.document!.source).toContain('"future"');
  });
  it('preserves independent desired and unknown observation sources across late reads', async () => {
    const future = { key: { kind: 'future', id: 'opaque' }, targetRevision: '2', appliedValue: null, state: 'pending' };
    const older = { ...configurationResource('2'), observationRevision: '1', observation: { baseRevision: '0', desiredRevision: '2', items: [future], reportedAt: WORKER_TIME } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource('3'))).mockResolvedValueOnce(configurationResponse(older)));
    const signal = new AbortController().signal, current = await getWorkerConfiguration(workerId(1), signal, admission()), incoming = await getWorkerConfiguration(workerId(1), signal, admission());
    const merged = mergeConfigurationResources(current, incoming);
    expect(merged.desired!.revision).toBe('3'); expect(merged.desired!.document).toBe(current.document);
    expect(merged.observation!.items).toEqual([]); expect(merged.observation!.document).toBe(incoming.document);
    expect(merged.observation!.document!.source).toContain('"future"');
  });
  it('validates common revision constraints for unknown observation kinds', () => {
    for (const revision of [undefined, '0', '3', 1]) {
      const item = { key: { kind: 'future' }, targetRevision: revision, state: 'future' };
      expect(() => parseWorkerConfiguration({ ...configurationResource('2'), observationRevision: '1', observation: { baseRevision: '0', desiredRevision: '2', items: [item], reportedAt: WORKER_TIME } })).toThrow();
    }
  });
  it('rejects a receipt that changes unknown data despite matching known fields', async () => {
    const raw = (revision: string, unknown: string) => new Response(JSON.stringify(configurationResource(revision)).replace('"maxConcurrent":2', `"future":${unknown},"maxConcurrent":2`), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': WORKER_USER, 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Tool-Paths': '2' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(raw('1', '900719925474099312345')).mockResolvedValueOnce(raw('2', '900719925474099312346')));
    const signal = new AbortController().signal, resource = await getWorkerConfiguration(workerId(1), signal, admission());
    const submission = mergeConfigurationDraft(workerConfigurationBaseline(resource)!, configurationValue()), onConfirmed = vi.fn();
    await expect(saveWorkerConfiguration(workerId(1), '1', submission, signal, { ...admission(), onConfirmed })).rejects.toMatchObject({ kind: 'protocol' });
    expect(onConfirmed).not.toHaveBeenCalled();
  });
  it('reads and saves decimal string CAS through the Worker-only API', async () => {
    const value = configurationValue(), fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource('9223372036854775806'))).mockResolvedValueOnce(configurationResponse(configurationResource('9223372036854775807', value)));
    vi.stubGlobal('fetch', fetch);
    const gate = { ...admission(), onDispatch: vi.fn() }, signal = new AbortController().signal;
    await getWorkerConfiguration(workerId(1).toUpperCase(), signal, gate);
    expect((await saveWorkerConfiguration(workerId(1), '9223372036854775806', value, signal, gate)).document!.known).toEqual({ ...configurationResource('9223372036854775807', value), toolPathsSupported: true });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`/api/v1/me/workers/${workerId(1)}/configuration`, `/api/v1/me/workers/${workerId(1)}/configuration`]);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ revision: '9223372036854775806', value });
    expect(gate.onDispatch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[1]![1].headers).not.toHaveProperty('Daynight-Worker-Protocol');
  });
  it('reports a validated receipt even if identity pauses synchronously afterward', async () => {
    const saved = configurationResource('2', configurationValue()), controller = new AbortController();
    const reason = new Error('configuration view closed');
    const fetch = vi.fn().mockResolvedValue(configurationResponse(saved)); vi.stubGlobal('fetch', fetch);
    let resume = () => {};
    const onConfirmed = vi.fn((_resource: WorkerConfigurationResource) => { resume = pauseAuthRequests(); controller.abort(reason); });
    try {
      await expect(saveWorkerConfiguration(workerId(1), '1', configurationValue(), controller.signal, { ...admission(), onConfirmed })).rejects.toBe(reason);
      expect(onConfirmed).toHaveBeenCalledOnce(); expect(onConfirmed.mock.calls[0]![0].document!.known).toEqual({ ...saved, toolPathsSupported: true }); expect(controller.signal.aborted).toBe(true);
    } finally { resume(); }
  });
  it.each([{ status: 409, code: 'version_conflict' }, { status: 400, code: 'invalid_input' }])('reports a trusted $status refusal before a synchronous pause and abort', async ({ status, code }) => {
    const controller = new AbortController(), fetch = vi.fn().mockResolvedValue(configurationError(status, code)); vi.stubGlobal('fetch', fetch);
    const reason = new Error('configuration view closed');
    let resume = () => {};
    const onRejected = vi.fn(() => { resume = pauseAuthRequests(); controller.abort(reason); });
    try {
      await expect(saveWorkerConfiguration(workerId(1), '1', configurationValue(), controller.signal, { ...admission(), onRejected })).rejects.toBe(reason);
      expect(onRejected).toHaveBeenCalledOnce(); expect(onRejected).toHaveBeenCalledWith(expect.objectContaining({ status, code }));
      expect(controller.signal.aborted).toBe(true);
    } finally { resume(); }
  });
  it('retains the validation explanation and request identity without retrying a refused save', async () => {
    const message = 'pollIntervalMs: 100000 value exceeds maximum 60000';
    const fetch = vi.fn().mockResolvedValue(configurationResponse({ error: { code: 'invalid_input', message, requestId: 'range-request' } }, 400));
    vi.stubGlobal('fetch', fetch);
    const onRejected = vi.fn();
    await expect(saveWorkerConfiguration(workerId(1), '1', configurationValue(), new AbortController().signal, { ...admission(), onRejected })).rejects.toMatchObject({ kind: 'server', status: 400, code: 'invalid_input', serverMessage: message, requestId: 'range-request' });
    expect(onRejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ serverMessage: message, requestId: 'range-request' }));
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['confirmed', 'rejected'] as const)('reports a validated %s before synchronous shared network cancellation', async outcome => {
    const saved = configurationResource('2', configurationValue());
    let networkSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      networkSignal = init.signal as AbortSignal;
      return Promise.resolve(outcome === 'confirmed' ? configurationResponse(saved) : configurationError(409, 'version_conflict'));
    });
    vi.stubGlobal('fetch', fetch);
    const onConfirmed = vi.fn((_resource: WorkerConfigurationResource) => cancelAuthNetworkRequests());
    const onRejected = vi.fn(() => cancelAuthNetworkRequests());
    const pending = saveWorkerConfiguration(workerId(1), '1', configurationValue(), new AbortController().signal, { ...admission(), onConfirmed, onRejected });
    const error = await pending.catch((failure: unknown) => failure);
    expect(networkSignal?.aborted).toBe(true);
    expect(error).toBe(networkSignal?.reason);
    if (outcome === 'confirmed') {
      expect(onConfirmed).toHaveBeenCalledOnce(); expect(onConfirmed.mock.calls[0]![0].document!.known).toEqual({ ...saved, toolPathsSupported: true });
      expect(onRejected).not.toHaveBeenCalled();
    } else {
      expect(onRejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 409, code: 'version_conflict' }));
      expect(onConfirmed).not.toHaveBeenCalled();
    }
  });
  it.each([
    { name: 'foreign principal', response: () => configurationResponse({ error: { code: 'version_conflict', message: 'conflict', requestId: 'request' } }, 409, workerId(99)) },
    { name: 'malformed error body', response: () => new Response('{', { status: 409, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': WORKER_USER } }) },
  ])('does not report a trusted rejection for $name', async ({ response }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response())); const onRejected = vi.fn();
    await expect(saveWorkerConfiguration(workerId(1), '1', configurationValue(), new AbortController().signal, { ...admission(), onRejected })).rejects.toMatchObject({ kind: 'protocol' });
    expect(onRejected).not.toHaveBeenCalled();
  });
  it('does not report confirmation for a mismatched receipt', async () => {
    const fetch = vi.fn().mockResolvedValue(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 8 })));
    vi.stubGlobal('fetch', fetch); const onConfirmed = vi.fn();
    await expect(saveWorkerConfiguration(workerId(1), '1', configurationValue(), new AbortController().signal, { ...admission(), onConfirmed })).rejects.toMatchObject({ kind: 'protocol' });
    expect(onConfirmed).not.toHaveBeenCalled();
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

describe('task tag filter wire format', () => {
  it('parses direct target and digest observations while retaining old services', () => {
    expect(parseWorkerConfiguration(configurationResource()).desired!.value.taskTagFilter).toBeUndefined();
    const filter = { names: ['backend', 'urgent'], match: 'all' as const };
    const resource = { ...observed([outcome({ kind: 'taskTagFilter' }, 'a'.repeat(64))]), desired: configurationResource('1', { ...configurationValue(), taskTagFilter: filter }).desired };
    expect(parseWorkerConfiguration(resource).desired!.value.taskTagFilter).toEqual(filter);
    expect(parseWorkerConfiguration(resource).observation!.items[0]!.appliedValue).toBe('a'.repeat(64));
    for (const invalid of ['A'.repeat(64), 'a'.repeat(63), true]) {
      expect(() => parseWorkerConfiguration({ ...resource, observation: { ...resource.observation!, items: [outcome({ kind: 'taskTagFilter' }, invalid)] } })).toThrow();
    }
  });
});
