import { Blob } from 'node:buffer';
import { openDB } from 'idb';
import { afterEach, expect, it } from 'vitest';
import { SESSION_PROTOCOL, type ImageTarget, type SessionCommand, type SessionOperation } from '../../daynight/src/session/protocol';
import { SESSION_DRAFT_DATABASE, SESSION_DRAFT_SCHEMA, SessionDraftStore, draftRecoveryRef } from '../src/features/task-agent-session/drafts/draft-store';
import type { DraftBlobInput, DraftOwnerIdentity, DraftRecord, DraftSnapshot } from '../src/features/task-agent-session/drafts/draft-types';

const stores: SessionDraftStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const store = () => { const result = new SessionDraftStore(); stores.push(result); return result; };
const target: ImageTarget = { serverOrigin: 'https://daynight.test', actorUserId: 'actor', fence: { sessionId: 'session', claimId: 'claim', executionGeneration: '1' }, expectedNativeSessionId: null };
const identity = (native: string | null = null): DraftOwnerIdentity => ({ target: { ...target, expectedNativeSessionId: native }, resolver: { kind: 'task', projectId: 'project', taskId: 'task' } });
const write = (draft: DraftRecord, text: string) => ({ draftId: draft.draftId, expectedStoreVersion: draft.storeVersion, text, items: draft.items, rejectedCandidates: draft.rejectedCandidates, overflowRejectedCount: draft.overflowRejectedCount });
const blobInput = (blobId: string): DraftBlobInput => ({ blobId, blob: new Blob(['image']) as unknown as globalThis.Blob, byteLength: 5, sha256: 'a'.repeat(64), mediaType: 'image/png', width: 1, height: 1, frameCount: 1, byteRevision: '1' });
const operation = (state: DraftSnapshot, value: SessionOperation['state']): SessionOperation => ({ protocol: SESSION_PROTOCOL, ...state.owner.identity.target.fence, operationId: state.submission!.operationId, kind: state.submission!.kind, state: value, providerResult: null, error: null });
async function addImage(db: SessionDraftStore, state: DraftSnapshot, name: string, text: string): Promise<DraftSnapshot> {
  const blob = blobInput(name);
  return db.saveDraft(state.owner, { ...write(state.editable!, text), blobs: [blob], items: [{ draftImageId: name, imageId: `${name}-image`, byteRevision: '1', label: `${name}.png`, blobId: name, validation: 'valid', error: null, uploadId: null }] });
}
async function prepare(db: SessionDraftStore): Promise<DraftSnapshot> {
  let state = await addImage(db, await db.openOwner(identity()), 'original', 'first');
  const item = state.editable!.items[0]!;
  let upload = await db.createUpload(state.owner, { draftImageId: item.draftImageId, byteRevision: '1', blobId: 'original', spec: { uploadId: 'upload', imageId: item.imageId, target, name: item.label, mediaType: 'image/png', byteLength: '5', sha256: 'a'.repeat(64) } });
  upload = await db.beginUploadRequest(state.owner, upload.uploadId, upload.storeVersion, { kind: 'prepare' });
  await db.observeUpload(state.owner, upload.uploadId, upload.requestSequence, { uploadId: upload.uploadId, imageId: item.imageId, target, state: 'complete', acceptedOffset: '5', spec: { name: item.label, mediaType: 'image/png', byteLength: '5', sha256: 'a'.repeat(64) }, resource: { resourceId: 'resource', status: 'available', name: item.label, mediaType: 'image/png', byteLength: '5', sha256: 'a'.repeat(64), width: 1, height: 1, frameCount: 1, error: null }, expiresAt: '2026-11-12T00:00:00Z', error: null });
  state = await db.read(state.owner); return state;
}
async function freeze(db: SessionDraftStore, state: DraftSnapshot): Promise<DraftSnapshot> {
  const draft = state.editable!, t = state.owner.identity.target;
  const command: SessionCommand = { protocol: SESSION_PROTOCOL, ...t.fence, requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), kind: 'send_message', contentRevision: 2, payload: { content: [{ type: 'text', text: draft.text }, ...draft.items.map(item => ({ type: 'image' as const, imageId: item.imageId, uploadId: item.uploadId!, resourceId: 'resource', sha256: 'a'.repeat(64), byteLength: '5' }))], expectedTurnId: null, target: t, expectedImageCapabilityRevision: '1', draftId: draft.draftId, draftRevision: draft.revision } };
  return db.freeze(state.owner, { draftId: draft.draftId, expectedStoreVersion: draft.storeVersion, command });
}

it('discovers a previous native owner successor after the original operation is accepted', async () => {
  const db = store(); let state = await freeze(db, await prepare(db)); const original = state;
  state = await db.startSuccessor(state.owner, state.submission!.operationId); state = await addImage(db, state, 'successor', 'later text');
  const successor = state.editable!;
  const current = await db.openOwner(identity('native'));
  await db.settleSubmission(state.owner, { operationId: original.submission!.operationId, outcome: 'accepted', operation: operation(original, 'provider_accepted') });
  db.close(); const reopened = store();
  expect(await reopened.readRecoverableSubmissions(identity('native'))).toEqual([]);
  const retained = await reopened.readDetachedDrafts(identity('native'));
  expect(retained).toHaveLength(1); expect(retained[0]?.editable).toEqual(successor); expect(retained[0]?.submission).toBeNull();
  expect((await reopened.read(current.owner)).editable?.text).toBe('');
  expect((await reopened.readBlob(retained[0]!.owner, 'successor'))?.byteLength).toBe(5);
});

it.each(['keep_current', 'restore_failed'] as const)('keeps the selected old-owner draft discoverable after %s clears its operation pointer', async choice => {
  const db = store(); let state = await freeze(db, await prepare(db)); const operationId = state.submission!.operationId;
  state = await db.startSuccessor(state.owner, operationId); state = await addImage(db, state, 'successor', 'later text');
  state = await db.refusePrepared(state.owner, operationId);
  await db.resolveFailure(state.owner, operationId, choice, draftRecoveryRef(state)!.choiceRevision);
  const retained = await db.readDetachedDrafts(identity('native'));
  expect(retained).toHaveLength(1); expect(retained[0]?.editable.text).toBe(choice === 'keep_current' ? 'later text' : 'first');
  expect(retained[0]?.editable.items[0]?.label).toBe(choice === 'keep_current' ? 'successor.png' : 'original.png');
});

it('excludes the current owner, empty old owners, unrelated scope and revoked old drafts from discovery', async () => {
  const db = store(); const old = await db.openOwner(identity());
  expect(await db.readDetachedDrafts(identity('native'))).toEqual([]);
  await db.saveDraft(old.owner, { ...write(old.editable!, ''), rejectedCandidates: [{ candidateId: 'failed', label: 'failed.png', reason: 'image_limit' }] });
  expect(await db.readDetachedDrafts(identity())).toEqual([]);
  expect(await db.readDetachedDrafts({ ...identity('native'), resolver: { kind: 'task', projectId: 'other', taskId: 'task' } })).toEqual([]);
  expect(await db.readDetachedDrafts({ ...identity('native'), target: { ...target, actorUserId: 'other' } })).toEqual([]);
  expect(await db.readDetachedDrafts({ ...identity('native'), target: { ...target, fence: { sessionId: target.fence.sessionId, executionGeneration: target.fence.executionGeneration, claimId: 'other' } } })).toEqual([]);
  expect(await db.readDetachedDrafts(identity('native'))).toHaveLength(1);
  await db.blockOwner(old.owner, 'revoked'); expect(await db.readDetachedDrafts(identity('native'))).toEqual([]);
});

it('releases accepted old-owner originals locally while retaining the independent remote release ledger', async () => {
  const db = store(); const frozen = await freeze(db, await prepare(db));
  await db.openOwner(identity('native'));
  const settled = await db.settleSubmission(frozen.owner, { operationId: frozen.submission!.operationId, outcome: 'accepted', operation: operation(frozen, 'provider_accepted') });
  expect(await db.readBlob(settled.owner, 'original')).toBeNull(); expect(settled.owner.allocatedBytes).toBe(0);
  expect(settled.uploads[0]).toMatchObject({ uploadId: 'upload', releaseIntent: true, spec: { sha256: 'a'.repeat(64) }, receipt: { state: 'complete' } });
  db.close(); const reopened = store(); expect((await reopened.read(settled.owner)).uploads[0]?.releaseIntent).toBe(true);
});

it('collects persisted release-only bytes from an accepted old owner during authorized cold recovery', async () => {
  const db = store(); const frozen = await freeze(db, await prepare(db));
  const original = await db.readBlob(frozen.owner, 'original');
  const settled = await db.settleSubmission(frozen.owner, { operationId: frozen.submission!.operationId, outcome: 'accepted', operation: operation(frozen, 'provider_accepted') });
  const unrelated = await db.openOwner({ ...identity(), target: { ...target, actorUserId: 'other-actor' } });
  const inspect = await openDB(SESSION_DRAFT_DATABASE, SESSION_DRAFT_SCHEMA);
  await inspect.put('blobs', { ...original, references: ['release:upload'] });
  await inspect.put('owners', { ...settled.owner, allocatedBytes: 5 });
  await inspect.put('blobs', { ...original, ownerKey: unrelated.owner.ownerKey, references: ['release:other'] });
  await inspect.put('owners', { ...unrelated.owner, allocatedBytes: 5 }); inspect.close(); db.close();
  const reopened = store(); expect(await reopened.readDetachedDrafts(identity('native'))).toEqual([]); expect(await reopened.readRecoverableSubmissions(identity('native'))).toEqual([]);
  await reopened.collectRecoveryResources(identity('native'));
  const collected = await reopened.read(settled.owner); expect(collected.owner.allocatedBytes).toBe(0); expect(collected.uploads).toEqual(settled.uploads); expect(await reopened.readBlob(settled.owner, 'original')).toBeNull();
  expect((await reopened.read(unrelated.owner)).owner.allocatedBytes).toBe(5); expect(await reopened.readBlob(unrelated.owner, 'original')).not.toBeNull();
});

it('releases removed originals even when a remote upload outcome is unknown', async () => {
  const db = store(); let state = await prepare(db); let upload = state.uploads[0]!;
  upload = await db.beginUploadRequest(state.owner, upload.uploadId, upload.storeVersion, { kind: 'query' }); await db.markUploadUnknown(state.owner, upload.uploadId, upload.requestSequence);
  state = await db.saveDraft(state.owner, { ...write(state.editable!, 'keep text'), items: [] });
  expect(await db.readBlob(state.owner, 'original')).toBeNull(); expect(state.owner.allocatedBytes).toBe(0);
  expect(state.uploads[0]).toMatchObject({ releaseIntent: true, outcomeUnknown: true, pendingAction: { kind: 'query' } });
});

it('keeps frozen and successor references until the final local content reference disappears', async () => {
  const db = store(); let state = await freeze(db, await prepare(db)); const frozen = state;
  await db.claimDispatch(state.owner, state.submission!.operationId); await db.observeSubmission(state.owner, state.submission!.operationId, operation(state, 'unknown'));
  await db.collectRecoveryResources(identity('native'));
  state = await db.startSuccessor(state.owner, state.submission!.operationId);
  expect((await db.readBlob(state.owner, 'original'))?.byteLength).toBe(5);
  state = await db.saveDraft(state.owner, { ...write(state.editable!, 'keep'), items: [{ ...frozen.frozen!.items[0]!, draftImageId: 'second', imageId: 'second-image', uploadId: null }] });
  state = await db.settleSubmission(state.owner, { operationId: frozen.submission!.operationId, outcome: 'accepted', operation: operation(frozen, 'confirmed') });
  expect((await db.readBlob(state.owner, 'original'))?.references).toEqual([`draft:${state.editable!.draftId}:second`]); expect(state.owner.allocatedBytes).toBe(5);
  state = await db.saveDraft(state.owner, { ...write(state.editable!, 'keep'), items: [] }); expect(await db.readBlob(state.owner, 'original')).toBeNull(); expect(state.owner.allocatedBytes).toBe(0);
});
