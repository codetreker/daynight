import { useI18n } from '../../i18n/LocaleProvider';

export const WorkerStatusBadge = ({ online, stale = false }: { readonly online: boolean; readonly stale?: boolean }) => {
  const { messages: { workers: m } } = useI18n();
  const status = online ? m.online : m.offline;
  return <span className={`worker-status-badge ${online ? 'online' : 'offline'}`}>{stale ? m.confirmedStatus({ status }) : status}</span>;
};
