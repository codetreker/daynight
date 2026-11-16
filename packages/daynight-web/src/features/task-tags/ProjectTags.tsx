import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError, authRequestsPaused, isAbortError } from '../../api/client';
import { createProjectTag, deleteProjectTag, getProjectTag, listProjectTags, normalizeTagName, resolveProjectTagColors, tagNameKey, updateProjectTag, type ProjectTag } from '../../api/task-tags';
import { useI18n } from '../../i18n/LocaleProvider';
import { ManagementDialog } from '../management/ManagementDialog';
import { useProjectAccess } from '../projects/ProjectAccess';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { tagMessages } from './messages';
import { TagColorChip, TagColorFeedback } from './TagColor';
import { DEFAULT_TAG_COLOR, normalizeTagColor, TagColorInput } from './TagColorInput';
import { useTagColors } from './useTagColors';
import { useProjectTags } from './useProjectTags';
import './project-tags.css';

type Dialog = { kind: 'create'; name: string; color: string } | { kind: 'rename'; name: string; color: string | null; tag: ProjectTag; preview: ProjectTag | null } | { kind: 'delete'; name: string; tag: ProjectTag; preview: ProjectTag | null };
type Phase = 'idle' | 'pending' | 'conflict' | 'unknown';
type Observation = { tag: ProjectTag; color: string };
type Draft = { dialog: Dialog; phase: Phase; error: unknown; checked: boolean; observed: Observation | null; missing: boolean; matches: readonly Observation[] | null; attempted: boolean };
const drafts = new WeakMap<TaskCacheScope, Map<string, Draft>>();
const permissionDenials = new WeakMap<TaskCacheScope, Set<string>>();
const denialsFor = (scope: TaskCacheScope): Set<string> => {
  let entries = permissionDenials.get(scope);
  if (entries === undefined) { entries = new Set(); permissionDenials.set(scope, entries); }
  return entries;
};
const draftsFor = (scope: TaskCacheScope): Map<string, Draft> => {
  let entries = drafts.get(scope);
  if (entries !== undefined) return entries;
  entries = new Map(); drafts.set(scope, entries);
  const owned = entries;
  const unsubscribe = scope.subscribe(event => {
    if (event.accessRevoked || event.directAccessUncertain) owned.delete(event.projectId);
  });
  scope.signal.addEventListener('abort', () => { owned.clear(); denialsFor(scope).clear(); unsubscribe(); }, { once: true });
  return owned;
};

let scopeKey = 0;
export const ProjectTags = ({ projectId, active = true }: { readonly projectId: string; readonly active?: boolean }) => {
  const scope = useTaskCacheScope();
  const key = useMemo(() => ++scopeKey, [scope]);
  return <ProjectTagsContent key={`${projectId}:${key}`} projectId={projectId} active={active} />;
};

const ProjectTagsContent = ({ projectId, active }: { readonly projectId: string; readonly active: boolean }) => {
  const { locale } = useI18n(); const m = tagMessages[locale];
  const scope = useTaskCacheScope(); const access = useProjectAccess(projectId);
  const catalog = useProjectTags(projectId, active);
  const colorIds = active ? catalog.page?.items.map(tag => tag.id) ?? [] : [];
  const colors = useTagColors(projectId, colorIds);
  const saved = useRef(draftsFor(scope).get(projectId) ?? null);
  const [dialog, setDialog] = useState<Dialog | null>(() => saved.current?.dialog ?? null);
  const [phase, setPhase] = useState<Phase>(() => saved.current?.phase ?? 'idle');
  const [error, setError] = useState<unknown>(() => saved.current?.error ?? null);
  const [reading, setReading] = useState(false);
  const [checked, setChecked] = useState(() => saved.current?.checked ?? false);
  const [observed, setObserved] = useState<Observation | null>(() => saved.current?.observed ?? null);
  const [missing, setMissing] = useState(() => saved.current?.missing ?? false);
  const [matches, setMatches] = useState<readonly Observation[] | null>(() => saved.current?.matches ?? null);
  const [attempted, setAttempted] = useState(() => saved.current?.attempted ?? false);
  const [permissionDenied, setPermissionDenied] = useState(() => denialsFor(scope).has(projectId));
  const [checkingPermission, setCheckingPermission] = useState(false);
  const [permissionCheckFailed, setPermissionCheckFailed] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const dialogLifetime = useRef(new AbortController());
  const write = useRef<{ dispatched: boolean } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const permissionRevision = useRef(0);
  const permissionLifetime = useRef<AbortController | null>(null);
  const retired = useRef(false);
  const activeRef = useRef(active); activeRef.current = active;
  const latest = useRef({ dialog, phase, error, checked, observed, missing, matches, attempted });
  latest.current = { dialog, phase, error, checked, observed, missing, matches, attempted };
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    draftsFor(scope).delete(projectId);
    const unsubscribe = scope.subscribe((event) => {
      if (event.projectId !== projectId) return;
      if (event.accessRevoked || event.directAccessUncertain) { ++permissionRevision.current; permissionLifetime.current?.abort(); permissionLifetime.current = null; setCheckingPermission(false); lifetime.current?.abort(); dialogLifetime.current.abort(); write.current = null; retired.current = true; latest.current = { ...latest.current, dialog: null }; setDialog(null); }
      else if (event.accessRestored) { retired.current = false; lifetime.current = new AbortController(); }
    });
    return () => {
      ++permissionRevision.current; permissionLifetime.current?.abort(); permissionLifetime.current = null; lifetime.current?.abort(); dialogLifetime.current.abort(); unsubscribe(); lifetime.current = null;
      const snapshot = latest.current;
      if (!retired.current && snapshot.dialog !== null && !scope.isInvalidated && !scope.signal.aborted && !scope.isProjectSuspended(projectId)) {
        const pending = write.current;
        draftsFor(scope).set(projectId, { ...snapshot, dialog: snapshot.dialog, phase: pending === null ? snapshot.phase : pending.dispatched ? 'unknown' : 'idle', checked: pending === null ? snapshot.checked : false });
      }
      write.current = null;
    };
  }, [scope, projectId]);
  useEffect(() => {
    if (!active) {
      ++permissionRevision.current; permissionLifetime.current?.abort(); permissionLifetime.current = null; setCheckingPermission(false);
      dialogLifetime.current.abort();
      setReading(false);
      if (write.current !== null) { setPhase(write.current.dispatched ? 'unknown' : 'idle'); setChecked(false); write.current = null; }
    } else if (dialogLifetime.current.signal.aborted) dialogLifetime.current = new AbortController();
  }, [active]);
  useEffect(() => {
    const current = access.session.snapshot();
    if (retired.current && current.status === 'ready' && current.access !== null && current.access === access.access && !scope.isInvalidated && !scope.isProjectSuspended(projectId)) {
      retired.current = false;
      lifetime.current = new AbortController();
    }
  }, [access.status, access.access, access.session, scope, projectId]);
  const signal = () => AbortSignal.any([scope.signal, lifetime.current!.signal, dialogLifetime.current.signal]);
  const admission = { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch };
  const checkPermission = async () => {
    if (!activeRef.current || scope.isInvalidated || lifetime.current === null) return;
    const revision = ++permissionRevision.current;
    permissionLifetime.current?.abort();
    const controller = new AbortController(); permissionLifetime.current = controller;
    const signal = AbortSignal.any([scope.signal, controller.signal]);
    setCheckingPermission(true); setPermissionCheckFailed(false);
    try {
      const result = await access.session.revalidateAfterMutation();
      if (signal.aborted || revision !== permissionRevision.current || !activeRef.current || scope.isInvalidated) return;
      if (result === null || scope.isProjectSuspended(projectId)) { setPermissionCheckFailed(true); return; }
      if (retired.current) { retired.current = false; lifetime.current = new AbortController(); }
      denialsFor(scope).delete(projectId); setPermissionDenied(false);
    } catch (failure) {
      if (!signal.aborted && revision === permissionRevision.current && activeRef.current && !scope.isInvalidated && !isAbortError(failure)) setPermissionCheckFailed(true);
    } finally {
      if (!signal.aborted && revision === permissionRevision.current && activeRef.current) { permissionLifetime.current = null; setCheckingPermission(false); }
    }
  };
  const canWrite = active && !permissionDenied && access.status === 'ready' && access.access !== null && !scope.isInvalidated && !scope.isProjectSuspended(projectId);
  const open = (next: Dialog) => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; dialogLifetime.current.abort(); dialogLifetime.current = new AbortController(); setReading(false); setMatches(null); setDialog(next); setPhase('idle'); setError(null); setChecked(false); setObserved(null); setMissing(false); setAttempted(false); };
  const close = () => { if (phase !== 'pending' && (phase !== 'unknown' || checked)) { dialogLifetime.current.abort(); setDialog(null); catalog.refresh(); const target = opener.current; queueMicrotask(() => { if (target?.isConnected && !target.closest('[hidden], [inert]')) target.focus(); }); } };
  // Neither endpoint alone supplies the name, color and exact version together.
  // Pair fresh responses rather than combining a retained projection with a new version.
  const readMatched = async (id: string, s: AbortSignal): Promise<Observation> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const [tag, page] = await Promise.all([
        getProjectTag(projectId, id, s, admission),
        resolveProjectTagColors(projectId, [id], null, s, admission),
      ]);
      const color = page.items[0];
      if (color?.state === 'missing') throw new ApiError('server', 404, 'tag_not_found');
      if (color?.state === 'found' && tag.version === color.version) return { tag, color: color.color };
    }
    throw new Error('Tag version and color did not match');
  };
  const loadEdit = async (target: Extract<Dialog, { kind: 'rename' }>) => {
    setReading(true); setError(null); setMissing(false);
    const s = signal();
    try {
      await scope.ready(s);
      const current = await readMatched(target.tag.id, s);
      if (!s.aborted) setDialog(previous => previous?.kind === 'rename' && previous.tag.id === target.tag.id && previous.color === null
        ? { ...previous, tag: current.tag, name: current.tag.name, color: current.color } : previous);
    } catch (failure) {
      if (s.aborted || isAbortError(failure)) return;
      if (failure instanceof ApiError && failure.code === 'tag_not_found') setMissing(true);
      else { setError(failure); if (failure instanceof ApiError && (failure.status === 403 || failure.status === 404 && failure.code === 'not_found')) void access.session.revalidateAfterMutation(true); }
    } finally { if (!s.aborted) setReading(false); }
  };
  const inspect = async (target: Dialog, preview = false) => {
    setReading(true); setError(null); setMissing(false); setObserved(null); setMatches(null); setChecked(false);
    const s = signal();
    try {
      await scope.ready(s);
      if (target.kind === 'create') {
        const name = normalizeTagName(target.name) ?? '';
        let cursor: string | null = null, epoch: string | null = null;
        const visited = new Set<string>(); const found: ProjectTag[] = [];
        do {
          const result = await listProjectTags(projectId, { query: name, limit: 50, cursor }, s, admission);
          if (epoch !== null && result.catalogEpoch !== epoch) throw new Error('Catalog changed');
          epoch = result.catalogEpoch;
          found.push(...result.items.filter(item => tagNameKey(item.name) === tagNameKey(name)));
          cursor = result.nextCursor;
          if (cursor !== null && visited.has(cursor)) throw new Error('Repeated catalog cursor');
          if (cursor !== null) visited.add(cursor);
        } while (cursor !== null && found.length === 0);
        const values = await Promise.all(found.map(item => readMatched(item.id, s)));
        if (!s.aborted) { setMatches(values); catalog.refresh(); setChecked(true); }
      }
      else {
        if (target.kind === 'delete' && preview) {
          const value = await getProjectTag(projectId, target.tag.id, s, admission);
          if (!s.aborted) { setChecked(true); setDialog({ ...target, preview: value }); }
        } else {
          const value = await readMatched(target.tag.id, s);
          if (!s.aborted) { setObserved(value); setChecked(true); }
        }
      }
    } catch (failure) {
      if (s.aborted || isAbortError(failure)) return;
      if (failure instanceof ApiError && failure.code === 'tag_not_found') { setMissing(true); setChecked(true); }
      else {
        setError(failure);
        if (failure instanceof ApiError && (failure.status === 403 || failure.status === 404 && failure.code === 'not_found')) void access.session.revalidateAfterMutation(true);
      }
    } finally { if (!s.aborted) setReading(false); }
  };
  const startEdit = (tag: ProjectTag) => { const target: Extract<Dialog, { kind: 'rename' }> = { kind: 'rename', name: tag.name, color: null, tag, preview: null }; open(target); void loadEdit(target); };
  const startDelete = (tag: ProjectTag) => { const target: Dialog = { kind: 'delete', name: tag.name, tag, preview: null }; open(target); void inspect(target, true); };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (dialog === null || phase !== 'idle' || !canWrite || reading || authRequestsPaused()) return;
    const name = normalizeTagName(dialog.name); setAttempted(true);
    if (dialog.kind !== 'delete' && name === null) return;
    const color = dialog.kind === 'delete' || dialog.color === null ? null : normalizeTagColor(dialog.color);
    if (dialog.kind !== 'delete' && color === null) return;
    if (dialog.kind === 'delete' && dialog.preview === null) return;
    setPhase('pending'); setError(null); let dispatched = false, confirmed = false;
    const operation = { dispatched: false }; write.current = operation;
    const s = signal();
    try {
      await scope.ready(s);
      if (await access.session.waitForFreshAccess(s) === null || scope.isInvalidated || scope.isProjectSuspended(projectId) || authRequestsPaused()) throw new Error('Project access unavailable');
      const writeAdmission = { ...admission, onDispatch: () => { dispatched = true; operation.dispatched = true; }, onWriteConfirmed: () => { confirmed = true; } };
      if (dialog.kind === 'create') await createProjectTag(projectId, name!, s, writeAdmission, color!);
      else if (dialog.kind === 'rename') await updateProjectTag(projectId, dialog.tag.id, { name: name!, color: color! }, dialog.tag.version, s, writeAdmission);
      else await deleteProjectTag(projectId, dialog.tag.id, dialog.preview!.version, s, writeAdmission);
      if (!s.aborted) { write.current = null; setDialog(null); setPhase('idle'); scope.notifyTagColors(projectId); catalog.refresh(); }
    } catch (failure) {
      if (write.current !== operation || s.aborted) return;
      write.current = null;
      const unknown = dispatched && (confirmed || !(failure instanceof ApiError) || failure.writeOutcome !== 'not_committed' && (failure.kind !== 'server' || failure.status === null || failure.status >= 500 || failure.code === 'write_outcome_unknown'));
      const conflict = failure instanceof ApiError && failure.code === 'version_conflict';
      if (failure instanceof ApiError && (failure.status === 403 || failure.code === 'permission_denied')) {
        denialsFor(scope).add(projectId); setPermissionDenied(true);
        void checkPermission();
      }
      setPhase(unknown ? 'unknown' : conflict ? 'conflict' : 'idle'); setError(failure); setChecked(false); setObserved(null);
      if (unknown || conflict) { catalog.refresh(); void inspect(dialog); }
    }
  };
  const invalid = dialog !== null && dialog.kind !== 'delete' && normalizeTagName(dialog.name) === null;
  const denied = permissionDenied || access.status === 'ready' && access.access === null;
  const errorText = error instanceof ApiError && error.code === 'tag_name_conflict' ? m.duplicate : error instanceof ApiError && error.code === 'invalid_tag_name' ? m.invalid : error instanceof ApiError && (error.code === 'permission_denied' || error.code === 'forbidden') ? m.denied : m.failed;
  return <section className="project-tags" aria-labelledby="project-tags-heading">
    <div className="project-tags-heading"><div><h2 id="project-tags-heading">{m.title}</h2><p>{m.description}</p></div><button className="button primary" type="button" disabled={!canWrite} onClick={() => open({ kind: 'create', name: '', color: DEFAULT_TAG_COLOR })}>{m.create}</button></div>
    {denied && <div role="status"><p>{m.denied}</p>{dialog === null && permissionDenied && <button className="button" type="button" disabled={checkingPermission} onClick={() => { void checkPermission(); }}>{checkingPermission ? m.checkingPermission : m.checkPermission}</button>}{dialog === null && permissionCheckFailed && <p>{m.permissionCheckFailed}</p>}</div>}
    <label className="project-tags-search">{m.search}<input type="search" value={catalog.query} onChange={(event) => catalog.setQuery(event.currentTarget.value)} /></label>
    {catalog.refreshing && <p role="status">{m.refreshing}</p>}
    {catalog.loading && catalog.page === null && <p role="status">{m.loading}</p>}
    {catalog.error !== null && <div role="alert"><p>{m.readError}</p><button className="button" type="button" onClick={catalog.refresh}>{m.retry}</button></div>}
    <TagColorFeedback projectId={projectId} ids={colorIds} onRetry={catalog.refresh} />
    {catalog.page !== null && <>{catalog.page.items.length === 0 ? <p>{catalog.query ? m.noMatches : m.empty}</p> : <ul className="project-tags-list">{catalog.page.items.map((tag) => <li key={tag.id}><div className="project-tags-name"><strong><TagColorChip name={tag.name} item={colors.items.get(tag.id)} /></strong><span>{m.usage(tag.usage.tasks, tag.usage.goals)}</span></div><div className="project-tags-actions"><button className="button" type="button" disabled={!canWrite} onClick={() => startEdit(tag)} aria-label={`${m.edit}: ${tag.name}`}>{m.edit}</button><button className="button" type="button" disabled={!canWrite} onClick={() => startDelete(tag)} aria-label={`${m.remove}: ${tag.name}`}>{m.remove}</button></div></li>)}</ul>}
      <div className="project-tags-pagination"><button className="button" type="button" disabled={catalog.loading} onClick={catalog.first}>{m.first}</button><button className="button" type="button" disabled={catalog.loading || catalog.page.nextCursor === null} onClick={catalog.next}>{m.next}</button></div></>}
    {dialog !== null && <ManagementDialog title={dialog.kind === 'create' ? m.create : dialog.kind === 'rename' ? m.edit : m.deleteTitle} busy={phase === 'pending'} suspended={!active || access.status === 'unavailable' || scope.isInvalidated || scope.isProjectSuspended(projectId)} onClose={close} initialFocus={dialog.kind === 'create' ? 'input' : 'cancel'} footer={<><button className="button" data-dialog-cancel type="button" disabled={phase === 'pending' || phase === 'unknown' && !checked} onClick={close}>{phase === 'unknown' ? m.checked : m.cancel}</button><button className={`button ${dialog.kind === 'delete' ? 'danger' : 'primary'}`} type="submit" form="project-tag-form" disabled={!canWrite || phase !== 'idle' || reading || dialog.kind === 'delete' && dialog.preview === null || dialog.kind === 'rename' && dialog.color === null}>{phase === 'pending' ? m.saving : dialog.kind === 'delete' ? m.deleteConfirm : m.save}</button></>}>
      <form id="project-tag-form" onSubmit={(event) => { void submit(event); }}>
        {dialog.kind !== 'delete' ? <><div className="project-tag-field"><label htmlFor="project-tag-name">{m.name}</label><input id="project-tag-name" value={dialog.name} disabled={phase === 'pending' || phase === 'unknown' || dialog.kind === 'rename' && dialog.color === null} aria-invalid={attempted && invalid} aria-describedby="project-tag-name-hint" onChange={(event) => { setDialog({ ...dialog, name: event.currentTarget.value }); setError(null); }} /><span id="project-tag-name-hint">{m.hint}</span>{attempted && invalid && <span role="alert">{m.invalid}</span>}</div>
          {dialog.color !== null && <TagColorInput value={dialog.color} name={dialog.name} disabled={!canWrite || phase === 'pending' || phase === 'unknown'} attempted={attempted} onChange={color => { setDialog({ ...dialog, color }); setError(null); }} />}
          {dialog.kind === 'rename' && dialog.color === null && <div role={reading ? 'status' : 'alert'}><p>{reading ? m.preview : missing ? m.missing : m.readError}</p>{!reading && !missing && <button className="button" type="button" onClick={() => { void loadEdit(dialog); }}>{m.retry}</button>}</div>}
        </> : dialog.preview === null ? <p>{reading ? m.preview : m.readError}</p> : <><p><strong>{dialog.preview.name}</strong></p><p>{m.usage(dialog.preview.usage.tasks, dialog.preview.usage.goals)}</p><p>Version: {dialog.preview.version.toString()}</p><p>{m.deleteWarning}</p></>}
        {(phase === 'unknown' || phase === 'conflict') && <div role="alert"><p>{phase === 'unknown' ? m.unknown : m.conflict}</p>{observed !== null && <p>{m.current}: <TagColorChip name={observed.tag.name} item={{ id: observed.tag.id, state: 'found', version: observed.tag.version, color: observed.color }} /> ({m.usage(observed.tag.usage.tasks, observed.tag.usage.goals)}) {observed.color}</p>}{missing && <p>{m.missing}</p>}{matches !== null && <p>{m.current}: {matches.length === 0 ? m.noMatches : matches.map(item => `${item.tag.name} (${item.color})`).join(', ')}</p>}{error !== null && <p>{m.readError}</p>}<button className="button" type="button" disabled={reading} onClick={() => { void inspect(dialog); }}>{reading ? m.checking : m.check}</button>{phase === 'conflict' && observed !== null && dialog.kind !== 'create' && <button className="button" type="button" onClick={() => { setDialog(dialog.kind === 'delete' ? { ...dialog, tag: observed.tag, preview: observed.tag } : { ...dialog, tag: observed.tag }); setPhase('idle'); setError(null); setObserved(null); }}>{m.useCurrent}</button>}</div>}
        {error !== null && phase === 'idle' && !(dialog.kind === 'rename' && dialog.color === null) && <p role="alert">{errorText}</p>}
        {permissionDenied && <div><button className="button" type="button" disabled={checkingPermission} onClick={() => { void checkPermission(); }}>{checkingPermission ? m.checkingPermission : m.checkPermission}</button>{permissionCheckFailed && <p role="status">{m.permissionCheckFailed}</p>}</div>}
      </form>
    </ManagementDialog>}
  </section>;
};
