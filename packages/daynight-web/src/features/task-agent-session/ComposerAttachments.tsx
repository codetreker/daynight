import { useEffect, useState } from 'react';
import type { ImageAssetAdapter } from './images/image-types';
import { SessionImageFrame } from './images/SessionImageFrame';
import { useDraftMessages } from './drafts/draft-messages';
import type { ImageDraftDetached, ImageDraftDetachedRef, ImageDraftRecovery, ImageDraftRecoveryDraft, ImageDraftRecoveryRef } from './drafts/image-draft-controller';
import '../../styles/session-draft-images.css';

type Item = { readonly draftImageId: string; readonly label: string; readonly asset?: ImageAssetAdapter | null; readonly progress: number; readonly error: string | null; readonly status: string; readonly canRetryPrepare?: boolean };
export type ComposerAttachmentsBinding = {
  readonly view: {
    readonly active: boolean; readonly loading: boolean; readonly items: readonly Item[];
    readonly rejectedCandidates: readonly { readonly id: string; readonly label: string; readonly error: string }[];
    readonly overflowRejectedCount: number; readonly saving: boolean; readonly error: string | null; readonly conflict: boolean;
    readonly frozen: boolean; readonly readOnly?: boolean; readonly failureChoice?: boolean;
    readonly recoveries?: readonly ImageDraftRecovery[];
    readonly detachedDrafts?: readonly ImageDraftDetached[];
    readonly submission: { readonly operationId: string; readonly snapshot?: { readonly text: string } | null } | null;
    readonly frozenItems?: readonly Item[]; readonly canSend: boolean; readonly canResumePrepared?: boolean; readonly canCancelPrepared?: boolean; readonly disabledReason: string | null; readonly checking: boolean;
  };
  addFiles(files: readonly File[], text: string): Promise<void>;
  remove(id: string): Promise<void>; discardRejected(): Promise<void>; retrySave(): Promise<void>; retryUpload(id: string): Promise<void>;
  checkStatus(ref?: ImageDraftRecoveryRef): Promise<void>; continueEditing(): Promise<void>; resolveConflict(choice: 'saved' | 'local'): Promise<void>; resolveFailure(ref: ImageDraftRecoveryRef, choice: 'current' | 'failed'): Promise<void>;
  resumePrepared?(): Promise<void>;
  cancelPrepared?(ref: ImageDraftRecoveryRef): Promise<void>;
  restoreDetached?(ref: ImageDraftDetachedRef): Promise<void>;
  retryDetachedSave?(ref: ImageDraftDetachedRef): Promise<void>;
  resolveDetachedConflict?(ref: ImageDraftDetachedRef, choice: 'saved' | 'local'): Promise<void>;
};

const sameRecovery = (a: ImageDraftRecoveryRef, b: ImageDraftRecoveryRef): boolean => a.ownerKey === b.ownerKey && a.operationId === b.operationId && a.choiceRevision === b.choiceRevision;
const hasFailureChoice = (entry: ImageDraftRecovery): boolean => !!entry.frozen && !!entry.successor && ['rejected', 'local_not_dispatched'].includes(entry.state);
const sameDetached = (a: ImageDraftDetachedRef, b: ImageDraftDetachedRef): boolean =>
  a.ownerKey === b.ownerKey && a.accessEpoch === b.accessEpoch && a.draftId === b.draftId && a.revision === b.revision && a.storeVersion === b.storeVersion &&
  a.targetOwnerKey === b.targetOwnerKey && a.targetAccessEpoch === b.targetAccessEpoch && a.targetDraftId === b.targetDraftId && a.targetRevision === b.targetRevision && a.targetStoreVersion === b.targetStoreVersion && a.pendingWriteId === b.pendingWriteId;

export function ComposerAttachments({ binding, active, editable, canRecover = editable }: { readonly binding: ComposerAttachmentsBinding; readonly active: boolean; readonly editable: boolean; readonly canRecover?: boolean }) {
  const m = useDraftMessages(), { view } = binding;
  const [choice, setChoice] = useState<{ readonly ref: ImageDraftRecoveryRef; readonly draft: 'current' | 'failed' } | null>(null);
  const [detachedChoice, setDetachedChoice] = useState<{ readonly ref: ImageDraftDetachedRef; readonly action: 'move' | 'saved' | 'local' } | null>(null);
  const recoveryAllowed = active && canRecover;
  const currentRecovery = view.recoveries?.find(entry => entry.currentOwner);
  const currentPrepared = currentRecovery?.state === 'prepared';
  const confirmedEntry = choice && recoveryAllowed ? view.recoveries?.find(entry => entry.canResolveFailure && sameRecovery(entry.ref, choice.ref)) : null;
  const confirmedDetached = detachedChoice && recoveryAllowed ? view.detachedDrafts?.find(entry =>
    (detachedChoice.action === 'move' ? entry.canRestore : entry.canResolveConflict) && sameDetached(entry.ref, detachedChoice.ref)) : null;
  useEffect(() => { if (choice && !confirmedEntry) setChoice(null); }, [choice, confirmedEntry]);
  useEffect(() => { if (detachedChoice && !confirmedDetached) setDetachedChoice(null); }, [detachedChoice, confirmedDetached]);
  const run = (action: Promise<void>) => { void action.catch(() => {}); };
  const recoveryDraft = (draft: ImageDraftRecoveryDraft | null, label: string) => draft ? <details className="session-draft-recovery-content"><summary>{label} · {m.imageCount}: {draft.items.length}{draft.text ? ` · ${draft.text.length > 120 ? `${draft.text.slice(0, 120)}…` : draft.text}` : ''}</summary>
    <p className="session-draft-frozen-text">{draft.text}</p>
    {draft.items.length ? <ul>{draft.items.map(item => <li className="session-draft-name" key={item.draftImageId}>{item.label}</li>)}</ul> : null}
  </details> : null;
  const items = (values: readonly Item[], frozen = false) => <div className="session-draft-items">{values.map(item => <div className="session-draft-item" key={item.draftImageId}>
    {item.asset ? <SessionImageFrame asset={item.asset} label={item.label} active={active} /> : <span className="session-draft-name" tabIndex={0}>{item.label}</span>}
    {!frozen ? <button className="button" type="button" disabled={!editable} aria-label={`${m.remove}: ${item.label}`} onClick={() => run(binding.remove(item.draftImageId))}>{m.remove}</button> : null}
    {!frozen && ['preparing', 'receiving', 'uploading', 'verifying'].includes(item.status) ? <progress aria-label={`${m.upload}: ${item.label}`} max={1} value={item.progress} /> : null}
    {item.error ? <span className="session-error" role="alert">{m.issue(item.error)}</span> : null}
    {!frozen && (item.error || ['unknown', 'upload_outcome_unknown', 'failed', 'expired', 'released'].includes(item.status)) ? <button className="button" type="button" disabled={!editable || view.checking} onClick={() => run(['unknown', 'upload_outcome_unknown'].includes(item.status) ? binding.checkStatus() : binding.retryUpload(item.draftImageId))}>{['unknown', 'upload_outcome_unknown'].includes(item.status) ? m.check : m.retry}</button> : null}
    {!frozen && item.canRetryPrepare ? <button className="button" type="button" disabled={!editable || view.checking} onClick={() => run(binding.retryUpload(item.draftImageId))}>{m.retryPrepare}</button> : null}
  </div>)}</div>;
  return <section className="session-draft-attachments" aria-label={m.label}>
    {view.items.length ? items(view.items) : null}
    {view.rejectedCandidates.length || view.overflowRejectedCount ? <div className="session-draft-rejected" role="alert">
      <strong>{m.rejected}</strong><ul>{view.rejectedCandidates.map(item => <li key={item.id}>{item.label}: {m.issue(item.error)}</li>)}</ul>
      {view.overflowRejectedCount ? <p>{m.moreRejected}: {view.overflowRejectedCount}</p> : null}
      <button className="button" type="button" disabled={!editable} onClick={() => run(binding.discardRejected())}>{m.discardRejected}</button>
    </div> : null}
    {view.saving ? <span className="session-draft-saving" role="status">{m.saving}</span> : null}
    {view.error ? <div className="session-error" role="alert">{m.issue(view.error)}<button className="button" type="button" disabled={!canRecover || view.saving} onClick={() => run(binding.retrySave())}>{m.retrySave}</button></div> : null}
    {view.conflict ? <div className="session-draft-recovery" role="alert"><p>{m.conflict}</p><button className="button" type="button" disabled={!editable} onClick={() => run(binding.resolveConflict('saved'))}>{m.useSaved}</button><button className="button" type="button" disabled={!editable} onClick={() => run(binding.resolveConflict('local'))}>{m.useLocal}</button></div> : null}
    {view.submission ? <div className="session-draft-recovery"><span>{view.failureChoice ? m.failedChoice : currentPrepared ? m.prepared : m.pending}</span>{!view.failureChoice && !currentPrepared ? <button className="button" type="button" disabled={!recoveryAllowed || view.checking} onClick={() => run(binding.checkStatus())}>{m.check}</button> : null}
      {!view.failureChoice && currentRecovery?.error ? <span className="session-error" role="alert">{m.issue(currentRecovery.error)}</span> : null}
      {view.canResumePrepared && binding.resumePrepared ? <button className="button" type="button" disabled={!recoveryAllowed || view.checking} onClick={() => run(binding.resumePrepared!())}>{m.resumePrepared}</button> : null}
      {currentPrepared && binding.cancelPrepared ? <button className="button" type="button" disabled={!recoveryAllowed || !currentRecovery.canCancelPrepared || view.checking} onClick={() => run(binding.cancelPrepared!(currentRecovery.ref))}>{m.cancelPrepared}</button> : null}
      {view.frozen && !view.failureChoice ? <button className="button" type="button" disabled={!recoveryAllowed} onClick={() => run(binding.continueEditing())}>{m.continueEditing}</button> : null}
      {!view.frozen && !view.failureChoice && view.submission.snapshot ? <details><summary>{m.frozen}</summary><p className="session-draft-frozen-text">{view.submission.snapshot.text}</p>{items(view.frozenItems ?? [], true)}</details> : null}
    </div> : null}
    {view.recoveries?.filter(entry => !entry.currentOwner || hasFailureChoice(entry)).map(entry => <div className="session-draft-recovery" key={JSON.stringify([entry.ref.ownerKey, entry.ref.operationId])}>
      {!entry.currentOwner ? <strong>{m.previousMessage}</strong> : null}
      {recoveryDraft(entry.frozen, m.frozen)}{recoveryDraft(entry.successor, m.successor)}
      {entry.error ? <span className="session-error" role="alert">{m.issue(entry.error)}</span> : null}
      {!entry.currentOwner && !['prepared', 'rejected', 'local_not_dispatched'].includes(entry.state) ? <button className="button" type="button" disabled={!recoveryAllowed || !entry.canCheck || view.checking} onClick={() => run(binding.checkStatus(entry.ref))}>{m.check}</button> : null}
      {!entry.currentOwner && entry.state === 'prepared' && binding.cancelPrepared ? <button className="button" type="button" disabled={!recoveryAllowed || !entry.canCancelPrepared || view.checking} onClick={() => run(binding.cancelPrepared!(entry.ref))}>{m.cancelPrepared}</button> : null}
      {hasFailureChoice(entry) ? <><strong>{m.failedChoice}</strong>
        <button className="button" type="button" disabled={!recoveryAllowed || !entry.canResolveFailure} onClick={() => { setDetachedChoice(null); setChoice({ ref: entry.ref, draft: 'current' }); }}>{m.keepCurrent}</button>
        <button className="button" type="button" disabled={!recoveryAllowed || !entry.canResolveFailure} onClick={() => { setDetachedChoice(null); setChoice({ ref: entry.ref, draft: 'failed' }); }}>{m.restoreFailed}</button>
      </> : null}
      {choice && confirmedEntry === entry ? <div role="group" aria-label={m.confirm}><p>{choice.draft === 'current' ? m.keepCurrent : m.restoreFailed}</p><button className="button" type="button" disabled={!recoveryAllowed} onClick={() => { run(binding.resolveFailure(choice.ref, choice.draft)); setChoice(null); }}>{m.confirm}</button><button className="button" type="button" onClick={() => setChoice(null)}>{m.cancel}</button></div> : null}
    </div>)}
    {view.detachedDrafts?.map(entry => <div className="session-draft-recovery" key={JSON.stringify([entry.ref.ownerKey, entry.ref.draftId])}>
      <strong>{m.previousDraft}</strong>
      {recoveryDraft(entry.draft, m.savedContent)}
      {recoveryDraft(entry.savedDraft, m.savedInAnotherWindow)}
      {entry.rejectedCandidates.length ? <ul>{entry.rejectedCandidates.map(item => <li key={item.id}>{item.label}: {m.issue(item.error)}</li>)}</ul> : null}
      {entry.overflowRejectedCount ? <p>{m.moreRejected}: {entry.overflowRejectedCount}</p> : null}
      {entry.error ? <span className="session-error" role="alert">{m.issue(entry.error)}</span> : null}
      {entry.canRetrySave && binding.retryDetachedSave ? <button className="button" type="button" disabled={!recoveryAllowed} onClick={() => run(binding.retryDetachedSave!(entry.ref))}>{m.retrySavedDraft}</button> : null}
      {binding.restoreDetached ? <button className="button" type="button" disabled={!recoveryAllowed || !entry.canRestore} onClick={() => { setChoice(null); setDetachedChoice({ ref: entry.ref, action: 'move' }); }}>{m.moveDraft}</button> : null}
      {entry.canResolveConflict && binding.resolveDetachedConflict ? <>
        <button className="button" type="button" disabled={!recoveryAllowed} onClick={() => { setChoice(null); setDetachedChoice({ ref: entry.ref, action: 'saved' }); }}>{m.keepSavedVersion}</button>
        <button className="button" type="button" disabled={!recoveryAllowed} onClick={() => { setChoice(null); setDetachedChoice({ ref: entry.ref, action: 'local' }); }}>{m.keepLocalVersion}</button>
      </> : null}
      {!entry.canRestore && entry.disabledReason ? <span className="session-draft-disabled" tabIndex={0}>{m.issue(entry.disabledReason)}</span> : null}
      {detachedChoice && confirmedDetached === entry ? <div role="group" aria-label={m.confirm}><p>{detachedChoice.action === 'move' ? m.moveDraftConfirm : detachedChoice.action === 'saved' ? m.keepSavedVersion : m.keepLocalVersion}</p>
        <button className="button" type="button" disabled={!recoveryAllowed} onClick={() => {
          if (detachedChoice.action === 'move') { if (binding.restoreDetached) run(binding.restoreDetached(detachedChoice.ref)); }
          else if (binding.resolveDetachedConflict) run(binding.resolveDetachedConflict(detachedChoice.ref, detachedChoice.action));
          setDetachedChoice(null);
        }}>{m.confirm}</button>
        <button className="button" type="button" onClick={() => setDetachedChoice(null)}>{m.cancel}</button>
      </div> : null}
    </div>)}
    {!view.canSend && view.active && view.disabledReason && !view.error && !view.submission ? <span className="session-draft-disabled" tabIndex={0}>{m.issue(view.disabledReason)}</span> : null}
  </section>;
}
