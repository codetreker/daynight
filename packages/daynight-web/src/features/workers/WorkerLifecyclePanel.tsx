import { useId, useState } from 'react';
import { ApiError } from '../../api/client';
import type { WorkerSummary } from '../../api/workers';
import { useI18n } from '../../i18n/LocaleProvider';
import { workerLifecycleMessages } from '../../i18n/worker-lifecycle';
import { ManagementDialog } from '../management/ManagementDialog';
import { WorkerTimestamp } from './presentation';
import { useWorkerLifecycle } from './useWorkerLifecycle';
import { lifecycleFacts } from './lifecycle-facts';
export { lifecycleFacts } from './lifecycle-facts';
import './worker-lifecycle.css';

export const WorkerLifecyclePanel = ({ worker, readEnabled, compact = false }: { readonly worker: WorkerSummary; readonly readEnabled: boolean; readonly compact?: boolean }) => {
  const state = useWorkerLifecycle(worker.workerId, { readEnabled });
  const { locale, format } = useI18n(), m = workerLifecycleMessages[locale];
  const id = useId();
  const [confirm, setConfirm] = useState<'disable' | 'resume' | null>(null);
  const resource = state.snapshot, envelope = resource?.observation ?? null, observation = envelope?.observation ?? null;
  const denied = state.error instanceof ApiError && state.error.kind === 'server' && (state.error.status === 401 || state.error.status === 403)
    || state.operationError === 'forbidden' || state.operationError === 'unauthenticated';
  const observedFacts = lifecycleFacts(resource, state.serverMilliseconds, state.stale || denied);
  const facts = state.pending === null ? observedFacts : { ...observedFacts, disabled: false, accepting: false,
    phase: state.pending.action === 'resume' && state.operationError !== 'unknown' ? 'resuming' as const : 'awaiting' as const };
  const unsupported = state.status === 'unavailable' || resource?.capability === 'unsupported';
  const hasAccess = readEnabled && state.status !== 'unavailable' && !state.stale && !denied && state.operationError !== 'storage';
  const mayDisable = hasAccess && resource?.capability === 'supported' && resource.desired === 'enabled' && state.pending === null && !state.busy;
  const mayResume = hasAccess && resource?.capability === 'supported' && facts.resumeEligible && state.pending === null && !state.busy;
  const unknown = state.pending !== null && state.operationError !== 'accepted';
  const count = (value: number | null | undefined) => value == null ? m.unknown : format.number(value);
  const phase = resource === null ? null : m[facts.phase];
  const stage = (value: string | null | undefined) => {
    if (value === 'failed') return m.error;
    if (value === 'unknown') return m.unknown;
    if (value === 'pending') return m.pending;
    if (value === 'not_started') return m.not_started;
    if (value === 'stopping') return m.stopping;
    if (value === 'confirmed') return m.confirmed;
    if (value === 'durable') return m.durable;
    if (value === 'complete') return m.complete;
    return m.unknown;
  };
  const errorMessage = state.operationError === 'version_conflict' || state.operationError === 'operation_conflict' ? m.conflict
    : state.operationError === 'forbidden' || state.operationError === 'unauthenticated' ? m.denied
      : state.operationError === 'storage' ? m.storage : state.operationError === 'not_committed' ? m.notCommitted : m.rejected;
  const confirmAllowed = confirm === 'disable' ? mayDisable : mayResume;
  const submit = () => {
    if (confirm === null || !confirmAllowed) return;
    const action = confirm;
    setConfirm(null);
    void state.submit(action);
  };
  return <section className={`worker-lifecycle${compact ? ' worker-lifecycle-compact' : ''}`} aria-labelledby={`${id}-title`}>
    <div className="worker-lifecycle-header"><h2 id={`${id}-title`}>{m.title}</h2><span className="worker-lifecycle-state" role="status" aria-live="polite">{phase ?? (unsupported ? m.unavailable : state.status === 'loading' ? m.loading : m.awaiting)}</span></div>
    {resource !== null && !facts.fresh && envelope !== null && <p className="worker-lifecycle-warning">{m.stale}</p>}
    {unsupported && <p className="worker-lifecycle-muted">{m.unavailable}</p>}
    {state.error !== null && !unsupported && <p className="notice error" role="alert">{m.failed}</p>}
    {unknown && <div className="worker-lifecycle-warning" role="status"><p>{m.unknownWrite}</p><p>{m.operation}: <code>{state.pending?.operationId}</code></p></div>}
    {state.operationError === 'accepted' && <p role="status">{m.accepted}</p>}
    {state.operationError !== null && state.operationError !== 'accepted' && !unknown && <p className="notice error" role="alert">{errorMessage}</p>}
    {!compact && resource !== null && <>
      <ol className="worker-lifecycle-stages">
        <li><strong>{m.intent}</strong><span>{resource.admission === 'closed' ? m.closed : m.open}</span></li>
        <li><strong>{m.execution}</strong><span>{stage(observation?.stop)}</span></li>
        <li><strong>{m.save}</strong><span>{stage(observation?.save)}</span></li>
        <li><strong>{m.sync}</strong><span>{stage(observation?.sync)}</span></li>
      </ol>
      <p className="worker-lifecycle-facts"><span>{m.inventory}: {count(observation?.resourceCount)}</span><span>{m.stopped}: {count(observation?.stoppedCount)}</span><span>{m.pendingCount}: {count(observation?.pendingCount)}</span><span>{m.blockedCount}: {count(observation?.blockedCount)}</span></p>
      {observation !== null && <p className="worker-lifecycle-muted">{m.current}: <WorkerTimestamp value={observation.receivedAt} /></p>}
      {observation?.inventoryComplete === false && <p className="worker-lifecycle-warning">{m.incomplete}</p>}
      {facts.fresh && observation?.inventoryComplete === true && observation.resourceCount === 0 && <p>{m.empty}</p>}
      {observation?.detailsComplete === false && <p className="worker-lifecycle-muted">{m.partial}</p>}
      {facts.disabled && <div className="worker-lifecycle-safe"><p>{m.safe}</p><p>{m.scope}</p></div>}
      {facts.disabled && observation?.sync !== 'complete' && <p className="worker-lifecycle-warning">{m.syncPending}</p>}
      {observation?.stop === 'confirmed' && observation.save === 'failed' && <p className="worker-lifecycle-warning">{m.diagnostics.save_failed}</p>}
      {facts.accepting && observation?.recovery.some(entry => entry.recoverability !== 'eligible') && <p className="worker-lifecycle-warning">{m.partialRecovery}</p>}
      {observation !== null && (observation.resources.length > 0 || observation.recovery.length > 0) && <details><summary>{m.details}</summary><ul className="worker-lifecycle-resources">
        {observation.resources.map(entry => <li key={entry.resourceId}><code>{entry.resourceId}</code> · {m.owners[entry.ownerKind]}<br />{m.execution}: {stage(entry.stop)} · {m.save}: {stage(entry.save)}{entry.errorCode !== null && <p>{m.diagnostics[entry.errorCode]}</p>}</li>)}
        {observation.recovery.map(entry => <li key={`recovery:${entry.resourceId}`}><code>{entry.resourceId}</code> · {m.recovery}: {entry.recoverability === 'eligible' ? m.eligible : entry.recoverability === 'blocked' ? m.recoveryBlocked : m.unknown}{entry.reasonCode !== null && <p>{m.diagnostics[entry.reasonCode]}</p>}</li>)}
      </ul></details>}
      {observation?.errorCode != null && <p className="notice error" role="alert">{m.diagnostics[observation.errorCode]}</p>}
    </>}
    <div className="worker-lifecycle-actions">
      <button className="button secondary" type="button" disabled={!mayDisable} aria-describedby={`${id}-reason`} onClick={() => setConfirm('disable')}>{m.disable}</button>
      {(resource?.desired === 'disabled' || facts.resumeEligible) && <button className="button primary" type="button" disabled={!mayResume} aria-describedby={`${id}-reason`} onClick={() => setConfirm('resume')}>{m.resume}</button>}
      <button className="button secondary" type="button" disabled={!readEnabled || state.busy} onClick={() => void state.check()}>{state.pending !== null ? m.check : m.refresh}</button>
    </div>
    <p id={`${id}-reason`} className="worker-lifecycle-muted">{denied ? m.denied : !readEnabled ? m.readOnly : unsupported ? m.unavailable : state.operationError === 'storage' ? m.storage : state.stale ? m.failed : resource?.desired === 'disabled' && !facts.disabled ? m.waitingResume : !mayDisable && !mayResume && !unknown ? m.waitingDisable : ''}</p>
    {confirm !== null && <ManagementDialog className="worker-lifecycle-dialog" title={confirm === 'disable' ? m.disable : m.resume} initialFocus="cancel" onClose={() => setConfirm(null)} footer={<>
      <button className="button secondary" data-dialog-cancel type="button" onClick={() => setConfirm(null)}>{m.cancel}</button>
      <button className="button primary" type="button" disabled={!confirmAllowed} onClick={submit}>{m.confirm}</button>
    </>}>
      <dl><dt>{m.identity}</dt><dd><bdi>{worker.alias?.value ?? worker.machine.name}</bdi><br /><code>{worker.workerId}</code></dd><dt>{m.machine}</dt><dd><bdi>{worker.machine.name}</bdi></dd><dt>{m.report}</dt><dd><WorkerTimestamp value={worker.lastReportedAt} /></dd><dt>{m.tasks}</dt><dd>{worker.taskObservationState === 'observed' ? count(worker.activeTaskCount) : m.unknown}</dd><dt>{m.bots}</dt><dd>{m.unknown}</dd><dt>{m.inventory}</dt><dd>{count(observation?.resourceCount)}</dd></dl>
      {observation !== null && <p className="worker-lifecycle-muted">{m.current}: <WorkerTimestamp value={observation.receivedAt} />{!facts.fresh && <> · {m.stale}</>}</p>}
      <p>{confirm === 'disable' ? m.impact : m.resumeImpact}</p><p>{m.leases}</p><p>{m.isolation}</p>
    </ManagementDialog>}
  </section>;
};
