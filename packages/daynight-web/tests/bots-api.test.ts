import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotCreationUnknown, createBot, getBot, getBotDefaults, listBots, parseBot, parseBotDefaults } from '../src/api/bots';
import * as botsApi from '../src/api/bots';
import { invalidateAuthRequests } from '../src/api/client';
import { BOT_USER, botDefaults, botDefinition, botError, botId, botResponse, botWorkerDefaults } from './helpers/bots';

const admission = () => ({ userId: BOT_USER, onPrincipalMismatch: vi.fn() });
const signal = () => new AbortController().signal;
const deleteInput = () => ({ ifVersion: '9007199254740993', deletionId: botId(50) });
const deletedBot = (state: 'pending' | 'failed' | 'completed' = 'pending') => ({
  id: botId(), workerId: botId(20), version: '9007199254740994',
  deletion: { deletionId: botId(50), requestedVersion: '9007199254740993', workerCleanup: { state, code: state === 'failed' ? 'process_stop_unconfirmed' : null }, serverCleanup: { state: state === 'completed' ? 'completed' : 'pending', code: null } },
});
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe('Bot response contracts', () => {
  it('preserves frozen native selections and permits resolved defaults to differ from provider defaults', () => {
    const config = { ...botDefinition().resolvedConfiguration, model: 'chosen', reasoningEffort: 'none', selection: { schemaVersion: 1, modelSource: 'preference', reasoningEffortSource: 'explicit', configurationGeneration: 'a'.repeat(64), catalogGeneration: botId(60) } };
    const value = { ...botDefinition(), requestedOverrides: { reasoningEffort: 'none' }, resolvedConfiguration: config };
    expect(parseBot(value, BOT_USER)).toEqual(value);
    const defaults = { ...botDefaults(), configuration: config, workers: [{ ...botWorkerDefaults(), configuration: config }] };
    expect(parseBotDefaults(defaults)).toEqual(defaults);
    expect(() => parseBot({ ...value, resolvedConfiguration: { ...config, reasoningEffort: 'high' } }, BOT_USER)).toThrow();
    expect(() => parseBot({ ...value, resolvedConfiguration: { ...config, selection: { ...config.selection, modelSource: 'unknown' } } }, BOT_USER)).toThrow();
    expect(() => parseBot({ ...value, resolvedConfiguration: { ...config, selection: { ...config.selection, reasoningEffortSource: 'cloud' } } }, BOT_USER)).toThrow();
    expect(() => parseBot({ ...value, requestedOverrides: { model: 'chosen' }, resolvedConfiguration: config }, BOT_USER)).toThrow();
  });
  it('preserves exact int64 versions and real startup states', () => {
    const pending = { ...botDefinition(), version: '9223372036854775807', creationOrder: '9007199254740993' };
    expect(parseBot(pending, BOT_USER)).toEqual(pending);
    const ready = { ...pending, sessionId: botId(30), testExecutionId: botId(31), roleConfiguration: { instructions: 'Help.', revision: 'v1', digest: 'a'.repeat(64) }, startupResult: { state: 'ready', code: null } };
    expect(parseBot(ready, BOT_USER)).toEqual(ready);
    const failed = { ...pending, startupResult: { state: 'failed', code: 'invalid_cwd' } };
    expect(parseBot(failed, BOT_USER)).toEqual(failed);
  });
  it('accepts only minimal deletion responsibility after deletion', () => {
    const deleted = { id: botId(), workerId: botId(20), version: '3', deletion: { deletionId: botId(50), requestedVersion: '2', workerCleanup: { state: 'pending', code: null }, serverCleanup: { state: 'failed', code: 'server_cleanup_failed' } } };
    expect(parseBot(deleted, BOT_USER)).toEqual(deleted);
    expect(() => parseBot({ ...botDefinition(), ...deleted }, BOT_USER)).toThrow();
  });
  it('preserves valid multiline role material and the storage configuration contract', () => {
    const value = { ...botDefinition(), sessionId: botId(30), testExecutionId: botId(31),
      roleConfiguration: { instructions: 'Help.\nUse the tools.', revision: 'v1\nv2', digest: 'a'.repeat(64) },
      resolvedConfiguration: { ...botDefinition().resolvedConfiguration, model: 'native\nmodel', args: ['', '\tvalue'] } };
    expect(parseBot(value, BOT_USER)).toEqual(value);
    expect(() => parseBot({ ...value, roleConfiguration: { ...value.roleConfiguration, instructions: ' \n ' } }, BOT_USER)).toThrow();
  });
  it.each([
    { version: 1 }, { version: '01' }, { version: '9223372036854775808' }, { creationOrder: '0' },
    { ownerUserId: botId(4) }, { workerId: botId(4) }, { name: '' }, { name: 'a'.repeat(41) },
    { name: 'x\n' }, { name: '\ud800' }, { sessionId: botId(30) },
    { startupResult: { state: 'ready', code: null } }, { startupResult: { state: 'pending', code: 'failed' } },
    { startupResult: { state: 'failed', code: null } }, { startupResult: { state: 'other', code: null } },
    { requestedOverrides: { cwd: '/different' } }, { requestedOverrides: { provider: null } },
    { resolvedConfiguration: { workerId: botId(20), cwd: 'relative', provider: 'codex', model: null, args: [] } },
    { roleConfiguration: { instructions: '', revision: 'v1', digest: 'a'.repeat(64) } },
  ])('rejects malformed or contradictory definitions %#', patch => {
    expect(() => parseBot({ ...botDefinition(), ...patch }, BOT_USER)).toThrow();
  });
  it('checks defaults selection, candidate identity and unavailable reasons', () => {
    expect(parseBotDefaults(botDefaults())).toEqual(botDefaults());
    const none = { observedAt: botDefaults().observedAt, workerId: null, configuration: null, reason: 'no_available_worker', workers: [] };
    expect(parseBotDefaults(none)).toEqual(none);
    const offline = { ...botWorkerDefaults(), state: 'offline', reason: 'offline', configuration: null };
    const explicit = { ...botDefaults(), configuration: null, reason: 'offline', workers: [offline] };
    expect(parseBotDefaults(explicit, botId(20))).toEqual(explicit);
    for (const patch of [{ workerId: botId(21) }, { reason: 'offline' }, { configuration: null }, { workers: [] }, { workers: [botWorkerDefaults(), botWorkerDefaults()] }]) {
      expect(() => parseBotDefaults({ ...botDefaults(), ...patch })).toThrow();
    }
    expect(() => parseBotDefaults(botDefaults(), botId(21))).toThrow();
  });
  it('rejects invalid provider observations and platform directories in defaults', () => {
    const original = botDefaults();
    const variants = [
      { ...botWorkerDefaults(), platform: 'windows' },
      { ...botWorkerDefaults(), providers: botWorkerDefaults().providers.map(p => ({ ...p, args: [''] })) },
      { ...botWorkerDefaults(), providers: botWorkerDefaults().providers.map(p => ({ ...p, args: Array(129).fill('arg') })) },
      { ...botWorkerDefaults(), providers: botWorkerDefaults().providers.map(p => ({ ...p, model: 'x'.repeat(257) })) },
    ];
    for (const worker of variants) expect(() => parseBotDefaults({ ...original, workers: [worker] })).toThrow();
  });
});

describe('Bot deletion API', () => {
  it.each(['pending', 'failed', 'completed'] as const)('returns the actual %s cleanup state with the original exact deletion identity', async state => {
    expect(botsApi.deleteBot).toBeTypeOf('function');
    const bot = deletedBot(state), fetch = vi.fn().mockResolvedValue(botResponse(bot)); vi.stubGlobal('fetch', fetch);
    expect(await botsApi.deleteBot(botId().toUpperCase(), deleteInput(), signal(), admission())).toEqual(bot);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/me/bots/${botId()}`);
    expect(fetch.mock.calls[0]![1].method).toBe('DELETE');
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual(deleteInput());
  });
  it('checks a replay against requestedVersion even after cleanup advances the Bot version', async () => {
    const bot = { ...deletedBot('completed'), version: '9007199254740998' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(botResponse(bot)));
    expect(await botsApi.deleteBot(botId(), deleteInput(), signal(), admission())).toEqual(bot);
  });
  it.each([
    () => Promise.reject(new TypeError('response lost')),
    () => Promise.resolve(botError(500, 'internal_error')),
    () => Promise.resolve(botResponse(deletedBot(), BOT_USER, 201)),
    () => Promise.resolve(botResponse(botDefinition())),
    () => Promise.resolve(botResponse({ ...deletedBot(), id: botId(2) })),
    () => Promise.resolve(botResponse({ ...deletedBot(), deletion: { ...deletedBot().deletion, deletionId: botId(51) } })),
    () => Promise.resolve(botResponse({ ...deletedBot(), deletion: { ...deletedBot().deletion, requestedVersion: '1' } })),
  ])('retains the frozen request for observation after an unknown deletion outcome %#', async response => {
    const fetch = vi.fn(response); vi.stubGlobal('fetch', fetch);
    await expect(botsApi.deleteBot(botId(), deleteInput(), signal(), admission())).rejects.toMatchObject({ name: 'BotDeletionUnknown', id: botId(), input: deleteInput() });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['version_conflict', 'resource_conflict'])('preserves a definite %s rejection without retrying', async code => {
    const fetch = vi.fn().mockResolvedValue(botError(409, code)); vi.stubGlobal('fetch', fetch);
    await expect(botsApi.deleteBot(botId(), deleteInput(), signal(), admission())).rejects.toMatchObject({ kind: 'server', status: 409, code });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not dispatch malformed IDs or inexact versions', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const input of [{ ...deleteInput(), ifVersion: '01' }, { ...deleteInput(), ifVersion: '0' }, { ...deleteInput(), ifVersion: '9223372036854775808' }, { ...deleteInput(), deletionId: 'bad' }]) {
      await expect(botsApi.deleteBot(botId(), input, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    }
    await expect(botsApi.deleteBot('bad', deleteInput(), signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('treats missing or changed response principals as unknown and invalidates the changed identity', async () => {
    const gate = admission(), fetch = vi.fn().mockResolvedValueOnce(botResponse(deletedBot(), null)).mockResolvedValueOnce(botResponse(deletedBot(), botId(40)));
    vi.stubGlobal('fetch', fetch);
    await expect(botsApi.deleteBot(botId(), deleteInput(), signal(), gate)).rejects.toMatchObject({ name: 'BotDeletionUnknown', cause: { kind: 'protocol' } });
    await expect(botsApi.deleteBot(botId(), deleteInput(), signal(), gate)).rejects.toMatchObject({ name: 'BotDeletionUnknown', cause: { code: 'principal_mismatch' } });
    expect(gate.onPrincipalMismatch).toHaveBeenCalledOnce();
  });
  it('retains dispatched aborts without classifying a pre-dispatch abort as unknown', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => { controller.abort(); throw new DOMException('Aborted', 'AbortError'); }); vi.stubGlobal('fetch', fetch);
    await expect(botsApi.deleteBot(botId(), deleteInput(), controller.signal, admission())).rejects.toMatchObject({ name: 'BotDeletionUnknown', id: botId(), input: deleteInput() });
    await expect(botsApi.deleteBot(botId(), deleteInput(), controller.signal, admission())).rejects.not.toBeInstanceOf(botsApi.BotDeletionUnknown);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not let caller mutation replace the identity of a dispatched deletion', async () => {
    const original = deleteInput(), fetch = vi.fn(async (_url: unknown, _options: RequestInit) => { original.ifVersion = '3'; original.deletionId = botId(51); throw new TypeError('lost'); }); vi.stubGlobal('fetch', fetch);
    await expect(botsApi.deleteBot(botId(), original, signal(), admission())).rejects.toMatchObject({ name: 'BotDeletionUnknown', input: deleteInput() });
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual(deleteInput());
  });
});

describe('Bot account API', () => {
  it.each([{}, { model: 'chosen' }, { reasoningEffort: 'none' }, { model: 'chosen', reasoningEffort: 'none' }])('sends only explicit native overrides %j', async native => {
    const overrides = { workerId: botId(20), ...native };
    const config = { ...botDefinition().resolvedConfiguration, model: native.model ?? null, reasoningEffort: native.reasoningEffort ?? null, selection: { schemaVersion: 1, modelSource: native.model ? 'explicit' : 'native', reasoningEffortSource: native.reasoningEffort ? 'explicit' : 'native' } };
    const value = { ...botDefinition(), requestedOverrides: overrides, resolvedConfiguration: config };
    const fetch = vi.fn().mockResolvedValue(botResponse(value)); vi.stubGlobal('fetch', fetch);
    expect(await createBot({ id: botId(), name: 'Assistant 1', overrides }, signal(), admission())).toEqual(value);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ id: botId(), name: 'Assistant 1', overrides });
  });
  it('queries native overrides without mutating them or submitting creation', async () => {
    const fetch = vi.fn().mockResolvedValue(botResponse(botDefaults())); vi.stubGlobal('fetch', fetch);
    await getBotDefaults(botId(20), signal(), admission(), { cwd: '/ordinary/directory', provider: 'codex', model: 'native/model', reasoningEffort: 'none' });
    expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/me/bots/defaults?workerId=${botId(20)}&cwd=%2Fordinary%2Fdirectory&provider=codex&model=native%2Fmodel&reasoningEffort=none`);
    expect(fetch.mock.calls[0]![1].method).not.toBe('POST');
  });
  it.each([{ model: null }, { model: '' }, { model: '汉'.repeat(86) }, { reasoningEffort: null }, { reasoningEffort: '' }, { reasoningEffort: 'high\n' }, { reasoningEffort: '汉'.repeat(22) }])('rejects malformed native overrides without dispatch %#', async overrides => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(createBot({ id: botId(), name: 'Assistant 1', overrides } as unknown as Parameters<typeof createBot>[0], signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains native overrides and original ID after a lost creation response', async () => {
    const overrides = { workerId: botId(20), model: 'chosen', reasoningEffort: 'none' };
    const value = { ...botDefinition(), requestedOverrides: overrides, resolvedConfiguration: { ...botDefinition().resolvedConfiguration, model: 'chosen', reasoningEffort: 'none', selection: { schemaVersion: 1, modelSource: 'explicit', reasoningEffortSource: 'explicit' } } };
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('lost')).mockResolvedValueOnce(botResponse(value)); vi.stubGlobal('fetch', fetch);
    await expect(createBot({ id: botId(), name: 'Assistant 1', overrides }, signal(), admission())).rejects.toMatchObject({ name: 'BotCreationUnknown', id: botId() });
    expect(await getBot(botId(), signal(), admission())).toEqual(value);
    expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual(['POST', undefined]);
  });
  it('reads authenticated pages, original identities and Worker-specific defaults', async () => {
    const page = { items: [botDefinition()], nextCursor: null };
    const fetch = vi.fn().mockResolvedValueOnce(botResponse(page)).mockResolvedValueOnce(botResponse(botDefinition())).mockResolvedValueOnce(botResponse(botDefaults()));
    vi.stubGlobal('fetch', fetch);
    expect(await listBots({ limit: 50, cursor: 'next/+ token' }, signal(), admission())).toEqual(page);
    expect(await getBot(botId().toUpperCase(), signal(), admission())).toEqual(botDefinition());
    expect(await getBotDefaults(botId(20), signal(), admission())).toEqual(botDefaults());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/me/bots?limit=50&cursor=next%2F%2B+token', `/api/v1/me/bots/${botId()}`, `/api/v1/me/bots/defaults?workerId=${botId(20)}`]);
  });
  it('sends only an immutable ID, name and explicit overrides for creation', async () => {
    const fetch = vi.fn().mockResolvedValue(botResponse(botDefinition())); vi.stubGlobal('fetch', fetch);
    expect(await createBot({ id: botId(), name: 'Assistant 1' }, signal(), admission())).toEqual(botDefinition());
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ id: botId(), name: 'Assistant 1' });
  });
  it.each([() => Promise.reject(new Error('offline')), () => Promise.resolve(botResponse({}, BOT_USER, 200)), () => Promise.resolve(botError(500, 'internal_error'))])('marks dispatched unknown outcomes for original-ID observation only %#', async response => {
    const fetch = vi.fn(response); vi.stubGlobal('fetch', fetch);
    await expect(createBot({ id: botId(), name: 'Assistant 1' }, signal(), admission())).rejects.toMatchObject({ name: 'BotCreationUnknown', id: botId() });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('keeps definite rejections distinct from unknown outcomes and does not send invalid input', async () => {
    const fetch = vi.fn().mockResolvedValue(botError(409, 'resource_conflict')); vi.stubGlobal('fetch', fetch);
    await expect(createBot({ id: botId(), name: 'Assistant 1' }, signal(), admission())).rejects.toMatchObject({ kind: 'server', status: 409 });
    await expect(createBot({ id: botId(), name: '' }, signal(), admission())).rejects.not.toBeInstanceOf(BotCreationUnknown);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('retains the original ID after an aborted dispatched create but never dispatches a pre-aborted input', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => { controller.abort(); throw new DOMException('Aborted', 'AbortError'); }); vi.stubGlobal('fetch', fetch);
    await expect(createBot({ id: botId(), name: 'Assistant 1' }, controller.signal, admission())).rejects.toMatchObject({ name: 'BotCreationUnknown', id: botId() });
    await expect(createBot({ id: botId(), name: 'Assistant 1' }, controller.signal, admission())).rejects.not.toBeInstanceOf(BotCreationUnknown);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('reports dispatch only after the request passes admission', async () => {
    const dispatch = vi.fn(), controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(botResponse(botDefinition())); vi.stubGlobal('fetch', fetch);
    controller.abort();
    await expect(createBot({ id: botId(), name: 'Assistant 1' }, controller.signal, { ...admission(), onDispatch: dispatch })).rejects.toBeDefined();
    expect(dispatch).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    await createBot({ id: botId(), name: 'Assistant 1' }, signal(), { ...admission(), onDispatch: dispatch });
    expect(dispatch).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
  });
  it('checks frozen explicit overrides in successful create responses', async () => {
    const overrides = { workerId: botId(20), cwd: '/ordinary/directory', provider: 'codex' as const };
    const fetch = vi.fn().mockResolvedValueOnce(botResponse({ ...botDefinition(), requestedOverrides: overrides })).mockResolvedValueOnce(botResponse(botDefinition())); vi.stubGlobal('fetch', fetch);
    expect((await createBot({ id: botId(), name: ' Assistant 1 ', overrides }, signal(), admission())).requestedOverrides).toEqual(overrides);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ id: botId(), name: 'Assistant 1', overrides });
    await expect(createBot({ id: botId(), name: 'Assistant 1', overrides }, signal(), admission())).rejects.toBeInstanceOf(BotCreationUnknown);
  });
  it('rejects missing principals, unexpected HTTP status, unavailable resources and leaked deletion definitions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(botResponse(botDefinition(), null)).mockResolvedValueOnce(botResponse(botDefinition(), BOT_USER, 201)).mockResolvedValueOnce(botError(404, 'not_found')));
    await expect(getBot(botId(), signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(getBot(botId(), signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(getBot(botId(), signal(), admission())).rejects.toMatchObject({ kind: 'server', status: 404, code: 'not_found' });
  });
  it('rejects response principal, resource and owner mismatch', async () => {
    const gate = admission();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(botResponse(botDefinition(), botId(40))).mockResolvedValueOnce(botResponse(botDefinition(2))).mockResolvedValueOnce(botResponse({ ...botDefinition(), ownerUserId: botId(40) })));
    await expect(getBot(botId(), signal(), gate)).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(gate.onPrincipalMismatch).toHaveBeenCalledOnce();
    await expect(getBot(botId(), signal(), gate)).rejects.toMatchObject({ kind: 'protocol' });
    await expect(getBot(botId(), signal(), gate)).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('rejects malformed page IDs, duplicate entries and invalid queries', async () => {
    const fetch = vi.fn().mockResolvedValue(botResponse({ items: [botDefinition(), botDefinition()], nextCursor: null })); vi.stubGlobal('fetch', fetch);
    await expect(listBots({}, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(listBots({ limit: 0 }, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(listBots({ cursor: '' }, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('Bot attention API', () => {
  it('requests the attention projection for list, detail and create but not defaults', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(botResponse({ items: [botDefinition()], nextCursor: null }))
      .mockResolvedValueOnce(botResponse(botDefinition())).mockResolvedValueOnce(botResponse(botDefinition()))
      .mockResolvedValueOnce(botResponse(botDefaults()));
    vi.stubGlobal('fetch', fetch);
    await listBots({}, signal(), admission());
    await getBot(botId(), signal(), admission());
    await createBot({ id: botId(), name: 'Assistant 1' }, signal(), admission());
    await getBotDefaults(null, signal(), admission());
    expect(fetch.mock.calls.map(([, options]) => new Headers(options.headers).get('Daynight-Bot-Attention'))).toEqual(['1', '1', '1', null]);
  });
  it.each([null, '2', '1, 1'])('rejects an unconfirmed attention projection %s without replaying creation', async header => {
    const response = (value: unknown) => {
      const result = botResponse(value);
      if (header === null) result.headers.delete('Daynight-Bot-Attention');
      else result.headers.set('Daynight-Bot-Attention', header);
      return result;
    };
    const fetch = vi.fn().mockResolvedValueOnce(response({ items: [botDefinition()], nextCursor: null }))
      .mockResolvedValueOnce(response(botDefinition())).mockResolvedValueOnce(response(botDefinition()));
    vi.stubGlobal('fetch', fetch);
    await expect(listBots({}, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(getBot(botId(), signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(createBot({ id: botId(), name: 'Assistant 1' }, signal(), admission())).rejects.toMatchObject({ name: 'BotCreationUnknown', id: botId() });
    expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
  });

  it.each([-1, 0.5, '1', null, undefined, Number.MAX_SAFE_INTEGER + 1])('rejects invalid attention counts %s', attentionCount => {
    expect(() => parseBot({ ...botDefinition(), attentionCount }, BOT_USER)).toThrow();
  });
  it('preserves the server attention count and sends one exact seen request', async () => {
    expect(parseBot({ ...botDefinition(), attentionCount: 3 }, BOT_USER)).toMatchObject({ attentionCount: 3 });
    const fetch = vi.fn().mockResolvedValue(botResponse({ targetBotId: botId() })); vi.stubGlobal('fetch', fetch);
    await botsApi.markBotAttentionSeen(botId().toUpperCase(), signal(), admission());
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/bots/${botId()}/attention/seen`);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: '{}' });
  });
  it.each([
    () => Promise.reject(new TypeError('response lost')),
    () => Promise.resolve(botResponse({ targetBotId: botId(2) })),
    () => Promise.resolve(botResponse({ targetBotId: botId() }, BOT_USER, 201)),
    () => Promise.resolve(botResponse({ targetBotId: botId() }, null)),
    () => Promise.resolve(botError(403, 'forbidden')),
  ])('does not replay a failed or unconfirmed seen request %#', async response => {
    const fetch = vi.fn(response); vi.stubGlobal('fetch', fetch);
    await expect(botsApi.markBotAttentionSeen(botId(), signal(), admission())).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects a changed principal and invalid request identity', async () => {
    const gate = admission(), fetch = vi.fn().mockResolvedValue(botResponse({ targetBotId: botId() }, botId(40))); vi.stubGlobal('fetch', fetch);
    await expect(botsApi.markBotAttentionSeen(botId(), signal(), gate)).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(gate.onPrincipalMismatch).toHaveBeenCalledOnce();
    await expect(botsApi.markBotAttentionSeen('bad', signal(), gate)).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
