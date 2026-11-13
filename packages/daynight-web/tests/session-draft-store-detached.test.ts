import { Blob } from 'node:buffer';
import { IDBObjectStore } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, expect, it, vi } from 'vitest';
import { SESSION_PROTOCOL, type ImageTarget, type SessionCommand } from '../../daynight/src/session/protocol';
import { SESSION_DRAFT_DATABASE, SESSION_DRAFT_SCHEMA, SessionDraftStore, draftDetachedRef } from '../src/features/task-agent-session/drafts/draft-store';
import type { DraftBlobInput, DraftOwnerIdentity, DraftRecord, DraftSnapshot } from '../src/features/task-agent-session/drafts/draft-types';

const stores: SessionDraftStore[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });
const store = () => { const result = new SessionDraftStore(); stores.push(result); return result; };
const target: ImageTarget = { serverOrigin: 'https://daynight.test', actorUserId: 'actor', fence: { sessionId: 'session', claimId: 'claim', executionGeneration: '1' }, expectedNativeSessionId: null };
const identity = (native: string | null = null, generation = '1'): DraftOwnerIdentity => ({ target: { ...target, fence: { ...target.fence, executionGeneration: generation }, expectedNativeSessionId: native }, resolver: { kind: 'task', projectId: 'project', taskId: 'task' } });
const write = (draft: DraftRecord, text = draft.text) => ({ draftId: draft.draftId, expectedStoreVersion: draft.storeVersion, text, items: draft.items, rejectedCandidates: draft.rejectedCandidates, overflowRejectedCount: draft.overflowRejectedCount });
const blob: DraftBlobInput = { blobId: 'original', blob: new Blob(['image']) as unknown as globalThis.Blob, byteLength: 5, sha256: 'a'.repeat(64), mediaType: 'image/png', width: 1, height: 1, frameCount: 1, byteRevision: '1' };
async function source(db: SessionDraftStore): Promise<DraftSnapshot> {
  const initial = await db.openOwner(identity());
  return db.saveDraft(initial.owner, { ...write(initial.editable!, '  keep exact text\n'), blobs: [blob], items: [
    { draftImageId: 'first', imageId: 'image', byteRevision: '1', label: 'first.png', blobId: blob.blobId, validation: 'valid', error: null, uploadId: null },
    { draftImageId: 'missing', imageId: 'missing-image', byteRevision: '1', label: 'missing.png', blobId: 'missing-blob', validation: 'bytes_missing', error: 'bytes_missing', uploadId: null },
  ], rejectedCandidates: [{ candidateId: 'rejected', label: 'ninth.png', reason: 'image_limit' }], overflowRejectedCount: 2 });
}
const restore = (db: SessionDraftStore, old: DraftSnapshot, current: DraftSnapshot) => db.restoreDetachedDraft(current.owner, draftDetachedRef(old)!, { draftId: current.editable!.draftId, expectedStoreVersion: current.editable!.storeVersion });
async function freezeText(db: SessionDraftStore, state: DraftSnapshot): Promise<DraftSnapshot> {
  const command: SessionCommand = { protocol: SESSION_PROTOCOL, ...state.owner.identity.target.fence, requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), kind: 'send_message', payload: { content: [{ type: 'text', text: state.editable!.text }], expectedTurnId: null } };
  return db.freeze(state.owner, { draftId: state.editable!.draftId, expectedStoreVersion: state.editable!.storeVersion, command });
}

it('atomically moves all old-target content to fresh local identities and preserves the remote ledger', async () => {
  const db = store(); let old = await source(db);
  await db.createUpload(old.owner, { draftImageId: 'first', byteRevision: '1', blobId: blob.blobId, spec: { uploadId: 'original-upload', imageId: 'image', target, name: 'first.png', mediaType: blob.mediaType, byteLength: String(blob.byteLength), sha256: blob.sha256 } });
  old = await db.read(old.owner); const current = await db.openOwner(identity('native', '2'));
  const moved = await restore(db, old, current), originalDraft = old.editable!, draft = moved.editable!;
  expect(draft.text).toBe(originalDraft.text); expect(draft.rejectedCandidates).toEqual(originalDraft.rejectedCandidates); expect(draft.overflowRejectedCount).toBe(2);
  expect(draft.draftId).not.toBe(originalDraft.draftId); expect(draft.draftId).not.toBe(current.editable!.draftId); expect(draft.revision).toBe('1');
  expect(draft.items.map(item => item.label)).toEqual(['first.png', 'missing.png']);
  for (const [index, item] of draft.items.entries()) { expect(item.draftImageId).not.toBe(originalDraft.items[index]!.draftImageId); expect(item.imageId).not.toBe(originalDraft.items[index]!.imageId); expect(item.blobId).not.toBe(originalDraft.items[index]!.blobId); expect(item.uploadId).toBeNull(); }
  expect(draft.items[0]?.validation).toBe('pending'); expect(draft.items[1]?.validation).toBe('bytes_missing');
  expect(await (await db.readBlob(moved.owner, draft.items[0]!.blobId!))?.blob.text()).toBe('image'); expect(moved.owner.allocatedBytes).toBe(5); expect(moved.uploads).toEqual([]);
  const emptied = await db.read(old.owner); expect(emptied.editable?.text).toBe(''); expect(emptied.editable?.items).toEqual([]); expect(emptied.editable?.draftId).not.toBe(originalDraft.draftId); expect(emptied.owner.allocatedBytes).toBe(0);
  expect(emptied.uploads[0]).toMatchObject({ uploadId: 'original-upload', releaseIntent: true, blobId: blob.blobId, spec: { target, imageId: 'image' } });
  expect(await db.readBlob(old.owner, blob.blobId)).toBeNull(); expect(await db.readDetachedDrafts(identity('native', '2'))).toEqual([]);
  await expect(db.saveDraft(old.owner, write(originalDraft, 'late old tab'))).rejects.toMatchObject({ code: 'conflict' });
  await expect(restore(db, old, current)).rejects.toMatchObject({ code: 'conflict' });
  db.close(); expect((await store().openOwner(identity('native', '2'))).editable).toEqual(draft);
});

it.each(['source', 'target'] as const)('rejects a stale %s content version without changing either draft', async side => {
  const db = store(), other = store(); const old = await source(db), current = await db.openOwner(identity('native'));
  const edited = side === 'source' ? old : current;
  await other.saveDraft(edited.owner, write(edited.editable!, 'intervening edit'));
  await expect(restore(db, old, current)).rejects.toMatchObject({ code: 'conflict' });
  expect((await db.read(edited.owner)).editable?.text).toBe('intervening edit');
  expect((await db.read(side === 'source' ? current.owner : old.owner)).editable?.text).toBe(side === 'source' ? '' : old.editable!.text);
});

it.each(['text', 'rejected', 'overflow'] as const)('refuses a nonempty target containing only %s', async kind => {
  const db = store(), old = await source(db); let current = await db.openOwner(identity('native'));
  current = await db.saveDraft(current.owner, { ...write(current.editable!, kind === 'text' ? '  ' : ''), rejectedCandidates: kind === 'rejected' ? [{ candidateId: 'rejected', label: 'file', reason: 'invalid' }] : [], overflowRejectedCount: kind === 'overflow' ? 1 : 0 });
  await expect(restore(db, old, current)).rejects.toMatchObject({ code: 'conflict' }); expect((await db.read(old.owner)).editable).toEqual(old.editable);
});

it('rolls back both owners and byte allocation if the new draft cannot be stored', async () => {
  const db = store(), old = await source(db), current = await db.openOwner(identity('native'));
  const original = IDBObjectStore.prototype.add;
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
    if (this.name === 'drafts') throw new DOMException('storage failed', 'QuotaExceededError'); return original.apply(this, args);
  });
  await expect(restore(db, old, current)).rejects.toMatchObject({ code: 'quota' }); vi.restoreAllMocks();
  expect(await db.read(old.owner)).toEqual(old); expect(await db.read(current.owner)).toEqual(current); expect(await db.readBlob(old.owner, blob.blobId)).not.toBeNull();
});

it('checks net account bytes after moving instead of temporarily charging for both owners', async () => {
  const db = store(), old = await source(db), current = await db.openOwner(identity('native'));
  const unrelated = await db.openOwner({ ...identity(), target: { ...target, fence: { ...target.fence, sessionId: 'other' } } });
  const inspect = await openDB(SESSION_DRAFT_DATABASE, SESSION_DRAFT_SCHEMA); await inspect.put('owners', { ...unrelated.owner, allocatedBytes: 256 * 1024 * 1024 - blob.byteLength }); inspect.close();
  expect((await restore(db, old, current)).owner.allocatedBytes).toBe(blob.byteLength); expect((await db.read(old.owner)).owner.allocatedBytes).toBe(0);
});

it('keeps old drafts visible while refusing a move through the current execution barrier', async () => {
  const db = store(); const old = await source(db), current = await db.openOwner(identity('native'));
  let third = await db.openOwner(identity('another-native')); third = await db.saveDraft(third.owner, write(third.editable!, 'pending')); await freezeText(db, third);
  expect(await db.readDetachedDrafts(identity('native'))).toHaveLength(1);
  await expect(restore(db, old, current)).rejects.toMatchObject({ code: 'execution_blocked' }); expect((await db.read(old.owner)).editable).toEqual(old.editable);
});

it('rejects a revoked source and a source from another recovery scope', async () => {
  const db = store(), old = await source(db), current = await db.openOwner(identity('native'));
  const unrelated = await db.openOwner({ ...identity('native'), resolver: { kind: 'task', projectId: 'other-project', taskId: 'task' } });
  await expect(restore(db, old, unrelated)).rejects.toMatchObject({ code: 'invalid' });
  await db.blockOwner(old.owner, 'revoked'); await expect(restore(db, old, current)).rejects.toMatchObject({ code: 'blocked' }); expect((await db.read(current.owner)).editable?.text).toBe('');
});

it('discovers unsent, locally refused, whitespace and overflow-only drafts without exposing unresolved drafts', async () => {
  const db = store(); let old = await db.openOwner(identity()); old = await db.saveDraft(old.owner, write(old.editable!, 'unsent'));
  expect(await db.readDetachedDrafts(identity('native', '2'))).toHaveLength(1); expect(await db.readDetachedDrafts(identity('native', '0'))).toEqual([]);
  const frozen = await freezeText(db, old); expect(await db.readDetachedDrafts(identity('native'))).toEqual([]);
  old = await db.refusePrepared(frozen.owner, frozen.submission!.operationId); expect(await db.readDetachedDrafts(identity('native'))).toHaveLength(1);
  old = await db.saveDraft(old.owner, write(old.editable!, '  ')); expect(await db.readDetachedDrafts(identity('native'))).toHaveLength(1);
  old = await db.saveDraft(old.owner, { ...write(old.editable!, ''), overflowRejectedCount: 1 }); expect(await db.readDetachedDrafts(identity('native'))).toHaveLength(1);
});
