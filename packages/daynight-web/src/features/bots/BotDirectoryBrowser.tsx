import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, authRequestsPaused, isAbortError, subscribeAuthPause } from '../../api/client';
import { browseWorkerDirectory, WorkerReadonlyError, type WorkerReadonlyResponse } from '../../api/worker-readonly';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useDirectoryMessages } from './directory-messages';

type DirectoryPage = WorkerReadonlyResponse<'directory.list'>;
type DirectoryQuery = { readonly path: string; readonly showHidden: boolean };
export type BotDirectoryBrowserProps = {
  readonly workerId: string;
  readonly workerName: string;
  readonly initialPath: string;
  readonly defaultPath: string;
  readonly enabled: boolean;
  readonly onCancel: () => void;
  readonly onSelect: (path: string) => void;
};

/** A browse result is only a candidate; the parent binds the Worker on confirmation. */
export function BotDirectoryBrowser({ workerId, workerName, initialPath, defaultPath, enabled, onCancel, onSelect }: BotDirectoryBrowserProps) {
  const scope = useTaskCacheScope(), m = useDirectoryMessages();
  const pathInput = useRef<HTMLInputElement>(null), request = useRef<AbortController | null>(null), generation = useRef(0);
  const [query, setQuery] = useState<DirectoryQuery>({ path: initialPath, showHidden: false });
  const snapshot = useRef<{ scope: typeof scope; workerId: string; query: DirectoryQuery; page: DirectoryPage; count: number; cursors: Set<string> } | null>(null);
  const [draft, setDraft] = useState(initialPath), [filter, setFilter] = useState('');
  const [page, setPage] = useState<DirectoryPage | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null), [paused, setPaused] = useState(authRequestsPaused);
  const permitted = enabled && !paused && !scope.isInvalidated;
  const active = useRef(permitted);
  useLayoutEffect(() => { active.current = permitted; }, [permitted]);
  useLayoutEffect(() => { pathInput.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, scope.signal]);
    const pause = () => {
      setPaused(true); request.current?.abort(); ++generation.current;
      void scope.ready(signal).then(() => { if (!signal.aborted) setPaused(authRequestsPaused()); }).catch(() => undefined);
    };
    const unsubscribe = subscribeAuthPause(pause);
    if (authRequestsPaused()) pause();
    return () => { controller.abort(); unsubscribe(); };
  }, [scope]);
  const load = useCallback(async (target: DirectoryQuery, previous: DirectoryPage | null = null) => {
    if (!active.current || authRequestsPaused() || scope.isInvalidated) return;
    request.current?.abort();
    const controller = new AbortController(), ticket = ++generation.current;
    request.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    const current = () => !signal.aborted && ticket === generation.current && active.current;
    setBusy(true); setError(null);
    const saved = snapshot.current;
    const retained = saved?.scope === scope && saved.workerId === workerId && saved.query === query ? saved : null;
    // Revalidate all displayed pages under one fresh connection snapshot. Until
    // that succeeds, keep the old nodes and scroll position but refuse selection.
    const pagesToRead = previous === null ? retained?.count ?? 1 : 1;
    if (previous === null && retained === null) { setPage(null); snapshot.current = null; }
    let collected = previous, count = previous === null ? 0 : retained?.count ?? 1;
    const seen = new Set(previous === null ? [] : retained?.cursors);
    try {
      await scope.ready(signal);
      if (!current()) return;
      for (let index = 0; index < pagesToRead; index++) {
        const cursor = collected?.result.nextCursor;
        const next = await browseWorkerDirectory(workerId, { path: collected?.result.path ?? target.path, showHidden: target.showHidden, limit: 100, ...(cursor ? { cursor } : {}) }, signal,
          { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch, isCurrent: current },
          collected === null ? undefined : { binding: { connectionId: collected.connectionId, capabilityGeneration: collected.capabilityGeneration } });
        await scope.ready(signal);
        if (!current()) return;
        if (next.result.nextCursor !== null && (next.result.nextCursor === cursor || seen.has(next.result.nextCursor))) throw new ApiError('protocol');
        if (collected !== null) {
          if (next.result.path !== collected.result.path || next.result.parentPath !== collected.result.parentPath
            || next.result.entries.some(entry => collected!.result.entries.some(old => old.name === entry.name || old.path === entry.path))) throw new ApiError('protocol');
          if (collected.result.entries.length + next.result.entries.length > 10_000) throw new WorkerReadonlyError('limit_exceeded', 'Directory entry limit exceeded.');
        }
        if (cursor) seen.add(cursor);
        collected = collected === null ? next : { ...next, result: { ...next.result, entries: [...collected.result.entries, ...next.result.entries] } };
        count++;
        if (collected.result.nextCursor === null) break;
      }
      if (collected === null) return;
      snapshot.current = { scope, workerId, query, page: collected, count, cursors: seen };
      setPage(collected);
      const normalizedPath = collected.result.path;
      setDraft(value => value === target.path ? normalizedPath : value);
    } catch (cause) {
      if (!current() || isAbortError(cause)) return;
      setError(cause);
    } finally { if (current()) setBusy(false); }
  }, [scope, workerId, query]);
  useEffect(() => {
    if (permitted) void load(query);
    else setBusy(false);
    return () => { request.current?.abort(); ++generation.current; };
  }, [load, permitted, query]);
  useEffect(() => {
    setQuery({ path: initialPath, showHidden: false }); setDraft(initialPath); setFilter('');
  }, [initialPath, workerId]);
  const navigate = (path: string, showHidden = query.showHidden) => {
    if (!active.current || authRequestsPaused() || scope.isInvalidated || path.length === 0) return;
    request.current?.abort(); ++generation.current;
    setDraft(path); setFilter(''); setQuery({ path, showHidden });
  };
  const cancel = () => { request.current?.abort(); ++generation.current; onCancel(); };
  const code = error instanceof WorkerReadonlyError || error instanceof ApiError ? error.code : 'generic';
  const errorMessage = Object.hasOwn(m.errors, code) ? m.errors[code as keyof typeof m.errors] : m.errors.generic;
  const entries = page?.result.entries.filter(entry => entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [];
  const canSelect = permitted && !busy && error === null && page !== null && draft === page.result.path;
  // Native disabled controls drop browser focus. Read-only and ARIA-disabled
  // controls retain it during identity checks; handlers enforce the same gate.
  return <div className="bot-directory-browser" onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault(); event.stopPropagation(); cancel();
  }}>
    <header className="bot-create-header"><h2 id="bot-create-title">{m.title}</h2><button className="close-button" type="button" aria-label={m.close} onClick={cancel}>×</button></header>
    <div className="bot-create-body">
      <p className="bot-directory-worker" tabIndex={0}>{workerName}</p>
      <div className="bot-directory-path">
        <button className="button" type="button" aria-label={m.parent} aria-disabled={!permitted || !page?.result.parentPath} onClick={() => { if (page?.result.parentPath) navigate(page.result.parentPath); }}>↑</button>
        <input ref={pathInput} aria-label={m.path} value={draft} readOnly={!permitted} aria-disabled={!permitted} autoComplete="off" spellCheck={false} onChange={event => { if (active.current && !authRequestsPaused() && !scope.isInvalidated) setDraft(event.target.value); }} onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault(); event.stopPropagation(); navigate(draft);
        }} />
        <button className="button" type="button" aria-disabled={!permitted || draft.length === 0} onClick={() => { if (draft.length > 0) navigate(draft); }}>{m.go}</button>
      </div>
      <button className="button bot-directory-default" type="button" aria-disabled={!permitted} onClick={() => navigate(defaultPath)}>{m.defaultDirectory}</button>
      <div className="field"><label htmlFor="bot-directory-filter">{m.filter}</label><input id="bot-directory-filter" type="search" value={filter} readOnly={!permitted} aria-disabled={!permitted} onChange={event => { if (active.current && !authRequestsPaused() && !scope.isInvalidated) setFilter(event.target.value); }} /></div>
      <div className="bot-directory-list" aria-busy={busy}>
        {entries.map(entry => <button className="bot-directory-entry" type="button" key={entry.path} aria-disabled={!permitted || busy} onClick={() => { if (!busy) navigate(entry.path); }}><span aria-hidden="true">▱</span><span>{entry.name}</span><span aria-hidden="true">›</span></button>)}
        {page !== null && !busy && error === null && entries.length === 0 && <p className="bot-directory-empty">{filter ? m.noMatches : m.empty}</p>}
        {page?.result.nextCursor && <button className="button" type="button" aria-disabled={!permitted || busy || error !== null} onClick={() => { if (!busy && error === null) void load({ ...query, path: page.result.path }, page); }}>{m.more}</button>}
      </div>
      <label className="bot-directory-hidden"><input type="checkbox" checked={query.showHidden} aria-disabled={!permitted} onChange={event => navigate(page?.result.path ?? query.path, event.target.checked)} />{m.hidden}</label>
      {page !== null && <p className="bot-directory-current" tabIndex={0}>{page.result.path}</p>}
      {error !== null && <div className="notice error" role="alert"><p>{errorMessage}</p><button className="button" type="button" aria-disabled={!permitted || busy} onClick={() => { if (!busy) void load(query); }}>{m.retry}</button></div>}
    </div>
    <footer className="bot-create-actions"><button className="button" type="button" onClick={cancel}>{m.cancel}</button><button className="button primary" type="button" aria-disabled={!canSelect} onClick={() => { if (canSelect && !authRequestsPaused() && !scope.isInvalidated) onSelect(page!.result.path); }}>{m.select}</button></footer>
  </div>;
}
