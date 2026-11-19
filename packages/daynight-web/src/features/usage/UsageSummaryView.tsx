import { createContext, useContext, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { usageMetricKeys, type UsageMetricKey, type UsageSummary } from '../../api/usage';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskUsage } from './useTaskUsage';
import './usage.css';

export const usageWords = (zh: boolean) => ({
  title: zh ? 'Token 用量' : 'Token usage', unknown: zh ? '未知' : 'Unknown', retry: zh ? '重试' : 'Retry', loading: zh ? '读取用量…' : 'Loading usage…',
  error: zh ? '用量暂不可用' : 'Usage unavailable', unsupported: zh ? '此服务不支持用量查询' : 'This service does not support usage',
  complete: zh ? '完整' : 'Complete', partial: zh ? '部分' : 'Partial', collecting: zh ? '采集中' : 'Collecting', unavailable: zh ? '不可用' : 'Unavailable',
  noData: zh ? '暂无计量记录；未知不代表零。' : 'No measurements; unknown does not mean zero.',
  updated: zh ? '最近计量' : 'Last measured', observed: zh ? '查询时间' : 'Observed', executions: zh ? '执行' : 'Executions', records: zh ? '来源记录' : 'Source records',
  metric: (key: UsageMetricKey | 'providerTotalTokens') => ({ inputTokens: zh ? '输入' : 'Input', outputTokens: zh ? '输出' : 'Output', cacheReadTokens: zh ? '缓存读取（输入子集）' : 'Cache read (input subset)', cacheWriteTokens: zh ? '缓存写入（输入子集）' : 'Cache write (input subset)', reasoningTokens: zh ? '推理（输出子集）' : 'Reasoning (output subset)', totalTokens: zh ? '合计' : 'Total', providerTotalTokens: zh ? 'Provider 原始合计' : 'Provider total' })[key],
});
const reasonLabels: Readonly<Record<string, readonly [string, string]>> = {
  historical_no_data: ['历史执行没有用量记录', 'No historical usage records'], registration_missing: ['执行尚未登记用量', 'Execution usage not registered'], provider_unsupported: ['Provider 不支持可靠计量', 'Provider does not support reliable measurement'], profile_unverified: ['Provider 版本尚未验证', 'Provider version not qualified'], native_recovery_gap: ['原生恢复记录存在缺口', 'Native recovery records are incomplete'], missing_final: ['缺少最终计量', 'Final measurement missing'], subagent_scope_unknown: ['子 Agent 用量范围未知', 'Subagent coverage unknown'], external_review_unobserved: ['无法观察外部 Review 用量', 'External review usage unobserved'], model_unknown: ['模型未知', 'Model unknown'], source_conflict: ['来源修订冲突', 'Source revision conflict'], inclusion_parent_missing: ['缺少已包含来源的父记录', 'Included source parent missing'], attribution_unknown: ['来源归属未知', 'Source attribution unknown'], local_capacity_exceeded: ['本地采集容量不足', 'Local collection capacity exceeded'], local_storage_failed: ['本地计量存储失败', 'Local measurement storage failed'], upload_expired: ['补报期限已过', 'Upload window expired'], permission_revoked: ['采集授权已撤销', 'Collection permission revoked'], collector_failed: ['用量采集失败', 'Usage collector failed'], scope_restricted: ['计量范围受限', 'Measurement scope restricted'], native_integer_unrepresentable: ['原生数值无法精确表示', 'Native integer cannot be represented exactly'], input_cache_semantics_unknown: ['输入与缓存的包含关系未知', 'Input and cache inclusion unknown'],
};
export const usageReasonLabel = (reason: string, locale: string | boolean): string => reasonLabels[reason]?.[locale === true || locale === 'zh-CN' ? 0 : 1] ?? reason;
export const usageCompletenessLabel = (value: string, zh: boolean): string => ({ complete: zh ? '完整' : 'Complete', partial: zh ? '部分' : 'Partial', collecting: zh ? '采集中' : 'Collecting', unavailable: zh ? '不可用' : 'Unavailable', unsupported: zh ? '不支持' : 'Unsupported', no_data: zh ? '无记录' : 'No data', unregistered: zh ? '未登记' : 'Unregistered' })[value] ?? (zh ? '未知' : 'Unknown');
export const formatUsageInteger = (value: string | null, locale: string): string => value === null ? (locale === 'zh-CN' ? '未知' : 'Unknown') : BigInt(value).toLocaleString(locale);
export const usageCompactReading = (summary: UsageSummary, locale: string) => {
  const zh = locale === 'zh-CN', m = usageWords(zh);
  const key = summary.metrics.totalTokens.known !== null ? 'totalTokens' : summary.metrics.outputTokens.known !== null ? 'outputTokens' : 'inputTokens';
  return { label: summary.metrics[key].known === null ? m.title : `${summary.completeness === 'complete' ? '' : zh ? '已知' : 'Known '}${m.metric(key)}`, value: formatUsageInteger(summary.metrics[key].known, locale), state: usageCompletenessLabel(summary.completeness, zh) };
};
export const UsageSummaryView = ({ summary, compact = false }: { readonly summary: UsageSummary; readonly compact?: boolean }) => {
  const { locale, format } = useI18n(), m = usageWords(locale === 'zh-CN');
  const status = usageCompletenessLabel(summary.completeness, locale === 'zh-CN');
  if (compact) {
    const reading = usageCompactReading(summary, locale);
    return <span className="usage-summary usage-summary-compact" title={`${m.title} · ${reading.state} · ${reading.label}: ${reading.value}`}>{reading.label}: <strong>{reading.value}</strong> · {reading.state}</span>;
  }
  return <div className="usage-summary">
    <span className="usage-completeness">{m.title} · {status}</span>
    <dl className="usage-metrics">{usageMetricKeys.map(key => <div key={key}><dt>{m.metric(key)}</dt><dd>{formatUsageInteger(summary.metrics[key].known, locale)}{summary.metrics[key].unknownRecords !== '0' && <small>{locale === 'zh-CN' ? `${summary.metrics[key].unknownRecords} 条来源未知` : `${summary.metrics[key].unknownRecords} unknown sources`}</small>}</dd></div>)}</dl>

      <p>{m.executions}: {formatUsageInteger(summary.coverage.completeExecutions, locale)} / {formatUsageInteger(summary.coverage.executions, locale)} {m.complete} · {m.records}: {formatUsageInteger(summary.measurementRecords, locale)}</p>
      <ul className="usage-coverage">{(['collecting', 'partial', 'unsupported', 'unavailable', 'unregistered'] as const).map(state => <li key={state}>{usageCompletenessLabel(state, locale === 'zh-CN')}: {formatUsageInteger(summary.coverage[`${state}Executions`], locale)}</li>)}</ul>
      {summary.measurementRecords === '0' && <p>{m.noData}</p>}
      <p>{m.updated}: {summary.lastMeasuredAt === null ? m.unknown : <time dateTime={summary.lastMeasuredAt}>{format.dateTime(summary.lastMeasuredAt)}</time>} · {m.observed}: <time dateTime={summary.observedAt}>{format.dateTime(summary.observedAt)}</time></p>
      {summary.reasonCodes.length > 0 && <ul className="usage-reasons">{summary.reasonCodes.map(reason => <li key={reason} title={reason}>{usageReasonLabel(reason, locale)}</li>)}</ul>}

  </div>;
};
const UsageProjectContext = createContext<string | null>(null);
export const UsageProjectProvider = ({ projectId, children }: { readonly projectId: string; readonly children: ReactNode }) => <UsageProjectContext value={projectId}>{children}</UsageProjectContext>;
const GraphUsageSummary = ({ projectId, taskId }: { readonly projectId: string; readonly taskId: string }) => {
  const { summary, error } = useTaskUsage(projectId, taskId), { locale } = useI18n(), zh = locale === 'zh-CN', m = usageWords(zh);
  const reading = summary === null ? null : usageCompactReading(summary, locale);
  const text = reading === null ? error === null ? m.title + '…' : m.error : `${reading.label}: ${reading.value} · ${reading.state}`;
  return <span className="task-node-usage" title={text}>
    {text}
  </span>;
};
export const TaskNodeUsageSummary = ({ taskId }: { readonly taskId: string }) => { const projectId = useContext(UsageProjectContext); return projectId === null ? null : <GraphUsageSummary projectId={projectId} taskId={taskId} />; };
export const UsageError = ({ error, retry }: { readonly error: unknown; readonly retry: () => void }) => {
  const { locale } = useI18n(), m = usageWords(locale === 'zh-CN');
  return <div className="usage-error" role="alert"><span>{error instanceof ApiError && error.code === 'usage_unsupported' ? m.unsupported : m.error}</span> <button type="button" className="button" onClick={retry}>{m.retry}</button></div>;
};
export const isUsageUnsupported = (error: unknown): boolean => error instanceof ApiError && error.code === 'usage_unsupported';

type TaskUsageSummaryProps = { readonly compact?: boolean; readonly href?: string; readonly onOpen?: (trigger: HTMLElement) => void; readonly hideUnsupported?: boolean };
export const TaskUsageSummaryContent = ({ state, compact = false, onOpen, href, hideUnsupported = false }: TaskUsageSummaryProps & { readonly state: ReturnType<typeof useTaskUsage> }) => {
  const { locale } = useI18n(), m = usageWords(locale === 'zh-CN');
  if (isUsageUnsupported(state.error)) return hideUnsupported ? null : <section className="task-usage-summary" aria-label={m.title}><span>{m.unsupported}</span></section>;
  const content = state.summary !== null ? <UsageSummaryView summary={state.summary} compact={compact} /> : <span>{state.pending ? m.loading : m.unknown}</span>;
  return <section className="task-usage-summary" aria-label={m.title} data-task-row-selectable>
    {href === undefined ? content : <a className="usage-summary-link" href={href} onClick={event => { if (onOpen !== undefined && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) { event.preventDefault(); onOpen(event.currentTarget); } }}>{content}</a>}
    {state.error !== null && <UsageError error={state.error} retry={state.retry} />}
  </section>;
};

export const TaskUsageSummary = ({ projectId, taskId, active = true, ...props }: TaskUsageSummaryProps & { readonly projectId: string; readonly taskId: string; readonly active?: boolean }) => {
  const state = useTaskUsage(projectId, taskId, active);
  return <TaskUsageSummaryContent state={state} {...props} />;
};
