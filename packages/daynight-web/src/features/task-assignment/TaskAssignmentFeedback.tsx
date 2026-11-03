import { ApiError } from '../../api/client';
import { useI18n } from '../../i18n/LocaleProvider';
import type { TaskMutationState } from '../task-detail/TaskDetailSession';
import { TaskDetailNotice, useMutationNoticeEvent } from '../task-detail/TaskDetailNotice';

export const TaskAssignmentFeedback = ({ mutation, uncertain, onReconcile }: { readonly mutation: TaskMutationState; readonly uncertain: boolean; readonly onReconcile: () => void }) => {
  const { messages: { assignment: m, common } } = useI18n();
  const event = useMutationNoticeEvent(mutation);
  const relevant = mutation.operation?.action === 'assignedTo';
  const error = mutation.reconciliationError ?? mutation.error;
  const message = error instanceof ApiError && error.code === 'version_conflict' ? m.versionConflict
    : error instanceof ApiError && error.code === 'invalid_input' ? m.assigneeUnavailable : m.saveFailed;
  return <TaskDetailNotice active={relevant && (uncertain || error !== null)} event={event} tone={uncertain ? 'warning' : 'error'} recoverable>
    <div className="task-assignment-feedback" role="alert">
      {uncertain && <><p>{m.uncertain}</p><button className="button" type="button" disabled={mutation.reconciling} onClick={onReconcile}>{mutation.reconciling ? m.checking : m.checkState}</button></>}
      {error !== null && <p>{message}</p>}
      {error instanceof ApiError && error.requestId !== null && <p className="request-id">{common.requestId} <code>{error.requestId}</code></p>}
    </div>
  </TaskDetailNotice>;
};
