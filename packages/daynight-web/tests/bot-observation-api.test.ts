import { afterEach, expect, it, vi } from 'vitest';
import { getBotObservation, parseBotObservation } from '../src/api/bot-observation';
import { invalidateAuthRequests } from '../src/api/client';
import { botObservation } from './helpers/bot-observation';
import { BOT_USER, botError, botId, botResponse } from './helpers/bots';

afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });
it.each(['offline', 'connecting', 'recovering', 'idle', 'working', 'abnormal'] as const)('decodes %s without deriving activity from Worker availability', state => {
  const value = botObservation(1, { state, reason: state, ...(state === 'offline' ? { freshUntil: null } : {}), ...(state === 'working' ? { currentTurnId: 'turn-1' } : {}) });
  expect(parseBotObservation(value, botId())).toEqual(value);
});
it('preserves exact versions, unknown identities and the initial zero connection epoch', () => {
  const value = botObservation(1, { botVersion: '9223372036854775807', hostingGeneration: '9007199254740993', connectionEpoch: '0', state: 'connecting', nativeSessionId: null });
  expect(parseBotObservation(value, botId())).toEqual(value);
  const unknown = botObservation(1, { state: 'offline', machine: null, sessionId: null, testExecutionId: null, nativeSessionId: null, hostingGeneration: null, executionGeneration: null, connectionEpoch: null, workerLastSeenAt: null, sessionLastSeenAt: null, freshUntil: null });
  expect(parseBotObservation(unknown, botId())).toEqual(unknown);
});
it('preserves server-admitted whitespace in machine names and native metadata', () => {
  const working = botObservation(1, { state: 'working', machine: { id: botId(100), name: 'Office\tNorth\nLaptop' }, nativeSessionId: 'native\tthread\n1', currentTurnId: 'turn\t1\n2' });
  expect(parseBotObservation(working, botId())).toEqual(working);
  const failure = botObservation(1, { state: 'abnormal', reason: 'provider\tstartup\nfailed' });
  expect(parseBotObservation(failure, botId())).toEqual(failure);
});
it.each([
  { machine: { id: botId(100), name: 'Office\0Laptop' } }, { machine: { id: botId(100), name: '\t\n\u0085' } },
  { nativeSessionId: 'native\0thread' }, { state: 'working', currentTurnId: 'turn\0id' }, { state: 'abnormal', reason: 'startup\0failed' },
])('rejects NUL and whitespace-only metadata %#', patch => {
  expect(() => parseBotObservation({ ...botObservation(), ...patch }, botId())).toThrow();
});
it.each([
  { schemaVersion: 2 }, { botId: botId(2) }, { botVersion: 1 }, { botVersion: '01' }, { botVersion: '0' }, { botVersion: '9223372036854775808' },
  { hostingGeneration: '0' }, { executionGeneration: '1.5' }, { connectionEpoch: -1 }, { state: 'ready' }, { reason: '' }, { reason: '\ud800' },
  { provider: 'other' }, { machine: { id: '', name: 'Machine' } }, { machine: { id: 'a', name: 'a', extra: true } },
  { observedAt: 'yesterday' }, { freshUntil: '2026-02-30T12:00:00Z' }, { sessionId: null }, { nativeSessionId: null },
  { currentTurnId: 'turn' }, { state: 'offline' }, { send: true },
])('rejects malformed or conflicting observation %#', patch => {
  expect(() => parseBotObservation({ ...botObservation(), ...patch }, botId())).toThrow();
});
it('rejects missing fields', () => {
  const { reason: _reason, ...value } = botObservation();
  expect(() => parseBotObservation(value, botId())).toThrow();
});
it('reads the independent endpoint with principal validation and no mutation', async () => {
  const fetch = vi.fn().mockResolvedValue(botResponse(botObservation())); vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  expect(await getBotObservation(botId(), signal, { userId: BOT_USER, onPrincipalMismatch: vi.fn() })).toEqual(botObservation());
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe(`/api/v1/me/bots/${botId()}/observation`); expect(init.body).toBeUndefined(); expect(init.method ?? 'GET').toBe('GET');
});
it('rejects another principal before publishing response data', async () => {
  const mismatch = vi.fn(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(botResponse(botObservation(), botId(99))));
  await expect(getBotObservation(botId(), new AbortController().signal, { userId: BOT_USER, onPrincipalMismatch: mismatch })).rejects.toMatchObject({ code: 'principal_mismatch' });
  expect(mismatch).toHaveBeenCalledOnce();
});
it.each([403, 404, 503])('retains a %i observation failure', async status => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(botError(status, 'capability_error')));
  await expect(getBotObservation(botId(), new AbortController().signal, { userId: BOT_USER, onPrincipalMismatch: vi.fn() })).rejects.toMatchObject({ kind: 'server', status, code: 'capability_error' });
});
it('rejects a non-200 success and invalid request identity', async () => {
  const fetch = vi.fn().mockResolvedValue(botResponse(botObservation(), BOT_USER, 201)); vi.stubGlobal('fetch', fetch);
  await expect(getBotObservation(botId(), new AbortController().signal, { userId: BOT_USER, onPrincipalMismatch: vi.fn() })).rejects.toMatchObject({ kind: 'protocol' });
  await expect(getBotObservation('invalid', new AbortController().signal, { userId: BOT_USER, onPrincipalMismatch: vi.fn() })).rejects.toMatchObject({ kind: 'protocol' });
  expect(fetch).toHaveBeenCalledOnce();
});
