import { Blob } from 'node:buffer';
import { IDBObjectStore } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, expect, it, vi } from 'vitest';
import { SESSION_PROTOCOL, type ImageTarget, type SessionCommand } from '../../daynight/src/session/protocol';
import { SessionDraftStore, SESSION_DRAFT_DATABASE, SESSION_DRAFT_SCHEMA, draftOwnerKey, draftExecutionKey, draftRecoveryRef } from '../src/features/task-agent-session/drafts/draft-store';
import type { DraftBlobInput, DraftOwnerIdentity, DraftRecord, DraftSnapshot } from '../src/features/task-agent-session/drafts/draft-types';

const stores: SessionDraftStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const store = () => { const result = new SessionDraftStore(); stores.push(result); return result; };
const target: ImageTarget = { serverOrigin: 'https://daynight.test', actorUserId: 'actor', fence: { sessionId: 'session', claimId: 'claim', executionGeneration: '1' }, expectedNativeSessionId: null };
const identity = (native: string | null = null): DraftOwnerIdentity => ({ target: { ...target, expectedNativeSessionId: native }, resolver: { kind: 'task', projectId: 'project', taskId: 'task' } });
const write = (draft: DraftRecord, text: string) => ({ draftId: draft.draftId, expectedStoreVersion: draft.storeVersion, text, items: draft.items, rejectedCandidates: draft.rejectedCandidates, overflowRejectedCount: draft.overflowRejectedCount });
const command = (snapshot: DraftSnapshot): SessionCommand => ({ protocol: SESSION_PROTOCOL, ...snapshot.owner.identity.target.fence, requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), kind: 'send_message', payload: { content: [{ type: 'text', text: snapshot.editable!.text }], expectedTurnId: null } });
const freeze = async (db: SessionDraftStore, snapshot: DraftSnapshot) => db.freeze(snapshot.owner, { draftId: snapshot.editable!.draftId, expectedStoreVersion: snapshot.editable!.storeVersion, command: command(snapshot) });
const acceptedOperation = (operationId: string) => ({ protocol: SESSION_PROTOCOL, ...target.fence, operationId, kind: 'send_message' as const, state: 'provider_accepted' as const, providerResult: null, error: null });
const blobInput = (): DraftBlobInput => ({ blobId: 'blob', blob: new Blob(['image']) as unknown as globalThis.Blob, byteLength: 5, sha256: 'a'.repeat(64), mediaType: 'image/png', width: 1, height: 1, frameCount: 1, byteRevision: '1' });

it('separates exact native owners while retaining the same execution barrier identity', () => {
  expect(draftOwnerKey(identity())).not.toBe(draftOwnerKey(identity('native')));
  expect(draftExecutionKey(identity())).toBe(draftExecutionKey(identity('native')));
  expect(draftOwnerKey({ ...identity(), target: { ...target, serverOrigin: 'https://daynight.test/' } })).toBe(draftOwnerKey(identity()));
});

it('persists ordered draft and original bytes, rejects stale content CAS, and reopens the committed version', async () => {
  const db = store(); const initial = await db.openOwner(identity());
  const blob = blobInput();
  const saved = await db.saveDraft(initial.owner, { ...write(initial.editable!, 'first'), items: [{ draftImageId: 'item', imageId: 'image', byteRevision: '1', label: 'first.png', blobId: blob.blobId, validation: 'valid', error: null, uploadId: null }], blobs: [blob] });
  expect(saved.editable?.revision).toBe('2');
  await expect(db.saveDraft(initial.owner, write(initial.editable!, 'stale'))).rejects.toMatchObject({ code: 'conflict' });
  db.close(); const reopened = store();
  const restored = await reopened.openOwner(identity());
  expect(restored.editable?.text).toBe('first');
  expect(await (await reopened.readBlob(restored.owner, 'blob'))?.blob.text()).toBe('image');
});

it('does not report a saved draft when a later request aborts the transaction', async () => {
  const db = store(); const initial = await db.openOwner(identity()); const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const request = original.apply(this, args); if (this.name === 'drafts') request.addEventListener('success', () => this.transaction.abort(), { once: true }); return request;
  });
  await expect(db.saveDraft(initial.owner, write(initial.editable!, 'lost'))).rejects.toBeDefined();
  vi.restoreAllMocks(); expect((await db.read(initial.owner)).editable?.text).toBe('');
});

it('claims dispatch once across connections and keeps the execution blocked after native initialization', async () => {
  const db = store(); const second = store(); const initial = await db.openOwner(identity());
  const edited = await db.saveDraft(initial.owner, write(initial.editable!, 'send'));
  const frozen = await freeze(db, edited); const op = frozen.submission!.operationId;
  const winners = await Promise.all([db.claimDispatch(frozen.owner, op), second.claimDispatch(frozen.owner, op)]);
  expect(winners.filter(Boolean)).toHaveLength(1);
  const native = await second.openOwner(identity('native'));
  expect(native.executionBlocked).toBe(true);
  const nativeEdited = await second.saveDraft(native.owner, write(native.editable!, 'later'));
  await expect(freeze(second, nativeEdited)).rejects.toMatchObject({ code: 'execution_blocked' });
});

it('settles only the frozen version and preserves successor edits', async () => {
  const db = store(); let state = await db.openOwner(identity()); state = await db.saveDraft(state.owner, write(state.editable!, 'first')); state = await freeze(db, state);
  const operationId = state.submission!.operationId; state = await db.startSuccessor(state.owner, operationId);
  state = await db.saveDraft(state.owner, write(state.editable!, 'second'));
  const successor = state.editable;
  const settled = await db.settleSubmission(state.owner, { operationId, outcome: 'accepted', operation: acceptedOperation(operationId) });
  expect(settled.editable).toEqual(successor); expect(settled.frozen).toBeNull(); expect(settled.executionBlocked).toBe(false);
});

it('retains a missing-byte item and rejects stale writes after an epoch tombstone', async () => {
  const db = store(); const initial = await db.openOwner(identity()); const blob = blobInput();
  const saved = await db.saveDraft(initial.owner, { ...write(initial.editable!, 'keep'), items: [{ draftImageId: 'item', imageId: 'image', byteRevision: '1', label: 'missing.png', blobId: 'blob', validation: 'valid', error: null, uploadId: null }], blobs: [blob] });
  const inspect = await openDB(SESSION_DRAFT_DATABASE, SESSION_DRAFT_SCHEMA); await inspect.delete('blobs', [saved.owner.ownerKey, 'blob']); inspect.close();
  expect((await db.read(saved.owner)).editable?.items[0]).toMatchObject({ label: 'missing.png', validation: 'bytes_missing' });
  await db.blockOwner(saved.owner, 'revoked');
  await expect(db.saveDraft(saved.owner, write(saved.editable!, 'resurrect'))).rejects.toMatchObject({ code: 'blocked' });
  await expect(db.openOwner(identity())).rejects.toMatchObject({ code: 'blocked' });
});

it('imports old text once and preserves the original unresolved identity without a dispatch claim', async () => {
  const db = store(); const other = store();
  expect(await db.readExisting(identity())).toBeNull();
  const legacy = { text: 'old text', revision: 'old-uuid', submission: { operationId: 'original-operation', revision: 'old-uuid' } };
  const [a, b] = await Promise.all([db.importLegacy(identity(), legacy), other.importLegacy(identity(), { ...legacy, text: 'other tab' })]);
  expect([a, b].filter((value) => value.imported)).toHaveLength(1);
  const restored = await db.openOwner(identity());
  expect(restored.frozen).toMatchObject({ text: 'old text', revision: '1' });
  expect(restored.submission).toMatchObject({ operationId: 'original-operation', command: null, legacy: { revision: 'old-uuid' } });
  expect(await db.claimDispatch(restored.owner, 'original-operation')).toBeNull();
});

it('retains the original upload spec and release intent after its draft item is removed', async () => {
  const db = store(); let state = await db.openOwner(identity()); const blob = blobInput();
  state = await db.saveDraft(state.owner, { ...write(state.editable!, 'keep'), items: [{ draftImageId: 'item', imageId: 'image', byteRevision: '1', label: 'first.png', blobId: 'blob', validation: 'valid', error: null, uploadId: null }], blobs: [blob] });
  const upload = await db.createUpload(state.owner, { draftImageId: 'item', byteRevision: '1', blobId: 'blob', spec: { uploadId: 'upload', imageId: 'image', target, name: 'first.png', mediaType: 'image/png', byteLength: '5', sha256: blob.sha256 } });
  const current = (await db.read(state.owner)).editable!;
  const started = await db.beginUploadRequest(state.owner, upload.uploadId, upload.storeVersion, { kind: 'prepare' });
  expect((await db.read(state.owner)).editable).toEqual(current);
  await db.markUploadUnknown(state.owner, upload.uploadId, started.requestSequence);
  state = await db.saveDraft(state.owner, { ...write(current, 'keep'), items: [] });
  expect(state.uploads[0]).toMatchObject({ releaseIntent: true, outcomeUnknown: true, spec: upload.spec });
  expect(await db.readBlob(state.owner, 'blob')).toBeNull(); expect(state.owner.allocatedBytes).toBe(0);
});

it('preserves both drafts on a proven rejection until the user chooses the one to keep', async () => {
  const db = store(); let state = await db.openOwner(identity()); state = await db.saveDraft(state.owner, write(state.editable!, 'failed')); state = await freeze(db, state);
  const operationId = state.submission!.operationId; state = await db.startSuccessor(state.owner, operationId); state = await db.saveDraft(state.owner, write(state.editable!, 'successor'));
  state = await db.refusePrepared(state.owner, operationId);
  expect(state.frozen).toMatchObject({ text: 'failed', state: 'detached' }); expect(state.editable?.text).toBe('successor'); expect(state.executionBlocked).toBe(true);
  state = await db.resolveFailure(state.owner, operationId, 'restore_failed', draftRecoveryRef(state)!.choiceRevision);
  expect(state.editable?.text).toBe('failed'); expect(state.frozen).toBeNull(); expect(state.executionBlocked).toBe(false);
});

it('keeps a durable blocked tombstone when private-content cleanup fails', async () => {
  const db = store(); let state = await db.openOwner(identity()); state = await db.saveDraft(state.owner, write(state.editable!, 'private')); state = await freeze(db, state);
  const original = IDBObjectStore.prototype.delete;
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['delete']>) {
    if (this.name === 'drafts') throw new DOMException('storage failed', 'UnknownError'); return original.apply(this, args);
  });
  await expect(db.blockOwner(state.owner, 'revoked')).rejects.toBeDefined(); vi.restoreAllMocks();
  const other = store(); await expect(other.openOwner(identity())).rejects.toMatchObject({ code: 'blocked' });
  const restored = await other.reauthorizeOwner(identity());
  expect(restored.editable?.text).toBe(''); expect(restored.submission).toMatchObject({ operationId: state.submission!.operationId, command: null, snapshot: null, sensitiveCleared: true });
  expect(restored.owner.accessEpoch).toBeGreaterThan(state.owner.accessEpoch); expect(restored.executionBlocked).toBe(true);
  await expect(db.saveDraft(state.owner, write(state.frozen!, 'stale'))).rejects.toMatchObject({ code: 'blocked' });
});

it('finds the original unresolved operation through the execution index after native initialization', async () => {
  const db = store(); let state = await db.openOwner(identity()); state = await db.saveDraft(state.owner, write(state.editable!, 'first')); state = await freeze(db, state);
  const originals = await db.readExecutionSubmissions(identity('native'));
  expect(originals.map(({ submission }) => submission.operationId)).toEqual([state.submission!.operationId]);
  expect(originals[0]?.owner.identity.target.expectedNativeSessionId).toBeNull();
  expect(await db.readExecutionSubmissions({ ...identity(), target: { ...target, actorUserId: 'other' } })).toEqual([]);
});

it('imports a later legacy edit independently of the original unresolved operation', async () => {
  const db = store(); const imported = await db.importLegacy(identity(), { text: 'later edit', revision: 'later-revision', submission: { operationId: 'original', revision: 'frozen-revision' } });
  expect(imported.snapshot.editable?.text).toBe('later edit'); expect(imported.snapshot.frozen).toBeNull();
  const settled = await db.settleSubmission(imported.snapshot.owner, { operationId: 'original', outcome: 'accepted', operation: acceptedOperation('original') });
  expect(settled.editable?.text).toBe('later edit');
});

it('does not erase committed draft content when the account budget rejects new original bytes', async () => {
  const db = store(); const first = await db.openOwner(identity());
  const otherIdentity = { ...identity(), target: { ...target, fence: { ...target.fence, sessionId: 'other-session' } } };
  const other = await db.openOwner(otherIdentity);
  const inspect = await openDB(SESSION_DRAFT_DATABASE, SESSION_DRAFT_SCHEMA);
  await inspect.put('owners', { ...other.owner, allocatedBytes: 256 * 1024 * 1024 }); inspect.close();
  const blob = blobInput();
  await expect(db.saveDraft(first.owner, { ...write(first.editable!, 'not committed'), items: [{ draftImageId: 'item', imageId: 'image', byteRevision: '1', label: 'first.png', blobId: 'blob', validation: 'valid', error: null, uploadId: null }], blobs: [blob] })).rejects.toMatchObject({ code: 'quota' });
  expect((await db.read(first.owner)).editable?.text).toBe(''); expect(await db.readBlob(first.owner, 'blob')).toBeNull();
});

it('retains rejected candidates across reopening and refuses to freeze an accepted subset', async () => {
  const db = store(); let state = await db.openOwner(identity());
  state = await db.saveDraft(state.owner, { ...write(state.editable!, 'keep'), rejectedCandidates: [{ candidateId: 'rejected', label: 'ninth.png', reason: 'image_limit' }], overflowRejectedCount: 2 });
  db.close(); const reopened = store(); const restored = await reopened.openOwner(identity());
  expect(restored.editable?.rejectedCandidates).toEqual([{ candidateId: 'rejected', label: 'ninth.png', reason: 'image_limit' }]);
  expect(restored.editable?.overflowRejectedCount).toBe(2);
  await expect(freeze(reopened, restored)).rejects.toMatchObject({ code: 'invalid' });
});

it('applies only the latest upload observation and allows later authoritative expiry', async () => {
  const db = store(); let state = await db.openOwner(identity()); const blob = blobInput();
  state = await db.saveDraft(state.owner, { ...write(state.editable!, 'keep'), items: [{ draftImageId: 'item', imageId: 'image', byteRevision: '1', label: 'first.png', blobId: 'blob', validation: 'valid', error: null, uploadId: null }], blobs: [blob] });
  let upload = await db.createUpload(state.owner, { draftImageId: 'item', byteRevision: '1', blobId: 'blob', spec: { uploadId: 'upload', imageId: 'image', target, name: 'first.png', mediaType: 'image/png', byteLength: '5', sha256: blob.sha256 } });
  const first = await db.beginUploadRequest(state.owner, 'upload', upload.storeVersion, { kind: 'prepare' });
  upload = await db.beginUploadRequest(state.owner, 'upload', first.storeVersion, { kind: 'query' });
  const receipt = { uploadId: 'upload', imageId: 'image', target, state: 'complete' as const, acceptedOffset: '5', spec: { name: 'first.png', mediaType: 'image/png' as const, byteLength: '5', sha256: blob.sha256 }, resource: { resourceId: 'resource', status: 'available' as const, name: 'first.png', mediaType: 'image/png', byteLength: '5', sha256: blob.sha256, width: 1, height: 1, frameCount: 1, error: null }, expiresAt: '2026-11-12T00:00:00Z', error: null };
  upload = await db.observeUpload(state.owner, 'upload', upload.requestSequence, receipt);
  const content = (await db.read(state.owner)).editable;
  await db.observeUpload(state.owner, 'upload', first.requestSequence, { ...receipt, state: 'receiving', acceptedOffset: '0', resource: null });
  expect((await db.read(state.owner)).uploads[0]?.receipt?.state).toBe('complete');
  upload = await db.beginUploadRequest(state.owner, 'upload', upload.storeVersion, { kind: 'query' });
  upload = await db.observeUpload(state.owner, 'upload', upload.requestSequence, { ...receipt, state: 'expired', resource: null });
  expect(upload.receipt?.state).toBe('expired'); expect((await db.read(state.owner)).editable).toEqual(content);
});

it('blocks all account handles and later owner creation until explicit authorization', async () => {
  const db = store(); const old = await db.openOwner(identity());
  await db.blockAccount(target.serverOrigin, target.actorUserId);
  await expect(store().openOwner(identity('new-native'))).rejects.toMatchObject({ code: 'blocked' });
  const fresh = await db.reauthorizeOwner(identity('new-native'));
  expect(fresh.editable?.text).toBe('');
  await expect(db.saveDraft(old.owner, write(old.editable!, 'late'))).rejects.toMatchObject({ code: 'blocked' });
});

it('deletes original operation correlations for an explicitly deleted Session and refuses reopening it', async () => {
  const db = store(); let state = await db.openOwner(identity()); state = await db.saveDraft(state.owner, write(state.editable!, 'private')); state = await freeze(db, state);
  await db.blockSession(target.serverOrigin, target.actorUserId, target.fence.sessionId);
  const inspect = await openDB(SESSION_DRAFT_DATABASE, SESSION_DRAFT_SCHEMA);
  expect(await inspect.getAll('submissions')).toEqual([]); inspect.close();
  await expect(store().openOwner(identity('another-native'))).rejects.toMatchObject({ code: 'blocked' });
  await expect(db.reauthorizeOwner(identity())).rejects.toMatchObject({ code: 'blocked' });
});

it('restores only minimal original-operation queries after an account is authorized for the same execution again', async () => {
  const db = store(); let state = await db.openOwner(identity()); state = await db.saveDraft(state.owner, write(state.editable!, 'private')); state = await freeze(db, state);
  await db.blockAccount(target.serverOrigin, target.actorUserId);
  const fresh = await db.reauthorizeOwner(identity('native'));
  const originals = await db.readExecutionSubmissions(identity('native'));
  expect(originals).toHaveLength(1); expect(originals[0]?.submission).toMatchObject({ command: null, snapshot: null, operationId: state.submission!.operationId });
  expect(fresh.executionBlocked).toBe(true);
  const operation = { protocol: SESSION_PROTOCOL, ...target.fence, operationId: state.submission!.operationId, kind: 'send_message' as const, state: 'provider_accepted' as const, providerResult: null, error: null };
  await db.settleSubmission(originals[0]!.owner, { operationId: operation.operationId, operation, outcome: 'accepted' });
  expect((await db.read(fresh.owner)).executionBlocked).toBe(false);
});

it('keeps content revision stable for an identical save and renews exhausted Decimal revisions without wrapping', async () => {
  const db = store(); const initial = await db.openOwner(identity());
  const same = await db.saveDraft(initial.owner, write(initial.editable!, ''));
  expect(same.editable?.revision).toBe('1'); expect(same.editable?.storeVersion).toBe(initial.editable?.storeVersion);
  const inspect = await openDB(SESSION_DRAFT_DATABASE, SESSION_DRAFT_SCHEMA);
  await inspect.put('drafts', { ...initial.editable, revision: '9223372036854775807' }); inspect.close();
  await expect(db.saveDraft(initial.owner, write(initial.editable!, 'next'))).rejects.toMatchObject({ code: 'revision_exhausted' });
  const renewed = await db.renewDraft(initial.owner, initial.editable!.storeVersion);
  expect(renewed.editable?.revision).toBe('1'); expect(renewed.editable?.draftId).not.toBe(initial.editable?.draftId);
});

it('bounds all-account storage independently of the current account and requests strict freezing durability', async () => {
  const db = store(); const initial = await db.openOwner(identity());
  const other = await db.openOwner({ ...identity(), target: { ...target, actorUserId: 'other-actor' } });
  const inspect = await openDB(SESSION_DRAFT_DATABASE, SESSION_DRAFT_SCHEMA); await inspect.put('owners', { ...other.owner, allocatedBytes: 512 * 1024 * 1024 }); inspect.close();
  const blob = blobInput();
  await expect(db.saveDraft(initial.owner, { ...write(initial.editable!, 'not committed'), items: [{ draftImageId: 'item', imageId: 'image', byteRevision: '1', label: 'first.png', blobId: 'blob', validation: 'valid', error: null, uploadId: null }], blobs: [blob] })).rejects.toMatchObject({ code: 'quota' });
  const edited = await db.saveDraft(initial.owner, write(initial.editable!, 'freeze'));
  const observed: string[] = [], original = IDBObjectStore.prototype.add;
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) { if (this.name === 'submissions') observed.push(this.transaction.durability); return original.apply(this, args); });
  const frozen = await freeze(db, edited); expect(observed).toEqual(['strict']);
  const callerCopy = frozen.submission!.command!; (callerCopy.payload as { content: unknown }).content = [];
  expect((await db.read(frozen.owner)).submission?.command?.payload).toMatchObject({ content: [{ type: 'text', text: 'freeze' }] });
});

it('does not let a stale prepared refusal release another connection dispatch claim', async () => {
  const first = store(), second = store(); let state = await first.openOwner(identity());
  state = await first.saveDraft(state.owner, write(state.editable!, 'one')); state = await freeze(first, state);
  const observed = await second.read(state.owner); expect(observed.submission?.state).toBe('prepared');
  const claimed = await first.claimDispatch(state.owner, observed.submission!.operationId); expect(claimed).not.toBeNull();
  const refused = await second.refusePrepared(state.owner, observed.submission!.operationId);
  expect(refused.submission?.state).toBe('dispatch_claimed'); expect(refused.executionBlocked).toBe(true); expect(refused.editable).toBeNull();
});

it('allows claimed refusal only with the uncopyable authority returned to the transaction winner', async () => {
  const first = store(), second = store(); let state = await first.openOwner(identity());
  state = await first.saveDraft(state.owner, write(state.editable!, 'keep')); state = await freeze(first, state);
  const claimed = (await first.claimDispatch(state.owner, state.submission!.operationId))!;
  await expect(second.refuseClaimed(state.owner, claimed.authority)).rejects.toMatchObject({ code: 'invalid' });
  await expect(first.refuseClaimed(state.owner, structuredClone(claimed.authority))).rejects.toMatchObject({ code: 'invalid' });
  const refused = await first.refuseClaimed(state.owner, claimed.authority);
  expect(refused.editable?.text).toBe('keep'); expect(refused.executionBlocked).toBe(false);
  await expect(first.refuseClaimed(state.owner, claimed.authority)).rejects.toMatchObject({ code: 'invalid' });
});

it('invalidates refusal authority on close and never recovers it from stored submissions', async () => {
  const db = store(); let state = await db.openOwner(identity()); state = await db.saveDraft(state.owner, write(state.editable!, 'unknown')); state = await freeze(db, state);
  const claimed = (await db.claimDispatch(state.owner, state.submission!.operationId))!; db.close();
  await expect(db.refuseClaimed(state.owner, claimed.authority)).rejects.toMatchObject({ code: 'invalid' });
  const restored = await db.read(state.owner); expect(restored.submission?.state).toBe('dispatch_claimed'); expect(restored.executionBlocked).toBe(true);
  expect(restored.submission).not.toHaveProperty('authority'); expect(await db.claimDispatch(state.owner, state.submission!.operationId)).toBeNull();
});

it('does not treat a pending operation observation as native acceptance or a local refusal', async () => {
  const db = store(); let state = await db.openOwner(identity()); state = await db.saveDraft(state.owner, write(state.editable!, 'sent')); state = await freeze(db, state);
  const claimed = (await db.claimDispatch(state.owner, state.submission!.operationId))!;
  const operation = { protocol: SESSION_PROTOCOL, ...target.fence, operationId: state.submission!.operationId, kind: 'send_message' as const, state: 'accepted' as const, providerResult: null, error: null };
  await expect(db.settleSubmission(state.owner, { operationId: operation.operationId, operation, outcome: 'accepted' })).rejects.toMatchObject({ code: 'invalid' });
  await db.observeSubmission(state.owner, operation.operationId, operation);
  await expect(db.refuseClaimed(state.owner, claimed.authority)).rejects.toMatchObject({ code: 'conflict' });
  expect((await db.read(state.owner)).executionBlocked).toBe(true);
});

it('keeps winner refusal authority until its cleanup transaction actually commits', async () => {
  const db = store(); let state = await db.openOwner(identity()); state = await db.saveDraft(state.owner, write(state.editable!, 'keep')); state = await freeze(db, state);
  const claim = (await db.claimDispatch(state.owner, state.submission!.operationId))!;
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const request = put.apply(this, args); if (this.name === 'drafts') request.addEventListener('success', () => this.transaction.abort(), { once: true }); return request;
  });
  await expect(db.refuseClaimed(state.owner, claim.authority)).rejects.toMatchObject({ code: 'unavailable' }); vi.restoreAllMocks();
  expect((await db.read(state.owner)).submission?.state).toBe('dispatch_claimed');
  const refused = await db.refuseClaimed(state.owner, claim.authority); expect(refused.editable?.text).toBe('keep'); expect(refused.executionBlocked).toBe(false);
});

it('does not issue dispatch authority if the store closes before claim completion', async () => {
  const db = store(); let state = await db.openOwner(identity()); state = await db.saveDraft(state.owner, write(state.editable!, 'keep')); state = await freeze(db, state);
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const request = put.apply(this, args); if (this.name === 'submissions') request.addEventListener('success', () => db.close(), { once: true }); return request;
  });
  expect(await db.claimDispatch(state.owner, state.submission!.operationId)).toBeNull(); vi.restoreAllMocks();
  expect((await db.read(state.owner)).submission?.state).toBe('dispatch_claimed'); expect((await db.read(state.owner)).executionBlocked).toBe(true);
});


it('checks the displayed failure revisions inside the resolving transaction', async () => {
  const db = store(), other = store(); let state = await db.openOwner(identity());
  state = await db.saveDraft(state.owner, write(state.editable!, 'failed message')); state = await freeze(db, state);
  const operationId = state.submission!.operationId;
  state = await db.startSuccessor(state.owner, operationId); state = await db.saveDraft(state.owner, write(state.editable!, 'displayed successor'));
  state = await db.refusePrepared(state.owner, operationId); const ref = draftRecoveryRef(state)!;
  await other.saveDraft(state.owner, write(state.editable!, 'unseen successor'));
  await expect(db.resolveFailure(state.owner, operationId, 'restore_failed', ref.choiceRevision)).rejects.toMatchObject({ code: 'conflict' });
  const current = await other.read(state.owner);
  expect(current.editable?.text).toBe('unseen successor'); expect(current.frozen?.text).toBe('failed message'); expect(current.executionBlocked).toBe(true);
  await db.resolveFailure(current.owner, operationId, 'keep_current', draftRecoveryRef(current)!.choiceRevision);
  expect((await db.read(state.owner)).editable?.text).toBe('unseen successor'); expect((await db.read(state.owner)).executionBlocked).toBe(false);
});

it('discovers authorized earlier-generation intents without extending their barrier into the current generation', async () => {
  const db = store(); let state = await db.openOwner(identity());
  state = await db.saveDraft(state.owner, write(state.editable!, 'original generation')); state = await freeze(db, state);
  const next = { ...identity('next-native'), target: { ...identity('next-native').target, serverOrigin: 'https://daynight.test/', fence: { ...target.fence, executionGeneration: '2' } } };
  const current = await db.openOwner(next);
  expect(current.executionBlocked).toBe(false); expect(current.editable?.text).toBe('');
  const entries = await db.readRecoverableSubmissions(next);
  expect(entries).toHaveLength(1); expect(entries[0]?.frozen?.text).toBe('original generation');
  expect(entries[0]?.submission.fence).toEqual({ sessionId: 'session', claimId: 'claim', executionGeneration: '1' });
  expect(entries[0]?.owner.ownerKey).toBe(state.owner.ownerKey);
});

it.each([
  ['origin', (value: DraftOwnerIdentity): DraftOwnerIdentity => ({ ...value, target: { ...value.target, serverOrigin: 'https://another.test' } })],
  ['actor', (value: DraftOwnerIdentity): DraftOwnerIdentity => ({ ...value, target: { ...value.target, actorUserId: 'another-actor' } })],
  ['session', (value: DraftOwnerIdentity): DraftOwnerIdentity => ({ ...value, target: { ...value.target, fence: { ...value.target.fence, sessionId: 'another-session' } } })],
  ['claim', (value: DraftOwnerIdentity): DraftOwnerIdentity => ({ ...value, target: { ...value.target, fence: { sessionId: value.target.fence.sessionId, executionGeneration: value.target.fence.executionGeneration, claimId: 'another-claim' } } })],
  ['project', (value: DraftOwnerIdentity): DraftOwnerIdentity => ({ ...value, resolver: { kind: 'task', projectId: 'another-project', taskId: 'task' } })],
  ['task', (value: DraftOwnerIdentity): DraftOwnerIdentity => ({ ...value, resolver: { kind: 'task', projectId: 'project', taskId: 'another-task' } })],
  ['resolver', (value: DraftOwnerIdentity): DraftOwnerIdentity => ({ ...value, resolver: { kind: 'session', sessionId: 'session', testExecutionId: 'execution' } })],
] as const)('does not expose historical intents across a different %s recovery scope', async (_name, change) => {
  const db = store(); let state = await db.openOwner(identity());
  state = await db.saveDraft(state.owner, write(state.editable!, 'private original')); await freeze(db, state);
  const next = { ...identity(), target: { ...target, fence: { ...target.fence, executionGeneration: '2' } } };
  expect(await db.readRecoverableSubmissions(change(next))).toEqual([]);
});

it('does not expose a newer generation to an older generation context', async () => {
  const db = store(); const next = { ...identity(), target: { ...target, fence: { ...target.fence, executionGeneration: '2' } } };
  let state = await db.openOwner(next); state = await db.saveDraft(state.owner, write(state.editable!, 'newer private draft'));
  await db.freeze(state.owner, { draftId: state.editable!.draftId, expectedStoreVersion: state.editable!.storeVersion, command: command(state) });
  expect(await db.readRecoverableSubmissions(identity())).toEqual([]);
});

it.each(['revoked', 'account_changed', 'deleted'] as const)('does not renew %s historical authorization while opening a new generation', async reason => {
  const db = store(); let state = await db.openOwner(identity());
  state = await db.saveDraft(state.owner, write(state.editable!, 'revoked original')); state = await freeze(db, state);
  await db.blockOwner(state.owner, reason);
  const next = { ...identity(), target: { ...target, fence: { ...target.fence, executionGeneration: '2' } } };
  await db.reauthorizeOwner(next);
  expect(await db.readRecoverableSubmissions(next)).toEqual([]);
  expect((await db.readExisting(next))?.editable?.text).toBe('');
});
