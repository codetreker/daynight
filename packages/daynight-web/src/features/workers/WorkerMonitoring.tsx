import type { MonitoringAssociation, MonitoringScope, WorkerMonitoringDetail } from '../../api/worker-monitoring';
import { ApiError } from '../../api/client';
import { taskDetailUrl } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { monitoringMessages } from './monitoring-messages';
import { followWorkerLink, WorkerTimestamp } from './presentation';
import type { WorkerReadState } from './useWorkerObservation';
import type { WorkerMonitoringProjectedItem } from './useWorkerMonitoring';
import './monitoring.css';

const Age = ({ receivedAt, now }: { readonly receivedAt: string; readonly now: number }) => {
  const { locale } = useI18n();
  const m = monitoringMessages(locale);
  const age = Math.max(0, now - Date.parse(receivedAt));
  return <>{age >= 3_600_000 ? m.expired : age >= 90_000 ? m.stale : m.observed} · <WorkerTimestamp value={receivedAt} serverMilliseconds={now} /></>;
};

const Association = ({ scope, association }: { readonly scope: MonitoringScope; readonly association: MonitoringAssociation }) => {
  const { locale } = useI18n();
  const m = monitoringMessages(locale);
  if (scope.kind === 'worker') return <>{m.worker}</>;
  if (scope.kind === 'project') return <>{association?.kind === 'project' ? association.projectName : `${m.project} · ${scope.projectId}`}</>;
  const title = association?.kind === 'task' ? association.title : `${m.task} · ${scope.taskId}`;
  return <><a href={taskDetailUrl(scope.projectId, scope.taskId, { tab: 'overview', path: null })} onClick={followWorkerLink}>{title}</a>{association?.kind === 'task' ? <> · {association.projectName}</> : <> · {m.labelsOmitted}</>}</>;
};

const Time = ({ label, value }: { readonly label: string; readonly value: string | null }) => {
  const { locale } = useI18n();
  return <><dt>{label}</dt><dd>{value === null ? monitoringMessages(locale).noTime : <WorkerTimestamp value={value} />}</dd></>;
};

const ErrorNotice = ({ state, readEnabled }: { readonly state: WorkerReadState<unknown>; readonly readEnabled: boolean }) => {
  const { locale } = useI18n();
  const m = monitoringMessages(locale);
  if (state.error === null) return null;
  return <section className="worker-sync-notice monitoring-notice" role="alert"><div><p className="worker-notice-title">{m.error}</p>{state.snapshot !== null && <p>{m.retained}</p>}{state.error instanceof ApiError && state.error.requestId !== null && <p>{m.requestId} · <code>{state.error.requestId}</code></p>}</div><button className="button" type="button" onClick={state.refresh} disabled={!readEnabled || state.refreshing}>{m.retry}</button></section>;
};

export const MonitoringCard = ({ item, now, expired = false }: { readonly item: WorkerMonitoringProjectedItem | null; readonly now: number | null; readonly expired?: boolean }) => {
  const { locale } = useI18n();
  const m = monitoringMessages(locale);
  if (item === null) return <p className="monitoring-card-state">{m.monitoringAge}: {m.noData}</p>;
  if (item.state === 'absent') return <p className="monitoring-card-state">{expired ? m.expired : m.absent}</p>;
  if (now === null) return <p className="monitoring-card-state">{m.unknown}</p>;
  if (now - Date.parse(item.receivedAt) >= 3_600_000) return <p className="monitoring-card-state">{m.expired}</p>;
  const s = item.summary;
  const admission = s.admission;
  const codes = admission?.reasonCodes.filter(code => code !== 'no-ready-tasks' || admission.coverage === 'complete') ?? [];
  return <div className="monitoring-card-state"><strong>{m.labels[s.scheduler.phase]}</strong><span>{s.capacity === null ? m.capacityUnknown : `${m.capacity}: ${s.capacity.occupied} / ${s.capacity.limit} ${m.occupied}${s.capacity.quality === 'stale' ? ` · ${m.stale}` : ''}`}</span>
    <span>{codes.length === 0 ? m.summaryReasonsUnknown : codes.map(code => m.labels[code]).join(' · ')}</span>
    {admission !== null && <small>{m.admission}: <WorkerTimestamp value={admission.observedAt} />{admission.coverage !== 'complete' ? ` · ${m.labels[admission.coverage]}` : ''}{admission.permissionProjection === 'restricted' ? ` · ${m.summaryRestricted}` : ''}</small>}
    <small><Age receivedAt={item.receivedAt} now={now} /></small></div>;
};

export const MonitoringListError = ({ state, readEnabled }: { readonly state: WorkerReadState<unknown>; readonly readEnabled: boolean }) => <ErrorNotice state={state} readEnabled={readEnabled} />;

export const WorkerMonitoring = ({ state, readEnabled }: { readonly state: WorkerReadState<WorkerMonitoringDetail> & { readonly expired?: boolean }; readonly readEnabled: boolean }) => {
  const { locale, format } = useI18n();
  const m = monitoringMessages(locale);
  const data = state.snapshot;
  const now = state.serverMilliseconds;
  const expired = state.expired === true || data?.state === 'available' && now !== null && now - Date.parse(data.receivedAt) >= 3_600_000;
  if (data === null) return <section className="worker-panel monitoring-empty"><ErrorNotice state={state} readEnabled={readEnabled} /><h2>{state.status === 'loading' ? m.loading : m.unknown}</h2></section>;
  if (data.state === 'absent' || expired) return <section className="worker-panel monitoring-empty"><ErrorNotice state={state} readEnabled={readEnabled} /><h2>{expired ? m.expired : m.absent}</h2><p>{m.absentDetail}</p></section>;
  const observation = data.data;
  const label = (value: string) => m.labels[value] ?? m.unknown;
  const incomplete = data.permissionProjection === 'restricted' || data.detailCoverage === 'partial';
  return <div className="monitoring-content">
    <ErrorNotice state={state} readEnabled={readEnabled} />
    <p className="monitoring-time">{now === null ? m.observed : <Age receivedAt={data.receivedAt} now={now} />} · {m.captured}: <WorkerTimestamp value={observation.capturedAt} /></p>
    {data.permissionProjection === 'restricted' && <p className="monitoring-projection">{m.restricted}</p>}
    {(data.detailCoverage === 'partial' || observation.admission.coverage === 'partial' || observation.capacity?.detailCoverage === 'partial') && <p className="monitoring-projection">{m.partial}</p>}
    <div className="monitoring-grid">
      <section className="monitoring-card" data-worker-reading><h2>{m.phase}</h2><p className="monitoring-value">{label(observation.scheduler.phase)}</p><p>{label(observation.lifecycle)} · {m.quality}: {label(observation.scheduler.coverage)}</p><dl><Time label={m.lastSuccess} value={observation.scheduler.lastSuccessfulAt} /><Time label={m.lastCompleted} value={observation.scheduler.lastCompletedAt} /><dt>{m.lastOutcome}</dt><dd>{observation.scheduler.lastOutcome === null ? m.noTime : label(observation.scheduler.lastOutcome)}</dd><Time label={m.nextPoll} value={observation.scheduler.nextPollAt} /></dl></section>
      <section className="monitoring-card" data-worker-reading><h2>{m.capacity}</h2>{observation.capacity === null ? <p>{m.capacityUnknown}</p> : <><p className="monitoring-value">{format.number(observation.capacity.occupied)} / {format.number(observation.capacity.limit)} <small>{m.occupied}</small></p><p>{format.number(observation.capacity.available)} {m.available}</p>{observation.capacity.quality === 'stale' && <p>{m.capacityStale}</p>}<dl><Time label={m.observed} value={observation.capacity.observedAt} /></dl></>}</section>
      <section className="monitoring-card" data-worker-reading><h2>{m.admission}</h2><p>{m.quality}: {label(observation.admission.coverage)}</p>{observation.admission.reasons.length === 0 ? <p>{incomplete || observation.admission.coverage !== 'complete' ? m.incompleteReasons : m.noReason}</p> : <ul>{observation.admission.reasons.map((reason, index) => <li key={`${reason.code}-${index}`}>{label(reason.code)} · <Association scope={reason.scope} association={reason.association} />{reason.nextAttemptAt !== null && <> · {m.nextAttempt}: <WorkerTimestamp value={reason.nextAttemptAt} /></>}</li>)}</ul>}</section>
    </div>
    <section className="worker-panel monitoring-panel"><h2 className="worker-panel-heading">{m.reservations}</h2>{observation.reservations.length === 0 ? <p className="monitoring-empty-text">{incomplete || observation.capacity?.detailCoverage === 'partial' ? m.incompleteReservations : m.noReservations}</p> : <ul className="monitoring-reservations">{observation.reservations.map(reservation => <li key={reservation.reservationId} data-worker-reading><Association scope={reservation.scope} association={reservation.association} /> · {reservation.roles.map(label).join(' · ')} · {reservation.occupied ? m.occupied : m.notOccupied} · <WorkerTimestamp value={reservation.observedAt} /></li>)}</ul>}</section>
    <section className="worker-panel monitoring-panel"><h2 className="worker-panel-heading">{m.activities}</h2>{observation.activities.length === 0 ? <p className="monitoring-empty-text">{incomplete ? m.incompleteActivities : m.noActivities}</p> : <ul className="monitoring-activities">{observation.activities.map(activity => <li key={activity.operationId} data-worker-reading><div><strong>{label(activity.kind)} · {label(activity.phase)}</strong><p><Association scope={activity.scope} association={activity.association} /></p></div><div><span className="monitoring-chip">{label(activity.status)}</span>{activity.waitReason !== null && <p>{m.wait}: {label(activity.waitReason)}</p>}</div><dl><Time label={m.started} value={activity.startedAt} /><Time label={m.progress} value={activity.lastProgressAt} />{activity.deadlineAt !== null && <Time label={m.deadline} value={activity.deadlineAt} />}{activity.nextAttemptAt !== null && <Time label={m.nextAttempt} value={activity.nextAttemptAt} />}</dl></li>)}</ul>}</section>
    <section className="worker-panel monitoring-panel"><h2 className="worker-panel-heading">{m.failures}</h2>{observation.currentFailures.length === 0 ? <p className="monitoring-empty-text">{incomplete ? m.incompleteFailures : m.noFailures}</p> : observation.currentFailures.map(failure => <details className="monitoring-issue" data-worker-reading key={`${failure.component}-${failure.operationId}`}><summary><strong>{label(failure.component)} · {label(failure.phase)}</strong><span>{m.causes[failure.error.code]}</span></summary><dl><dt>{m.component} / {m.operation}</dt><dd>{label(failure.component)} · {label(failure.phase)}</dd><dt>{m.cause}</dt><dd>{m.causes[failure.error.code]}</dd><Time label={m.first} value={failure.firstObservedAt} /><Time label={m.last} value={failure.lastObservedAt} /><dt>{m.occurrences}</dt><dd>{format.number(failure.occurrencesInRun)}</dd><dt>{m.retryState}</dt><dd>{label(failure.retryState)}</dd>{failure.nextAttemptAt !== null && <Time label={m.nextAttempt} value={failure.nextAttemptAt} />}<dt>{m.task}</dt><dd><Association scope={failure.scope} association={failure.association} /></dd>{failure.worktree !== undefined && <><dt>{m.worktreePath}</dt><dd>{failure.worktree.kind === 'project-relative' ? <code className="monitoring-worktree">{failure.worktree.path}</code> : m.worktreeUnavailable[failure.worktree.reason]}</dd></>}</dl></details>)}</section>
    <section className="worker-panel monitoring-panel" data-worker-reading><h2 className="worker-panel-heading">{m.recovery}</h2>{observation.lastRecovery === null ? <p className="monitoring-empty-text">{incomplete ? m.incompleteRecovery : m.noRecovery}</p> : <div className="monitoring-empty-text"><strong>{label(observation.lastRecovery.component)} · {m.recovered}</strong><p><Association scope={observation.lastRecovery.scope} association={observation.lastRecovery.association} /> · <WorkerTimestamp value={observation.lastRecovery.observedAt} /></p></div>}</section>
    <section className="worker-panel monitoring-panel" data-worker-reading><h2 className="worker-panel-heading">{m.delivery}</h2><dl className="monitoring-delivery"><Time label={m.deliverySuccess} value={observation.delivery.lastSucceededAt} />{observation.delivery.lastFailure !== null && <><dt>{m.deliveryFailure}</dt><dd>{label(observation.delivery.lastFailure.phase)} · {m.causes[observation.delivery.lastFailure.error.code]} · <WorkerTimestamp value={observation.delivery.lastFailure.observedAt} />{observation.delivery.lastFailure.requestId !== null && <> · {m.requestId}: {observation.delivery.lastFailure.requestId}</>}</dd></>}</dl></section>
  </div>;
};
