import { ApiError, assertResponsePrincipal, json, request, requestId } from './client';
import { jsonContainerSources, jsonObjectSources } from './json-source';
import { array, boolean, id, malformed, nullableTimestamp, record, string, timestamp } from './validation';
import type { WorkerReadAdmission } from './workers';

class AssistantTaskJsonNumber {
  constructor(readonly source: string) { Object.freeze(this); }
  toJSON(): never { throw new TypeError('Use stringifyAssistantTaskJson to preserve the JSON number.'); }
}
export type AssistantTaskJson = null | boolean | number | string | AssistantTaskJsonNumber | readonly AssistantTaskJson[] | { readonly [key: string]: AssistantTaskJson };
export type AssistantTaskTrigger = null | { readonly kind: 'interval'; readonly minutes: number } | { readonly kind: 'daily'; readonly time: string; readonly timeZone: string };
export type AssistantTaskClaim = {
  readonly holderBotId: string | null; readonly credentialOperationId: string | null;
  readonly claimGeneration: string; readonly claimState: 'unowned' | 'pending' | 'active' | 'expired';
  readonly claimedAt: string | null; readonly renewedAt: string | null; readonly leaseUntil: string | null; readonly observedAt: string;
};
export type AssistantTask = AssistantTaskClaim & {
  readonly id: string; readonly ownerUserId: string; readonly application: string; readonly name: string; readonly purpose: string; readonly scope: string;
  readonly kind: 'continuous' | 'once'; readonly state: 'active' | 'paused' | 'deleted'; readonly takeover: 'manual' | 'auto'; readonly trigger: AssistantTaskTrigger;
  readonly version: string; readonly manualVersion: string; readonly createdAt: string; readonly updatedAt: string;
};
export type AssistantTaskManual = { readonly taskId: string; readonly version: string; readonly body: string; readonly rules: AssistantTaskJson; readonly source: 'initial' | 'revision' | 'rollback'; readonly proposalId: string | null; readonly createdAt: string };
export type AssistantTaskAppendix = { readonly id: string; readonly taskId: string; readonly text: string; readonly sourceRecords: readonly string[]; readonly authorBotId: string | null; readonly state: 'active' | 'edited' | 'deleted'; readonly version: string; readonly createdAt: string; readonly updatedAt: string };
export type AssistantTaskProposal = { readonly id: string; readonly taskId: string; readonly baseVersion: string; readonly body: string; readonly rules: AssistantTaskJson; readonly reason: string; readonly evidenceRecords: readonly string[]; readonly authorBotId: string | null; readonly widens: boolean; readonly status: 'pending' | 'approved' | 'edited' | 'rejected'; readonly decisionNote: string; readonly createdAt: string; readonly decidedAt: string | null };
export type AssistantTaskItem = { readonly id: string; readonly taskId: string; readonly key: string; readonly episode: string; readonly state: 'open' | 'closed'; readonly category: string; readonly followerBotId: string | null; readonly appState: AssistantTaskJson; readonly version: string; readonly createdAt: string; readonly updatedAt: string };
export type AssistantTaskRecord = { readonly id: string; readonly taskId: string; readonly itemId: string | null; readonly author: 'bot' | 'system'; readonly authorBotId: string | null; readonly kind: 'fact' | 'guess' | 'action' | 'unknown' | 'question' | 'answer' | 'note'; readonly text: string; readonly refs: AssistantTaskJson; readonly createdAt: string };
const eventTypes = ['report', 'escalation', 'result_unknown', 'proposal_pending', 'inquiry_timed_out', 'takeover', 'claim_lost', 'update', 'resolved', 'direct_success', 'proposal_decided', 'appendix_added', 'inquiry', 'answer', 'transfer', 'intervention', 'trigger'] as const;
export type AssistantTaskEvent = { readonly id: string; readonly taskId: string; readonly targetBotId: string; readonly type: typeof eventTypes[number]; readonly payload: AssistantTaskJson; readonly state: 'pending' | 'delivered' | 'expired'; readonly attention: boolean; readonly createdAt: string; readonly deliveredAt: string | null; readonly seenAt: string | null; readonly ackOperationId: string | null };
export type AssistantTaskPage<T> = { readonly items: readonly T[]; readonly nextCursor: string | null; readonly observedAt: string };
export type AssistantTaskClaimOperation = { readonly operationId: string; readonly kind: 'claim' | 'bind' | 'renew' | 'transfer' | 'release'; readonly taskId: string; readonly actorBotId: string | null; readonly requestFingerprint: string; readonly admittedAt: string; readonly resultingVersion: string; readonly resultingGeneration: string; readonly holderBotId: string | null; readonly credentialOperationId: string | null; readonly leaseUntil: string | null };
export type AssistantTaskClaimResult = { readonly operation: AssistantTaskClaimOperation; readonly currentClaim: AssistantTaskClaim };
export type AssistantTaskAdmission = WorkerReadAdmission & { readonly onDispatch?: () => void };
export type AssistantTaskQuery = { readonly limit?: number; readonly cursor?: string; readonly state?: string; readonly itemId?: string; readonly targetBotId?: string };
export type CreateAssistantTaskInput = { readonly id: string; readonly name: string; readonly purpose: string; readonly scope: string; readonly kind: AssistantTask['kind']; readonly takeover: AssistantTask['takeover']; readonly application?: string; readonly trigger?: AssistantTaskTrigger; readonly manual: { readonly body: string; readonly rules?: AssistantTaskJson } };
export type UpdateAssistantTaskInput = { readonly ifVersion: string; readonly name?: string; readonly purpose?: string; readonly scope?: string; readonly takeover?: AssistantTask['takeover']; readonly trigger?: AssistantTaskTrigger; readonly state?: AssistantTask['state'] };
export type AssistantTaskTransferInput = { readonly operationId: string; readonly ifVersion: string; readonly expectedGeneration: string; readonly targetBotId: string };
export type AssistantTaskReleaseInput = Omit<AssistantTaskTransferInput, 'targetBotId'>;
export type AssistantTaskDecisionInput = { readonly ifVersion: string; readonly decision: 'approved' | 'edited' | 'rejected'; readonly note?: string; readonly body?: string; readonly rules?: AssistantTaskJson };

const fields = (value: unknown, required: readonly string[], optional: readonly string[] = []) => {
  const data = record(value);
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))) return malformed();
  return data;
};
const choice = <T extends string>(value: unknown, values: readonly T[]): T => typeof value === 'string' && values.includes(value as T) ? value as T : malformed();
const text = (value: unknown, required = false): string => { const result = string(value); return result.isWellFormed() && !result.includes('\0') && (!required || result.trim() !== '') ? result : malformed(); };
const uuid = (value: unknown): string => { const result = id(value); return result === value && result !== '00000000-0000-0000-0000-000000000000' ? result : malformed(); };
const nullableId = (value: unknown) => value === null ? null : uuid(value);
const decimal = (value: unknown, zero = false): string => { const result = string(value); return /^(0|[1-9][0-9]{0,18})$/.test(result) && (zero || result !== '0') && BigInt(result) <= 9_223_372_036_854_775_807n ? result : malformed(); };
const jsonValue = (value: unknown): AssistantTaskJson => {
  if (value instanceof AssistantTaskJsonNumber) return value;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? value : malformed();
  if (Array.isArray(value)) return value.map(jsonValue);
  return Object.fromEntries(Object.entries(record(value)).map(([key, entry]) => [key, jsonValue(entry)]));
};
/** Preserve application JSON numbers that cannot round-trip through a JavaScript number. */
export const parseAssistantTaskJson = (source: string): AssistantTaskJson => {
  const parsed: unknown = JSON.parse(source);
  const restore = (value: unknown, source: string): AssistantTaskJson => {
    if (typeof value === 'number') {
      const token = source.trim();
      return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) && JSON.stringify(value) === token ? value : new AssistantTaskJsonNumber(token);
    }
    if (Array.isArray(value)) {
      const sources = jsonContainerSources(source);
      return value.map((entry, index) => restore(entry, sources[index]!));
    }
    if (value !== null && typeof value === 'object') {
      const sources = jsonObjectSources(source);
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restore(entry, sources.get(key)!)]));
    }
    return jsonValue(value);
  };
  return restore(parsed, source);
};
/** Encode application JSON without changing numeric tokens, optionally indenting containers. */
export const stringifyAssistantTaskJson = (value: unknown, space = 0): string => {
  const gap = ' '.repeat(Math.min(10, Math.max(0, Math.trunc(space))));
  const encode = (value: AssistantTaskJson, indent: string): string => {
    if (value instanceof AssistantTaskJsonNumber) return value.source;
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    const next = indent + gap, isArray = Array.isArray(value);
    const members = isArray ? value.map(entry => encode(entry, next)) : Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}:${gap ? ' ' : ''}${encode(entry, next)}`);
    const [open, close] = isArray ? ['[', ']'] : ['{', '}'];
    return members.length === 0 ? `${open}${close}` : gap ? `${open}\n${next}${members.join(`,\n${next}`)}\n${indent}${close}` : `${open}${members.join(',')}${close}`;
  };
  return encode(jsonValue(value), '');
};
const decodeAssistantTaskJson = async (response: Response): Promise<unknown> => {
  const source = await response.text(), parsed: unknown = JSON.parse(source);
  const restore = (value: unknown, source: string): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const data = record(value), sources = jsonObjectSources(source);
    // Only application-owned JSON fields use numeric tokens; protocol fields keep their strict types.
    for (const key of ['rules', 'appState', 'refs', 'payload']) if (Object.hasOwn(data, key)) data[key] = parseAssistantTaskJson(sources.get(key)!);
    if (Array.isArray(data.items)) {
      const items = jsonContainerSources(sources.get('items')!);
      data.items = data.items.map((entry, index) => restore(entry, items[index]!));
    }
    return data;
  };
  return restore(parsed, source);
};
const trigger = (value: unknown): AssistantTaskTrigger => {
  if (value === null) return null;
  const data = record(value);
  if (data.kind === 'interval') {
    fields(data, ['kind', 'minutes']);
    if (typeof data.minutes !== 'number' || !Number.isSafeInteger(data.minutes) || data.minutes < 1) return malformed();
    return { kind: 'interval', minutes: data.minutes };
  }
  fields(data, ['kind', 'time', 'timeZone']);
  if (data.kind !== 'daily') return malformed();
  const time = text(data.time), timeZone = text(data.timeZone, true);
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(time) || timeZone === 'Local') return malformed();
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { return malformed(); }
  return { kind: 'daily', time, timeZone };
};
const claimFields = ['holderBotId', 'credentialOperationId', 'claimGeneration', 'claimState', 'claimedAt', 'renewedAt', 'leaseUntil', 'observedAt'] as const;
const claim = (data: Record<string, unknown>): AssistantTaskClaim => {
  const result = { holderBotId: nullableId(data.holderBotId), credentialOperationId: nullableId(data.credentialOperationId), claimGeneration: decimal(data.claimGeneration, true), claimState: choice(data.claimState, ['unowned', 'pending', 'active', 'expired']), claimedAt: nullableTimestamp(data.claimedAt), renewedAt: nullableTimestamp(data.renewedAt), leaseUntil: nullableTimestamp(data.leaseUntil), observedAt: timestamp(data.observedAt) };
  if (result.claimState === 'unowned') {
    if (result.holderBotId !== null || result.credentialOperationId !== null || result.claimedAt !== null || result.renewedAt !== null || result.leaseUntil !== null) return malformed();
  } else {
    if (result.holderBotId === null || result.claimGeneration === '0' || result.claimedAt === null || result.leaseUntil === null) return malformed();
    if (result.claimState === 'pending' && (result.credentialOperationId !== null || result.renewedAt !== null)) return malformed();
    if (result.claimState === 'active' && result.credentialOperationId === null) return malformed();
  }
  return result;
};
export const parseAssistantTask = (value: unknown, userId: string, expectedId?: string): AssistantTask => {
  const data = fields(value, [...claimFields, 'id', 'ownerUserId', 'application', 'name', 'purpose', 'scope', 'kind', 'state', 'takeover', 'trigger', 'version', 'manualVersion', 'createdAt', 'updatedAt']);
  const state = choice(data.state, ['active', 'paused', 'deleted']);
  const result = { ...claim(data), id: uuid(data.id), ownerUserId: uuid(data.ownerUserId), application: text(data.application), name: text(data.name, state !== 'deleted'), purpose: text(data.purpose), scope: text(data.scope), kind: choice(data.kind, ['continuous', 'once']), state, takeover: choice(data.takeover, ['manual', 'auto']), trigger: trigger(data.trigger), version: decimal(data.version), manualVersion: decimal(data.manualVersion, state === 'deleted'), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
  if (result.ownerUserId !== requestId(userId) || expectedId !== undefined && result.id !== requestId(expectedId)) return malformed();
  if (state === 'deleted' && (result.manualVersion !== '0' || result.claimState !== 'unowned' || result.name !== '' || result.purpose !== '' || result.scope !== '' || result.trigger !== null)) return malformed();
  return result;
};
const taskIdentity = (data: Record<string, unknown>, taskId: string) => { const result = uuid(data.taskId); return result === requestId(taskId) ? result : malformed(); };
const entryIdentity = (data: Record<string, unknown>, taskId: string) => ({ id: uuid(data.id), taskId: taskIdentity(data, taskId) });
export const parseAssistantTaskManual = (value: unknown, taskId: string): AssistantTaskManual => {
  const data = fields(value, ['taskId', 'version', 'body', 'rules', 'source', 'proposalId', 'createdAt']);
  const result = { taskId: taskIdentity(data, taskId), version: decimal(data.version), body: text(data.body, true), rules: jsonValue(data.rules), source: choice(data.source, ['initial', 'revision', 'rollback']), proposalId: nullableId(data.proposalId), createdAt: timestamp(data.createdAt) };
  if ((result.source === 'revision') !== (result.proposalId !== null)) return malformed();
  return result;
};
export const parseAssistantTaskAppendix = (value: unknown, taskId: string): AssistantTaskAppendix => {
  const data = fields(value, ['id', 'taskId', 'text', 'sourceRecords', 'authorBotId', 'state', 'version', 'createdAt', 'updatedAt']);
  const state = choice(data.state, ['active', 'edited', 'deleted']);
  const result = { ...entryIdentity(data, taskId), text: text(data.text, state !== 'deleted'), sourceRecords: array(data.sourceRecords, uuid), authorBotId: nullableId(data.authorBotId), state, version: decimal(data.version), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
  if (state === 'deleted' && (result.text !== '' || result.sourceRecords.length !== 0)) return malformed();
  return result;
};
export const parseAssistantTaskProposal = (value: unknown, taskId: string): AssistantTaskProposal => {
  const data = fields(value, ['id', 'taskId', 'baseVersion', 'body', 'rules', 'reason', 'evidenceRecords', 'authorBotId', 'widens', 'status', 'decisionNote', 'createdAt', 'decidedAt']);
  const result = { ...entryIdentity(data, taskId), baseVersion: decimal(data.baseVersion), body: text(data.body, true), rules: jsonValue(data.rules), reason: text(data.reason, true), evidenceRecords: array(data.evidenceRecords, uuid), authorBotId: nullableId(data.authorBotId), widens: boolean(data.widens), status: choice(data.status, ['pending', 'approved', 'edited', 'rejected']), decisionNote: text(data.decisionNote), createdAt: timestamp(data.createdAt), decidedAt: nullableTimestamp(data.decidedAt) };
  if ((result.status === 'pending') !== (result.decidedAt === null)) return malformed();
  return result;
};
export const parseAssistantTaskItem = (value: unknown, taskId: string): AssistantTaskItem => {
  const data = fields(value, ['id', 'taskId', 'key', 'episode', 'state', 'category', 'followerBotId', 'appState', 'version', 'createdAt', 'updatedAt']);
  return { ...entryIdentity(data, taskId), key: text(data.key, true), episode: decimal(data.episode), state: choice(data.state, ['open', 'closed']), category: text(data.category), followerBotId: nullableId(data.followerBotId), appState: jsonValue(data.appState), version: decimal(data.version), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
};
export const parseAssistantTaskRecord = (value: unknown, taskId: string): AssistantTaskRecord => {
  const data = fields(value, ['id', 'taskId', 'itemId', 'author', 'authorBotId', 'kind', 'text', 'refs', 'createdAt']);
  const result = { ...entryIdentity(data, taskId), itemId: nullableId(data.itemId), author: choice(data.author, ['bot', 'system']), authorBotId: nullableId(data.authorBotId), kind: choice(data.kind, ['fact', 'guess', 'action', 'unknown', 'question', 'answer', 'note']), text: text(data.text, true), refs: jsonValue(data.refs), createdAt: timestamp(data.createdAt) };
  if ((result.author === 'bot') !== (result.authorBotId !== null)) return malformed();
  return result;
};
export const parseAssistantTaskEvent = (value: unknown, taskId?: string): AssistantTaskEvent => {
  const data = fields(value, ['id', 'taskId', 'targetBotId', 'type', 'payload', 'state', 'attention', 'createdAt', 'deliveredAt', 'seenAt', 'ackOperationId']);
  return { id: uuid(data.id), taskId: taskId === undefined ? uuid(data.taskId) : taskIdentity(data, taskId), targetBotId: uuid(data.targetBotId), type: choice(data.type, eventTypes), payload: jsonValue(data.payload), state: choice(data.state, ['pending', 'delivered', 'expired']), attention: boolean(data.attention), createdAt: timestamp(data.createdAt), deliveredAt: nullableTimestamp(data.deliveredAt), seenAt: nullableTimestamp(data.seenAt), ackOperationId: nullableId(data.ackOperationId) };
};
export const parseAssistantTaskClaimResult = (value: unknown, taskId: string, operationId: string): AssistantTaskClaimResult => {
  const data = fields(value, ['operation', 'currentClaim']);
  const op = fields(data.operation, ['operationId', 'kind', 'taskId', 'actorBotId', 'requestFingerprint', 'admittedAt', 'resultingVersion', 'resultingGeneration', 'holderBotId', 'credentialOperationId', 'leaseUntil']);
  const operation = { operationId: uuid(op.operationId), kind: choice(op.kind, ['claim', 'bind', 'renew', 'transfer', 'release']), taskId: taskIdentity(op, taskId), actorBotId: nullableId(op.actorBotId), requestFingerprint: text(op.requestFingerprint), admittedAt: timestamp(op.admittedAt), resultingVersion: decimal(op.resultingVersion), resultingGeneration: decimal(op.resultingGeneration), holderBotId: nullableId(op.holderBotId), credentialOperationId: nullableId(op.credentialOperationId), leaseUntil: nullableTimestamp(op.leaseUntil) };
  if (operation.operationId !== requestId(operationId) || !/^[a-f0-9]{64}$/.test(operation.requestFingerprint)) return malformed();
  if (operation.kind === 'release' && (operation.holderBotId !== null || operation.credentialOperationId !== null || operation.leaseUntil !== null)) return malformed();
  if (operation.kind === 'transfer' && (operation.holderBotId === null || operation.credentialOperationId !== null || operation.leaseUntil === null)) return malformed();
  if (['claim', 'bind', 'renew'].includes(operation.kind) && (operation.actorBotId === null || operation.actorBotId !== operation.holderBotId || operation.credentialOperationId === null || operation.leaseUntil === null)) return malformed();
  if (['claim', 'bind'].includes(operation.kind) && operation.credentialOperationId !== operation.operationId) return malformed();
  const currentClaim = claim(fields(data.currentClaim, claimFields));
  if (BigInt(currentClaim.claimGeneration) < BigInt(operation.resultingGeneration)) return malformed();
  return { operation, currentClaim };
};

const input = <T>(parse: () => T): T => { try { return parse(); } catch { throw new ApiError('protocol'); } };
const target = (value: string) => input(() => uuid(requestId(value)));
const base = '/api/v1/assistant-tasks';
const path = (taskId: string) => `${base}/${target(taskId)}`;
const cursor = (value: unknown) => text(value, true);
const queryString = (query: AssistantTaskQuery, allowed: readonly string[], states: readonly string[] = []) => input(() => {
  fields(query, [], ['limit', 'cursor', ...allowed]);
  const result = new URLSearchParams();
  if (query.limit !== undefined) { if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200) return malformed(); result.set('limit', String(query.limit)); }
  if (query.cursor !== undefined) result.set('cursor', cursor(query.cursor));
  if (query.state !== undefined) result.set('state', choice(query.state, states));
  if (query.itemId !== undefined) result.set('itemId', target(query.itemId));
  if (query.targetBotId !== undefined) result.set('targetBotId', target(query.targetBotId));
  return result.size === 0 ? '' : `?${result}`;
});
async function read<T>(url: string, signal: AbortSignal, admission: AssistantTaskAdmission, parse: (value: unknown) => T): Promise<T> {
  const user = target(admission.userId);
  const response = await request(url, signal, { headers: { Accept: 'application/json' } }, admission.onDispatch);
  assertResponsePrincipal(response, user, admission.onPrincipalMismatch);
  return json(response, signal, value => { if (response.status !== 200) throw new ApiError('protocol', response.status); return parse(value); }, decodeAssistantTaskJson);
}
const page = <T>(value: unknown, parse: (value: unknown) => T, key: (entry: T) => string, query: AssistantTaskQuery): AssistantTaskPage<T> => {
  const data = fields(value, ['items', 'nextCursor', 'observedAt']), items = array(data.items, parse);
  if (items.length > (query.limit ?? 50) || new Set(items.map(key)).size !== items.length) return malformed();
  const nextCursor = data.nextCursor === null ? null : cursor(data.nextCursor);
  if (nextCursor !== null && (items.length === 0 || nextCursor === query.cursor)) return malformed();
  return { items, nextCursor, observedAt: timestamp(data.observedAt) };
};
export const getAssistantTask = (taskId: string, signal: AbortSignal, admission: AssistantTaskAdmission) => read(path(taskId), signal, admission, value => parseAssistantTask(value, admission.userId, taskId));
export const listAssistantTasks = (query: AssistantTaskQuery, signal: AbortSignal, admission: AssistantTaskAdmission) => read(`${base}${queryString(query, ['state', 'targetBotId'], ['active', 'paused'])}`, signal, admission, value => page(value, value => {
  const task = parseAssistantTask(value, admission.userId);
  if (task.state === 'deleted' || query.state !== undefined && task.state !== query.state || query.targetBotId !== undefined && task.holderBotId !== target(query.targetBotId)) return malformed();
  return task;
}, task => task.id, query));
export const getAssistantTaskManual = (taskId: string, signal: AbortSignal, admission: AssistantTaskAdmission, version?: string) => read(`${path(taskId)}/manual${version === undefined ? '' : `/versions/${input(() => decimal(version))}`}`, signal, admission, value => {
  const manual = parseAssistantTaskManual(value, taskId); if (version !== undefined && manual.version !== version) return malformed(); return manual;
});
export const getAssistantTaskClaimOperation = (taskId: string, operationId: string, signal: AbortSignal, admission: AssistantTaskAdmission) => read(`${path(taskId)}/claim-operations/${target(operationId)}`, signal, admission, value => parseAssistantTaskClaimResult(value, taskId, operationId));
const listResource = <T>(taskId: string, resource: string, query: AssistantTaskQuery, signal: AbortSignal, admission: AssistantTaskAdmission, parser: (value: unknown, taskId: string) => T, key: (item: T) => string, states: readonly string[] = [], allowed: readonly string[] = states.length ? ['state'] : []) => read(`${path(taskId)}/${resource}${queryString(query, allowed, states)}`, signal, admission, value => page(value, value => {
  const parsed = parser(value, taskId), data = record(parsed);
  if (query.state !== undefined && data[resource === 'proposals' ? 'status' : 'state'] !== query.state || query.itemId !== undefined && data.itemId !== target(query.itemId)) return malformed();
  return parsed;
}, key, query));
export const listAssistantTaskManuals = (taskId: string, query: AssistantTaskQuery, signal: AbortSignal, admission: AssistantTaskAdmission) => listResource(taskId, 'manual/versions', query, signal, admission, parseAssistantTaskManual, item => item.version);
export const listAssistantTaskAppendices = (taskId: string, query: AssistantTaskQuery, signal: AbortSignal, admission: AssistantTaskAdmission) => listResource(taskId, 'appendix', query, signal, admission, parseAssistantTaskAppendix, item => item.id, ['active', 'edited', 'deleted']);
export const listAssistantTaskProposals = (taskId: string, query: AssistantTaskQuery, signal: AbortSignal, admission: AssistantTaskAdmission) => listResource(taskId, 'proposals', query, signal, admission, parseAssistantTaskProposal, item => item.id, ['pending', 'approved', 'edited', 'rejected']);
export const listAssistantTaskItems = (taskId: string, query: AssistantTaskQuery, signal: AbortSignal, admission: AssistantTaskAdmission) => listResource(taskId, 'items', query, signal, admission, parseAssistantTaskItem, item => item.id, ['open', 'closed']);
export const listAssistantTaskRecords = (taskId: string, query: AssistantTaskQuery, signal: AbortSignal, admission: AssistantTaskAdmission) => listResource(taskId, 'records', query, signal, admission, parseAssistantTaskRecord, item => item.id, [], ['itemId']);
export const listAssistantTaskEvents = (query: AssistantTaskQuery & { readonly taskId?: string }, signal: AbortSignal, admission: AssistantTaskAdmission) => {
  const { taskId, ...filters } = query;
  return read(`${taskId === undefined ? '/api/v1/assistant-task-events' : `${path(taskId)}/events`}${queryString(filters, ['state', 'targetBotId'], ['pending', 'delivered', 'expired'])}`, signal, admission, value => page(value, value => {
    const event = parseAssistantTaskEvent(value, taskId);
    if (filters.targetBotId !== undefined && event.targetBotId !== target(filters.targetBotId) || filters.state !== undefined && event.state !== filters.state) return malformed();
    return event;
  }, item => item.id, filters));
};

export class AssistantTaskWriteUnknown extends Error {
  readonly operationId: string | null;
  constructor(readonly taskId: string, readonly method: string, readonly path: string, readonly input: Readonly<Record<string, unknown>>, cause: unknown) {
    super('The assistant task write outcome is unknown. Observe the original resource before deciding another write.', { cause });
    this.name = 'AssistantTaskWriteUnknown'; this.operationId = typeof input.operationId === 'string' ? input.operationId : null;
  }
}
async function write<T>(taskId: string, suffix: string, method: string, body: Record<string, unknown>, signal: AbortSignal, admission: AssistantTaskAdmission, parse: (value: unknown) => T): Promise<T> {
  const expected = target(admission.userId), task = target(taskId), url = suffix === 'create' ? base : suffix === 'watchdog' ? '/api/v1/assistant-task-presets/watchdog' : `${path(task)}${suffix}`;
  const encoded = stringifyAssistantTaskJson(body), original = Object.freeze(record(parseAssistantTaskJson(encoded)));
  let dispatched = false;
  try {
    const response = await request(url, signal, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: encoded }, () => { dispatched = true; admission.onDispatch?.(); });
    // An older server may reject an unregistered preset route before its
    // authenticated JSON adapter runs; this is a refusal, not a lost receipt.
    if (suffix === 'watchdog' && (response.status === 404 || response.status === 405)) throw new ApiError('server', response.status, 'preset_unavailable');
    assertResponsePrincipal(response, expected, admission.onPrincipalMismatch);
    return await json(response, signal, value => { if (response.status !== 200) throw new ApiError('protocol', response.status); return parse(value); }, decodeAssistantTaskJson);
  } catch (error) {
    if (dispatched && !(error instanceof ApiError && error.kind === 'server' && error.status !== null && error.status >= 400 && error.status < 500)) throw new AssistantTaskWriteUnknown(task, method, url, original, error);
    throw error;
  }
}
export async function createAssistantTask(value: CreateAssistantTaskInput, signal: AbortSignal, admission: AssistantTaskAdmission): Promise<AssistantTask> {
  const body = input(() => {
    fields(value, ['id', 'name', 'purpose', 'scope', 'kind', 'takeover', 'manual'], ['application', 'trigger']); fields(value.manual, ['body'], ['rules']);
    return { id: target(value.id), name: text(value.name, true), purpose: text(value.purpose), scope: text(value.scope), kind: choice(value.kind, ['continuous', 'once']), takeover: choice(value.takeover, ['manual', 'auto']), application: text(value.application ?? ''), trigger: trigger(value.trigger ?? null), manual: { body: text(value.manual.body, true), ...(value.manual.rules === undefined ? {} : { rules: value.manual.rules === null ? malformed() : jsonValue(value.manual.rules) }) } };
  });
  return write(body.id, 'create', 'POST', body, signal, admission, result => {
    const task = parseAssistantTask(result, admission.userId, body.id);
    if (task.application !== body.application || task.name !== body.name || task.purpose !== body.purpose || task.scope !== body.scope || task.kind !== body.kind || task.takeover !== body.takeover || task.state === 'deleted') return malformed();
    return task;
  });
}
/** Preset creation preserves the account's existing Watchdog identity when one exists. */
export async function enableWatchdog(value: { readonly id: string; readonly targetBotId: string }, signal: AbortSignal, admission: AssistantTaskAdmission): Promise<AssistantTask> {
  const body = input(() => { fields(value, ['id', 'targetBotId']); return { id: target(value.id), targetBotId: target(value.targetBotId) }; });
  return write(body.id, 'watchdog', 'POST', body, signal, admission, result => {
    const task = parseAssistantTask(result, admission.userId);
    if (task.application !== 'watchdog' || task.state !== 'active' || task.holderBotId !== body.targetBotId) return malformed();
    return task;
  });
}
export async function updateAssistantTask(taskId: string, value: UpdateAssistantTaskInput, signal: AbortSignal, admission: AssistantTaskAdmission): Promise<AssistantTask> {
  const body = input(() => {
    fields(value, ['ifVersion'], ['name', 'purpose', 'scope', 'takeover', 'trigger', 'state']);
    if (Object.keys(value).length < 2) return malformed();
    return { ifVersion: decimal(value.ifVersion), ...(value.name === undefined ? {} : { name: text(value.name, true) }), ...(value.purpose === undefined ? {} : { purpose: text(value.purpose) }), ...(value.scope === undefined ? {} : { scope: text(value.scope) }), ...(value.takeover === undefined ? {} : { takeover: choice(value.takeover, ['manual', 'auto']) }), ...(value.trigger === undefined ? {} : { trigger: trigger(value.trigger) }), ...(value.state === undefined ? {} : { state: choice(value.state, ['active', 'paused', 'deleted']) }) };
  });
  return write(taskId, '', 'PATCH', body, signal, admission, result => {
    const task = parseAssistantTask(result, admission.userId, taskId);
    if (task.version !== body.ifVersion && BigInt(task.version) !== BigInt(body.ifVersion) + 1n || body.state !== undefined && task.state !== body.state || body.name !== undefined && task.state !== 'deleted' && task.name !== body.name || body.purpose !== undefined && task.state !== 'deleted' && task.purpose !== body.purpose || body.scope !== undefined && task.state !== 'deleted' && task.scope !== body.scope || body.takeover !== undefined && task.takeover !== body.takeover) return malformed();
    return task;
  });
}
export async function deleteAssistantTask(taskId: string, ifVersion: string, signal: AbortSignal, admission: AssistantTaskAdmission): Promise<AssistantTask> {
  const body = input(() => ({ ifVersion: decimal(ifVersion) }));
  return write(taskId, '', 'DELETE', body, signal, admission, result => { const task = parseAssistantTask(result, admission.userId, taskId); if (task.state !== 'deleted' || BigInt(task.version) <= BigInt(body.ifVersion)) return malformed(); return task; });
}
async function humanClaim(taskId: string, kind: 'transfer' | 'release', value: AssistantTaskReleaseInput | AssistantTaskTransferInput, signal: AbortSignal, admission: AssistantTaskAdmission): Promise<AssistantTaskClaimResult> {
  const body = input(() => {
    fields(value, ['operationId', 'ifVersion', 'expectedGeneration', ...(kind === 'transfer' ? ['targetBotId'] : [])]);
    return { operationId: target(value.operationId), ifVersion: decimal(value.ifVersion), expectedGeneration: decimal(value.expectedGeneration, kind === 'transfer'), ...(kind === 'transfer' ? { targetBotId: target((value as AssistantTaskTransferInput).targetBotId) } : {}) };
  });
  return write(taskId, `/${kind}`, 'POST', body, signal, admission, result => {
    const parsed = parseAssistantTaskClaimResult(result, taskId, body.operationId), op = parsed.operation;
    if (op.kind !== kind || op.actorBotId !== null || BigInt(op.resultingVersion) !== BigInt(body.ifVersion) + 1n || BigInt(op.resultingGeneration) !== BigInt(body.expectedGeneration) + 1n || kind === 'transfer' && op.holderBotId !== body.targetBotId) return malformed();
    return parsed;
  });
}
export const transferAssistantTask = (taskId: string, value: AssistantTaskTransferInput, signal: AbortSignal, admission: AssistantTaskAdmission) => humanClaim(taskId, 'transfer', value, signal, admission);
export const releaseAssistantTask = (taskId: string, value: AssistantTaskReleaseInput, signal: AbortSignal, admission: AssistantTaskAdmission) => humanClaim(taskId, 'release', value, signal, admission);
export async function updateAssistantTaskAppendix(taskId: string, appendixId: string, value: { readonly ifVersion: string; readonly text: string; readonly sourceRecords?: readonly string[] }, signal: AbortSignal, admission: AssistantTaskAdmission): Promise<AssistantTaskAppendix> {
  const entry = target(appendixId), body = input(() => { fields(value, ['ifVersion', 'text'], ['sourceRecords']); return { ifVersion: decimal(value.ifVersion), text: text(value.text, true), ...(value.sourceRecords === undefined ? {} : { sourceRecords: array(value.sourceRecords, entry => target(string(entry))) }) }; });
  return write(taskId, `/appendix/${entry}`, 'PATCH', body, signal, admission, result => { const appendix = parseAssistantTaskAppendix(result, taskId); if (appendix.id !== entry || appendix.state !== 'edited' || appendix.text !== body.text || body.sourceRecords !== undefined && JSON.stringify(appendix.sourceRecords) !== JSON.stringify(body.sourceRecords)) return malformed(); return appendix; });
}
export async function deleteAssistantTaskAppendix(taskId: string, appendixId: string, ifVersion: string, signal: AbortSignal, admission: AssistantTaskAdmission): Promise<AssistantTaskAppendix> {
  const entry = target(appendixId), body = input(() => ({ ifVersion: decimal(ifVersion) }));
  return write(taskId, `/appendix/${entry}`, 'DELETE', body, signal, admission, result => { const appendix = parseAssistantTaskAppendix(result, taskId); if (appendix.id !== entry || appendix.state !== 'deleted') return malformed(); return appendix; });
}
export async function decideAssistantTaskProposal(taskId: string, proposalId: string, value: AssistantTaskDecisionInput, signal: AbortSignal, admission: AssistantTaskAdmission): Promise<AssistantTaskProposal> {
  const entry = target(proposalId), body = input(() => {
    fields(value, ['ifVersion', 'decision'], ['note', 'body', 'rules']);
    const decision = choice(value.decision, ['approved', 'edited', 'rejected']);
    if (decision !== 'edited' && (value.body !== undefined || value.rules !== undefined)) return malformed();
    return { ifVersion: decimal(value.ifVersion), decision, note: text(value.note ?? ''), ...(value.body === undefined ? {} : { body: text(value.body, true) }), ...(value.rules === undefined ? {} : { rules: value.rules === null ? malformed() : jsonValue(value.rules) }) };
  });
  return write(taskId, `/proposals/${entry}/decision`, 'POST', body, signal, admission, result => { const proposal = parseAssistantTaskProposal(result, taskId); if (proposal.id !== entry || proposal.status !== body.decision || proposal.decisionNote !== body.note || body.body !== undefined && proposal.body !== body.body) return malformed(); return proposal; });
}
export async function rollbackAssistantTaskManual(taskId: string, value: { readonly ifVersion: string; readonly manualVersion: string }, signal: AbortSignal, admission: AssistantTaskAdmission): Promise<AssistantTaskManual> {
  const body = input(() => { fields(value, ['ifVersion', 'manualVersion']); return { ifVersion: decimal(value.ifVersion), manualVersion: decimal(value.manualVersion) }; });
  return write(taskId, '/manual/rollback', 'POST', body, signal, admission, result => { const manual = parseAssistantTaskManual(result, taskId); if (manual.source !== 'rollback' || BigInt(manual.version) <= BigInt(body.manualVersion)) return malformed(); return manual; });
}
