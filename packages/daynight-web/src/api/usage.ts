import { ApiError, assertResponsePrincipal, json, request, requestId, waitForAuthRequests, type TaskResponseAdmission } from './client';
import { array, id, malformed, nonemptyString, record, string, timestamp } from './validation';

export const usageMetricKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'] as const;
export type UsageMetricKey = typeof usageMetricKeys[number];
export type UsageMetrics = Readonly<Record<UsageMetricKey, string | null>> & { readonly providerTotalTokens: string | null };
export type UsageSummary = {
  readonly metrics: Readonly<Record<UsageMetricKey, { readonly known: string | null; readonly contributingRecords: string; readonly unknownRecords: string }>>;
  readonly scope: string; readonly completeness: string; readonly reasonCodes: readonly string[];
  readonly coverage: Readonly<Record<'executions' | 'supportedExecutions' | 'collectingExecutions' | 'completeExecutions' | 'partialExecutions' | 'unsupportedExecutions' | 'unavailableExecutions' | 'unregisteredExecutions', string>>;
  readonly measurementRecords: string; readonly lastMeasuredAt: string | null; readonly observedAt: string; readonly etag: string;
};
export type UsageRecord = {
  readonly id: string; readonly recordKind: 'execution_state' | 'measurement'; readonly sessionId: string; readonly stateId: string | null;
  readonly executionGeneration: string; readonly provider: string; readonly model: string | null; readonly sourceKey: string | null;
  readonly profileId: string; readonly providerVersion: string; readonly aggregationRole: string | null; readonly finality: string | null;
  readonly disposition: string | null; readonly collectionState: string | null; readonly effectiveCollectionState: string | null;
  readonly metrics: UsageMetrics; readonly reasonCodes: readonly string[]; readonly observedAt: string; readonly updatedAt: string;
};
export const usageDecimal = (value: unknown): string => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? value : malformed();
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null || value === undefined ? null : parse(value);
const reasons = (value: unknown): readonly string[] => array(value, nonemptyString);
export const parseUsageSummary = (value: unknown): UsageSummary => {
  const data = record(value), metrics = record(data.metrics), coverage = record(data.coverage);
  const parsedMetrics = Object.fromEntries(usageMetricKeys.map(key => {
    const item = record(metrics[key]);
    return [key, { known: item.known === null ? null : usageDecimal(item.known), contributingRecords: usageDecimal(item.contributingRecords), unknownRecords: usageDecimal(item.unknownRecords) }];
  })) as UsageSummary['metrics'];
  const coverageKeys = ['executions', 'supportedExecutions', 'collectingExecutions', 'completeExecutions', 'partialExecutions', 'unsupportedExecutions', 'unavailableExecutions', 'unregisteredExecutions'] as const;
  return { metrics: parsedMetrics, coverage: Object.fromEntries(coverageKeys.map(key => [key, usageDecimal(coverage[key])])) as UsageSummary['coverage'], scope: string(data.scope), completeness: nonemptyString(data.completeness), reasonCodes: reasons(data.reasonCodes), measurementRecords: usageDecimal(data.measurementRecords), lastMeasuredAt: nullable(data.lastMeasuredAt, timestamp), observedAt: timestamp(data.observedAt), etag: nonemptyString(data.etag) };
};
export const parseUsageRecord = (value: unknown): UsageRecord => {
  const data = record(value), metrics = record(data.metrics);
  if (data.recordKind !== 'execution_state' && data.recordKind !== 'measurement') return malformed();
  return { id: id(data.id), recordKind: data.recordKind, sessionId: id(data.sessionId), stateId: nullable(data.stateId, id), executionGeneration: usageDecimal(data.executionGeneration), provider: nonemptyString(data.provider), model: nullable(data.model, string), sourceKey: nullable(data.sourceKey, string), profileId: nonemptyString(data.profileId), providerVersion: nonemptyString(data.providerVersion), aggregationRole: nullable(data.aggregationRole, string), finality: nullable(data.finality, string), disposition: nullable(data.disposition, string), collectionState: nullable(data.collectionState, string), effectiveCollectionState: nullable(data.effectiveCollectionState, string), metrics: Object.fromEntries([...usageMetricKeys, 'providerTotalTokens'].map(key => [key, nullable(metrics[key], usageDecimal)])) as UsageMetrics, reasonCodes: reasons(data.reasonCodes), observedAt: timestamp(data.observedAt), updatedAt: timestamp(data.updatedAt) };
};
const root = (project: string) => `/api/projects/${requestId(project)}`;
// Usage v1's fault envelope omits the message required by the older API codec.
export const usageReadJson = <T>(response: Response, signal: AbortSignal, parse: (value: unknown) => T): Promise<T> => json(response, signal, parse, async value => {
  const data = record(JSON.parse(await value.text()));
  if (!value.ok) { const error = record(data.error); return { ...data, error: { ...error, message: error.message ?? '' } }; }
  return data;
});
const read = async <T>(url: string, signal: AbortSignal, admission: TaskResponseAdmission, parse: (value: unknown) => T, init: RequestInit = {}): Promise<T> => {
  await waitForAuthRequests(signal);
  signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const response = await request(url, signal, { headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, ...init });
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  return usageReadJson(response, signal, value => response.status === 200 ? parse(value) : malformed());
};
export const getUsageCapabilities = async (signal: AbortSignal, admission: TaskResponseAdmission): Promise<void> => {
  await waitForAuthRequests(signal);
  signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const response = await request('/api/usage/v1/capabilities', signal, { headers: { Accept: 'application/json' } });
  if (response.status === 404 || response.status === 501) throw new ApiError('server', response.status, 'usage_unsupported');
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  await usageReadJson(response, signal, value => { const data = record(value); if (data.protocol !== 'daynight.usage.v1') return malformed(); });
};
export const getTaskUsageSummary = (projectId: string, taskId: string, signal: AbortSignal, admission: TaskResponseAdmission): Promise<UsageSummary> => read(`${root(projectId)}/tasks/${requestId(taskId)}/usage/v1/summary`, signal, admission, parseUsageSummary);
export const getTaskUsageSummaries = (projectId: string, taskIds: readonly string[], signal: AbortSignal, admission: TaskResponseAdmission): Promise<readonly { readonly taskId: string; readonly summary: UsageSummary }[]> => {
  const ids = taskIds.map(requestId);
  if (ids.length === 0 || ids.length > 100 || new Set(ids).size !== ids.length) throw new ApiError('protocol');
  return read(`${root(projectId)}/usage/v1/task-summaries`, signal, admission, value => {
    const data = record(value), items = array(data.items, value => { const item = record(value); return { taskId: id(item.taskId), summary: parseUsageSummary(item.summary) }; });
    if (items.length !== ids.length || items.some((item, index) => item.taskId !== ids[index])) return malformed();
    return items;
  }, { method: 'POST', body: JSON.stringify({ taskIds: ids }) });
};
export type UsageRecordQuery = { readonly kind?: 'execution_state' | 'measurement'; readonly model?: string; readonly provider?: string; readonly stateId?: string; readonly cursor?: string };
export type UsageRecordsPage = { readonly items: readonly UsageRecord[]; readonly nextCursor: string | null; readonly snapshotToken: string; readonly observedAt: string };
export const getTaskUsageRecords = (projectId: string, taskId: string, query: UsageRecordQuery, signal: AbortSignal, admission: TaskResponseAdmission): Promise<UsageRecordsPage> => {
  const parameters = new URLSearchParams({ limit: '50' });
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') parameters.set(key, value);
  return read(`${root(projectId)}/tasks/${requestId(taskId)}/usage/v1/records?${parameters}`, signal, admission, value => {
    const data = record(value), items = array(data.items, parseUsageRecord), nextCursor = nullable(data.nextCursor, nonemptyString);
    if (items.length > 50 || new Set(items.map(item => item.id)).size !== items.length || nextCursor !== null && items.length === 0) return malformed();
    return { items, nextCursor, snapshotToken: nonemptyString(data.snapshotToken), observedAt: timestamp(data.observedAt) };
  });
};
