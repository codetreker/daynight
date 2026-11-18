import type { WorkerConfigurationResource } from '../../../api/worker-configuration';
import { useI18n } from '../../../i18n/LocaleProvider';
import { ConfigurationTaskTagFeedback, configurationOutcome } from './ConfigurationFeedback';
import type { TaskTagDigest } from './useTaskTagFilterObservation';

export const ConfigurationTaskTagsField = ({ resource, digest }: { readonly resource: WorkerConfigurationResource; readonly digest: TaskTagDigest }) => {
  const { messages: { workers: { configuration: m } } } = useI18n();
  const filter = resource.desired?.value.taskTagFilter;
  return <div className="field full task-tag-filter"><strong>{m.taskTags.title}</strong><p className="configuration-field-detail">{m.taskTags.detail}</p>
    {filter === undefined ? <p>{m.taskTags.unsupportedService}</p> : <><p className="task-tag-target">{filter.names.length === 0 ? m.taskTags.empty : <>{m.taskTags[filter.match]}: {filter.names.join(', ')}</>}</p>
      {configurationOutcome(resource, 'taskTagFilter') === undefined && <p>{m.taskTags.unsupportedWorker}</p>}
      <ConfigurationTaskTagFeedback resource={resource} filter={filter} digest={digest} /></>}
  </div>;
};
