import { ApiError, assertResponsePrincipal, json, request, requestId } from '../../api/client';
import { array, boolean, id, malformed, nonemptyString, record, string, timestamp } from '../../api/parse';
import { parseConfigurationRevision } from '../../api/worker-configuration';
import type { PullRequestAdmission, PullRequestDetail } from '../pull-request-detail/api';

export type PullRequestState = 'active' | 'merged' | 'closed' | 'all';
export type PullRequestSummary = Omit<PullRequestDetail, 'description'>;
export type PullRequestPage = {
  readonly projectId: string; readonly revision: string; readonly items: readonly PullRequestSummary[];
  readonly total: string; readonly counts: Readonly<Record<PullRequestState, string>>;
  readonly authorId: string | null; readonly projectTotal: string;
  readonly nextCursor: string | null; readonly previousCursor: string | null;
};
export type PullRequestAuthor = { readonly id: string; readonly login: string; readonly loginAmbiguous: boolean };
export type PullRequestAuthorsPage = {
  readonly projectId: string; readonly revision: string; readonly items: readonly PullRequestAuthor[];
  readonly nextCursor: string | null;
};
type SyncError = { readonly code: string; readonly message: string; readonly at: string | null };
export type GitHubStatus = {
  readonly projectId: string; readonly version: string; readonly revision: string; readonly serviceAvailable: boolean; readonly syncEnabled: boolean;
  readonly connection: 'not_connected' | 'connected' | 'unavailable' | 'disconnected';
  readonly repository: { readonly id: string; readonly fullName: string; readonly private: boolean | null } | null;
  readonly installation: { readonly id: string; readonly accountLogin: string } | null;
  readonly pollIntervalMinutes: number; readonly initializing: boolean;
  readonly poll: { readonly running: boolean; readonly lastAttemptAt: string | null; readonly lastSuccessAt: string | null; readonly nextAttemptAt: string | null; readonly error: SyncError | null };
  readonly webhook: { readonly running: boolean; readonly lastReceivedAt: string | null; readonly lastAttemptAt: string | null; readonly lastSuccessAt: string | null; readonly error: SyncError | null };
};

const decimal = (value: unknown) => parseConfigurationRevision(value);
const count = (value: unknown) => parseConfigurationRevision(value, true);
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);
const choice = <T extends string>(value: unknown, choices: readonly T[]): T => typeof value === 'string' && choices.includes(value as T) ? value as T : malformed();
const syncError = (value: unknown): SyncError => { const data = record(value); return { code: string(data.code), message: string(data.message), at: nullable(data.at, timestamp) }; };

export const parsePullRequestSummary = (value: unknown): PullRequestSummary => {
  const data = record(value), base = record(data.base), head = record(data.head);
  return {
    number: decimal(data.number), id: decimal(data.id), url: string(data.url), title: string(data.title),
    author: nullable(data.author, value => { const author = record(value); return { id: decimal(author.id), login: string(author.login) }; }),
    state: string(data.state), draft: boolean(data.draft),
    base: { repositoryId: decimal(base.repositoryId), repositoryFullName: string(base.repositoryFullName), ref: string(base.ref) },
    head: { repositoryId: nullable(head.repositoryId, decimal), repositoryFullName: nullable(head.repositoryFullName, string), ref: nullable(head.ref, string), sha: string(head.sha) },
    createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt), closedAt: nullable(data.closedAt, timestamp), mergedAt: nullable(data.mergedAt, timestamp),
    observedAt: timestamp(data.observedAt), revision: count(data.revision),
  };
};

export const parsePullRequestPage = (value: unknown, projectId: string, authorId: string | null = null): PullRequestPage => {
  const data = record(value), project = id(data.projectId), counts = record(data.counts), items = array(data.items, parsePullRequestSummary);
  if (project !== requestId(projectId) || items.length > 6 || new Set(items.map(item => item.number)).size !== items.length || items.some((item, index) => index > 0 && BigInt(items[index - 1]!.number) <= BigInt(item.number))) return malformed();
  const all = count(counts.all);
  if (authorId !== null && (decimal(data.authorId) !== decimal(authorId) || items.some(item => item.author?.id !== authorId))) return malformed();
  return { projectId: project, revision: count(data.revision), items, total: count(data.total),
    counts: { active: count(counts.active), merged: count(counts.merged), closed: count(counts.closed), all },
    authorId, projectTotal: authorId === null ? all : count(data.projectTotal),
    nextCursor: nullable(data.nextCursor, nonemptyString), previousCursor: nullable(data.previousCursor, nonemptyString) };
};

// PostgreSQL's C collation compares UTF-8 bytes and lowercases ASCII only.
export const comparePullRequestAuthors = (a: PullRequestAuthor, b: PullRequestAuthor): number => {
  const key = (login: string) => new TextEncoder().encode(login.replace(/[A-Z]/g, letter => letter.toLowerCase()));
  const left = key(a.login), right = key(b.login);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  if (left.length !== right.length) return left.length - right.length;
  return BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
};

export const parsePullRequestAuthorsPage = (value: unknown, projectId: string): PullRequestAuthorsPage => {
  const data = record(value), project = id(data.projectId);
  const items = array(data.items, value => {
    const author = record(value), login = string(author.login);
    if (!login.isWellFormed() || login.includes('\0')) return malformed();
    return { id: decimal(author.id), login, loginAmbiguous: boolean(author.loginAmbiguous) };
  });
  const nextCursor = nullable(data.nextCursor, nonemptyString);
  if (project !== requestId(projectId) || items.length > 50 || new Set(items.map(item => item.id)).size !== items.length ||
      items.some((item, index) => index > 0 && comparePullRequestAuthors(items[index - 1]!, item) >= 0) ||
      items.length === 0 && nextCursor !== null) return malformed();
  return { projectId: project, revision: count(data.revision), items, nextCursor };
};

export const parseGitHubStatus = (value: unknown, projectId: string): GitHubStatus => {
  const data = record(value), project = id(data.projectId), poll = record(data.poll), webhook = record(data.webhook), interval = data.pollIntervalMinutes;
  if (project !== requestId(projectId) || typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1 || interval > 2_147_483_647) return malformed();
  return { projectId: project, version: decimal(data.version), revision: count(data.revision), serviceAvailable: boolean(data.serviceAvailable), syncEnabled: boolean(data.syncEnabled),
    connection: choice(data.connection, ['not_connected', 'connected', 'unavailable', 'disconnected']),
    repository: nullable(data.repository, value => { const item = record(value); return { id: decimal(item.id), fullName: string(item.fullName), private: nullable(item.private, boolean) }; }),
    installation: nullable(data.installation, value => { const item = record(value); return { id: decimal(item.id), accountLogin: string(item.accountLogin) }; }),
    pollIntervalMinutes: interval, initializing: boolean(data.initializing),
    poll: { running: boolean(poll.running), lastAttemptAt: nullable(poll.lastAttemptAt, timestamp), lastSuccessAt: nullable(poll.lastSuccessAt, timestamp), nextAttemptAt: nullable(poll.nextAttemptAt, timestamp), error: nullable(poll.error, syncError) },
    webhook: { running: boolean(webhook.running), lastReceivedAt: nullable(webhook.lastReceivedAt, timestamp), lastAttemptAt: nullable(webhook.lastAttemptAt, timestamp), lastSuccessAt: nullable(webhook.lastSuccessAt, timestamp), error: nullable(webhook.error, syncError) },
  };
};

const read = async <T>(url: string, signal: AbortSignal, admission: PullRequestAdmission, parse: (value: unknown) => T): Promise<T> => {
  const userId = requestId(admission.userId);
  const response = await request(url, signal, { headers: { Accept: 'application/json' } }, admission.onDispatch);
  assertResponsePrincipal(response, userId, admission.onPrincipalMismatch);
  return json(response, signal, value => { if (response.status !== 200) throw new ApiError('protocol', response.status); return parse(value); });
};

export const getGitHubStatus = (projectId: string, signal: AbortSignal, admission: PullRequestAdmission): Promise<GitHubStatus> =>
  read(`/api/v1/projects/${requestId(projectId)}/github`, signal, admission, value => parseGitHubStatus(value, projectId));

const validQuery = (q: string, cursor: string | null) => q.isWellFormed() && !q.includes('\0') && new TextEncoder().encode(q).length <= 1024 && cursor !== '';

export const getPullRequests = (projectId: string, query: { readonly state: PullRequestState; readonly q: string; readonly cursor: string | null; readonly authorId?: string | null }, signal: AbortSignal, admission: PullRequestAdmission): Promise<PullRequestPage> => {
  const project = requestId(projectId);
  if (!['active', 'merged', 'closed', 'all'].includes(query.state) || !validQuery(query.q, query.cursor)) throw new ApiError('protocol');
  const authorId = query.authorId == null ? null : decimal(query.authorId);
  const params = new URLSearchParams({ state: query.state, q: query.q, limit: '6' });
  if (query.cursor !== null) params.set('cursor', query.cursor);
  if (authorId !== null) params.set('authorId', authorId);
  return read(`/api/v1/projects/${project}/pull-requests?${params}`, signal, admission, value => parsePullRequestPage(value, project, authorId));
};

export const getPullRequestAuthors = (projectId: string, query: { readonly q: string; readonly cursor: string | null }, signal: AbortSignal, admission: PullRequestAdmission): Promise<PullRequestAuthorsPage> => {
  const project = requestId(projectId);
  if (!validQuery(query.q, query.cursor)) throw new ApiError('protocol');
  const params = new URLSearchParams({ q: query.q, limit: '50' });
  if (query.cursor !== null) params.set('cursor', query.cursor);
  return read(`/api/v1/projects/${project}/pull-request-authors?${params}`, signal, admission, value => parsePullRequestAuthorsPage(value, project));
};
