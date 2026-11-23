import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { ApiError, authRequestsPaused, createTask, getTask, getTaskObservation, isAbortError, listTaskChildren, type CreateTaskInput, type TaskChildrenPage } from '../../api/client';
import type { TaskDetail, TaskTag } from '../../api/types';
import { browserNavigation } from '../../app/navigation';
import { taskDetailUrl } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { AssigneePicker } from '../task-assignment/AssigneePicker';
import { TaskAssigneeIdentity } from '../task-assignment/TaskAssigneeIdentity';
import { useProjectAccess } from '../projects/ProjectAccess';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TagPicker } from '../task-tags/TagPicker';
import { tagMessages } from '../task-tags/messages';
import { FormDialog } from './TaskOrganization';
import type { TaskReadFence } from '../task-cache/project-cache';
import { pollingInterval } from '../../app/polling';
import { NativeSelect } from '../../ui/native-select/NativeSelect';
import './ordinary-task-relations.css';

// Relation pages use their own epoch-qualified Task read, independently of the
// detail source. A project graph is not an authoritative child list.
export type OrdinaryTaskRelationsProps = {
  readonly projectId: string;
  readonly detail: TaskDetail;
  readonly history: number;
  readonly active: boolean;
  readonly onRefreshGraph: () => void;
  readonly render?: (slots: { readonly parent: ReactNode; readonly children: ReactNode }) => ReactNode;
};

type View = { readonly owner: object; readonly page: TaskChildrenPage | null; readonly parent: TaskDetail | null; readonly error: unknown; readonly pending: boolean; readonly fence: TaskReadFence | null; readonly current: TaskDetail | null };
const denied = (error: unknown) => error instanceof ApiError && error.kind === 'server' && [401, 403, 404, 410].includes(error.status ?? 0);

export const OrdinaryTaskRelations = ({ projectId, detail, history, active, onRefreshGraph, render }: OrdinaryTaskRelationsProps) => {
  const { locale, messages } = useI18n(); const zh = locale === 'zh-CN';
  const scope = useTaskCacheScope(); const access = useProjectAccess(projectId);
  const subscribeScope = useCallback((listener: () => void) => {
    const unsubscribe = scope.subscribe(listener); scope.signal.addEventListener('abort', listener);
    return () => { unsubscribe(); scope.signal.removeEventListener('abort', listener); };
  }, [scope]);
  const owner = useMemo(() => ({}), [scope, projectId, detail.id, history]);
  const [view, setView] = useState<View>({ owner, page: null, parent: null, error: null, pending: false, fence: null, current: null });
  const scopeState = useSyncExternalStore(subscribeScope, () => `${scope.isInvalidated}/${scope.hasIdentityMismatch}/${scope.isProjectSuspended(projectId)}/${scope.getHistoryGeneration(projectId)}/${view.fence === null || scope.isTaskReadCurrent(view.fence, true)}`);
  const revoked = scope.isInvalidated || scope.hasIdentityMismatch || scope.isProjectSuspended(projectId) || access.status === 'unavailable' || view.fence !== null && !scope.isTaskReadCurrent(view.fence, true);
  useLayoutEffect(() => { if (revoked) { stores.get(scope)?.delete(`${projectId}/${detail.id}/${history}`); setCreating(false); } }, [scope, projectId, detail.id, history, revoked, scopeState]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<readonly (string | null)[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createRevision, setCreateRevision] = useState(0);
  const latest = useRef({ detail, active, history, onRefreshGraph }); latest.current = { detail, active, history, onRefreshGraph };
  const reset = useCallback(() => { setCursor(null); setPrevious([]); setAttempt(value => value + 1); }, []);
  useEffect(() => { setCursor(null); setPrevious([]); setCreating(false); }, [owner]);
  useEffect(() => {
    if (!active) return;
    const refresh = () => { if (document.visibilityState !== 'hidden') setAttempt(value => value + 1); };
    const timer = setInterval(refresh, pollingInterval('taskSync'));
    const visibility = () => { if (document.visibilityState !== 'hidden') refresh(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [active, owner]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); const signal = AbortSignal.any([controller.signal, scope.signal]);
    let live = true;
    setView(old => old.owner === owner ? { ...old, pending: true, error: null } : { owner, page: null, parent: null, error: null, pending: true, fence: null, current: null });
    void (async () => {
      let fence: TaskReadFence | null = null;
      try {
        await scope.ready(signal);
        fence = await scope.beginTaskRead(projectId, detail.id, 0, 0, signal);
        const generation = scope.getHistoryGeneration(projectId), revision = scope.getProjectRevision(projectId);
        const admission = { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch };
        // A fresh epoch-bearing Task observation qualifies both summary and direct readers.
        const observation = await getTaskObservation(projectId, detail.id, signal, admission);
        if (await scope.observeHistory(fence, observation.epoch, signal) !== 'current') return;
        const current = observation.detail;
        if (!latest.current.active || latest.current.history !== history || latest.current.detail.id !== detail.id || current.version !== latest.current.detail.version || current.type !== latest.current.detail.type || current.status !== latest.current.detail.status) {
          if (live) { setView({ owner, page: null, parent: null, current: null, fence: null, error: new Error(zh ? 'Task 已变化，请刷新详情。' : 'The Task changed. Refresh its detail.'), pending: false }); latest.current.onRefreshGraph(); }
          return;
        }
        if (current.parentTaskId === undefined) throw new Error(zh ? '此服务器不支持普通父子关系。' : 'This server does not support ordinary Task relationships.');
        const [page, parent] = await Promise.all([
          listTaskChildren(projectId, detail.id, cursor, signal, admission),
          current.parentTaskId ? getTask(projectId, current.parentTaskId, signal, admission) : Promise.resolve(null),
        ]);
        await scope.ready(signal);
        if (!live || !latest.current.active || latest.current.history !== history || latest.current.detail.id !== current.id || latest.current.detail.version !== current.version || latest.current.detail.status !== current.status || latest.current.detail.type !== current.type || signal.aborted || scope.getHistoryGeneration(projectId) !== generation || scope.getProjectRevision(projectId) !== revision ||
          !await scope.verifyTaskRead(fence, signal) || !scope.isTaskHistoryConfirmedCurrent(fence)) return;
        setView(old => {
          const prior = old.owner === owner && old.page !== null ? new Map(old.page.items.map(item => [item.id, item])) : new Map<string, TaskDetail>();
          return { owner, page: { ...page, items: page.items.map(item => { const earlier = prior.get(item.id); return earlier !== undefined && earlier.version > item.version ? earlier : item; }) }, parent, current, fence, error: null, pending: false };
        });
      } catch (error) {
        if (!live || signal.aborted || isAbortError(error)) return;
        if (!denied(error)) { try { await scope.ready(signal); } catch { return; } }
        if (!live || signal.aborted || fence !== null && !scope.isTaskReadCurrent(fence, true)) return;
        setView(old => old.owner === owner ? { ...old, page: denied(error) ? null : old.page, parent: denied(error) ? null : old.parent, fence: denied(error) ? null : old.fence, current: denied(error) ? null : old.current, error, pending: false } : { owner, page: null, parent: null, error, pending: false, fence: null, current: null });
      }
    })();
    return () => { live = false; controller.abort(); };
  }, [scope, projectId, detail.id, detail.version, detail.parentTaskId, active, owner, cursor, attempt, createRevision]);
  const visible = active && view.owner === owner && !revoked ? view : { owner, page: null, parent: null, error: null, pending: false, fence: null, current: null };
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); browserNavigation().navigate(event.currentTarget.getAttribute('href')!);
  };
  const link = (item: TaskDetail) => <a href={taskDetailUrl(projectId, item.id, { tab: 'overview', path: null })} onClick={follow}>{item.title}</a>;
  const canCreate = visible.fence !== null && visible.current !== null && visible.current.status !== 'done' && visible.current.status !== 'cancelled' && active;
  const parentSlot = visible.parent !== null ? <section className="task-detail-section" aria-label={zh ? '父 Task' : 'Parent Task'}><h4>{zh ? '父 Task' : 'Parent Task'}</h4>{link(visible.parent)}</section> : null;
  const childrenSlot = <section className="task-detail-section ordinary-task-relations" aria-label={zh ? '子任务' : 'Subtasks'}>
      <div className="ordinary-task-heading"><h4>{zh ? '子任务' : 'Subtasks'}</h4><button className="button" type="button" disabled={!canCreate} onClick={() => setCreating(true)}>{zh ? '新建子任务' : 'New subtask'}</button></div>
      {visible.error !== null && <div role="alert"><p>{zh ? '无法读取子任务。' : 'Could not load subtasks.'} {visible.error instanceof ApiError ? visible.error.serverMessage ?? visible.error.message : visible.error instanceof Error ? visible.error.message : ''}</p><button className="button" type="button" onClick={reset}>{zh ? '重试' : 'Retry'}</button></div>}
      {visible.page === null && visible.error === null && <p role="status">{zh ? '正在读取子任务…' : 'Loading subtasks…'}</p>}
      {visible.page !== null && <>{visible.page.items.length === 0 ? <p>{zh ? '暂无子任务' : 'No subtasks'}</p> : <ul className="ordinary-task-list">{visible.page.items.map(item => <li key={item.id}><span>{link(item)}</span><span className={`ordinary-task-status ordinary-task-status-${item.status}`}>{messages.common.status[item.status]}</span></li>)}</ul>}
        {(previous.length > 0 || visible.page.nextCursor !== null) && <nav aria-label={zh ? '子任务分页' : 'Subtask pages'}><button className="button" type="button" disabled={visible.pending || previous.length === 0} onClick={() => { setCursor(previous[previous.length - 1] ?? null); setPrevious(previous.slice(0, -1)); }}>{zh ? '上一页' : 'Previous'}</button><button className="button" type="button" disabled={visible.pending || visible.page.nextCursor === null} onClick={() => { setPrevious([...previous, cursor]); setCursor(visible.page!.nextCursor); }}>{zh ? '下一页' : 'Next'}</button></nav>}</>}
    </section>;
  return <>{render === undefined ? <>{parentSlot}{childrenSlot}</> : render({ parent: parentSlot, children: childrenSlot })}
    {creating && !revoked && <OrdinarySubtaskCreate projectId={projectId} parent={visible.current ?? detail} fence={visible.fence} history={history} active={active} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); setCreateRevision(value => value + 1); reset(); onRefreshGraph(); }} onRefresh={() => { reset(); onRefreshGraph(); }} />}
  </>;
};

type CreateState = { readonly title: string; readonly description: string; readonly assignedTo: string | null; readonly tags: readonly TaskTag[]; readonly submitted: CreateTaskInput | null; readonly phase: 'idle' | 'pending' | 'unknown' | 'confirmed'; readonly receipt: TaskDetail | null; readonly status: 'proposed' | 'todo'; readonly error: unknown };
type Entry = { state: CreateState; readonly listeners: Set<() => void> };
const stores = new WeakMap<object, Map<string, Entry>>();
const entryFor = (scope: object, key: string, userId: string): Entry => {
  let entries = stores.get(scope); if (entries === undefined) { entries = new Map(); stores.set(scope, entries); }
  let entry = entries.get(key); if (entry === undefined) { entry = { state: { title: '', description: '', assignedTo: userId, tags: [], submitted: null, phase: 'idle', receipt: null, status: 'proposed', error: null }, listeners: new Set() }; entries.set(key, entry); }
  return entry;
};
const publish = (entry: Entry, state: CreateState) => { entry.state = state; for (const listener of entry.listeners) listener(); };

export const OrdinarySubtaskCreate = ({ projectId, parent, fence, history, active, onClose, onCreated, onRefresh }: { readonly projectId: string; readonly parent: TaskDetail; readonly fence: TaskReadFence | null; readonly history: number; readonly active: boolean; readonly onClose: () => void; readonly onCreated: (task: TaskDetail) => void; readonly onRefresh: () => void }) => {
  const { locale, messages } = useI18n(); const zh = locale === 'zh-CN';
  const scope = useTaskCacheScope(); const access = useProjectAccess(projectId);
  const entry = entryFor(scope, `${projectId}/${parent.id}/${history}`, scope.userId);
  const state = useSyncExternalStore(listener => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener); }; }, () => entry.state);
  const [creatingTag, setCreatingTag] = useState(false);
  const mounted = useRef(true); useEffect(() => () => { mounted.current = false; }, []);
  const latest = useRef({ parent, active, history, fence }); latest.current = { parent, active, history, fence };
  const update = (patch: Partial<CreateState>) => publish(entry, { ...entry.state, ...patch });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (entry.state.phase !== 'idle' || creatingTag || !entry.state.title.trim() || !access.ready || !active || authRequestsPaused() || parent.status === 'done' || parent.status === 'cancelled') return;
    if (fence === null) return;
    const generation = scope.getHistoryGeneration(projectId), revision = scope.getProjectRevision(projectId);
    const input: CreateTaskInput = { title: entry.state.title, description: entry.state.description, parentTaskId: parent.id, status: entry.state.status, assignedTo: entry.state.assignedTo, tagIds: entry.state.tags.map(tag => tag.id) };
    update({ phase: 'pending', error: null, submitted: input, receipt: null }); let submitted = false, confirmed = false; let result: TaskDetail | null = null;
    try {
      await scope.ready(scope.signal);
      if (await access.session.waitForFreshAccess(scope.signal) === null || scope.isInvalidated || authRequestsPaused() || scope.getHistoryGeneration(projectId) !== generation || scope.getProjectRevision(projectId) !== revision || !await scope.verifyTaskRead(fence, scope.signal) || !scope.isTaskHistoryConfirmedCurrent(fence)) throw new Error(zh ? 'Task 访问状态不可用' : 'Task access is unavailable');
      const observed = await getTaskObservation(projectId, parent.id, scope.signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
      if (!mounted.current || !latest.current.active || latest.current.history !== history || latest.current.fence !== fence || latest.current.parent.id !== parent.id || latest.current.parent.version !== parent.version || latest.current.parent.status !== parent.status || observed.detail.type !== parent.type || observed.detail.version !== parent.version || observed.detail.status !== parent.status || observed.detail.parentTaskId === undefined ||
        await scope.observeHistory(fence, observed.epoch, scope.signal) !== 'current' || !await scope.verifyTaskRead(fence, scope.signal)) throw new Error(zh ? '父 Task 已发生变化，请重试。' : 'The parent Task changed. Please retry.');
      submitted = true;
      result = await createTask(projectId, input, scope.signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch, onWriteConfirmed: () => { confirmed = true; } });
    } catch (error) {
      if (!mounted.current || scope.isInvalidated || scope.hasIdentityMismatch || scope.isProjectSuspended(projectId) || isAbortError(error) && scope.signal.aborted) return;
      const unknown = submitted && (confirmed || !(error instanceof ApiError) || error.kind !== 'server' || error.status === null || error.status >= 500 || error.code === 'write_outcome_unknown');
      update({ phase: unknown ? 'unknown' : 'idle', error, ...(unknown ? {} : { submitted: null }) }); if (unknown && mounted.current) onRefresh();
      return;
    }
    // The verified creation receipt survives later history or local storage failures.
    if (!mounted.current || scope.isInvalidated || scope.hasIdentityMismatch || scope.isProjectSuspended(projectId)) return;
    update({ phase: 'confirmed', receipt: result, error: null });
    let admitted = false;
    try { admitted = await scope.verifyTaskRead(fence, scope.signal) && scope.isTaskHistoryConfirmedCurrent(fence); } catch { /* The receipt remains confirmed. */ }
    if (mounted.current && admitted && result !== null) {
      publish(entry, { title: '', description: '', assignedTo: scope.userId, tags: [], submitted: null, phase: 'idle', receipt: null, status: 'proposed', error: null });
      onCreated(result);
    }
  };
  const close = () => { if (entry.state.phase === 'pending') return; if (entry.state.phase === 'confirmed') publish(entry, { title: '', description: '', assignedTo: scope.userId, tags: [], submitted: null, phase: 'idle', receipt: null, status: 'proposed', error: null }); onClose(); };
  return <FormDialog title={zh ? '新建子任务' : 'New subtask'} onClose={close}><form onSubmit={submit}><div className="dialog-body task-organization-fields">
    <p>{zh ? '父 Task' : 'Parent Task'}: {parent.title} ({parent.id})</p>
    <fieldset disabled={state.phase !== 'idle'}><label>{zh ? '状态' : 'Status'}<NativeSelect density="form" layout="fill" focusTone="task" value={state.status} onChange={event => update({ status: event.currentTarget.value as 'proposed' | 'todo' })}><option value="proposed">{messages.common.status.proposed}</option><option value="todo">{messages.common.status.todo}</option></NativeSelect></label><label>{zh ? '标题' : 'Title'}<input required value={state.title} onChange={event => update({ title: event.currentTarget.value })} /></label><label>{zh ? '工作说明' : 'Description'}<textarea value={state.description} onChange={event => update({ description: event.currentTarget.value })} /></label>
      <div><span className="assignee-field-label">{messages.assignment.label}</span><AssigneePicker projectId={projectId} label={messages.assignment.label} value={state.assignedTo ?? ''} choices={[{ value: '', label: messages.assignment.unassigned }]} disabled={state.phase !== 'idle'} onSelect={value => update({ assignedTo: value || null })}><TaskAssigneeIdentity projectId={projectId} assignedTo={state.assignedTo} compact /></AssigneePicker></div>
      <div onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement) event.preventDefault(); }}><span>{tagMessages[locale].title}</span><TagPicker projectId={projectId} value={state.tags} onChange={value => { if (entry.state.phase === 'idle') update({ tags: value }); }} canWrite={access.ready} onCreatingChange={setCreatingTag} /></div>
    </fieldset>
    {state.phase === 'confirmed' && state.receipt !== null && <p role="status">{zh ? '子任务已创建：' : 'Subtask created: '}{state.receipt.title} ({state.receipt.id})</p>}
    {state.phase === 'unknown' && <div role="alert"><p>{zh ? '创建结果尚未确认。检查子任务列表不会证明原请求的结果，也不会重新提交。' : 'The creation outcome is unknown. Checking the subtask list cannot prove the original outcome and will not resend the request.'}</p><button className="button" type="button" onClick={onRefresh}>{zh ? '刷新子任务列表' : 'Refresh subtasks'}</button><button className="button" type="button" onClick={() => update({ phase: 'idle', receipt: null, status: 'proposed', title: '', description: '', assignedTo: scope.userId, tags: [], submitted: null, error: null })}>{zh ? '开始新建另一个子任务' : 'Create another subtask'}</button></div>}
    {state.error !== null && state.phase !== 'unknown' && <p role="alert">{state.error instanceof ApiError ? state.error.serverMessage ?? state.error.message : (zh ? '创建失败。' : 'Creation failed.')}</p>}
  </div><footer className="dialog-footer"><button className="button" type="button" disabled={state.phase === 'pending'} onClick={close}>{zh ? '取消' : 'Cancel'}</button><button className="button primary" type="submit" disabled={state.phase !== 'idle' || creatingTag || !state.title.trim() || !access.ready || !active || parent.status === 'done' || parent.status === 'cancelled'}>{zh ? '创建' : 'Create'}</button></footer></form></FormDialog>;
};
