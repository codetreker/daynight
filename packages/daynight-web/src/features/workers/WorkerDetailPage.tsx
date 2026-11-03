import type { ReactNode } from 'react';
import type { WorkerExecutableProbe, WorkerHerdrProbe, WorkerProbe, WorkerTaskSnapshot } from '../../api/workers';
import type { WorkerAgent } from '../../api/types';
import { taskDetailUrl } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { isWorkerOnline, isWorkerRecent } from './observation';
import { useWorker } from './useWorker';
import { WorkerStatusBadge } from './WorkerStatusBadge';
import { followWorkerLink, formatWorkerBytes, WorkerReadNotice, WorkerReadState, WorkerRefresh, WorkerTimestamp } from './presentation';
import './workers.css';

const agentNames: Readonly<Record<WorkerAgent, string>> = { codex: 'Codex', claude: 'Claude Code', copilot: 'Copilot' };

const ProbeFailure = ({ probe, software = false }: { readonly probe: Extract<WorkerProbe<unknown>, { state: 'error' }>; readonly software?: boolean }) => {
  const { messages: { workers: m } } = useI18n();
  return <><span className="worker-probe-error">{software ? m.detectionError : m.collectionError}</span><span className="worker-probe-reason">{m.probeCodes[probe.code]}</span></>;
};

const CheckedAt = ({ value }: { readonly value: string }) => {
  const { messages: { workers: m } } = useI18n();
  return <p className="worker-checked-at">{m.checkedAt}: <WorkerTimestamp value={value} /></p>;
};

const Meter = ({ value, label, high = false }: { readonly value: number; readonly label: string; readonly high?: boolean }) => <div className={`worker-meter${high ? ' high' : ''}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}><span style={{ width: `${value}%` }} /></div>;

const MetricCard = ({ title, children, checkedAt }: { readonly title: string; readonly children: ReactNode; readonly checkedAt: string }) => <section className="worker-metric-card"><h2 className="worker-metric-label">{title}</h2>{children}<CheckedAt value={checkedAt} /></section>;

const SoftwareRow = ({ name, probe }: { readonly name: string; readonly probe: WorkerExecutableProbe | WorkerHerdrProbe }) => {
  const { messages: { workers: m } } = useI18n();
  return <div className="worker-info-row"><dt>{name}</dt><dd>
    {probe.state === 'ok' ? <span className="worker-software-version">{probe.value}</span> : probe.state === 'error' ? <ProbeFailure probe={probe} software /> : <span className="worker-software-unavailable">{probe.state === 'not_installed' ? m.notInstalled : m.notRunning}</span>}
    <CheckedAt value={probe.checkedAt} />
  </dd></div>;
};

const TaskRows = ({ tasks }: { readonly tasks: readonly WorkerTaskSnapshot[] }) => {
  const { messages: { workers: m, common, inspection: { claim } } } = useI18n();
  return <table className="worker-task-table"><thead><tr><th scope="col">{m.taskColumn}</th><th scope="col">{m.statusColumn}</th><th scope="col">{m.agentColumn}</th></tr></thead><tbody>
    {tasks.map(task => <tr key={`${task.projectId}/${task.taskId}/${task.claimId}`}><td><a className="worker-task-title" href={taskDetailUrl(task.projectId, task.taskId, { tab: 'overview', path: null })} onClick={followWorkerLink}>{task.title}</a><p className="worker-task-project">{task.projectName} · <span title={task.taskId}>{task.taskId.slice(0, 8)}</span></p></td>
      <td><span className="worker-task-status">{common.status[task.status]}</span><p className="worker-task-phase">{claim.phase[task.phase]}</p></td><td>{agentNames[task.agent]}</td></tr>)}
  </tbody></table>;
};

export const WorkerDetailPage = ({ workerId, readEnabled }: { readonly workerId: string; readonly readEnabled: boolean }) => {
  const state = useWorker(workerId, { readEnabled });
  const { messages: { workers: m, platform }, locale, format } = useI18n();
  const { snapshot, serverMilliseconds } = state;
  if (snapshot !== null && serverMilliseconds === null) throw new Error('A Worker snapshot requires its server observation time.');
  const worker = snapshot?.worker;
  const recent = worker !== undefined && isWorkerRecent(worker, serverMilliseconds!);
  const online = worker !== undefined && isWorkerOnline(worker, serverMilliseconds!);
  const unavailable = snapshot !== null && !recent;
  const taskSnapshot = !online || state.stale || worker?.taskObservationState === 'stale';
  const bytes = (value: number) => formatWorkerBytes(value, locale);
  const percent = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  return <div className="worker-page">
    <a className="worker-back-link" href="/workers" onClick={followWorkerLink}>← {m.back}</a>
    {worker === undefined || unavailable ? <WorkerReadState kind="detail" {...state} status={unavailable ? 'unavailable' : state.status} readEnabled={readEnabled} /> : <>
      <div className="page-heading worker-detail-heading"><div><h1 id="page-title" tabIndex={-1}>{worker.machine.name}</h1>
        <div className="worker-description"><WorkerStatusBadge online={online} stale={state.stale} /><span>{platform.names[worker.platform]}</span><span>{m.lastReported}: <WorkerTimestamp value={worker.lastReportedAt} /> (<WorkerTimestamp value={worker.lastReportedAt} serverMilliseconds={serverMilliseconds!} />)</span></div>
        <p className="worker-id">{m.workerId} · {worker.workerId}</p></div><div className="heading-actions"><WorkerRefresh refresh={state.refresh} refreshing={state.refreshing} readEnabled={readEnabled} /></div></div>
      <WorkerReadNotice {...state} observedAt={snapshot!.observedAt} readEnabled={readEnabled} />
      {!online && <section className="worker-snapshot-notice" role="status"><span aria-hidden="true">◷</span><div><p>{m.offlineNotice}</p><p>{m.lastReported}: <WorkerTimestamp value={worker.lastReportedAt} /> · {m.offlineDetail}</p></div></section>}
      <p className="worker-sample-time">{m.sampledAt}: <WorkerTimestamp value={worker.telemetry.sampledAt} /></p>
      <div className="worker-metric-grid">
        <MetricCard title={m.cpuUsage} checkedAt={worker.telemetry.cpu.checkedAt}>{worker.telemetry.cpu.state === 'error' ? <ProbeFailure probe={worker.telemetry.cpu} /> : <>
          <p className="worker-metric-value">{percent(worker.telemetry.cpu.value.usagePercent)}<span className="worker-metric-unit">%</span></p><Meter value={worker.telemetry.cpu.value.usagePercent} label={m.cpuUsage} /><p className="worker-metric-detail">{worker.telemetry.cpu.value.model} · {m.logicalProcessors({ count: format.number(worker.telemetry.cpu.value.logicalProcessors) })}</p>
        </>}</MetricCard>
        <MetricCard title={m.memory} checkedAt={worker.telemetry.memory.checkedAt}>{worker.telemetry.memory.state === 'error' ? <ProbeFailure probe={worker.telemetry.memory} /> : <>
          <p className="worker-metric-value">{bytes(worker.telemetry.memory.value.usedBytes)}<span className="worker-metric-unit">{m.usedCapacity({ total: bytes(worker.telemetry.memory.value.totalBytes) })}</span></p>
          {worker.telemetry.memory.value.totalBytes > 0 && <Meter value={worker.telemetry.memory.value.usedBytes / worker.telemetry.memory.value.totalBytes * 100} label={m.memory} />}<p className="worker-metric-detail">{m.totalMemory({ total: bytes(worker.telemetry.memory.value.totalBytes) })}</p>
        </>}</MetricCard>
        <MetricCard title={m.disk} checkedAt={worker.telemetry.disk.checkedAt}>{worker.telemetry.disk.state === 'error' ? <ProbeFailure probe={worker.telemetry.disk} /> : <>
          <p className="worker-metric-value">{bytes(worker.telemetry.disk.value.availableBytes)}<span className="worker-metric-unit">{m.availableCapacity({ total: bytes(worker.telemetry.disk.value.totalBytes) })}</span></p>
          {worker.telemetry.disk.value.totalBytes > 0 && <Meter value={(worker.telemetry.disk.value.totalBytes - worker.telemetry.disk.value.availableBytes) / worker.telemetry.disk.value.totalBytes * 100} label={m.disk} high={worker.telemetry.disk.value.availableBytes / worker.telemetry.disk.value.totalBytes < .2} />}<p className="worker-metric-detail">{m.totalDisk({ total: bytes(worker.telemetry.disk.value.totalBytes) })}</p>
        </>}</MetricCard>
      </div>
      <div className="worker-detail-columns">
        <section className="worker-panel"><h2 className="worker-panel-heading">{m.environment}</h2><dl className="worker-info-list">
          <div className="worker-info-row"><dt>{m.operatingSystem}</dt><dd>{worker.telemetry.os.state === 'error' ? <ProbeFailure probe={worker.telemetry.os} /> : <>{worker.telemetry.os.value.type}<br />{worker.telemetry.os.value.release}<br /><span className="worker-os-version">{worker.telemetry.os.value.version}</span></>}<CheckedAt value={worker.telemetry.os.checkedAt} /></dd></div>
          <div className="worker-info-row"><dt>{m.architecture}</dt><dd>{worker.telemetry.os.state === 'error' ? <ProbeFailure probe={worker.telemetry.os} /> : worker.telemetry.os.value.arch}</dd></div>
          <div className="worker-info-row"><dt>{m.cpu}</dt><dd>{worker.telemetry.cpu.state === 'error' ? <ProbeFailure probe={worker.telemetry.cpu} /> : <>{worker.telemetry.cpu.value.model}<br />{m.logicalProcessors({ count: format.number(worker.telemetry.cpu.value.logicalProcessors) })}</>}</dd></div>
          <div className="worker-info-row"><dt>{m.workingDirectory}</dt><dd>{worker.telemetry.workingDirectory}</dd></div>
        </dl></section>
        <section className="worker-panel"><h2 className="worker-panel-heading">{m.software}</h2><dl className="worker-info-list">
          <div className="worker-info-row"><dt>Daynight CLI</dt><dd className="worker-software-version">{worker.telemetry.versions.daynight}</dd></div>
          <SoftwareRow name="Herdr" probe={worker.telemetry.versions.herdr} /><SoftwareRow name="Codex" probe={worker.telemetry.versions.codex} /><SoftwareRow name="Copilot" probe={worker.telemetry.versions.copilot} />
        </dl></section>
      </div>
      <section className="worker-panel"><h2 className="worker-panel-heading"><span className="worker-task-heading-label" data-current-label={m.tasks}><span>{taskSnapshot ? m.tasksSnapshot : m.tasks}</span></span>{' '}
        {worker.activeTaskCount !== null && <span className="worker-count-badge">{format.number(worker.activeTaskCount)}</span>}{' '}
        <span className="worker-task-snapshot-caption" aria-hidden={!taskSnapshot}>{m.lastReportSnapshot}</span></h2>
        {worker.taskObservationState === 'unavailable' ? <p className="worker-task-empty">{m.tasksPending}</p> : <>
          <div className="worker-task-observation">{worker.taskObservationState === 'stale' && <p>{m.oldInventory}</p>}<p>{m.taskObservedAt}: <WorkerTimestamp value={worker.taskObservedAt!} /></p><p>{m.inventoryObservedAt}: <WorkerTimestamp value={worker.inventoryObservedAt!} /></p></div>
          {worker.tasks.length > 0 ? <TaskRows tasks={worker.tasks} /> : <p className="worker-task-empty">{taskSnapshot ? m.snapshotIdle : m.idle}</p>}
        </>}
      </section><p className="worker-detail-footnote">{m.footer}</p>
    </>}
  </div>;
};
