import { Blob } from 'node:buffer';
import { IDBObjectStore } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, expect, it, vi } from 'vitest';
import { SESSION_PROTOCOL, type SessionCommand } from '../../daynight/src/session/protocol';
import { SESSION_DRAFT_DATABASE, SESSION_DRAFT_SCHEMA, SessionDraftStore } from '../src/features/task-agent-session/drafts/draft-store';
import { DraftUploader } from '../src/features/task-agent-session/drafts/draft-uploads';
import type { DraftBlobInput, DraftImageMetadata, DraftOwnerIdentity, DraftRecord, PendingDraftBlobInput } from '../src/features/task-agent-session/drafts/draft-types';

const identity: DraftOwnerIdentity = { target: { serverOrigin: 'https://daynight.test', actorUserId: 'actor', fence: { sessionId: 'session', claimId: 'claim', executionGeneration: '1' }, expectedNativeSessionId: null }, resolver: { kind: 'task', projectId: 'project', taskId: 'task' } };
const stores: SessionDraftStore[] = [];
const store = () => { const db = new SessionDraftStore(); stores.push(db); return db; };
afterEach(() => { vi.restoreAllMocks(); for (const db of stores.splice(0)) db.close(); });
const write = (draft: DraftRecord) => ({ draftId: draft.draftId, expectedStoreVersion: draft.storeVersion, text: draft.text, items: draft.items, rejectedCandidates: [], overflowRejectedCount: 0 });
const metadata: DraftImageMetadata = { byteLength: 5, sha256: 'a'.repeat(64), mediaType: 'image/png', width: 1, height: 1, frameCount: 1 };
const raw = (text = 'image'): PendingDraftBlobInput => ({ validation: 'pending', blobId: 'original', blob: new Blob([text]) as unknown as globalThis.Blob, byteLength: text.length, byteRevision: '1' });
async function pending() {
  const db = store(), initial = await db.openOwner(identity), original = raw();
  const state = await db.saveDraft(initial.owner, { ...write(initial.editable!), items: [{ draftImageId: 'item', imageId: 'image', byteRevision: '1', label: 'clipboard.png', blobId: original.blobId, validation: 'pending', error: null, uploadId: null }], blobs: [original] });
  const saved = (await db.readBlob(state.owner, original.blobId))!;
  const ref = { draftId: state.editable!.draftId, draftImageId: 'item', itemIncarnation: state.editable!.items[0]!.incarnation!, blobId: original.blobId, byteRevision: '1', originalId: saved.originalId! };
  return { db, state, original, saved, ref };
}

it('commits pending bytes with the item and promotes the saved original without replacing its bytes', async () => {
  const { db, state, original, saved, ref } = await pending();
  expect(saved).toMatchObject({ validation: 'pending', byteLength: 5 }); expect(saved).not.toHaveProperty('sha256');
  expect(state.owner.allocatedBytes).toBe(5); expect(state.editable!.items[0]!.blobId).toBe(original.blobId);
  const replaced = await db.saveDraft(state.owner, { ...write(state.editable!), blobs: [raw('other')] });
  expect(await (await db.readBlob(replaced.owner, original.blobId))!.blob.text()).toBe('image');
  const verified = await db.validateBlob(state.owner, ref, { ...metadata, blob: raw('other').blob } as DraftImageMetadata);
  expect(await verified.blob.text()).toBe('image'); expect(verified.sha256).toBe(metadata.sha256);
  const peer = store(); const repeated = await peer.validateBlob(state.owner, ref, metadata);
  expect(await repeated.blob.text()).toBe('image');
  await expect(peer.validateBlob(state.owner, ref, { ...metadata, sha256: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'bytes_invalid' });
});

it('rejects stale validation after the same blob and item identifiers are deleted and recreated', async () => {
  const { db, state, ref, original } = await pending();
  const empty = await db.saveDraft(state.owner, { ...write(state.editable!), items: [] });
  expect(await db.readBlob(state.owner, original.blobId)).toBeNull();
  const recreated = await db.saveDraft(state.owner, { ...write(empty.editable!), items: state.editable!.items, blobs: [raw('other')] });
  const current = (await db.readBlob(state.owner, original.blobId))!;
  expect(current.originalId).not.toBe(ref.originalId);
  await expect(db.validateBlob(state.owner, ref, metadata)).rejects.toMatchObject({ code: 'conflict' });
  expect(recreated.editable!.items[0]!.validation).toBe('pending'); expect(await current.blob.text()).toBe('other');
});

it('rejects stale item validation even while another item retains the same immutable original', async () => {
  const { db, state, ref } = await pending();
  const first = state.editable!.items[0]!, second = { ...first, draftImageId: 'second', imageId: 'second-image' };
  const shared = await db.saveDraft(state.owner, { ...write(state.editable!), items: [first, second] });
  const removed = await db.saveDraft(state.owner, { ...write(shared.editable!), items: [shared.editable!.items[1]!] });
  const recreated = await db.saveDraft(state.owner, { ...write(removed.editable!), items: [first, ...removed.editable!.items] });
  expect((await db.readBlob(state.owner, ref.blobId))!.originalId).toBe(ref.originalId);
  expect(recreated.editable!.items[0]!.incarnation).not.toBe(ref.itemIncarnation);
  await expect(db.validateBlob(state.owner, ref, metadata)).rejects.toMatchObject({ code: 'conflict' });
});

it('rejects metadata-only replacement and all upload or freeze attempts on pending bytes', async () => {
  const { db, state, original } = await pending();
  await expect(db.saveDraft(state.owner, { ...write(state.editable!), blobs: [{ ...metadata, blobId: original.blobId, blob: original.blob, byteRevision: '1' }] })).rejects.toMatchObject({ code: 'conflict' });
  const forged = await db.saveDraft(state.owner, { ...write(state.editable!), items: state.editable!.items.map(item => ({ ...item, validation: 'valid' })) });
  expect(forged.editable!.items[0]!.validation).toBe('pending');
  await expect(db.createUpload(state.owner, { draftImageId: 'item', byteRevision: '1', blobId: original.blobId, spec: { uploadId: 'upload', imageId: 'image', target: identity.target, name: 'clipboard.png', mediaType: 'image/png', byteLength: '5', sha256: metadata.sha256 } })).rejects.toMatchObject({ code: 'conflict' });
  const command: SessionCommand = { protocol: SESSION_PROTOCOL, ...identity.target.fence, operationId: 'operation', requestId: 'request', kind: 'send_message', contentRevision: 2, payload: { target: identity.target, draftId: forged.editable!.draftId, draftRevision: forged.editable!.revision, expectedTurnId: null, expectedImageCapabilityRevision: '1', content: [{ type: 'image', imageId: 'image', uploadId: 'upload', resourceId: 'resource', byteLength: '5', sha256: metadata.sha256 }] } };
  await expect(db.freeze(state.owner, { ...write(forged.editable!), command })).rejects.toMatchObject({ code: 'bytes_invalid' });
  const read = vi.spyOn(db, 'read');
  const uploader = new DraftUploader({ store: db, locks: null, resources: {} as never, signal: new AbortController().signal, isCurrent: () => true, canPrepare: () => true, changed: async () => {} });
  await expect(uploader.run(state.owner, 'upload', original as unknown as DraftBlobInput)).rejects.toThrow('image_bytes_invalid');
  expect(read).not.toHaveBeenCalled();
});

it('rolls back both pending item and original on quota failure and collects the final raw reference', async () => {
  const { db, state, saved } = await pending(); const put = IDBObjectStore.prototype.put;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'drafts') throw new DOMException('storage full', 'QuotaExceededError'); return put.apply(this, args);
  });
  await expect(db.saveDraft(state.owner, { ...write(state.editable!), items: [...state.editable!.items, { ...state.editable!.items[0]!, draftImageId: 'second', imageId: 'second-image', blobId: 'second' }], blobs: [{ ...raw(), blobId: 'second' }] })).rejects.toMatchObject({ code: 'quota' });
  fault.mockRestore();
  expect((await db.read(state.owner)).editable).toEqual(state.editable); expect(await db.readBlob(state.owner, 'second')).toBeNull();
  expect((await db.readBlob(state.owner, saved.blobId))!.originalId).toBe(saved.originalId);
  const empty = await db.saveDraft(state.owner, { ...write(state.editable!), items: [] });
  expect(await db.readBlob(state.owner, saved.blobId)).toBeNull(); expect(empty.owner.allocatedBytes).toBe(0);
});

it.each(['account_changed', 'revoked', 'deleted'] as const)('clears unvalidated originals and denies late promotion after %s', async reason => {
  const { db, state, ref } = await pending(); await db.blockOwner(state.owner, reason);
  await expect(db.validateBlob(state.owner, ref, metadata)).rejects.toMatchObject({ code: 'blocked' });
  const inspect = await openDB(SESSION_DRAFT_DATABASE, SESSION_DRAFT_SCHEMA);
  expect(await inspect.getAll('blobs')).toEqual([]); expect(await inspect.getAll('drafts')).toEqual([]); inspect.close();
});
