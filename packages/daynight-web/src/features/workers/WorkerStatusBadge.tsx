import { useI18n } from '../../i18n/LocaleProvider';

export const WorkerStatusBadge = ({ online, stale = false }: { readonly online: boolean; readonly stale?: boolean }) => {
  const { messages: { workers: m } } = useI18n();
  const status = online ? m.online : m.offline;
  const confirmed = m.confirmedStatus({ status });
  return <span className={`worker-status-badge ${online ? 'online' : 'offline'}`}><span className="worker-status-label" data-confirmed-label={confirmed}><span>{stale ? confirmed : status}</span></span></span>;
};
