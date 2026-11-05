import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError, listProjects } from '../../api/client';
import type { Project } from '../../api/types';
import type { TaskCacheScope } from '../task-cache/project-cache';

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

  const request = useCallback(async (cursor: string | null, append: boolean) => {
    if (blockedRef.current || admission?.isInvalidated) return;
    active.current?.abort();
    const controller = new AbortController();
    const signal = admission === undefined ? controller.signal : AbortSignal.any([controller.signal, admission.signal]);
    active.current = controller;
    const currentGeneration = ++generation.current;
    setState((previous) => append && previous.scopeKey === scopeKey
      ? { ...previous, loadingMore: true, moreError: null }
      : initialState(scopeKey));

    try {
      if (admission !== undefined) await admission.ready(signal);
      if (signal.aborted || blockedRef.current || currentGeneration !== generation.current || scopeRef.current !== scopeKey) return;
      const page = await listProjects({
        limit: 50,
        ...(cursor === null ? {} : { cursor }),
        ...(scopeKey === 'shared' ? { shared: true as const } : scopeKey.startsWith('team:') ? { teamId: scopeKey.slice(5) } : {}),
      }, signal, admission === undefined ? undefined : { userId: admission.userId, onPrincipalMismatch: admission.principalMismatch });
      if (admission !== undefined) await admission.ready(signal);
      if (signal.aborted || blockedRef.current || currentGeneration !== generation.current || scopeRef.current !== scopeKey) return;
      setState((previous) => {
        if (blockedRef.current || admission?.isInvalidated || scopeRef.current !== scopeKey || previous.scopeKey !== scopeKey) return previous;
        const projects = new Map<string, Project>();
        for (const project of [...(append ? previous.items : []), ...page.items]) {
          if (!projects.has(project.id)) projects.set(project.id, project);
        }
        return {
          scopeKey,
          items: [...projects.values()],
          nextCursor: page.nextCursor,
          status: 'ready',
          error: null,
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
        : { ...initialState(scopeKey), status: 'error', error });
    } finally {
      if (currentGeneration === generation.current) active.current = null;
    }
  }, [scopeKey, admission]);

  useEffect(() => {
    if (!blockedRef.current) void request(null, false);
    return () => {
      ++generation.current;
      active.current?.abort();
      active.current = null;
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
