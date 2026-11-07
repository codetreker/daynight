import type { RefObject } from 'react';
import type { TaskDetail, TaskStatus } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { TaskConfirmation } from './TaskConfirmation';
import { readWorkerClaim } from '../../api/task-properties';
import { taskReviewKey } from './freshness';

export type StatusConfirmation = { readonly kind: 'status'; readonly detail: TaskDetail; readonly status: TaskStatus };
export const matchesStatusReview = (confirmation: StatusConfirmation, detail: TaskDetail | null): boolean =>
  detail !== null && taskReviewKey(confirmation.detail) === taskReviewKey(detail);

export const TaskStatusConfirmation = ({ confirmation, ...props }: {
  readonly confirmation: StatusConfirmation;
  readonly owner: RefObject<HTMLElement | null>;
  readonly fallbackFocus: RefObject<HTMLElement | null>;
  readonly confirmDisabled?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) => {
  const { messages: { inspection: { status: m }, common } } = useI18n();
  const { detail, status } = confirmation;
  const cancellation = status === 'cancelled';
  const blocked = cancellation && readWorkerClaim(detail.properties)?.state === 'active';
  const timing = detail.status === status ? m.unchanged : cancellation ? blocked ? m.releaseBeforeCancel : m.cancelExplanation : status === 'todo' ? m.resetTiming : status === 'in_progress' ? m.startTiming : detail.status === 'in_progress' ? m.finishTiming : m.directFinishTiming;
  return <TaskConfirmation {...props} title={m.title} question={cancellation ? m.cancelQuestion : m.question} confirmDisabled={blocked || props.confirmDisabled === true}
    explanation={timing} taskTitle={detail.title}
    content={<><div className="task-status-route"><span className={`task-detail-status task-detail-status-${detail.status}`}>{common.status[detail.status]}</span><span aria-hidden="true">→</span><span className={`task-detail-status task-detail-status-${status}`}>{common.status[status]}</span></div><p className="task-status-timing">{timing}</p></>}
    confirmLabel={cancellation ? m.confirmCancellation : m.confirm} cancelLabel={m.cancel} closeLabel={m.closeConfirmation} />;
};
