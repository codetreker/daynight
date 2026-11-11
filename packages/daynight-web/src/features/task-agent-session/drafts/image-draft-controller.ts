import { SESSION_PROTOCOL, type ImageCapabilities, type ImageTarget, type SessionCommand, type SessionFence, type SessionOperation } from '../../../../../daynight/src/session/protocol';
import type { SessionResourceClient } from '../../../../../daynight/src/session/resource-client';
import type { LocalImageAssetAdapter, LocalImageMetadata } from '../images/image-store';
import { DraftStoreError, SessionDraftStore, draftOwnerKey } from './draft-store';
import type { DraftBlobInput, DraftImageItem, DraftOwner, DraftOwnerIdentity, DraftRecord, DraftSnapshot, DraftSubmission, LegacyDraftImport } from './draft-types';
import { DraftSender } from './draft-send';
import { DraftUploader } from './draft-uploads';
import { imageSetIssue, safeImageLabel, sameImageTarget } from './draft-validation';

export type ImageDraftContext = {
  readonly identity: DraftOwnerIdentity;
  readonly target: ImageTarget;
  readonly resources: SessionResourceClient;
  readonly capabilities: ImageCapabilities | null;
  readonly active: boolean;
  readonly canEdit: boolean;
  readonly canSend: boolean;
  readonly mode: 'send' | 'steer';
  readonly expectedTurnId: string | null;
  readonly authorizationGeneration: string;
};
export type ImageDraftItemView = DraftImageItem & { readonly asset: LocalImageAssetAdapter | null; readonly progress: number; readonly status: string; readonly canRetryPrepare: boolean };
export type ImageDraftView = {
  readonly active: boolean; readonly loading: boolean; readonly text: string; readonly revision: string; readonly draftId: string | null;
  readonly items: readonly ImageDraftItemView[]; readonly frozenItems: readonly ImageDraftItemView[];
  readonly rejectedCandidates: readonly { readonly id: string; readonly label: string; readonly error: string }[];
  readonly overflowRejectedCount: number; readonly saving: boolean; readonly error: string | null; readonly conflict: boolean;
  readonly frozen: boolean; readonly readOnly: boolean; readonly failureChoice: boolean; readonly submission: DraftSubmission | null;
  readonly canSend: boolean; readonly canResumePrepared: boolean; readonly canCancelPrepared: boolean; readonly disabledReason: string | null; readonly checking: boolean;
};
export type ImageDraftOptions = {
  readonly getContext: () => ImageDraftContext | null;
  readonly dispatch: (command: SessionCommand) => Promise<SessionOperation>;
  readonly query: (fence: SessionFence, operationId: string, signal?: AbortSignal) => Promise<SessionOperation>;
  readonly createAsset: (blob: Blob, draftImageId: string, byteRevision: string, metadata?: LocalImageMetadata) => LocalImageAssetAdapter;
  readonly isDefinitiveNotDispatched?: (error: unknown) => boolean;
  readonly store?: SessionDraftStore; readonly locks?: LockManager | null;
  readonly legacy?: () => (LegacyDraftImport & { readonly onImported: () => void }) | null;
};
const emptyView = (): ImageDraftView => ({ active: false, loading: false, text: '', revision: '1', draftId: null, items: [], frozenItems: [], rejectedCandidates: [], overflowRejectedCount: 0, saving: false, error: null, conflict: false, frozen: false, readOnly: false, failureChoice: false, submission: null, canSend: false, canResumePrepared: false, canCancelPrepared: false, disabledReason: null, checking: false });
const message = (error: unknown): string => {
  if (error instanceof DraftStoreError) return `image_draft_${error.code}`;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error && /^image_[a-z_]+$/.test(error.message) ? error.message : 'image_draft_failed';
};
const itemKey = (item: Pick<DraftImageItem, 'draftImageId' | 'byteRevision'>): string => JSON.stringify([item.draftImageId, item.byteRevision]);
const sameProfile = (a: ImageCapabilities | null, b: ImageCapabilities | null): boolean => !!a && !!b && a.expectedNativeSessionId === b.expectedNativeSessionId && a.modelId === b.modelId && a.controlsRevision === b.controlsRevision;
type PendingDraftWrite = { readonly owner: DraftOwner; readonly base: DraftRecord; readonly draft: DraftRecord; readonly blobs: readonly DraftBlobInput[]; readonly preceding: Promise<void> };

/** One durable image draft owner inside the existing Session client. */
export class ImageDraftController {
  private readonly store: SessionDraftStore;
  private readonly locks: LockManager | null;
  private readonly listeners = new Set<() => void>();
  private view = emptyView();
  private saved: DraftSnapshot | null = null;
  private local: DraftRecord | null = null;
  private scopeKey: string | null = null;
  private authGeneration: string | null = null;
  private epoch = 0;
  private lifetime = new AbortController();
  private network = new AbortController();
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly background = new Set<Promise<void>>();
  private readonly contentCommits = new Map<string, DraftRecord>();
  private readonly retiringDrafts = new Map<string, PendingDraftWrite>();
  private loading: Promise<void> | null = null;
  private loadingEpoch: number | null = null;
  private restoreComplete = false;
  private loadFailed = false;
  private activating: Promise<void> | null = null;
  private pendingLegacy: (LegacyDraftImport & { readonly onImported: () => void }) | null = null;
  private writes: Promise<void> = Promise.resolve();
  private validations: Promise<void> = Promise.resolve();
  private writeVersion = 0;
  private dirty = false;
  private error: string | null = null;
  private conflict = false;
  private checking = false;
  private freezing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private observeTimer: ReturnType<typeof setTimeout> | null = null;
  private observeStarted = 0;
  private observeAttempt = 0;
  private fingerprint = '';
  private readonly blobs = new Map<string, DraftBlobInput>();
  private readonly assets = new Map<string, LocalImageAssetAdapter>();
  private readonly pendingFiles = new Map<string, { readonly item: DraftImageItem; readonly file: File }>();
  private validationPaused = false;
  private readonly uploadFlights = new Map<string, Promise<void>>();
  private originals: readonly { readonly owner: DraftOwner; readonly submission: DraftSubmission }[] = [];
  private freshCapability: ImageCapabilities | null = null;
  private capabilityBaseRevision: string | null = null;
  private channel: BroadcastChannel | null = null;
  private readonly onFocus = () => { void this.backgroundWork(this.refresh()); };
  private readonly onVisibility = () => {
    if (!this.networkAllowed()) { this.network.abort(); this.stopObserving(); this.publish(); return; }
    if (this.network.signal.aborted) this.network = new AbortController();
    this.onFocus();
  };

  constructor(private readonly options: ImageDraftOptions) {
    this.store = options.store ?? new SessionDraftStore();
    this.locks = options.locks === undefined ? globalThis.navigator?.locks ?? null : options.locks;
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.onFocus);
      document.addEventListener('visibilitychange', this.onVisibility);
      if (typeof window.BroadcastChannel === 'function') {
        this.channel = new BroadcastChannel('daynight-session-drafts');
        this.channel.onmessage = event => { if (event.data?.ownerKey === this.scopeKey) this.onFocus(); };
      }
    }
  }
  getSnapshot = (): ImageDraftView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private networkAllowed(): boolean { const context = this.options.getContext(); return !this.closed && !!context?.active && context.canEdit && (typeof document === 'undefined' || !document.hidden); }
  private backgroundWork(work: Promise<void>, epoch = this.epoch): Promise<void> {
    const observed = work.catch(error => { if (this.current(epoch)) this.fail(error); });
    this.background.add(observed);
    void observed.then(() => this.background.delete(observed), () => this.background.delete(observed));
    return observed;
  }
  private current(epoch: number): boolean {
    const c = this.options.getContext();
    return !this.closed && this.epoch === epoch && !!c && draftOwnerKey(c.identity) === this.scopeKey && c.authorizationGeneration === this.authGeneration;
  }
  private context(): ImageDraftContext {
    const context = this.options.getContext();
    if (!context || !context.canEdit || !this.current(this.epoch)) throw new Error('image_access_unavailable');
    return context;
  }
  private sameActionOwner(original: ImageDraftContext): boolean {
    const current = this.options.getContext();
    return !this.closed && !!current?.canEdit && draftOwnerKey(original.identity) === draftOwnerKey(current.identity) && original.authorizationGeneration === current.authorizationGeneration;
  }
  private capability(context: ImageDraftContext): ImageCapabilities | null { return this.capabilityBaseRevision === context.capabilities?.revision && sameProfile(this.freshCapability, context.capabilities) ? this.freshCapability : context.capabilities; }
  private fail(error: unknown): void { if (this.closed) return; this.error = message(error); if (error instanceof DraftStoreError && error.code === 'conflict') this.conflict = true; this.publish(); }
  private items(draft: DraftRecord | null): readonly ImageDraftItemView[] {
    return draft?.items.map(item => {
      const upload = this.saved?.uploads.find(upload => upload.uploadId === item.uploadId), receipt = upload?.receipt;
      return { ...item, asset: this.assets.get(itemKey(item)) ?? null, progress: receipt ? Math.min(1, Number(receipt.acceptedOffset) / Number(upload!.spec.byteLength)) : 0,
        status: upload?.outcomeUnknown ? 'unknown' : receipt?.state ?? item.validation,
        canRetryPrepare: !!upload?.outcomeUnknown && upload.pendingAction?.kind === 'prepare' && !receipt && this.canPrepare(),
        error: item.error ?? receipt?.error?.message ?? (upload?.outcomeUnknown ? 'image_upload_unknown' : null) };
    }) ?? [];
  }
  private gate(snapshot: DraftSnapshot | null, prepared?: DraftSubmission): string | null {
    const c = this.options.getContext(), draft = prepared?.snapshot ?? this.local ?? snapshot?.editable;
    if (!c || !this.networkAllowed() || !c.canSend || !this.current(this.epoch)) return 'image_session_unavailable';
    if (!snapshot || !draft || this.loading || this.loadFailed || this.dirty || this.conflict) return 'image_draft_unsaved';
    if (!prepared && (snapshot.editable?.draftId !== this.local?.draftId || snapshot.editable?.storeVersion !== this.local?.storeVersion)) return 'image_draft_conflict';
    if (!prepared && (snapshot.executionBlocked || snapshot.submission || this.originals.length)) return 'image_submission_pending';
    if (draft.rejectedCandidates.length || draft.overflowRejectedCount) return 'image_rejected_candidates';
    if (!draft.items.length) return draft.text.trim() ? null : 'image_draft_empty';
    if (!this.locks) return 'image_locks_unavailable';
    if (draft.items.some(item => item.validation !== 'valid' || !item.blobId || !this.blobs.has(item.blobId))) return 'image_validation_incomplete';
    const metadata = draft.items.map(item => this.blobs.get(item.blobId!)!);
    const capability = this.capability(c), issue = imageSetIssue(metadata, capability, c.target, c.mode);
    if (issue) return issue;
    if (prepared?.command?.kind === 'send_message' && (prepared.command.payload.expectedImageCapabilityRevision !== capability?.revision || prepared.command.payload.expectedTurnId !== c.expectedTurnId || !sameImageTarget(prepared.target, c.target))) return 'image_capability_changed';
    if (draft.items.some(item => {
      const upload = snapshot.uploads.find(upload => upload.uploadId === item.uploadId);
      return !upload || upload.outcomeUnknown || upload.pendingAction || upload.releaseIntent || upload.receipt?.state !== 'complete' || !sameImageTarget(upload.spec.target, c.target);
    })) return 'image_upload_incomplete';
    return null;
  }
  private publish(): void {
    if (this.closed) return;
    if (!this.options.getContext()) {
      if (this.view.active || this.view.loading) { this.view = emptyView(); for (const listener of this.listeners) listener(); }
      return;
    }
    const draft = this.local ?? this.saved?.frozen ?? null, submission = this.saved?.submission ?? this.originals[0]?.submission ?? null;
    const readOnly = !!this.loading || this.freezing || (!!this.saved || this.view.active) && !this.local || !this.options.getContext()?.canEdit;
    const next: ImageDraftView = { active: !!this.saved || this.view.active, loading: !!this.loading, text: draft?.text ?? this.view.text, revision: draft?.revision ?? '1', draftId: draft?.draftId ?? null,
      items: this.items(draft), frozenItems: this.items(this.saved?.frozen ?? null), rejectedCandidates: draft?.rejectedCandidates.map(item => ({ id: item.candidateId, label: item.label, error: item.reason })) ?? [], overflowRejectedCount: draft?.overflowRejectedCount ?? 0,
      saving: this.dirty && !this.error, error: this.error, conflict: this.conflict, frozen: !!this.saved?.frozen && !this.local, readOnly,
      failureChoice: !!this.saved?.frozen && !!this.saved.editable && (this.saved.submission?.state === 'rejected' || this.saved.submission?.state === 'local_not_dispatched'), submission,
      canSend: this.gate(this.saved) === null, canResumePrepared: this.saved?.submission?.state === 'prepared' && !this.loading && !!this.options.getContext()?.active && !!this.options.getContext()?.canSend && !this.dirty && !this.conflict,
      canCancelPrepared: this.originals.some(entry => entry.submission.state === 'prepared') && this.networkAllowed(),
      disabledReason: this.gate(this.saved), checking: this.checking };
    const comparable = (value: ImageDraftView) => JSON.stringify({ ...value, items: value.items.map(({ asset, ...item }) => ({ ...item, asset: asset?.key })), frozenItems: value.frozenItems.map(({ asset, ...item }) => ({ ...item, asset: asset?.key })) });
    if (comparable(this.view) === comparable(next)) return;
    this.view = Object.freeze(next); for (const listener of this.listeners) listener();
  }
  private adopt(snapshot: DraftSnapshot): void {
    this.saved = snapshot;
    if (!this.dirty) this.local = snapshot.editable;
    else if (this.local && snapshot.editable?.draftId === this.local.draftId) this.local = { ...this.local, storeVersion: snapshot.editable.storeVersion, revision: snapshot.editable.revision, items: this.local.items.map(item => ({ ...item, uploadId: snapshot.editable!.items.find(saved => saved.draftImageId === item.draftImageId)?.uploadId ?? item.uploadId })) };
    const retained = new Set([...(snapshot.editable?.items ?? []), ...(snapshot.frozen?.items ?? []), ...(this.local?.items ?? [])].map(itemKey));
    for (const [key, asset] of this.assets) if (!retained.has(key)) { asset.release(); this.assets.delete(key); }
    for (const key of this.pendingFiles.keys()) if (!retained.has(key)) this.pendingFiles.delete(key);
    const referencedBlobs = new Set([...(snapshot.editable?.items ?? []), ...(snapshot.frozen?.items ?? []), ...(this.local?.items ?? [])].map(item => item.blobId));
    for (const key of this.blobs.keys()) if (!referencedBlobs.has(key)) this.blobs.delete(key);
    this.publish();
  }
  private clearAssets(): void { for (const asset of this.assets.values()) asset.release(); this.assets.clear(); this.blobs.clear(); this.pendingFiles.clear(); this.validationPaused = false; }
  private validationInterrupted(error: unknown): boolean {
    return !this.options.getContext()?.canEdit || error instanceof Error && error.name === 'AbortError' || !!error && typeof error === 'object' && 'code' in error && ['access_pending', 'access_revoked'].includes(String(error.code));
  }
  /** Capture only content whose local write admission was already established. */
  private capturePendingWrite(): PendingDraftWrite | null {
    const context = this.options.getContext(), base = this.saved?.editable;
    if (!this.dirty || this.conflict || !base || !this.local || this.local.draftId !== base.draftId || !context?.canEdit || context.target.actorUserId !== this.saved!.owner.identity.target.actorUserId || context.target.serverOrigin !== this.saved!.owner.identity.target.serverOrigin) return null;
    return { owner: this.saved!.owner, base, draft: this.local, blobs: this.local.items.flatMap(item => item.blobId && this.blobs.has(item.blobId) ? [this.blobs.get(item.blobId)!] : []), preceding: this.writes };
  }
  private retireWrite(captured: PendingDraftWrite | null): Promise<void> {
    if (!captured) return Promise.resolve();
    this.retiringDrafts.set(captured.owner.ownerKey, captured);
    const save = async () => {
      await captured.preceding.catch(() => {});
      const saved = await this.store.read(captured.owner), current = saved.editable;
      const committed = this.contentCommits.get(captured.owner.ownerKey), known = committed?.draftId === captured.draft.draftId && BigInt(committed.revision) >= BigInt(captured.base.revision) ? committed : captured.base;
      if (!current || current.draftId !== captured.draft.draftId || current.revision !== known.revision) throw new DraftStoreError('conflict', 'The saved draft changed before the final local write.');
      const items = captured.draft.items.map(item => {
        const stored = current.items.find(candidate => candidate.draftImageId === item.draftImageId && candidate.byteRevision === item.byteRevision);
        return stored && item.uploadId === captured.base.items.find(candidate => candidate.draftImageId === item.draftImageId)?.uploadId ? { ...item, uploadId: stored.uploadId } : item;
      });
      await this.store.saveDraft(captured.owner, { draftId: current.draftId, expectedStoreVersion: current.storeVersion, text: captured.draft.text, items, rejectedCandidates: captured.draft.rejectedCandidates, overflowRejectedCount: captured.draft.overflowRejectedCount, blobs: captured.blobs });
      if (this.retiringDrafts.get(captured.owner.ownerKey) === captured) this.retiringDrafts.delete(captured.owner.ownerKey);
    };
    return this.backgroundWork(save());
  }

  /** Repeated calls from the host are inert unless its authenticated admission changes. */
  sync = (): Promise<void> => this.backgroundWork(this.syncOwner());
  private syncOwner = async (): Promise<void> => {
    if (this.closed) return;
    const c = this.options.getContext();
    if (!c) { if (!this.lifetime.signal.aborted) this.epoch++; this.lifetime.abort(); this.network.abort(); this.fingerprint = ''; this.stopObserving(); this.publish(); return; }
    const key = draftOwnerKey(c.identity), fingerprint = JSON.stringify([key, c.authorizationGeneration, c.active, c.canEdit, c.canSend, c.mode, c.expectedTurnId, c.capabilities]);
    if (fingerprint === this.fingerprint) { if (this.loading) await this.loading; await this.resumeValidation(); this.publish(); return; }
    this.fingerprint = fingerprint;
    if (key !== this.scopeKey) {
      const retired = this.retireWrite(this.capturePendingWrite());
      this.epoch++; this.lifetime.abort(); this.network.abort(); this.lifetime = new AbortController(); this.network = new AbortController(); this.clearAssets();
      this.scopeKey = key; this.authGeneration = c.authorizationGeneration; this.saved = null; this.local = null; this.dirty = false; this.error = null; this.conflict = false; this.freezing = false; this.originals = []; this.freshCapability = null; this.pendingLegacy = null; this.view = emptyView();
      this.restoreComplete = false; this.loadFailed = false;
      if (typeof indexedDB === 'undefined') { this.restoreComplete = true; this.loading = null; this.publish(); return; }
      await this.startLoad(c, this.epoch, retired);
      return;
    }
    if (this.authGeneration !== c.authorizationGeneration) { this.epoch++; this.lifetime.abort(); this.network.abort(); this.authGeneration = c.authorizationGeneration; if (!this.restoreComplete) this.loadFailed = false; }
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    if (!this.networkAllowed()) this.network.abort();
    else if (this.network.signal.aborted) this.network = new AbortController();
    if (!this.restoreComplete && !this.loadFailed && (!this.loading || this.loadingEpoch !== this.epoch)) { await this.startLoad(c, this.epoch); return; }
    this.publish();
    await this.resumeValidation();
    if (c.canEdit && this.saved && this.dirty && !this.conflict) await this.flush();
    if (!this.networkAllowed()) this.stopObserving();
    else if (this.saved) { await this.prepareUploads(true); this.observeLater(true); }
  };
  private startLoad(c: ImageDraftContext, epoch: number, preceding: Promise<void> = Promise.resolve()): Promise<void> {
    this.restoreComplete = false; this.loadingEpoch = epoch;
    const loading = preceding.then(async () => {
      if (!this.current(epoch)) return;
      await this.load(c, epoch);
      if (this.current(epoch)) this.restoreComplete = true;
    }).catch(error => {
      if (!this.current(epoch)) return;
      this.loadFailed = true; this.view = { ...this.view, active: true, text: this.options.legacy?.()?.text ?? this.view.text }; this.fail(error);
    }).finally(() => { if (this.loading === loading) { this.loading = null; this.publish(); } });
    this.loading = loading; this.publish(); return loading;
  }
  private async load(c: ImageDraftContext, epoch: number): Promise<void> {
    let snapshot: DraftSnapshot | null;
    try { snapshot = await this.store.readExisting(c.identity); }
    catch (error) {
      if (!this.current(epoch) || !c.canEdit || !(error instanceof DraftStoreError) || error.code !== 'blocked') throw error;
      snapshot = await this.store.reauthorizeOwner(c.identity);
    }
    if (!this.current(epoch)) return;
    this.loadFailed = false;
    const originals = await this.store.readExecutionSubmissions(c.identity);
    if (!this.current(epoch)) return;
    this.originals = originals.filter(entry => entry.owner.ownerKey !== this.scopeKey);
    if (!snapshot && this.originals.length) snapshot = await this.store.openOwner(c.identity);
    if (!this.current(epoch)) return;
    if (!snapshot) { this.view = { ...emptyView(), text: this.view.text }; this.error = null; this.publish(); return; }
    this.adopt(snapshot);
    const retired = this.retiringDrafts.get(snapshot.owner.ownerKey);
    if (retired) {
      this.local = retired.draft; for (const blob of retired.blobs) this.blobs.set(blob.blobId, blob);
      this.dirty = true; this.error = 'image_draft_unsaved'; this.conflict = snapshot.editable?.revision !== retired.base.revision; this.publish();
    }
    await this.restore(epoch);
    if (!this.current(epoch)) return;
    if (c.active) {
      await this.checkSubmissions();
      await this.prepareUploads(true);
      this.observeLater(true);
    }
  }
  private async activate(text: string, original: ImageDraftContext): Promise<number | null> {
    await this.sync(); if (!this.sameActionOwner(original)) return null;
    if (this.loadFailed) throw new Error('image_draft_unavailable'); if (this.saved) return this.epoch;
    if (this.activating) { const epoch = this.epoch; await this.activating; return this.current(epoch) ? epoch : null; }
    const c = this.context(), epoch = this.epoch;
    const legacy = this.pendingLegacy ?? this.options.legacy?.() ?? null; this.pendingLegacy = legacy;
    this.view = { ...this.view, active: true, text }; this.publish();
    const activate = (async () => {
      const imported = legacy ? await this.store.importLegacy(c.identity, { text: legacy.text, revision: legacy.revision, submission: legacy.submission }) : null;
      const saved = imported?.snapshot ?? await this.store.openOwner(c.identity);
      if (!this.current(epoch)) return;
      this.adopt(saved);
      if (imported?.imported) { this.pendingLegacy = null; legacy?.onImported(); }
      if (!imported && this.local && this.local.text !== text) { this.edit({ ...this.local, text }); await this.flush().catch(() => {}); }
      if (imported && !imported.imported && legacy && saved.editable?.text !== legacy.text) { this.local = { ...saved.editable!, text: legacy.text }; this.dirty = true; this.conflict = true; this.error = 'image_draft_conflict'; this.publish(); }
    })();
    this.activating = activate;
    try { await activate; } catch (error) {
      if (!this.current(epoch)) return null;
      // Storage failure preserves the whole local selection. Retry first reads
      // the owner again and cannot turn an unreadable saved draft into an empty one.
      if (!this.local) this.local = { ownerKey: this.scopeKey!, draftId: crypto.randomUUID(), revision: '1', storeVersion: 0, text, items: [], rejectedCandidates: [], overflowRejectedCount: 0, state: 'editable', savedAt: 0 };
      this.dirty = true; this.fail(error);
    } finally { if (this.activating === activate) this.activating = null; }
    return this.current(epoch) ? epoch : null;
  }
  private edit(draft: DraftRecord): void { this.local = draft; this.dirty = true; this.writeVersion++; this.publish(); }
  setText = (text: string): void => {
    if (this.freezing || !this.local || !this.options.getContext()?.canEdit || this.local.text === text) return;
    this.edit({ ...this.local, text });
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.backgroundWork(this.flush()); }, 150);
  };
  flush = async (): Promise<void> => {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const invocationEpoch = this.epoch;
    let committed = false;
    const write = async () => {
      if (!this.current(invocationEpoch)) return;
      if (!this.dirty) return;
      if (!this.options.getContext()?.canEdit) return;
      this.context(); if (this.conflict) throw new Error('image_draft_conflict');
      if (!this.local || !this.saved?.editable) throw new Error('image_draft_unavailable');
      const epoch = this.epoch, version = this.writeVersion, draft = this.local, before = this.saved.editable;
      const input = { draftId: draft.draftId, expectedStoreVersion: before.storeVersion, text: draft.text, items: draft.items, rejectedCandidates: draft.rejectedCandidates, overflowRejectedCount: draft.overflowRejectedCount,
        blobs: draft.items.flatMap(item => item.blobId && this.blobs.has(item.blobId) ? [this.blobs.get(item.blobId)!] : []) };
      let snapshot: DraftSnapshot;
      try { snapshot = await this.store.saveDraft(this.saved.owner, input); }
      catch (error) {
        if (!(error instanceof DraftStoreError) || error.code !== 'revision_exhausted' || !this.current(epoch)) throw error;
        const renewed = await this.store.renewDraft(this.saved.owner, before.storeVersion);
        if (!this.current(epoch)) return;
        this.saved = renewed; this.local = { ...this.local!, draftId: renewed.editable!.draftId, revision: renewed.editable!.revision, storeVersion: renewed.editable!.storeVersion };
        snapshot = await this.store.saveDraft(renewed.owner, { ...input, draftId: renewed.editable!.draftId, expectedStoreVersion: renewed.editable!.storeVersion });
      }
      if (snapshot.editable) this.contentCommits.set(snapshot.owner.ownerKey, snapshot.editable);
      if (!this.current(epoch)) return;
      if (version === this.writeVersion) this.dirty = false;
      this.error = null; this.adopt(snapshot); this.channel?.postMessage({ ownerKey: snapshot.owner.ownerKey, storeVersion: snapshot.editable?.storeVersion });
      committed = true;
    };
    const flight = this.writes.catch(() => {}).then(write); this.writes = flight;
    try {
      await flight;
      if (committed && this.current(invocationEpoch)) void this.backgroundWork(this.prepareUploads(), invocationEpoch);
    } catch (error) { if (this.current(invocationEpoch)) this.fail(error); throw error; }
  };
  retrySave = async (): Promise<void> => {
    this.error = null;
    if (this.loadFailed) {
      await this.startLoad(this.context(), this.epoch);
      return;
    }
    if (!this.saved && this.local) {
      const c = this.context(), epoch = this.epoch, legacy = this.pendingLegacy;
      const migrated = legacy ? await this.store.importLegacy(c.identity, { text: legacy.text, revision: legacy.revision, submission: legacy.submission }) : null;
      if (!this.current(epoch)) return;
      if (migrated?.imported) { this.pendingLegacy = null; legacy?.onImported(); }
      const existing = migrated ? null : await this.store.readExisting(c.identity);
      if (!this.current(epoch)) return;
      if (existing) { this.saved = existing; this.conflict = true; this.error = 'image_draft_conflict'; this.publish(); return; }
      const saved = migrated?.snapshot ?? await this.store.openOwner(c.identity);
      if (!this.current(epoch)) return;
      this.saved = saved;
      if (!saved.editable) { this.conflict = true; this.error = 'image_submission_pending'; this.publish(); return; }
      this.local = { ...this.local, draftId: saved.editable.draftId, storeVersion: saved.editable.storeVersion };
    }
    await this.resumeValidation(); await this.flush(); await this.prepareUploads();
  };

  addFiles = async (files: readonly File[], text: string): Promise<void> => {
    if (!files.length) return;
    const original = this.options.getContext();
    if (!original?.canEdit) return;
    try {
      const epoch = await this.activate(text, original);
      if (epoch === null || !this.current(epoch) || !this.sameActionOwner(original)) return;
      this.context();
      if (this.freezing || !this.local) throw new Error('image_submission_pending');
      const items = [...this.local.items], rejected = [...this.local.rejectedCandidates]; let overflow = this.local.overflowRejectedCount;
      for (const file of files) {
        const id = crypto.randomUUID(), label = safeImageLabel(file.name, id);
        if (items.length >= 8) { if (rejected.length < 32) rejected.push({ candidateId: id, label, reason: 'image_count_limit' }); else overflow++; continue; }
        const item: DraftImageItem = { draftImageId: id, imageId: crypto.randomUUID(), byteRevision: '1', label, blobId: null, validation: 'pending', error: null, uploadId: null };
        items.push(item); this.pendingFiles.set(itemKey(item), { item, file });
      }
      this.edit({ ...this.local, items, rejectedCandidates: rejected, overflowRejectedCount: overflow });
      await this.flush().catch(() => {});
      if (!this.current(epoch)) return;
      await this.validatePendingFiles();
      if (this.current(epoch)) await this.prepareUploads();
    } catch (error) { if (this.sameActionOwner(original)) this.fail(error); }
  };
  private validatePendingFiles(): Promise<void> {
    const epoch = this.epoch;
    const validate = async () => {
      for (const [key, candidate] of [...this.pendingFiles]) {
          if (!this.current(epoch) || !this.options.getContext()?.canEdit) return;
          if (!this.local?.items.some(item => itemKey(item) === key)) { this.pendingFiles.delete(key); continue; }
          let asset: LocalImageAssetAdapter | null = null;
          try {
            if (candidate.file.size < 1 || candidate.file.size > 10 * 1024 * 1024) throw new Error('image_byte_limit');
            this.assets.get(key)?.release();
            asset = this.options.createAsset(candidate.file, candidate.item.draftImageId, candidate.item.byteRevision); this.assets.set(key, asset); this.publish();
            const metadata = await asset.validate(this.lifetime.signal);
            if (!this.current(epoch) || !this.local?.items.some(item => itemKey(item) === key)) { asset.release(); if (this.assets.get(key) === asset) this.assets.delete(key); continue; }
            const original: DraftBlobInput = { ...metadata, blobId: crypto.randomUUID(), blob: candidate.file, byteRevision: candidate.item.byteRevision };
            this.blobs.set(original.blobId, original);
            this.edit({ ...this.local, items: this.local.items.map(item => item.draftImageId === candidate.item.draftImageId ? { ...item, blobId: original.blobId, label: safeImageLabel(candidate.file.name, item.draftImageId, metadata.mediaType), validation: 'valid', error: null } : item) });
            this.pendingFiles.delete(key);
          } catch (error) {
            asset?.release(); if (this.assets.get(key) === asset) this.assets.delete(key);
            if (!this.current(epoch) || !this.local) return;
            if (this.validationInterrupted(error)) { this.publish(); return; }
            this.pendingFiles.delete(key);
            this.edit({ ...this.local, items: this.local.items.map(item => item.draftImageId === candidate.item.draftImageId ? { ...item, validation: 'bytes_invalid', error: message(error) } : item) });
          }
          await this.flush().catch(() => {});
      }
    };
    const validation = this.validations.catch(() => {}).then(validate); this.validations = validation;
    return validation;
  }
  private async resumeValidation(): Promise<void> {
    if (!this.options.getContext()?.canEdit || !this.current(this.epoch) || !this.pendingFiles.size && !this.validationPaused) return;
    if (this.pendingFiles.size) await this.validatePendingFiles();
    if (this.validationPaused) await this.restore(this.epoch);
    if (this.saved && this.dirty && !this.conflict) await this.flush();
    await this.prepareUploads();
  }
  private restore(epoch: number): Promise<void> {
    const validation = this.validations.catch(() => {}).then(() => this.restoreItems(epoch)); this.validations = validation;
    return validation;
  }
  private async restoreItems(epoch: number): Promise<void> {
    if (!this.current(epoch)) return;
    this.validationPaused = false;
    const items = [...(this.saved?.editable?.items ?? []), ...(this.saved?.frozen?.items ?? [])];
    for (const item of items) {
      if (!item.blobId || this.assets.has(itemKey(item))) continue;
      const original = await this.store.readBlob(this.saved!.owner, item.blobId);
      if (!this.current(epoch)) return;
      if (!original) continue;
      let asset: LocalImageAssetAdapter | null = null;
      try {
        asset = this.options.createAsset(original.blob, item.draftImageId, item.byteRevision, original); this.assets.set(itemKey(item), asset);
        const metadata = await asset.validate(this.lifetime.signal);
        if (!this.current(epoch)) { asset.release(); if (this.assets.get(itemKey(item)) === asset) this.assets.delete(itemKey(item)); return; }
        if (metadata.byteLength !== original.byteLength || metadata.sha256 !== original.sha256 || metadata.mediaType !== original.mediaType || metadata.width !== original.width || metadata.height !== original.height || metadata.frameCount !== original.frameCount) throw new Error('image_bytes_invalid');
        this.blobs.set(original.blobId, original);
      } catch (error) {
        asset?.release(); if (this.assets.get(itemKey(item)) === asset) this.assets.delete(itemKey(item));
        if (!this.current(epoch)) return;
        if (this.validationInterrupted(error)) { this.validationPaused = true; this.publish(); return; }
        if (this.local?.items.some(candidate => candidate.draftImageId === item.draftImageId)) { this.edit({ ...this.local, items: this.local.items.map(candidate => candidate.draftImageId === item.draftImageId ? { ...candidate, validation: 'bytes_invalid', error: message(error) } : candidate) }); await this.flush(); }
        else this.error = message(error);
      }
    }
    this.publish();
  }
  private reload(): Promise<void> {
    const epoch = this.epoch;
    const readback = this.writes.catch(() => {}).then(() => this.adoptReadback(epoch)); this.writes = readback;
    return readback;
  }
  /** Called only while owning the local persistence queue. */
  private async adoptReadback(epoch: number, ownUpload = false): Promise<void> {
    if (!this.current(epoch) || !this.saved) return;
    const snapshot = await this.store.read(this.saved.owner);
    if (!this.current(epoch)) return;
    if (this.dirty && this.saved.editable?.storeVersion !== snapshot.editable?.storeVersion && !(ownUpload && this.saved.editable && snapshot.editable?.storeVersion === this.saved.editable.storeVersion + 1)) { this.conflict = true; this.error = 'image_draft_conflict'; this.publish(); return; }
    this.adopt(snapshot);
  }
  private async refresh(): Promise<void> {
    if (!this.networkAllowed()) return;
    if (!this.saved) { if (typeof indexedDB !== 'undefined') await this.startLoad(this.context(), this.epoch); return; }
    if (this.network.signal.aborted) this.network = new AbortController();
    await this.reload(); await this.restore(this.epoch); await this.checkStatus(); this.observeLater(true);
  }
  /** Rechecks durable owner and execution barriers before the caller chooses its send path. */
  refreshForSend = async (): Promise<void> => {
    await this.sync();
    if (this.closed || typeof indexedDB === 'undefined' || this.loadFailed) return;
    const c = this.context(), epoch = this.epoch;
    await this.flush();
    if (!this.current(epoch)) throw new Error('image_access_unavailable');
    const before = this.local ?? this.saved?.frozen;
    await this.startLoad(c, epoch);
    if (!this.current(epoch)) throw new Error('image_access_unavailable');
    const after = this.local ?? this.saved?.frozen;
    if (before && (before.draftId !== after?.draftId || before.revision !== after?.revision)) throw new Error('image_draft_restored');
  };
  private canPrepare(): boolean {
    const c = this.options.getContext(), draft = this.local;
    return !!c && this.networkAllowed() && !!this.saved && !!draft && !this.dirty && !this.conflict && !draft.rejectedCandidates.length && !draft.overflowRejectedCount && draft.items.length > 0 && draft.items.every(item => item.validation === 'valid' && !!item.blobId && this.blobs.has(item.blobId)) && imageSetIssue(draft.items.map(item => this.blobs.get(item.blobId!)!), this.capability(c), c.target, 'send') === null;
  }
  private async prepareUploads(observe = false, retryPrepareId?: string): Promise<void> {
    if (!this.saved || !this.locks || !this.networkAllowed()) return;
    const epoch = this.epoch, c = this.context();
    const allocate = async () => {
      if (!this.current(epoch) || !this.canPrepare()) return;
      for (const id of this.local!.items.map(item => item.draftImageId)) {
        if (!this.current(epoch) || !this.canPrepare()) return;
        const item = this.local!.items.find(candidate => candidate.draftImageId === id);
        if (!item || item.uploadId) continue;
        const original = this.blobs.get(item.blobId!)!;
        await this.store.createUpload(this.saved!.owner, { draftImageId: item.draftImageId, byteRevision: item.byteRevision, blobId: original.blobId, spec: { uploadId: crypto.randomUUID(), imageId: item.imageId, target: c.target, name: item.label, mediaType: original.mediaType, byteLength: String(original.byteLength), sha256: original.sha256 } });
        if (!this.current(epoch)) return; await this.adoptReadback(epoch, true);
      }
    };
    // Binding an upload advances the draft CAS version. Adopt it before another
    // local save or allocation, while keeping network work outside this queue.
    const allocation = this.writes.catch(() => {}).then(allocate); this.writes = allocation;
    await allocation;
    if (!this.current(epoch) || !this.saved) return;
    const uploads = this.saved.uploads.map(upload => upload.uploadId);
    for (const uploadId of uploads) {
      if (!this.current(epoch)) return;
      while (this.uploadFlights.has(uploadId)) {
        await this.uploadFlights.get(uploadId);
        if (!this.current(epoch)) return;
      }
      const upload = this.saved.uploads.find(candidate => candidate.uploadId === uploadId);
      if (!upload) continue;
      if (!upload.releaseIntent && !observe && (!this.canPrepare() || upload.receipt?.state === 'complete' || upload.outcomeUnknown || upload.pendingAction)) continue;
      if (!upload.releaseIntent && upload.receipt && ['failed', 'expired', 'released'].includes(upload.receipt.state)) continue;
      if (upload.releaseIntent && upload.receipt?.state === 'released') continue;
      const uploader = new DraftUploader({ store: this.store, locks: this.locks, resources: c.resources, signal: this.network.signal, isCurrent: () => this.current(epoch) && !!this.options.getContext()?.canEdit, canPrepare: () => this.canPrepare(), changed: async () => { if (!this.dirty && !this.conflict) this.error = null; await this.reload(); } });
      const run = uploader.run(this.saved.owner, upload.uploadId, this.blobs.get(upload.blobId) ?? null, observe, retryPrepareId === upload.uploadId).catch(error => { if (this.current(epoch)) this.fail(error); });
      this.uploadFlights.set(upload.uploadId, run);
      try { await run; } finally { if (this.uploadFlights.get(upload.uploadId) === run) this.uploadFlights.delete(upload.uploadId); }
    }
    this.publish();
    this.observeLater();
  }
  remove = async (id: string): Promise<void> => {
    this.context(); if (!this.local) return;
    const epoch = this.epoch;
    const removed = this.local.items.find(item => item.draftImageId === id);
    this.edit({ ...this.local, items: this.local.items.filter(item => item.draftImageId !== id), rejectedCandidates: this.local.rejectedCandidates.filter(item => item.candidateId !== id) });
    await this.flush();
    if (!this.current(epoch)) return;
    if (removed) { this.assets.get(itemKey(removed))?.release(); this.assets.delete(itemKey(removed)); }
    await this.prepareUploads();
  };
  discardRejected = async (): Promise<void> => { this.context(); if (!this.local) return; const epoch = this.epoch; this.edit({ ...this.local, rejectedCandidates: [], overflowRejectedCount: 0 }); await this.flush(); if (this.current(epoch)) await this.prepareUploads(); };
  retryUpload = async (id: string): Promise<void> => {
    this.context(); const item = this.local?.items.find(item => item.draftImageId === id); if (!item) return;
    const upload = this.saved?.uploads.find(upload => upload.uploadId === item.uploadId);
    if (!upload || upload.outcomeUnknown || upload.pendingAction || !upload.receipt || !['failed', 'expired', 'released'].includes(upload.receipt.state)) { await this.prepareUploads(true, upload?.pendingAction?.kind === 'prepare' && !upload.receipt ? upload.uploadId : undefined); return; }
    const epoch = this.epoch;
    this.edit({ ...this.local!, items: this.local!.items.map(candidate => candidate === item ? { ...candidate, uploadId: null } : candidate) });
    await this.flush(); if (this.current(epoch)) await this.prepareUploads();
  };
  private sender(epoch: number, owner = this.saved?.owner): DraftSender {
    return new DraftSender({ store: this.store, locks: this.locks, isCurrent: () => this.current(epoch), admit: (snapshot, prepared) => this.gate(snapshot, prepared),
      command: snapshot => {
        const c = this.context(), draft = snapshot.editable!;
        return { protocol: SESSION_PROTOCOL, ...c.target.fence, contentRevision: 2, requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), kind: 'send_message', payload: {
          content: [...(draft.text.trim() ? [{ type: 'text' as const, text: draft.text }] : []), ...draft.items.map(item => { const upload = snapshot.uploads.find(upload => upload.uploadId === item.uploadId)!; return { type: 'image' as const, imageId: item.imageId, uploadId: upload.uploadId, resourceId: upload.receipt!.resource!.resourceId, sha256: upload.spec.sha256, byteLength: upload.spec.byteLength }; })], expectedTurnId: c.expectedTurnId,
          ...(draft.items.length ? { target: c.target, expectedImageCapabilityRevision: this.capability(c)!.revision, draftId: draft.draftId, draftRevision: draft.revision } : {}) } };
      }, dispatch: this.options.dispatch, query: this.options.query, signal: this.network.signal,
      ...(this.options.isDefinitiveNotDispatched ? { isDefinitiveNotDispatched: this.options.isDefinitiveNotDispatched } : {}),
      changed: snapshot => { if (owner?.ownerKey === this.scopeKey && this.current(epoch)) { if (snapshot.submission) this.freezing = false; if (!this.dirty && !this.conflict) this.error = null; this.adopt(snapshot); } } });
  }
  send = async (): Promise<void> => {
    if (this.freezing) return;
    const epochAtStart = this.epoch;
    this.freezing = !!this.local; this.publish();
    try {
      await this.flush(); if (!this.current(epochAtStart)) return; this.context(); if (!this.saved) return;
      const c = this.context(), epoch = this.epoch;
      if ((this.local ?? this.saved.frozen)?.items.length) {
        const result = await c.resources.capabilities(this.network.signal);
        if (!this.current(epoch) || c.capabilities?.revision !== this.context().capabilities?.revision || !sameProfile(c.capabilities, this.context().capabilities) || !sameProfile(result.capabilities, this.context().capabilities)) throw new Error('image_capability_changed');
        this.freshCapability = result.capabilities; this.capabilityBaseRevision = c.capabilities!.revision;
      }
      await this.sender(epoch).send(this.saved.owner); this.publish(); this.observeLater(true);
    } catch (error) { if (this.current(epochAtStart)) this.fail(error); }
    finally { if (this.current(epochAtStart)) { this.freezing = false; this.publish(); } }
  };
  resumePrepared = async (): Promise<void> => { if (this.saved?.submission?.state === 'prepared') await this.send(); };
  cancelPrepared = async (): Promise<void> => {
    this.context(); const entry = this.originals.find(candidate => candidate.submission.state === 'prepared'); if (!entry) return;
    const epoch = this.epoch; await this.store.refusePrepared(entry.owner, entry.submission.operationId);
    if (!this.current(epoch)) return;
    const originals = await this.store.readExecutionSubmissions(this.context().identity);
    if (!this.current(epoch)) return;
    this.originals = originals.filter(candidate => candidate.owner.ownerKey !== this.scopeKey); await this.reload();
  };
  private async checkSubmissions(): Promise<void> {
    if (!this.saved || !this.networkAllowed()) return;
    const epoch = this.epoch;
    for (const entry of [...(this.saved.submission ? [{ owner: this.saved.owner, submission: this.saved.submission }] : []), ...this.originals]) {
      if (entry.submission.state === 'prepared' || entry.submission.state === 'rejected' || entry.submission.state === 'local_not_dispatched') continue;
      try { await this.sender(epoch, entry.owner).check(entry.owner, entry.submission); } catch (error) { if (this.current(epoch)) this.fail(error); }
    }
    if (!this.current(epoch)) return;
    const originals = await this.store.readExecutionSubmissions(this.context().identity);
    if (!this.current(epoch)) return;
    this.originals = originals.filter(entry => entry.owner.ownerKey !== this.scopeKey); await this.reload();
  }
  checkStatus = async (): Promise<void> => {
    if (this.checking || !this.saved || !this.networkAllowed()) return; this.checking = true; this.publish();
    try { await this.checkSubmissions(); await this.prepareUploads(true); } finally { this.checking = false; this.publish(); }
  };
  private stopObserving(): void { if (this.observeTimer) clearTimeout(this.observeTimer); this.observeTimer = null; this.observeStarted = 0; this.observeAttempt = 0; }
  private observeLater(reset = false): void {
    const pending = !!this.saved?.submission && !['prepared', 'rejected', 'local_not_dispatched'].includes(this.saved.submission.state) || this.originals.some(entry => !['prepared', 'rejected', 'local_not_dispatched'].includes(entry.submission.state)) || this.saved?.uploads.some(upload => upload.outcomeUnknown || upload.receipt?.state === 'verifying');
    if (!pending || !this.networkAllowed()) { this.stopObserving(); return; }
    if (reset) this.stopObserving();
    if (this.observeTimer) return;
    if (!this.observeStarted) this.observeStarted = Date.now();
    const delay = [1000, 2000, 5000, 10000, 30000][Math.min(this.observeAttempt++, 4)]!;
    if (Date.now() - this.observeStarted + delay > 60_000) return;
    this.observeTimer = setTimeout(() => { this.observeTimer = null; void this.backgroundWork(this.checkStatus().then(() => this.observeLater())); }, delay);
  }
  continueEditing = async (): Promise<void> => { this.context(); if (!this.saved?.submission || this.local) return; const epoch = this.epoch, snapshot = await this.store.startSuccessor(this.saved.owner, this.saved.submission.operationId); if (this.current(epoch)) this.adopt(snapshot); };
  resolveFailure = async (choice: 'current' | 'failed'): Promise<void> => { this.context(); if (!this.saved?.submission) return; const epoch = this.epoch; await this.flush(); if (!this.current(epoch)) return; const snapshot = await this.store.resolveFailure(this.saved.owner, this.saved.submission.operationId, choice === 'current' ? 'keep_current' : 'restore_failed'); if (!this.current(epoch)) return; this.adopt(snapshot); await this.prepareUploads(); };
  resolveConflict = async (choice: 'saved' | 'local'): Promise<void> => {
    this.context(); if (!this.saved) return;
    const epoch = this.epoch, latest = await this.store.read(this.saved.owner); if (!this.current(epoch)) return; this.saved = latest;
    if (choice === 'saved') { this.dirty = false; this.local = latest.editable; }
    else if (!this.local || !latest.editable) throw new Error('image_submission_pending');
    else this.local = { ...this.local, draftId: latest.editable.draftId, storeVersion: latest.editable.storeVersion };
    this.conflict = false; this.error = null;
    if (choice === 'local') await this.flush(); else { await this.restore(this.epoch); this.publish(); }
    await this.prepareUploads();
  };
  revoke = async (reason: 'revoked' | 'account_changed' | 'deleted' = 'revoked'): Promise<void> => {
    const owner = this.saved?.owner; this.epoch++; this.lifetime.abort(); this.network.abort(); this.stopObserving(); this.clearAssets(); this.saved = null; this.local = null; this.originals = []; this.dirty = false; this.view = emptyView(); this.scopeKey = null; this.fingerprint = '';
    for (const listener of this.listeners) listener();
    if (owner) try { await this.store.blockOwner(owner, reason); } catch (error) { this.fail(error); }
  };
  close = (): Promise<void> => {
    if (this.closing) return this.closing;
    const pending = this.capturePendingWrite();
    this.closed = true; this.epoch++; this.lifetime.abort(); this.network.abort(); this.stopObserving(); if (this.timer) clearTimeout(this.timer); this.clearAssets(); this.listeners.clear(); this.channel?.close();
    if (typeof window !== 'undefined') { window.removeEventListener('focus', this.onFocus); document.removeEventListener('visibilitychange', this.onVisibility); }
    const finalWrite = this.retireWrite(pending);
    this.closing = (async () => {
      await Promise.allSettled([...this.background, ...this.uploadFlights.values(), this.loading, this.activating, this.validations, this.writes, finalWrite]);
      if (!this.options.store) this.store.close();
    })();
    return this.closing;
  };
}
