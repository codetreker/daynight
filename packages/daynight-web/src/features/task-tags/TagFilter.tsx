import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { resolveProjectTags } from '../../api/task-tags';
import type { TaskTag } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { SelectTrigger } from '../../ui/selection-control/SelectTrigger';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useProjectTags } from './useProjectTags';
import { TagColorChip, TagColorFeedback } from './TagColor';
import { useTagColors } from './useTagColors';
import { useTagFilterPopover } from './useTagFilterPopover';
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
  return { projectId, open, setOpen, query, setQuery, value: state.value, invalid: state.unidentified || state.invalidIds.length > 0, invalidIds: state.invalidIds, names: state.names, error: state.error, update, markInvalid, retry: () => setRevision(value => value + 1), catalog };
};

export type TagFilterController = ReturnType<typeof useTagFilter>;
const messages = {
  en: { manage: 'Manage tags', title: 'Tag filter', child: 'Child task tag filter', clear: 'Clear filter', search: 'Find tags', clearQuery: 'Clear tag search', all: 'All selected', any: 'Any selected', untagged: 'Untagged only', match: 'Match', oneRule: 'Choose at least two tags to change matching', untaggedRule: 'Matching does not apply to untagged items', invalid: 'A selected tag is unavailable. Remove it to search again.', removed: 'unavailable', remove: 'Remove', loading: 'Loading tags…', empty: 'No tags yet.', noMatches: 'No matching tags.', error: 'Could not load tags.', resolveError: 'Could not check selected tags.', retry: 'Retry', next: 'Next', first: 'First page' },
  'zh-CN': { manage: '管理标签', title: '标签筛选', child: '子 Task 标签筛选', clear: '清空筛选', search: '查找标签', clearQuery: '清空查找词', all: '全部满足', any: '满足任一', untagged: '仅无标签', match: '匹配方式', oneRule: '选择至少两个标签时可切换匹配方式', untaggedRule: '仅无标签不使用匹配方式', invalid: '选中的标签已不可用，请移除后重新查询。', removed: '已不可用', remove: '移除', loading: '正在读取标签…', empty: '还没有标签。', noMatches: '没有匹配的标签。', error: '无法读取标签。', resolveError: '无法核对选中的标签。', retry: '重试', next: '下一页', first: '首页' },
} as const;

export const TagFilter = ({ controller, child = false, onManage }: { readonly controller: TagFilterController; readonly child?: boolean; readonly onManage?: () => void }) => {
  const { locale } = useI18n(); const m = messages[locale];
  const matchId = useId();
  const { value, names, invalidIds, catalog, update } = controller;
  const title = child ? m.child : m.title;
  const colorIds = [...value.tagIds, ...(controller.open ? catalog.page?.items.map(tag => tag.id) ?? [] : [])];
  const colors = useTagColors(controller.projectId, colorIds);
  const popover = useTagFilterPopover(controller.open, controller.setOpen);
  const toggle = (tag: TaskTag, checked: boolean) => update({ ...value, untagged: false, tagIds: checked ? [...value.tagIds, tag.id] : value.tagIds.filter(id => id !== tag.id) }, { [tag.id]: tag.name });
  const clear = () => update({ ...value, tagIds: [], untagged: false });
  const count = value.untagged ? 1 : value.tagIds.length;
  const matchDisabled = value.untagged || value.tagIds.length < 2;
  const page = catalog.query === controller.query ? catalog.page : null;
  return <div className="tag-filter-wrap">
    <details ref={popover.rootRef} className="tag-filter" open={controller.open} onToggle={event => controller.setOpen(event.currentTarget.open)} onKeyDown={popover.onKeyDown}>
      <SelectTrigger as="summary" ref={popover.triggerRef} density="filter" touchMode="responsive" focusTone="task" aria-expanded={controller.open} aria-invalid={controller.invalid || controller.error !== null || undefined} pending={controller.open && page === null && catalog.error === null} count={count} onClick={event => { event.preventDefault(); controller.setOpen(!controller.open); }}>{title}</SelectTrigger>
      <div ref={popover.panelRef} className="tag-filter-panel">
        <div className="tag-filter-head"><strong>{title}</strong><button className="tag-filter-text" type="button" disabled={count === 0} onClick={clear}>{m.clear}</button></div>
        <div className="tag-filter-search">
          <input ref={popover.searchRef} type="search" aria-label={`${title}: ${m.search}`} placeholder={`${m.search}…`} value={controller.query} onChange={event => controller.setQuery(event.target.value)} />
          {controller.query && <button className="tag-filter-search-clear" type="button" aria-label={m.clearQuery} onClick={() => { controller.setQuery(''); popover.searchRef.current?.focus(); }}>×</button>}
        </div>
        {catalog.error !== null && <p className="tag-filter-feedback" role="alert">{m.error} <button className="tag-filter-text" type="button" onClick={catalog.refresh}>{m.retry}</button></p>}
        {page !== null ? page.items.length === 0 ? <div className="tag-filter-message"><p>{controller.query ? m.noMatches : m.empty}</p>{controller.query && <button className="tag-filter-text" type="button" onClick={() => { controller.setQuery(''); popover.searchRef.current?.focus(); }}>{m.clearQuery}</button>}</div> : <div className="tag-filter-options">{page.items.map(tag => <label key={tag.id}><input type="checkbox" checked={value.tagIds.includes(tag.id)} onChange={event => toggle(tag, event.target.checked)} /><TagColorChip name={tag.name} item={colors.items.get(tag.id)} /></label>)}</div> : catalog.error === null && <div className="tag-filter-message">{m.loading}</div>}
        {(page?.nextCursor || catalog.cursor !== null && page !== null) && <div className="tag-filter-pages">{catalog.cursor !== null && <button className="tag-filter-text" type="button" onClick={catalog.first}>{m.first}</button>}{page?.nextCursor && <button className="tag-filter-text" type="button" onClick={catalog.next}>{m.next}</button>}</div>}
        <label className="tag-filter-untagged"><input type="checkbox" checked={value.untagged} onChange={event => update({ ...value, untagged: event.target.checked, tagIds: event.target.checked ? [] : value.tagIds })} />{m.untagged}</label>
        <fieldset className="tag-filter-match" disabled={matchDisabled} aria-describedby={matchDisabled ? `${matchId}-reason` : undefined}>
          <legend>{m.match}</legend><div className="tag-filter-radios">{(['all', 'any'] as const).map(mode => <label key={mode}><input type="radio" name={matchId} value={mode} checked={value.tagMatch === mode} onChange={() => update({ ...value, tagMatch: mode })} />{m[mode]}</label>)}</div>
        </fieldset>
        {matchDisabled && <p className="tag-filter-reason" id={`${matchId}-reason`}>{value.untagged ? m.untaggedRule : m.oneRule}</p>}
        {!child && onManage !== undefined && <div className="tag-filter-manage"><button className="tag-filter-text" type="button" onClick={onManage}>{m.manage}</button></div>}
      </div>
    </details>
    <TagColorFeedback projectId={controller.projectId} ids={colorIds} onRetry={catalog.refresh} />
    {controller.invalid && <p className="tag-filter-error" role="alert">{m.invalid}</p>}
    {controller.error !== null && <p className="tag-filter-error" role="alert">{m.resolveError} <button type="button" onClick={controller.retry}>{m.retry}</button></p>}
    {(value.tagIds.length > 0 || value.untagged) && <div className="tag-filter-selected">{value.tagIds.map(id => <TagColorChip className="tag-filter-chip" key={id} name={`${names[id] ?? id}${invalidIds.includes(id) && colors.items.get(id)?.state !== 'missing' ? ` · ${m.removed}` : ''}`} item={colors.items.get(id)}><button type="button" aria-label={`${m.remove} ${names[id] ?? id}`} onClick={() => update({ ...value, tagIds: value.tagIds.filter(selected => selected !== id) })}>×</button></TagColorChip>)}{value.untagged && <span className="tag-filter-chip">{m.untagged}<button type="button" aria-label={`${m.remove} ${m.untagged}`} onClick={() => update({ ...value, untagged: false })}>×</button></span>}</div>}
  </div>;
};
