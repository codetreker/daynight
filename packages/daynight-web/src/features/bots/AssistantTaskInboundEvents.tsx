import { useState } from 'react';
import type { AssistantTaskEvent, AssistantTaskJson } from '../../api/assistant-tasks';
import type { BotDefinition } from '../../api/bots';
import { navigate, projectSectionUrl, taskDetailUrl } from '../../app/router';
import { useAssistantTaskContentMessages } from './assistant-task-messages';

/** External bodies are untrusted; the page shows only a bounded plain-text preview. */
export const INBOUND_PREVIEW_CHARACTERS = 600;
const PAGE = 20;
const canonicalId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type InboundActor = { readonly kind: 'user' | 'bot' | 'system'; readonly botId: string | null } | null;
export type InboundPayload =
  | { readonly classification: 'daynight'; readonly receivedAt: string; readonly eventType: string; readonly projectId: string | null; readonly taskId: string | null; readonly occurredAt: string; readonly actor: InboundActor }
  | { readonly classification: 'external'; readonly receivedAt: string; readonly mediaType: string; readonly byteLength: number; readonly preview: string; readonly truncated: boolean };

type JsonObject = { readonly [key: string]: AssistantTaskJson };
const object = (value: AssistantTaskJson | undefined): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: AssistantTaskJson | undefined): string => typeof value === 'string' ? value : '';
const id = (value: AssistantTaskJson | undefined): string | null => typeof value === 'string' && canonicalId.test(value) ? value : null;

/** Reads the stored inbound payload defensively; an unrecognized shape returns null and the event shows only its envelope. */
export function parseInboundPayload(payload: AssistantTaskJson): InboundPayload | null {
  if (!object(payload)) return null;
  if (payload.classification === 'daynight') {
    const kind = object(payload.actor) ? payload.actor.kind : null;
    const actor: InboundActor = kind === 'user' || kind === 'bot' || kind === 'system' ? { kind, botId: object(payload.actor) ? id(payload.actor.botId) : null } : null;
    return { classification: 'daynight', receivedAt: text(payload.receivedAt), eventType: text(payload.eventType), projectId: id(payload.projectId), taskId: id(payload.taskId), occurredAt: text(payload.occurredAt), actor };
  }
  if (payload.classification === 'external') {
    const characters = [...text(payload.body)];
    return { classification: 'external', receivedAt: text(payload.receivedAt), mediaType: text(payload.mediaType), byteLength: typeof payload.byteLength === 'number' ? payload.byteLength : 0, preview: characters.slice(0, INBOUND_PREVIEW_CHARACTERS).join(''), truncated: characters.length > INBOUND_PREVIEW_CHARACTERS };
  }
  return null;
}

const Time = ({ value, locale }: { readonly value: string; readonly locale: string }) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : <time dateTime={value}>{date.toLocaleString(locale)}</time>;
};

const Link = ({ href, children }: { readonly href: string; readonly children: string }) =>
  <a href={href} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(href); }}>{children}</a>;

/**
 * Inbound events are informational: they never use the attention role and stay
 * outside the decisions strip. Whether the user must act is the assistant's report.
 */
export function AssistantTaskInboundEvents({ events, bots = [], eventId }: { readonly events: readonly AssistantTaskEvent[]; readonly bots?: readonly BotDefinition[]; readonly eventId?: string }) {
  const m = useAssistantTaskContentMessages();
  const [paged, setShown] = useState(PAGE);
  const inbound = events.filter(event => event.type === 'inbound').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // A deep-linked event must be rendered so the detail view can focus it, even when it is older than the loaded page.
  const shown = Math.max(paged, inbound.findIndex(event => event.id === eventId) + 1);
  if (inbound.length === 0) return null;
  const actorName = (actor: InboundActor) => actor === null ? m.inboundActorUnknown : actor.kind === 'user' ? m.inboundActorUser : actor.kind === 'system' ? m.system
    : actor.botId === null ? m.inboundActorUnknown : bots.find(bot => bot.id === actor.botId)?.name ?? m.unknownAssistant.replace('{id}', actor.botId);
  return <section className="assistant-task-panel assistant-task-inbound" aria-label={m.inbound}>
    <header><h3>{m.inbound}</h3><span className="assistant-task-meta">{m.inboundCount.replace('{count}', String(inbound.length))}</span></header>
    <ol className="assistant-task-records">{inbound.slice(0, shown).map(event => {
      const payload = parseInboundPayload(event.payload);
      return <li className="assistant-task-record" id={`assistant-event-${event.id}`} tabIndex={-1} key={event.id} data-classification={payload?.classification ?? 'unknown'}>
        <header>
          <span className="assistant-task-badge">{payload?.classification === 'daynight' ? m.inboundDaynight : payload?.classification === 'external' ? m.inboundExternal : m.inboundUnreadable}</span>
          {payload?.classification === 'external' ? <span className="assistant-task-badge" data-untrusted="true">{m.inboundUntrusted}</span> : null}
          <span>{m[`inbound_${event.state}`]}</span>
          <Time value={event.createdAt} locale={m.locale} />
        </header>
        {payload?.classification === 'daynight' ? <dl className="assistant-task-inbound-facts">
          <div><dt>{m.inboundEventType}</dt><dd><code>{payload.eventType || '—'}</code></dd></div>
          <div><dt>{m.inboundSource}</dt><dd>{payload.projectId ? <Link href={projectSectionUrl(payload.projectId, 'overview')}>{m.inboundProject}</Link> : '—'}{payload.projectId && payload.taskId ? <>{' · '}<Link href={taskDetailUrl(payload.projectId, payload.taskId, { tab: 'overview', path: null })}>{m.inboundTask}</Link></> : null}</dd></div>
          <div><dt>{m.author}</dt><dd>{actorName(payload.actor)}</dd></div>
          <div><dt>{m.inboundOccurred}</dt><dd><Time value={payload.occurredAt} locale={m.locale} /></dd></div>
        </dl> : null}
        {payload?.classification === 'external' ? <>
          <p className="assistant-task-meta"><span>{payload.mediaType}</span><span>{m.inboundBytes.replace('{count}', String(payload.byteLength))}</span></p>
          <p className="assistant-task-meta">{m.inboundUntrustedHint}</p>
          {/* Rendered as a text node only: no Markdown, links or HTML from the sender. */}
          <pre className="assistant-task-rules assistant-task-inbound-preview">{payload.preview}{payload.truncated ? '…' : ''}</pre>
          {payload.truncated ? <p className="assistant-task-meta">{m.inboundTruncated}</p> : null}
        </> : null}
      </li>;
    })}</ol>
    {inbound.length > shown ? <button className="button" type="button" onClick={() => setShown(shown + PAGE)}>{m.inboundMore}</button> : null}
  </section>;
}
