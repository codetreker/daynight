import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionDraftStore } from '../src/features/task-agent-session/drafts/draft-store';
import { clearImageDraftScope, imageDraftCleanupFailures, retryImageDraftScopeCleanup, subscribeImageDraftCleanup } from '../src/features/task-agent-session/drafts/draft-store-cleanup';
import type { DraftOwnerIdentity } from '../src/features/task-agent-session/drafts/draft-types';
const identity: DraftOwnerIdentity = { target: { serverOrigin: window.location.origin, actorUserId: 'cleanup-user', fence: { sessionId: 'cleanup-session', testExecutionId: 'cleanup-execution', executionGeneration: '1' }, expectedNativeSessionId: null }, resolver: { kind: 'session', sessionId: 'cleanup-session', testExecutionId: 'cleanup-execution' } };
const stores: SessionDraftStore[] = [];
const store = () => { const result = new SessionDraftStore(); stores.push(result); return result; };
afterEach(async () => { vi.restoreAllMocks(); await retryImageDraftScopeCleanup(); for (const db of stores.splice(0)) db.close(); });

it('publishes an asynchronous cleanup failure and retries only the originally blocked content', async () => {
  const db = store(); const old = await db.openOwner(identity); const listener = vi.fn(); const detach = subscribeImageDraftCleanup(listener);
  const remove = IDBObjectStore.prototype.delete;
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['delete']>) { if (this.name === 'drafts') throw new DOMException('failed cleanup', 'UnknownError'); return remove.apply(this, args); });
  const error = await clearImageDraftScope({ origin: window.location.origin, actorUserId: identity.target.actorUserId, sessionId: null, reason: 'account_changed' });
  expect(error).toBeInstanceOf(Error); expect(imageDraftCleanupFailures()).toHaveLength(1); expect(listener).toHaveBeenCalled();
  vi.restoreAllMocks(); const fresh = await db.reauthorizeOwner(identity);
  await db.saveDraft(fresh.owner, { draftId: fresh.editable!.draftId, expectedStoreVersion: fresh.editable!.storeVersion, text: 'new authorized text', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
  await retryImageDraftScopeCleanup(); expect(imageDraftCleanupFailures()).toHaveLength(0);
  expect((await db.read(fresh.owner)).editable?.text).toBe('new authorized text');
  await expect(db.read(old.owner)).rejects.toMatchObject({ code: 'blocked' }); detach();
});

it('keeps deletion permanent when a later cache callback merely revokes the same Session', async () => {
  const db = store(); await db.openOwner(identity);
  await clearImageDraftScope({ origin: window.location.origin, actorUserId: identity.target.actorUserId, sessionId: identity.target.fence.sessionId, reason: 'deleted' });
  await clearImageDraftScope({ origin: window.location.origin, actorUserId: identity.target.actorUserId, sessionId: identity.target.fence.sessionId, reason: 'revoked' });
  await expect(db.reauthorizeOwner(identity)).rejects.toMatchObject({ code: 'blocked' });
});
