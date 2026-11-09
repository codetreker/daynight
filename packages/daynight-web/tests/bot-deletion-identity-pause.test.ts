import { afterEach, expect, it, vi } from 'vitest';
import { pauseAuthRequests } from '../src/api/client';
import { getBotDeletionCoordinator } from '../src/features/bots/deletion-coordinator';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { BOT_USER, botDefinition, botError, botId, botResponse } from './helpers/bots';

const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
let resume: (() => void) | undefined;
afterEach(() => { scopes.splice(0).forEach(scope => scope.dispose()); resume?.(); resume = undefined; sessionStorage.clear(); });
function fixture() {
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const coordinator = getBotDeletionCoordinator(scope);
  const cache = { blockBot: vi.fn(), unblockBot: vi.fn(), invalidateBot: vi.fn() }; coordinator.attachCache(cache);
  const bot = { ...botDefinition(), sessionId: botId(31), testExecutionId: botId(41), roleConfiguration: { instructions: 'Assistant', revision: '1', digest: 'a'.repeat(64) } };
  const response = Promise.withResolvers<Response>();
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'DELETE' ? response.promise : botResponse(bot));
  vi.stubGlobal('fetch', fetcher);
  const record = () => coordinator.snapshot()[0]!;
  const deleted = () => ({ id: bot.id, workerId: bot.workerId, version: '2', deletion: { deletionId: record().request!.deletionId, requestedVersion: '1', workerCleanup: { state: 'completed', code: null }, serverCleanup: { state: 'completed', code: null } } });
  return { scope, coordinator, cache, bot, response, fetcher, record, deleted };
}

it.each(['409', '500', 'network'] as const)('preserves a %s DELETE outcome through temporary identity pause without replay', async outcome => {
  const f = fixture(), operation = f.coordinator.begin(f.bot);
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  const original = f.record().request;
  resume = pauseAuthRequests();
  if (outcome === 'network') f.response.reject(new Error('lost response'));
  else f.response.resolve(botError(Number(outcome), outcome === '409' ? 'version_conflict' : 'failure'));
  await operation;
  expect(f.record().phase).toBe('unknown'); expect(f.record().request).toEqual(original);
  const stored = JSON.parse(sessionStorage.getItem(`daynight.bot.deletions:${BOT_USER}`)!);
  expect(stored[0]).toMatchObject({ phase: 'unknown', request: original, rejected: outcome === '409' });
  expect(f.cache.unblockBot).not.toHaveBeenCalled(); expect(f.coordinator.sessionAdmission(f.bot.sessionId)).toBe('blocked');
  expect(f.fetcher).toHaveBeenCalledOnce();
  resume(); await f.coordinator.check(f.bot.id);
  expect(f.record().phase).toBe(outcome === '409' ? 'rejected' : 'unknown');
  expect(f.coordinator.sessionAdmission(f.bot.sessionId)).toBe(outcome === '409' ? 'allowed' : 'blocked');
  expect(f.cache.unblockBot.mock.calls.length > 0).toBe(outcome === '409');
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  expect(f.record().request).toEqual(original);
});

it('retains an authenticated successful DELETE while identity is paused', async () => {
  const f = fixture(), operation = f.coordinator.begin(f.bot);
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  resume = pauseAuthRequests(); f.response.resolve(botResponse(f.deleted()));
  await vi.waitFor(() => expect(f.record().phase).toBe('completed'));
  await operation;
  expect(f.coordinator.sessionAdmission(f.bot.sessionId)).toBe('revoked'); expect(f.cache.invalidateBot).toHaveBeenCalled();
  expect(f.fetcher).toHaveBeenCalledOnce();
  resume(); await f.coordinator.check(f.bot.id);
  expect(f.record().phase).toBe('completed'); expect(f.cache.unblockBot).not.toHaveBeenCalled();
});

it.each([false, true])('retains an authenticated detail observation only for a valid scope (invalidated=%s)', async invalidated => {
  const f = fixture(); f.response.resolve(botError(500, 'failure')); await f.coordinator.begin(f.bot);
  const deleted = f.deleted();
  resume = pauseAuthRequests();
  if (invalidated) f.scope.dispose();
  f.coordinator.observe({ ...deleted, deletion: { ...deleted.deletion, workerCleanup: { state: 'completed', code: null }, serverCleanup: { state: 'completed', code: null } } });
  if (invalidated) {
    expect(f.coordinator.snapshot()).toEqual([]); expect(f.cache.invalidateBot).not.toHaveBeenCalled();
  } else {
    expect(f.record().phase).toBe('completed'); expect(f.coordinator.sessionAdmission(f.bot.sessionId)).toBe('revoked');
    expect(f.cache.invalidateBot).toHaveBeenCalledWith(f.bot.id, f.bot.sessionId);
  }
});

it.each(['409', 'completed'] as const)('discards a late %s outcome after actual scope invalidation', async outcome => {
  const f = fixture(), operation = f.coordinator.begin(f.bot);
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  const response = outcome === '409' ? botError(409, 'version_conflict') : botResponse(f.deleted());
  resume = pauseAuthRequests(); f.scope.dispose(); f.response.resolve(response); resume(); await operation;
  expect(f.coordinator.snapshot()).toEqual([]); expect(f.cache.unblockBot).not.toHaveBeenCalled(); expect(f.cache.invalidateBot).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(`daynight.bot.deletions:${BOT_USER}`)).toBeNull(); expect(f.fetcher).toHaveBeenCalledOnce();
});

it.each(['403', '404', 'completed', 'active'] as const)('retains an authenticated %s GET result across identity pause without prematurely restoring input', async outcome => {
  const f = fixture(), read = Promise.withResolvers<Response>();
  f.fetcher.mockImplementation(async (_url, init) => init?.method === 'DELETE' ? botError(409, 'version_conflict') : read.promise);
  const operation = f.coordinator.begin(f.bot);
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
  resume = pauseAuthRequests();
  read.resolve(outcome === 'active' ? botResponse(f.bot) : outcome === 'completed' ? botResponse(f.deleted()) : botError(Number(outcome), 'not_found'));
  if (outcome !== 'active') await vi.waitFor(() => expect(f.record().phase).toBe(outcome === 'completed' ? 'completed' : 'unavailable'));
  else await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.cache.unblockBot).not.toHaveBeenCalled();
  resume(); await operation;
  expect(f.record().phase).toBe(outcome === 'active' ? 'rejected' : outcome === 'completed' ? 'completed' : 'unavailable');
  expect(f.coordinator.sessionAdmission(f.bot.sessionId)).toBe(outcome === 'active' ? 'allowed' : 'revoked');
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});

it('does not classify a lifecycle failure before dispatch as an authenticated rejection', async () => {
  const f = fixture();
  vi.spyOn(f.scope, 'ready').mockRejectedValueOnce(new Error('identity availability changed'));
  await f.coordinator.begin(f.bot);
  expect(f.record().phase).toBe('unknown'); expect(f.cache.unblockBot).not.toHaveBeenCalled();
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
});

it('does not let a rejected retry during identity pause resolve an earlier unknown deletion', async () => {
  const f = fixture(); f.response.resolve(botError(500, 'failure')); await f.coordinator.begin(f.bot);
  const original = f.record().request, retryResponse = Promise.withResolvers<Response>();
  f.fetcher.mockImplementation(async (_url, init) => init?.method === 'DELETE' ? retryResponse.promise : botResponse(f.bot));
  const retry = f.coordinator.retry(f.bot.id);
  await vi.waitFor(() => expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2));
  resume = pauseAuthRequests(); retryResponse.resolve(botError(409, 'version_conflict')); await retry;
  resume(); await f.coordinator.check(f.bot.id);
  expect(f.record().phase).toBe('unknown'); expect(f.record().request).toEqual(original);
  expect(f.cache.unblockBot).not.toHaveBeenCalled(); expect(f.coordinator.sessionAdmission(f.bot.sessionId)).toBe('blocked');
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2);
});
