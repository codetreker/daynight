import { afterEach, expect, it, vi } from 'vitest';
import { BotDeletionCoordinator } from '../src/features/bots/deletion-coordinator';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { BOT_USER, botError, botId, botResponse } from './helpers/bots';
import { recoveryBot, recoveryResource } from './helpers/bot-deletion-recovery';

const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.dispose()); sessionStorage.clear(); });
function fixture() {
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const coordinator = new BotDeletionCoordinator(scope);
  return { scope, coordinator, record: () => coordinator.snapshot()[0]!, check: () => coordinator.check(botId(), new AbortController().signal) };
}
it('discovers evidence missing from a deleted DTO and refuses the invalid original DELETE retry', async () => {
  const f = fixture(); f.coordinator.observe(recoveryBot());
  const fetcher = vi.fn(async (url: string) => botResponse(url.endsWith('/deletion-recovery') ? recoveryResource() : recoveryBot())); vi.stubGlobal('fetch', fetcher);
  await f.check(); expect(f.record().recovery?.value?.recoveryRequired).toBe(true);
  await f.coordinator.retry(botId()); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('reads a server decision on another device and cannot regress its settled state with late Bot data', async () => {
  const f = fixture(); f.coordinator.observe(recoveryBot());
  vi.stubGlobal('fetch', vi.fn(async (url: string) => botResponse(url.endsWith('/deletion-recovery') ? recoveryResource(true, 'completed') : recoveryBot())));
  await f.check(); expect(f.record().phase).toBe('settled'); expect(f.record().result!.deletion.workerCleanup.state).toBe('failed');
  f.coordinator.observe(recoveryBot(recoveryResource(false, 'pending', '7')));
  expect(f.record().phase).toBe('settled');
  const restored = new BotDeletionCoordinator(f.scope);
  expect(restored.snapshot()[0]!.phase).toBe('settled');
});
it('keeps an unsupported sidecar distinct from missing execution records', async () => {
  const f = fixture(); f.coordinator.observe(recoveryBot());
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/deletion-recovery') ? botError(404, 'not_found') : botResponse(recoveryBot())));
  await f.check(); expect(f.record().recovery).toEqual({ value: null, phase: 'unsupported' });
});
it('retains original Bot ownership while showing a different recovery host', async () => {
  const f = fixture(); f.coordinator.observe(recoveryBot());
  vi.stubGlobal('fetch', vi.fn(async (url: string) => botResponse(url.endsWith('/deletion-recovery') ? { ...recoveryResource(), hostingWorkerId: botId(88) } : recoveryBot())));
  await f.check();
  expect(f.record().workerId).toBe(botId(20)); expect(f.record().recovery?.value?.hostingWorkerId).toBe(botId(88));
  const restored = new BotDeletionCoordinator(f.scope);
  expect(restored.snapshot()[0]!.workerId).toBe(botId(20));
});
it('cannot regress a newer ordinary deletion completion from a stale recovery response', async () => {
  const f = fixture(); f.coordinator.observe(recoveryBot());
  const pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn(async (url: string) => url.endsWith('/deletion-recovery') ? pending.promise : botResponse(recoveryBot())); vi.stubGlobal('fetch', fetcher);
  const checking = f.check(); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  f.coordinator.observe({ ...recoveryBot(), version: '9', deletion: { ...recoveryBot().deletion, workerCleanup: { state: 'completed', code: null }, serverCleanup: { state: 'completed', code: null } } });
  pending.resolve(botResponse(recoveryResource())); await checking; expect(f.record().phase).toBe('completed');
});
it.each(['pending', 'failed'] as const)('reads a CLI decision with %s cleanup and later observes its completion without a write', async state => {
  const f = fixture(); let value = recoveryResource(true, state);
  f.coordinator.observe(recoveryBot(value));
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => botResponse(url.endsWith('/deletion-recovery') ? value : recoveryBot(value))); vi.stubGlobal('fetch', fetcher);
  await f.check(); fetcher.mockClear();
  await f.coordinator.retry(botId()); expect(fetcher).not.toHaveBeenCalled();
  value = recoveryResource(true, 'completed', '8');
  await f.check(); expect(f.record().phase).toBe('settled');
  expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
