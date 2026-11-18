import { useEffect, useRef } from 'react';
import type { ApiError } from '../../api/client';
import { useI18n } from '../../i18n/LocaleProvider';
import { BarChart } from '../../ui/bar-chart';
import { PullRequestAuthorPicker } from '../pull-requests/PullRequestAuthorPicker';
import type { GraphSnapshot } from '../projects/useTaskGraph';
import { TaskStatistics } from './TaskStatistics';
import { useDateWindow } from './useDateWindow';
import { usePRStatistics } from './pr-statistics';
import { chartMaximum, chartPoints, statisticsText } from './presentation';
import './statistics.css';

export function ProjectStatistics(props: {
  readonly userId: string; readonly projectId: string; readonly canRead: boolean; readonly active: boolean;
  readonly snapshot: GraphSnapshot | null; readonly taskError: unknown; readonly onTaskRetry: () => void;
  readonly onPrincipalMismatch: () => void; readonly onAccessError: (error: ApiError) => void; readonly refreshRevision: number;
}) {
  const { locale } = useI18n(), m = statisticsText(locale);
  const window = useDateWindow(props.active);
  const pr = usePRStatistics({ userId: props.userId, projectId: props.projectId, canRead: props.canRead, active: props.active,
    endDate: window.endDate, window: window.encoded, onPrincipalMismatch: props.onPrincipalMismatch, onAccessError: props.onAccessError });
  const previousRefresh = useRef(props.refreshRevision);
  useEffect(() => { if (previousRefresh.current !== props.refreshRevision) { previousRefresh.current = props.refreshRevision; if (props.active) pr.refresh(); } }, [props.refreshRevision, props.active, pr.refresh]);
  const data = pr.data;
  const all = data?.daily.map(BigInt) ?? [];
  const selected = pr.author === null ? all : data?.authorDaily?.map(BigInt) ?? all;
  const ready = data?.availability === 'ready';
  return <div className="statistics-stack">
    <TaskStatistics key={JSON.stringify([props.userId, props.projectId])} projectId={props.projectId} snapshot={props.canRead && props.snapshot?.observedAt !== null && (props.snapshot?.revision ?? 0) > 0 ? props.snapshot : null} error={props.taskError} onRetry={props.onTaskRetry} window={window} />
    <section className="statistics-card" aria-labelledby="pr-statistics-title">
      <header className="statistics-header"><h2 id="pr-statistics-title">{m.prs}</h2>{ready && <div className="statistics-total"><span>{m.total}</span><strong>{new Intl.NumberFormat(locale).format(BigInt(data.projectTotal))}</strong></div>}</header>
      {pr.error !== null && <div className="statistics-state error" role="alert">{m.prError}<button className="button" type="button" onClick={pr.refresh}>{m.retry}</button></div>}
      {data === null && pr.error === null && <div className="statistics-state" role="status"><span className="spinner" aria-hidden="true" />{m.loading}</div>}
      {data !== null && !ready && <div className="statistics-state" role="status">{data.availability === 'not_connected' ? m.notConnected : data.availability === 'initializing' ? m.initializing : m.noSavedData}</div>}
      {ready && <div className="statistics-chart"><div className="statistics-chart-heading"><h3>{m.dailyPRs}</h3><PullRequestAuthorPicker selected={pr.author} items={pr.authors.items} query={pr.authors.query} loaded={pr.authors.loaded} loading={pr.authors.loading} error={pr.authors.error} nextCursor={pr.authors.nextCursor} rebuilding={pr.authors.rebuilding} disabled={!data.hasAuthors} active={props.active} onOpen={pr.authors.open} onClose={pr.authors.close} onQueryChange={pr.authors.setQuery} onLoadMore={pr.authors.loadMore} onRetry={pr.authors.retry} onSelect={pr.setAuthor} /></div>
        <BarChart label={m.dailyPRs} points={chartPoints(window.dates, selected, locale)} domainMax={chartMaximum(all)} formatValue={value => new Intl.NumberFormat(locale).format(value)} />
      </div>}
    </section>
  </div>;
}
