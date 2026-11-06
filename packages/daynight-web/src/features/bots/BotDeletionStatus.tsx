import { ApiError } from '../../api/client';
import type { BotDeletionCoordinator } from './deletion-coordinator';
import { useBotMessages } from './messages';

type Record = ReturnType<BotDeletionCoordinator['snapshot']>[number];
export function BotDeletionStatus({ record, coordinator, enabled }: { readonly record: Record; readonly coordinator: BotDeletionCoordinator; readonly enabled: boolean }) {
  const m = useBotMessages();
  const phase = record.phase;
  return <section className="bot-deletion-status notice" aria-label={m.deletionStatus}>
    <strong>{record.name || record.id}</strong>
    <p role="status">{phase === 'completed' ? m.deletionCompleted : phase === 'pending' ? m.deletionPending : phase === 'failed' ? m.deletionFailed : phase === 'rejected' ? m.deletionRejected : phase === 'unavailable' ? m.deletionUnavailable : phase === 'submitting' ? m.deleting : m.deletionUnknown}</p>
    {record.result && phase !== 'completed' ? <dl><dt>{m.workerCleanup}</dt><dd>{m.cleanupState(record.result.deletion.workerCleanup.state)}{record.result.deletion.workerCleanup.code ? <> <code>{record.result.deletion.workerCleanup.code}</code></> : null}</dd><dt>{m.serverCleanup}</dt><dd>{m.cleanupState(record.result.deletion.serverCleanup.state)}{record.result.deletion.serverCleanup.code ? <> <code>{record.result.deletion.serverCleanup.code}</code></> : null}</dd></dl> : null}
    {record.error instanceof ApiError ? <p role="alert">{record.error.message}{record.error.requestId ? <> <code>{record.error.requestId}</code></> : null}</p> : null}
    {!['completed', 'rejected'].includes(phase) && <button type="button" className="button" disabled={!enabled || record.busy} onClick={() => void coordinator.check(record.id)}>{record.busy ? m.checking : m.checkDeletion}</button>}
    {['unknown','failed'].includes(phase) && record.request !== null && <button type="button" className="button" disabled={!enabled || record.busy} onClick={() => void coordinator.retry(record.id)}>{m.retryDeletion}</button>}
  </section>;
}
