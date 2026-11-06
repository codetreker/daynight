import { ApiError, assertResponsePrincipal, request, requestId, type TaskResponseAdmission } from './client';
import { jsonObjectSources } from './json-source';
import { parseServerError } from './parse';
import { array, count, id, malformed, nonemptyString, nullableId, record, status, string, timestamp } from './validation';
import type { TaskStatus } from './types';

export type TaskSearchFilters = { readonly status: TaskStatus | ''; readonly assignedTo: string };
export type TaskSearchItem = {
  readonly id: string; readonly projectId: string; readonly title: string; readonly status: TaskStatus;
  readonly assignedTo: string | null; readonly updatedAt: string;
  readonly context: { readonly taskId: string; readonly title: string } | null;
  readonly match: { readonly fields: readonly ('title' | 'description')[]; readonly descriptionSnippet: string | null };
};
export type TaskSearchPage = { readonly projectId: string; readonly total: number; readonly items: readonly TaskSearchItem[]; readonly nextCursor: string | null };
export type SearchSyntax = { readonly reason: string; readonly position: number; readonly length: number };
export type SearchContextLimit = { readonly nodeCount: number; readonly edgeCount: number; readonly maxNodes: number; readonly maxEdges: number };
export class TaskSearchError extends ApiError {
  constructor(status: number, code: string, requestId: string, readonly syntax?: SearchSyntax, readonly contextLimit?: SearchContextLimit) {
    super('server', status, code, requestId);
  }
}
const reasons = new Set(['empty_phrase', 'empty_query', 'expected_operand', 'field_group_not_supported', 'invalid_escape', 'missing_field_value', 'nesting_too_deep', 'query_too_large', 'too_many_terms', 'unclosed_group', 'unclosed_quote', 'unexpected_closing_group', 'unexpected_token', 'unknown_field']);
const text = (value: unknown, nonempty = false): string => {
  const result = nonempty ? nonemptyString(value) : string(value);
  if (!result.isWellFormed() || result.includes('\0')) return malformed();
  return result;
};
export const parseTaskSearchPage = (value: unknown, projectId: string, filters: TaskSearchFilters, userId: string, limit = 15): TaskSearchPage => {
  const data = record(value);
  if (id(data.projectId) !== projectId) return malformed();
  const total = count(data.total);
  const items = array(data.items, (value): TaskSearchItem => {
    const item = record(value), itemProject = id(item.projectId), itemStatus = status(item.status), assignedTo = nullableId(item.assignedTo);
    if (itemProject !== projectId || filters.status !== '' && itemStatus !== filters.status) return malformed();
    const assignment = filters.assignedTo === 'me' ? userId : filters.assignedTo === 'unassigned' ? null : filters.assignedTo === '' ? undefined : filters.assignedTo;
    if (assignment !== undefined && assignedTo !== assignment) return malformed();
    const rawContext = item.context === null ? null : record(item.context);
    const context = rawContext === null ? null : { taskId: id(rawContext.taskId), title: text(rawContext.title, true) };
    const rawMatch = record(item.match);
    const fields = array(rawMatch.fields, (field) => field === 'title' || field === 'description' ? field : malformed());
    if (fields.length > 2 || new Set(fields).size !== fields.length || fields.length === 2 && (fields[0] !== 'title' || fields[1] !== 'description')) return malformed();
    const descriptionSnippet = rawMatch.descriptionSnippet === null ? null : text(rawMatch.descriptionSnippet);
    if (descriptionSnippet !== null && (descriptionSnippet.length === 0 || Array.from(descriptionSnippet).length > 162) || fields.includes('description') !== (descriptionSnippet !== null)) return malformed();
    return { id: id(item.id), projectId: itemProject, title: text(item.title, true), status: itemStatus, assignedTo, updatedAt: timestamp(item.updatedAt), context, match: { fields, descriptionSnippet } };
  });
  if (items.length > limit || items.length > total || new Set(items.map(item => item.id)).size !== items.length) return malformed();
  const nextCursor = data.nextCursor === null ? null : text(data.nextCursor, true);
  if (nextCursor !== null && (items.length === 0 || items.length >= total)) return malformed();
  return { projectId, total, items, nextCursor };
};

const integerSource = (sources: ReadonlyMap<string, string>, name: string): void => { if (!/^(?:0|[1-9][0-9]*)$/.test(sources.get(name) ?? '')) malformed(); };
const searchError = (body: unknown, source: string, httpStatus: number, query: string): TaskSearchError => {
  const parsed = parseServerError(body);
  const expected: Readonly<Record<string, number>> = { invalid_input: 400, invalid_search_expression: 400, search_changed: 409, search_context_limit_exceeded: 400, search_timeout: 504 };
  if (expected[parsed.code] !== undefined && expected[parsed.code] !== httpStatus) return malformed();
  let syntax: SearchSyntax | undefined, contextLimit: SearchContextLimit | undefined;
  if (parsed.code === 'invalid_search_expression' || parsed.code === 'search_context_limit_exceeded') {
    const details = record(record(record(body).error).details);
    const sources = jsonObjectSources(jsonObjectSources(jsonObjectSources(source).get('error')!).get('details')!);
    const fields = parsed.code === 'invalid_search_expression' ? ['reason', 'position', 'length'] : ['nodeCount', 'edgeCount', 'maxNodes', 'maxEdges'];
    if (Object.keys(details).length !== fields.length || sources.size !== fields.length || fields.some(field => !Object.hasOwn(details, field))) return malformed();
    for (const field of fields.filter(field => field !== 'reason')) integerSource(sources, field);
    if (parsed.code === 'invalid_search_expression') {
      const reason = string(details.reason), position = count(details.position), length = count(details.length), size = Array.from(query).length;
      if (!reasons.has(reason) || position < 1 || position > size + 1 || position - 1 + length > size) return malformed();
      syntax = { reason, position, length };
    } else contextLimit = { nodeCount: count(details.nodeCount), edgeCount: count(details.edgeCount), maxNodes: count(details.maxNodes), maxEdges: count(details.maxEdges) };
  }
  return new TaskSearchError(httpStatus, parsed.code, parsed.requestId, syntax, contextLimit);
};

export const searchTasks = async (projectId: string, query: string, filters: TaskSearchFilters, cursor: string | null, signal: AbortSignal, admission: TaskResponseAdmission, correlation?: { readonly requestId: string; readonly onResponseId: (requestId: string) => void }): Promise<TaskSearchPage> => {
  const project = requestId(projectId), userId = requestId(admission.userId);
  if (!query.isWellFormed() || query.includes('\0') || filters.status !== '' && filters.status !== 'todo' && filters.status !== 'in_progress' && filters.status !== 'done') throw new ApiError('protocol');
  const assignedTo = filters.assignedTo === '' ? undefined : filters.assignedTo === 'me' || filters.assignedTo === 'unassigned' ? filters.assignedTo : requestId(filters.assignedTo);
  if (cursor !== null && (cursor.trim() === '' || !cursor.isWellFormed() || cursor.includes('\0'))) throw new ApiError('protocol');
  const response = await request(`/api/v1/projects/${project}/tasks/search`, signal, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(correlation === undefined ? {} : { 'X-Request-ID': correlation.requestId }) }, body: JSON.stringify({ query, ...(filters.status === '' ? {} : { status: filters.status }), ...(assignedTo === undefined ? {} : { assignedTo }), limit: 15, ...(cursor === null ? {} : { cursor }) }) });
  const responseId = response.headers.get('X-Request-ID');
  if (responseId !== null && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(responseId)) correlation?.onResponseId(responseId);
  assertResponsePrincipal(response, userId, admission.onPrincipalMismatch);
  let source: string, body: unknown;
  try {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('Content-Type') ?? '')) throw new Error('Invalid media type');
    source = await response.text(); body = JSON.parse(source); signal.throwIfAborted();
    if (!response.ok) throw searchError(body, source, response.status, query);
    if (response.status !== 200) return malformed();
    integerSource(jsonObjectSources(source), 'total');
    return parseTaskSearchPage(body, project, { ...filters, assignedTo: assignedTo ?? '' }, userId);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ApiError) throw error;
    throw new ApiError('protocol', response.status, 'protocol', null, undefined, error);
  }
};

export const searchSelectionRange = (query: string, syntax: SearchSyntax): { start: number; end: number } => {
  const chars = Array.from(query);
  return { start: chars.slice(0, syntax.position - 1).join('').length, end: chars.slice(0, syntax.position - 1 + syntax.length).join('').length };
};
