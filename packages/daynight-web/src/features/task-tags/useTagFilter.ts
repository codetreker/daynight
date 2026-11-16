import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { resolveProjectTags } from '../../api/task-tags';
import type { TaskTag } from '../../api/types';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useProjectTags } from './useProjectTags';

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
