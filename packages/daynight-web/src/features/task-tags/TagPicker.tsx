import { useEffect, useRef, useState } from 'react';
import { ApiError, authRequestsPaused, isAbortError } from '../../api/client';
import { createProjectTag, listProjectTags, normalizeTagName, resolveProjectTags, tagNameKey } from '../../api/task-tags';
import type { TaskTag } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { useProjectAccess } from '../projects/ProjectAccess';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { tagMessages } from './messages';
import { useProjectTags } from './useProjectTags';

export const TagPicker = ({ projectId, value, onChange, canWrite, onCreatingChange, onNameDirty }: {
  readonly projectId: string; readonly value: readonly TaskTag[];
  readonly onChange: (value: readonly TaskTag[]) => void; readonly canWrite: boolean; readonly onCreatingChange?: (creating: boolean) => void; readonly onNameDirty?: (dirty: boolean) => void;
}) => {
  const { locale } = useI18n(); const m = tagMessages[locale];
  const scope = useTaskCacheScope(); const access = useProjectAccess(projectId);
  const catalog = useProjectTags(projectId);
  const [name, setName] = useState(''); const nameRef = useRef(name); nameRef.current = name;
  const attemptedName = useRef(''); const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState(false); const [resolveRetry, setResolveRetry] = useState(0);
  const [checking, setChecking] = useState(false); const [matches, setMatches] = useState<readonly TaskTag[] | null>(null);
  const [unknown, setUnknown] = useState(false);
  const lifetime = useRef(new AbortController());
  const latest = useRef({ value, onChange }); latest.current = { value, onChange };
  const ids = value.map(tag => tag.id).sort().join(',');
  useEffect(() => () => lifetime.current.abort(), []);
  useEffect(() => {
    if (!ids || catalog.page === null) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetime.current.signal, scope.signal]);
    const selected = ids.split(',');
    const admission = { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch };
    void (async () => {
      try {
        await scope.ready(signal);
        let resolved: readonly TaskTag[];
        try { resolved = await resolveProjectTags(projectId, selected, signal, admission); }
        catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'tag_not_found') throw error;
          const individually = await Promise.all(selected.map(async id => {
            try { return (await resolveProjectTags(projectId, [id], signal, admission))[0]!; }
            catch (failure) { if (failure instanceof ApiError && failure.code === 'tag_not_found') return null; throw failure; }
          }));
          resolved = individually.filter((tag): tag is TaskTag => tag !== null);
        }
        await scope.ready(signal);
        if (signal.aborted || scope.isInvalidated || scope.isProjectSuspended(projectId)) return;
        const byId = new Map(resolved.map(tag => [tag.id, tag]));
        const current = latest.current.value;
        const next = current.flatMap(tag => selected.includes(tag.id) ? (byId.has(tag.id) ? [byId.get(tag.id)!] : []) : [tag]);
        if (next.length !== current.length || next.some((tag, index) => tag.name !== current[index]?.name)) latest.current.onChange(next);
        setResolveError(false);
      } catch (error) { if (!signal.aborted && !isAbortError(error)) setResolveError(true); }
    })();
    return () => controller.abort();
  }, [scope, projectId, ids, catalog.page?.catalogEpoch, resolveRetry]);
  const toggle = (tag: TaskTag) => onChange(value.some(item => item.id === tag.id) ? value.filter(item => item.id !== tag.id) : [...value, { id: tag.id, name: tag.name }]);
  const create = async () => {
    const normalized = normalizeTagName(name);
    if (normalized === null) { setCreateError(m.invalid); return; }
    if (creating || unknown || !canWrite || authRequestsPaused()) return;
    attemptedName.current = normalized; setCreating(true); onCreatingChange?.(true); setCreateError(null);
    const signal = AbortSignal.any([scope.signal, lifetime.current.signal]);
    let dispatched = false, confirmed = false;
    try {
      await scope.ready(signal);
      if (await access.session.waitForFreshAccess(signal) === null || scope.isInvalidated || scope.isProjectSuspended(projectId) || authRequestsPaused()) throw new Error('Project access unavailable');
      const tag = await createProjectTag(projectId, normalized, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch, onDispatch: () => { dispatched = true; }, onWriteConfirmed: () => { confirmed = true; } });
      await scope.ready(signal);
      if (signal.aborted || scope.isInvalidated || scope.isProjectSuspended(projectId)) return;
      const current = latest.current.value;
      if (!current.some(item => item.id === tag.id)) latest.current.onChange([...current, { id: tag.id, name: tag.name }]);
      if (nameRef.current === name) { setName(''); onNameDirty?.(false); } catalog.refresh();
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return;
      const uncertain = dispatched && (confirmed || !(error instanceof ApiError) || error.writeOutcome !== 'not_committed' && (error.kind !== 'server' || error.status === null || error.status >= 500 || error.code === 'write_outcome_unknown'));
      setUnknown(uncertain);
      setCreateError(uncertain ? m.unknown : error instanceof ApiError && error.code === 'tag_name_conflict' ? m.duplicate : error instanceof ApiError && error.code === 'invalid_tag_name' ? m.invalid : error instanceof ApiError && (error.status === 403 || error.code === 'permission_denied') ? m.denied : error instanceof ApiError && error.code === 'resource_limit_exceeded' ? (locale === 'zh-CN' ? '已达到标签容量上限。' : 'The tag capacity limit was reached.') : m.failed);
      if (uncertain) catalog.refresh();
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) void access.session.revalidateAfterMutation(true);
    } finally { if (!signal.aborted) { setCreating(false); onCreatingChange?.(false); } }
  };
  const inspectCreate = async () => {
    if (checking) return;
    setChecking(true); setMatches(null);
    const signal = AbortSignal.any([scope.signal, lifetime.current.signal]);
    try {
      await scope.ready(signal);
      const normalized = attemptedName.current;
      const admission = { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch };
      let cursor: string | null = null, epoch: string | null = null;
      const visited = new Set<string>(); const found: TaskTag[] = [];
      do {
        const page = await listProjectTags(projectId, { query: normalized, cursor, limit: 50 }, signal, admission);
        if (epoch !== null && epoch !== page.catalogEpoch) throw new Error('Catalog changed');
        epoch = page.catalogEpoch;
        found.push(...page.items.filter(tag => tagNameKey(tag.name) === tagNameKey(normalized)));
        cursor = page.nextCursor;
        if (cursor !== null && visited.has(cursor)) throw new Error('Repeated catalog cursor');
        if (cursor !== null) visited.add(cursor);
      } while (cursor !== null && found.length === 0);
      await scope.ready(signal);
      if (!signal.aborted && !scope.isInvalidated && !scope.isProjectSuspended(projectId)) { setMatches(found); catalog.refresh(); }
    } catch (error) { if (!signal.aborted && !isAbortError(error)) setCreateError(m.readError); }
    finally { if (!signal.aborted) setChecking(false); }
  };
  return <div className="tag-picker">
    <div className="tag-picker-selected">{value.map(tag => <span className="task-tag" key={tag.id}>{tag.name} <button type="button" aria-label={`${locale === 'zh-CN' ? '移除' : 'Remove'} ${tag.name}`} onClick={() => toggle(tag)}>×</button></span>)}</div>
    <label>{m.search}<input type="search" value={catalog.query} onChange={event => catalog.setQuery(event.currentTarget.value)} /></label>
    {catalog.loading && catalog.page === null && <p role="status">{m.loading}</p>}
    {catalog.error !== null && <div role="alert">{m.readError} <button className="button" type="button" onClick={catalog.refresh}>{m.retry}</button></div>}
    {resolveError && <div role="alert">{m.readError} <button className="button" type="button" onClick={() => setResolveRetry(value => value + 1)}>{m.retry}</button></div>}
    {catalog.page !== null && <><div className="tag-picker-options">{catalog.page.items.length === 0 ? <p>{catalog.query ? m.noMatches : m.empty}</p> : catalog.page.items.map(tag => <label key={tag.id}><input type="checkbox" checked={value.some(item => item.id === tag.id)} onChange={() => toggle(tag)} /> {tag.name}</label>)}</div><div className="tag-picker-actions"><button className="button" type="button" disabled={catalog.loading} onClick={catalog.first}>{m.first}</button><button className="button" type="button" disabled={catalog.loading || catalog.page.nextCursor === null} onClick={catalog.next}>{m.next}</button></div></>}
    <div className="tag-picker-create"><label>{m.name}<input value={name} disabled={unknown} onChange={event => { setName(event.currentTarget.value); onNameDirty?.(event.currentTarget.value !== ''); setCreateError(null); }} /></label><button className="button" type="button" disabled={!canWrite || creating || unknown} onClick={() => { void create(); }}>{creating ? m.saving : m.create}</button></div>
    <p>{locale === 'zh-CN' ? '新标签立即加入项目标签库；取消编辑不会删除它。' : 'New tags are added to the project immediately; cancelling editing will not delete them.'}</p>
    {createError !== null && <div role="alert">{createError}{unknown && <><p>{m.name}: {attemptedName.current}</p><button className="button" type="button" disabled={checking} onClick={() => { void inspectCreate(); }}>{checking ? m.checking : m.check}</button>{matches !== null && <><p>{m.current}: {matches.length ? matches.map(tag => tag.name).join(', ') : m.noMatches}</p><button className="button" type="button" onClick={() => { setUnknown(false); setCreateError(null); setMatches(null); }}>{m.checked}</button></>}</>}</div>}
  </div>;
};
