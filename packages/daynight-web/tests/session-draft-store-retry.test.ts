import { Blob } from 'node:buffer';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionDraftStore } from '../src/features/task-agent-session/drafts/draft-store';
import type { DraftOwnerIdentity, DraftUploadReplacement } from '../src/features/task-agent-session/drafts/draft-types';

const identity: DraftOwnerIdentity = { target: { serverOrigin: 'https://daynight.test', actorUserId: 'actor', fence: { sessionId: 'session', claimId: 'claim', executionGeneration: '1' }, expectedNativeSessionId: null }, resolver: { kind: 'task', projectId: 'p', taskId: 't' } };
const stores: SessionDraftStore[] = [];
const store = () => { const db = new SessionDraftStore(); stores.push(db); return db; };
afterEach(() => { vi.restoreAllMocks(); stores.splice(0).forEach(db => db.close()); });
async function terminal(state: 'failed' | 'expired' | 'released' = 'failed') {
  const db = store(), initial = await db.openOwner(identity);
  const blob = { blobId: 'blob', blob: new Blob(['image']) as unknown as globalThis.Blob, byteLength: 5, byteRevision: '1', mediaType: 'image/png' as const, sha256: 'a'.repeat(64), width: 1, height: 1, frameCount: 1 };
  const saved = await db.saveDraft(initial.owner, { draftId: initial.editable!.draftId, expectedStoreVersion: initial.editable!.storeVersion, text: 'keep', items: [{ draftImageId: 'item', imageId: 'image', byteRevision: '1', blobId: blob.blobId, validation: 'valid', error: null, label: 'a.png', uploadId: null }], rejectedCandidates: [], overflowRejectedCount: 0, blobs: [blob] });
  const upload = await db.createUpload(saved.owner, { draftImageId: 'item', byteRevision: '1', blobId: blob.blobId, spec: { uploadId: 'original', imageId: 'image', target: identity.target, name: 'a.png', mediaType: 'image/png', byteLength: '5', sha256: blob.sha256 } });
  const request = await db.beginUploadRequest(saved.owner, upload.uploadId, upload.storeVersion, { kind: 'prepare' });
  const observed = await db.observeUpload(saved.owner, upload.uploadId, request.requestSequence, { uploadId: upload.uploadId, imageId: upload.spec.imageId, target: identity.target, state, acceptedOffset: '0', spec: { name: 'a.png', mediaType: 'image/png', byteLength: '5', sha256: blob.sha256 }, resource: null, error: null, expiresAt: '2026-11-12T00:00:00Z' });
  const before = await db.read(saved.owner), draft = before.editable!, item = draft.items[0]!;
  const replacement: DraftUploadReplacement = { draftId: draft.draftId, expectedStoreVersion: draft.storeVersion, draftImageId: item.draftImageId, itemIncarnation: item.incarnation!, uploadId: observed.uploadId, uploadStoreVersion: observed.storeVersion };
  return { db, before, replacement };
}
it.each(['failed', 'expired', 'released'] as const)('atomically replaces a %s wire binding once across connections', async state => {
  const { db, before, replacement } = await terminal(state), peer = store();
  const attempts = await Promise.allSettled([db.replaceTerminalUpload(before.owner, replacement), peer.replaceTerminalUpload(before.owner, replacement)]);
  expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
  const after = await peer.read(before.owner), old = before.editable!, next = after.editable!, item = next.items[0]!;
  expect(next).toMatchObject({ draftId: old.draftId, revision: old.revision, text: old.text, storeVersion: old.storeVersion + 1 });
  expect(item).toMatchObject({ draftImageId: old.items[0]!.draftImageId, incarnation: old.items[0]!.incarnation, blobId: 'blob', byteRevision: '1' });
  expect(item.imageId).not.toBe('image'); expect(item.uploadId).not.toBe('original');
  expect(after.uploads).toHaveLength(2); expect(after.uploads.find(upload => upload.uploadId === 'original')).toMatchObject({ spec: before.uploads[0]!.spec, releaseIntent: true });
  expect(after.uploads.find(upload => upload.uploadId === item.uploadId)?.spec.imageId).toBe(item.imageId);
  expect(await (await peer.readBlob(before.owner, 'blob'))!.blob.text()).toBe('image');
});
it('rolls back both identities and the replacement record when the transaction aborts', async () => {
  const { db, before, replacement } = await terminal(), original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const request = original.apply(this, args); if (this.name === 'drafts') request.addEventListener('success', () => this.transaction.abort(), { once: true }); return request;
  });
  await expect(db.replaceTerminalUpload(before.owner, replacement)).rejects.toMatchObject({ code: 'unavailable' });
  vi.restoreAllMocks(); expect(await db.read(before.owner)).toEqual(before);
});
it('does not reuse a reserved image identity after a caller clears its terminal upload binding', async () => {
  const { db, before } = await terminal(), draft = before.editable!, upload = before.uploads[0]!;
  await db.saveDraft(before.owner, { draftId: draft.draftId, expectedStoreVersion: draft.storeVersion, text: draft.text, items: draft.items.map(item => ({ ...item, uploadId: null })), rejectedCandidates: [], overflowRejectedCount: 0 });
  await expect(db.createUpload(before.owner, { draftImageId: upload.draftImageId, byteRevision: upload.byteRevision, blobId: upload.blobId, spec: { ...upload.spec, uploadId: 'replacement' } })).rejects.toMatchObject({ code: 'conflict' });
});
it.each(['unknown', 'pending', 'incarnation', 'stale', 'revoked', 'admission'] as const)('rejects terminal replacement with %s authority', async reason => {
  const { db, before, replacement } = await terminal();
  let input = replacement;
  if (reason === 'pending' || reason === 'unknown') {
    const request = await db.beginUploadRequest(before.owner, replacement.uploadId, replacement.uploadStoreVersion, { kind: 'query' });
    const changed = reason === 'unknown' ? await db.markUploadUnknown(before.owner, request.uploadId, request.requestSequence) : request;
    input = { ...input, uploadStoreVersion: changed.storeVersion };
  }
  if (reason === 'incarnation') input = { ...input, itemIncarnation: 'removed-item' };
  if (reason === 'stale') input = { ...input, expectedStoreVersion: input.expectedStoreVersion - 1 };
  if (reason === 'revoked') await db.blockOwner(before.owner, 'revoked');
  await expect(db.replaceTerminalUpload(before.owner, input, () => reason !== 'admission')).rejects.toMatchObject({ code: ['revoked', 'admission'].includes(reason) ? 'blocked' : 'conflict' });
  if (reason !== 'revoked') expect((await db.read(before.owner)).uploads).toHaveLength(1);
});
