import { ApiError } from '../../api/client';
import type { BotDeletionCoordinator } from './deletion-coordinator';
import { useBotMessages } from './messages';

type Record = ReturnType<BotDeletionCoordinator['snapshot']>[number];
export function BotDeletionStatus({ record, coordinator, onCheck, enabled, workerName }: { readonly record: Record; readonly coordinator: BotDeletionCoordinator; readonly onCheck: (id: string) => Promise<void>; readonly enabled: boolean; readonly workerName?: string | undefined }) {
  const m = useBotMessages();
  const phase = record.phase;
  const recovery = record.recovery, value = recovery?.value, missing = record.result?.deletion.workerCleanup.code === 'execution_evidence_missing';
  const terminal = phase === 'completed' || phase === 'settled';
  const title = phase === 'settled' ? m.recoverySettled : value?.decision && value.serverCleanup.state === 'pending' ? m.recoveryPending : missing && !value?.decision ? m.recoveryRequired : phase === 'completed' ? m.deletionCompleted : phase === 'pending' ? m.deletionPending : phase === 'failed' ? m.deletionFailed : phase === 'rejected' ? m.deletionRejected : phase === 'unavailable' ? m.deletionUnavailable : phase === 'submitting' ? m.deleting : m.deletionUnknown;
  return <section className="bot-deletion-status notice" aria-label={m.deletionStatus}>
    <strong>{record.name || record.id}</strong>
    <p role="status">{title}</p>
    {phase === 'settled' ? <p>{m.recoveryClosedDescription}</p> : null}
    {record.result && !terminal ? <dl><dt>{m.workerCleanup}</dt><dd>{missing ? m.recoveryUnverified : m.cleanupState(record.result.deletion.workerCleanup.state)}{record.result.deletion.workerCleanup.code ? <> <code>{record.result.deletion.workerCleanup.code}</code></> : null}</dd><dt>{m.serverCleanup}</dt><dd>{m.cleanupState(record.result.deletion.serverCleanup.state)}{record.result.deletion.serverCleanup.code ? <> <code>{record.result.deletion.serverCleanup.code}</code></> : null}</dd></dl> : null}
    {recovery?.phase === 'unsupported' ? <p>{m.recoveryUnsupported}</p> : null}
    {value?.decision ? <details className="bot-recovery-details"><summary>{m.recoveryDecision}</summary><dl><dt>{m.recoveryDecidedAt}</dt><dd><time dateTime={value.decision.acknowledgedAt}>{value.decision.acknowledgedAt}</time></dd><dt>{m.recoveryActor}</dt><dd><code>{value.decision.actorUserId}</code></dd><dt>{m.recoveryReason}</dt><dd>{value.decision.reason}</dd></dl></details> : null}
    {record.error instanceof ApiError && recovery?.phase !== 'unsupported' ? <p role="alert">{record.error.message}{record.error.requestId ? <> <code>{record.error.requestId}</code></> : null}</p> : null}
    {!terminal && phase !== 'rejected' && <button type="button" className="button" disabled={!enabled || record.busy} onClick={() => void onCheck(record.id)}>{record.busy ? m.checking : m.checkDeletion}</button>}
    {['unknown','failed'].includes(phase) && !missing && !value?.decision && record.request !== null && <button type="button" className="button" disabled={!enabled || record.busy} onClick={() => void coordinator.retry(record.id)}>{m.retryDeletion}</button>}
    {value && (value.recoveryRequired || value.decision) && !terminal ? <details className="bot-recovery-instructions"><summary>{m.recoveryInstructions}</summary>
      <p><strong>{m.worker}</strong><br />{workerName ? <>{workerName}<br /></> : null}<code>{value.hostingWorkerId}</code></p>
      {value.decision ? <>
        <p>{m.recoveryRetry}</p>
        <p><code>daynight bot deletion inspect {record.id} --server-only --json</code></p>
        <p><code>daynight bot deletion retry-cleanup {record.id} --if-version &lt;version&gt; --deletion-id {value.deletionId} --operation-id {value.decision.operationId}</code></p>
      </> : <>
        <p>{m.recoveryPrepare}</p>
        <p>{m.recoveryInspect}<br /><code>daynight bot deletion inspect {record.id}</code></p>
        <p>{m.recoveryRecover}<br /><code>daynight bot deletion recover {record.id} --deletion-id {value.deletionId}</code></p>
        <p>{m.recoveryMissing}<br /><code>daynight bot deletion resolve --help</code></p>
        <p>{m.recoveryWarning}</p>
      </>}
      <p>{m.recoveryReconcile}<br /><code>daynight bot deletion inspect {record.id} --server-only --json</code></p>
    </details> : null}
  </section>;
}
