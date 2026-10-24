import { useId, type RefObject } from 'react';
import { ApiError } from '../../api/client';
import type { TaskDetail } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { taskReviewKey } from './freshness';
import { TaskConfirmation } from './TaskConfirmation';
import { TaskControlTip, TaskDetailNotice, useMutationNoticeEvent } from './TaskDetailNotice';
import type { TaskMutationState } from './TaskDetailSession';

export type AgentPermissionConfirmation = { readonly detail: TaskDetail; readonly allowAgents: boolean };
export const matchesAgentPermissionReview = (confirmation: AgentPermissionConfirmation, detail: TaskDetail | null): boolean =>
  detail !== null && taskReviewKey(confirmation.detail) === taskReviewKey(detail);

export const TaskAgentPermissionConfirmation = ({ confirmation, ...props }: {
  readonly confirmation: AgentPermissionConfirmation;
  readonly owner: RefObject<HTMLElement | null>;
  readonly fallbackFocus: RefObject<HTMLElement | null>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) => {
  const { messages: { automation: m } } = useI18n();
  return <TaskConfirmation {...props} title={confirmation.allowAgents ? m.enableTitle : m.disableTitle}
    question={confirmation.allowAgents ? m.enableQuestion : m.disableQuestion}
    explanation={confirmation.allowAgents ? m.enableExplanation : m.disableExplanation}
    taskTitle={confirmation.detail.title} confirmLabel={confirmation.allowAgents ? m.enableAction : m.disableAction} cancelLabel={m.cancel} closeLabel={m.closeConfirmation} />;
};

export const TaskAgentPermissionSwitch = ({ detail, disabled, onClick, describedBy }: {
  readonly detail: TaskDetail;
  readonly disabled: boolean;
  readonly describedBy: string;
  readonly onClick: () => void;
}) => {
  const { messages: { automation: m } } = useI18n();
  const labelId = useId();
  return <div className="task-automation-control">
    <span id={labelId}>{m.label}</span>
    <TaskControlTip text={detail.status === 'in_progress' ? m.locked : null} label={m.label} id={`${describedBy}-tip`}><button className="task-automation-switch" type="button" role="switch" aria-checked={detail.allowAgents}
      aria-labelledby={labelId} aria-describedby={detail.status === 'in_progress' ? `${describedBy}-tip` : undefined} disabled={disabled} onClick={onClick}><span aria-hidden="true" /></button></TaskControlTip>
  </div>;
};

const PermissionError = ({ error }: { readonly error: unknown }) => {
  const { messages: { automation: m, common } } = useI18n();
  const message = error instanceof ApiError
    ? error.kind === 'network' ? m.networkError : error.kind === 'protocol' ? m.protocolError
      : error.code === 'version_conflict' ? m.versionConflict : error.code === 'invalid_transition' ? m.invalidTransition
        : error.code === 'not_found' ? m.notFound : m.refused
    : m.requestFailed;
  return <><p>{message}</p>{error instanceof ApiError && error.requestId !== null && <p className="request-id">{common.requestId}{' '}<code>{error.requestId}</code></p>}</>;
};

export const TaskAgentPermissionFeedback = ({ mutation, id, onReconcile }: {
  readonly detail: TaskDetail | null;
  readonly mutation: TaskMutationState;
  readonly id: string;
  readonly onReconcile: () => void;
}) => {
  const { messages: { automation: m } } = useI18n();
  const relevant = mutation.operation?.action === 'allowAgents';
  const event = useMutationNoticeEvent(mutation);
  const busy = relevant && (mutation.phase === 'pending' || mutation.reconciling);
  const unresolved = relevant && (mutation.phase === 'unknown' || mutation.reconciliationError !== null);
  const message = !relevant ? null : mutation.reconciling ? m.checking : mutation.phase === 'pending' ? m.pending
    : mutation.phase === 'confirmed' ? m.confirmed : mutation.phase === 'unknown' ? m.unknown
      : mutation.phase === 'conflict' ? m.conflict : mutation.phase === 'reconciled' ? m.reconciled : null;
  return <div id={id} className="task-automation-feedback" aria-live="polite" aria-busy={busy}><TaskDetailNotice active={relevant && mutation.phase !== 'idle'} event={event}
    initiallyVisible={mutation.phase !== 'confirmed'} tone={mutation.phase === 'confirmed' ? 'success' : mutation.phase === 'refused' ? 'error' : unresolved || mutation.phase === 'conflict' ? 'warning' : 'info'} recoverable={unresolved}>
    {message !== null && <p role={unresolved || mutation.phase === 'conflict' ? 'alert' : 'status'}>{message}</p>}
    {unresolved && <button className="button" type="button" disabled={busy} onClick={onReconcile}>{mutation.reconciling ? m.checking : m.checkState}</button>}
    {relevant && mutation.error !== null && <div className="task-automation-error" role="alert"><PermissionError error={mutation.error} /></div>}
    {relevant && mutation.reconciliationError !== null && <div className="task-automation-error" role="alert"><p>{m.checkFailed}</p><PermissionError error={mutation.reconciliationError} /></div>}
  </TaskDetailNotice></div>;
};
