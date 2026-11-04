import { sessionFenceKey } from '../../../../daynight/src/session/protocol';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { legacySubagentActivity } from './legacy-subagent-activity';
import '../../styles/markdown.css';
import './session-timeline.css';
import { SessionMarkdown } from './SessionMarkdown';
import { timelineNativeLabels, useTimelineMessages } from './timeline-messages';
import type { InteractionResponse, MessagePart, SessionInteraction, TimelineEntry } from '../../api/types';
import { sessionRespondGate, hasPendingResponse, type SessionState } from './state';
import { SessionResourceView } from './SessionResourceView';
import { SessionInteractionCard } from './SessionInteractionCard';
import { useSessionMessages } from './messages';
import { useSessionHistoryPagination } from './useSessionHistoryPagination';
import { useTimelineScroll } from '../../ui/useTimelineScroll';
import { selectSessionDisplayEntries, type SessionDisplayMode } from './display-mode';

export function SessionTimeline({ state, active, canRespond, onRespond, hasOlder, loadingOlder, onLoadOlder, onLoadResource, historyError = null, displayMode = 'standard', historyReady = false, historyRevision = 0, connectionGeneration = 0 }: {
  readonly state: SessionState; readonly active: boolean; readonly canRespond: boolean;
  readonly onRespond: (interaction: SessionInteraction, response: InteractionResponse) => Promise<void>;
  readonly hasOlder: boolean; readonly loadingOlder: boolean; readonly onLoadOlder: () => Promise<void>;
  readonly onLoadResource: (resourceId: string, signal: AbortSignal) => Promise<Blob>; readonly historyError?: string | null;
  readonly displayMode?: SessionDisplayMode;
  readonly historyReady?: boolean; readonly historyRevision?: number; readonly connectionGeneration?: number;
}) {
  const m = useSessionMessages();
  const entries = useMemo(() => selectSessionDisplayEntries(state.entries, displayMode), [state.entries, displayMode]);
  const originalKeys = useMemo(() => state.entries.map(entry => entry.entryId), [state.entries]);
  const visibleKeys = useMemo(() => entries.map(entry => entry.entryId), [entries]);
  const identity = `${state.snapshot?.sessionId}/${state.snapshot?.historyEpoch}`;
  const scroll = useTimelineScroll(identity, active, state.entries, undefined, { originalKeys, visibleKeys, mode: displayMode });
  const historyIdentity = state.snapshot ? `${sessionFenceKey(state.snapshot)}/${state.snapshot.historyEpoch}/${state.snapshot.connectionEpoch}` : identity;
  const history = useSessionHistoryPagination({ scroll, identity: historyIdentity, mode: displayMode, active, ready: historyReady, generation: connectionGeneration, revision: historyRevision, hasOlder, loading: loadingOlder, error: historyError, load: onLoadOlder });
  return <div className="session-timeline-shell">
    <div className="session-timeline" ref={scroll.viewport} tabIndex={0} aria-label={m.title} onScroll={history.onScroll} onWheel={history.onWheel} onTouchStart={history.onTouchStart} onTouchMove={history.onTouchMove} onPointerDown={history.onPointerDown} onKeyDown={history.onKeyDown} onFocus={scroll.onFocus} onClick={(event) => { if (event.target instanceof Element && event.target.closest('a[data-footnote-ref], a[data-footnote-backref]')) scroll.pause(); }}>
      <div ref={scroll.content} className="session-timeline-content">
        {loadingOlder ? <div className="session-history-loading" role="status" aria-live="polite">{m.loadingOlder}</div> : null}
        {history.error ? <div role="alert" className="session-error session-history-error"><span>{history.error}</span>{hasOlder ? <button type="button" className="inline-link" disabled={!active || !historyReady || loadingOlder} onClick={history.retry}>{m.retryHistory}</button> : null}</div> : null}
        {entries.length === 0 ? <p className="session-empty">{displayMode === 'conversation' ? m.conversationEmpty : m.empty}</p> : entries.map((entry) => <article key={entry.entryId} data-entry-key={entry.entryId} className={`session-entry session-entry-${entry.kind}`}><SessionEntry entry={entry} resources={state.resources} active={active} canRespond={entry.kind === 'interaction' && sessionRespondGate(state, canRespond, entry.interaction)} pendingResponse={entry.kind === 'interaction' && hasPendingResponse(state, entry.interaction)} onRespond={onRespond} onLoadResource={onLoadResource} /></article>)}
      </div>
    </div>
    {scroll.showLatest ? <button className="button session-latest" onClick={history.latest}>{m.latest} ↓</button> : null}
  </div>;
}

function LazyDetails({ className, summary, children }: { readonly className: string; readonly summary: ReactNode; readonly children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return <details className={className} onToggle={(event) => setExpanded(event.currentTarget.open)}><summary>{summary}</summary>{expanded ? children : null}</details>;
}
type EntryProps = {
  readonly entry: TimelineEntry; readonly resources: SessionState['resources']; readonly active: boolean; readonly canRespond: boolean; readonly pendingResponse: boolean;
  readonly onRespond: (interaction: SessionInteraction, response: InteractionResponse) => Promise<void>;
  readonly onLoadResource: (resourceId: string, signal: AbortSignal) => Promise<Blob>;
};
function SessionParts({ content, resources, active, onLoadResource, raw = false }: Pick<EntryProps, 'resources' | 'active' | 'onLoadResource'> & { readonly content: readonly MessagePart[]; readonly raw?: boolean }) {
  return content.map((part, index) => {
    if (part.type === 'text') return raw ? <pre className="session-tool-output" tabIndex={0} key={index}>{part.text}</pre> : <SessionMarkdown key={index} text={part.text} />;
    const resource = resources.get(part.resourceId);
    return <SessionResourceView key={`${part.resourceId}/${resource?.status}/${resource?.sha256}`} resource={resource} label={part.label} active={active} onLoad={onLoadResource} />;
  });
}
function toolSummary(input: string): string {
  let value = input;
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const fields = parsed as Record<string, unknown>;
      const summary = ['command', 'cmd', 'file_path', 'filePath', 'path', 'query', 'description', 'url'].map(key => fields[key]).find(value => typeof value === 'string');
      if (typeof summary === 'string') value = summary;
    }
  } catch { /* Shell commands and other plain-text parameters are already readable. */ }
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > 180 ? `${line.slice(0, 179)}…` : line;
}
const SessionEntry = memo(function SessionEntry({ entry, resources, active, canRespond, pendingResponse, onRespond, onLoadResource }: EntryProps) {
  const m = useSessionMessages(), labels = useTimelineMessages();
  switch (entry.kind) {
      case 'user_message': case 'assistant_message': return <div className={`session-message ${entry.kind} markdown-content`}><SessionParts content={entry.content} resources={resources} active={active} onLoadResource={onLoadResource} /></div>;
      case 'reasoning': return <LazyDetails className="session-reasoning" summary={m.reasoning}><SessionMarkdown text={entry.text} /></LazyDetails>;
      case 'tool_call': return <LazyDetails className={`session-tool session-tool-${entry.status}`} summary={<><svg className="session-tool-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg><strong className="session-tool-name" title={entry.name} lang={entry.name === 'commandExecution' || entry.name === 'fileChange' ? 'en' : undefined}>{entry.name === 'commandExecution' ? timelineNativeLabels.command : entry.name === 'fileChange' ? timelineNativeLabels.fileChanges : entry.name}</strong><span className="session-tool-summary">{toolSummary(entry.input)}</span><small className="session-tool-status">{labels[entry.status]}</small></>}><h5>{m.input}</h5><pre className="session-tool-input" tabIndex={0}>{entry.input}</pre><h5>{m.output}</h5><div>{entry.output.length ? <SessionParts raw content={entry.output} resources={resources} active={active} onLoadResource={onLoadResource} /> : <p>{labels.noOutput}</p>}</div>{entry.truncated ? <p className="session-notice">{m.truncated}</p> : null}</LazyDetails>;
      case 'interaction': return <SessionInteractionCard key={`${entry.interaction.interactionId}/${entry.interaction.revision}`} interaction={entry.interaction} enabled={canRespond && !pendingResponse} onRespond={(response) => onRespond(entry.interaction, response)} />;
      case 'error': {
        if (entry.code === 'input_cancelled' || entry.code === 'turn_interrupted') return <p className="session-cancellation" role="status">{entry.code === 'input_cancelled' ? labels.inputCancelled : labels.turnInterrupted}</p>;
        const activity = legacySubagentActivity(entry);
        if (activity) return <LazyDetails className="session-tool" summary={<><svg className="session-tool-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg><strong className="session-tool-name" title={activity.name}>{activity.name}</strong><span className="session-tool-summary">{toolSummary(activity.input)}</span></>}><pre className="session-tool-input" tabIndex={0}>{activity.input}</pre></LazyDetails>;
        return <div className="session-error" role="alert"><strong>{entry.code}</strong><p>{entry.message}</p></div>;
      }
      case 'compaction': return <details className="session-compaction"><summary>{m.compaction}</summary><p>{entry.summary}</p></details>;
      case 'todo': return <section aria-label={m.todo}><ul className="session-todos">{entry.items.map((todo) => <li key={todo.id} data-status={todo.status}><span aria-hidden="true">{todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◉' : '○'}</span> {todo.text}</li>)}</ul></section>;
  }
});
