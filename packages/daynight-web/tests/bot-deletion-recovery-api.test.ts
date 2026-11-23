import { afterEach, expect, it, vi } from 'vitest';
import { getBotDeletionRecovery, parseBotDeletionRecovery } from '../src/api/bot-deletion-recovery';
import { invalidateAuthRequests } from '../src/api/client';
import { BOT_USER, botId, botError, botResponse } from './helpers/bots';
import { recoveryResource } from './helpers/bot-deletion-recovery';

afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });
const admission = () => ({ userId: BOT_USER, onPrincipalMismatch: vi.fn() });
const signal = () => new AbortController().signal;

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
it('handles the old router plain 404 as unsupported without invalidating the account', async () => {
  const identity = admission();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('404 page not found\n', { status: 404, headers: { 'Content-Type': 'text/plain' } })));
  await expect(getBotDeletionRecovery(botId(), signal(), identity)).rejects.toMatchObject({ kind: 'server', status: 404, code: 'deletion_recovery_unsupported' });
  expect(identity.onPrincipalMismatch).not.toHaveBeenCalled();
});
it('does not treat a foreign principal on a 404 as an unsupported capability', async () => {
  const identity = admission(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(botError(404, 'not_found', botId(99))));
  await expect(getBotDeletionRecovery(botId(), signal(), identity)).rejects.toMatchObject({ code: 'principal_mismatch' });
  expect(identity.onPrincipalMismatch).toHaveBeenCalledOnce();
});
