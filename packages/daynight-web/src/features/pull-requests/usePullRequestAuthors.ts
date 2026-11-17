import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { comparePullRequestAuthors, getPullRequestAuthors, type PullRequestAuthor, type PullRequestAuthorsPage } from './api';
import type { ReadSession } from './read-session';

export type AuthorAnchors = { readonly focusedId: string | null; readonly visibleId: string | null };
type Snapshot = {
  readonly items: readonly PullRequestAuthor[]; readonly query: string; readonly revision: string | null;
  readonly nextCursor: string | null; readonly loading: boolean; readonly rebuilding: boolean;
  readonly error: ApiError | null; readonly loaded: boolean;
};
const empty = (): Snapshot => ({ items: [], query: '', revision: null, nextCursor: null, loading: false, rebuilding: false, error: null, loaded: false });
const protocol = () => new ApiError('protocol');

/** An independent, bounded directory; it never replaces the selected author identity. */
export const usePullRequestAuthors = (options: { readonly userId: string; readonly projectId: string; readonly active: boolean; readonly scope: ReadSession }) => {
  const { userId, projectId, scope, active } = options;
  const state = useMemo(() => ({ snapshot: empty(), open: false, generation: 0, pending: null as AbortController | null,
    timer: undefined as ReturnType<typeof setTimeout> | undefined, acceptedRevision: null as string | null }), [userId, projectId, scope]);
  const [, render] = useState(0);
  const current = useRef(options); current.current = options;
  const publish = useCallback((snapshot: Snapshot) => { state.snapshot = snapshot; render(value => value + 1); }, [state]);
  const cancel = useCallback(() => {
    state.generation += 1; state.pending?.abort(); state.pending = null;
    if (state.timer !== undefined) clearTimeout(state.timer); state.timer = undefined;
  }, [state]);
  const permitted = useCallback(() => state.open && current.current.active && document.visibilityState !== 'hidden' && scope.isAllowed(), [scope, state]);

  const run = useCallback((mode: 'first' | 'more' | 'rebuild', anchors?: AuthorAnchors) => {
    if (!permitted() || state.pending !== null) return;
    const initial = state.snapshot;
    if (mode === 'more' && (initial.nextCursor === null || initial.rebuilding)) return;
    const controller = new AbortController(), generation = ++state.generation, token = scope.capture();
    state.pending = controller;
    const admitted = () => permitted() && !controller.signal.aborted && state.generation === generation && scope.current(token) && scope.isDirectoryAllowed();
    publish({ ...initial, loading: true, rebuilding: mode === 'rebuild', error: scope.isDirectoryAllowed() ? null : initial.error });
    let totalTimeout: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    if (mode === 'rebuild') totalTimeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
    const read = async (cursor: string | null): Promise<PullRequestAuthorsPage> => scope.request(controller.signal,
      (signal, onDispatch) => getPullRequestAuthors(projectId, { q: initial.query, cursor }, signal, { userId, onPrincipalMismatch: () => {}, onDispatch }));
    const validPage = (page: PullRequestAuthorsPage, previous: readonly PullRequestAuthor[], revision: string | null) => {
      if (revision !== null && page.revision !== revision) throw new ApiError('server', 409, 'resource_conflict');
      if (state.acceptedRevision !== null && BigInt(page.revision) < BigInt(state.acceptedRevision)) throw protocol();
      const seen = new Set(previous.map(author => author.id));
      for (const author of page.items) if (seen.has(author.id)) throw protocol(); else seen.add(author.id);
      if (previous.length > 0 && page.items.length > 0 && comparePullRequestAuthors(previous[previous.length - 1]!, page.items[0]!) >= 0) throw protocol();
    };
    const execute = async () => {
      try {
        if (!scope.isDirectoryAllowed()) {
          const verified = await scope.verifyBaseline(controller.signal);
          if (!verified || !admitted()) {
            if (state.generation === generation && permitted() && !controller.signal.aborted) publish({ ...state.snapshot, loading: false, rebuilding: false, error: state.snapshot.error ?? new ApiError('network') });
            return;
          }
        }
        let page: PullRequestAuthorsPage;
        let items: readonly PullRequestAuthor[];
        if (mode === 'rebuild') {
          items = []; let cursor: string | null = null, revision: string | null = null;
          const visited = new Set<string>();
          for (;;) {
            page = await read(cursor);
            if (!await scope.accept(token, controller.signal) || !admitted()) return;
            validPage(page, items, revision); revision = page.revision;
            items = [...items, ...page.items];
            const found = (id: string | null | undefined) => id == null || items.some(author => author.id === id);
            if (page.nextCursor === null || items.length >= initial.items.length && found(anchors?.focusedId) && found(anchors?.visibleId)) break;
            if (visited.has(page.nextCursor) || page.nextCursor === cursor) throw protocol();
            visited.add(page.nextCursor); cursor = page.nextCursor;
          }
        } else {
          page = await read(mode === 'more' ? initial.nextCursor : null);
          if (!await scope.accept(token, controller.signal) || !admitted()) return;
          const previous = mode === 'more' ? initial.items : [];
          validPage(page, previous, mode === 'more' ? initial.revision : null);
          if (mode === 'more' && page.nextCursor !== null && page.nextCursor === initial.nextCursor) throw protocol();
          items = [...previous, ...page.items];
        }
        if (!admitted()) return;
        state.acceptedRevision = page.revision;
        publish({ ...state.snapshot, items, revision: page.revision, nextCursor: page.nextCursor, loaded: true, error: null, loading: false, rebuilding: false });
      } catch (cause: unknown) {
        if (state.generation !== generation || !permitted() || controller.signal.aborted && !timedOut) return;
        const error = timedOut ? new ApiError('network') : cause instanceof ApiError ? cause : isAbortError(cause) ? new ApiError('network') : new ApiError('protocol', null, 'protocol', null, cause);
        if (!timedOut && !await scope.accept(token, controller.signal)) return;
        if (state.generation !== generation || !permitted()) return;
        if (error.code === 'principal_mismatch' || error.status === 401 || error.status === 403) { scope.revoke(error); return; }
        if (error.status === 404) {
          publish({ ...state.snapshot, loading: true, rebuilding: false, error });
          try { await scope.verifyBaseline(controller.signal); } catch { /* An inconclusive baseline leaves the directory unavailable. */ }
          if (state.generation === generation && permitted() && !controller.signal.aborted) publish({ ...state.snapshot, loading: false });
          return;
        }
        publish({ ...state.snapshot, loading: false, rebuilding: false, error });
      } finally {
        if (totalTimeout !== undefined) clearTimeout(totalTimeout);
        if (state.pending === controller) state.pending = null;
      }
    };
    void execute();
  }, [permitted, projectId, publish, scope, state, userId]);

  const open = useCallback(() => {
    cancel(); state.open = true; publish(empty()); run('first');
  }, [cancel, publish, run, state]);
  const close = useCallback(() => { cancel(); state.open = false; publish({ ...state.snapshot, loading: false, rebuilding: false }); }, [cancel, publish, state]);
  const setQuery = useCallback((query: string, composing = false) => {
    cancel(); publish({ ...empty(), query });
    if (!composing) state.timer = setTimeout(() => { state.timer = undefined; run('first'); }, 250);
  }, [cancel, publish, run, state]);
  const loadMore = useCallback(() => run('more'), [run]);
  const retry = useCallback((anchors: AuthorAnchors) => {
    if (state.snapshot.error?.status === 409 && state.snapshot.error.code === 'resource_conflict' && state.snapshot.items.length > 0) run('rebuild', anchors);
    else run(state.snapshot.items.length > 0 && state.snapshot.nextCursor !== null ? 'more' : 'first');
  }, [run, state]);

  useLayoutEffect(() => scope.subscribe(() => { cancel(); state.acceptedRevision = null; publish(empty()); }), [cancel, publish, scope, state]);
  useEffect(() => {
    const visibility = () => {
      if (!permitted()) { cancel(); publish({ ...state.snapshot, loading: false, rebuilding: false }); }
      else if (state.open && !state.snapshot.loaded && state.snapshot.error === null) run('first');
    };
    visibility(); document.addEventListener('visibilitychange', visibility);
    return () => { document.removeEventListener('visibilitychange', visibility); cancel(); };
  }, [active, cancel, permitted, publish, run, state]);

  return { ...state.snapshot, open, close, setQuery, loadMore, retry };
};
