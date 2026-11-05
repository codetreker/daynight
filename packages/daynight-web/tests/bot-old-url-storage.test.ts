import { afterEach, expect, it, vi } from 'vitest';
import { TaskSessionClient, clearIndependentSessionStorage } from '../src/features/task-agent-session/client';
import { BotSessionStorage } from '../src/features/bots/session-storage';
import { getBotDeletionCoordinator } from '../src/features/bots/deletion-coordinator';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { botFixture } from './helpers/bot-session';
import { BOT_USER, botDefinition, botId, botResponse } from './helpers/bots';

const clients: TaskSessionClient[] = [];
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
afterEach(() => {
  clients.splice(0).forEach(client => client.close()); scopes.splice(0).forEach(scope => scope.dispose());
  sessionStorage.clear(); localStorage.clear(); vi.unstubAllGlobals();
});
async function visitOldUrl(userId: string, sessionId: string, text: string) {
  const binding = { ownerUserId: userId, botId: botId(), sessionId, testExecutionId: botId(40) };
  const fixture = botFixture(binding);
  // TestSessionPage uses the same independent client without a Bot namespace.
  const client = new TaskSessionClient({ api: fixture.api, userId, testSessionId: sessionId, isCurrent: () => true, onPrincipalMismatch: vi.fn(), storage: sessionStorage });
  clients.push(client); await client.start();
  await vi.waitFor(() => expect(client.snapshot().connected).toBe(true));
  client.setDraft(text); vi.mocked(fixture.api.command).mockRejectedValue(new Error('receipt unknown'));
  await expect(client.send(text)).rejects.toThrow('receipt unknown');
  client.close();
  const prefixes = [`daynight:session-draft:${userId}:test:${sessionId}:`, `daynight:session-operations:${userId}:${sessionId}:`];
  const entries = Object.entries(sessionStorage).filter(([key]) => prefixes.some(prefix => key.startsWith(prefix)));
  expect(entries.some(([key]) => key.startsWith(prefixes[0]!))).toBe(true);
  expect(entries.some(([key]) => key.startsWith(prefixes[1]!))).toBe(true);
  return entries;
}

it.each(['pending', 'failed', 'completed', 'unknown'] as const)('handles %s Bot deletion after an old Test URL leaves raw drafts and unknown receipts', async outcome => {
  const sessionId = botId(30);
  const owned = await visitOldUrl(BOT_USER, sessionId, 'Bot history through its old URL');
  const otherSession = await visitOldUrl(BOT_USER, botId(31), 'another independent Session');
  const otherAccount = await visitOldUrl(botId(80), sessionId, 'another account');
  const otherBot = new BotSessionStorage(JSON.stringify([BOT_USER, botId(2), botId(32), botId(42)]), sessionStorage);
  otherBot.setItem('draft', 'another Bot draft'); otherBot.setItem('receipt', 'another Bot receipt');
  const taskKey = `daynight:session-draft:${BOT_USER}:task:${botId(50)}:${botId(51)}:fence`;
  const taskReceipt = `daynight:session-operations:${BOT_USER}:${botId(52)}:task:fence`;
  sessionStorage.setItem(taskKey, 'independent Task draft'); sessionStorage.setItem(taskReceipt, 'independent Task receipt');
  const similar = [
    `daynight:session-draft:${BOT_USER}:test:${sessionId}0:fence`,
    `daynight:session-operations:${BOT_USER}:${sessionId}0:fence`,
    `daynight:session-draft:${BOT_USER}0:test:${sessionId}:fence`,
    `daynight:session-operations:${BOT_USER}0:${sessionId}:fence`,
  ];
  for (const key of similar) sessionStorage.setItem(key, 'prefix neighbor');
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const coordinator = getBotDeletionCoordinator(scope);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method !== 'DELETE') return botResponse(botDefinition());
    if (outcome === 'unknown') throw new Error('deletion response lost');
    const request = JSON.parse(init.body);
    return botResponse({ id: botId(), workerId: botId(20), version: '2', deletion: {
      deletionId: request.deletionId, requestedVersion: request.ifVersion,
      workerCleanup: { state: outcome, code: outcome === 'failed' ? 'stop_failed' : null },
      serverCleanup: { state: outcome === 'completed' ? 'completed' : 'pending', code: null },
    } });
  }));
  await coordinator.begin({ ...botDefinition(), sessionId, testExecutionId: botId(40) });
  expect(coordinator.snapshot()[0]?.phase).toBe(outcome);
  expect(owned.map(([key]) => sessionStorage.getItem(key))).toEqual(outcome === 'unknown' ? owned.map(([, value]) => value) : owned.map(() => null));
  expect(otherSession.map(([key]) => sessionStorage.getItem(key))).toEqual(otherSession.map(([, value]) => value));
  expect(otherAccount.map(([key]) => sessionStorage.getItem(key))).toEqual(otherAccount.map(([, value]) => value));
  expect(otherBot.getItem('draft')).toBe('another Bot draft'); expect(otherBot.getItem('receipt')).toBe('another Bot receipt');
  expect(sessionStorage.getItem(taskKey)).toBe('independent Task draft'); expect(sessionStorage.getItem(taskReceipt)).toBe('independent Task receipt');
  expect(similar.map(key => sessionStorage.getItem(key))).toEqual(similar.map(() => 'prefix neighbor'));
});

it('uses explicit storage and keeps clearing other owned keys after one removal fails', () => {
  const sessionId = botId(30), draft = `daynight:session-draft:${BOT_USER}:test:${sessionId}:generation`, receipt = `daynight:session-operations:${BOT_USER}:${sessionId}:generation`;
  sessionStorage.setItem(draft, 'draft'); sessionStorage.setItem(receipt, 'receipt');
  clearIndependentSessionStorage(BOT_USER, sessionId, null);
  expect(sessionStorage.getItem(draft)).toBe('draft'); expect(sessionStorage.getItem(receipt)).toBe('receipt');
  const storage: Storage = {
    get length() { return sessionStorage.length; }, key: index => sessionStorage.key(index), getItem: key => sessionStorage.getItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value), clear: () => sessionStorage.clear(),
    removeItem: key => { if (key === receipt) throw new Error('denied'); sessionStorage.removeItem(key); },
  };
  expect(() => clearIndependentSessionStorage(BOT_USER, sessionId, storage)).not.toThrow();
  expect(sessionStorage.getItem(draft)).toBeNull(); expect(sessionStorage.getItem(receipt)).toBe('receipt');
});
