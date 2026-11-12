import type { TaskDetail } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import type { TaskScope } from '../task-graph/scope';

export const GoalInformation = ({ detail, scope, graphError, onRefreshGraph }: {
  readonly detail: Pick<TaskDetail, 'createdAt' | 'updatedAt'>;
  readonly scope: TaskScope | null;
  readonly graphError?: unknown;
  readonly onRefreshGraph: () => void;
}) => {
  const { locale, messages, format } = useI18n();
  const zh = locale === 'zh-CN';
  return <aside className="goal-information" aria-label={zh ? 'Goal 信息' : 'Goal information'}>
    <section className="goal-information-section">
      <h3>{zh ? '常规信息' : 'General information'}</h3>
      <dl className="goal-information-dates">
        <div><dt>{zh ? '创建时间' : 'Created'}</dt><dd><time dateTime={detail.createdAt}>{format.dateTime(detail.createdAt)}</time></dd></div>
        <div><dt>{zh ? '修改时间' : 'Modified'}</dt><dd><time dateTime={detail.updatedAt}>{format.dateTime(detail.updatedAt)}</time></dd></div>
      </dl>
    </section>
    <section className="goal-information-section">
      <h3>{zh ? '任务统计' : 'Task statistics'}</h3>
      {scope !== null && <>
        <dl className="goal-information-counts">
          <div><dt>{zh ? '独立任务数' : 'Standalone tasks'}</dt><dd>{format.number(scope.standaloneIds.length)}</dd></div>
          <div><dt>{zh ? '任务链数' : 'Task chains'}</dt><dd>{format.number(scope.chains.length)}</dd></div>
          <div><dt>{zh ? '任务总数' : 'Total tasks'}</dt><dd>{format.number(scope.progress.total)}</dd></div>
        </dl>
        <p className="goal-information-progress">{messages.graph.progress(scope.progress)}</p>
        <div className="goal-information-track" aria-hidden="true"><i className="goal-information-done" style={{ width: `${scope.progress.total === 0 ? 0 : scope.progress.done / scope.progress.total * 100}%` }} /><i className="goal-information-cancelled" style={{ width: `${scope.progress.total === 0 ? 0 : scope.progress.cancelled / scope.progress.total * 100}%` }} /></div>
        <dl className="goal-information-counts goal-information-statuses">
          <div><dt>{zh ? '已完成' : 'Completed'}</dt><dd>{format.number(scope.progress.done)}</dd></div>
          <div><dt>{zh ? '已取消' : 'Cancelled'}</dt><dd>{format.number(scope.progress.cancelled)}</dd></div>
          <div><dt>{zh ? '未结束' : 'Unfinished'}</dt><dd>{format.number(scope.progress.unfinished)}</dd></div>
        </dl>
      </>}
      {scope === null && graphError == null && <p className="goal-information-loading" role="status">{messages.inspection.detail.loading}</p>}
      {graphError != null && <div className="goal-information-error" role="alert"><p>{messages.workspace.project.refreshFailed}</p><button className="button" type="button" onClick={onRefreshGraph}>{messages.workspace.project.retryRefresh}</button></div>}
    </section>
  </aside>;
};
