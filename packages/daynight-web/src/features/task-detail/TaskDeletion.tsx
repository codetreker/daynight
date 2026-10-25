import type { RefObject } from 'react';
import { ApiError } from '../../api/client';
import type { TaskDetail } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { taskReviewKey } from './freshness';
import { TaskConfirmation } from './TaskConfirmation';
import { TaskDetailNotice, useMutationNoticeEvent } from './TaskDetailNotice';
import type { TaskMutationState } from './TaskDetailSession';

export type DeletionConfirmation = { readonly kind: 'delete'; readonly detail: TaskDetail; readonly removeDepends: true };
export const matchesDeletionReview = (confirmation: DeletionConfirmation, detail: TaskDetail | null): boolean =>
  detail !== null && taskReviewKey(confirmation.detail) === taskReviewKey(detail);

export const TaskDeletionConfirmation = ({ confirmation, ...props }: {
  readonly confirmation: DeletionConfirmation;
  readonly owner: RefObject<HTMLElement | null>;
  readonly fallbackFocus: RefObject<HTMLElement | null>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) => {
  const { messages: { inspection: { deletion: m } } } = useI18n();
  return <TaskConfirmation {...props} title={m.title} question={m.question} explanation={m.explanation}
    taskTitle={confirmation.detail.title} confirmLabel={m.confirm} cancelLabel={m.cancel} closeLabel={m.closeConfirmation} destructive />;
};

const DeletionError = ({ error }: { readonly error: unknown }) => {
  const { messages: { inspection: { deletion: m }, common } } = useI18n();
  const message = error instanceof ApiError
    ? error.kind === 'network' ? m.networkError : error.kind === 'protocol' ? m.protocolError
      : error.code === 'version_conflict' ? m.versionConflict : error.code === 'dependency_unsatisfied' ? m.dependencyUnsatisfied
        : error.code === 'invalid_transition' ? m.invalidTransition : error.code === 'not_found' ? m.notFound : m.refused
    : m.requestFailed;
  return <><p>{message}</p>{error instanceof ApiError && error.requestId !== null && <p className="request-id">{common.requestId}{' '}<code>{error.requestId}</code></p>}</>;
};

export const TaskDeletionFeedback = ({ mutation, onReconcile }: {
  readonly mutation: TaskMutationState;
  readonly onReconcile: () => void;
}) => {
  const { messages: { inspection: { deletion: m } } } = useI18n();
  const relevant = mutation.operation?.action === 'delete';
  const event = useMutationNoticeEvent(mutation);
  const busy = relevant && (mutation.phase === 'pending' || mutation.reconciling);
  const unresolved = relevant && (mutation.phase === 'unknown' || mutation.reconciliationError !== null);
  const summary = !relevant ? null : mutation.reconciling ? m.checking : mutation.phase === 'pending' ? m.pending
    : mutation.phase === 'unknown' ? m.unknown : mutation.phase === 'conflict' ? m.conflict : mutation.phase === 'reconciled' ? m.reconciled : null;
  return <div className="task-deletion-feedback" aria-live="polite" aria-busy={busy}><TaskDetailNotice active={relevant && mutation.phase !== 'idle' && mutation.phase !== 'confirmed'} event={event}
    tone={mutation.phase === 'refused' ? 'error' : unresolved || mutation.phase === 'conflict' ? 'warning' : 'info'} recoverable={unresolved}>
    {summary !== null && <p role={unresolved || mutation.phase === 'conflict' ? 'alert' : 'status'}>{summary}</p>}
    {unresolved && <button className="button" type="button" disabled={busy} onClick={onReconcile}>{mutation.reconciling ? m.checking : m.checkState}</button>}
    {relevant && mutation.error !== null && <div role="alert"><DeletionError error={mutation.error} /></div>}
    {relevant && mutation.reconciliationError !== null && <div role="alert"><p>{m.checkFailed}</p><DeletionError error={mutation.reconciliationError} /></div>}
  </TaskDetailNotice></div>;
};
