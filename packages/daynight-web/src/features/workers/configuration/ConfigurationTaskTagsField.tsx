import { useState } from 'react';
import type { WorkerConfigurationResource } from '../../../api/worker-configuration';
import { normalizeTagName, tagNameKey } from '../../../api/task-tags';
import { useI18n } from '../../../i18n/LocaleProvider';
import { NativeSelect } from '../../../ui/native-select/NativeSelect';
import { ConfigurationTaskTagFeedback, configurationOutcome } from './ConfigurationFeedback';
import { TaskTagFilterValue } from './TaskTagFilterValue';
import type { ConfigurationDraft } from './model';
import type { TaskTagDigest } from './useTaskTagFilterObservation';

type TagDraft = NonNullable<ConfigurationDraft['taskTagFilter']>;

export const ConfigurationTaskTagsField = ({ resource, digest, draft, disabled, invalid, changed, onChange }: {
  readonly resource: WorkerConfigurationResource;
  readonly digest: TaskTagDigest;
  readonly draft: TagDraft | undefined;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly changed: boolean;
  readonly onChange: (draft: TagDraft) => void;
}) => {
  const { messages: { workers: { configuration: m } } } = useI18n();
  const [addError, setAddError] = useState(false);
  const filter = resource.desired?.value.taskTagFilter;
  const supported = configurationOutcome(resource, 'taskTagFilter') !== undefined;
  const editable = !disabled && filter !== undefined && draft !== undefined && supported;
  const update = (value: TagDraft) => { setAddError(false); onChange(value); };
  const add = () => {
    if (!editable || draft === undefined) return;
    const name = normalizeTagName(draft.input);
    if (name === null) { setAddError(true); document.getElementById('config-taskTagFilter')?.focus(); return; }
    update({ ...draft, names: draft.names.some(item => tagNameKey(item) === tagNameKey(name)) ? draft.names : [...draft.names, name], input: '' });
    document.getElementById('config-taskTagFilter')?.focus();
  };
  return <div className="field full task-tag-filter"><div className="task-tag-heading"><label htmlFor="config-taskTagFilter">{m.taskTags.title}</label>
    {draft !== undefined && <NativeSelect density="form" id="config-taskTagMatch" aria-label={m.taskTags.match} value={draft.match} disabled={!editable} onChange={event => update({ ...draft, match: event.target.value as 'any' | 'all' })}><option value="any">{m.taskTags.matchAny}</option><option value="all">{m.taskTags.matchAll}</option></NativeSelect>}</div>
    {filter === undefined || draft === undefined ? <p>{m.taskTags.unsupportedService}</p> : <>
      <div className="task-tag-editor"><span className="task-tag-chips" role="list">{draft.names.map(name => <span className="task-tag-chip" role="listitem" key={tagNameKey(name)}><span>{name}</span><button type="button" disabled={!editable} aria-label={m.taskTags.remove(name)} onClick={() => update({ ...draft, names: draft.names.filter(item => tagNameKey(item) !== tagNameKey(name)) })}>×</button></span>)}</span>
        <input data-touch-text="responsive" id="config-taskTagFilter" type="text" placeholder={m.taskTags.placeholder} autoComplete="off" spellCheck={false} value={draft.input} disabled={!editable} aria-invalid={invalid || addError} aria-describedby={`task-tag-help${invalid || addError ? ' task-tag-error' : ''}`} onChange={event => update({ ...draft, input: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }} />
        <button className="button" type="button" disabled={!editable} onClick={add}>{m.taskTags.add}</button></div>
      <div className="task-tag-actions"><p className="configuration-field-detail" id="task-tag-help">{m.taskTags.detail}</p><button className="task-tag-clear" type="button" disabled={disabled || draft.names.length === 0 && draft.input === ''} onClick={() => update({ names: [], match: 'any', input: '' })}>{m.taskTags.clear}</button></div>
      {(invalid || addError) && <p className="field-error" id="task-tag-error" role="alert">{m.taskTags.invalid}</p>}
      {!supported && <p>{m.taskTags.unsupportedWorker}</p>}
      <p className="task-tag-target">{m.taskTags.target}: <TaskTagFilterValue filter={filter} /></p>
      <ConfigurationTaskTagFeedback resource={resource} filter={filter} digest={digest} changed={changed} /></>}
  </div>;
};
