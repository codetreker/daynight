import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionArchive } from '../../../../daynight/src/session/archive';
import type { SessionV2Archive } from '../../../../daynight/src/session/v2/types';
import { ApiError } from '../../api/client';
import { createTerminalSessionApi, parseSessionHistory, type SessionHistoryItem, type TerminalSessionApi } from '../../api/terminal-sessions';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskAgentSession } from './TaskAgentSession';
import { TerminalSessionView } from './TerminalSessionView';
import { TerminalRecordingView } from './TerminalRecordingView';
import { SessionTimeline } from './SessionTimeline';
import { emptySessionState } from './state';
import { useTerminalHostMessages } from './terminal-host-messages';
import { useSessionMessages } from './messages';
import { useSessionFullscreen } from './useSessionFullscreen';
import './terminal-session.css';
import './terminal-host.css';

import type { AttachmentRecordSlots } from '../task-detail/attachments/TaskAttachments';

type ScopeProps = { readonly projectId: string; readonly taskId: string; readonly active: boolean };
function useRecords(projectId: string, taskId: string, active: boolean) {
  const scope = useTaskCacheScope();
  const api = useMemo(() => createTerminalSessionApi(projectId, taskId, scope.userId, scope.principalMismatch), [projectId, taskId, scope]);
  const [page, setPage] = useState<{ items: SessionHistoryItem[]; cursor: string | null }>({ items: [], cursor: null });
  const [error, setError] = useState<unknown>(null); const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0); const [cursor, setCursor] = useState<string | null>(null);
  const loadedRequest = useRef<{ api: TerminalSessionApi; cursor: string | null; revision: number } | null>(null);
  useEffect(() => {
    if (!active || scope.isInvalidated) return;
    // Reopening a retained tab preserves its inventory until an explicit refresh.
    if (loadedRequest.current?.api === api && loadedRequest.current.cursor === cursor && loadedRequest.current.revision === revision) return;
    const controller = new AbortController(); const abort = () => controller.abort(); scope.signal.addEventListener('abort', abort);
    setLoading(true); setError(null);
    void api.history(cursor, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      loadedRequest.current = { api, cursor, revision };
      setPage(old => ({ items: cursor === null ? result.items : [...old.items, ...result.items.filter(item => !old.items.some(previous => previous.sessionId === item.sessionId))], cursor: result.nextCursor }));
    }).catch(cause => { if (!controller.signal.aborted) { setError(cause); if (cause instanceof ApiError && [401, 403, 404, 410].includes(cause.status ?? 0)) setPage({ items: [], cursor: null }); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); scope.signal.removeEventListener('abort', abort); };
  }, [api, scope, active, cursor, revision]);
  return { api, scope, ...page, error, loading, refresh: () => { setCursor(null); setRevision(value => value + 1); }, more: () => setCursor(page.cursor) };
}
function recordLabel(item: SessionHistoryItem): string {
  return `${item.createdAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')} · ${item.agentControlMode === 'herdr' ? 'Herdr' : 'Web'}`;
}
export function TaskSessionHost({ projectId, taskId, claimId, mode, active, current }: ScopeProps & {
  readonly claimId: string; readonly mode: 'web' | 'herdr'; readonly current: boolean;
}) {
  const m = useTerminalHostMessages(); const history = useRecords(projectId, taskId, active && current);
  // Retain the selected immutable reference even when a refresh discovers a new claim.
  const selectionKey = `daynight:recording:${history.scope.userId}:${projectId}:${taskId}`;
  const [selected, setSelected] = useState<SessionHistoryItem | null>(() => {
    try { const raw = sessionStorage.getItem(selectionKey); return raw === null ? null : parseSessionHistory({ items: [JSON.parse(raw)], nextCursor: null }).items[0] ?? null; } catch { return null; }
  });
  const select = (item: SessionHistoryItem | null) => {
    setSelected(item); try { if (item === null) sessionStorage.removeItem(selectionKey); else sessionStorage.setItem(selectionKey, JSON.stringify(item)); } catch { /* Reading remains available without browser storage. */ }
  };
  return <div className="task-session-host">
    <div className="terminal-host-toolbar"><label>{m.record}<select aria-label={m.record} value={selected?.sessionId ?? ''} onChange={event => select(history.items.find(item => item.sessionId === event.target.value) ?? null)}>
      <option value="">{m.current}</option>{selected && !history.items.some(item => item.sessionId === selected.sessionId) ? <option value={selected.sessionId}>{recordLabel(selected)}</option> : null}
      {history.items.map(item => <option value={item.sessionId} key={item.sessionId}>{recordLabel(item)}</option>)}
    </select></label><button className="button" disabled={history.loading || !current} onClick={history.refresh}>{m.refresh}</button>
    {history.cursor ? <button className="button" disabled={history.loading} onClick={history.more}>{m.more}</button> : null}</div>
    {history.error ? <p className="session-error" role="alert">{recordingError(history.error, m)}</p> : null}
    <div className="task-session-current" hidden={selected !== null} inert={selected !== null}>
      {mode === 'web' ? <TaskAgentSession key={claimId} projectId={projectId} taskId={taskId} claimId={claimId} active={active && selected === null} current={current} /> : <TerminalSessionView key={claimId} projectId={projectId} api={history.api} claimId={claimId} active={active && selected === null} current={current} />}
    </div>
    {selected ? <FixedSessionRecording key={`${selected.sessionId}/${selected.archive.sha256}`} api={history.api} item={selected} active={active && current} /> : null}
  </div>;
}
export function ManagedSessionRecords({ projectId, taskId, active, resetSelection, children }: ScopeProps & { readonly resetSelection?: object; readonly children: (records: AttachmentRecordSlots) => ReactNode }) {
  const m = useTerminalHostMessages(); const history = useRecords(projectId, taskId, active);
  const [selected, setSelected] = useState<SessionHistoryItem | null>(null);
  useLayoutEffect(() => { setSelected(null); }, [resetSelection]);
  const clearSelection = () => setSelected(null);
  const sidebar = <section className="managed-session-records" aria-label={m.records}>
    <div className="terminal-host-toolbar"><h4>{m.records}</h4><button className="button" disabled={history.loading} onClick={history.refresh}>{m.refresh}</button></div>
    {history.error ? <p role="alert" className="session-error">{recordingError(history.error, m)}</p> : null}
    {history.loading ? <p role="status">{m.loading}</p> : history.items.length === 0 && !history.error ? <p>{m.empty}</p> : null}
    <ul className="managed-session-list">{history.items.map(item => <li key={item.sessionId}><button className="button" aria-pressed={selected?.sessionId === item.sessionId} onClick={() => setSelected(item)}>{recordLabel(item)} · {m[item.archive.state === 'ready' ? 'readonly' : item.archive.state]}</button></li>)}</ul>
    {history.cursor ? <button className="button" disabled={history.loading} onClick={history.more}>{m.more}</button> : null}
  </section>;
  const preview = selected ? <><div className="managed-recording-close"><button className="button" onClick={clearSelection}>{m.close}</button></div><FixedSessionRecording key={`${selected.sessionId}/${selected.archive.sha256}`} api={history.api} item={selected} active={active} /></> : null;
  return children({ sidebar, preview, clearSelection });
}
export function FixedSessionRecording({ api, item, active }: { readonly api: TerminalSessionApi; readonly item: SessionHistoryItem; readonly active: boolean }) {
  const scope = useTaskCacheScope(); const m = useTerminalHostMessages(); const sm = useSessionMessages();
  const [revision, refresh] = useState(0);
  const [loaded, setLoaded] = useState<{ terminal?: SessionV2Archive; native?: SessionArchive; status: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const identity = useRef({});
  const fullscreen = useSessionFullscreen({ client: identity.current, userId: scope.userId, identity: item.sessionId, active });
  useEffect(() => {
    if (!active || scope.isInvalidated) return;
    const controller = new AbortController(); const abort = () => { controller.abort(); setLoaded(null); }; scope.signal.addEventListener('abort', abort);
    setLoaded(null); setError(null);
    void (async () => {
      if (item.agentControlMode === 'herdr') {
        const result = await api.archive(item, controller.signal); if (controller.signal.aborted) return;
        setLoaded({ status: result.status.payload.state, ...(result.archive ? { terminal: result.archive } : {}) });
      } else {
        const result = await api.nativeArchive(item, controller.signal); if (controller.signal.aborted) return;
        setLoaded({ status: result.status.state, ...(result.archive ? { native: result.archive } : {}) });
      }
    })().catch(cause => { if (!controller.signal.aborted) setError(cause); });
    return () => { controller.abort(); scope.signal.removeEventListener('abort', abort); };
  }, [api, item, active, revision, scope]);
  return <section ref={fullscreen.sectionRef} className={`task-agent-session terminal-session${fullscreen.fullscreen ? ' session-fullscreen' : ''}`} onKeyDown={fullscreen.onKeyDown}>
    <div className="terminal-host-toolbar"><strong>{m.readonly}</strong><button className="button" onClick={() => refresh(value => value + 1)}>{m.refresh}</button><button ref={fullscreen.buttonRef} className="button" aria-pressed={fullscreen.fullscreen} onClick={fullscreen.toggle}>{fullscreen.fullscreen ? sm.exitFullscreen : sm.enterFullscreen}</button></div>
    {error ? <p role="alert" className="session-error">{recordingError(error, m)}</p> : !loaded ? <p role="status">{m.loading}</p> : loaded.terminal ? <TerminalRecordingView archive={loaded.terminal} active={active} /> : loaded.native ? <NativeRecording archive={loaded.native} active={active} /> : <p role="status">{m[loaded.status === 'pending' ? 'pending' : loaded.status === 'failed' ? 'failed' : 'unavailable']}</p>}
  </section>;
}
function NativeRecording({ archive, active }: { readonly archive: SessionArchive; readonly active: boolean }) {
  const state = useMemo(() => ({ ...emptySessionState(), entries: archive.entries, resources: new Map(archive.resources.map(item => [item.resource.resourceId, item.resource])) }), [archive]);
  return <SessionTimeline state={state} active={active} canRespond={false} onRespond={async () => {}} hasOlder={false} loadingOlder={false} onLoadOlder={async () => {}} historyReady historyComplete onLoadResource={async (id, signal) => {
    signal.throwIfAborted(); const item = archive.resources.find(value => value.resource.resourceId === id);
    if (!item || item.data === null) throw new Error('Archived resource unavailable.');
    return new Blob([Uint8Array.from(atob(item.data), char => char.charCodeAt(0))], { type: item.resource.mediaType ?? 'application/octet-stream' });
  }} />;
}

function recordingError(error: unknown, m: ReturnType<typeof useTerminalHostMessages>): string {
  if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status ?? 0)) return m.permission;
  if (error instanceof ApiError && ['unsupported_protocol', 'unsupported_content_kind'].includes(error.code)) return m.unsupported;
  return m.error;
}
