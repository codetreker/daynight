import { afterEach, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import { discoverWorkerModels, parseWorkerReadonlyResponse, requestWorkerReadonly } from '../src/api/worker-readonly';

const ownerUserId = '11111111-1111-4111-8111-111111111111';
const workerId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const connectionId = '44444444-4444-4444-8444-444444444444';
const capabilityGeneration = '55555555-5555-4555-8555-555555555555';
const catalogGeneration = '66666666-6666-4666-8666-666666666666';
const modelResult = () => ({ schemaVersion: 1, provider: 'codex', cwd: '/workspace', configurationGeneration: 'a'.repeat(64), catalogGeneration,
  models: [{ id: 'native-model', label: 'Native Model', aliases: [], hidden: false, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' }],
  defaults: { model: { value: 'native-model', source: 'native' }, reasoningEffort: { value: 'high', source: 'native' } }, selectionError: null, nextCursor: null });
const envelope = () => ({ type: 'result', protocol: 'daynight.worker-readonly.v1', ownerUserId, workerId, requestId, connectionId, capabilityGeneration, result: modelResult() });
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': ownerUserId } });
const signal = () => new AbortController().signal;
const admission = () => ({ userId: ownerUserId, onPrincipalMismatch: vi.fn() });
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

it('returns model capabilities from the requested Worker and Provider', async () => {
  const fetch = vi.fn().mockResolvedValue(response(envelope())); vi.stubGlobal('fetch', fetch);
  const result = await requestWorkerReadonly(workerId, 'model.list', { provider: 'codex' }, signal(), admission(), { requestId });
  expect(result).toEqual(envelope());
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ requestId, operation: 'model.list', input: { provider: 'codex' } });
});

it('rejects malformed model queries before dispatch', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  for (const input of [null, {}, { provider: null }, { provider: 'other' }, { provider: 'codex', cwd: 'relative' }, { provider: 'codex', model: '' },
    { provider: 'codex', limit: 101 }, { provider: 'codex', limit: 0 }, { provider: 'codex', limit: 1.5 }, { provider: 'codex', includeHidden: null },
    { provider: 'codex', cursor: null }, { provider: 'codex', cursor: '' }, { provider: 'codex', model: 'x'.repeat(257) }, { provider: 'codex', extra: true }]) {
    await expect(discoverWorkerModels(workerId, input as never, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects capabilities for another Provider while preserving all connection fences', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...envelope(), result: { ...modelResult(), provider: 'claude' } })));
  await expect(discoverWorkerModels(workerId, { provider: 'codex' }, signal(), admission(), { requestId })).rejects.toMatchObject({ kind: 'protocol' });
  for (const changed of [{ workerId: ownerUserId }, { ownerUserId: workerId }, { requestId: workerId }, { capabilityGeneration: requestId }, { connectionId: requestId }]) {
    expect(() => parseWorkerReadonlyResponse({ ...envelope(), ...changed }, 'model.list', { ownerUserId, workerId, requestId, binding: { connectionId, capabilityGeneration } })).toThrow();
  }
});

it('preserves native defaults, unsupported effort and unknown selections', async () => {
  for (const reasoningEfforts of [null, []]) {
    const result = { ...modelResult(), provider: 'copilot', models: [{ ...modelResult().models[0]!, reasoningEfforts, defaultReasoningEffort: null }],
      defaults: { model: { value: null, source: 'unknown' }, reasoningEffort: { value: null, source: 'native' } }, selectionError: { code: 'unknown_default', message: 'Default model is unknown.' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...envelope(), result })));
    expect((await discoverWorkerModels(workerId, { provider: 'copilot' }, signal(), admission(), { requestId })).result).toEqual(result);
  }
});

it('retains the request generation binding for model pagination', async () => {
  const fetch = vi.fn().mockResolvedValue(response({ ...envelope(), result: { ...modelResult(), nextCursor: 'opaque' } })); vi.stubGlobal('fetch', fetch);
  const input = { provider: 'codex' as const, cwd: 'C:\\Users', model: 'native-model', includeHidden: true, limit: 20, cursor: 'opaque' };
  const result = await discoverWorkerModels(workerId, input, signal(), admission(), { requestId, binding: { connectionId, capabilityGeneration } });
  expect(result.result.configurationGeneration).toBe('a'.repeat(64)); expect(result.result.catalogGeneration).toBe(catalogGeneration);
  expect(JSON.parse(fetch.mock.calls[0]![1].body).input).toEqual(input);
});

it('rejects malformed or excessive model capabilities', () => {
  const parse = (value: unknown) => parseWorkerReadonlyResponse({ ...envelope(), result: value }, 'model.list', { ownerUserId, workerId, requestId });
  const base = modelResult(), option = base.models[0]!;
  for (const value of [null, {}, { ...base, extra: true }, { ...base, schemaVersion: 2 }, { ...base, provider: 'other' }, { ...base, cwd: 'relative' },
    { ...base, configurationGeneration: 'A'.repeat(64) }, { ...base, catalogGeneration: '' }, { ...base, nextCursor: '' }, { ...base, models: null },
    { ...base, models: Array(101).fill(option) }, { ...base, models: [option, option] }, { ...base, models: [{ ...option, id: '' }] },
    { ...base, models: [{ ...option, label: 'x'.repeat(1025) }] }, { ...base, models: [{ ...option, aliases: null }] },
    { ...base, models: [{ ...option, aliases: ['alias', 'alias'] }] }, { ...base, models: [{ ...option, aliases: Array(17).fill('alias') }] },
    { ...base, models: [{ ...option, hidden: null }] }, { ...base, models: [{ ...option, reasoningEfforts: Array(33).fill('high') }] },
    { ...base, models: [{ ...option, reasoningEfforts: ['high', 'high'] }] }, { ...base, models: [{ ...option, defaultReasoningEffort: 'other' }] },
    { ...base, models: [{ ...option, reasoningEfforts: null, defaultReasoningEffort: 'high' }] },
    { ...base, defaults: { ...base.defaults, model: { value: null, source: 'local' } } },
    { ...base, defaults: { ...base.defaults, model: { value: 'model', source: 'unknown' } } },
    { ...base, defaults: { ...base.defaults, model: { value: 'model', source: 'other' } } },
    { ...base, defaults: { ...base.defaults, reasoningEffort: { value: 'x'.repeat(65), source: 'native' } } },
    { ...base, selectionError: { code: 'other', message: 'Failed' } }, { ...base, selectionError: { code: 'unknown_default', message: '' } },
    { ...base, models: Array.from({ length: 100 }, (_, i) => ({ ...option, id: String(i), label: 'x'.repeat(1000) })) },
  ]) expect(() => parse(value)).toThrow();
});

it('preserves capability and cleanup failures', async () => {
  const { result: _result, ...base } = envelope();
  for (const code of ['invalid_input', 'capability_error', 'cleanup_unknown', 'stale_configuration']) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...base, error: { code, message: 'Model discovery failed.' } })));
    await expect(discoverWorkerModels(workerId, { provider: 'codex' }, signal(), admission(), { requestId })).rejects.toMatchObject({ code });
  }
});

it('discards late model responses when the caller changes Provider or cancels', async () => {
  let current = true;
  vi.stubGlobal('fetch', vi.fn(async () => { current = false; return response(envelope()); }));
  await expect(discoverWorkerModels(workerId, { provider: 'codex' }, signal(), { ...admission(), isCurrent: () => current }, { requestId })).rejects.toMatchObject({ name: 'AbortError' });
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); return response(envelope()); }));
  await expect(discoverWorkerModels(workerId, { provider: 'codex' }, controller.signal, admission(), { requestId })).rejects.toMatchObject({ name: 'AbortError' });
});
