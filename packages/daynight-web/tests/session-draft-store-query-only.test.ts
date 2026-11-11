import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { SESSION_PROTOCOL, type ImageTarget, type SessionCommand, type SessionOperation } from '../../daynight/src/session/protocol';
import { SessionDraftStore } from '../src/features/task-agent-session/drafts/draft-store';
import type { DraftOwnerIdentity, NewDraftUpload } from '../src/features/task-agent-session/drafts/draft-types';

const target: ImageTarget = { serverOrigin: 'https://daynight.test', actorUserId: 'original-actor', fence: { sessionId: 'original-session', claimId: 'original-claim', executionGeneration: '2' }, expectedNativeSessionId: 'original-native' };
const identity: DraftOwnerIdentity = { target, resolver: { kind: 'task', projectId: 'project', taskId: 'task' } };
const currentIdentity: DraftOwnerIdentity = { ...identity, target: { ...target, fence: { ...target.fence, executionGeneration: '3' }, expectedNativeSessionId: 'current-native' } };
const stores: SessionDraftStore[] = [];
const store = () => { const result = new SessionDraftStore(); stores.push(result); return result; };
afterEach(() => { for (const db of stores.splice(0)) db.close(); });

async function retained(reason: 'account_changed' | 'revoked' | 'deleted' = 'account_changed', claimed = true) {
  const db = store(); let original = await db.openOwner(identity);
  original = await db.saveDraft(original.owner, { draftId: original.editable!.draftId, expectedStoreVersion: original.editable!.storeVersion, text: 'private original text', items: [], rejectedCandidates: [], overflowRejectedCount: 0 });
  const command: SessionCommand = { protocol: SESSION_PROTOCOL, ...target.fence, requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), kind: 'send_message', payload: { content: [{ type: 'text', text: original.editable!.text }], expectedTurnId: null } };
  original = await db.freeze(original.owner, { draftId: original.editable!.draftId, expectedStoreVersion: original.editable!.storeVersion, command });
  if (claimed) expect(await db.claimDispatch(original.owner, command.operationId)).not.toBeNull();
  if (reason === 'account_changed') await db.blockAccount(target.serverOrigin, target.actorUserId);
  else if (reason === 'revoked') await db.revokeSession(target.serverOrigin, target.actorUserId, target.fence.sessionId);
  else await db.blockSession(target.serverOrigin, target.actorUserId, target.fence.sessionId);
  const operation = (state: SessionOperation['state']): SessionOperation => ({ protocol: SESSION_PROTOCOL, ...target.fence, operationId: command.operationId, kind: command.kind, state, providerResult: null, error: null });
  return { db, original, command, operation };
}

it.each(['account_changed', 'revoked'] as const)('restores only original receipt access after %s at an earlier generation', async reason => {
  const { db, original, command, operation } = await retained(reason);
  const current = await db.reauthorizeOwner(currentIdentity);
  expect(current.executionBlocked).toBe(false); expect(current.editable?.text).toBe('');
  const recoveries = await db.readRecoverableSubmissions(currentIdentity); expect(recoveries).toHaveLength(1);
  const historical = recoveries[0]!;
  expect(historical.owner.blocked).toBeTruthy();
  expect(historical.submission).toMatchObject({ operationId: command.operationId, fence: target.fence, sensitiveCleared: true, command: null, snapshot: null, blobIds: [], uploadIds: [] });
  expect(historical.frozen).toBeNull(); expect(historical.editable).toBeNull(); expect(historical.uploads).toEqual([]);
  await expect(db.read(original.owner)).rejects.toMatchObject({ code: 'blocked' });
  await db.observeSubmission(historical.owner, command.operationId, operation('unknown'));
  const settled = await db.settleSubmission(historical.owner, { operationId: command.operationId, outcome: 'accepted', operation: operation('provider_accepted') });
  expect(settled.editable).toBeNull(); expect(settled.frozen).toBeNull(); expect(settled.submission).toBeNull();
  expect(await db.readRecoverableSubmissions(currentIdentity)).toEqual([]);
  expect((await db.readExisting(currentIdentity))!.editable).toEqual(current.editable);
  await expect(db.openOwner(identity)).rejects.toMatchObject({ code: 'blocked' });
  await expect(db.reauthorizeOwner(identity)).rejects.toMatchObject({ code: 'blocked' });
});

it('denies private content and all new work through a historical receipt handle', async () => {
  const { db, original, command, operation } = await retained(); await db.reauthorizeOwner(currentIdentity);
  const recoveries = await db.readRecoverableSubmissions(currentIdentity); expect(recoveries).toHaveLength(1);
  const handle = recoveries[0]!.owner;
  const write = { draftId: original.frozen!.draftId, expectedStoreVersion: original.frozen!.storeVersion, text: 'forbidden', items: [], rejectedCandidates: [], overflowRejectedCount: 0 };
  const upload: NewDraftUpload = { draftImageId: 'image', byteRevision: '1', blobId: 'blob', spec: { uploadId: 'upload', imageId: 'image', target, name: 'forbidden.png', mediaType: 'image/png', byteLength: '1', sha256: '0'.repeat(64) } };
  const denied: readonly [string, () => Promise<unknown>][] = [
    ['read', () => db.read(handle)], ['readExisting', () => db.readExisting(identity)], ['openOwner', () => db.openOwner(identity)], ['reauthorizeOwner', () => db.reauthorizeOwner(identity)],
    ['readBlob', () => db.readBlob(handle, 'blob')], ['saveDraft', () => db.saveDraft(handle, write)], ['renewDraft', () => db.renewDraft(handle, 1)],
    ['importLegacy', () => db.importLegacy(identity, { text: 'forbidden', revision: '1', submission: null })],
    ['freeze', () => db.freeze(handle, { draftId: write.draftId, expectedStoreVersion: write.expectedStoreVersion, command })],
    ['startSuccessor', () => db.startSuccessor(handle, command.operationId)], ['claimDispatch', () => db.claimDispatch(handle, command.operationId)],
    ['refusePrepared', () => db.refusePrepared(handle, command.operationId)], ['createUpload', () => db.createUpload(handle, upload)],
    ['beginUploadRequest', () => db.beginUploadRequest(handle, 'upload', 1, { kind: 'query' })], ['markUploadUnknown', () => db.markUploadUnknown(handle, 'upload', 1)],
    ['requestRelease', () => db.requestRelease(handle, 'upload')], ['resolveFailure', () => db.resolveFailure(handle, command.operationId, 'keep_current', 'old-choice')],
  ];
  for (const [label, attempt] of denied) await expect(attempt(), label).rejects.toMatchObject({ code: 'blocked' });
  for (const wrong of [{ ...operation('unknown'), executionGeneration: '3' }, { ...operation('unknown'), operationId: crypto.randomUUID() }, { ...operation('unknown'), kind: 'execute_command' as const }]) {
    await expect(db.observeSubmission(handle, command.operationId, wrong)).rejects.toMatchObject({ code: 'invalid' });
  }
  const observed = await db.observeSubmission(handle, command.operationId, operation('unknown'));
  expect(observed.submission).toMatchObject({ state: 'unknown', sensitiveCleared: true, command: null, snapshot: null, blobIds: [], uploadIds: [] });
  expect(observed.editable).toBeNull(); expect(observed.uploads).toEqual([]);
});

const otherScopes: readonly [string, DraftOwnerIdentity][] = [
  ['actor', { ...currentIdentity, target: { ...currentIdentity.target, actorUserId: 'other-actor' } }],
  ['origin', { ...currentIdentity, target: { ...currentIdentity.target, serverOrigin: 'https://other.test' } }],
  ['project', { ...currentIdentity, resolver: { kind: 'task', projectId: 'other-project', taskId: 'task' } }],
  ['task', { ...currentIdentity, resolver: { kind: 'task', projectId: 'project', taskId: 'other-task' } }],
  ['resolver', { ...currentIdentity, resolver: { kind: 'session', sessionId: target.fence.sessionId, testExecutionId: 'other-execution' } }],
  ['session', { ...currentIdentity, target: { ...currentIdentity.target, fence: { ...currentIdentity.target.fence, sessionId: 'other-session' } } }],
  ['claim', { ...currentIdentity, target: { ...currentIdentity.target, fence: { sessionId: target.fence.sessionId, executionGeneration: '3', claimId: 'other-claim' } } }],
  ['newer stored generation', { ...currentIdentity, target: { ...currentIdentity.target, fence: { ...currentIdentity.target.fence, executionGeneration: '1' } } }],
];
it.each(otherScopes)('keeps receipt access blocked across a different %s', async (_label, candidate) => {
  const { db, original } = await retained(); await db.reauthorizeOwner(candidate);
  expect(await db.readRecoverableSubmissions(candidate)).toEqual([]);
  await expect(db.read(original.owner)).rejects.toMatchObject({ code: 'blocked' });
  await expect(db.openOwner(identity)).rejects.toMatchObject({ code: 'blocked' });
});

it.each(['account_changed', 'revoked', 'deleted'] as const)('invalidates receipt handles after a subsequent %s', async reason => {
  const { db, command, operation } = await retained(); await db.reauthorizeOwner(currentIdentity);
  const recoveries = await db.readRecoverableSubmissions(currentIdentity); expect(recoveries).toHaveLength(1);
  const handle = recoveries[0]!.owner, peer = store();
  if (reason === 'account_changed') await peer.blockAccount(target.serverOrigin, target.actorUserId);
  else if (reason === 'revoked') await peer.revokeSession(target.serverOrigin, target.actorUserId, target.fence.sessionId);
  else await peer.blockSession(target.serverOrigin, target.actorUserId, target.fence.sessionId);
  await expect(db.readRecoverableSubmissions(currentIdentity)).rejects.toMatchObject({ code: 'blocked' });
  await expect(db.observeSubmission(handle, command.operationId, operation('unknown'))).rejects.toMatchObject({ code: 'blocked' });
  await expect(db.settleSubmission(handle, { operationId: command.operationId, outcome: 'accepted', operation: operation('provider_accepted') })).rejects.toMatchObject({ code: 'blocked' });
});

it('never reauthorizes a deleted historical Session', async () => {
  const { db } = await retained('deleted'); await expect(db.reauthorizeOwner(currentIdentity)).rejects.toMatchObject({ code: 'blocked' });
});

it('keeps historical recovery blocked until private-content cleanup commits', async () => {
  const db = store(); const { snapshot: original } = await db.importLegacy(identity, { text: 'private frozen text', revision: '1', submission: { operationId: 'original-unknown', revision: '1' } });
  const remove = IDBObjectStore.prototype.delete;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['delete']>) {
    if (this.name === 'drafts') throw new DOMException('private cleanup failed', 'UnknownError');
    return remove.apply(this, args);
  });
  try {
    await expect(db.blockAccount(target.serverOrigin, target.actorUserId)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(db.reauthorizeOwner(currentIdentity)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(db.readRecoverableSubmissions(currentIdentity)).rejects.toMatchObject({ code: 'blocked' });
    await expect(db.read(original.owner)).rejects.toMatchObject({ code: 'blocked' });
  } finally { fault.mockRestore(); await db.retryBlockedCleanup(target.serverOrigin, target.actorUserId); }
  await db.reauthorizeOwner(currentIdentity);
  const recoveries = await db.readRecoverableSubmissions(currentIdentity);
  expect(recoveries).toHaveLength(1);
  expect(recoveries[0]).toMatchObject({ editable: null, frozen: null, uploads: [], owner: { blocked: 'recovery_only', cleanupPending: false }, submission: { state: 'unknown', sensitiveCleared: true, command: null, snapshot: null } });
});

it('settles an original rejection without creating an editable historical draft', async () => {
  const { db, command, operation } = await retained(); const current = await db.reauthorizeOwner(currentIdentity);
  const historical = (await db.readRecoverableSubmissions(currentIdentity))[0]!;
  const rejected = await db.settleSubmission(historical.owner, { operationId: command.operationId, outcome: 'rejected', operation: operation('rejected') });
  expect(rejected).toMatchObject({ editable: null, frozen: null, submission: null, uploads: [], owner: { blocked: 'recovery_only' } });
  expect((await db.read(current.owner)).editable).toEqual(current.editable);
  await expect(db.reauthorizeOwner(identity)).rejects.toMatchObject({ code: 'blocked' });
});

it.each([
  ['account_changed', false], ['account_changed', true], ['revoked', false], ['revoked', true],
] as const)('keeps historical access recovery-only after a later %s and reauthorization (settled=%s)', async (reason, settled) => {
  const { db, command, operation } = await retained(); await db.reauthorizeOwner(currentIdentity);
  const historical = (await db.readRecoverableSubmissions(currentIdentity))[0]!;
  if (settled) await db.settleSubmission(historical.owner, { operationId: command.operationId, outcome: 'accepted', operation: operation('provider_accepted') });
  const peer = store();
  if (reason === 'account_changed') await peer.blockAccount(target.serverOrigin, target.actorUserId);
  else await peer.revokeSession(target.serverOrigin, target.actorUserId, target.fence.sessionId);
  const current = await db.reauthorizeOwner(currentIdentity);
  await expect(db.read(historical.owner)).rejects.toMatchObject({ code: 'blocked' });
  await expect(db.reauthorizeOwner(identity)).rejects.toMatchObject({ code: 'blocked' });
  await expect(db.openOwner(identity)).rejects.toMatchObject({ code: 'blocked' });
  const recoveries = await db.readRecoverableSubmissions(currentIdentity);
  expect(recoveries).toHaveLength(settled ? 0 : 1);
  if (!settled) {
    expect(recoveries[0]!.owner.accessEpoch).toBeGreaterThan(historical.owner.accessEpoch);
    await db.observeSubmission(recoveries[0]!.owner, command.operationId, operation('unknown'));
  }
  expect((await db.read(current.owner)).editable?.text).toBe('');
});

it.each([false, true])('rejects a cached historical identity before the current owner reauthorizes (settled=%s)', async settled => {
  const { db, command, operation } = await retained(); await db.reauthorizeOwner(currentIdentity);
  const historical = (await db.readRecoverableSubmissions(currentIdentity))[0]!;
  if (settled) await db.settleSubmission(historical.owner, { operationId: command.operationId, outcome: 'accepted', operation: operation('provider_accepted') });
  await db.blockAccount(target.serverOrigin, target.actorUserId);
  await expect(db.reauthorizeOwner(identity)).rejects.toMatchObject({ code: 'blocked' });
  await expect(db.readRecoverableSubmissions(currentIdentity)).rejects.toMatchObject({ code: 'blocked' });
  await db.reauthorizeOwner(currentIdentity);
});

it.each(['same', 'later'] as const)('retains explicit cancellation of a prepared tombstone from the %s execution generation', async generation => {
  const { db, command, operation } = await retained('account_changed', false);
  const currentTarget = generation === 'same' ? { ...currentIdentity.target, fence: target.fence } : currentIdentity.target;
  const current = await db.reauthorizeOwner({ ...currentIdentity, target: currentTarget });
  expect(current.executionBlocked).toBe(generation === 'same');
  const recoveries = await db.readRecoverableSubmissions(current.owner.identity); expect(recoveries).toHaveLength(1);
  const historical = recoveries[0]!;
  expect(historical.owner.blocked).toBeTruthy();
  expect(historical.submission).toMatchObject({ state: 'prepared', operationId: command.operationId, command: null, snapshot: null, sensitiveCleared: true });
  await expect(db.claimDispatch(historical.owner, command.operationId)).rejects.toMatchObject({ code: 'blocked' });
  await expect(db.observeSubmission(historical.owner, command.operationId, operation('unknown'))).rejects.toMatchObject({ code: 'blocked' });
  await expect(db.settleSubmission(historical.owner, { operationId: command.operationId, outcome: 'accepted', operation: operation('provider_accepted') })).rejects.toMatchObject({ code: 'blocked' });
  const refused = await db.refusePrepared(historical.owner, command.operationId);
  expect(refused.submission).toBeNull(); expect(refused.editable).toBeNull(); expect(refused.frozen).toBeNull();
  expect(await db.readRecoverableSubmissions(current.owner.identity)).toEqual([]);
  const after = await db.read(current.owner); expect(after.executionBlocked).toBe(false); expect(after.editable).toEqual(current.editable);
});

it('reconciles an admitted scope without creating a current owner or invalidating an existing recovery handle', async () => {
  const { db, command, operation } = await retained();
  const authorizer = store(); expect(await authorizer.reconcileAuthorizedOwner(currentIdentity)).toBeNull();
  expect(await db.reconcileAuthorizedOwner(currentIdentity)).toBeNull();
  expect(await db.readExisting(currentIdentity)).toBeNull();
  const historical = (await db.readRecoverableSubmissions(currentIdentity))[0]!;
  const peer = store(); expect(await peer.reconcileAuthorizedOwner(currentIdentity)).toBeNull();
  const repeated = (await db.readRecoverableSubmissions(currentIdentity))[0]!;
  expect(repeated.owner).toEqual(historical.owner);
  await db.observeSubmission(historical.owner, command.operationId, operation('unknown'));
  expect(await db.readExisting(currentIdentity)).toBeNull();
});

it.each(['cleanup', 'transaction'] as const)('does not restore access after admission is lost during %s reconciliation', async boundary => {
  const { db, original } = await retained(); let admitted = true;
  if (boundary === 'cleanup') {
    const cleanup = db.retryBlockedCleanup.bind(db), entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const held = vi.spyOn(db, 'retryBlockedCleanup').mockImplementationOnce(async (...args) => { await cleanup(...args); entered.resolve(); await finish.promise; });
    const reconcile = db.reconcileAuthorizedOwner(currentIdentity, () => admitted); await entered.promise;
    admitted = false; finish.resolve(); await expect(reconcile).rejects.toMatchObject({ code: 'blocked' }); held.mockRestore();
  } else {
    const remove = IDBObjectStore.prototype.delete;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['delete']>) {
      const request = remove.apply(this, args);
      if (this.name === 'owners') request.addEventListener('success', () => { admitted = false; }, { once: true });
      return request;
    });
    await expect(db.reconcileAuthorizedOwner(currentIdentity, () => admitted)).rejects.toMatchObject({ code: 'blocked' }); fault.mockRestore();
  }
  await expect(db.readExisting(currentIdentity)).rejects.toMatchObject({ code: 'blocked' });
  await expect(db.read(original.owner)).rejects.toMatchObject({ code: 'blocked' });
  const peer = store(); await expect(peer.readRecoverableSubmissions(currentIdentity)).rejects.toMatchObject({ code: 'blocked' });
});
