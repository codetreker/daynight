import type { RefObject } from 'react';
import { ApiError } from '../../api/client';
import { executionPlatform } from '../../api/parse';
import type { ExecutionPlatform, TaskDetail } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { taskReviewKey } from './freshness';
import { TaskConfirmation } from './TaskConfirmation';
import { TaskControlTip, TaskDetailNotice, useMutationNoticeEvent } from './TaskDetailNotice';
import type { TaskMutationState } from './TaskDetailSession';

export const TaskPlatformBadge = ({ requiredPlatform, compact = false }: {
  readonly requiredPlatform: ExecutionPlatform | null;
  readonly compact?: boolean;
}) => {
  const { messages: { platform: m } } = useI18n();
  const label = requiredPlatform === null ? m.any : m.names[requiredPlatform];
  return <span className={`task-platform${compact ? ' task-platform-compact' : ''}`} title={`${m.title}: ${label}`}>{label}</span>;
};

export type PlatformConfirmation = { readonly detail: TaskDetail; readonly requiredPlatform: ExecutionPlatform | null };
export const matchesPlatformReview = (confirmation: PlatformConfirmation, detail: TaskDetail | null): boolean =>
  detail !== null && taskReviewKey(confirmation.detail) === taskReviewKey(detail) && confirmation.requiredPlatform !== detail.requiredPlatform;

export const TaskPlatformConfirmation = ({ confirmation, ...props }: {
  readonly confirmation: PlatformConfirmation;
  readonly owner: RefObject<HTMLElement | null>;
  readonly fallbackFocus: RefObject<HTMLElement | null>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) => {
  const { messages: { platform: m } } = useI18n();
  const name = (value: ExecutionPlatform | null): string => value === null ? m.any : m.names[value];
  return <TaskConfirmation {...props} title={m.confirmTitle} question={m.confirmQuestion}
    content={<><p>{m.transition({ from: name(confirmation.detail.requiredPlatform), to: name(confirmation.requiredPlatform) })}</p><p>{m.explanation}</p></>}
    explanation={m.explanation} taskTitle={confirmation.detail.title} confirmLabel={m.confirm} cancelLabel={m.cancel} closeLabel={m.closeConfirmation} />;
};

export const TaskPlatformSelect = ({ detail, disabled, describedBy, onReview }: {
  readonly detail: TaskDetail;
  readonly disabled: boolean;
  readonly describedBy: string;
  readonly onReview: (requiredPlatform: ExecutionPlatform | null) => void;
}) => {
  const { messages: { platform: m } } = useI18n();
  const saved = detail.requiredPlatform === null ? '' : detail.requiredPlatform;
  return <TaskControlTip text={detail.status === 'in_progress' ? m.locked : null} label={m.title} id={`${describedBy}-tip`}><select className="task-platform-select" aria-label={m.title} aria-describedby={detail.status === 'in_progress' ? `${describedBy}-tip` : undefined}
    title={detail.status === 'in_progress' ? undefined : m.help} value={saved} disabled={disabled}
    onChange={(event) => {
      const selected = event.currentTarget.value === '' ? null : executionPlatform(event.currentTarget.value);
      event.currentTarget.value = saved;
      if (selected !== detail.requiredPlatform) onReview(selected);
    }}>
    <option value="">{m.any}</option>
    {(['windows', 'linux', 'macos'] as const).map((platform) => <option value={platform} key={platform}>{m.names[platform]}</option>)}
  </select></TaskControlTip>;
};

const PlatformError = ({ error }: { readonly error: unknown }) => {
  const { messages: { platform: m, common } } = useI18n();
  const message = error instanceof ApiError
    ? error.kind === 'network' ? m.networkError : error.kind === 'protocol' ? m.protocolError
      : error.code === 'version_conflict' ? m.versionConflict : error.code === 'invalid_transition' ? m.invalidTransition
        : error.code === 'not_found' ? m.notFound : m.refused
    : m.requestFailed;
  return <><p>{message}</p>{error instanceof ApiError && error.requestId !== null && <p className="request-id">{common.requestId}{' '}<code>{error.requestId}</code></p>}</>;
};

export const TaskPlatformFeedback = ({ id, mutation, onReconcile }: {
  readonly id?: string;
  readonly detail: TaskDetail | null;
  readonly mutation: TaskMutationState;
  readonly onReconcile: () => void;
}) => {
  const { messages: { platform: m } } = useI18n();
  const relevant = mutation.operation?.action === 'requiredPlatform';
  const event = useMutationNoticeEvent(mutation);
  const busy = relevant && (mutation.phase === 'pending' || mutation.reconciling);
  const unresolved = relevant && (mutation.phase === 'unknown' || mutation.reconciliationError !== null);
  const summary = !relevant ? null : mutation.reconciling ? m.checking : mutation.phase === 'pending' ? m.pending
    : mutation.phase === 'confirmed' ? m.confirmed : mutation.phase === 'unknown' ? m.unknown
      : mutation.phase === 'conflict' ? m.conflict : mutation.phase === 'reconciled' ? m.reconciled : null;
  return <div id={id} className="task-platform-feedback" aria-live="polite" aria-busy={busy}><TaskDetailNotice active={relevant && mutation.phase !== 'idle'} event={event}
    initiallyVisible={mutation.phase !== 'confirmed'} tone={mutation.phase === 'confirmed' ? 'success' : mutation.phase === 'refused' ? 'error' : unresolved || mutation.phase === 'conflict' ? 'warning' : 'info'} recoverable={unresolved}>
    {summary !== null && <p role={unresolved || mutation.phase === 'conflict' ? 'alert' : 'status'}>{summary}</p>}
    {unresolved && <button className="button" type="button" disabled={busy} onClick={onReconcile}>{mutation.reconciling ? m.checking : m.checkState}</button>}
    {relevant && mutation.error !== null && <div className="task-platform-error" role="alert"><PlatformError error={mutation.error} /></div>}
    {relevant && mutation.reconciliationError !== null && <div className="task-platform-error" role="alert"><p>{m.checkFailed}</p><PlatformError error={mutation.reconciliationError} /></div>}
  </TaskDetailNotice></div>;
};
