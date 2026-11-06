import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError, listProjects } from '../../api/client';
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
  const itemGenerations = useRef(new Map<string, ReadonlyMap<string, string>>());
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
    const currentGeneration = ++generation.current;
    setState((previous) => append && previous.scopeKey === scopeKey
      ? { ...previous, loadingMore: true, moreError: null }
      : preserve && previous.scopeKey === scopeKey && previous.status === 'ready' ? previous
      : initialState(scopeKey));

    try {
      const snapshot = admission === undefined ? new Map<string, string>() : await admission.prepareProjection(signal);
      if (signal.aborted || blockedRef.current || currentGeneration !== generation.current || scopeRef.current !== scopeKey) return;
      activeSnapshot.current = snapshot;
      const page = await listProjects({
        limit: 50,
        ...(cursor === null ? {} : { cursor }),
        ...(scopeKey === 'shared' ? { shared: true as const } : scopeKey.startsWith('team:') ? { teamId: scopeKey.slice(5) } : {}),
      }, signal, admission === undefined ? undefined : { userId: admission.userId, onPrincipalMismatch: admission.principalMismatch });
      if (admission !== undefined) await admission.ready(signal);
      if (signal.aborted || blockedRef.current || currentGeneration !== generation.current || scopeRef.current !== scopeKey) return;
      if (!append && !preserve) itemGenerations.current.clear();
      const visible = page.items.filter((project) => admission?.projectionSnapshotDenied(snapshot, project.id) !== true);
      for (const project of visible) if (!append || !itemGenerations.current.has(project.id)) itemGenerations.current.set(project.id, snapshot);
      setState((previous) => {
        if (blockedRef.current || admission?.isInvalidated || scopeRef.current !== scopeKey || previous.scopeKey !== scopeKey) return previous;
        const projects = new Map<string, Project>();
        for (const project of [...(append || preserve ? previous.items.filter((item) => admission?.projectionSnapshotDenied(snapshot, item.id) !== true) : []), ...visible]) {
          if (!projects.has(project.id) || preserve) projects.set(project.id, project);
        }
        return {
          scopeKey,
          items: [...projects.values()],
          nextCursor: preserve && previous.status === 'ready' ? previous.nextCursor : page.nextCursor,
          status: 'ready',
          error: admission?.projectionSnapshotError(snapshot) ?? (admission?.projectionSnapshotHasDenials(snapshot) ? previous.error : null),
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
        : preserve && previous.status === 'ready' ? { ...previous, error }
        : { ...initialState(scopeKey), status: 'error', error });
    } finally {
      if (currentGeneration === generation.current) {
        active.current = null; activeSnapshot.current = null;
        if (restorePending.current) { restorePending.current = false; void request(null, false, true); }
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
      if (cancel) { ++generation.current; active.current?.abort(); active.current = null; activeSnapshot.current = null; }
      if (remove || cancel || event.error instanceof TaskCacheError && admission.isProjectionDenied(event.projectId)) {
        setState((previous) => ({ ...previous, items: remove ? previous.items.filter((item) => item.id !== event.projectId) : previous.items,
          loadingMore: cancel ? false : previous.loadingMore,
          error: event.error instanceof TaskCacheError ? event.error : previous.error }));
      }
      if (cancel && stateRef.current.status === 'loading' && !(event.error instanceof TaskCacheError)) void request(null, false);
    });
  }, [admission, request]);

  useEffect(() => {
    if (!blockedRef.current) void request(null, false);
    return () => {
      ++generation.current;
      active.current?.abort();
      active.current = null;
      restorePending.current = false;
    };
  }, [request]);

  useEffect(() => {
    if (!admissionBlocked && active.current === null) {
      if (state.scopeKey !== scopeKey || state.status === 'loading') void request(null, false);
      else if (state.loadingMore && state.nextCursor !== null) void request(state.nextCursor, true);
    }
  }, [admissionBlocked, request, scopeKey]);

  const refresh = useCallback(() => { void request(null, false); }, [request]);
  const loadMore = useCallback(() => {
    if (state.scopeKey === scopeKey && state.nextCursor !== null && active.current === null) {
      void request(state.nextCursor, true);
    }
  }, [request, scopeKey, state.scopeKey, state.nextCursor]);

  return { ...(state.scopeKey === scopeKey ? state : initialState(scopeKey)), refresh, loadMore };
};
