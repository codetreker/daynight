import type { MouseEvent } from 'react';
import { ApiError } from '../../api/client';
import { navigate } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import type { Locale } from '../../i18n/locale';
import type { WorkerSummary } from '../../api/workers';
import { isWorkerOnline } from './observation';

export const followWorkerLink = (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(event.currentTarget.pathname + event.currentTarget.search + event.currentTarget.hash);
};

export const formatWorkerBytes = (bytes: number, locale: Locale): string => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const index = bytes === 0 ? 0 : Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 ** index)} ${units[index]}`;
};

export const formatWorkerRelative = (timestamp: string, serverMilliseconds: number, locale: Locale): string => {
  const seconds = (Date.parse(timestamp) - serverMilliseconds) / 1000;
  const [divisor, unit]: readonly [number, Intl.RelativeTimeFormatUnit] = Math.abs(seconds) >= 86400
    ? [86400, 'day'] : Math.abs(seconds) >= 3600 ? [3600, 'hour'] : Math.abs(seconds) >= 60 ? [60, 'minute'] : [1, 'second'];
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.trunc(seconds / divisor), unit);
};

export const WorkerIcon = () => <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="13" rx="1" /><path d="M8 21h8m-4-5v5M7 7h10M7 10h6" /></svg>;

export const WorkerTimestamp = ({ value, serverMilliseconds }: { readonly value: string; readonly serverMilliseconds?: number }) => {
  const { locale, format } = useI18n();
  return <time dateTime={value} title={format.dateTime(value)}>{serverMilliseconds === undefined ? format.dateTime(value) : formatWorkerRelative(value, serverMilliseconds, locale)}</time>;
};

export const WorkerRefresh = ({ refresh, refreshing, readEnabled }: { readonly refresh: () => void; readonly refreshing: boolean; readonly readEnabled: boolean }) => {
  const { messages: { workers: m } } = useI18n();
  return <button className="button" type="button" onClick={refresh} disabled={!readEnabled || refreshing}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></svg>
    {refreshing ? m.refreshing : m.refresh}
  </button>;
};

const WorkerErrorDetail = ({ error }: { readonly error: unknown }) => {
  const { messages: { workers: m, common } } = useI18n();
  return <><p>{error instanceof ApiError ? error.kind === 'network' ? m.networkError : error.kind === 'protocol' ? m.protocolError : m.readError : m.readError}</p>
    {error instanceof ApiError && error.requestId !== null && <p className="request-id">{common.requestId} <code>{error.requestId}</code></p>}</>;
};

export const WorkerReadState = ({ status, error, refresh, refreshing, readEnabled, kind }: { readonly kind: 'list' | 'detail'; readonly status: 'loading' | 'ready' | 'error' | 'unavailable'; readonly error: unknown; readonly refresh: () => void; readonly refreshing: boolean; readonly readEnabled: boolean }) => {
  const { messages: { workers: m } } = useI18n();
  const loading = status === 'loading';
  return <section className="state-box" role={status === 'error' ? 'alert' : 'status'}>
    {loading ? <span className="spinner" aria-hidden="true" /> : <div className="state-icon"><WorkerIcon /></div>}
    <h2>{loading ? kind === 'list' ? m.loading : m.detailLoading : status === 'error' ? kind === 'list' ? m.loadingFailed : m.detailLoadingFailed : m.unavailable}</h2>
    {status === 'error' ? <WorkerErrorDetail error={error} /> : <p>{loading ? kind === 'list' ? m.loadingDetail : m.detailLoadingDetail : m.unavailableDetail}</p>}
    {!loading && <button className="button primary" type="button" onClick={refresh} disabled={!readEnabled || refreshing}>{refreshing ? m.refreshing : m.retry}</button>}
  </section>;
};

export const WorkerReadNotice = ({ stale, error, observedAt, refresh, refreshing, readEnabled }: { readonly stale: boolean; readonly error: unknown; readonly observedAt: string; readonly refresh: () => void; readonly refreshing: boolean; readonly readEnabled: boolean }) => {
  const { messages: { workers: m } } = useI18n();
  if (!stale) return null;
  return <section className="worker-sync-notice" role={error === null ? 'status' : 'alert'}>
    <div><p className="worker-notice-title">{error === null ? m.synchronizing : m.refreshFailed}</p><p>{m.retainedState}</p>
      <p>{m.lastSynchronized}: <WorkerTimestamp value={observedAt} /></p>
      {error !== null && <WorkerErrorDetail error={error} />}</div>
    {error !== null && <button className="button" type="button" onClick={refresh} disabled={!readEnabled || refreshing}>{refreshing ? m.refreshing : m.retry}</button>}
  </section>;
};

export const WorkerTaskSummary = ({ worker, serverMilliseconds, stale }: { readonly worker: WorkerSummary; readonly serverMilliseconds: number; readonly stale: boolean }) => {
  const { messages: { workers: m }, format } = useI18n();
  if (worker.activeTaskCount === null) return <>{m.tasksPending}</>;
  const snapshot = stale || worker.taskObservationState === 'stale' || !isWorkerOnline(worker, serverMilliseconds);
  if (worker.activeTaskCount === 0) return <>{snapshot ? m.snapshotIdle : m.idle}</>;
  return <>{snapshot ? m.snapshotTasks({ count: format.number(worker.activeTaskCount) }) : m.activeTasks({ count: format.number(worker.activeTaskCount) })}</>;
};
