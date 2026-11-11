import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, authRequestsPaused, createTask, isAbortError } from '../../api/client';
import { listProjectPeople } from '../../api/auth';
import type { ProjectPerson } from '../../api/auth-types';
import { useI18n } from '../../i18n/LocaleProvider';
import { OverlayOwnerContext } from '../../app/overlay';
import { ProjectAccessBoundary, useProjectAccess } from '../projects/ProjectAccess';
import type { GraphSnapshot } from '../projects/useTaskGraph';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { DetailFrame, useDetailOverlay } from './DetailFrame';
import { useTaskDetail } from './useTaskDetail';
import './task-organization.css';

const labels = {
  en: { newTask: 'New Task', addExisting: 'Add existing Task', title: 'Title', description: 'Description', goal: 'Goal', none: 'No Goal', assignee: 'Assignee', defaultAssignee: 'Default', unassigned: 'Unassigned', peopleFailed: 'Could not load assignees.', retry: 'Retry', cancel: 'Cancel', create: 'Create', add: 'Add to Goal', select: 'Task', loading: 'Loading Task…', check: 'Check current state', checking: 'Checking…', unknown: 'The result is unknown. Check the current state before making another change.', createUnknown: 'The result is unknown. Check the task list before creating another Task.', checked: 'I checked the list; start a new Task', error: 'The request failed.', conflict: 'The Task changed. Check its current state before trying again.', review: 'Review current Task', close: 'Close', current: 'Current Goal', move: 'Move Task', save: 'Save' },
  'zh-CN': { newTask: '新建 Task', addExisting: '加入已有 Task', title: '标题', description: '工作说明', goal: 'Goal', none: '未归属 Goal', assignee: '负责人', defaultAssignee: '默认', unassigned: '未分配', peopleFailed: '无法读取负责人列表。', retry: '重试', cancel: '取消', create: '创建', add: '加入 Goal', select: 'Task', loading: '正在读取 Task…', check: '查看当前状态', checking: '正在查看…', unknown: '结果尚未确认，请先查看当前状态再进行其他修改。', createUnknown: '结果尚未确认，请先检查任务列表，再创建其他 Task。', checked: '我已检查列表，开始新建 Task', error: '请求失败。', conflict: 'Task 已发生变化，请查看当前状态后再试。', review: '确认当前 Task', close: '关闭', current: '所属 Goal', move: '移动 Task', save: '保存' },
} as const;

const failureText = (error: unknown, fallback: string) => error instanceof ApiError ? error.serverMessage ?? error.message : error instanceof Error ? error.message : fallback;
const goalOptions = (snapshot: GraphSnapshot | null) => [...(snapshot?.summaries.values() ?? [])].filter(item => item.type === 'goal').sort((a, b) => a.titlePreview.localeCompare(b.titlePreview));
const taskOptions = (snapshot: GraphSnapshot | null, goalId: string) => [...(snapshot?.index.nodes.values() ?? [])].filter(item => item.parentId !== goalId).sort((a, b) => a.titlePreview.localeCompare(b.titlePreview));
const optionTitle = (item: { titlePreview: string; titleTruncated: boolean; id: string }) => `${item.titlePreview}${item.titleTruncated ? '…' : ''} (${item.id})`;
const parentLabel = (snapshot: GraphSnapshot, parentId: string | null, none: string) => {
  if (parentId === null) return none;
  const goal = snapshot.summaries.get(parentId);
  return goal?.type === 'goal' ? optionTitle(goal) : parentId;
};

export const FormDialog = ({ title, onClose, children }: { readonly title: string; readonly onClose: () => void; readonly children: ReactNode }) => {
  const { locale } = useI18n();
  const m = labels[locale];
  const root = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const heading = useId();
  const opener = useRef<HTMLElement | null>(null);
  if (opener.current === null && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
  useDetailOverlay({ root, initialFocus: close, modal: true, fullscreen: false, scope: title, blocked: () => false, onEscape: onClose, onRestoreFocus: () => { if (opener.current?.isConnected && !opener.current.closest('[inert], [hidden]')) opener.current.focus(); } });
  return createPortal(<div className="task-detail-backdrop"><OverlayOwnerContext value={root}><DetailFrame root={root} modal headingId={heading} className="task-organization-dialog"><header className="dialog-header"><h2 id={heading}>{title}</h2><button className="close-button" ref={close} type="button" aria-label={m.close} onClick={onClose}>×</button></header>{children}</DetailFrame></OverlayOwnerContext></div>, document.body);
};

type CreateState = { readonly title: string; readonly description: string; readonly parent: string; readonly assignee: string; readonly busy: boolean; readonly error: unknown; readonly unknown: boolean };
type CreateStore = { state: CreateState; readonly listeners: Set<() => void> };
const createStores = new WeakMap<object, Map<string, CreateStore>>();
const createStore = (scope: object, projectId: string): CreateStore => {
  let projects = createStores.get(scope);
  if (projects === undefined) { projects = new Map(); createStores.set(scope, projects); }
  let store = projects.get(projectId);
  if (store === undefined) { store = { state: { title: '', description: '', parent: '', assignee: 'default', busy: false, error: null, unknown: false }, listeners: new Set() }; projects.set(projectId, store); }
  return store;
};
const updateCreate = (store: CreateStore, patch: Partial<CreateState>) => {
  store.state = { ...store.state, ...patch };
  for (const listener of store.listeners) listener();
};

export const TaskParentControl = ({ detail, snapshot, disabled, mutation, onSelect, onReconcile }: {
  readonly detail: NonNullable<ReturnType<typeof useTaskDetail>['detail']>; readonly snapshot: GraphSnapshot | null; readonly disabled: boolean;
  readonly mutation: ReturnType<typeof useTaskDetail>['mutation']; readonly onSelect: (id: string | null, version: bigint) => void; readonly onReconcile: () => void;
}) => {
  const { locale } = useI18n(); const m = labels[locale];
  const [selected, setSelected] = useState(detail.parentId ?? '');
  const [selectedVersion, setSelectedVersion] = useState(detail.version);
  const [dirty, setDirty] = useState(false);
  const relevant = mutation.operation?.action === 'parent';
  const unresolved = relevant && (mutation.phase === 'unknown' || mutation.reconciliationError !== null);
  useEffect(() => { if (relevant && (mutation.phase === 'confirmed' || mutation.phase === 'reconciled')) { setSelected(detail.parentId ?? ''); setSelectedVersion(detail.version); setDirty(false); } }, [mutation.phase, mutation.operation]);
  const goals = goalOptions(snapshot);
  return <section className="task-parent-control"><label>{m.current}<select value={dirty ? selected : detail.parentId ?? ''} disabled={disabled || snapshot === null} onChange={(event) => { setSelected(event.target.value); setSelectedVersion(detail.version); setDirty(event.target.value !== (detail.parentId ?? '')); }}><option value="">{m.none}</option>{detail.parentId !== null && !goals.some(goal => goal.id === detail.parentId) && <option value={detail.parentId}>{detail.parentId}</option>}{goals.map(goal => <option key={goal.id} value={goal.id}>{optionTitle(goal)}</option>)}</select></label>
    <button className="button" type="button" aria-label={locale === 'en' ? 'Save Goal membership' : '保存 Goal 归属'} disabled={disabled || !dirty || selectedVersion !== detail.version} onClick={() => onSelect(selected || null, selectedVersion)}>{m.save}</button>
    {dirty && selectedVersion !== detail.version && <div role="alert"><p>{m.conflict}</p><p>{m.current}: {snapshot === null ? detail.parentId ?? m.none : parentLabel(snapshot, detail.parentId, m.none)}</p><button className="button" type="button" disabled={disabled} onClick={() => setSelectedVersion(detail.version)}>{m.review}</button></div>}
    {relevant && (mutation.error !== null || unresolved || mutation.phase === 'conflict') && <div role="alert">{unresolved && <p>{m.unknown}</p>}{mutation.phase === 'conflict' && <p>{m.conflict}</p>}{mutation.error !== null && <p>{failureText(mutation.error, m.error)}</p>}{mutation.reconciliationError !== null && <p>{failureText(mutation.reconciliationError, m.error)}</p>}{(unresolved || mutation.phase === 'conflict') && <button className="button" type="button" disabled={mutation.reconciling} onClick={onReconcile}>{mutation.reconciling ? m.checking : m.check}</button>}</div>}
  </section>;
};

export const ExistingSelection = ({ projectId, taskId, goalId, snapshot, onClose }: { readonly projectId: string; readonly taskId: string; readonly goalId: string; readonly snapshot: GraphSnapshot; readonly onClose: () => void }) => {
  const { locale } = useI18n(); const m = labels[locale];
  const task = useTaskDetail(projectId, taskId, { kind: 'project-summary', revision: snapshot.revision, task: snapshot.index.nodes.get(taskId) });
  const [submitted, setSubmitted] = useState(false);
  const [review, setReview] = useState<{ readonly parentId: string | null; readonly version: bigint } | null>(null);
  useEffect(() => { if (review === null && task.detail !== null && task.canSetParent) setReview({ parentId: task.detail.parentId, version: task.detail.version }); }, [review, task.detail, task.canSetParent]);
  useEffect(() => { if (submitted && task.mutation.operation?.action === 'parent' && task.mutation.phase === 'confirmed') onClose(); }, [submitted, task.mutation, onClose]);
  const error = task.mutation.reconciliationError ?? task.mutation.error ?? task.error;
  const unresolved = task.mutation.phase === 'unknown' || task.mutation.reconciliationError !== null;
  const changed = review !== null && task.detail !== null && (review.version !== task.detail.version || review.parentId !== task.detail.parentId);
  return <><div className="dialog-body">{task.detail === null && error === null && <p>{m.loading}</p>}{task.detail !== null && <><p>{task.detail.title}</p><p>{m.current}: {parentLabel(snapshot, task.detail.parentId, m.none)}</p></>}{changed && <div role="alert"><p>{m.conflict}</p><button className="button" type="button" disabled={!task.canSetParent} onClick={() => { if (task.detail !== null) setReview({ parentId: task.detail.parentId, version: task.detail.version }); }}>{m.review}</button></div>}{unresolved && <p role="alert">{m.unknown}</p>}{task.mutation.phase === 'conflict' && <p role="alert">{m.conflict}</p>}{error !== null && <p role="alert">{failureText(error, m.error)}</p>}{(unresolved || task.mutation.phase === 'conflict' || task.status === 'error') && <button className="button" type="button" disabled={task.mutation.reconciling} onClick={task.retry}>{task.mutation.reconciling ? m.checking : m.check}</button>}</div><footer className="dialog-footer"><button className="button" type="button" onClick={onClose}>{m.cancel}</button><button className="button primary" type="button" disabled={!task.canSetParent || task.detail === null || review === null || changed || task.detail.parentId === goalId || authRequestsPaused()} onClick={() => { if (task.detail !== null && review !== null && task.detail.version === review.version && task.detail.parentId === review.parentId) { setSubmitted(true); task.setParent(goalId, review.version); } }}>{m.add}</button></footer></>;
};

type OrganizationProps = { readonly projectId: string; readonly goalId?: string; readonly snapshot: GraphSnapshot | null; readonly onRefreshGraph: () => void };
export const TaskOrganization = (props: OrganizationProps) => <ProjectAccessBoundary projectId={props.projectId} initialRead><TaskOrganizationContent {...props} /></ProjectAccessBoundary>;
const TaskOrganizationContent = ({ projectId, goalId, snapshot, onRefreshGraph }: OrganizationProps) => {
  const { locale } = useI18n(); const m = labels[locale];
  const scope = useTaskCacheScope(); const access = useProjectAccess(projectId);
  const [mode, setMode] = useState<'create' | 'existing' | null>(null);
  const store = createStore(scope, projectId);
  const { title, description, parent, assignee, busy, error, unknown } = useSyncExternalStore((listener) => { store.listeners.add(listener); return () => { store.listeners.delete(listener); }; }, () => store.state);
  const [selected, setSelected] = useState('');
  const [people, setPeople] = useState<{ items: readonly ProjectPerson[]; error: unknown }>({ items: [], error: null });
  const [peopleAttempt, setPeopleAttempt] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (mode !== 'create') return;
    const controller = new AbortController(); const signal = AbortSignal.any([controller.signal, scope.signal]);
    void listProjectPeople(projectId, { kind: 'catalogue' }, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch }).then(result => setPeople({ items: result.items, error: null })).catch(failure => { if (!signal.aborted) setPeople({ items: [], error: failure }); });
    return () => controller.abort();
  }, [mode, scope, projectId, peopleAttempt]);
  const candidates = goalId === undefined ? [] : taskOptions(snapshot, goalId);
  const create = async (event: FormEvent) => {
    event.preventDefault(); if (store.state.busy || store.state.unknown || !access.ready || authRequestsPaused() || !title.trim()) return;
    updateCreate(store, { busy: true, error: null }); let confirmed = false; let dispatched = false;
    try {
      await scope.ready(scope.signal);
      if (await access.session.waitForFreshAccess(scope.signal) === null || scope.isInvalidated || authRequestsPaused()) throw new Error(m.error);
      dispatched = true;
      await createTask(projectId, { title, description, ...(parent ? { parentId: parent } : {}), ...(assignee === 'default' ? {} : { assignedTo: assignee || null }) }, scope.signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch, onWriteConfirmed: () => { confirmed = true; } });
      if (mounted.current) setMode(null); updateCreate(store, { title: '', description: '', parent: '', assignee: 'default', error: null }); if (mounted.current) onRefreshGraph();
    } catch (failure) {
      if (scope.isInvalidated || isAbortError(failure) && scope.signal.aborted) return;
      const uncertain = dispatched && (confirmed || !(failure instanceof ApiError) || failure.kind !== 'server' || failure.status === null || failure.status >= 500 || failure.code === 'write_outcome_unknown');
      updateCreate(store, { error: failure, unknown: uncertain }); if (uncertain && mounted.current) onRefreshGraph();
    } finally { updateCreate(store, { busy: false }); }
  };
  const close = () => setMode(null);
  return <span className="task-organization-actions">{goalId !== undefined && <button className="button" type="button" disabled={snapshot === null} onClick={() => { setSelected(''); setMode('existing'); }}>{m.addExisting}</button>}<button className="button primary" type="button" disabled={snapshot === null} onClick={() => { if (!store.state.title && !store.state.error && !store.state.busy) updateCreate(store, { parent: goalId ?? '' }); setMode('create'); }}>{m.newTask}</button>
    {mode === 'create' && <FormDialog title={m.newTask} onClose={close}><form onSubmit={create}><div className="dialog-body task-organization-fields"><fieldset disabled={busy || unknown}><label>{m.title}<input required value={title} onChange={event => updateCreate(store, { title: event.target.value })} /></label><label>{m.description}<textarea value={description} onChange={event => updateCreate(store, { description: event.target.value })} /></label><label>{m.goal}<select value={parent} onChange={event => updateCreate(store, { parent: event.target.value })}><option value="">{m.none}</option>{goalOptions(snapshot).map(goal => <option key={goal.id} value={goal.id}>{optionTitle(goal)}</option>)}</select></label><label>{m.assignee}<select value={assignee} onChange={event => updateCreate(store, { assignee: event.target.value })}><option value="default">{m.defaultAssignee}</option><option value="">{m.unassigned}</option>{assignee !== 'default' && assignee !== '' && !people.items.some(person => person.userId === assignee) && <option value={assignee}>{assignee}</option>}{people.items.filter(person => person.hasProjectAccess).map(person => <option key={person.userId} value={person.userId}>{person.name ?? person.userId}</option>)}</select></label></fieldset>{people.error !== null && <div role="alert"><p>{m.peopleFailed} {failureText(people.error, m.error)}</p><button className="button" type="button" onClick={() => setPeopleAttempt(value => value + 1)}>{m.retry}</button></div>}{unknown && <div role="alert"><p>{m.createUnknown}</p><button className="button" type="button" onClick={() => { onRefreshGraph(); setMode(null); }}>{m.check}</button><button className="button" type="button" onClick={() => updateCreate(store, { title: '', description: '', parent: goalId ?? '', assignee: 'default', error: null, unknown: false })}>{m.checked}</button></div>}{error !== null && <p role="alert">{failureText(error, m.error)}</p>}</div><footer className="dialog-footer"><button className="button" type="button" onClick={close}>{m.cancel}</button><button className="button primary" type="submit" disabled={busy || unknown || !access.ready || !title.trim()}>{m.create}</button></footer></form></FormDialog>}
    {mode === 'existing' && goalId !== undefined && snapshot !== null && <FormDialog title={m.addExisting} onClose={close}><div className="dialog-body task-organization-fields"><label>{m.select}<select value={selected} onChange={event => setSelected(event.target.value)}><option value="">—</option>{candidates.map(task => <option key={task.id} value={task.id}>{optionTitle(task)} · {parentLabel(snapshot, task.parentId, m.none)}</option>)}</select></label></div>{selected ? <ExistingSelection key={selected} projectId={projectId} taskId={selected} goalId={goalId} snapshot={snapshot} onClose={close} /> : <footer className="dialog-footer"><button className="button" type="button" onClick={close}>{m.cancel}</button><button className="button primary" type="button" disabled>{m.add}</button></footer>}</FormDialog>}
  </span>;
};
