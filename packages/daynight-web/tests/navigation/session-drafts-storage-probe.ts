import { SESSION_DRAFT_DATABASE, SessionDraftStore, draftOwnerKey } from '../../src/features/task-agent-session/drafts/draft-store';
import type { DraftOwnerIdentity } from '../../src/features/task-agent-session/drafts/draft-types';

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
    read: (actor?: string) => inspect(store => store.readExisting(scopedIdentity(actor))),
    readBlob: (blobId: string, actor?: string) => inspect(async store => { const saved = await store.readExisting(scopedIdentity(actor)); const blob = saved ? await store.readBlob(saved.owner, blobId) : null; return blob ? { blobId: blob.blobId, byteLength: blob.blob.size, sha256: blob.sha256 } : null; }),
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
