import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { ImageUploadReceipt, SessionOperation } from '../../../../../daynight/src/session/protocol';
import { canonicalDraftOrigin, draftAccountKey, draftExecutionKey, draftOwnerKey, sameDraftFence, sameDraftRecoveryScope, sameDraftTarget } from './draft-store-identity';
import { isValidatedDraftBlob } from './draft-types';
import type { DraftBlob, DraftBlobInput, DraftBlobValidationRef, DraftImageMetadata, DraftDetachedRef, DraftDetachedSnapshot, DraftDispatchAuthority, DraftDispatchClaim, DraftFreeze, DraftHandle, DraftImageItem, DraftOwner, DraftOwnerIdentity, DraftRecord, DraftRecoveryRef, DraftRecoverySnapshot, DraftSettlement, DraftSnapshot, DraftStoreErrorCode, DraftSubmission, DraftUpload, DraftUploadAction, DraftUploadReplacement, DraftWrite, LegacyDraftImport, NewDraftUpload } from './draft-types';
export { draftExecutionKey, draftOwnerKey } from './draft-store-identity';
export const SESSION_DRAFT_DATABASE = 'daynight-session-drafts';
// Older clients cannot safely interpret recovery-only owners or unvalidated originals.
// Upgrading closes their connections and makes their older-version reopen fail closed.
export const SESSION_DRAFT_SCHEMA = 3;
export const DRAFT_ACCOUNT_BYTE_LIMIT = 256 * 1024 * 1024;
export const DRAFT_TOTAL_BYTE_LIMIT = 512 * 1024 * 1024;
const MAX_REVISION = 9_223_372_036_854_775_807n;
const STORES = ['owners', 'drafts', 'blobs', 'uploads', 'submissions'] as const;
type AccessMarker = { readonly kind: 'account_tombstone' | 'session_tombstone'; readonly ownerKey: string; readonly accountKey: string; readonly sessionId: string | null; readonly reason: 'account_changed' | 'revoked' | 'deleted' };
type CleanupScope = { readonly origin: string; readonly actorUserId: string; readonly sessionId: string | null; readonly reason: 'account_changed' | 'revoked' | 'deleted' };
const pendingScopeCleanup = new Map<string, CleanupScope>();
const isOwner = (row: DraftOwner | AccessMarker): row is DraftOwner => 'identity' in row;
const accountMarkerKey = (origin: string, actor: string): string => JSON.stringify(['daynight-draft-access', 1, canonicalDraftOrigin(origin), actor]);
const sessionMarkerKey = (origin: string, actor: string, sessionId: string): string => JSON.stringify(['daynight-draft-session-access', 1, canonicalDraftOrigin(origin), actor, sessionId]);
export interface SessionDraftSchema extends DBSchema {
  owners: { key: string; value: DraftOwner | AccessMarker; indexes: { execution: string; account: string } };
  drafts: { key: [string, string]; value: DraftRecord; indexes: { owner: string } };
  blobs: { key: [string, string]; value: DraftBlob; indexes: { owner: string } };
  uploads: { key: [string, string]; value: DraftUpload; indexes: { owner: string } };
  submissions: { key: [string, string]; value: DraftSubmission; indexes: { owner: string; execution: string } };
}
type Tx = IDBPTransaction<SessionDraftSchema, typeof STORES, 'readwrite'>;
export class DraftStoreError extends Error {
  constructor(readonly code: DraftStoreErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = 'DraftStoreError'; }
}
const fail = (code: DraftStoreErrorCode, message: string): never => { throw new DraftStoreError(code, message); };
const pending = (submission: DraftSubmission) => !['accepted', 'rejected', 'local_not_dispatched'].includes(submission.state);
const newDraft = (ownerKey: string): DraftRecord => ({ ownerKey, draftId: crypto.randomUUID(), revision: '1', storeVersion: 1, text: '', items: [], rejectedCandidates: [], overflowRejectedCount: 0, state: 'editable', savedAt: Date.now() });
const increment = (version: number): number => { if (!Number.isSafeInteger(version) || version >= Number.MAX_SAFE_INTEGER) return fail('invalid', 'Draft storage version is exhausted.'); return version + 1; };
const revision = (value: string): string => { if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) >= MAX_REVISION) return fail('revision_exhausted', 'Create a new draft before editing this revision.'); return String(BigInt(value) + 1n); };
const immutable = <T>(value: T): T => structuredClone(value);
const hasContent = (draft: DraftRecord): boolean => !!(draft.text.length || draft.items.length || draft.rejectedCandidates.length || draft.overflowRejectedCount);

export function draftRecoveryRef(snapshot: Pick<DraftSnapshot, 'owner' | 'submission' | 'frozen' | 'editable'>): DraftRecoveryRef | null {
  if (!snapshot.submission) return null;
  const version = (draft: DraftRecord | null) => draft ? [draft.draftId, draft.revision, draft.storeVersion] : null;
  return { ownerKey: snapshot.owner.ownerKey, operationId: snapshot.submission.operationId,
    choiceRevision: JSON.stringify([snapshot.owner.accessEpoch, snapshot.submission.state, version(snapshot.frozen), version(snapshot.editable)]) };
}

export function draftDetachedRef(snapshot: Pick<DraftSnapshot, 'owner' | 'submission' | 'editable'>): DraftDetachedRef | null {
  const draft = snapshot.editable;
  if (snapshot.submission || !draft || draft.state !== 'editable' || !hasContent(draft)) return null;
  return { ownerKey: snapshot.owner.ownerKey, accessEpoch: snapshot.owner.accessEpoch, draftId: draft.draftId, revision: draft.revision, storeVersion: draft.storeVersion };
}

export class SessionDraftStore {
  private connection: Promise<IDBPDatabase<SessionDraftSchema>> | null = null;
  private revoked = new Set<string>();
  private claimGeneration = 0;
  private dispatchAuthorities = new WeakMap<DraftDispatchAuthority, { readonly ownerKey: string; readonly accessEpoch: number; readonly operationId: string }>();
  constructor(private readonly options: { readonly databaseName?: string } = {}) {}
  close(): void { this.claimGeneration++; this.dispatchAuthorities = new WeakMap(); const current = this.connection; this.connection = null; void current?.then((db) => db.close(), () => {}); }
  private database(): Promise<IDBPDatabase<SessionDraftSchema>> {
    if (this.connection) return this.connection;
    if (typeof indexedDB === 'undefined') return Promise.reject(new DraftStoreError('unavailable', 'Draft storage is unavailable.'));
    const opening = new Promise<IDBPDatabase<SessionDraftSchema>>((resolve, reject) => {
      let abandoned = false;
      void openDB<SessionDraftSchema>(this.options.databaseName ?? SESSION_DRAFT_DATABASE, SESSION_DRAFT_SCHEMA, {
        upgrade(db, oldVersion) {
          if (oldVersion >= 1) return;
          const owners = db.createObjectStore('owners', { keyPath: 'ownerKey' }); owners.createIndex('execution', 'executionKey'); owners.createIndex('account', 'accountKey');
          for (const [name, id] of [['drafts', 'draftId'], ['blobs', 'blobId'], ['uploads', 'uploadId'], ['submissions', 'operationId']] as const) {
            const object = db.createObjectStore(name, { keyPath: ['ownerKey', id] }); object.createIndex('owner', 'ownerKey');
            if (name === 'submissions') (object as ReturnType<typeof db.createObjectStore<'submissions'>>).createIndex('execution', 'executionKey');
          }
        },
        blocked() { abandoned = true; reject(new DraftStoreError('unavailable', 'Draft storage upgrade is blocked by another window.')); },
        blocking: () => { this.close(); },
        terminated: () => { this.connection = null; },
      }).then((db) => { if (abandoned) db.close(); else resolve(db); }, (cause) => reject(new DraftStoreError('unavailable', 'Draft storage could not be opened.', { cause })));
    });
    this.connection = opening; void opening.catch(() => { if (this.connection === opening) this.connection = null; }); return opening;
  }
  private async transaction<T>(mode: 'readonly' | 'readwrite', callback: (tx: Tx) => Promise<T>, strict = false, admitted?: () => boolean): Promise<T> {
    const db = await this.database();
    if (admitted && !admitted()) return fail('blocked', 'Draft authorization is no longer current.');
    const tx = db.transaction(STORES, mode, strict ? { durability: 'strict' } : undefined) as Tx;
    // Observe done immediately: an aborted transaction can reject before its request does.
    const complete = tx.done; void complete.catch(() => {});
    try {
      const result = await callback(tx);
      if (admitted && !admitted()) return fail('blocked', 'Draft authorization is no longer current.');
      await complete; return result;
    }
    catch (error) {
      try { tx.abort(); } catch { /* The transaction may already have completed or aborted. */ }
      await complete.catch(() => {});
      if (error instanceof DraftStoreError) throw error;
      throw new DraftStoreError(error instanceof DOMException && error.name === 'QuotaExceededError' ? 'quota' : 'unavailable', 'Draft storage did not commit.', { cause: error });
    }
  }
  private async readOwner(tx: Tx, key: string): Promise<DraftOwner | undefined> {
    const row = await tx.objectStore('owners').get(key); return row && isOwner(row) ? row : undefined;
  }
  private async assertIdentityAvailable(tx: Tx, identity: DraftOwnerIdentity): Promise<void> {
    const target = identity.target;
    if (pendingScopeCleanup.has(accountMarkerKey(target.serverOrigin, target.actorUserId)) || pendingScopeCleanup.has(sessionMarkerKey(target.serverOrigin, target.actorUserId, target.fence.sessionId)) || await tx.objectStore('owners').get(accountMarkerKey(target.serverOrigin, target.actorUserId)) || await tx.objectStore('owners').get(sessionMarkerKey(target.serverOrigin, target.actorUserId, target.fence.sessionId))) fail('blocked', 'Draft access must be confirmed again.');
  }
  private async owner(tx: Tx, handle: DraftHandle): Promise<DraftOwner> {
    const owner = await this.readOwner(tx, handle.ownerKey);
    if (!owner || owner.accessEpoch !== handle.accessEpoch || owner.blocked || owner.recoveryOnly || this.revoked.has(handle.ownerKey)) return fail('blocked', 'Draft access is no longer current.');
    await this.assertIdentityAvailable(tx, owner.identity);
    return owner;
  }
  private async recoveryOwner(tx: Tx, handle: DraftHandle, action: 'list' | 'observe' | 'cancel', operationId?: string): Promise<DraftOwner> {
    const owner = await this.readOwner(tx, handle.ownerKey);
    if (owner?.blocked !== 'recovery_only') return this.owner(tx, handle);
    if (owner.accessEpoch !== handle.accessEpoch || owner.cleanupPending || this.revoked.has(owner.ownerKey)) return fail('blocked', 'Original-operation recovery is no longer authorized.');
    await this.assertIdentityAvailable(tx, owner.identity);
    const submission = owner.unresolvedSubmissionId ? await tx.objectStore('submissions').get([owner.ownerKey, owner.unresolvedSubmissionId]) : undefined;
    if (!submission || !submission.sensitiveCleared || submission.command || submission.snapshot || submission.blobIds.length || submission.uploadIds.length || !['prepared', 'dispatch_claimed', 'unknown'].includes(submission.state)) return fail('blocked', 'Only a cleared original operation can be recovered.');
    if (operationId !== undefined && operationId !== submission.operationId) return fail('invalid', 'The operation does not match the retained original submission.');
    if (action === 'observe' && submission.state === 'prepared' || action === 'cancel' && submission.state !== 'prepared') return fail('blocked', 'This recovery action is not permitted for the original operation.');
    return owner;
  }
  private async snapshot(tx: Tx, owner: DraftOwner): Promise<DraftSnapshot> {
    const submission = owner.unresolvedSubmissionId ? await tx.objectStore('submissions').get([owner.ownerKey, owner.unresolvedSubmissionId]) ?? null : null;
    const load = async (id: string | null): Promise<DraftRecord | null> => {
      if (!id) return null;
      const draft = await tx.objectStore('drafts').get([owner.ownerKey, id]); if (!draft) return null;
      const items = await Promise.all(draft.items.map(async (item) => {
        if (!item.blobId) return item;
        const blob = await tx.objectStore('blobs').get([owner.ownerKey, item.blobId]);
        if (!blob) return { ...item, validation: 'bytes_missing' as const, error: 'bytes_missing' };
        if (blob.byteRevision !== item.byteRevision || blob.blob.size !== blob.byteLength) return { ...item, validation: 'bytes_invalid' as const, error: 'bytes_invalid' };
        return !isValidatedDraftBlob(blob) && item.validation === 'valid' ? { ...item, validation: 'pending' as const, error: null } : item;
      })); return { ...draft, items };
    };
    const executionOwners = (await tx.objectStore('owners').index('execution').getAll(owner.executionKey)).filter(isOwner);
    const recoveryOnly = owner.recoveryOnly || owner.blocked === 'recovery_only';
    return { owner, editable: recoveryOnly ? null : await load(owner.editableDraftId), frozen: recoveryOnly ? null : await load(submission?.draftId ?? null), submission, uploads: recoveryOnly ? [] : await tx.objectStore('uploads').index('owner').getAll(owner.ownerKey), executionBlocked: executionOwners.some((item) => item.unresolvedSubmissionId !== null) };
  }
  async readExisting(identity: DraftOwnerIdentity): Promise<DraftSnapshot | null> {
    const key = draftOwnerKey(identity);
    return this.transaction('readonly', async (tx) => { await this.assertIdentityAvailable(tx, identity); const owner = await this.readOwner(tx, key); return owner ? this.snapshot(tx, await this.owner(tx, owner)) : null; });
  }
  async openOwner(identity: DraftOwnerIdentity): Promise<DraftSnapshot> {
    const normalized = immutable({ ...identity, target: { ...identity.target, serverOrigin: canonicalDraftOrigin(identity.target.serverOrigin) } });
    const key = draftOwnerKey(normalized);
    return this.transaction('readwrite', async (tx) => {
      await this.assertIdentityAvailable(tx, normalized);
      const existing = await this.readOwner(tx, key); if (existing) return this.snapshot(tx, await this.owner(tx, existing));
      if (this.revoked.has(key)) return fail('blocked', 'Draft access has been revoked.');
      const draft = newDraft(key); const owner: DraftOwner = { ownerKey: key, identity: normalized, executionKey: draftExecutionKey(normalized), accountKey: draftAccountKey(normalized), accessEpoch: 1, storeVersion: 1, editableDraftId: draft.draftId, unresolvedSubmissionId: null, blocked: null, cleanupPending: false, allocatedBytes: 0, legacyImported: false };
      await tx.objectStore('owners').add(owner); await tx.objectStore('drafts').add(draft); return this.snapshot(tx, owner);
    });
  }
  async readExecutionSubmissions(identity: DraftOwnerIdentity): Promise<readonly { readonly owner: DraftOwner; readonly submission: DraftSubmission }[]> {
    return this.transaction('readonly', async (tx) => {
      await this.assertIdentityAvailable(tx, identity);
      const results: { owner: DraftOwner; submission: DraftSubmission }[] = [];
      for (const owner of (await tx.objectStore('owners').index('execution').getAll(draftExecutionKey(identity))).filter(isOwner)) {
        if (owner.blocked && owner.blocked !== 'recovery_only' || owner.cleanupPending || this.revoked.has(owner.ownerKey) || !owner.unresolvedSubmissionId || !sameDraftRecoveryScope(owner.identity, identity)) continue;
        await this.recoveryOwner(tx, owner, 'list');
        const submission = await tx.objectStore('submissions').get([owner.ownerKey, owner.unresolvedSubmissionId]);
        if (submission) results.push({ owner, submission });
      }
      return results;
    });
  }
  async readRecoverableSubmissions(identity: DraftOwnerIdentity): Promise<readonly DraftRecoverySnapshot[]> {
    return this.transaction('readonly', async (tx) => {
      await this.assertIdentityAvailable(tx, identity);
      const current = await this.readOwner(tx, draftOwnerKey(identity));
      if (current) await this.owner(tx, current);
      const results: DraftRecoverySnapshot[] = [];
      for (const owner of (await tx.objectStore('owners').index('account').getAll(draftAccountKey(identity))).filter(isOwner)) {
        if (owner.blocked && owner.blocked !== 'recovery_only' || owner.cleanupPending || this.revoked.has(owner.ownerKey) || !owner.unresolvedSubmissionId || !sameDraftRecoveryScope(owner.identity, identity)) continue;
        const snapshot = await this.snapshot(tx, await this.recoveryOwner(tx, owner, 'list'));
        if (snapshot.submission) results.push({ ...snapshot, submission: snapshot.submission });
      }
      return results;
    });
  }
  async readDetachedDrafts(identity: DraftOwnerIdentity): Promise<readonly DraftDetachedSnapshot[]> {
    return this.transaction('readonly', async (tx) => {
      await this.assertIdentityAvailable(tx, identity);
      const currentKey = draftOwnerKey(identity), current = await this.readOwner(tx, currentKey);
      if (current) await this.owner(tx, current);
      const results: DraftDetachedSnapshot[] = [];
      for (const owner of (await tx.objectStore('owners').index('account').getAll(draftAccountKey(identity))).filter(isOwner)) {
        if (owner.ownerKey === currentKey || owner.blocked || owner.cleanupPending || this.revoked.has(owner.ownerKey) || owner.unresolvedSubmissionId || !sameDraftRecoveryScope(owner.identity, identity)) continue;
        const snapshot = await this.snapshot(tx, await this.owner(tx, owner));
        if (snapshot.editable?.state === 'editable' && hasContent(snapshot.editable) && !snapshot.submission) results.push({ ...snapshot, editable: snapshot.editable, submission: null });
      }
      return results;
    });
  }
  async collectRecoveryResources(identity: DraftOwnerIdentity): Promise<void> {
    await this.transaction('readwrite', async (tx) => {
      await this.assertIdentityAvailable(tx, identity);
      const current = await this.readOwner(tx, draftOwnerKey(identity));
      if (current) await this.owner(tx, current);
      for (const owner of (await tx.objectStore('owners').index('account').getAll(draftAccountKey(identity))).filter(isOwner)) {
        if (owner.blocked || owner.cleanupPending || this.revoked.has(owner.ownerKey) || !sameDraftRecoveryScope(owner.identity, identity)) continue;
        await this.collect(tx, await this.owner(tx, owner));
      }
    });
  }
  async restoreDetachedDraft(handle: DraftHandle, source: DraftDetachedRef, target: Pick<DraftWrite, 'draftId' | 'expectedStoreVersion'>): Promise<DraftSnapshot> {
    const ref = immutable(source), expected = immutable(target);
    return this.transaction('readwrite', async (tx) => {
      let owner = await this.owner(tx, handle), previous = await this.owner(tx, ref);
      if (previous.ownerKey === owner.ownerKey || !sameDraftRecoveryScope(previous.identity, owner.identity)) return fail('invalid', 'The retained draft does not belong to this recovery scope.');
      if (previous.cleanupPending || owner.cleanupPending) return fail('blocked', 'Draft cleanup must finish before restoring content.');
      for (const key of new Set([previous.executionKey, owner.executionKey])) {
        if ((await tx.objectStore('owners').index('execution').getAll(key)).filter(isOwner).some(candidate => candidate.unresolvedSubmissionId)) return fail('execution_blocked', 'An original submission still needs reconciliation.');
      }
      const old = await tx.objectStore('drafts').get([previous.ownerKey, ref.draftId]);
      const current = await tx.objectStore('drafts').get([owner.ownerKey, expected.draftId]);
      if (!old || old.state !== 'editable' || previous.editableDraftId !== old.draftId || old.revision !== ref.revision || old.storeVersion !== ref.storeVersion || !hasContent(old)) return fail('conflict', 'The retained draft changed after it was displayed.');
      if (!current || current.state !== 'editable' || owner.editableDraftId !== current.draftId || current.storeVersion !== expected.expectedStoreVersion || hasContent(current)) return fail('conflict', 'The current draft must still be empty before restoring content.');
      const blobs = new Map<string, DraftBlob | null>(), items: DraftImageItem[] = [];
      for (const item of old.items) {
        let copied: DraftBlob | null = null;
        if (item.blobId) {
          if (!blobs.has(item.blobId)) {
            const original = await tx.objectStore('blobs').get([previous.ownerKey, item.blobId]);
            const next = original ? { ...original, ownerKey: owner.ownerKey, blobId: crypto.randomUUID(), originalId: crypto.randomUUID(), references: [] } : null;
            if (next) await tx.objectStore('blobs').add(next);
            blobs.set(item.blobId, next);
          }
          copied = blobs.get(item.blobId)!;
        }
        const valid = copied && copied.byteRevision === item.byteRevision && copied.byteLength === copied.blob.size;
        items.push({ ...item, draftImageId: crypto.randomUUID(), imageId: crypto.randomUUID(), blobId: copied?.blobId ?? null, uploadId: null,
          validation: !copied ? 'bytes_missing' : valid ? 'pending' : 'bytes_invalid', error: !copied ? 'bytes_missing' : valid ? null : 'bytes_invalid' });
      }
      const moved: DraftRecord = { ...newDraft(owner.ownerKey), text: old.text, items, rejectedCandidates: old.rejectedCandidates, overflowRejectedCount: old.overflowRejectedCount };
      const empty = newDraft(previous.ownerKey);
      await tx.objectStore('drafts').add(moved); await tx.objectStore('drafts').add(empty);
      await this.releaseRemoved(tx, previous.ownerKey, old, null);
      await tx.objectStore('drafts').delete([previous.ownerKey, old.draftId]); await tx.objectStore('drafts').delete([owner.ownerKey, current.draftId]);
      previous = await this.collect(tx, { ...previous, editableDraftId: empty.draftId, storeVersion: increment(previous.storeVersion) });
      owner = await this.collect(tx, { ...owner, editableDraftId: moved.draftId, storeVersion: increment(owner.storeVersion) });
      await this.budget(tx, owner); return this.snapshot(tx, owner);
    }, true);
  }
  async read(handle: DraftHandle): Promise<DraftSnapshot> { return this.transaction('readonly', async (tx) => this.snapshot(tx, await this.owner(tx, handle))); }
  async readBlob(handle: DraftHandle, blobId: string): Promise<DraftBlob | null> { return this.transaction('readonly', async (tx) => { await this.owner(tx, handle); return await tx.objectStore('blobs').get([handle.ownerKey, blobId]) ?? null; }); }
  private async collect(tx: Tx, owner: DraftOwner): Promise<DraftOwner> {
    const references = new Map<string, string[]>();
    const refer = (id: string | null, reference: string) => { if (id) references.set(id, [...references.get(id) ?? [], reference]); };
    for (const draft of await tx.objectStore('drafts').index('owner').getAll(owner.ownerKey)) for (const item of draft.items) refer(item.blobId, `draft:${draft.draftId}:${item.draftImageId}`);
    for (const submission of await tx.objectStore('submissions').index('owner').getAll(owner.ownerKey)) if (pending(submission)) for (const id of submission.blobIds) refer(id, `submission:${submission.operationId}`);
    let allocatedBytes = 0;
    for (const blob of await tx.objectStore('blobs').index('owner').getAll(owner.ownerKey)) {
      const refs = references.get(blob.blobId) ?? [];
      if (!refs.length) await tx.objectStore('blobs').delete([owner.ownerKey, blob.blobId]);
      else { allocatedBytes += blob.byteLength; await tx.objectStore('blobs').put({ ...blob, references: refs }); }
    }
    const next = { ...owner, allocatedBytes }; await tx.objectStore('owners').put(next); return next;
  }
  private async budget(tx: Tx, owner: DraftOwner): Promise<void> {
    let total = 0, account = 0;
    for (const candidate of (await tx.objectStore('owners').getAll()).filter(isOwner)) { total += candidate.allocatedBytes; if (candidate.accountKey === owner.accountKey) account += candidate.allocatedBytes; }
    if (account > DRAFT_ACCOUNT_BYTE_LIMIT || total > DRAFT_TOTAL_BYTE_LIMIT) fail('quota', 'Local image storage is full.');
  }
  private async releaseRemoved(tx: Tx, ownerKey: string, before: DraftRecord, after: DraftRecord | null): Promise<void> {
    const retained = new Set(after?.items.map((item) => item.uploadId));
    for (const item of before.items) if (item.uploadId && !retained.has(item.uploadId)) {
      const upload = await tx.objectStore('uploads').get([ownerKey, item.uploadId]);
      if (upload && !upload.releaseIntent) await tx.objectStore('uploads').put({ ...upload, releaseIntent: true, storeVersion: increment(upload.storeVersion) });
    }
  }
  async saveDraft(handle: DraftHandle, write: DraftWrite): Promise<DraftSnapshot> {
    const input = immutable(write);
    return this.transaction('readwrite', async (tx) => {
      let owner = await this.owner(tx, handle); const old = await tx.objectStore('drafts').get([handle.ownerKey, input.draftId]);
      if (!old || old.state !== 'editable' || owner.editableDraftId !== old.draftId || old.storeVersion !== input.expectedStoreVersion) return fail('conflict', 'The saved draft changed in another window.');
      if (input.items.length > 8 || input.rejectedCandidates.length > 32 || !Number.isSafeInteger(input.overflowRejectedCount) || input.overflowRejectedCount < 0 || new Set(input.items.map((item) => item.draftImageId)).size !== input.items.length) return fail('invalid', 'Invalid ordered draft items.');
      for (const blob of input.blobs ?? []) {
        if (blob.blob.size !== blob.byteLength || blob.byteLength <= 0 || blob.byteLength > 10 * 1024 * 1024 || isValidatedDraftBlob(blob) && !/^[0-9a-f]{64}$/.test(blob.sha256)) return fail('bytes_invalid', 'Image bytes do not match their metadata.');
        const existing = await tx.objectStore('blobs').get([handle.ownerKey, blob.blobId]);
        if (existing && (existing.byteLength !== blob.byteLength || existing.byteRevision !== blob.byteRevision || isValidatedDraftBlob(blob) && (!isValidatedDraftBlob(existing) || existing.sha256 !== blob.sha256))) return fail('conflict', 'Original image bytes are immutable.');
        if (!existing) await tx.objectStore('blobs').add({ ...blob, ownerKey: handle.ownerKey, references: [], originalId: crypto.randomUUID() });
      }
      const items = input.items.map(item => {
        const previous = old.items.find(candidate => candidate.draftImageId === item.draftImageId && candidate.imageId === item.imageId && candidate.byteRevision === item.byteRevision && candidate.blobId === item.blobId);
        return { ...item, incarnation: previous?.incarnation ?? crypto.randomUUID() };
      });
      let imageBytes = 0;
      for (const item of items) if (item.blobId) { const blob = await tx.objectStore('blobs').get([handle.ownerKey, item.blobId]); if (blob) { if (blob.byteRevision !== item.byteRevision) return fail('bytes_invalid', 'Image byte revision changed.'); imageBytes += blob.byteLength; } }
      if (imageBytes > 20 * 1024 * 1024) return fail('quota', 'The draft exceeds the image message limit.');
      if (old.text === input.text && JSON.stringify(old.items) === JSON.stringify(items) && JSON.stringify(old.rejectedCandidates) === JSON.stringify(input.rejectedCandidates) && old.overflowRejectedCount === input.overflowRejectedCount) { owner = await this.collect(tx, owner); await this.budget(tx, owner); return this.snapshot(tx, owner); }
      const next: DraftRecord = { ...old, text: input.text, items, rejectedCandidates: input.rejectedCandidates, overflowRejectedCount: input.overflowRejectedCount, revision: revision(old.revision), storeVersion: increment(old.storeVersion), savedAt: Date.now() };
      await this.releaseRemoved(tx, owner.ownerKey, old, next); await tx.objectStore('drafts').put(next); owner = await this.collect(tx, owner); await this.budget(tx, owner); return this.snapshot(tx, owner);
    });
  }
  /** Add validation metadata to the persisted original, never caller-supplied replacement bytes. */
  async validateBlob(handle: DraftHandle, reference: DraftBlobValidationRef, metadata: DraftImageMetadata): Promise<DraftBlobInput> {
    const ref = immutable(reference), value = immutable(metadata);
    return this.transaction('readwrite', async tx => {
      const owner = await this.owner(tx, handle);
      const draft = await tx.objectStore('drafts').get([owner.ownerKey, ref.draftId]);
      const item = draft?.items.find(candidate => candidate.draftImageId === ref.draftImageId);
      const blob = await tx.objectStore('blobs').get([owner.ownerKey, ref.blobId]);
      if (!draft || owner.editableDraftId !== draft.draftId || draft.state !== 'editable' || !item || !ref.itemIncarnation || item.incarnation !== ref.itemIncarnation || item.blobId !== ref.blobId || item.byteRevision !== ref.byteRevision || !blob || !ref.originalId || blob.originalId !== ref.originalId || blob.byteRevision !== ref.byteRevision) return fail('conflict', 'The original image changed during validation.');
      if (value.byteLength !== blob.byteLength || blob.blob.size !== blob.byteLength || !/^[0-9a-f]{64}$/.test(value.sha256)) return fail('bytes_invalid', 'Image validation does not match the saved original.');
      if (isValidatedDraftBlob(blob)) {
        if (value.sha256 !== blob.sha256 || value.mediaType !== blob.mediaType || value.width !== blob.width || value.height !== blob.height || value.frameCount !== blob.frameCount) return fail('bytes_invalid', 'Original image metadata is immutable.');
        return blob;
      }
      const verified = { ...blob, byteLength: value.byteLength, sha256: value.sha256, mediaType: value.mediaType, width: value.width, height: value.height, frameCount: value.frameCount, validation: 'verified' as const };
      await tx.objectStore('blobs').put(verified); return verified;
    });
  }
  async renewDraft(handle: DraftHandle, expectedStoreVersion: number): Promise<DraftSnapshot> {
    return this.transaction('readwrite', async (tx) => {
      let owner = await this.owner(tx, handle);
      if (owner.unresolvedSubmissionId) return fail('execution_blocked', 'A frozen submission prevents draft renewal.');
      const draft = owner.editableDraftId ? await tx.objectStore('drafts').get([owner.ownerKey, owner.editableDraftId]) : undefined;
      if (!draft || draft.storeVersion !== expectedStoreVersion) return fail('conflict', 'The editable draft changed before renewal.');
      if (draft.revision !== String(MAX_REVISION)) return fail('invalid', 'Only an exhausted draft revision needs renewal.');
      const next: DraftRecord = { ...draft, draftId: crypto.randomUUID(), revision: '1', storeVersion: 1, savedAt: Date.now() };
      await tx.objectStore('drafts').add(next); await tx.objectStore('drafts').delete([owner.ownerKey, draft.draftId]);
      owner = { ...owner, editableDraftId: next.draftId, storeVersion: increment(owner.storeVersion) }; owner = await this.collect(tx, owner); return this.snapshot(tx, owner);
    }, true);
  }
  async createUpload(handle: DraftHandle, input: NewDraftUpload): Promise<DraftUpload> {
    const value = immutable(input);
    return this.transaction('readwrite', async (tx) => {
      const owner = await this.owner(tx, handle);
      if (!sameDraftTarget(value.spec.target, owner.identity.target)) return fail('invalid', 'The upload target changed.');
      const existing = await tx.objectStore('uploads').get([owner.ownerKey, value.spec.uploadId]);
      if (existing) {
        if (JSON.stringify(existing.spec) !== JSON.stringify(value.spec) || existing.draftImageId !== value.draftImageId || existing.byteRevision !== value.byteRevision || existing.blobId !== value.blobId) return fail('conflict', 'An upload identity already owns different bytes.');
        return existing;
      }
      if ((await tx.objectStore('uploads').index('owner').getAll(owner.ownerKey)).some(upload => upload.spec.imageId === value.spec.imageId)) return fail('conflict', 'The image identity already belongs to its original upload.');
      const draft = owner.editableDraftId ? await tx.objectStore('drafts').get([owner.ownerKey, owner.editableDraftId]) : undefined;
      const item = draft?.items.find((candidate) => candidate.draftImageId === value.draftImageId);
      const blob = await tx.objectStore('blobs').get([owner.ownerKey, value.blobId]);
      if (!draft || !item || item.byteRevision !== value.byteRevision || item.blobId !== value.blobId || item.imageId !== value.spec.imageId || item.label !== value.spec.name || !blob || !isValidatedDraftBlob(blob) || item.validation !== 'valid' || value.spec.byteLength !== String(blob.byteLength) || value.spec.sha256 !== blob.sha256 || value.spec.mediaType !== blob.mediaType) return fail('conflict', 'The image changed before upload preparation.');
      if (item.uploadId) {
        const previous = await tx.objectStore('uploads').get([owner.ownerKey, item.uploadId]);
        if (previous) return fail('conflict', 'Use terminal replacement to allocate a new image and upload identity.');
      }
      const upload: DraftUpload = { ...value, ownerKey: owner.ownerKey, uploadId: value.spec.uploadId, storeVersion: 1, requestSequence: 0, observedSequence: 0, receipt: null, pendingAction: null, outcomeUnknown: false, releaseIntent: false };
      await tx.objectStore('uploads').add(upload);
      await tx.objectStore('drafts').put({ ...draft, storeVersion: increment(draft.storeVersion), items: draft.items.map((candidate) => candidate.draftImageId === item.draftImageId ? { ...candidate, uploadId: upload.uploadId } : candidate) });
      return upload;
    });
  }
  /** A terminal retry owns a new server image identity as well as a new upload. */
  async replaceTerminalUpload(handle: DraftHandle, input: DraftUploadReplacement, admitted: () => boolean = () => true): Promise<DraftSnapshot> {
    const value = immutable(input);
    return this.transaction('readwrite', async tx => {
      const owner = await this.owner(tx, handle);
      const draft = await tx.objectStore('drafts').get([owner.ownerKey, value.draftId]);
      const item = draft?.items.find(candidate => candidate.draftImageId === value.draftImageId);
      const previous = await tx.objectStore('uploads').get([owner.ownerKey, value.uploadId]);
      if (!draft || owner.editableDraftId !== draft.draftId || draft.state !== 'editable' || draft.storeVersion !== value.expectedStoreVersion || !item || !value.itemIncarnation || item.incarnation !== value.itemIncarnation || item.uploadId !== value.uploadId || !previous || previous.storeVersion !== value.uploadStoreVersion || previous.outcomeUnknown || previous.pendingAction || !['failed', 'expired', 'released'].includes(previous.receipt?.state ?? '')) return fail('conflict', 'The original upload must be confirmed terminal before replacement.');
      const blob = item.blobId ? await tx.objectStore('blobs').get([owner.ownerKey, item.blobId]) : undefined;
      if (!blob || !isValidatedDraftBlob(blob) || item.validation !== 'valid' || item.byteRevision !== blob.byteRevision || previous.blobId !== item.blobId || previous.byteRevision !== item.byteRevision || previous.spec.imageId !== item.imageId) return fail('conflict', 'The original image changed before upload replacement.');
      const uploadId = crypto.randomUUID(), imageId = crypto.randomUUID();
      const upload: DraftUpload = { ownerKey: owner.ownerKey, draftImageId: item.draftImageId, byteRevision: item.byteRevision, blobId: blob.blobId, uploadId,
        spec: { uploadId, imageId, target: owner.identity.target, name: item.label, mediaType: blob.mediaType, byteLength: String(blob.byteLength), sha256: blob.sha256 },
        storeVersion: 1, requestSequence: 0, observedSequence: 0, receipt: null, pendingAction: null, outcomeUnknown: false, releaseIntent: false };
      await tx.objectStore('uploads').add(upload);
      if (!previous.releaseIntent) await tx.objectStore('uploads').put({ ...previous, releaseIntent: true, storeVersion: increment(previous.storeVersion) });
      await tx.objectStore('drafts').put({ ...draft, storeVersion: increment(draft.storeVersion), items: draft.items.map(candidate => candidate === item ? { ...candidate, imageId, uploadId } : candidate) });
      return this.snapshot(tx, owner);
    }, true, admitted);
  }
  async beginUploadRequest(handle: DraftHandle, uploadId: string, expectedStoreVersion: number, action: DraftUploadAction): Promise<DraftUpload> {
    return this.transaction('readwrite', async (tx) => {
      const owner = await this.owner(tx, handle); const upload = await tx.objectStore('uploads').get([owner.ownerKey, uploadId]);
      if (!upload || upload.storeVersion !== expectedStoreVersion) return fail('conflict', 'The upload changed in another window.');
      if (upload.releaseIntent && !['query', 'release'].includes(action.kind)) return fail('blocked', 'The upload is waiting for release.');
      if (action.kind === 'release' && !upload.releaseIntent) return fail('invalid', 'Release must be explicitly requested.');
      if (action.kind === 'chunk' && (!/^(0|[1-9][0-9]*)$/.test(action.offset) || action.length <= 0 || action.length > 512 * 1024 || !/^[0-9a-f]{64}$/.test(action.sha256))) return fail('invalid', 'Invalid upload chunk boundary.');
      const next: DraftUpload = { ...upload, storeVersion: increment(upload.storeVersion), requestSequence: increment(upload.requestSequence), pendingAction: action.kind === 'query' && upload.pendingAction ? upload.pendingAction : immutable(action) };
      await tx.objectStore('uploads').put(next); return next;
    }, true);
  }
  async observeUpload(handle: DraftHandle, uploadId: string, requestSequence: number, receipt: ImageUploadReceipt): Promise<DraftUpload> {
    const observation = immutable(receipt);
    return this.transaction('readwrite', async (tx) => {
      const owner = await this.owner(tx, handle); const upload = await tx.objectStore('uploads').get([owner.ownerKey, uploadId]);
      if (!upload) return fail('invalid', 'The original upload is missing.');
      if (requestSequence !== upload.requestSequence || requestSequence <= upload.observedSequence) return upload;
      const spec = upload.spec;
      if (observation.uploadId !== uploadId || observation.imageId !== spec.imageId || !sameDraftTarget(observation.target, spec.target) || observation.spec.name !== spec.name || observation.spec.mediaType !== spec.mediaType || observation.spec.byteLength !== spec.byteLength || observation.spec.sha256 !== spec.sha256 || !/^(0|[1-9][0-9]*)$/.test(observation.acceptedOffset) || BigInt(observation.acceptedOffset) > BigInt(spec.byteLength)) return fail('invalid', 'The upload receipt does not match its original specification.');
      const prior = upload.receipt;
      if (prior && (BigInt(observation.acceptedOffset) < BigInt(prior.acceptedOffset) || ['released', 'expired', 'failed'].includes(prior.state) && observation.state !== prior.state || prior.state === 'complete' && ['receiving', 'verifying'].includes(observation.state))) return upload;
      if (observation.state === 'complete') {
        const resource = observation.resource;
        if (!resource || resource.status !== 'available' || resource.sha256 !== spec.sha256 || resource.byteLength !== spec.byteLength || resource.mediaType !== spec.mediaType || observation.acceptedOffset !== spec.byteLength) return fail('invalid', 'The complete upload receipt does not identify the original bytes.');
      }
      const next: DraftUpload = { ...upload, receipt: observation, observedSequence: requestSequence, pendingAction: null, outcomeUnknown: false, storeVersion: increment(upload.storeVersion) };
      await tx.objectStore('uploads').put(next); if (next.releaseIntent) await this.collect(tx, owner); return next;
    });
  }
  async markUploadUnknown(handle: DraftHandle, uploadId: string, requestSequence: number): Promise<DraftUpload> {
    return this.transaction('readwrite', async (tx) => {
      const owner = await this.owner(tx, handle); const upload = await tx.objectStore('uploads').get([owner.ownerKey, uploadId]);
      if (!upload) return fail('invalid', 'The original upload is missing.');
      if (requestSequence !== upload.requestSequence || requestSequence <= upload.observedSequence) return upload;
      const next = { ...upload, outcomeUnknown: true, storeVersion: increment(upload.storeVersion) }; await tx.objectStore('uploads').put(next); return next;
    });
  }
  async requestRelease(handle: DraftHandle, uploadId: string): Promise<DraftUpload> {
    return this.transaction('readwrite', async (tx) => {
      const owner = await this.owner(tx, handle); const upload = await tx.objectStore('uploads').get([owner.ownerKey, uploadId]);
      if (!upload) return fail('invalid', 'The original upload is missing.');
      if (upload.releaseIntent) return upload;
      const next = { ...upload, releaseIntent: true, storeVersion: increment(upload.storeVersion) }; await tx.objectStore('uploads').put(next); return next;
    }, true);
  }
  async importLegacy(identity: DraftOwnerIdentity, input: LegacyDraftImport, admitted: () => boolean = () => true): Promise<{ readonly snapshot: DraftSnapshot; readonly imported: boolean; readonly legacySubmission?: DraftSubmission | null }> {
    const normalized = immutable({ ...identity, target: { ...identity.target, serverOrigin: canonicalDraftOrigin(identity.target.serverOrigin) } });
    const legacy = immutable(input); const key = draftOwnerKey(normalized);
    return this.transaction('readwrite', async (tx) => {
      await this.assertIdentityAvailable(tx, normalized);
      const existing = await this.readOwner(tx, key);
      if (existing) {
        const owner = await this.owner(tx, existing);
        let legacySubmission: DraftSubmission | null = null;
        if (legacy.submission) {
          const original = legacy.submission;
          const candidates = (await tx.objectStore('submissions').index('execution').getAll(owner.executionKey)).filter(candidate => candidate.operationId === original.operationId);
          for (const candidate of candidates) {
            const originalOwner = await this.readOwner(tx, candidate.ownerKey);
            if (!originalOwner || draftOwnerKey(originalOwner.identity) !== key || !sameDraftTarget(candidate.target, normalized.target) || !sameDraftFence(candidate.fence, normalized.target.fence) || candidate.kind !== (original.kind ?? 'send_message') || candidate.legacy?.revision !== original.revision) return fail('conflict', 'The legacy operation does not match its saved original identity.');
            legacySubmission = candidate;
          }
          if (!legacySubmission) {
            // This internal namespace never grants editable ownership. The real
            // target and original operation remain unchanged and query-only.
            const recoveryKey = JSON.stringify(['daynight-draft-legacy-operation', 1, key, original.operationId]);
            const recovery: DraftOwner = { ownerKey: recoveryKey, identity: normalized, executionKey: owner.executionKey, accountKey: owner.accountKey, accessEpoch: 1, storeVersion: 1, editableDraftId: null, unresolvedSubmissionId: original.operationId, recoveryOnly: true, blocked: 'recovery_only', cleanupPending: false, allocatedBytes: 0, legacyImported: true };
            legacySubmission = { ownerKey: recoveryKey, operationId: original.operationId, kind: original.kind ?? 'send_message', executionKey: owner.executionKey, target: normalized.target, fence: normalized.target.fence, draftId: crypto.randomUUID(), draftRevision: '1', command: null, snapshot: null, blobIds: [], uploadIds: [], state: 'unknown', lastOperation: null, legacy: { revision: original.revision, kind: original.kind ?? 'send_message' }, sensitiveCleared: true };
            await tx.objectStore('owners').add(recovery); await tx.objectStore('submissions').add(legacySubmission);
          }
        }
        return { snapshot: await this.snapshot(tx, owner), imported: false, legacySubmission };
      }
      if (this.revoked.has(key)) return fail('blocked', 'Draft access has been revoked.');
      const frozenLegacy = legacy.submission !== null && legacy.revision === legacy.submission.revision;
      const draft: DraftRecord = { ...newDraft(key), text: legacy.text, state: frozenLegacy ? 'frozen' : 'editable' };
      const owner: DraftOwner = { ownerKey: key, identity: normalized, executionKey: draftExecutionKey(normalized), accountKey: draftAccountKey(normalized), accessEpoch: 1, storeVersion: 1, editableDraftId: frozenLegacy ? null : draft.draftId, unresolvedSubmissionId: legacy.submission?.operationId ?? null, blocked: null, cleanupPending: false, allocatedBytes: 0, legacyImported: true };
      await tx.objectStore('owners').add(owner); await tx.objectStore('drafts').add(draft);
      if (legacy.submission) await tx.objectStore('submissions').add({ ownerKey: key, operationId: legacy.submission.operationId, kind: legacy.submission.kind ?? 'send_message', executionKey: owner.executionKey, target: normalized.target, fence: normalized.target.fence, draftId: frozenLegacy ? draft.draftId : crypto.randomUUID(), draftRevision: draft.revision, command: null, snapshot: frozenLegacy ? draft : null, blobIds: [], uploadIds: [], state: 'unknown', lastOperation: null, legacy: { revision: legacy.submission.revision, kind: legacy.submission.kind ?? 'send_message' }, sensitiveCleared: false });
      return { snapshot: await this.snapshot(tx, owner), imported: true };
    }, true, admitted);
  }
  async freeze(handle: DraftHandle, input: DraftFreeze): Promise<DraftSnapshot> {
    const frozenInput = immutable(input);
    return this.transaction('readwrite', async (tx) => {
      let owner = await this.owner(tx, handle);
      if (((await tx.objectStore('owners').index('execution').getAll(owner.executionKey)).filter(isOwner)).some((candidate) => candidate.unresolvedSubmissionId)) return fail('execution_blocked', 'An original submission still needs reconciliation.');
      const draft = await tx.objectStore('drafts').get([handle.ownerKey, frozenInput.draftId]);
      if (!draft || draft.state !== 'editable' || owner.editableDraftId !== draft.draftId || draft.storeVersion !== frozenInput.expectedStoreVersion) return fail('conflict', 'The draft changed before freezing.');
      if (draft.rejectedCandidates.length || draft.overflowRejectedCount || draft.items.some((item) => item.validation !== 'valid' || !item.blobId)) return fail('invalid', 'Every selected image must be saved and valid.');
      const command = frozenInput.command;
      if (!sameDraftFence(command, owner.identity.target.fence)) return fail('invalid', 'The command does not belong to this draft.');
      if (command.kind === 'execute_command') {
        const proof = frozenInput.commandDraft, parsed = /^\/([^\s]+)(?:\s([\s\S]*))?$/u.exec(draft.text.trimStart());
        if (draft.items.length || !proof || proof.text !== draft.text || !parsed || parsed[1] !== proof.commandName || (parsed[2] ?? '') !== command.payload.arguments) return fail('invalid', 'The command must consume the exact saved slash-command text.');
      } else if (command.kind === 'send_message') {
        if (draft.items.length && (!command.payload.target || !sameDraftTarget(command.payload.target, owner.identity.target) || command.payload.draftId !== draft.draftId || command.payload.draftRevision !== draft.revision)) return fail('invalid', 'The command does not identify this frozen image draft.');
        const imageParts = command.payload.content.filter((part) => part.type === 'image');
        if (imageParts.length !== draft.items.length) return fail('invalid', 'The command must contain the complete image set.');
        const text = command.payload.content.filter((part) => part.type === 'text').map((part) => part.text);
        if (draft.text.trim() ? text.length !== 1 || text[0] !== draft.text : text.length !== 0) return fail('invalid', 'The command text does not match the saved draft.');
        for (let i = 0; i < draft.items.length; i++) {
          const item = draft.items[i]!; const blob = await tx.objectStore('blobs').get([owner.ownerKey, item.blobId!]);
          if (!blob) return fail('bytes_missing', 'Original image bytes are missing.');
          if (!isValidatedDraftBlob(blob) || blob.byteRevision !== item.byteRevision || blob.byteLength !== blob.blob.size) return fail('bytes_invalid', 'Original image bytes changed.');
          const upload = item.uploadId ? await tx.objectStore('uploads').get([owner.ownerKey, item.uploadId]) : undefined; const part = imageParts[i]!;
          if (!upload || upload.releaseIntent || upload.outcomeUnknown || upload.pendingAction || upload.receipt?.state !== 'complete' || !sameDraftTarget(upload.spec.target, owner.identity.target) || part.imageId !== item.imageId || part.uploadId !== upload.uploadId || part.resourceId !== upload.receipt.resource?.resourceId || part.sha256 !== blob.sha256 || part.byteLength !== String(blob.byteLength)) return fail('invalid', 'An image upload is not ready for this exact submission.');
        }
      } else return fail('invalid', 'Only message and command input can freeze a draft.');
      const snapshot: DraftRecord = { ...draft, state: 'frozen', storeVersion: increment(draft.storeVersion) };
      const submission: DraftSubmission = { ownerKey: owner.ownerKey, operationId: command.operationId, kind: command.kind, executionKey: owner.executionKey, target: owner.identity.target, fence: owner.identity.target.fence, draftId: draft.draftId, draftRevision: draft.revision, command, snapshot, blobIds: draft.items.flatMap((item) => item.blobId ? [item.blobId] : []), uploadIds: draft.items.flatMap((item) => item.uploadId ? [item.uploadId] : []), state: 'prepared', lastOperation: null, legacy: null, sensitiveCleared: false };
      await tx.objectStore('submissions').add(submission); await tx.objectStore('drafts').put(snapshot);
      owner = { ...owner, editableDraftId: null, unresolvedSubmissionId: command.operationId, storeVersion: increment(owner.storeVersion) }; owner = await this.collect(tx, owner); return this.snapshot(tx, owner);
    }, true);
  }
  async claimDispatch(handle: DraftHandle, operationId: string): Promise<DraftDispatchClaim | null> {
    const generation = this.claimGeneration;
    const submission = await this.transaction('readwrite', async (tx) => {
      const owner = await this.owner(tx, handle); const current = await tx.objectStore('submissions').get([owner.ownerKey, operationId]);
      if (!current || owner.unresolvedSubmissionId !== operationId || current.state !== 'prepared' || !current.command) return null;
      const claimed: DraftSubmission = { ...current, state: 'dispatch_claimed' }; await tx.objectStore('submissions').put(claimed); return claimed;
    }, true);
    // Only the successful transaction caller receives this non-persisted authority.
    if (!submission || generation !== this.claimGeneration) return null;
    const authority = Object.freeze({}) as DraftDispatchAuthority;
    this.dispatchAuthorities.set(authority, { ownerKey: handle.ownerKey, accessEpoch: handle.accessEpoch, operationId });
    return { submission, authority };
  }
  async refusePrepared(handle: DraftHandle, operationId: string): Promise<DraftSnapshot> {
    return this.transaction('readwrite', async (tx) => {
      const owner = await this.recoveryOwner(tx, handle, 'cancel', operationId); const submission = await tx.objectStore('submissions').get([owner.ownerKey, operationId]);
      if (!submission || owner.unresolvedSubmissionId !== operationId || submission.state !== 'prepared') return this.snapshot(tx, owner);
      return this.settleInTransaction(tx, owner, submission, 'local_not_dispatched');
    }, true);
  }
  async refuseClaimed(handle: DraftHandle, authority: DraftDispatchAuthority): Promise<DraftSnapshot> {
    const issued = this.dispatchAuthorities.get(authority);
    if (!issued || issued.ownerKey !== handle.ownerKey || issued.accessEpoch !== handle.accessEpoch) return fail('invalid', 'Only this dispatch winner can prove a local refusal.');
    const result = await this.transaction('readwrite', async (tx) => {
      const owner = await this.owner(tx, handle); const submission = await tx.objectStore('submissions').get([owner.ownerKey, issued.operationId]);
      if (this.dispatchAuthorities.get(authority) !== issued) return fail('invalid', 'The dispatch authority is no longer live.');
      if (!submission || owner.unresolvedSubmissionId !== issued.operationId || !['dispatch_claimed', 'unknown'].includes(submission.state) || submission.lastOperation && submission.lastOperation.state !== 'unknown') return fail('conflict', 'The original operation can no longer be refused locally.');
      return this.settleInTransaction(tx, owner, submission, 'local_not_dispatched');
    }, true);
    this.dispatchAuthorities.delete(authority); return result;
  }
  async startSuccessor(handle: DraftHandle, operationId: string): Promise<DraftSnapshot> {
    return this.transaction('readwrite', async (tx) => {
      let owner = await this.owner(tx, handle); const submission = await tx.objectStore('submissions').get([owner.ownerKey, operationId]);
      if (!submission || !pending(submission) || owner.unresolvedSubmissionId !== operationId || owner.editableDraftId) return fail('conflict', 'Only one successor draft is allowed.');
      const next = newDraft(owner.ownerKey); await tx.objectStore('drafts').add(next); owner = { ...owner, editableDraftId: next.draftId, storeVersion: increment(owner.storeVersion) }; await tx.objectStore('owners').put(owner); return this.snapshot(tx, owner);
    });
  }
  async settleSubmission(handle: DraftHandle, settlement: DraftSettlement): Promise<DraftSnapshot> {
    return this.transaction('readwrite', async (tx) => {
      const owner = await this.recoveryOwner(tx, handle, 'observe', settlement.operationId); const current = await tx.objectStore('submissions').get([owner.ownerKey, settlement.operationId]);
      if (!current) return fail('invalid', 'The original submission is missing.');
      const operation = settlement.operation;
      if (!operation || operation.operationId !== current.operationId || !sameDraftFence(operation, current.fence) || operation.kind !== current.kind) return fail('invalid', 'The operation does not match the original submission.');
      const states = settlement.outcome === 'accepted' ? ['provider_accepted', 'confirmed'] : settlement.outcome === 'rejected' ? ['rejected', 'failed', 'expired'] : [];
      if (!states.includes(operation.state)) return fail('invalid', 'Only a terminal original operation can settle a submission.');
      return this.settleInTransaction(tx, owner, current, settlement.outcome, operation);
    }, true);
  }
  private async settleInTransaction(tx: Tx, originalOwner: DraftOwner, current: DraftSubmission, outcome: 'accepted' | 'rejected' | 'local_not_dispatched', operation?: SessionOperation): Promise<DraftSnapshot> {
    let owner = originalOwner;
    if (current.state === 'accepted') return this.snapshot(tx, owner);
    if (owner.unresolvedSubmissionId !== current.operationId) return fail('conflict', 'The original submission is no longer active.');
    const draft = await tx.objectStore('drafts').get([owner.ownerKey, current.draftId]);
    if (draft && (draft.revision !== current.draftRevision || draft.state !== 'frozen' && draft.state !== 'detached')) return fail('conflict', 'The frozen draft no longer matches the original submission.');
    await tx.objectStore('submissions').put({ ...current, state: outcome, lastOperation: operation ?? current.lastOperation });
    if (outcome === 'accepted') {
      if (draft) { await this.releaseRemoved(tx, owner.ownerKey, draft, null); await tx.objectStore('drafts').delete([owner.ownerKey, draft.draftId]); }
      owner = { ...owner, unresolvedSubmissionId: null, storeVersion: increment(owner.storeVersion) };
      if (!owner.editableDraftId && !owner.recoveryOnly && owner.blocked !== 'recovery_only') { const next = newDraft(owner.ownerKey); await tx.objectStore('drafts').add(next); owner = { ...owner, editableDraftId: next.draftId }; }
    } else if (draft && !owner.editableDraftId) {
      await tx.objectStore('drafts').put({ ...draft, state: 'editable', storeVersion: increment(draft.storeVersion) }); owner = { ...owner, editableDraftId: draft.draftId, unresolvedSubmissionId: null, storeVersion: increment(owner.storeVersion) };
    } else if (draft) await tx.objectStore('drafts').put({ ...draft, state: 'detached', storeVersion: increment(draft.storeVersion) });
    else owner = { ...owner, unresolvedSubmissionId: null, storeVersion: increment(owner.storeVersion) };
    owner = await this.collect(tx, owner); return this.snapshot(tx, owner);
  }
  async observeSubmission(handle: DraftHandle, operationId: string, operation: SessionOperation): Promise<DraftSnapshot> {
    return this.transaction('readwrite', async (tx) => {
      const owner = await this.recoveryOwner(tx, handle, 'observe', operationId); const submission = await tx.objectStore('submissions').get([owner.ownerKey, operationId]);
      if (!submission || operation.operationId !== operationId || !sameDraftFence(submission.fence, operation) || operation.kind !== submission.kind) return fail('invalid', 'The operation does not match the original submission.');
      if (pending(submission)) await tx.objectStore('submissions').put({ ...submission, state: submission.state === 'prepared' ? 'prepared' : 'unknown', lastOperation: operation });
      return this.snapshot(tx, owner);
    });
  }
  async resolveFailure(handle: DraftHandle, operationId: string, choice: 'keep_current' | 'restore_failed', expectedChoiceRevision: string): Promise<DraftSnapshot> {
    return this.transaction('readwrite', async (tx) => {
      let owner = await this.owner(tx, handle); const submission = await tx.objectStore('submissions').get([owner.ownerKey, operationId]);
      if (!submission || pending(submission) || submission.state === 'accepted' || owner.unresolvedSubmissionId !== operationId || !owner.editableDraftId) return fail('conflict', 'No failed draft is waiting for a choice.');
      const failed = await tx.objectStore('drafts').get([owner.ownerKey, submission.draftId]); const current = await tx.objectStore('drafts').get([owner.ownerKey, owner.editableDraftId]);
      if (!failed || !current) return fail('invalid', 'A draft needed for the choice is missing.');
      if (draftRecoveryRef({ owner, submission, frozen: failed, editable: current })?.choiceRevision !== expectedChoiceRevision) return fail('conflict', 'The drafts changed after the failure choice was displayed.');
      const removed = choice === 'keep_current' ? failed : current; const kept = choice === 'keep_current' ? current : failed;
      await this.releaseRemoved(tx, owner.ownerKey, removed, null); await tx.objectStore('drafts').delete([owner.ownerKey, removed.draftId]);
      await tx.objectStore('drafts').put({ ...kept, state: 'editable', storeVersion: increment(kept.storeVersion) });
      owner = { ...owner, editableDraftId: kept.draftId, unresolvedSubmissionId: null, storeVersion: increment(owner.storeVersion) }; owner = await this.collect(tx, owner); return this.snapshot(tx, owner);
    }, true);
  }
  private async clearPrivateOwner(tx: Tx, owner: DraftOwner): Promise<DraftOwner> {
    for (const name of ['drafts', 'blobs', 'uploads'] as const) for (const key of await tx.objectStore(name).index('owner').getAllKeys(owner.ownerKey)) await tx.objectStore(name).delete(key);
    let unresolvedSubmissionId = owner.unresolvedSubmissionId;
    for (const submission of await tx.objectStore('submissions').index('owner').getAll(owner.ownerKey)) {
      if (owner.blocked !== 'deleted' && owner.recoveryOnly && owner.legacyImported && submission.legacy) {
        // Correlation contains no message content. Keep terminal identities so a
        // stale legacy key cannot recreate an already settled original operation.
        await tx.objectStore('submissions').put({ ...submission, command: null, snapshot: null, blobIds: [], uploadIds: [], lastOperation: null, sensitiveCleared: true });
        continue;
      }
      if (owner.blocked === 'deleted' || !pending(submission)) {
        await tx.objectStore('submissions').delete([owner.ownerKey, submission.operationId]);
        if (unresolvedSubmissionId === submission.operationId) unresolvedSubmissionId = null;
      } else await tx.objectStore('submissions').put({ ...submission, command: null, snapshot: null, blobIds: [], uploadIds: [], lastOperation: null, legacy: null, sensitiveCleared: true });
    }
    const next: DraftOwner = { ...owner, editableDraftId: null, unresolvedSubmissionId, allocatedBytes: 0, cleanupPending: false };
    await tx.objectStore('owners').put(next); return next;
  }
  async blockOwner(handle: DraftHandle, reason: CleanupScope['reason']): Promise<void> {
    this.revoked.add(handle.ownerKey);
    // The durable tombstone survives a later cleanup failure and prevents reopening private rows.
    const blocked = await this.transaction('readwrite', async (tx) => {
      const owner = await this.readOwner(tx, handle.ownerKey); if (!owner) return null;
      if (owner.accessEpoch !== handle.accessEpoch && !owner.blocked) return fail('blocked', 'A stale access epoch cannot revoke a renewed owner.');
      if (owner.blocked && owner.cleanupPending) return owner;
      const next: DraftOwner = { ...owner, accessEpoch: increment(owner.accessEpoch), storeVersion: increment(owner.storeVersion), blocked: reason, cleanupPending: true };
      await tx.objectStore('owners').put(next); return next;
    }, true);
    if (!blocked) return;
    await this.transaction('readwrite', async (tx) => {
      const owner = await this.readOwner(tx, handle.ownerKey);
      if (owner?.blocked && owner.accessEpoch === blocked.accessEpoch) await this.clearPrivateOwner(tx, owner);
    }, true);
  }
  private async blockScope(origin: string, actorUserId: string, sessionId: string | null, reason: CleanupScope['reason']): Promise<void> {
    const normalizedOrigin = canonicalDraftOrigin(origin);
    const key = sessionId === null ? accountMarkerKey(normalizedOrigin, actorUserId) : sessionMarkerKey(normalizedOrigin, actorUserId, sessionId);
    const accountKey = JSON.stringify(['daynight-draft-account', 1, normalizedOrigin, actorUserId]);
    pendingScopeCleanup.set(key, { origin: normalizedOrigin, actorUserId, sessionId, reason });
    const blocked = await this.transaction('readwrite', async (tx) => {
      const prior = await tx.objectStore('owners').get(key);
      const effectiveReason = prior && !isOwner(prior) && prior.reason === 'deleted' ? 'deleted' : reason;
      await tx.objectStore('owners').put({ kind: sessionId === null ? 'account_tombstone' : 'session_tombstone', ownerKey: key, accountKey, sessionId, reason: effectiveReason });
      const owners = (await tx.objectStore('owners').index('account').getAll(accountKey)).filter(isOwner).filter((owner) => sessionId === null || owner.identity.target.fence.sessionId === sessionId);
      const result: DraftOwner[] = [];
      for (const owner of owners) {
        this.revoked.add(owner.ownerKey);
        const next: DraftOwner = { ...owner, accessEpoch: increment(owner.accessEpoch), storeVersion: increment(owner.storeVersion), blocked: effectiveReason, cleanupPending: true };
        await tx.objectStore('owners').put(next); result.push(next);
      }
      return result;
    }, true);
    for (const observed of blocked) await this.transaction('readwrite', async (tx) => {
      const owner = await this.readOwner(tx, observed.ownerKey);
      if (owner?.blocked && owner.accessEpoch === observed.accessEpoch) await this.clearPrivateOwner(tx, owner);
    }, true);
    pendingScopeCleanup.delete(key);
  }
  async blockAccount(origin: string, actorUserId: string): Promise<void> { await this.blockScope(origin, actorUserId, null, 'account_changed'); }
  async blockSession(origin: string, actorUserId: string, sessionId: string): Promise<void> { await this.blockScope(origin, actorUserId, sessionId, 'deleted'); }
  async revokeSession(origin: string, actorUserId: string, sessionId: string): Promise<void> { await this.blockScope(origin, actorUserId, sessionId, 'revoked'); }
  async retryBlockedCleanup(origin: string, actorUserId: string): Promise<void> {
    const normalizedOrigin = canonicalDraftOrigin(origin);
    for (const scope of [...pendingScopeCleanup.values()]) if (scope.origin === normalizedOrigin && scope.actorUserId === actorUserId) await this.blockScope(scope.origin, scope.actorUserId, scope.sessionId, scope.reason);
    await this.transaction('readwrite', async (tx) => {
      const accountKey = JSON.stringify(['daynight-draft-account', 1, normalizedOrigin, actorUserId]);
      for (const owner of (await tx.objectStore('owners').index('account').getAll(accountKey)).filter(isOwner)) if (owner.blocked && owner.cleanupPending) await this.clearPrivateOwner(tx, owner);
    }, true);
  }
  async reauthorizeOwner(identity: DraftOwnerIdentity): Promise<DraftSnapshot> { return (await this.reconcileAuthorization(identity, true))!; }
  async reconcileAuthorizedOwner(identity: DraftOwnerIdentity, admitted: () => boolean = () => true): Promise<DraftSnapshot | null> { return this.reconcileAuthorization(identity, false, admitted); }
  private async reconcileAuthorization(identity: DraftOwnerIdentity, create: boolean, admitted: () => boolean = () => true): Promise<DraftSnapshot | null> {
    const normalized = immutable({ ...identity, target: { ...identity.target, serverOrigin: canonicalDraftOrigin(identity.target.serverOrigin) } });
    const key = draftOwnerKey(normalized); const renewed = new Set([key]);
    if (!admitted()) return fail('blocked', 'Draft authorization is no longer current.');
    await this.retryBlockedCleanup(normalized.target.serverOrigin, normalized.target.actorUserId);
    const result = await this.transaction('readwrite', async (tx) => {
      const target = normalized.target;
      const markerKey = sessionMarkerKey(target.serverOrigin, target.actorUserId, target.fence.sessionId);
      const marker = await tx.objectStore('owners').get(markerKey);
      if (marker && !isOwner(marker) && marker.reason === 'deleted') return fail('blocked', 'The original Session was deleted.');
      if (marker) await tx.objectStore('owners').delete(markerKey);
      let owner = await this.readOwner(tx, key);
      if (owner?.blocked === 'deleted' || owner?.blocked === 'recovery_only' || owner?.recoveryOnly) return fail('blocked', 'The original draft owner cannot regain editable access.');
      await tx.objectStore('owners').delete(accountMarkerKey(target.serverOrigin, target.actorUserId));
      // Current authorization permits only original-operation recovery for older owners.
      for (let peer of (await tx.objectStore('owners').index('account').getAll(draftAccountKey(normalized))).filter(isOwner)) {
        if (peer.ownerKey === key || !peer.blocked || peer.blocked === 'deleted' || !sameDraftRecoveryScope(peer.identity, normalized)) continue;
        if (peer.cleanupPending) peer = await this.clearPrivateOwner(tx, peer);
        const submission = peer.unresolvedSubmissionId ? await tx.objectStore('submissions').get([peer.ownerKey, peer.unresolvedSubmissionId]) : undefined;
        if (!submission?.sensitiveCleared || !['prepared', 'dispatch_claimed', 'unknown'].includes(submission.state)) continue;
        renewed.add(peer.ownerKey);
        if (peer.blocked === 'recovery_only' && peer.recoveryOnly) continue;
        await tx.objectStore('owners').put({ ...peer, recoveryOnly: true, blocked: 'recovery_only', accessEpoch: increment(peer.accessEpoch), storeVersion: increment(peer.storeVersion) });
      }
      if (owner && !owner.blocked) return this.snapshot(tx, owner);
      if (!owner && !create) return null;
      if (owner?.cleanupPending) owner = await this.clearPrivateOwner(tx, owner);
      const draft = newDraft(key); await tx.objectStore('drafts').add(draft);
      owner = owner
        ? { ...owner, blocked: null, cleanupPending: false, accessEpoch: increment(owner.accessEpoch), storeVersion: increment(owner.storeVersion), editableDraftId: draft.draftId }
        : { ownerKey: key, identity: normalized, executionKey: draftExecutionKey(normalized), accountKey: draftAccountKey(normalized), accessEpoch: 1, storeVersion: 1, editableDraftId: draft.draftId, unresolvedSubmissionId: null, blocked: null, cleanupPending: false, allocatedBytes: 0, legacyImported: false };
      await tx.objectStore('owners').put(owner); return this.snapshot(tx, owner);
    }, true, admitted);
    if (!admitted()) return fail('blocked', 'Draft authorization is no longer current.');
    for (const renewedKey of renewed) this.revoked.delete(renewedKey); return result;
  }
}

export async function clearImageDraftAccount(origin: string, actorUserId: string): Promise<void> {
  const store = new SessionDraftStore(); try { await store.blockAccount(origin, actorUserId); } finally { store.close(); }
}
export async function clearImageDraftSession(origin: string, actorUserId: string, sessionId: string): Promise<void> {
  const store = new SessionDraftStore(); try { await store.blockSession(origin, actorUserId, sessionId); } finally { store.close(); }
}

export async function revokeImageDraftSession(origin: string, actorUserId: string, sessionId: string): Promise<void> {
  const store = new SessionDraftStore(); try { await store.revokeSession(origin, actorUserId, sessionId); } finally { store.close(); }
}
export async function retryImageDraftCleanup(origin: string, actorUserId: string): Promise<void> {
  const store = new SessionDraftStore(); try { await store.retryBlockedCleanup(origin, actorUserId); } finally { store.close(); }
}
