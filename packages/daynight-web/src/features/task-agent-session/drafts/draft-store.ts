import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { ImageUploadReceipt, SessionOperation } from '../../../../../daynight/src/session/protocol';
import { canonicalDraftOrigin, draftAccountKey, draftExecutionKey, draftOwnerKey, sameDraftFence, sameDraftTarget } from './draft-store-identity';
import type { DraftBlob, DraftDispatchAuthority, DraftDispatchClaim, DraftFreeze, DraftHandle, DraftOwner, DraftOwnerIdentity, DraftRecord, DraftSettlement, DraftSnapshot, DraftStoreErrorCode, DraftSubmission, DraftUpload, DraftUploadAction, DraftWrite, LegacyDraftImport, NewDraftUpload } from './draft-types';
export { draftExecutionKey, draftOwnerKey } from './draft-store-identity';
export const SESSION_DRAFT_DATABASE = 'daynight-session-drafts';
export const SESSION_DRAFT_SCHEMA = 1;
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
        upgrade(db) {
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
  private async transaction<T>(mode: 'readonly' | 'readwrite', callback: (tx: Tx) => Promise<T>, strict = false): Promise<T> {
    const db = await this.database(); const tx = db.transaction(STORES, mode, strict ? { durability: 'strict' } : undefined) as Tx;
    // Observe done immediately: an aborted transaction can reject before its request does.
    const complete = tx.done; void complete.catch(() => {});
    try { const result = await callback(tx); await complete; return result; }
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
    if (!owner || owner.accessEpoch !== handle.accessEpoch || owner.blocked || this.revoked.has(handle.ownerKey)) return fail('blocked', 'Draft access is no longer current.');
    await this.assertIdentityAvailable(tx, owner.identity);
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
        return item;
      })); return { ...draft, items };
    };
    const executionOwners = (await tx.objectStore('owners').index('execution').getAll(owner.executionKey)).filter(isOwner);
    return { owner, editable: await load(owner.editableDraftId), frozen: await load(submission?.draftId ?? null), submission, uploads: await tx.objectStore('uploads').index('owner').getAll(owner.ownerKey), executionBlocked: executionOwners.some((item) => item.unresolvedSubmissionId !== null) };
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
        if (owner.blocked || owner.cleanupPending || this.revoked.has(owner.ownerKey) || !owner.unresolvedSubmissionId) continue;
        const submission = await tx.objectStore('submissions').get([owner.ownerKey, owner.unresolvedSubmissionId]);
        if (submission) results.push({ owner, submission });
      }
      return results;
    });
  }
  async read(handle: DraftHandle): Promise<DraftSnapshot> { return this.transaction('readonly', async (tx) => this.snapshot(tx, await this.owner(tx, handle))); }
  async readBlob(handle: DraftHandle, blobId: string): Promise<DraftBlob | null> { return this.transaction('readonly', async (tx) => { await this.owner(tx, handle); return await tx.objectStore('blobs').get([handle.ownerKey, blobId]) ?? null; }); }
  private async collect(tx: Tx, owner: DraftOwner): Promise<DraftOwner> {
    const references = new Map<string, string[]>();
    const refer = (id: string | null, reference: string) => { if (id) references.set(id, [...references.get(id) ?? [], reference]); };
    for (const draft of await tx.objectStore('drafts').index('owner').getAll(owner.ownerKey)) for (const item of draft.items) refer(item.blobId, `draft:${draft.draftId}:${item.draftImageId}`);
    for (const submission of await tx.objectStore('submissions').index('owner').getAll(owner.ownerKey)) if (pending(submission)) for (const id of submission.blobIds) refer(id, `submission:${submission.operationId}`);
    for (const upload of await tx.objectStore('uploads').index('owner').getAll(owner.ownerKey)) if (upload.releaseIntent && !['released', 'expired', 'failed'].includes(upload.receipt?.state ?? '')) refer(upload.blobId, `release:${upload.uploadId}`);
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
        if (blob.blob.size !== blob.byteLength || blob.byteLength <= 0 || blob.byteLength > 10 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(blob.sha256)) return fail('bytes_invalid', 'Image bytes do not match their metadata.');
        const existing = await tx.objectStore('blobs').get([handle.ownerKey, blob.blobId]);
        if (existing && (existing.sha256 !== blob.sha256 || existing.byteLength !== blob.byteLength || existing.byteRevision !== blob.byteRevision)) return fail('conflict', 'Original image bytes are immutable.');
        if (!existing) await tx.objectStore('blobs').add({ ...blob, ownerKey: handle.ownerKey, references: [] });
      }
      let imageBytes = 0;
      for (const item of input.items) if (item.blobId) { const blob = await tx.objectStore('blobs').get([handle.ownerKey, item.blobId]); if (blob) { if (blob.byteRevision !== item.byteRevision) return fail('bytes_invalid', 'Image byte revision changed.'); imageBytes += blob.byteLength; } }
      if (imageBytes > 20 * 1024 * 1024) return fail('quota', 'The draft exceeds the image message limit.');
      if (old.text === input.text && JSON.stringify(old.items) === JSON.stringify(input.items) && JSON.stringify(old.rejectedCandidates) === JSON.stringify(input.rejectedCandidates) && old.overflowRejectedCount === input.overflowRejectedCount) { owner = await this.collect(tx, owner); await this.budget(tx, owner); return this.snapshot(tx, owner); }
      const next: DraftRecord = { ...old, text: input.text, items: input.items, rejectedCandidates: input.rejectedCandidates, overflowRejectedCount: input.overflowRejectedCount, revision: revision(old.revision), storeVersion: increment(old.storeVersion), savedAt: Date.now() };
      await this.releaseRemoved(tx, owner.ownerKey, old, next); await tx.objectStore('drafts').put(next); owner = await this.collect(tx, owner); await this.budget(tx, owner); return this.snapshot(tx, owner);
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
      const draft = owner.editableDraftId ? await tx.objectStore('drafts').get([owner.ownerKey, owner.editableDraftId]) : undefined;
      const item = draft?.items.find((candidate) => candidate.draftImageId === value.draftImageId);
      const blob = await tx.objectStore('blobs').get([owner.ownerKey, value.blobId]);
      if (!draft || !item || item.byteRevision !== value.byteRevision || item.blobId !== value.blobId || item.imageId !== value.spec.imageId || item.label !== value.spec.name || !blob || item.validation !== 'valid' || value.spec.byteLength !== String(blob.byteLength) || value.spec.sha256 !== blob.sha256 || value.spec.mediaType !== blob.mediaType) return fail('conflict', 'The image changed before upload preparation.');
      if (item.uploadId) {
        const previous = await tx.objectStore('uploads').get([owner.ownerKey, item.uploadId]);
        if (previous && (previous.outcomeUnknown || previous.pendingAction || !['failed', 'expired', 'released'].includes(previous.receipt?.state ?? ''))) return fail('conflict', 'The original upload must be reconciled before replacement.');
      }
      const upload: DraftUpload = { ...value, ownerKey: owner.ownerKey, uploadId: value.spec.uploadId, storeVersion: 1, requestSequence: 0, observedSequence: 0, receipt: null, pendingAction: null, outcomeUnknown: false, releaseIntent: false };
      await tx.objectStore('uploads').add(upload);
      await tx.objectStore('drafts').put({ ...draft, storeVersion: increment(draft.storeVersion), items: draft.items.map((candidate) => candidate.draftImageId === item.draftImageId ? { ...candidate, uploadId: upload.uploadId } : candidate) });
      return upload;
    });
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
  async importLegacy(identity: DraftOwnerIdentity, input: LegacyDraftImport): Promise<{ readonly snapshot: DraftSnapshot; readonly imported: boolean }> {
    const normalized = immutable({ ...identity, target: { ...identity.target, serverOrigin: canonicalDraftOrigin(identity.target.serverOrigin) } });
    const legacy = immutable(input); const key = draftOwnerKey(normalized);
    return this.transaction('readwrite', async (tx) => {
      await this.assertIdentityAvailable(tx, normalized);
      const existing = await this.readOwner(tx, key);
      if (existing) return { snapshot: await this.snapshot(tx, await this.owner(tx, existing)), imported: false };
      if (this.revoked.has(key)) return fail('blocked', 'Draft access has been revoked.');
      const frozenLegacy = legacy.submission !== null && legacy.revision === legacy.submission.revision;
      const draft: DraftRecord = { ...newDraft(key), text: legacy.text, state: frozenLegacy ? 'frozen' : 'editable' };
      const owner: DraftOwner = { ownerKey: key, identity: normalized, executionKey: draftExecutionKey(normalized), accountKey: draftAccountKey(normalized), accessEpoch: 1, storeVersion: 1, editableDraftId: frozenLegacy ? null : draft.draftId, unresolvedSubmissionId: legacy.submission?.operationId ?? null, blocked: null, cleanupPending: false, allocatedBytes: 0, legacyImported: true };
      await tx.objectStore('owners').add(owner); await tx.objectStore('drafts').add(draft);
      if (legacy.submission) await tx.objectStore('submissions').add({ ownerKey: key, operationId: legacy.submission.operationId, kind: legacy.submission.kind ?? 'send_message', executionKey: owner.executionKey, target: normalized.target, fence: normalized.target.fence, draftId: frozenLegacy ? draft.draftId : crypto.randomUUID(), draftRevision: draft.revision, command: null, snapshot: frozenLegacy ? draft : null, blobIds: [], uploadIds: [], state: 'unknown', lastOperation: null, legacy: { revision: legacy.submission.revision, kind: legacy.submission.kind ?? 'send_message' }, sensitiveCleared: false });
      return { snapshot: await this.snapshot(tx, owner), imported: true };
    }, true);
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
      if (command.kind !== 'send_message' || !sameDraftFence(command, owner.identity.target.fence)) return fail('invalid', 'The command does not belong to this draft.');
      if (draft.items.length && (!command.payload.target || !sameDraftTarget(command.payload.target, owner.identity.target) || command.payload.draftId !== draft.draftId || command.payload.draftRevision !== draft.revision)) return fail('invalid', 'The command does not identify this frozen image draft.');
      const imageParts = command.payload.content.filter((part) => part.type === 'image');
      if (imageParts.length !== draft.items.length) return fail('invalid', 'The command must contain the complete image set.');
      const text = command.payload.content.filter((part) => part.type === 'text').map((part) => part.text);
      if (draft.text.trim() ? text.length !== 1 || text[0] !== draft.text : text.length !== 0) return fail('invalid', 'The command text does not match the saved draft.');
      for (let i = 0; i < draft.items.length; i++) {
        const item = draft.items[i]!; const blob = await tx.objectStore('blobs').get([owner.ownerKey, item.blobId!]);
        if (!blob) return fail('bytes_missing', 'Original image bytes are missing.');
        if (blob.byteRevision !== item.byteRevision || blob.byteLength !== blob.blob.size) return fail('bytes_invalid', 'Original image bytes changed.');
        const upload = item.uploadId ? await tx.objectStore('uploads').get([owner.ownerKey, item.uploadId]) : undefined; const part = imageParts[i]!;
        if (!upload || upload.releaseIntent || upload.outcomeUnknown || upload.pendingAction || upload.receipt?.state !== 'complete' || !sameDraftTarget(upload.spec.target, owner.identity.target) || part.imageId !== item.imageId || part.uploadId !== upload.uploadId || part.resourceId !== upload.receipt.resource?.resourceId || part.sha256 !== blob.sha256 || part.byteLength !== String(blob.byteLength)) return fail('invalid', 'An image upload is not ready for this exact submission.');
      }
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
      const owner = await this.owner(tx, handle); const submission = await tx.objectStore('submissions').get([owner.ownerKey, operationId]);
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
      const owner = await this.owner(tx, handle); const current = await tx.objectStore('submissions').get([owner.ownerKey, settlement.operationId]);
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
      if (!owner.editableDraftId) { const next = newDraft(owner.ownerKey); await tx.objectStore('drafts').add(next); owner = { ...owner, editableDraftId: next.draftId }; }
    } else if (draft && !owner.editableDraftId) {
      await tx.objectStore('drafts').put({ ...draft, state: 'editable', storeVersion: increment(draft.storeVersion) }); owner = { ...owner, editableDraftId: draft.draftId, unresolvedSubmissionId: null, storeVersion: increment(owner.storeVersion) };
    } else if (draft) await tx.objectStore('drafts').put({ ...draft, state: 'detached', storeVersion: increment(draft.storeVersion) });
    else owner = { ...owner, unresolvedSubmissionId: null, storeVersion: increment(owner.storeVersion) };
    owner = await this.collect(tx, owner); return this.snapshot(tx, owner);
  }
  async observeSubmission(handle: DraftHandle, operationId: string, operation: SessionOperation): Promise<DraftSnapshot> {
    return this.transaction('readwrite', async (tx) => {
      const owner = await this.owner(tx, handle); const submission = await tx.objectStore('submissions').get([owner.ownerKey, operationId]);
      if (!submission || operation.operationId !== operationId || !sameDraftFence(submission.fence, operation) || operation.kind !== submission.kind) return fail('invalid', 'The operation does not match the original submission.');
      if (pending(submission)) await tx.objectStore('submissions').put({ ...submission, state: submission.state === 'prepared' ? 'prepared' : 'unknown', lastOperation: operation });
      return this.snapshot(tx, owner);
    });
  }
  async resolveFailure(handle: DraftHandle, operationId: string, choice: 'keep_current' | 'restore_failed'): Promise<DraftSnapshot> {
    return this.transaction('readwrite', async (tx) => {
      let owner = await this.owner(tx, handle); const submission = await tx.objectStore('submissions').get([owner.ownerKey, operationId]);
      if (!submission || pending(submission) || submission.state === 'accepted' || owner.unresolvedSubmissionId !== operationId || !owner.editableDraftId) return fail('conflict', 'No failed draft is waiting for a choice.');
      const failed = await tx.objectStore('drafts').get([owner.ownerKey, submission.draftId]); const current = await tx.objectStore('drafts').get([owner.ownerKey, owner.editableDraftId]);
      if (!failed || !current) return fail('invalid', 'A draft needed for the choice is missing.');
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
      if (owner.blocked === 'deleted' || !pending(submission)) {
        await tx.objectStore('submissions').delete([owner.ownerKey, submission.operationId]);
        if (unresolvedSubmissionId === submission.operationId) unresolvedSubmissionId = null;
      } else await tx.objectStore('submissions').put({ ...submission, command: null, snapshot: null, blobIds: [], uploadIds: [], lastOperation: null, legacy: null, sensitiveCleared: true });
    }
    const next: DraftOwner = { ...owner, editableDraftId: null, unresolvedSubmissionId, allocatedBytes: 0, cleanupPending: false };
    await tx.objectStore('owners').put(next); return next;
  }
  async blockOwner(handle: DraftHandle, reason: NonNullable<DraftOwner['blocked']>): Promise<void> {
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
  async reauthorizeOwner(identity: DraftOwnerIdentity): Promise<DraftSnapshot> {
    const normalized = immutable({ ...identity, target: { ...identity.target, serverOrigin: canonicalDraftOrigin(identity.target.serverOrigin) } });
    const key = draftOwnerKey(normalized); const renewed = new Set([key]);
    await this.retryBlockedCleanup(normalized.target.serverOrigin, normalized.target.actorUserId);
    const result = await this.transaction('readwrite', async (tx) => {
      const target = normalized.target;
      const markerKey = sessionMarkerKey(target.serverOrigin, target.actorUserId, target.fence.sessionId);
      const marker = await tx.objectStore('owners').get(markerKey);
      if (marker && !isOwner(marker) && marker.reason === 'deleted') return fail('blocked', 'The original Session was deleted.');
      if (marker) await tx.objectStore('owners').delete(markerKey);
      let owner = await this.readOwner(tx, key);
      if (owner?.blocked === 'deleted') return fail('blocked', 'The original draft owner is unavailable.');
      await tx.objectStore('owners').delete(accountMarkerKey(target.serverOrigin, target.actorUserId));
      // Authorization for this exact execution also permits querying its old native target.
      for (let peer of (await tx.objectStore('owners').index('execution').getAll(draftExecutionKey(normalized))).filter(isOwner)) {
        if (peer.ownerKey === key || !peer.blocked || peer.blocked === 'deleted') continue;
        if (peer.cleanupPending) peer = await this.clearPrivateOwner(tx, peer);
        await tx.objectStore('owners').put({ ...peer, blocked: null, accessEpoch: increment(peer.accessEpoch), storeVersion: increment(peer.storeVersion) }); renewed.add(peer.ownerKey);
      }
      if (owner && !owner.blocked) return this.snapshot(tx, owner);
      if (owner?.cleanupPending) owner = await this.clearPrivateOwner(tx, owner);
      const draft = newDraft(key); await tx.objectStore('drafts').add(draft);
      owner = owner
        ? { ...owner, blocked: null, cleanupPending: false, accessEpoch: increment(owner.accessEpoch), storeVersion: increment(owner.storeVersion), editableDraftId: draft.draftId }
        : { ownerKey: key, identity: normalized, executionKey: draftExecutionKey(normalized), accountKey: draftAccountKey(normalized), accessEpoch: 1, storeVersion: 1, editableDraftId: draft.draftId, unresolvedSubmissionId: null, blocked: null, cleanupPending: false, allocatedBytes: 0, legacyImported: false };
      await tx.objectStore('owners').put(owner); return this.snapshot(tx, owner);
    }, true);
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
