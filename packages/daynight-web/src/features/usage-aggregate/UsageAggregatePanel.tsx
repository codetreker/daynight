import { useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { getUsageAggregate, type UsageAggregate, type UsageAggregateScope } from '../../api/usage-aggregate';
import { getUsageCapabilities } from '../../api/usage';
import { useOptionalAccountSession } from '../../app/AccountSessionProvider';
import { useI18n } from '../../i18n/LocaleProvider';
import { UsageSummaryView, usageReasonLabel } from '../usage/UsageSummaryView';
import './usage-aggregate.css';

type Props = {
  readonly projectId: string;
  readonly scope: UsageAggregateScope;
  readonly scopeId: string;
  readonly active?: boolean;
  readonly onOpenTask: (taskId: string, trigger: HTMLElement) => void;
};

const stateLabel = (state: string, zh: boolean): string => ({
  complete: zh ? '完整' : 'Complete', collecting: zh ? '采集中' : 'Collecting', partial: zh ? '部分' : 'Partial',
  unsupported: zh ? '不支持' : 'Unsupported', unavailable: zh ? '不可用' : 'Unavailable', no_data: zh ? '无数据' : 'No data',
})[state] ?? state;

const errorLabel = (error: unknown, zh: boolean): string => {
  if (error instanceof ApiError) {
    if (error.code === 'usage_unsupported') return zh ? '此服务不支持用量查询。' : 'This service does not support usage queries.';
    if (error.status === 401 || error.status === 403) return zh ? '没有权限读取此范围的用量。' : 'You do not have permission to read usage for this scope.';
    if (error.status === 404) return zh ? '此用量范围已不可用。' : 'This usage scope is no longer available.';
    if (error.code === 'aggregate_scope_too_large') return zh ? '此范围超过 10,000 个任务，无法汇总。' : 'This scope exceeds the 10,000-task aggregation limit.';
    if (error.code === 'reset_required' || error.code === 'cursor_expired') return zh ? '成员或用量已更改，请刷新后继续。' : 'Membership or usage changed. Refresh before continuing.';
  }
  return zh ? '无法读取汇总用量，请重试。' : 'Unable to load aggregate usage. Try again.';
};

const AggregateContent = ({ projectId, scope, scopeId, active = true, onOpenTask }: Props) => {
  const { locale, format } = useI18n();
  const zh = locale === 'zh-CN';
  const account = useOptionalAccountSession();
  const userId = account?.session.status === 'authenticated' ? account.session.user.id : null;
  const requireRefresh = account?.requireAccountRefresh;
  const [data, setData] = useState<UsageAggregate | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [started, setStarted] = useState(active);
  useEffect(() => { if (active) setStarted(true); }, [active]);
  const latest = useRef(data);
  latest.current = data;
  useEffect(() => {
    if (!started || userId === null) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const admission = { userId, onPrincipalMismatch: () => { requireRefresh?.('principal_mismatch'); } };
    void getUsageCapabilities(controller.signal, admission).then(() => getUsageAggregate(projectId, scope, scopeId, cursor, controller.signal, admission)).then(result => {
      if (controller.signal.aborted) return;
      const previous = latest.current;
      if (cursor !== null && previous !== null) {
        // A page is valid only for the same membership and usage snapshot.
        if (previous.membershipRevision !== result.membershipRevision || previous.summary.etag !== result.summary.etag ||
          result.missingMembers.some(member => previous.missingMembers.some(loaded => loaded.taskId === member.taskId))) {
          throw new ApiError('server', 409, 'reset_required');
        }
        setData({ ...result, missingMembers: [...previous.missingMembers, ...result.missingMembers] });
      } else setData(result);
    }).catch(cause => {
      if (controller.signal.aborted || isAbortError(cause)) return;
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403 || cause.status === 404)) setData(null);
      setError(cause);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId, scope, scopeId, started, cursor, attempt, userId, requireRefresh]);
  const refresh = () => { setCursor(null); setAttempt(value => value + 1); };
  const reset = error instanceof ApiError && ['reset_required', 'cursor_expired'].includes(error.code);
  return <section className="usage-aggregate" aria-label={zh ? 'Token 用量汇总' : 'Token usage aggregate'} aria-busy={loading}>
    <div className="usage-aggregate-heading"><h3>{zh ? 'Token 用量汇总' : 'Token usage aggregate'}</h3><button className="button secondary" type="button" disabled={loading} onClick={refresh}>{loading ? (zh ? '正在读取…' : 'Loading…') : (zh ? '刷新用量' : 'Refresh usage')}</button></div>
    <p className="usage-aggregate-policy">{zh ? '当前成员 · 不含已删除任务。' : 'Current members · deleted tasks excluded. '}{scope === 'goal' ? (zh ? '仅包含 Goal 当前的直接普通子任务；每个任务计量一次。' : 'Current direct ordinary child tasks only; each task is counted once.') : (zh ? '包含普通依赖双向连接的当前任务；共享节点和重复路径仅计量一次。' : 'Current tasks connected by ordinary dependencies in either direction; shared tasks and repeated paths are counted once.')}</p>
    {data !== null && <>
      <UsageSummaryView summary={data.summary} />
      <dl className="usage-aggregate-counts">
        <div><dt>{zh ? '任务总数' : 'Total tasks'}</dt><dd>{data.members.total}</dd></div>
        <div><dt>{zh ? '有已知用量' : 'With known usage'}</dt><dd>{data.members.withKnownUsage}</dd></div>
        <div><dt>{zh ? '用量未知' : 'Unknown usage'}</dt><dd>{(BigInt(data.members.total) - BigInt(data.members.withKnownUsage)).toString()}</dd></div>
        {(['complete', 'collecting', 'partial', 'unsupported', 'unavailable', 'noData'] as const).map(key => <div key={key}><dt>{stateLabel(key === 'noData' ? 'no_data' : key, zh)}</dt><dd>{data.members[key]}</dd></div>)}
      </dl>
      <p className="usage-aggregate-observed">{zh ? '查询时间：' : 'Observed: '}<time dateTime={data.observedAt}>{format.dateTime(data.observedAt)}</time></p>
      {data.members.total === '0' ? <p>{zh ? '当前范围没有任务。' : 'There are no tasks in the current scope.'}</p> : <>
        <h4>{zh ? '用量未完整的任务' : 'Tasks with incomplete usage'}</h4>
        {data.missingMembers.length === 0 ? <p>{zh ? '所有成员用量均完整。' : 'All members have complete usage.'}</p> : <ul className="usage-aggregate-members">{data.missingMembers.map(member => <li key={member.taskId}>
          <button type="button" className="usage-aggregate-member" onClick={event => onOpenTask(member.taskId, event.currentTarget)}>{member.title || member.taskId}</button>
          <span>{stateLabel(member.completeness, zh)}</span>
          {member.reasonCodes.length > 0 && <span className="usage-aggregate-reasons">{member.reasonCodes.map(reason => usageReasonLabel(reason, locale)).join(', ')}</span>}
        </li>)}</ul>}
        {data.nextMembersCursor !== null && <button className="button secondary" type="button" disabled={loading || reset} onClick={() => { setCursor(data.nextMembersCursor); setAttempt(value => value + 1); }}>{zh ? '加载更多未完整任务' : 'Load more incomplete tasks'}</button>}
      </>}
    </>}
    {error !== null && <div role="alert" className="usage-aggregate-error"><p>{errorLabel(error, zh)}</p><button className="button" type="button" disabled={loading} onClick={refresh}>{zh ? '重试' : 'Retry'}</button></div>}
    {data === null && error === null && loading && <p role="status">{zh ? '正在读取用量…' : 'Loading usage…'}</p>}
  </section>;
};

export const UsageAggregatePanel = (props: Props) => {
  const account = useOptionalAccountSession();
  const identity = account?.session.status === 'authenticated' ? `${account.session.user.id}/${account.session.generation}` : 'anonymous';
  return <AggregateContent key={`${identity}/${props.projectId}/${props.scope}/${props.scopeId}`} {...props} />;
};

export const UsageAggregateDisclosure = (props: Omit<Props, 'active'>) => {
  const { locale } = useI18n();
  const [opened, setOpened] = useState(false);
  return <details className="usage-aggregate-disclosure" onToggle={event => { if (event.currentTarget.open) setOpened(true); }}>
    <summary>{locale === 'zh-CN' ? 'Token 用量' : 'Token usage'}</summary>
    {opened && <UsageAggregatePanel {...props} />}
  </details>;
};
