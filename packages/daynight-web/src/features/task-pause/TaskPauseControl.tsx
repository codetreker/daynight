import { useLayoutEffect, useRef, type RefObject } from 'react';
import { ApiError } from '../../api/client';
import { useI18n } from '../../i18n/LocaleProvider';
import type { TaskMutationState } from '../task-detail/TaskDetailSession';
import { TaskControlTip, TaskDetailNotice, useMutationNoticeEvent } from '../task-detail/TaskDetailNotice';
import { TaskPauseIcon } from './TaskPause';

export const TaskPauseControl = ({ paused, disabled, mutation, onUnpause, fallbackFocus }: {
  readonly paused: boolean;
  readonly disabled: boolean;
  readonly mutation: TaskMutationState;
  readonly onUnpause: () => void;
  readonly fallbackFocus: RefObject<HTMLElement | null>;
}) => {
  const { messages: { inspection: { pause: m } } } = useI18n();
  const busy = mutation.operation?.action === 'unpause' && mutation.phase === 'pending';
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!paused && restoreFocus.current) {
      restoreFocus.current = false;
      if (document.activeElement === document.body) fallbackFocus.current?.focus({ preventScroll: true });
    }
  }, [paused, fallbackFocus]);
  if (!paused) return null;
  return <div className="task-pause-strip">
    <span className="task-pause-label"><TaskPauseIcon />{m.label}</span>
    <TaskControlTip text={disabled && !busy ? m.unavailable : null} label={m.unpause}>
      <button className="button task-pause-unpause" type="button" disabled={disabled || busy} aria-busy={busy} onBlur={(event) => { if (event.relatedTarget instanceof HTMLElement && event.relatedTarget !== document.body) restoreFocus.current = false; }} onClick={() => { restoreFocus.current = true; onUnpause(); }}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.7a.7.7 0 0 1 1.05-.6l8 5.3a.7.7 0 0 1 0 1.2l-8 5.3a.7.7 0 0 1-1.05-.6z" /></svg>}
        {busy ? m.unpausing : m.unpause}
      </button>
    </TaskControlTip>
  </div>;
};

const PauseError = ({ error }: { readonly error: unknown }) => {
  const { messages: { inspection: { pause: m }, common } } = useI18n();
  const message = error instanceof ApiError
    ? error.kind === 'network' ? m.networkError : error.kind === 'protocol' ? m.protocolError
      : error.code === 'version_conflict' ? m.versionConflict : error.code === 'not_found' ? m.notFound : m.refused
    : m.requestFailed;
  return <><p>{message}</p>{error instanceof ApiError && error.requestId !== null && <p className="request-id">{common.requestId}{' '}<code>{error.requestId}</code></p>}</>;
};

export const TaskPauseFeedback = ({ mutation, onReconcile }: { readonly mutation: TaskMutationState; readonly onReconcile: () => void }) => {
  const { messages: { inspection: { pause: m } } } = useI18n();
  const relevant = mutation.operation?.action === 'unpause';
  const event = useMutationNoticeEvent(mutation);
  const busy = relevant && (mutation.phase === 'pending' || mutation.reconciling);
  const unresolved = relevant && (mutation.phase === 'unknown' || mutation.reconciliationError !== null);
  const message = !relevant ? null : mutation.reconciling ? m.checking : mutation.phase === 'confirmed' ? m.confirmed : mutation.phase === 'unknown' ? m.unknown
      : mutation.phase === 'conflict' ? m.conflict : mutation.phase === 'reconciled' ? m.reconciled : null;
  return <div className="task-pause-feedback" aria-live="polite" aria-busy={busy}><TaskDetailNotice active={relevant && mutation.phase !== 'idle' && mutation.phase !== 'pending'} event={event}
    initiallyVisible={mutation.phase !== 'confirmed'} tone={mutation.phase === 'confirmed' ? 'success' : mutation.phase === 'refused' ? 'error' : unresolved || mutation.phase === 'conflict' ? 'warning' : 'info'} recoverable={unresolved}>
    {message !== null && <p role={unresolved || mutation.phase === 'conflict' ? 'alert' : 'status'}>{message}</p>}
    {unresolved && <button className="button" type="button" disabled={busy} onClick={onReconcile}>{mutation.reconciling ? m.checking : m.checkState}</button>}
    {relevant && mutation.error !== null && <div role="alert"><PauseError error={mutation.error} /></div>}
    {relevant && mutation.reconciliationError !== null && <div role="alert"><p>{m.checkFailed}</p><PauseError error={mutation.reconciliationError} /></div>}
  </TaskDetailNotice></div>;
};
