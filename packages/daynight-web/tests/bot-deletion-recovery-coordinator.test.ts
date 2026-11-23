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
  await f.check(); expect(f.record().recovery).toEqual({ value: null, request: null, phase: 'unsupported' });
});
it('retains an unknown acceptance across reload and only reads until explicit replay', async () => {
  const f = fixture(); f.coordinator.observe(recoveryBot()); let posts = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts++; throw new Error('lost'); }
    return botResponse(url.endsWith('/deletion-recovery') ? recoveryResource() : recoveryBot());
  }); vi.stubGlobal('fetch', fetcher);
  await f.check(); await f.coordinator.resolveRecovery(botId(), 'Original records lost', '5');
  expect(f.record().recovery?.phase).toBe('unknown'); const original = f.record().recovery?.request;
  const restored = new BotDeletionCoordinator(f.scope);
  expect(restored.snapshot()[0]?.recovery?.request).toEqual(original);
  await restored.check(botId(), new AbortController().signal); expect(posts).toBe(1);
  await restored.retryRecovery(botId()); expect(posts).toBe(2); expect(restored.snapshot()[0]?.recovery?.request).toEqual(original);
});
it.each(['pending', 'failed'] as const)('allows explicit cleanup retry of a confirmed %s decision using its current exact version', async state => {
  const f = fixture(); f.coordinator.observe(recoveryBot()); let body: unknown;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { body = JSON.parse(init.body as string); return botResponse(recoveryResource(true, 'completed', '8')); }
    return botResponse(url.endsWith('/deletion-recovery') ? recoveryResource(true, state, '7') : recoveryBot());
  }));
  await f.check(); await f.coordinator.retryRecovery(botId());
  expect(body).toEqual({ action: 'retry_cleanup', ifVersion: '7', deletionId: botId(90), operationId: botId(91) });
  expect(f.record().phase).toBe('settled');
});
it('preserves the version reviewed in the dialog instead of substituting a fresher version', async () => {
  const f = fixture(); f.coordinator.observe(recoveryBot()); let body: Record<string, unknown> | undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { body = JSON.parse(init.body as string); return botError(409, 'version_conflict'); }
    return botResponse(url.endsWith('/deletion-recovery') ? recoveryResource(false, 'pending', '7') : recoveryBot());
  }));
  await f.check(); await f.coordinator.resolveRecovery(botId(), 'Original records lost', '5'); expect(body?.ifVersion).toBe('5');
});
it('retains an earlier unknown acceptance when its explicit replay is rejected', async () => {
  const f = fixture(); f.coordinator.observeRecovery(recoveryResource()); let posts = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { if (++posts === 1) throw new Error('lost'); return botError(409, 'version_conflict'); }
    return botResponse(recoveryResource());
  }));
  await f.coordinator.resolveRecovery(botId(), 'Original records lost', '5');
  await f.coordinator.retryRecovery(botId()); expect(f.record().recovery?.phase).toBe('unknown');
});
it('retains original Bot ownership while showing a different recovery host', () => {
  const f = fixture(); f.coordinator.observeRecovery({ ...recoveryResource(), hostingWorkerId: botId(88) });
  expect(f.record().workerId).toBe(botId(20)); expect(f.record().recovery?.value?.hostingWorkerId).toBe(botId(88));
  const restored = new BotDeletionCoordinator(f.scope);
  expect(restored.snapshot()[0]!.workerId).toBe(botId(20));
});
it('cannot regress a newer ordinary deletion completion from a stale recovery listing', () => {
  const f = fixture(); f.coordinator.observe({ ...recoveryBot(), version: '9', deletion: { ...recoveryBot().deletion, workerCleanup: { state: 'completed', code: null }, serverCleanup: { state: 'completed', code: null } } });
  f.coordinator.observeRecovery(recoveryResource()); expect(f.record().phase).toBe('completed');
});
it('can explicitly replay an unknown cleanup retry with its original CAS version when the first request never arrived', async () => {
  const f = fixture(); f.coordinator.observeRecovery(recoveryResource(true, 'failed')); const requests: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { requests.push(JSON.parse(init.body as string)); if (requests.length === 1) throw new Error('lost before arrival'); return botResponse(recoveryResource(true, 'completed', '8')); }
    return botResponse(recoveryResource(true, 'failed'));
  }));
  await f.coordinator.retryRecovery(botId()); expect(f.record().recovery?.phase).toBe('unknown');
  await f.coordinator.retryRecovery(botId()); expect(requests[1]).toEqual(requests[0]); expect(f.record().phase).toBe('settled');
});
it('adopts another device’s immutable decision after an unknown acceptance and can retry its pending cleanup', async () => {
  const f = fixture(); f.coordinator.observeRecovery(recoveryResource()); let accepted = false, retry: unknown;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const input = JSON.parse(init.body as string);
      if (input.action === 'accept_unverified') { accepted = true; throw new Error('lost'); }
      retry = input; return botResponse(recoveryResource(true, 'completed', '8'));
    }
    return botResponse(accepted ? recoveryResource(true, 'pending') : recoveryResource());
  }));
  await f.coordinator.resolveRecovery(botId(), 'Different device request', '5');
  expect(f.record().recovery?.phase).toBe('ready'); expect(f.record().recovery?.value?.decision?.operationId).toBe(botId(91));
  await f.coordinator.retryRecovery(botId()); expect(retry).toMatchObject({ action: 'retry_cleanup', operationId: botId(91) });
});
