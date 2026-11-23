import { useCallback, useId, useLayoutEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { WorkerTaskSnapshot } from '../../api/workers';
import type { WorkerAgent } from '../../api/types';
import { useWorkerHistory } from '../../app/use-page-history';
import { taskDetailUrl } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { isWorkerOnline, isWorkerRecent } from './observation';
import { useWorker } from './useWorker';
import { WorkerStatusBadge } from './WorkerStatusBadge';
import { followWorkerLink, WorkerReadNotice, WorkerReadState, WorkerRefresh, WorkerTimestamp } from './presentation';
import { WorkerEditingPanels } from './configuration/WorkerEditingPanels';
import { WorkerMonitoring, WorkerMonitoringTime } from './WorkerMonitoring';
import { WorkerSystemSnapshot } from './WorkerSystemSnapshot';
import { useWorkerPageAnchor } from './useWorkerPageAnchor';
import { useWorkerMonitoring } from './useWorkerMonitoring';
import type { WorkerAlias } from '../../api/worker-alias';
import { WorkerAliasEditor } from './WorkerAliasEditor';
import './workers.css';
import { WorkerLifecyclePanel } from './WorkerLifecyclePanel';

const sections = ['overview', 'system', 'configuration', 'prompt'] as const;

const agentNames: Readonly<Record<WorkerAgent, string>> = { codex: 'Codex', claude: 'Claude Code', copilot: 'Copilot' };

const TaskRows = ({ tasks }: { readonly tasks: readonly WorkerTaskSnapshot[] }) => {
  const id = useId();
  const { messages: { workers: m, common, inspection: { claim } } } = useI18n();
  return <div className="worker-task-table-container"><table className="worker-task-table" role="table"><thead role="rowgroup"><tr role="row"><th id={`${id}-task`} scope="col" role="columnheader">{m.taskColumn}</th><th id={`${id}-status`} scope="col" role="columnheader">{m.statusColumn}</th><th id={`${id}-agent`} scope="col" role="columnheader">{m.agentColumn}</th></tr></thead><tbody role="rowgroup">
    {tasks.map(task => <tr role="row" key={`${task.projectId}/${task.taskId}/${task.claimId}`}><td className="worker-task-identity" role="cell" headers={`${id}-task`}><a className="worker-task-title" href={taskDetailUrl(task.projectId, task.taskId, { tab: 'overview', path: null })} onClick={followWorkerLink}>{task.title}</a><p className="worker-task-project">{task.projectName} · <span title={task.taskId}>{task.taskId.slice(0, 8)}</span></p></td>
      <td className="worker-task-work" role="cell" headers={`${id}-status`}><span className="worker-task-status">{common.status[task.status]}</span><p className="worker-task-phase">{claim.phase[task.phase]}</p></td><td className="worker-task-agent" role="cell" headers={`${id}-agent`}>{agentNames[task.agent]}</td></tr>)}
  </tbody></table></div>;
};

export const WorkerDetailPage = ({ workerId, userId, active = true, readEnabled, onRetentionChange }: { readonly workerId: string; readonly userId: string; readonly active?: boolean; readonly readEnabled: boolean; readonly onRetentionChange?: (retain: boolean) => void }) => {
  const id = useId();
  const state = useWorker(workerId, { readEnabled });
  const monitoring = useWorkerMonitoring(workerId, { readEnabled });
  const refresh = () => { state.refresh(); monitoring.refresh(); };
  const monitoringAge = monitoring.snapshot?.state === 'available' && monitoring.serverMilliseconds !== null ? monitoring.serverMilliseconds - Date.parse(monitoring.snapshot.receivedAt) : null;
  const ageClass = monitoringAge === null ? 'unknown' : monitoringAge >= 3_600_000 ? 'expired' : monitoringAge >= 90_000 ? 'stale' : 'current';
  const { messages: { workers: m, platform }, locale, format } = useI18n();
  const { snapshot, serverMilliseconds } = state;
  if (snapshot !== null && serverMilliseconds === null) throw new Error('A Worker snapshot requires its server observation time.');
  const worker = snapshot?.worker;
  const [savedAlias, setSavedAlias] = useState<{ workerId: string; userId: string; alias: WorkerAlias } | null>(null);
  const alias = savedAlias?.workerId === workerId && savedAlias.userId === userId && worker?.alias !== undefined
    && BigInt(savedAlias.alias.version) >= BigInt(worker.alias.version) ? savedAlias.alias : worker?.alias;
  const recent = worker !== undefined && isWorkerRecent(worker, serverMilliseconds!);
  const online = worker !== undefined && isWorkerOnline(worker, serverMilliseconds!);
  const unavailable = snapshot !== null && !recent;
  const taskSnapshot = !online || state.stale || worker?.taskObservationState === 'stale';
  const { section, select: selectSection, error: historyError } = useWorkerHistory(userId, workerId, active);
  const page = useWorkerPageAnchor(monitoring.snapshot, monitoring.error, state.snapshot, state.error, ageClass, online, recent, section);
  const [opened, setOpened] = useState<{ workerId: string; opened: boolean }>({ workerId, opened: false });
  const configurationOpened = opened.workerId === workerId && opened.opened || (section === 'configuration' || section === 'prompt');
  useLayoutEffect(() => {
    if ((section === 'configuration' || section === 'prompt') && !historyError) setOpened({ workerId, opened: true });
  }, [workerId, section, historyError]);
  const [toolPathsRequest, setToolPathsRequest] = useState<{ workerId: string; userId: string } | null>(null);
  const finishToolPathsRequest = useCallback(() => setToolPathsRequest(null), []);
  useLayoutEffect(() => {
    if (!active || historyError || section !== 'configuration' || toolPathsRequest?.workerId !== workerId || toolPathsRequest.userId !== userId) setToolPathsRequest(null);
  }, [active, historyError, section, workerId, userId, toolPathsRequest]);
  const openToolPaths = () => {
    setToolPathsRequest({ workerId, userId });
    selectSection('configuration');
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = sections.indexOf(section);
    const next = event.key === 'Home' ? sections[0] : event.key === 'End' ? sections[sections.length - 1]! : event.key === 'ArrowLeft' ? sections[(index + sections.length - 1) % sections.length]! : event.key === 'ArrowRight' ? sections[(index + 1) % sections.length]! : null;
    if (next === null) return;
    event.preventDefault(); selectSection(next); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-worker-tab="${next}"]`)?.focus();
  };
  const header = (trigger: ReactNode) => worker !== undefined && <>
    <div className="worker-title-row"><h1 id="page-title" tabIndex={-1}><bdi>{alias?.value ?? worker.machine.name}</bdi></h1>{trigger}</div>
    <div className="worker-description"><WorkerStatusBadge online={online} stale={state.stale} /><span>{platform.names[worker.platform]}</span><span>{m.lastReported}: <WorkerTimestamp value={worker.lastReportedAt} /> (<WorkerTimestamp value={worker.lastReportedAt} serverMilliseconds={serverMilliseconds!} />)</span></div>
    <p className="worker-machine-name">{m.alias.machineName}: <bdi>{worker.machine.name}</bdi></p>
    <p className="worker-id">{m.workerId} · {worker.workerId}</p>
  </>;
  return <div className="worker-page" ref={page}>
    <a className="worker-back-link" href="/workers" onClick={followWorkerLink}>← {m.back}</a>
    {historyError && <div className="notice error" role="alert">{locale === "zh-CN" ? "页面导航状态无效。" : "Invalid page navigation state."}</div>}
    <div hidden={historyError} inert={historyError}>
    {worker !== undefined && recent && <div className="page-heading worker-detail-heading"><div>
        {alias === undefined ? header(null) : <WorkerAliasEditor key={`${userId}/${workerId}`} workerId={workerId} resource={alias} header={header} readEnabled={readEnabled && active && !historyError} onSaved={incoming => {
          setSavedAlias(old => old?.workerId === workerId && old.userId === userId && BigInt(old.alias.version) > BigInt(incoming.version) ? old : { workerId, userId, alias: incoming });
          state.refresh();
        }} />}</div>{(section === 'overview' || section === 'system') && <div className="heading-actions"><WorkerRefresh refresh={section === 'system' ? state.refresh : refresh} refreshing={section === 'system' ? state.refreshing : state.refreshing || monitoring.refreshing} readEnabled={readEnabled} /></div>}</div>}
    {(worker === undefined || unavailable) && section !== 'overview' && <div className="page-heading worker-detail-heading"><h1 id="page-title" tabIndex={-1}>{m.workerId} · {workerId}</h1></div>}
    <div className="worker-tabs" role="tablist" aria-label={m.configuration.sections}>{sections.map(value => <button key={value} type="button" role="tab" id={`${id}-tab-${value}`} data-worker-tab={value} aria-controls={`${id}-panel-${value}`} aria-selected={section === value} tabIndex={section === value ? 0 : -1} onClick={() => selectSection(value)} onKeyDown={onTabKeyDown}>{m.configuration[value]}</button>)}</div>
    <section className="worker-section" id={`${id}-panel-overview`} data-worker-panel="overview" role="tabpanel" aria-labelledby={`${id}-tab-overview`} hidden={section !== 'overview'} inert={section !== 'overview'}>
    {worker === undefined || unavailable ? <WorkerReadState kind="detail" {...state} status={unavailable ? 'unavailable' : state.status} readEnabled /> : <>
      <WorkerReadNotice {...state} observedAt={snapshot!.observedAt} readEnabled />
      {!online && <section className="worker-snapshot-notice" role="status"><span aria-hidden="true">◷</span><div><p>{m.offlineNotice}</p><p>{m.lastReported}: <WorkerTimestamp value={worker.lastReportedAt} /> · {m.offlineDetail}</p></div></section>}
      <WorkerMonitoringTime state={monitoring} />
      <WorkerLifecyclePanel key={`${userId}/${workerId}`} worker={worker} readEnabled={readEnabled && active && !historyError} />
      <section className="worker-panel" data-worker-reading><h2 className="worker-panel-heading"><span className="worker-task-heading-label" data-current-label={m.tasks}><span>{taskSnapshot ? m.tasksSnapshot : m.tasks}</span></span>{' '}
        {worker.activeTaskCount !== null && <span className="worker-count-badge">{format.number(worker.activeTaskCount)}</span>}{' '}
        <span className="worker-task-snapshot-caption" aria-hidden={!taskSnapshot}>{m.lastReportSnapshot}</span></h2>
        {worker.taskObservationState === 'unavailable' ? <p className="worker-task-empty">{m.tasksPending}</p> : <>
          <div className="worker-task-observation">{worker.taskObservationState === 'stale' && <p>{m.oldInventory}</p>}<p>{m.taskObservedAt}: <WorkerTimestamp value={worker.taskObservedAt!} /></p><p>{m.inventoryObservedAt}: <WorkerTimestamp value={worker.inventoryObservedAt!} /></p></div>
          {worker.tasks.length > 0 ? <TaskRows tasks={worker.tasks} /> : <p className="worker-task-empty">{taskSnapshot ? m.snapshotIdle : m.idle}</p>}
        </>}
      </section>
      <WorkerMonitoring state={monitoring} readEnabled />
    </>}
    </section>
    <section className="worker-section" id={`${id}-panel-system`} data-worker-panel="system" role="tabpanel" aria-labelledby={`${id}-tab-system`} hidden={section !== 'system'} inert={section !== 'system'}>
    {worker === undefined || unavailable ? <WorkerReadState kind="detail" {...state} status={unavailable ? 'unavailable' : state.status} readEnabled={readEnabled} /> : <>
      <WorkerReadNotice {...state} observedAt={snapshot!.observedAt} readEnabled={readEnabled} />
      {!online && <section className="worker-snapshot-notice" role="status"><span aria-hidden="true">◷</span><div><p>{m.offlineNotice}</p><p>{m.lastReported}: <WorkerTimestamp value={worker.lastReportedAt} /> · {m.offlineDetail}</p></div></section>}
      <WorkerSystemSnapshot worker={worker} online={online} stale={state.stale} openToolPaths={openToolPaths} />
    </>}
    </section>
    {!configurationOpened && <><section id={`${id}-panel-configuration`} data-worker-panel="configuration" role="tabpanel" aria-labelledby={`${id}-tab-configuration`} hidden inert /><section id={`${id}-panel-prompt`} data-worker-panel="prompt" role="tabpanel" aria-labelledby={`${id}-tab-prompt`} hidden inert /></>}
    {configurationOpened && <WorkerEditingPanels id={id} workerId={workerId} {...(worker !== undefined && recent ? { platform: worker.platform, ...(worker.telemetry.toolPaths === undefined ? {} : { toolPaths: worker.telemetry.toolPaths }) } : {})} section={section} {...(active && !historyError && toolPathsRequest?.workerId === workerId && toolPathsRequest.userId === userId ? { onRevealToolPaths: finishToolPathsRequest } : {})} onContinueEditing={editor => selectSection(editor, true)} readEnabled={readEnabled} reviewEnabled={active && !historyError} online={worker === undefined || !recent || state.stale ? null : online} tasks={recent && worker !== undefined ? worker.tasks : []} {...(onRetentionChange === undefined ? {} : { onRetentionChange })} />}
    </div>
  </div>;
};
