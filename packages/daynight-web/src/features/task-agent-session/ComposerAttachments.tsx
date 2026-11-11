import { useState } from 'react';
import type { ImageAssetAdapter } from './images/image-types';
import { SessionImageFrame } from './images/SessionImageFrame';
import { useDraftMessages } from './drafts/draft-messages';
import '../../styles/session-draft-images.css';

type Item = { readonly draftImageId: string; readonly label: string; readonly asset?: ImageAssetAdapter | null; readonly progress: number; readonly error: string | null; readonly status: string; readonly canRetryPrepare?: boolean };
export type ComposerAttachmentsBinding = {
  readonly view: {
    readonly active: boolean; readonly loading: boolean; readonly items: readonly Item[];
    readonly rejectedCandidates: readonly { readonly id: string; readonly label: string; readonly error: string }[];
    readonly overflowRejectedCount: number; readonly saving: boolean; readonly error: string | null; readonly conflict: boolean;
    readonly frozen: boolean; readonly readOnly?: boolean; readonly failureChoice?: boolean;
    readonly submission: { readonly operationId: string; readonly snapshot?: { readonly text: string } | null } | null;
    readonly frozenItems?: readonly Item[]; readonly canSend: boolean; readonly canResumePrepared?: boolean; readonly canCancelPrepared?: boolean; readonly disabledReason: string | null; readonly checking: boolean;
  };
  addFiles(files: readonly File[], text: string): Promise<void>;
  remove(id: string): Promise<void>; discardRejected(): Promise<void>; retrySave(): Promise<void>; retryUpload(id: string): Promise<void>;
  checkStatus(): Promise<void>; continueEditing(): Promise<void>; resolveConflict(choice: 'saved' | 'local'): Promise<void>; resolveFailure(choice: 'current' | 'failed'): Promise<void>;
  resumePrepared?(): Promise<void>;
  cancelPrepared?(): Promise<void>;
};

export function ComposerAttachments({ binding, active, editable, canRecover = editable }: { readonly binding: ComposerAttachmentsBinding; readonly active: boolean; readonly editable: boolean; readonly canRecover?: boolean }) {
  const m = useDraftMessages(), { view } = binding;
  const [choice, setChoice] = useState<'current' | 'failed' | null>(null);
  const run = (action: Promise<void>) => { void action.catch(() => {}); };
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
    {view.submission ? <div className="session-draft-recovery"><span>{m.pending}</span><button className="button" type="button" disabled={!active || view.checking} onClick={() => run(binding.checkStatus())}>{m.check}</button>
      {view.canResumePrepared && binding.resumePrepared ? <button className="button" type="button" disabled={!active || view.checking} onClick={() => run(binding.resumePrepared!())}>{m.resumePrepared}</button> : null}
      {view.canCancelPrepared && binding.cancelPrepared ? <button className="button" type="button" disabled={!active || view.checking} onClick={() => run(binding.cancelPrepared!())}>{m.cancelPrepared}</button> : null}
      {view.frozen && !view.failureChoice ? <button className="button" type="button" disabled={!active} onClick={() => run(binding.continueEditing())}>{m.continueEditing}</button> : null}
      {!view.frozen && view.submission.snapshot ? <details><summary>{m.frozen}</summary><p className="session-draft-frozen-text">{view.submission.snapshot.text}</p>{items(view.frozenItems ?? [], true)}</details> : null}
    </div> : null}
    {view.failureChoice ? <div className="session-draft-recovery"><strong>{m.failedChoice}</strong><button className="button" type="button" disabled={!active} onClick={() => setChoice('current')}>{m.keepCurrent}</button><button className="button" type="button" disabled={!active} onClick={() => setChoice('failed')}>{m.restoreFailed}</button>
      {choice ? <div role="group" aria-label={m.confirm}><p>{choice === 'current' ? m.keepCurrent : m.restoreFailed}</p><button className="button" type="button" disabled={!active} onClick={() => { run(binding.resolveFailure(choice)); setChoice(null); }}>{m.confirm}</button><button className="button" type="button" onClick={() => setChoice(null)}>{m.cancel}</button></div> : null}
    </div> : null}
    {!view.canSend && view.active && view.disabledReason && !view.error && !view.submission ? <span className="session-draft-disabled" tabIndex={0}>{m.issue(view.disabledReason)}</span> : null}
  </section>;
}
