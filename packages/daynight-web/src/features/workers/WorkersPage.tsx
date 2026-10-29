import { useI18n } from '../../i18n/LocaleProvider';
import { isWorkerOnline, isWorkerRecent, sortWorkers } from './observation';
import { useWorkers } from './useWorkers';
import { WorkerStatusBadge } from './WorkerStatusBadge';
import { followWorkerLink, WorkerIcon, WorkerReadNotice, WorkerReadState, WorkerRefresh, WorkerTaskSummary, WorkerTimestamp } from './presentation';
import './workers.css';

export const WorkersPage = ({ readEnabled }: { readonly readEnabled: boolean }) => {
  const state = useWorkers({ readEnabled });
  const { messages: { workers: m, platform, workspace: { app } }, format } = useI18n();
  const { snapshot, serverMilliseconds } = state;
  if (snapshot !== null && serverMilliseconds === null) throw new Error('A Worker snapshot requires its server observation time.');
  const workers = snapshot === null ? [] : sortWorkers(snapshot.items.filter(worker => isWorkerRecent(worker, serverMilliseconds!)), serverMilliseconds!);
  const onlineCount = workers.filter(worker => isWorkerOnline(worker, serverMilliseconds!)).length;
  return <div className="worker-page">
    <div className="page-heading"><div><p className="eyebrow">{app.workspace}</p><h1 id="page-title" tabIndex={-1}>{m.title}</h1><p className="subtitle">{m.subtitle}</p></div>
      <div className="heading-actions"><WorkerRefresh refresh={state.refresh} refreshing={state.refreshing} readEnabled={readEnabled} /></div></div>
    {snapshot === null ? <WorkerReadState kind="list" {...state} readEnabled={readEnabled} /> : <>
      <WorkerReadNotice {...state} observedAt={snapshot.observedAt} readEnabled={readEnabled} />
      {workers.length === 0 ? <section className="state-box" role="status"><div className="state-icon"><WorkerIcon /></div><h2>{m.empty}</h2><p>{m.emptyDetail}</p></section> : <>
        <div className="worker-summary-strip"><span>{m.count({ count: format.number(workers.length) })}</span><span>{m.onlineCount({ count: format.number(onlineCount) })}</span><span>{m.offlineCount({ count: format.number(workers.length - onlineCount) })}</span></div>
        <ul className="worker-grid" aria-label={m.list}>{workers.map(worker => <li key={worker.workerId}>
          <a className="worker-card" href={`/workers/${worker.workerId}`} onClick={followWorkerLink} aria-label={m.open({ name: worker.machine.name })}>
            <div className="worker-card-top"><span className="worker-machine-icon"><WorkerIcon /></span><WorkerStatusBadge online={isWorkerOnline(worker, serverMilliseconds!)} stale={state.stale} /></div>
            <h2 className="worker-name">{worker.machine.name}</h2><p className="worker-platform">{platform.names[worker.platform]}</p>
            <p className="worker-workload"><WorkerTaskSummary worker={worker} serverMilliseconds={serverMilliseconds!} stale={state.stale} /></p>
            <div className="worker-card-footer"><div>{m.lastReported}<span className="worker-last-time"><WorkerTimestamp value={worker.lastReportedAt} serverMilliseconds={serverMilliseconds!} /></span></div>
              <span className="worker-open" aria-hidden="true">{m.viewDetails} <span>→</span></span></div>
          </a>
        </li>)}</ul><p className="list-footer">{m.recentDetail}</p>
      </>}
    </>}
  </div>;
};
