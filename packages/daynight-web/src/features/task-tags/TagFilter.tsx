import { NativeSelect, isNativeSelectPopupOpen } from '../../ui/native-select/NativeSelect';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { resolveProjectTags } from '../../api/task-tags';
import type { TaskTag } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useProjectTags } from './useProjectTags';
import './tag-filter.css';

export type TagFilterValue = { readonly tagIds: readonly string[]; readonly tagMatch: 'all' | 'any'; readonly untagged: boolean };
export const emptyTagFilter: TagFilterValue = { tagIds: [], tagMatch: 'all', untagged: false };
export const matchesTagFilter = (tags: readonly TaskTag[], value: TagFilterValue): boolean => {
  if (value.untagged) return tags.length === 0;
  if (value.tagIds.length === 0) return true;
  const ids = new Set(tags.map(tag => tag.id));
  return value.tagMatch === 'all' ? value.tagIds.every(id => ids.has(id)) : value.tagIds.some(id => ids.has(id));
};

type Selection = { readonly scope: object; readonly projectId: string; readonly value: TagFilterValue; readonly names: Readonly<Record<string, string>>; readonly invalidIds: readonly string[]; readonly unidentified: boolean; readonly afterRemoval: boolean; readonly error: unknown };
const initial = (scope: object, projectId: string): Selection => ({ scope, projectId, value: emptyTagFilter, names: {}, invalidIds: [], unidentified: false, afterRemoval: false, error: null });

export const useTagFilter = (projectId: string, active = true) => {
  const scope = useTaskCacheScope();
  const [stored, setStored] = useState<Selection>(() => initial(scope, projectId));
  const state = stored.scope === scope && stored.projectId === projectId ? stored : initial(scope, projectId);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState(() => ({ scope, projectId, query: '' }));
  const query = search.scope === scope && search.projectId === projectId ? search.query : '';
  const setQuery = useCallback((value: string) => setSearch({ scope, projectId, query: value }), [scope, projectId]);
  const catalogActive = active && (open || state.value.tagIds.length > 0);
  const catalog = useProjectTags(projectId, catalogActive);
  useEffect(() => { if (catalogActive && catalog.query !== query) catalog.setQuery(query); }, [catalogActive, catalog.query, catalog.setQuery, query]);
  const [revision, setRevision] = useState(0);
  const blocked = useRef(false);
  const resolving = useRef<AbortController | null>(null);
  const idsKey = JSON.stringify(state.value.tagIds);
  const epoch = catalog.page?.catalogEpoch;
  useEffect(() => {
    setStored(previous => previous.scope === scope && previous.projectId === projectId ? previous : initial(scope, projectId));
    setSearch(previous => previous.scope === scope && previous.projectId === projectId ? previous : { scope, projectId, query: '' });
    blocked.current = scope.isProjectSuspended(projectId);
    const unsubscribe = scope.subscribe(event => {
      if (event.projectId !== projectId) return;
      if (event.accessRevoked || event.directAccessUncertain) {
        blocked.current = true; resolving.current?.abort();
        if (event.accessRevoked) { setStored(initial(scope, projectId)); setQuery(''); }
      } else if (event.accessRestored) { blocked.current = false; setRevision(value => value + 1); }
      else if (event.historyChanged) { resolving.current?.abort(); setRevision(value => value + 1); }
    });
    return () => { resolving.current?.abort(); resolving.current = null; unsubscribe(); };
  }, [scope, projectId, setQuery]);
  useEffect(() => {
    const ids = JSON.parse(idsKey) as string[];
    if (!active || ids.length === 0 || !epoch || blocked.current || scope.isProjectSuspended(projectId)) return;
    const controller = new AbortController(); resolving.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    const admission = { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch };
    const publish = (names: readonly TaskTag[], invalidIds: readonly string[], error: unknown = null, identified = false) => {
      if (signal.aborted || scope.isInvalidated || blocked.current || scope.isProjectSuspended(projectId)) return;
      setStored(previous => {
        if (previous.scope !== scope || previous.projectId !== projectId || JSON.stringify(previous.value.tagIds) !== idsKey) return previous;
        return { ...previous, names: { ...previous.names, ...Object.fromEntries(names.map(tag => [tag.id, tag.name])) }, invalidIds: [...new Set([...previous.invalidIds, ...invalidIds])], unidentified: identified && invalidIds.length > 0 || error === null && names.length > 0 && previous.afterRemoval ? false : previous.unidentified, afterRemoval: error === null ? false : previous.afterRemoval, error };
      });
    };
    void (async () => {
      try {
        await scope.ready(signal);
        const names = await resolveProjectTags(projectId, ids, signal, admission);
        await scope.ready(signal);
        publish(names, []);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        if (!(error instanceof ApiError) || error.code !== 'tag_not_found') { publish([], [], error); return; }
        const results = await Promise.all(ids.map(async id => {
          try { return { id, tags: await resolveProjectTags(projectId, [id], signal, admission), error: null }; }
          catch (failure) { return { id, tags: [] as readonly TaskTag[], error: failure }; }
        }));
        try { await scope.ready(signal); } catch { return; }
        if (signal.aborted || blocked.current || scope.isProjectSuspended(projectId)) return;
        const missing = results.filter(result => result.error instanceof ApiError && result.error.code === 'tag_not_found').map(result => result.id);
        const failure = results.find(result => result.error !== null && !(result.error instanceof ApiError && result.error.code === 'tag_not_found'))?.error ?? null;
        publish(results.flatMap(result => result.tags), missing.length ? missing : failure === null ? ids : [], failure, failure === null);
      }
    })();
    return () => { controller.abort(); if (resolving.current === controller) resolving.current = null; };
  }, [active, idsKey, epoch, scope, projectId, revision]);
  const update = useCallback((value: TagFilterValue, names: Readonly<Record<string, string>> = {}) => {
    const normalized: TagFilterValue = { tagIds: value.untagged ? [] : [...new Set(value.tagIds)].sort(), tagMatch: value.tagMatch, untagged: value.untagged };
    setStored(previous => {
      const old = previous.scope === scope && previous.projectId === projectId ? previous : initial(scope, projectId);
      return { ...old, value: normalized, names: { ...old.names, ...names }, invalidIds: old.invalidIds.filter(id => normalized.tagIds.includes(id)), unidentified: old.unidentified && normalized.tagIds.length > 0, afterRemoval: old.unidentified && normalized.tagIds.length > 0 && (old.afterRemoval || old.value.tagIds.some(id => !normalized.tagIds.includes(id))), error: null };
    });
  }, [scope, projectId]);
  const markInvalid = useCallback(() => {
    setStored(previous => previous.scope === scope && previous.projectId === projectId ? { ...previous, unidentified: previous.value.tagIds.length > 0, afterRemoval: false } : previous);
    setRevision(value => value + 1);
  }, [scope, projectId]);
  return { open, setOpen, query, setQuery, value: state.value, invalid: state.unidentified || state.invalidIds.length > 0, invalidIds: state.invalidIds, names: state.names, error: state.error, update, markInvalid, retry: () => setRevision(value => value + 1), catalog };
};

export type TagFilterController = ReturnType<typeof useTagFilter>;
const messages = {
  en: { manage: 'Manage tags', title: 'Tag filter', child: 'Child task tag filter', clear: 'Clear', search: 'Search tags', all: 'Match all (AND)', any: 'Match any (OR)', untagged: 'No tags', invalid: 'A selected tag is unavailable. Remove it to search again.', removed: 'unavailable', remove: 'Remove', loading: 'Loading tags…', empty: 'No tags yet.', noMatches: 'No matching tags.', error: 'Could not load tags.', resolveError: 'Could not check selected tags.', retry: 'Retry', next: 'Next', first: 'First page' },
  'zh-CN': { manage: '管理标签', title: '标签筛选', child: '子 Task 标签筛选', clear: '清除', search: '搜索标签', all: '全部匹配（AND）', any: '任一匹配（OR）', untagged: '无标签', invalid: '选中的标签已不可用，请移除后重新查询。', removed: '已不可用', remove: '移除', loading: '正在读取标签…', empty: '还没有标签。', noMatches: '没有匹配的标签。', error: '无法读取标签。', resolveError: '无法核对选中的标签。', retry: '重试', next: '下一页', first: '首页' },
} as const;

export const TagFilter = ({ controller, child = false, onManage }: { readonly controller: TagFilterController; readonly child?: boolean; readonly onManage?: () => void }) => {
  const { locale } = useI18n(); const m = messages[locale];
  const { value, names, invalidIds, catalog, update } = controller;
  const title = child ? m.child : m.title;
  const details = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    if (!controller.open) return;
    const position = () => {
      const element = details.current;
      const panel = element?.querySelector<HTMLElement>('.tag-filter-panel');
      if (element === null || panel === undefined || panel === null) return;
      const bounds = element.getBoundingClientRect();
      const width = panel.getBoundingClientRect().width;
      const left = Math.max(16, Math.min(bounds.left, document.documentElement.clientWidth - width - 16));
      panel.style.left = `${left - bounds.left}px`;
    };
    position();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    if (details.current !== null) {
      observer?.observe(details.current);
      const toolbar = details.current.closest('.task-list-filters');
      if (toolbar !== null) {
        observer?.observe(toolbar);
        for (const control of toolbar.children) observer?.observe(control);
      }
    }
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { observer?.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [controller.open, locale]);
  const toggle = (tag: TaskTag, checked: boolean) => update({ ...value, untagged: false, tagIds: checked ? [...value.tagIds, tag.id] : value.tagIds.filter(id => id !== tag.id) }, { [tag.id]: tag.name });
  const clear = () => update({ ...value, tagIds: [], untagged: false });
  const count = value.untagged ? 1 : value.tagIds.length;
  return <div className="tag-filter-wrap">
    <details ref={details} className="tag-filter" open={controller.open} onToggle={event => controller.setOpen(event.currentTarget.open)} onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === 'Escape' && event.currentTarget.open) {
        if (isNativeSelectPopupOpen(event.target)) { event.stopPropagation(); return; }
        event.preventDefault(); event.stopPropagation(); controller.setOpen(false);
        event.currentTarget.querySelector<HTMLElement>('summary')?.focus();
      }
    }}>
      <summary className="tag-filter-trigger" onClick={event => { event.preventDefault(); controller.setOpen(!controller.open); }}>{title}{count > 0 ? ` (${count})` : ''}</summary>
      <div className="tag-filter-panel">
        <div className="tag-filter-head"><strong>{title}</strong><button type="button" onClick={clear}>{m.clear}</button></div>
        <input type="search" aria-label={`${title}: ${m.search}`} placeholder={m.search} value={controller.query} onChange={event => controller.setQuery(event.target.value)} />
        <NativeSelect density="filter" focusTone="task" layout="fill" wrapperClassName="tag-filter-match" aria-label={`${title}: AND / OR`} value={value.tagMatch} disabled={value.untagged} onChange={event => update({ ...value, tagMatch: event.target.value as 'all' | 'any' })}><option value="all">{m.all}</option><option value="any">{m.any}</option></NativeSelect>
        <label><input type="checkbox" checked={value.untagged} onChange={event => update({ ...value, untagged: event.target.checked, tagIds: event.target.checked ? [] : value.tagIds })} /> {m.untagged}</label>
        {catalog.error !== null ? <p role="alert">{m.error} <button type="button" onClick={catalog.refresh}>{m.retry}</button></p> : catalog.loading && catalog.page === null ? <p>{m.loading}</p> : catalog.page?.items.length === 0 ? <p>{controller.query ? m.noMatches : m.empty}</p> : <div className="tag-filter-options">{catalog.page?.items.map(tag => <label key={tag.id}><input type="checkbox" checked={value.tagIds.includes(tag.id)} onChange={event => toggle(tag, event.target.checked)} /> <span>{tag.name}</span></label>)}</div>}
        {catalog.page?.nextCursor && <button type="button" onClick={catalog.next}>{m.next}</button>}
        {catalog.cursor !== null && <button type="button" onClick={catalog.first}>{m.first}</button>}
        {!child && onManage !== undefined && <div className="tag-filter-manage"><button type="button" onClick={onManage}>{m.manage}</button></div>}
      </div>
    </details>
    {controller.invalid && <p className="tag-filter-error" role="alert">{m.invalid}</p>}
    {controller.error !== null && <p className="tag-filter-error" role="alert">{m.resolveError} <button type="button" onClick={controller.retry}>{m.retry}</button></p>}
    {(value.tagIds.length > 0 || value.untagged) && <div className="tag-filter-selected">{value.tagIds.map(id => <span className="tag-filter-chip" key={id}>{names[id] ?? id}{invalidIds.includes(id) ? ` · ${m.removed}` : ''}<button type="button" aria-label={`${m.remove} ${names[id] ?? id}`} onClick={() => update({ ...value, tagIds: value.tagIds.filter(selected => selected !== id) })}>×</button></span>)}{value.untagged && <span className="tag-filter-chip">{m.untagged}<button type="button" aria-label={`${m.remove} ${m.untagged}`} onClick={() => update({ ...value, untagged: false })}>×</button></span>}</div>}
  </div>;
};
