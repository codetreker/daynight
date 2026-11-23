import type { WorkerTaskTagFilter } from '../../../api/worker-task-tag-filter';
import { useI18n } from '../../../i18n/LocaleProvider';

export const TaskTagFilterValue = ({ filter }: { readonly filter: WorkerTaskTagFilter }) => {
  const { messages: { workers: { configuration: m } } } = useI18n();
  if (filter.names.length === 0) return <>{m.taskTags.empty}</>;
  return <>{m.taskTags[filter.match]}: <span className="task-tag-names" role="list">{filter.names.map(name => <span className="task-tag-name" role="listitem" key={name}>{name}</span>)}</span></>;
};
