import { sessionFenceKey } from '../../../../daynight/src/session/protocol';
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { legacySubagentActivity } from './legacy-subagent-activity';
import '../../styles/markdown.css';
import './session-timeline.css';
import { SessionMarkdown } from './SessionMarkdown';
import type { ImagePart, ImageUnavailablePart, MarkdownImageMetadata } from '../../../../daynight/src/session/image-values';
import type { ChatImagePresentation } from '../../ui/ChatMarkdown';
import { timelineNativeLabels, useTimelineMessages } from './timeline-messages';
import type { InteractionResponse, MessagePart, SessionInteraction, TimelineEntry } from '../../api/types';
import { sessionRespondGate, hasPendingResponse, type SessionState } from './state';
import { SessionResourceView } from './SessionResourceView';
import { SessionInteractionCard } from './SessionInteractionCard';
import { SessionError } from './SessionError';
import { useSessionMessages } from './messages';
import { useSessionHistoryPagination } from './useSessionHistoryPagination';
import { usePendingInteractionLocator } from './usePendingInteractionLocator';
import { useTimelineScroll } from '../../ui/useTimelineScroll';
import { selectSessionDisplayEntries, type SessionDisplayMode } from './display-mode';
import { matchingSessionHistoryPreview, selectSessionHistoryRows, type SessionHistoryPreview, type SessionHistoryCoverage } from './history-preview';
import { toolSummary } from './tool-summary';
import type { InvalidImageBindings } from './useInvalidImageBindings';

export type SessionTimelineReadingHandle = Pick<ReturnType<typeof useTimelineScroll>, 'captureBookmark' | 'restoreBookmark' | 'getRestoreStatus'>;

// The caller supplies its authenticated principal and view ownership scope.
// SessionTimeline adds the actual session fence and history epoch.
export type SessionTimelineReading = { readonly scope: string; readonly ref: Ref<SessionTimelineReadingHandle> };

export function SessionTimeline({ state, active, canRespond, actionAdmitted = true, onRespond, hasOlder, loadingOlder, onLoadOlder, onLoadResource, onInvalidImageBindings, historyError = null, suppressEmpty = false, displayMode = 'standard', historyReady = false, historyComplete = false, historyRevision = 0, connectionGeneration = 0, reading, historyPreview, historyLoaded = true, historyCoverage = null, recordIdentity }: {
  readonly onInvalidImageBindings?: InvalidImageBindings;
  readonly recordIdentity?: { readonly scope: string; readonly historyEpoch: string };
  readonly historyPreview?: SessionHistoryPreview; readonly historyLoaded?: boolean; readonly historyCoverage?: SessionHistoryCoverage | null;
  readonly state: SessionState; readonly active: boolean; readonly canRespond: boolean;
  readonly actionAdmitted?: boolean;
  readonly onRespond: (interaction: SessionInteraction, response: InteractionResponse) => Promise<void>;
  readonly hasOlder: boolean; readonly loadingOlder: boolean; readonly onLoadOlder: () => Promise<void>;
  readonly onLoadResource: (resourceId: string, signal: AbortSignal) => Promise<Blob>; readonly historyError?: string | null;
  readonly suppressEmpty?: boolean;
  readonly displayMode?: SessionDisplayMode;
  readonly reading?: SessionTimelineReading;
  /** Confirmed complete history, independent of live pagination admission and errors. */
  readonly historyComplete?: boolean;
  readonly historyReady?: boolean; readonly historyRevision?: number; readonly connectionGeneration?: number;
}) {
  const m = useSessionMessages();
  const preview = matchingSessionHistoryPreview(state, historyPreview);
  const rows = useMemo(() => selectSessionHistoryRows(state, preview, historyLoaded, historyCoverage), [state, preview, historyLoaded, historyCoverage]);
  const renderedEntries = useMemo(() => rows.map(row => row.entry), [rows]);
  const previewIds = useMemo(() => new Set(rows.filter(row => row.preview).map(row => row.entry.entryId)), [rows]);
  const previewResources = useMemo(() => new Map(preview?.resources.map(resource => [resource.resourceId, resource]) ?? []), [preview]);
  const entries = useMemo(() => selectSessionDisplayEntries(renderedEntries, displayMode), [renderedEntries, displayMode]);
  const historyEmpty = state.entries.length === 0 && (!hasOlder || historyComplete);
  const originalKeys = useMemo(() => renderedEntries.map(entry => entry.entryId), [renderedEntries]);
  const visibleKeys = useMemo(() => entries.map(entry => entry.entryId), [entries]);
  const fence = state.snapshot ?? preview?.fence;
  const epoch = state.snapshot?.historyEpoch ?? preview?.historyEpoch ?? recordIdentity?.historyEpoch;
  const identity = reading && fence ? JSON.stringify([reading.scope, sessionFenceKey(fence)]) : recordIdentity?.scope ?? `${fence?.sessionId}/${epoch}`;
  const scroll = useTimelineScroll(identity, active, renderedEntries, undefined, { originalKeys, visibleKeys, mode: displayMode }, epoch && (reading && fence || recordIdentity) ? {
    historyEpoch: epoch,
    historyComplete: historyComplete || historyReady && !hasOlder && !loadingOlder && !historyError,
  } : undefined);
  // The handle identifies this mounted Timeline; proxies retain the latest
  // visibility, history boundary and ownership checks across its renders.
  const disclosures = useRef({ identity, values: new Map<string, boolean>() });
  if (disclosures.current.identity !== identity) disclosures.current = { identity, values: new Map() };
  useEffect(() => {
    const retained = new Set(originalKeys);
    for (const key of disclosures.current.values.keys()) if (!retained.has(key.split('/')[0]!)) disclosures.current.values.delete(key);
  }, [originalKeys]);
  const currentScroll = useRef(scroll); currentScroll.current = scroll;
  const readingHandle = useMemo<SessionTimelineReadingHandle>(() => ({
    captureBookmark: () => currentScroll.current.captureBookmark(),
    restoreBookmark: bookmark => currentScroll.current.restoreBookmark(bookmark),
    getRestoreStatus: () => currentScroll.current.getRestoreStatus(),
  }), []);
  useImperativeHandle(reading?.ref, () => readingHandle, [readingHandle]);
  const restoredPreview = useRef<string | null>(null);
  useEffect(() => {
    if (!preview || !epoch || !active || restoredPreview.current === identity) return;
    restoredPreview.current = identity;
    const anchor = preview.readingAnchor;
    if (!anchor || historyLoaded) return;
    scroll.restoreBookmark({ identity, historyEpoch: epoch, following: anchor.following, anchor: anchor.following ? null : { key: anchor.entryId, top: -anchor.offset } });
  }, [preview, epoch, identity, active, historyLoaded, scroll]);
  const historyIdentity = state.snapshot ? `${sessionFenceKey(state.snapshot)}/${state.snapshot.historyEpoch}/${state.snapshot.connectionEpoch}` : identity;
  const history = useSessionHistoryPagination({ scroll, identity: historyIdentity, mode: displayMode, active, ready: historyReady, generation: connectionGeneration, revision: historyRevision, hasOlder, loading: loadingOlder, error: historyError, load: onLoadOlder });
  const pendingInteractions = useMemo(() => state.snapshot?.activity === 'waiting_input' ? entries.flatMap(entry => !previewIds.has(entry.entryId) && entry.kind === 'interaction' && entry.interaction.state === 'pending' && sessionRespondGate(state, canRespond, entry.interaction) ? [{ entryId: entry.entryId, title: entry.interaction.title }] : []) : [], [entries, state, canRespond, previewIds]);
  const pending = usePendingInteractionLocator(scroll, active, pendingInteractions);
  return <div className="session-timeline-shell">
    <div className="session-timeline" ref={scroll.viewport} tabIndex={0} aria-label={m.title} onScroll={history.onScroll} onWheel={history.onWheel} onTouchStart={history.onTouchStart} onTouchMove={history.onTouchMove} onPointerDown={history.onPointerDown} onKeyDown={history.onKeyDown} onFocus={scroll.onFocus} onClick={(event) => { if (event.target instanceof Element && event.target.closest('a[data-footnote-ref], a[data-footnote-backref]')) scroll.pause(); }}>
      <div ref={scroll.content} className="session-timeline-content">
        {previewIds.size > 0 ? <p className="session-history-preview-label">{m.historyPreview}</p> : null}
        {loadingOlder ? <div className="session-history-loading" role="status" aria-live="polite">{m.loadingOlder}</div> : null}
        {history.error ? <div role="alert" className="session-error session-history-error"><span>{history.error}</span>{hasOlder ? <button type="button" className="inline-link" disabled={!active || !historyReady || loadingOlder} onClick={history.retry}>{m.retryHistory}</button> : null}</div> : null}
        {entries.length === 0 ? (suppressEmpty ? null : <p className="session-empty">{displayMode === 'conversation' && !historyEmpty ? m.conversationEmpty : m.empty}</p>) : entries.map((entry) => <article key={entry.entryId} data-entry-key={entry.entryId} data-history-preview={previewIds.has(entry.entryId) ? 'true' : undefined} className={`session-entry session-entry-${entry.kind}`}><SessionEntry entry={entry} disclosures={disclosures.current.values} resourceAccess={previewIds.has(entry.entryId) ? 'none' : 'live'} operations={entry.kind === 'interaction' && !previewIds.has(entry.entryId) ? state.operations : undefined} resources={previewIds.has(entry.entryId) ? previewResources : state.resources} active={active} canRespond={!previewIds.has(entry.entryId) && entry.kind === 'interaction' && sessionRespondGate(state, canRespond, entry.interaction)} actionAdmitted={actionAdmitted} pendingResponse={entry.kind === 'interaction' && hasPendingResponse(state, entry.interaction)} onRespond={onRespond} onLoadResource={onLoadResource} onInvalidImageBindings={onInvalidImageBindings} /></article>)}
      </div>
    </div>
    {pending.target || scroll.showLatest ? <div className="session-timeline-navigation">
      {pending.target ? <button type="button" className="button session-pending-request" onClick={pending.reveal}><span>{m.pendingRequest} · {pending.target.title}</span><span aria-hidden="true">{pending.target.direction === 'up' ? '↑' : '↓'}</span></button> : null}
      {scroll.showLatest ? <button type="button" className="button session-latest" onClick={history.latest}>{m.latest} ↓</button> : null}
    </div> : null}
  </div>;
}

function LazyDetails({ className, summary, children, disclosures, disclosureKey }: { readonly className: string; readonly summary: ReactNode; readonly children: ReactNode; readonly disclosures?: Map<string, boolean>; readonly disclosureKey?: string }) {
  const [expanded, setExpanded] = useState(disclosureKey ? disclosures?.get(disclosureKey) ?? false : false);
  return <details className={className} open={expanded} onToggle={(event) => { const open = event.currentTarget.open; if (disclosureKey) disclosures?.set(disclosureKey, open); setExpanded(open); }}><summary>{summary}</summary>{expanded ? children : null}</details>;
}
type EntryProps = {
  readonly disclosures: Map<string, boolean>;
  readonly resourceAccess: 'live' | 'none';
  readonly operations: SessionState['operations'] | undefined;
  readonly actionAdmitted: boolean;
  readonly entry: TimelineEntry; readonly resources: SessionState['resources']; readonly active: boolean; readonly canRespond: boolean; readonly pendingResponse: boolean;
  readonly onRespond: (interaction: SessionInteraction, response: InteractionResponse) => Promise<void>;
  readonly onLoadResource: (resourceId: string, signal: AbortSignal) => Promise<Blob>;
  readonly onInvalidImageBindings: InvalidImageBindings | undefined;
};
type PartProps = Pick<EntryProps, 'resources' | 'active' | 'onLoadResource' | 'resourceAccess'> & { readonly entryId: string; readonly onInvalidBindings: () => void };
function partImage(part: ImagePart | ImageUnavailablePart, presentation: ChatImagePresentation, props: PartProps) {
  return <SessionResourceView resource={part.type === 'image' ? props.resources.get(part.resourceId) : undefined} label={part.label} active={props.active} resourceAccess={props.resourceAccess} onLoad={props.onLoadResource} onInvalidResource={props.onInvalidBindings} presentation={presentation} mediaKey={`${props.entryId}/${part.imageId}`} {...(part.type === 'image_unavailable' ? { error: part.error.message } : {})} />;
}
function BoundMarkdown({ text, metadata, ...props }: PartProps & { readonly text: string; readonly metadata: MarkdownImageMetadata }) {
  return <SessionMarkdown text={text} metadata={metadata} resourceAccess={props.resourceAccess} renderImage={(part, presentation) => partImage(part, presentation, props)} onInvalidBindings={props.onInvalidBindings} />;
}
function SessionParts({ content, raw = false, ...props }: PartProps & { readonly content: readonly MessagePart[]; readonly raw?: boolean }) {
  return content.map((part, index) => {
    if (part.type === 'text') return raw ? <pre className="session-tool-output" tabIndex={0} key={index}>{part.text}</pre> : <SessionMarkdown key={index} text={part.text} />;
    if (part.type === 'markdown') { const { type: _type, text, ...metadata } = part; return <BoundMarkdown key={part.partId} text={text} metadata={metadata} {...props} />; }
    if (part.type === 'image' || part.type === 'image_unavailable') return <span key={part.imageId} className="session-image-occurrence">{partImage(part, 'standalone', props)}</span>;
    return <SessionResourceView key={`${index}/${part.resourceId}`} resource={props.resources.get(part.resourceId)} label={part.label} active={props.active} resourceAccess={props.resourceAccess} onLoad={props.onLoadResource} onInvalidResource={props.onInvalidBindings} mediaKey={`${props.entryId}/resource/${index}/${part.resourceId}`} />;
  });
}
const SessionEntry = memo(function SessionEntry({ entry, operations, resources, active, canRespond, actionAdmitted, pendingResponse, onRespond, onLoadResource, onInvalidImageBindings, resourceAccess, disclosures }: EntryProps) {
  const m = useSessionMessages(), labels = useTimelineMessages();
  const invalid = useCallback(() => onInvalidImageBindings?.(entry.entryId, entry.revision), [entry.entryId, entry.revision, onInvalidImageBindings]);
  switch (entry.kind) {
      case 'user_message': case 'assistant_message': return <div className={`session-message ${entry.kind} markdown-content`}><SessionParts entryId={entry.entryId} content={entry.content} resources={resources} active={active} onLoadResource={onLoadResource} resourceAccess={resourceAccess} onInvalidBindings={invalid} /></div>;
      case 'reasoning': return <LazyDetails disclosures={disclosures} disclosureKey={`${entry.entryId}/reasoning`} className="session-reasoning" summary={m.reasoning}>{entry.markdown ? <BoundMarkdown entryId={entry.entryId} text={entry.text} metadata={entry.markdown} resources={resources} active={active} onLoadResource={onLoadResource} resourceAccess={resourceAccess} onInvalidBindings={invalid} /> : <SessionMarkdown text={entry.text} />}</LazyDetails>;
      case 'tool_call': return <LazyDetails disclosures={disclosures} disclosureKey={`${entry.entryId}/${entry.callId}`} className={`session-tool session-tool-${entry.status}`} summary={<><svg className="session-tool-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg><strong className="session-tool-name" title={entry.name} lang={entry.name === 'commandExecution' || entry.name === 'fileChange' ? 'en' : undefined}>{entry.name === 'commandExecution' ? timelineNativeLabels.command : entry.name === 'fileChange' ? timelineNativeLabels.fileChanges : entry.name}</strong><span className="session-tool-summary">{toolSummary(entry.input, entry.name)}</span><small className="session-tool-status">{labels[entry.status]}</small></>}><h5>{m.input}</h5><pre className="session-tool-input" tabIndex={0}>{entry.input}</pre><h5>{m.output}</h5><div>{entry.output.length ? <SessionParts entryId={entry.entryId} raw content={entry.output} resources={resources} active={active} onLoadResource={onLoadResource} resourceAccess={resourceAccess} onInvalidBindings={invalid} /> : <p>{labels.noOutput}</p>}</div>{entry.truncated ? <p className="session-notice">{m.truncated}</p> : null}</LazyDetails>;
      case 'interaction': return <SessionInteractionCard readOnly={resourceAccess === 'none'} key={`${entry.interaction.interactionId}/${entry.interaction.revision}`} interaction={entry.interaction} {...(operations ? { operations } : {})} enabled={canRespond && !pendingResponse} actionAdmitted={actionAdmitted} onRespond={(response) => onRespond(entry.interaction, response)} />;
      case 'error': {
        if (entry.code === 'input_cancelled' || entry.code === 'turn_interrupted') return <p className="session-cancellation" role="status">{entry.code === 'input_cancelled' ? labels.inputCancelled : labels.turnInterrupted}</p>;
        const activity = legacySubagentActivity(entry);
        if (activity) return <LazyDetails className="session-tool" summary={<><svg className="session-tool-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg><strong className="session-tool-name" title={activity.name}>{activity.name}</strong><span className="session-tool-summary">{toolSummary(activity.input, activity.name)}</span></>}><pre className="session-tool-input" tabIndex={0}>{activity.input}</pre></LazyDetails>;
        return <SessionError entry={entry} />;
      }
      case 'compaction': return <details className="session-compaction"><summary>{m.compaction}</summary><p>{entry.summary}</p></details>;
      case 'todo': return <section aria-label={m.todo}><ul className="session-todos">{entry.items.map((todo) => <li key={todo.id} data-status={todo.status}><span aria-hidden="true">{todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◉' : '○'}</span> {todo.text}</li>)}</ul></section>;
  }
});
