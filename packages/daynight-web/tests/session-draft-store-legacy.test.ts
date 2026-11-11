import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { SESSION_PROTOCOL, type SessionOperation } from '../../daynight/src/session/protocol';
import { SessionDraftStore } from '../src/features/task-agent-session/drafts/draft-store';
import type { DraftOwnerIdentity } from '../src/features/task-agent-session/drafts/draft-types';

const identity: DraftOwnerIdentity = { target: { serverOrigin: 'https://daynight.test', actorUserId: 'actor', fence: { sessionId: 'session', claimId: 'claim', executionGeneration: '1' }, expectedNativeSessionId: null }, resolver: { kind: 'task', projectId: 'p', taskId: 't' } };
const legacy = { text: 'submitted text', revision: 'original-revision', submission: { operationId: 'original-operation', revision: 'original-revision' } };
const stores: SessionDraftStore[] = [];
const store = () => { const db = new SessionDraftStore(); stores.push(db); return db; };
afterEach(() => { vi.restoreAllMocks(); stores.splice(0).forEach(db => db.close()); });
const operation = (state: SessionOperation['state']): SessionOperation => ({ protocol: SESSION_PROTOCOL, ...identity.target.fence, operationId: legacy.submission.operationId, kind: 'send_message', state, providerResult: null, error: null });
async function savedDraft() {
  const db = store(), initial = await db.openOwner(identity);
  const saved = await db.saveDraft(initial.owner, { draftId: initial.editable!.draftId, expectedStoreVersion: initial.editable!.storeVersion, text: 'saved text', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
  return { db, saved };
}
it('retains the original legacy operation separately without overwriting an existing draft or operation', async () => {
  const { db, saved } = await savedDraft();
  const frozen = await db.freeze(saved.owner, { draftId: saved.editable!.draftId, expectedStoreVersion: saved.editable!.storeVersion, command: { protocol: SESSION_PROTOCOL, ...identity.target.fence, operationId: 'saved-operation', requestId: 'request', kind: 'send_message', payload: { content: [{ type: 'text', text: 'saved text' }], expectedTurnId: null } } });
  const migrated = await db.importLegacy(identity, legacy);
  expect(migrated.imported).toBe(false); expect(migrated.snapshot.frozen).toEqual(frozen.frozen); expect(migrated.snapshot.submission).toEqual(frozen.submission);
  const originals = await db.readRecoverableSubmissions(identity); expect(originals).toHaveLength(2);
  const original = originals.find(entry => entry.submission.operationId === legacy.submission.operationId)!;
  expect(original).toMatchObject({ editable: null, frozen: null, owner: { identity, recoveryOnly: true, blocked: 'recovery_only' }, submission: { command: null, snapshot: null, sensitiveCleared: true, legacy: { revision: legacy.submission.revision } } });
  await expect(db.read(original.owner)).rejects.toMatchObject({ code: 'blocked' });
  await expect(db.startSuccessor(original.owner, legacy.submission.operationId)).rejects.toMatchObject({ code: 'blocked' });
  expect((await db.importLegacy(identity, legacy)).legacySubmission).toEqual(original.submission);
  expect(await db.readRecoverableSubmissions(identity)).toHaveLength(2);
});
it.each(['accepted', 'rejected'] as const)('does not resurrect a %s legacy operation after reopening and account cleanup', async outcome => {
  const { db, saved } = await savedDraft(); await db.importLegacy(identity, legacy);
  const original = (await db.readRecoverableSubmissions(identity))[0]!;
  await db.settleSubmission(original.owner, { operationId: legacy.submission.operationId, outcome, operation: operation(outcome === 'accepted' ? 'provider_accepted' : 'failed') });
  db.close(); const reopened = store();
  expect((await reopened.importLegacy(identity, legacy)).legacySubmission?.state).toBe(outcome);
  expect((await reopened.read(saved.owner)).editable).toEqual(saved.editable);
  await reopened.blockAccount(identity.target.serverOrigin, identity.target.actorUserId);
  await reopened.reconcileAuthorizedOwner(identity);
  expect((await reopened.importLegacy(identity, legacy)).legacySubmission).toMatchObject({ state: outcome, snapshot: null, command: null, lastOperation: null });
  expect(await reopened.readRecoverableSubmissions(identity)).toEqual([]);
});
it('restores only original-operation querying after revoking a collided legacy operation', async () => {
  const { db } = await savedDraft(); await db.importLegacy(identity, legacy);
  const before = (await db.readRecoverableSubmissions(identity))[0]!;
  await db.blockAccount(identity.target.serverOrigin, identity.target.actorUserId); await db.reconcileAuthorizedOwner(identity);
  const original = (await db.readRecoverableSubmissions(identity))[0]!;
  expect(original.owner.accessEpoch).toBeGreaterThan(before.owner.accessEpoch);
  expect(original).toMatchObject({ editable: null, frozen: null, owner: { recoveryOnly: true, blocked: 'recovery_only' } });
  expect((await db.importLegacy(identity, legacy)).legacySubmission?.operationId).toBe(legacy.submission.operationId);
  await expect(db.observeSubmission(before.owner, legacy.submission.operationId, operation('unknown'))).rejects.toMatchObject({ code: 'blocked' });
  await db.observeSubmission(original.owner, legacy.submission.operationId, operation('unknown'));
  await expect(db.freeze(original.owner, {} as never)).rejects.toMatchObject({ code: 'blocked' });
});
it.each(['resolver', 'native', 'kind', 'revision'] as const)('rejects a same-ID legacy collision with different %s correlation', async change => {
  const { db } = await savedDraft();
  const originalIdentity = change === 'resolver' ? { ...identity, resolver: { ...identity.resolver, taskId: 'other' } as DraftOwnerIdentity['resolver'] } : change === 'native' ? { ...identity, target: { ...identity.target, expectedNativeSessionId: 'other-native' } } : identity;
  const original = change === 'kind' ? { ...legacy, submission: { ...legacy.submission, kind: 'execute_command' as const } } : change === 'revision' ? { ...legacy, submission: { ...legacy.submission, revision: 'other-revision' } } : legacy;
  await db.importLegacy(originalIdentity, original);
  await expect(db.importLegacy(identity, legacy)).rejects.toMatchObject({ code: 'conflict' });
});
it('aborts collision migration when admission is lost before transaction completion', async () => {
  const { db, saved } = await savedDraft(); let admitted = true;
  const original = IDBObjectStore.prototype.add;
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
    const request = original.apply(this, args); if (this.name === 'submissions') request.addEventListener('success', () => { admitted = false; }, { once: true }); return request;
  });
  await expect(db.importLegacy(identity, legacy, () => admitted)).rejects.toMatchObject({ code: 'blocked' });
  vi.restoreAllMocks(); expect(await db.read(saved.owner)).toEqual(saved); expect(await db.readRecoverableSubmissions(identity)).toEqual([]);
});
