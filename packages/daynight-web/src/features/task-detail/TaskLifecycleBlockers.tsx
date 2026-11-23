import { ApiError } from '../../api/client';
import { taskDetailUrl } from '../../app/router';
import { browserNavigation } from '../../app/navigation';
import { useI18n } from '../../i18n/LocaleProvider';

export const TaskLifecycleBlockers = ({ error, projectId }: { readonly error: unknown; readonly projectId: string }) => {
  const { messages: { inspection: { status: m } } } = useI18n();
  if (!(error instanceof ApiError) || error.taskIds === undefined || error.taskIds.length === 0) return null;
  return <ul className="task-detail-relations" aria-label={m.blockingTasks}>{error.taskIds.map(id => <li key={id}><a href={taskDetailUrl(projectId, id, { tab: 'overview', path: null })} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); browserNavigation().navigate(event.currentTarget.getAttribute('href')!);
  }}>{id}</a></li>)}</ul>;
};

export const taskLifecycleReason = (error: unknown, messages: ReturnType<typeof useI18n>['messages']['inspection']['status']): string | null => {
  if (!(error instanceof ApiError) || error.kind !== 'server') return null;
  return error.code === 'task_unfinished_children' ? messages.unfinishedChildren
    : error.code === 'task_parent_terminal' ? messages.parentTerminal
      : error.code === 'task_parent_immutable' ? messages.parentImmutable
        : error.code === 'invalid_transition' && error.taskIds !== undefined && error.taskIds.length > 0 ? messages.blockingClaim : null;
};
