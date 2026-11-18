import { useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { getTaskUsageRecords, usageMetricKeys, type UsageRecordQuery, type UsageRecordsPage } from '../../api/usage';
import { useI18n } from '../../i18n/LocaleProvider';
import { NativeSelect } from '../../ui/native-select/NativeSelect';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { formatUsageInteger, TaskUsageSummary, UsageError, usageWords, usageReasonLabel, usageCompletenessLabel } from './UsageSummaryView';

export const TaskUsagePanel = ({ projectId, taskId, active }: { readonly projectId: string; readonly taskId: string; readonly active: boolean }) => {
  const { locale, format } = useI18n(), zh = locale === 'zh-CN', m = usageWords(zh), scope = useTaskCacheScope();
  const [query, setQuery] = useState<UsageRecordQuery>({ kind: 'execution_state' });
  const [draft, setDraft] = useState({ model: '', provider: '', stateId: '' });
  const [page, setPage] = useState<UsageRecordsPage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const loaded = useRef<string | null>(null);
  const queryKey = JSON.stringify([projectId, taskId, query]);
  useEffect(() => {
    if (!active || loaded.current === queryKey) return;
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, scope.signal, scope.mismatchSignal]);
    setPending(true); setError(null);
    void scope.ready(signal).then(() => getTaskUsageRecords(projectId, taskId, query, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch })).then(result => {
      signal.throwIfAborted();
      loaded.current = queryKey; setPage(result); setPending(false);
    }).catch(error => {
      if (isAbortError(error)) return;
      setPending(false); setError(error);
      if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) setPage(null);
    });
    return () => controller.abort();
  }, [scope, projectId, taskId, query, queryKey, active, revision]);
  const retry = () => { loaded.current = null; setRevision(value => value + 1); };
  const changeQuery = (next: UsageRecordQuery) => { loaded.current = null; setQuery(next); setRevision(value => value + 1); };
  const resetRequired = error instanceof ApiError && ['reset_required', 'cursor_expired', 'usage_changed'].includes(error.code);
  return <section className="usage-panel" aria-label={m.title}>
    <TaskUsageSummary projectId={projectId} taskId={taskId} active={active} />
    <form className="usage-filters" onSubmit={event => { event.preventDefault(); changeQuery({ kind: query.kind ?? 'execution_state', ...Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== '')) }); }}>
      <label>{zh ? '查看' : 'View'}<NativeSelect value={query.kind ?? 'execution_state'} onChange={event => changeQuery({ kind: event.target.value as 'execution_state' | 'measurement' })}><option value="execution_state">{m.executions}</option><option value="measurement">{m.records}</option></NativeSelect></label>
      {(['provider', 'model', 'stateId'] as const).map(key => <label key={key}>{key === 'provider' ? 'Provider' : key === 'model' ? zh ? '模型' : 'Model' : zh ? '执行 State ID' : 'Execution State ID'}<input value={draft[key]} onChange={event => setDraft(value => ({ ...value, [key]: event.target.value }))} /></label>)}
      <button type="submit" className="button" disabled={pending}>{zh ? '筛选' : 'Filter'}</button>
      <button type="button" className="button" disabled={pending} onClick={() => { loaded.current = null; if (query.cursor !== undefined) changeQuery({ kind: query.kind ?? 'execution_state' }); else retry(); }}>{zh ? '刷新' : 'Refresh'}</button>
    </form>
    {error !== null && (resetRequired ? <div role="alert"><p>{zh ? '用量记录已变化，请从第一页重新读取。' : 'Usage records changed. Read again from the first page.'}</p><button className="button" type="button" onClick={() => { const { cursor: _, ...first } = query; changeQuery(first); }}>{m.retry}</button></div> : <UsageError error={error} retry={retry} />)}
    {pending && <p role="status">{page === null ? m.loading : zh ? '正在读取；下方保留上次页面。' : 'Reading; the previous page remains below.'}</p>}
    {page !== null && <>
      {page.items.length === 0 && <p>{m.noData}</p>}
      <ul className="usage-records">{page.items.map(item => <li className="usage-record" key={item.id}>
        <h4>{item.provider} · {item.model ?? m.unknown}</h4>
        <p>{m.executions}: <code>{item.sessionId}</code> · {zh ? '代次' : 'Generation'} {item.executionGeneration}</p>
        {item.recordKind === 'execution_state' ? <>
          <p>{zh ? '收集状态' : 'Collection'}: {usageCompletenessLabel(item.effectiveCollectionState ?? item.collectionState ?? '', zh)}</p>
          <button type="button" className="button" onClick={() => changeQuery({ kind: 'measurement', stateId: item.id })}>{zh ? '查看本次执行来源' : 'View execution sources'}</button>
        </> : <>
          <p>{zh ? '来源' : 'Source'}: <code>{item.sourceKey}</code> · {item.aggregationRole} · {item.finality} · {item.disposition}</p>
          <dl className="usage-metrics">{[...usageMetricKeys, 'providerTotalTokens'] .map(key => <div key={key}><dt>{m.metric(key as typeof usageMetricKeys[number] | 'providerTotalTokens')}</dt><dd>{formatUsageInteger(item.metrics[key as keyof typeof item.metrics], locale)}</dd></div>)}</dl>
        </>}
        {item.reasonCodes.length > 0 && <ul className="usage-reasons">{item.reasonCodes.map(reason => <li key={reason} title={reason}>{usageReasonLabel(reason, locale)}</li>)}</ul>}
        <p>{zh ? '更新' : 'Updated'}: <time dateTime={item.updatedAt}>{format.dateTime(item.updatedAt)}</time></p>
        <details><summary>{zh ? '计量身份' : 'Measurement identity'}</summary><p>{zh ? '记录' : 'Record'}: <code>{item.id}</code></p><p>Profile: {item.profileId} · {item.providerVersion}</p></details>
      </li>)}</ul>
      <div className="usage-filters"><button className="button" type="button" disabled={pending || query.cursor === undefined} onClick={() => { const { cursor: _, ...first } = query; changeQuery(first); }}>{zh ? '第一页' : 'First page'}</button><button className="button" type="button" disabled={pending || resetRequired || page.nextCursor === null} onClick={() => { if (page.nextCursor !== null) changeQuery({ ...query, cursor: page.nextCursor }); }}>{zh ? '下一页' : 'Next page'}</button></div>
    </>}
  </section>;
};
