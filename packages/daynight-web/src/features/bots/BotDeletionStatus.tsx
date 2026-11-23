import { ApiError } from '../../api/client';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { BotRecoveryDialog } from './BotRecoveryDialog';
import type { BotDeletionCoordinator } from './deletion-coordinator';
import { useBotMessages } from './messages';

type Record = ReturnType<BotDeletionCoordinator['snapshot']>[number];
export function BotDeletionStatus({ record, coordinator, onCheck, enabled, workerName }: { readonly record: Record; readonly coordinator: BotDeletionCoordinator; readonly onCheck: (id: string) => Promise<void>; readonly enabled: boolean; readonly workerName?: string | undefined }) {
  const m = useBotMessages();
  const phase = record.phase;
  const [dialog, setDialog] = useState<{ opener: HTMLElement; version: string } | null>(null);
  const recovery = record.recovery, value = recovery?.value, missing = record.result?.deletion.workerCleanup.code === 'execution_evidence_missing';
  const terminal = phase === 'completed' || phase === 'settled';
  const title = phase === 'settled' ? m.recoverySettled : recovery?.phase === 'submitting' ? m.recoverySubmitting : recovery?.phase === 'unknown' ? m.recoveryUnknown : value?.decision && value.serverCleanup.state === 'pending' ? m.recoveryPending : missing && !value?.decision ? m.recoveryRequired : phase === 'completed' ? m.deletionCompleted : phase === 'pending' ? m.deletionPending : phase === 'failed' ? m.deletionFailed : phase === 'rejected' ? m.deletionRejected : phase === 'unavailable' ? m.deletionUnavailable : phase === 'submitting' ? m.deleting : m.deletionUnknown;
  return <section className="bot-deletion-status notice" aria-label={m.deletionStatus}>
    <strong>{record.name || record.id}</strong>
    <p role="status">{title}</p>
    {phase === 'settled' ? <p>{m.recoveryClosedDescription}</p> : null}
    {record.result && !terminal ? <dl><dt>{m.workerCleanup}</dt><dd>{missing ? m.recoveryUnverified : m.cleanupState(record.result.deletion.workerCleanup.state)}{record.result.deletion.workerCleanup.code ? <> <code>{record.result.deletion.workerCleanup.code}</code></> : null}</dd><dt>{m.serverCleanup}</dt><dd>{m.cleanupState(record.result.deletion.serverCleanup.state)}{record.result.deletion.serverCleanup.code ? <> <code>{record.result.deletion.serverCleanup.code}</code></> : null}</dd></dl> : null}
    {recovery?.phase === 'unknown' ? <p>{m.recoveryUnknownDescription}</p> : null}
    {recovery?.phase === 'unsupported' ? <p>{m.recoveryUnsupported}</p> : null}
    {recovery?.phase === 'rejected' ? <p role="alert">{m.recoveryRejected}</p> : null}
    {value?.decision ? <details className="bot-recovery-details"><summary>{m.recoveryDecision}</summary><dl><dt>{m.recoveryDecidedAt}</dt><dd><time dateTime={value.decision.acknowledgedAt}>{value.decision.acknowledgedAt}</time></dd><dt>{m.recoveryActor}</dt><dd><code>{value.decision.actorUserId}</code></dd><dt>{m.recoveryReason}</dt><dd>{value.decision.reason}</dd></dl></details> : null}
    {record.error instanceof ApiError && recovery?.phase !== 'unsupported' ? <p role="alert">{record.error.message}{record.error.requestId ? <> <code>{record.error.requestId}</code></> : null}</p> : null}
    {!terminal && phase !== 'rejected' && <button type="button" className="button" disabled={!enabled || record.busy} onClick={() => void onCheck(record.id)}>{record.busy ? m.checking : m.checkDeletion}</button>}
    {['unknown','failed'].includes(phase) && !missing && !value?.decision && record.request !== null && <button type="button" className="button" disabled={!enabled || record.busy} onClick={() => void coordinator.retry(record.id)}>{m.retryDeletion}</button>}
    {value?.recoveryRequired && recovery?.phase !== 'unknown' ? <button type="button" className="button" disabled={!enabled || record.busy || record.error !== null} onClick={event => setDialog({ opener: event.currentTarget, version: value.version })}>{m.recoverDeletion}</button> : null}
    {(value?.decision && value.serverCleanup.state !== 'completed' && recovery?.phase !== 'unknown' || recovery?.phase === 'unknown' && recovery.request !== null) ? <button type="button" className="button" disabled={!enabled || record.busy} onClick={() => void coordinator.retryRecovery(record.id)}>{recovery?.phase === 'unknown' ? m.recoveryRetryOriginal : m.recoveryRetryCleanup}</button> : null}
    {dialog && value?.recoveryRequired ? createPortal(<BotRecoveryDialog botId={record.id} workerId={value.hostingWorkerId} workerName={workerName} opener={dialog.opener} enabled={enabled && !record.busy && record.error === null} onClose={() => setDialog(null)} onConfirm={reason => { const version = dialog.version; setDialog(null); void coordinator.resolveRecovery(record.id, reason, version); }} />, document.body) : null}
  </section>;
}
