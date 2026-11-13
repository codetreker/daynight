import { SESSION_DRAFT_DATABASE, SessionDraftStore, draftOwnerKey } from '../../src/features/task-agent-session/drafts/draft-store';
import { isValidatedDraftBlob } from '../../src/features/task-agent-session/drafts/draft-types';
import type { DraftBlob, DraftOwner, DraftOwnerIdentity, DraftRecord, DraftSubmission, DraftUpload } from '../../src/features/task-agent-session/drafts/draft-types';

const names = ['owners', 'drafts', 'blobs', 'uploads', 'submissions'] as const;
type Fault = 'abort' | 'quota';
type WriteEvidence = { readonly kind: Fault; readonly store: string; requestSucceeded: boolean; aborted: boolean; completed: boolean };
const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.addEventListener('success', () => resolve(request.result), { once: true });
  request.addEventListener('error', () => reject(request.error), { once: true });
});
const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.addEventListener('complete', () => resolve(), { once: true });
  transaction.addEventListener('abort', () => reject(transaction.error ?? new DOMException('Aborted', 'AbortError')), { once: true });
});

/** Observes native IndexedDB; faults target the production store's actual transactions. */
export function createDraftStorageProbe(identity: () => DraftOwnerIdentity) {
  let fault: Fault | null = null;
  const writes: WriteEvidence[] = [], originalPut = IDBObjectStore.prototype.put, originalAdd = IDBObjectStore.prototype.add;
  const originalClaimDispatch = SessionDraftStore.prototype.claimDispatch;
  let claimArrivals = 0, releaseClaim: (() => void) | null = null;
  const scopedIdentity = (actor?: string): DraftOwnerIdentity => {
    const current = identity(); return actor === undefined ? current : { ...current, target: { ...current.target, actorUserId: actor } };
  };
  const inspect = async <T>(operation: (store: SessionDraftStore) => Promise<T>): Promise<T> => {
    const store = new SessionDraftStore(); try { return await operation(store); } finally { store.close(); }
  };
  const intercept = (store: IDBObjectStore, original: IDBObjectStore['put'], args: Parameters<IDBObjectStore['put']>): IDBRequest<IDBValidKey> => {
    const value = args[0] as { ownerKey?: string } | null;
    if (!fault || store.transaction.db.name !== SESSION_DRAFT_DATABASE || store.name !== 'drafts' || value?.ownerKey !== draftOwnerKey(identity())) return original.apply(store, args);
    const transaction = store.transaction, evidence: WriteEvidence = { kind: fault, store: store.name, requestSucceeded: false, aborted: false, completed: false }; writes.push(evidence);
    transaction.addEventListener('abort', () => { evidence.aborted = true; }, { once: true });
    transaction.addEventListener('complete', () => { evidence.completed = true; }, { once: true });
    if (fault === 'quota') throw new DOMException('Injected storage quota failure', 'QuotaExceededError');
    const request = original.apply(store, args);
    request.addEventListener('success', () => { evidence.requestSucceeded = true; transaction.abort(); }, { once: true });
    return request;
  };
  const clearFault = () => { fault = null; IDBObjectStore.prototype.put = originalPut; IDBObjectStore.prototype.add = originalAdd; };
  return {
    /** Rebuild a controlled legacy fixture after its production clients have closed. */
    recreateLegacySchema: async (version: 1 | 2 | 3) => {
      const current = await requestResult(indexedDB.open(SESSION_DRAFT_DATABASE)), sourceVersion = current.version;
      const reading = current.transaction([...names], 'readonly'), readDone = transactionDone(reading);
      void readDone.catch(() => {});
      const rows = await Promise.all(names.map(name => requestResult(reading.objectStore(name).getAll())));
      await readDone; current.close();
      for (const draft of rows[1] as DraftRecord[]) for (const item of draft.items) delete (item as { incarnation?: string }).incarnation;
      for (const blob of rows[2] as DraftBlob[]) delete (blob as { originalId?: string }).originalId;
      for (const submission of rows[4] as DraftSubmission[]) for (const item of submission.snapshot?.items ?? []) delete (item as { incarnation?: string }).incarnation;
      await requestResult(indexedDB.deleteDatabase(SESSION_DRAFT_DATABASE));
      const opening = indexedDB.open(SESSION_DRAFT_DATABASE, version);
      opening.addEventListener('upgradeneeded', () => {
        const database = opening.result, owners = database.createObjectStore('owners', { keyPath: 'ownerKey' });
        owners.createIndex('execution', 'executionKey'); owners.createIndex('account', 'accountKey');
        for (const [name, id] of [['drafts', 'draftId'], ['blobs', 'blobId'], ['uploads', 'uploadId'], ['submissions', 'operationId']]) {
          const object = database.createObjectStore(name!, { keyPath: ['ownerKey', id!] }); object.createIndex('owner', 'ownerKey');
          if (name === 'submissions') object.createIndex('execution', 'executionKey');
        }
      }, { once: true });
      const legacy = await requestResult(opening);
      try {
        const writing = legacy.transaction([...names], 'readwrite'), written = transactionDone(writing);
        void written.catch(() => {});
        for (const [index, name] of names.entries()) for (const row of rows[index]!) writing.objectStore(name).put(row);
        await written;
        const inspecting = legacy.transaction([...names], 'readonly'), inspected = transactionDone(inspecting);
        void inspected.catch(() => {});
        const [drafts, blobs, uploads] = await Promise.all(['drafts', 'blobs', 'uploads'].map(name => requestResult(inspecting.objectStore(name).getAll())));
        await inspected;
        return { sourceVersion, version: legacy.version, drafts: drafts as DraftRecord[], uploads: uploads as DraftUpload[],
          blobs: await Promise.all((blobs as DraftBlob[]).map(async blob => ({ blobId: blob.blobId, byteLength: blob.blob.size, actualSha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('') }))) };
      } finally { legacy.close(); }
    },
    read: (actor?: string) => inspect(store => store.readExisting(scopedIdentity(actor))),
    readBlob: (blobId: string, actor?: string) => inspect(async store => { const saved = await store.readExisting(scopedIdentity(actor)); const blob = saved ? await store.readBlob(saved.owner, blobId) : null; return blob ? { blobId: blob.blobId, byteLength: blob.blob.size, sha256: isValidatedDraftBlob(blob) ? blob.sha256 : null } : null; }),
    inventory: async () => {
      const database = await requestResult(indexedDB.open(SESSION_DRAFT_DATABASE));
      try {
        const transaction = database.transaction([...names], 'readonly'), done = transactionDone(transaction);
        void done.catch(() => {});
        const [owners, drafts, blobs, uploads, submissions] = await Promise.all(names.map(name => requestResult(transaction.objectStore(name).getAll())));
        await done;
        return { owners: owners as DraftOwner[], drafts: drafts as DraftRecord[], uploads: uploads as DraftUpload[], submissions: submissions as DraftSubmission[],
          blobs: await Promise.all((blobs as DraftBlob[]).map(async value => ({ ownerKey: value.ownerKey, blobId: value.blobId, references: value.references, byteLength: value.blob.size, sha256: isValidatedDraftBlob(value) ? value.sha256 : null,
            actualSha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await value.blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('') }))) };
      } finally { database.close(); }
    },
    counts: async () => {
      await inspect(store => store.readExisting(identity()));
      const database = await requestResult(indexedDB.open(SESSION_DRAFT_DATABASE));
      try {
        const transaction = database.transaction([...names], 'readonly'), done = transactionDone(transaction), ownerKey = draftOwnerKey(identity());
        void done.catch(() => {});
        const values = await Promise.all(names.map(async name => {
          const keys = await requestResult(transaction.objectStore(name).getAllKeys());
          return [name, keys.filter(key => name === 'owners' ? key === ownerKey : Array.isArray(key) && key[0] === ownerKey).length] as const;
        }));
        await done; return Object.fromEntries(values) as Record<typeof names[number], number>;
      } finally { database.close(); }
    },
    removeBlob: async (blobId: string) => {
      const database = await requestResult(indexedDB.open(SESSION_DRAFT_DATABASE));
      try {
        const transaction = database.transaction('blobs', 'readwrite'), done = transactionDone(transaction);
        void done.catch(() => {});
        await requestResult(transaction.objectStore('blobs').delete([draftOwnerKey(identity()), blobId])); await done;
      } finally { database.close(); }
    },
    holdBeforeDispatchClaim: () => {
      if (releaseClaim) throw new Error('The dispatch claim barrier is already armed.');
      claimArrivals = 0;
      const held = new Promise<void>(resolve => { releaseClaim = resolve; });
      SessionDraftStore.prototype.claimDispatch = async function (this: SessionDraftStore, ...args) {
        if (args[0].ownerKey === draftOwnerKey(identity())) { claimArrivals++; await held; }
        return originalClaimDispatch.apply(this, args);
      };
    },
    dispatchClaimArrivals: () => claimArrivals,
    releaseDispatchClaim: () => { SessionDraftStore.prototype.claimDispatch = originalClaimDispatch; releaseClaim?.(); releaseClaim = null; },
    armFault: (kind: Fault) => {
      clearFault(); writes.length = 0; fault = kind;
      IDBObjectStore.prototype.put = function (...args) { return intercept(this, originalPut, args); };
      IDBObjectStore.prototype.add = function (...args) { return intercept(this, originalAdd, args); };
    },
    clearFault,
    writes: () => structuredClone(writes),
  };
}
