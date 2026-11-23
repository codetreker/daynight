import { afterEach, expect, it, vi } from 'vitest';
import { BotRecoveryUnknown, getBotDeletionRecovery, listBotDeletionRecoveries, parseBotDeletionRecovery, submitBotDeletionRecovery, type BotRecoveryInput } from '../src/api/bot-deletion-recovery';
import { invalidateAuthRequests } from '../src/api/client';
import { BOT_USER, botId, botError, botResponse } from './helpers/bots';
import { recoveryResource } from './helpers/bot-deletion-recovery';

afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });
const admission = () => ({ userId: BOT_USER, onPrincipalMismatch: vi.fn() });
const signal = () => new AbortController().signal;
const input = (): BotRecoveryInput => ({ action: 'accept_unverified', ifVersion: '5', deletionId: botId(90), operationId: botId(91), acknowledgeLocalUnverified: true, reason: 'Original records lost' });

it('reads recovery independently of the old Bot response and preserves local-unverified settlement', async () => {
  const value = recoveryResource(true, 'completed');
  const fetcher = vi.fn().mockResolvedValue(botResponse(value)); vi.stubGlobal('fetch', fetcher);
  expect(await getBotDeletionRecovery(botId(), signal(), admission())).toEqual(value);
  expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/me/bots/${botId()}/deletion-recovery`);
  expect(value.workerCleanup.state).toBe('failed');
});
it.each([
  { schemaVersion: 2 }, { version: '3' }, { botId: botId(99) }, { requiresStopProof: false }, { recoveryRequired: false },
  { originalBinding: null }, { workerCleanup: { state: 'completed', code: 'execution_evidence_missing' } },
])('rejects contradictory recovery evidence %#', patch => {
  expect(() => parseBotDeletionRecovery({ ...recoveryResource(), ...patch }, botId(), BOT_USER)).toThrow();
});
it('submits the explicit original identity and refuses malformed acceptance before dispatch', async () => {
  const fetcher = vi.fn().mockResolvedValue(botResponse(recoveryResource(true, 'completed'))); vi.stubGlobal('fetch', fetcher);
  expect(await submitBotDeletionRecovery(botId(), input(), signal(), admission())).toEqual(recoveryResource(true, 'completed'));
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual(input());
  await expect(submitBotDeletionRecovery(botId(), { ...input(), acknowledgeLocalUnverified: false } as unknown as BotRecoveryInput, signal(), admission())).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
});
it.each(['network', 'malformed', 'identity', 'server'] as const)('retains the operation after an unknown %s outcome without replaying it', async mode => {
  const fetcher = vi.fn().mockImplementation(async () => {
    if (mode === 'network') throw new Error('lost');
    if (mode === 'server') return botError(500, 'internal_error');
    return botResponse(mode === 'malformed' ? {} : recoveryResource(true), mode === 'identity' ? botId(99) : BOT_USER);
  }); vi.stubGlobal('fetch', fetcher);
  await expect(submitBotDeletionRecovery(botId(), input(), signal(), admission())).rejects.toMatchObject({ input: input(), botId: botId() });
  expect(fetcher).toHaveBeenCalledOnce();
});
it('keeps a definite version conflict distinct from unknown acceptance', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(botError(409, 'version_conflict')));
  const error = await submitBotDeletionRecovery(botId(), input(), signal(), admission()).catch(error => error);
  expect(error).not.toBeInstanceOf(BotRecoveryUnknown); expect(error.code).toBe('version_conflict');
});
it('validates cold recovery pages without treating malformed contents as an empty list', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(botResponse({ items: [recoveryResource()], nextCursor: 'next' })).mockResolvedValueOnce(botResponse({ items: [recoveryResource(), recoveryResource()], nextCursor: null })); vi.stubGlobal('fetch', fetcher);
  expect(await listBotDeletionRecoveries(null, signal(), admission())).toMatchObject({ items: [recoveryResource()], nextCursor: 'next' });
  await expect(listBotDeletionRecoveries('next', signal(), admission())).rejects.toThrow();
  expect(fetcher.mock.calls[1]![0]).toBe('/api/v1/me/bot-deletion-recoveries?limit=100&cursor=next');
});
it('handles the old router plain 404 as unsupported without invalidating the account', async () => {
  const identity = admission();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('404 page not found\n', { status: 404, headers: { 'Content-Type': 'text/plain' } })));
  await expect(getBotDeletionRecovery(botId(), signal(), identity)).rejects.toMatchObject({ kind: 'server', status: 404, code: 'deletion_recovery_unsupported' });
  await expect(listBotDeletionRecoveries(null, signal(), identity)).rejects.toMatchObject({ kind: 'server', status: 404 });
  await expect(submitBotDeletionRecovery(botId(), input(), signal(), identity)).rejects.toMatchObject({ kind: 'server', status: 404 });
  expect(identity.onPrincipalMismatch).not.toHaveBeenCalled();
});
it('does not treat a foreign principal on a 404 as an unsupported capability', async () => {
  const identity = admission(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(botError(404, 'not_found', botId(99))));
  await expect(getBotDeletionRecovery(botId(), signal(), identity)).rejects.toMatchObject({ code: 'principal_mismatch' });
  expect(identity.onPrincipalMismatch).toHaveBeenCalledOnce();
});
