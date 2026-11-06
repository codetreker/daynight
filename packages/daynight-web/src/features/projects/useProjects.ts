import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError, listProjects } from '../../api/client';
import type { Project } from '../../api/types';
import type { TaskCacheScope } from '../task-cache/project-cache';
import { TaskCacheError } from '../task-cache/database';

export type ProjectScope = { readonly kind: 'all' } | { readonly kind: 'team'; readonly teamId: string } | { readonly kind: 'shared' };

type ProjectsState = {
  scopeKey: string;
  items: readonly Project[];
  nextCursor: string | null;
  status: 'loading' | 'ready' | 'error';
  error: unknown;
  loadingMore: boolean;
  moreError: unknown;
};

const initialState = (scopeKey: string): ProjectsState => ({
  scopeKey,
  items: [],
  nextCursor: null,
  status: 'loading',
  error: null,
  loadingMore: false,
  moreError: null,
});

export const useProjects = (scope: ProjectScope = { kind: 'all' }, admission?: TaskCacheScope, admissionBlocked = false) => {
  const scopeKey = scope.kind === 'team' ? `team:${scope.teamId}` : scope.kind;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const blockedRef = useRef(admissionBlocked);
  blockedRef.current = admissionBlocked;
  const [state, setState] = useState<ProjectsState>(() => initialState(scopeKey));
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const activeSnapshot = useRef<ReadonlyMap<string, string> | null>(null);
  const activeRestoration = useRef(false);
  const itemGenerations = useRef(new Map<string, ReadonlyMap<string, string>>());
  const loadedPages = useRef(0);
  const restorePending = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const request = useCallback(async (cursor: string | null, append: boolean, preserve = false): Promise<void> => {
    if (blockedRef.current || admission?.isInvalidated) return;
    active.current?.abort();
    const controller = new AbortController();
    const signal = admission === undefined ? controller.signal : AbortSignal.any([controller.signal, admission.signal]);
    active.current = controller;
    activeSnapshot.current = null;
    activeRestoration.current = preserve;
    const currentGeneration = ++generation.current;
    let preparationError: TaskCacheError | null = null;
    setState((previous) => append && previous.scopeKey === scopeKey
      ? { ...previous, loadingMore: true, moreError: null }
      : preserve && previous.scopeKey === scopeKey && previous.status === 'ready' ? previous
      : initialState(scopeKey));

    try {
      const snapshot = admission === undefined ? new Map<string, string>() : await admission.prepareProjection(signal);
      if (signal.aborted || admission?.isInvalidated || currentGeneration !== generation.current || scopeRef.current !== scopeKey) return;
      activeSnapshot.current = snapshot;
      preparationError = admission?.projectionSnapshotError(snapshot) ?? null;
      if (admission?.projectionSnapshotHasDenials(snapshot)) {
        setState((previous) => previous.scopeKey !== scopeKey ? previous : {
          ...previous,
          items: previous.items.filter((item) => !admission.projectionSnapshotDenied(snapshot, item.id)),
          status: previous.status === 'loading' && preparationError !== null ? 'error' : previous.status,
          error: preparationError ?? previous.error,
        });
      }
      if (blockedRef.current) { if (preserve) restorePending.current = true; return; }
      const pages: Project[] = [];
      let nextCursor = cursor, pageCount = 0;
      const limit = preserve ? Math.max(1, loadedPages.current) : 1;
      const cursors = new Set<string>();
      do {
        if (admission !== undefined) await admission.ready(signal);
        if (signal.aborted || currentGeneration !== generation.current || scopeRef.current !== scopeKey) return;
        if (blockedRef.current) { if (preserve) restorePending.current = true; return; }
        if (preserve && nextCursor !== null) {
          if (cursors.has(nextCursor)) throw new ApiError('protocol');
          cursors.add(nextCursor);
        }
        const page = await listProjects({
          limit: 50,
          ...(nextCursor === null ? {} : { cursor: nextCursor }),
          ...(scopeKey === 'shared' ? { shared: true as const } : scopeKey.startsWith('team:') ? { teamId: scopeKey.slice(5) } : {}),
        }, signal, admission === undefined ? undefined : { userId: admission.userId, onPrincipalMismatch: admission.principalMismatch });
        if (preserve && page.nextCursor !== null && cursors.has(page.nextCursor)) throw new ApiError('protocol');
        pages.push(...page.items); nextCursor = page.nextCursor; pageCount++;
      } while (preserve && pageCount < limit && nextCursor !== null);
      if (admission !== undefined) await admission.ready(signal);
      if (signal.aborted || currentGeneration !== generation.current || scopeRef.current !== scopeKey) return;
      if (blockedRef.current) { if (preserve) restorePending.current = true; return; }
      if (!append && !preserve) itemGenerations.current.clear();
      const visible = pages.filter((project) => admission?.projectionSnapshotDenied(snapshot, project.id) !== true);
      for (const project of visible) if (!append || !itemGenerations.current.has(project.id)) itemGenerations.current.set(project.id, snapshot);
      loadedPages.current = append ? loadedPages.current + pageCount : pageCount;
      setState((previous) => {
        if (blockedRef.current || admission?.isInvalidated || scopeRef.current !== scopeKey || previous.scopeKey !== scopeKey) return previous;
        const projects = new Map<string, Project>();
        const retained = append || preserve ? previous.items.filter((item) => admission?.projectionSnapshotDenied(snapshot, item.id) !== true) : [];
        for (const project of preserve ? [...visible, ...retained] : [...retained, ...visible]) {
          if (!projects.has(project.id)) projects.set(project.id, project);
        }
        return {
          scopeKey,
          items: [...projects.values()],
          nextCursor,
          status: 'ready',
          error: preparationError ?? admission?.projectionSnapshotError(snapshot) ?? (admission?.projectionSnapshotHasDenials(snapshot) ? previous.error : null),
          loadingMore: false,
          moreError: null,
        };
      });
    } catch (error) {
      if (signal.aborted || admission?.isInvalidated || isAbortError(error)) return;
      try { if (admission !== undefined) await admission.ready(signal); } catch { return; }
      if (signal.aborted || blockedRef.current || currentGeneration !== generation.current || scopeRef.current !== scopeKey) return;
      setState((previous) => blockedRef.current || admission?.isInvalidated || previous.scopeKey !== scopeKey || scopeRef.current !== scopeKey ? previous : append
        ? { ...previous, loadingMore: false, moreError: error }
        : preserve && previous.status === 'ready' ? { ...previous, error: preparationError ?? error }
        : { ...initialState(scopeKey), status: 'error', error: preparationError ?? error });
    } finally {
      if (currentGeneration === generation.current) {
        active.current = null; activeSnapshot.current = null; activeRestoration.current = false;
        if (restorePending.current && !blockedRef.current) { restorePending.current = false; void request(null, false, true); }
      }
    }
  }, [scopeKey, admission]);

  useEffect(() => {
    if (admission === undefined) return;
    return admission.subscribeProjection((event) => {
      if (event.accessRestored) {
        if (itemGenerations.current.has(event.projectId) || stateRef.current.status === 'loading') {
          if (active.current === null) void request(null, false, true);
          else restorePending.current = true;
        }
        return;
      }
      if (!event.accessRevoked) return;
      const observed = itemGenerations.current.get(event.projectId);
      const remove = observed !== undefined && admission.projectionEventMatches(observed, event);
      const cancel = !(event.error instanceof TaskCacheError) && active.current !== null && admission.projectionEventMatches(activeSnapshot.current, event);
      const resumeRestoration = cancel && activeRestoration.current;
      if (cancel) { ++generation.current; active.current?.abort(); active.current = null; activeSnapshot.current = null; activeRestoration.current = false; }
      if (remove || cancel || event.error instanceof TaskCacheError && admission.isProjectionDenied(event.projectId)) {
        setState((previous) => ({ ...previous, items: remove ? previous.items.filter((item) => item.id !== event.projectId) : previous.items,
          loadingMore: cancel ? false : previous.loadingMore,
          error: event.error instanceof TaskCacheError ? event.error : previous.error }));
      }
      if (resumeRestoration) {
        if (blockedRef.current) restorePending.current = true;
        else void request(null, false, true);
      }
      else if (cancel && stateRef.current.status === 'loading' && !(event.error instanceof TaskCacheError)) void request(null, false);
    });
  }, [admission, request]);

  useEffect(() => {
    if (!blockedRef.current) void request(null, false);
    return () => {
      ++generation.current;
      active.current?.abort();
      active.current = null;
      activeRestoration.current = false;
      restorePending.current = false;
    };
  }, [request]);

  useEffect(() => {
    if (!admissionBlocked && active.current === null) {
      if (restorePending.current) { restorePending.current = false; void request(null, false, true); }
      else if (state.scopeKey !== scopeKey || state.status === 'loading') void request(null, false);
      else if (state.loadingMore && state.nextCursor !== null) void request(state.nextCursor, true);
    }
  }, [admissionBlocked, request, scopeKey]);

  const refresh = useCallback(() => { void request(null, false); }, [request]);
  const loadMore = useCallback(() => {
    if (state.scopeKey === scopeKey && state.nextCursor !== null && !state.loadingMore) {
      if (active.current !== null) restorePending.current = true;
      void request(state.nextCursor, true);
    }
  }, [request, scopeKey, state.scopeKey, state.nextCursor, state.loadingMore]);

  return { ...(state.scopeKey === scopeKey ? state : initialState(scopeKey)), refresh, loadMore };
};
