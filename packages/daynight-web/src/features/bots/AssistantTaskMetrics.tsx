import { useCallback } from 'react';
import { getAssistantTaskMetrics } from '../../api/assistant-tasks';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { assistantTaskAdmission } from './assistant-task-data';
import { useAssistantTaskContentMessages } from './assistant-task-messages';
import { useBotRead } from './useBotRead';

const minute = 60_000, hour = 60 * minute, day = 24 * hour;
/** Choose the largest unit that keeps the value at least one, so short and long resolutions stay readable. */
export function formatResolution(milliseconds: number, locale: string): string {
  const [value, unit] = milliseconds >= day ? [milliseconds / day, 'day'] : milliseconds >= hour ? [milliseconds / hour, 'hour'] : [milliseconds / minute, 'minute'];
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(value);
}

export function AssistantTaskMetrics({ taskId, enabled }: { readonly taskId: string; readonly enabled: boolean }) {
  const m = useAssistantTaskContentMessages();
  const load = useCallback((scope: TaskCacheScope, signal: AbortSignal) => getAssistantTaskMetrics(taskId, signal, assistantTaskAdmission(scope)), [taskId]);
  const read = useBotRead(`assistant-task-metrics:${taskId}`, enabled, load);
  const value = read.value, number = new Intl.NumberFormat(m.locale);
  const tiles = value ? [
    ['actions', m.actions, number.format(value.actionCount)],
    ['effective', m.effective, number.format(value.outcomes.effective)],
    ['ineffective', m.ineffective, number.format(value.outcomes.ineffective)],
    ['inconclusive', m.inconclusive, number.format(value.outcomes.inconclusive)],
    ['escalations', m.escalations, number.format(value.escalationCount)],
    ['results-unknown', m.resultsUnknown, number.format(value.resultUnknownCount)],
    ['closures', m.closures, number.format(value.closureCount)],
    ['average-resolution', m.averageResolution, value.averageResolutionMs === null ? '—' : formatResolution(value.averageResolutionMs, m.locale)],
    ['recurring', m.recurringItems, number.format(value.recurringItemCount)],
  ] as const : [];
  return <section className="assistant-task-panel assistant-task-metrics" aria-label={m.metrics} aria-busy={read.busy}>
    <header><h3>{m.metrics}</h3>{value ? <span className="assistant-task-meta">{m.metricsUpdated.replace('{time}', new Date(value.observedAt).toLocaleString(m.locale))}</span> : null}</header>
    {read.error ? <div role="alert" className="notice error">{m.metricsError}<button className="button" type="button" disabled={!enabled || read.busy} onClick={read.refresh}>{m.retry}</button></div> : null}
    {value === null && read.error === null ? <p role="status">{m.loading}</p> : null}
    {value ? <dl className="assistant-task-metric-grid">{tiles.map(([key, label, text]) => <div key={key} data-metric={key}><dt>{label}</dt><dd>{text}</dd></div>)}</dl> : null}
    {value && value.untimedClosureCount > 0 ? <p className="assistant-task-meta">{m.untimedClosures.replace('{count}', number.format(value.untimedClosureCount))}</p> : null}
  </section>;
}
