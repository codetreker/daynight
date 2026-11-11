import { Blob } from 'node:buffer';
import { openDB } from 'idb';
import { afterEach, expect, it } from 'vitest';
import { SessionDraftStore, SESSION_DRAFT_SCHEMA } from '../src/features/task-agent-session/drafts/draft-store';
import type { DraftOwnerIdentity } from '../src/features/task-agent-session/drafts/draft-types';

const identity: DraftOwnerIdentity = { target: { serverOrigin: 'https://daynight.test', actorUserId: 'actor', fence: { sessionId: 'session', claimId: 'claim', executionGeneration: '2' }, expectedNativeSessionId: 'native' }, resolver: { kind: 'task', projectId: 'project', taskId: 'task' } };
const stores: SessionDraftStore[] = [];
const store = (databaseName: string) => { const result = new SessionDraftStore({ databaseName }); stores.push(result); return result; };
afterEach(() => { for (const db of stores.splice(0)) db.close(); });
const names = ['owners', 'drafts', 'blobs', 'uploads', 'submissions'] as const;

it('preserves all version-one records and original Blob bytes while retiring version-one connections', async () => {
  const source = store('schema-fixture'); let state = await source.openOwner(identity);
  const blob = { blobId: 'original-blob', blob: new Blob(['original-image-bytes']) as unknown as globalThis.Blob, byteLength: 20, sha256: 'a'.repeat(64), mediaType: 'image/png' as const, width: 1, height: 1, frameCount: 1, byteRevision: '1' };
  state = await source.saveDraft(state.owner, { draftId: state.editable!.draftId, expectedStoreVersion: state.editable!.storeVersion, text: 'original draft', items: [{ draftImageId: 'item', imageId: 'image', byteRevision: '1', label: 'original.png', blobId: blob.blobId, validation: 'valid', error: null, uploadId: null }], rejectedCandidates: [], overflowRejectedCount: 0, blobs: [blob] });
  await source.createUpload(state.owner, { draftImageId: 'item', byteRevision: '1', blobId: blob.blobId, spec: { uploadId: 'original-upload', imageId: 'image', target: identity.target, name: 'original.png', mediaType: 'image/png', byteLength: '20', sha256: blob.sha256 } });
  const historical = { ...identity, target: { ...identity.target, fence: { ...identity.target.fence, executionGeneration: '1' } } };
  await source.importLegacy(historical, { text: 'original frozen text', revision: 'original-revision', submission: { operationId: 'original-operation', revision: 'original-revision' } });
  const inspect = await openDB('schema-fixture', SESSION_DRAFT_SCHEMA);
  const rows = await Promise.all(names.map(name => inspect.getAll(name))); inspect.close(); source.close();
  const versionChanges: number[] = [];
  const legacy = await openDB('schema-upgrade', 1, {
    upgrade(db) {
      const owners = db.createObjectStore('owners', { keyPath: 'ownerKey' }); owners.createIndex('execution', 'executionKey'); owners.createIndex('account', 'accountKey');
      for (const [name, id] of [['drafts', 'draftId'], ['blobs', 'blobId'], ['uploads', 'uploadId'], ['submissions', 'operationId']]) {
        const object = db.createObjectStore(name!, { keyPath: ['ownerKey', id!] }); object.createIndex('owner', 'ownerKey');
        if (name === 'submissions') object.createIndex('execution', 'executionKey');
      }
    },
    blocking(_oldVersion, newVersion) { versionChanges.push(newVersion!); legacy.close(); },
  });
  for (const [index, name] of names.entries()) for (const row of rows[index]!) await legacy.put(name, row);
  const upgraded = store('schema-upgrade'), restored = await upgraded.readExisting(identity);
  expect(versionChanges).toEqual([2]); expect(SESSION_DRAFT_SCHEMA).toBe(2);
  expect(restored?.editable?.text).toBe('original draft');
  expect(await (await upgraded.readBlob(restored!.owner, blob.blobId))!.blob.text()).toBe('original-image-bytes');
  expect((await upgraded.readRecoverableSubmissions(identity))[0]?.submission.operationId).toBe('original-operation');
  const after = await openDB('schema-upgrade', 2);
  for (const [index, name] of names.entries()) expect(await after.getAll(name), name).toEqual(rows[index]);
  after.close();
  expect(() => legacy.transaction('drafts', 'readwrite')).toThrow();
  await expect(openDB('schema-upgrade', 1)).rejects.toMatchObject({ name: 'VersionError' });
});

it('refuses an unknown newer schema without modifying its records', async () => {
  const future = await openDB('future-schema', SESSION_DRAFT_SCHEMA + 1, { upgrade(db) { db.createObjectStore('future'); } });
  await future.put('future', { schema: 'unknown', privateText: 'keep untouched' }, 'record');
  const current = store('future-schema');
  await expect(current.readExisting(identity)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(current.reauthorizeOwner(identity)).rejects.toMatchObject({ code: 'unavailable' });
  expect(await future.get('future', 'record')).toEqual({ schema: 'unknown', privateText: 'keep untouched' }); future.close();
});
