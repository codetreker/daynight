import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { listTestSessions, type TestSessionSummary } from '../../api/test-sessions';
import { navigate } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useTestSessionListMessages } from './test-session-list-messages';
import './test-session-list.css';

type ListState = { readonly scope: TaskCacheScope; readonly items: readonly TestSessionSummary[]; readonly cursor: string | null; readonly status: 'loading' | 'ready' | 'error'; readonly loadingMore: boolean; readonly error: unknown; readonly failedCursor: string | null };
const initialState = (scope: TaskCacheScope): ListState => ({ scope, items: [], cursor: null, status: 'loading', loadingMore: false, error: null, failedCursor: null });
export const followSessionLink = (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); navigate(event.currentTarget.pathname);
};
export function TestSessionListPage() {
  const scope = useTaskCacheScope(), m = useTestSessionListMessages(), { format } = useI18n();
  const [state, setState] = useState(() => initialState(scope));
  const request = useRef<AbortController | null>(null);
  const current = state.scope === scope && !scope.isInvalidated ? state : initialState(scope);
  const load = useCallback(async (cursor: string | null) => {
    if (scope.isInvalidated) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setState(old => cursor === null ? initialState(scope) : { ...old, loadingMore: true, error: null });
    try {
      await scope.ready(controller.signal);
      const page = await listTestSessions(scope.userId, cursor, controller.signal, scope.principalMismatch);
      await scope.ready(controller.signal);
      if (controller.signal.aborted || scope.isInvalidated) return;
      setState(old => {
        const items = cursor === null ? page.items : [...new Map([...old.items, ...page.items].map(item => [item.sessionId, item])).values()];
        return { scope, items, cursor: page.nextCursor, status: 'ready', loadingMore: false, error: null, failedCursor: null };
      });
    } catch (error) {
      if (controller.signal.aborted || scope.isInvalidated || isAbortError(error)) return;
      setState(old => ({ ...old, scope, status: cursor === null ? 'error' : 'ready', loadingMore: false, error, failedCursor: cursor }));
    }
  }, [scope]);
  useEffect(() => {
    const clear = () => { request.current?.abort(); setState(initialState(scope)); };
    scope.signal.addEventListener('abort', clear, { once: true });
    void load(null);
    return () => { request.current?.abort(); scope.signal.removeEventListener('abort', clear); };
  }, [scope, load]);
  return <section className="test-session-list" aria-labelledby="test-session-list-title">
    <div className="page-heading"><div><h1 id="test-session-list-title">{m.title}</h1><p className="subtitle">{m.subtitle}</p></div><button className="button" onClick={() => void load(null)} disabled={current.status === 'loading' || current.loadingMore}>{m.refresh}</button></div>
    {current.status === 'loading' ? <p role="status">{m.loading}</p> : null}
    {current.error !== null ? <div className="notice error" role="alert"><p>{m.error}</p>{current.error instanceof ApiError && current.error.requestId ? <code>{current.error.requestId}</code> : null}<button className="button" onClick={() => void load(current.failedCursor)}>{m.retry}</button></div> : null}
    {current.status === 'ready' && current.items.length === 0 ? <div className="state-box"><h2>{m.empty}</h2><p>{m.create}</p><code>daynight controller codex</code></div> : null}
    {current.items.length > 0 ? <ul className="test-session-list-rows">{current.items.map(item => <li key={item.sessionId}><a className="test-session-list-link" href={`/test-sessions/${item.sessionId}`} onClick={followSessionLink} aria-label={`${m.open}: ${item.provider} ${item.sessionId}`}>
      <div className="test-session-list-identity"><strong>{item.provider === 'claude' ? 'Claude' : item.provider === 'codex' ? 'Codex' : 'Copilot'}</strong><code title={item.sessionId}>{item.sessionId.slice(0, 8)}</code></div>
      <div className="test-session-list-status"><span>{m[item.lifecycle]}</span><span className={`test-session-connection ${item.connectionState}`}>{m[item.connectionState]}</span></div>
      <div className="test-session-list-dates"><span>{m.updated} <time dateTime={item.updatedAt}>{format.dateTime(item.updatedAt)}</time></span><small>{m.created} <time dateTime={item.createdAt}>{format.dateTime(item.createdAt)}</time></small></div><span className="test-session-list-arrow" aria-hidden="true">›</span>
    </a></li>)}</ul> : null}
    {current.status === 'ready' && current.cursor !== null ? <button className="button test-session-list-more" disabled={current.loadingMore} onClick={() => void load(current.cursor)}>{current.loadingMore ? m.loading : m.more}</button> : null}
    {current.status === 'ready' && current.items.length > 0 && current.cursor === null ? <p className="test-session-list-end">{m.end}</p> : null}
  </section>;
}
