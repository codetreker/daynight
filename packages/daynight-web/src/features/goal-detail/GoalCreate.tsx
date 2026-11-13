import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ApiError, authRequestsPaused, createTask, isAbortError, type CreateTaskInput } from '../../api/client';
import type { TaskTag } from '../../api/types';
import { TagPicker } from '../task-tags/TagPicker';
import { tagMessages } from '../task-tags/messages';
import '../task-tags/task-tags.css';
import { useI18n } from '../../i18n/LocaleProvider';
import { useProjectAccess } from '../projects/ProjectAccess';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { AssigneePicker } from '../task-assignment/AssigneePicker';
import { TaskAssigneeIdentity } from '../task-assignment/TaskAssigneeIdentity';
import { FormDialog } from '../task-detail/TaskOrganization';
import { GoalMutationError } from './GoalMutationError';

type State = { readonly title: string; readonly description: string; readonly assignedTo: string | null; readonly tags: readonly TaskTag[]; readonly submitted: CreateTaskInput | null; readonly phase: 'idle' | 'pending' | 'unknown'; readonly error: unknown };
type Entry = { state: State; readonly listeners: Set<() => void> };
const stores = new WeakMap<object, Map<string, Entry>>();
const entryFor = (scope: object, projectId: string, userId: string): Entry => {
  let projects = stores.get(scope);
  if (projects === undefined) { projects = new Map(); stores.set(scope, projects); }
  let entry = projects.get(projectId);
  if (entry === undefined) { entry = { state: { title: '', description: '', assignedTo: userId, tags: [], submitted: null, phase: 'idle', error: null }, listeners: new Set() }; projects.set(projectId, entry); }
  return entry;
};
const publish = (entry: Entry, state: State) => { entry.state = state; for (const listener of entry.listeners) listener(); };

export const GoalCreate = ({ projectId, onClose, onRefreshGraph }: { readonly projectId: string; readonly onClose: () => void; readonly onRefreshGraph: () => void }) => {
  const { locale, messages } = useI18n();
  const zh = locale === 'zh-CN';
  const scope = useTaskCacheScope();
  const access = useProjectAccess(projectId);
  const entry = entryFor(scope, projectId, scope.userId);
  const state = useSyncExternalStore((listener) => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener); }; }, () => entry.state);
  const mounted = useRef(true);
  const [creatingTag, setCreatingTag] = useState(false);
  useEffect(() => () => { mounted.current = false; }, []);
  const update = (fields: Partial<State>) => publish(entry, { ...entry.state, ...fields });
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (entry.state.phase !== 'idle' || creatingTag || !entry.state.title.trim() || !access.ready || authRequestsPaused()) return;
    const input = { title: entry.state.title, description: entry.state.description, type: 'goal' as const, assignedTo: entry.state.assignedTo, tagIds: entry.state.tags.map(tag => tag.id) };
    update({ phase: 'pending', error: null, submitted: input });
    let submitted = false, confirmed = false;
    try {
      await scope.ready(scope.signal);
      if (await access.session.waitForFreshAccess(scope.signal) === null || scope.isInvalidated || authRequestsPaused()) throw new Error(zh ? '项目访问状态不可用' : 'Project access is unavailable');
      submitted = true;
      await createTask(projectId, input, scope.signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch, onWriteConfirmed: () => { confirmed = true; } });
      publish(entry, { title: '', description: '', assignedTo: scope.userId, tags: [], submitted: null, phase: 'idle', error: null });
      onRefreshGraph();
      if (mounted.current) onClose();
    } catch (error) {
      if (scope.isInvalidated || isAbortError(error) && scope.signal.aborted) return;
      const unknown = submitted && (confirmed || !(error instanceof ApiError) || error.kind !== 'server' || error.status === null || error.status >= 500 || error.code === 'write_outcome_unknown');
      update({ phase: unknown ? 'unknown' : 'idle', error, ...(unknown ? {} : { submitted: null }) });
      if (unknown) onRefreshGraph();
    }
  };
  const busy = state.phase === 'pending';
  const close = () => { if (entry.state.phase === 'idle' && entry.state.error === null) update({ tags: [] }); onClose(); };
  return <FormDialog title={zh ? '新建 Goal' : 'New Goal'} onClose={close}><form onSubmit={create}><div className="dialog-body task-organization-fields">
    <label>{zh ? '名称' : 'Name'}<input value={state.title} required disabled={busy} onChange={(event) => update({ title: event.currentTarget.value })} /></label>
    <label>{zh ? '目标描述' : 'Description'}<textarea value={state.description} disabled={busy} onChange={(event) => update({ description: event.currentTarget.value })} /></label>
    <div><span className="assignee-field-label">{messages.assignment.label}</span><AssigneePicker projectId={projectId} label={messages.assignment.label} value={state.assignedTo ?? ''} choices={[{ value: '', label: messages.assignment.unassigned }]} disabled={busy} onSelect={(value) => update({ assignedTo: value || null })}><TaskAssigneeIdentity projectId={projectId} assignedTo={state.assignedTo} compact /></AssigneePicker></div>
    <fieldset disabled={state.phase !== 'idle'}><div><span>{tagMessages[locale].title}</span><TagPicker projectId={projectId} value={state.tags} onChange={value => { if (entry.state.phase === 'idle') update({ tags: value }); }} canWrite={access.ready} onCreatingChange={setCreatingTag} /></div></fieldset>
    {state.phase === 'unknown' && <div role="alert"><p>{zh ? '创建结果尚未确认。请查看 Goal 列表；核对不能证明原请求的结果，也不会自动重新提交。' : 'The creation outcome is unknown. Check the Goal list; observation cannot prove the original outcome and will not resend the request.'}</p><button className="button" type="button" onClick={onRefreshGraph}>{zh ? '刷新 Goal 列表' : 'Refresh Goal list'}</button><button className="button" type="button" onClick={() => update({ phase: 'idle', title: '', description: '', assignedTo: scope.userId, tags: [], submitted: null, error: null })}>{zh ? '开始新建另一个 Goal' : 'Create another Goal'}</button></div>}
    {state.error !== null && (state.error instanceof ApiError ? <GoalMutationError error={state.error} action="create" outcomeUnknown={state.phase === 'unknown'} /> : <p role="alert">{state.phase === 'unknown' ? (zh ? '创建结果尚未确认。' : 'The creation outcome is unknown.') : (zh ? '创建失败' : 'Creation failed')}</p>)}
  </div><footer className="dialog-footer"><button className="button" type="button" onClick={close}>{zh ? '取消' : 'Cancel'}</button><button className="button primary" type="submit" disabled={state.phase !== 'idle' || creatingTag || !state.title.trim() || !access.ready}>{zh ? '创建' : 'Create'}</button></footer></form></FormDialog>;
};
