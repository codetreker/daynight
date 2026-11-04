import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotCreationUnknown, createBot, getBot, getBotDefaults, listBots, parseBot, parseBotDefaults } from '../src/api/bots';
import { invalidateAuthRequests } from '../src/api/client';
import { BOT_USER, botDefaults, botDefinition, botError, botId, botResponse, botWorkerDefaults } from './helpers/bots';

const admission = () => ({ userId: BOT_USER, onPrincipalMismatch: vi.fn() });
const signal = () => new AbortController().signal;
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe('Bot response contracts', () => {
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

describe('Bot account API', () => {
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
