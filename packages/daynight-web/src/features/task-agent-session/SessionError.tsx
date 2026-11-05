import { useMemo, useState } from 'react';
import type { TimelineEntry } from '../../api/types';
import { useTimelineMessages } from './timeline-messages';

function diagnostic(message: string) {
  let summary = message.trim(), retryEnvelope = false;
  try {
    const parsed: unknown = JSON.parse(message);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const fields = parsed as Record<string, unknown>;
      summary = typeof fields.message === 'string' ? fields.message.trim() : '';
      retryEnvelope = summary.length > 0 && typeof fields.details === 'string';
    } else summary = '';
  } catch {
    // Truncated historical JSON has no reliable summary; its bytes remain in details.
    if (/^[\[{\"]/.test(summary)) summary = '';
  }
  summary = summary.replace(/\s+/g, ' ');
  return { summary: summary.length > 240 ? `${summary.slice(0, 239)}…` : summary, retryEnvelope };
}

export function SessionError({ entry }: { readonly entry: Extract<TimelineEntry, { kind: 'error' }> }) {
  const labels = useTimelineMessages();
  const [expanded, setExpanded] = useState(false);
  const content = useMemo(() => diagnostic(entry.message), [entry.message]);
  const retry = entry.code === 'native_retry' && content.retryEnvelope;
  const title = retry ? labels.retryNotice : entry.code === 'native_turn_error' ? labels.turnFailed : labels.error;
  return <div className={`session-diagnostic ${retry ? 'session-diagnostic-retry' : 'session-diagnostic-error'}`} role={retry ? 'status' : 'alert'}>
    <p className="session-diagnostic-heading"><strong>{title}</strong><span className="session-diagnostic-summary">{content.summary || labels.errorReported}</span></p>
    <details className="session-diagnostic-details" onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>{labels.technicalDetails}</summary>
      <div><code>{entry.code}</code>{expanded ? <pre tabIndex={0}>{entry.message}</pre> : null}</div>
    </details>
  </div>;
}
