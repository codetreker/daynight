import { ApiError } from '../../../api/client';
import { useI18n } from '../../../i18n/LocaleProvider';
import type { useWorkerReviewParticipation } from './useWorkerReviewParticipation';

export const WorkerReviewParticipation = ({ state, enabled }: { readonly state: ReturnType<typeof useWorkerReviewParticipation>; readonly enabled: boolean }) => {
  const { messages: { workers: { configuration: { review: m, enabled: on, disabled: off }, retry }, common } } = useI18n();
  const inactive = !enabled || state.pending || state.needsRead || state.value === null || state.unavailable;
  return <section className="panel worker-review-panel" aria-labelledby="worker-review-title">
    <header className="panel-heading"><h2 id="worker-review-title">{m.title}</h2></header>
    <div className="panel-body">
      <div className="worker-review-row"><div><strong>{m.label}</strong><p id="worker-review-detail">{m.detail}</p></div>
        <div className="worker-review-control" hidden={state.value === null}><span aria-hidden="true">{state.value?.enabled ? on : off}</span><button type="button" className="worker-review-switch" role="switch" aria-label={m.label} aria-describedby="worker-review-detail" aria-checked={state.value?.enabled ?? false} aria-disabled={inactive} aria-busy={state.pending || state.reading && state.needsRead} onClick={() => { if (!inactive) state.toggle(); }}><span /></button></div>
      </div>
      <div aria-live="polite">
        {state.pending ? <p role="status">{m.saving}</p> : state.value === null && state.reading ? <p role="status">{m.loading}</p> : null}
        {state.unavailable && <p role="status">{m.unavailable}</p>}
        {state.notice === 'saved' && <p role="status">{m.saved}</p>}
        {state.notice === 'conflict' && <p role="alert">{m.conflict}</p>}
        {state.notice === 'unknown' && <p role="alert">{m.unknown}</p>}
        {state.notice === 'rejected' && <p role="alert">{m.rejected}</p>}
        {state.error !== null && state.notice !== 'rejected' && <p role="alert">{state.needsRead ? m.checkError : m.readError}</p>}
        {state.error instanceof ApiError && state.error.requestId !== null && <p className="request-id">{common.requestId} <code>{state.error.requestId}</code></p>}
        {state.error !== null && state.notice !== 'rejected' && <button className="button" type="button" disabled={!enabled || state.reading || state.pending} onClick={state.refresh}>{retry}</button>}
      </div>
    </div>
  </section>;
};
