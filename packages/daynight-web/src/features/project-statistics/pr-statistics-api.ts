import { ApiError, assertResponsePrincipal, json, request, requestId } from '../../api/client';
import { array, boolean, id, malformed, record, string } from '../../api/parse';
import { parseConfigurationRevision } from '../../api/worker-configuration';
import type { PullRequestAdmission } from '../pull-request-detail/api';
import { parseRepository } from '../pull-requests/api';

export type PRStatistics = {
  readonly projectId: string; readonly endDate: string; readonly revision: string;
  readonly projectTotal: string; readonly availability: 'ready' | 'not_connected' | 'initializing' | 'no_saved_data';
  readonly hasAuthors: boolean; readonly daily: readonly string[]; readonly authorId: string | null;
  readonly author: { readonly id: string; readonly login: string } | null; readonly authorDaily: readonly string[] | null;
};

const count = (value: unknown) => parseConfigurationRevision(value, true);
const positive = (value: unknown) => parseConfigurationRevision(value);
const series = (value: unknown): readonly string[] => {
  const result = array(value, count);
  if (result.length !== 30) return malformed();
  return result;
};

// Validate the full segment shape before sending a browser-derived interval.
export const validateStatisticsWindow = (endDate: string, window: string): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new ApiError('protocol');
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(end) || new Date(end).toISOString().slice(0, 10) !== endDate || endDate < '0001-01-30') throw new ApiError('protocol');
  const first = end - 29 * 86_400_000, parts = window.split(',');
  if (parts.length < 2 || parts.length > 64) throw new ApiError('protocol');
  let previous = -Infinity, previousIndex: string | null = null, hasDay = false;
  const segments = parts.map(part => {
    const match = /^(\-|0|[1-9]|[12][0-9])@(-?(?:0|[1-9][0-9]*))$/.exec(part);
    if (!match || match[2] === '-0') throw new ApiError('protocol');
    const index = match[1]!, value = Number(match[2]);
    if (!Number.isSafeInteger(value) || value <= previous || index === previousIndex || value < first - 86_400_000 || value > end + 2 * 86_400_000) throw new ApiError('protocol');
    previous = value; previousIndex = index; hasDay ||= index !== '-';
    return { index, value };
  });
  if (!hasDay || segments.at(-1)?.index !== '-') throw new ApiError('protocol');
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    if (segment.index === '-') continue;
    const day = first + Number(segment.index) * 86_400_000;
    if (segment.value < day - 86_400_000 || segments[i + 1]!.value > day + 2 * 86_400_000) throw new ApiError('protocol');
  }
};

export const parsePRStatistics = (value: unknown, projectId: string, endDate: string, authorId: string | null, repositoryId: string | null = null): PRStatistics => {
  const data = record(value), project = id(data.projectId), daily = series(data.daily);
  if (repositoryId !== null) parseRepository(data.repository, repositoryId);
  const availability = data.availability;
  if (project !== requestId(projectId) || data.endDate !== endDate ||
      (availability !== 'ready' && availability !== 'not_connected' && availability !== 'initializing' && availability !== 'no_saved_data')) return malformed();
  const total = count(data.projectTotal), hasAuthors = boolean(data.hasAuthors);
  const responseAuthorId = data.authorId === null ? null : positive(data.authorId);
  const author = data.author === null ? null : (() => {
    const source = record(data.author), login = string(source.login);
    if (!login.isWellFormed() || login.includes('\0')) return malformed();
    return { id: positive(source.id), login };
  })();
  const authorDaily = data.authorDaily === null ? null : series(data.authorDaily);
  if (responseAuthorId !== authorId || (authorId === null ? author !== null || authorDaily !== null : authorDaily === null || author !== null && author.id !== authorId) ||
      authorDaily?.some((n, i) => BigInt(n) > BigInt(daily[i]!)) ||
      authorId !== null && author === null && authorDaily?.some(n => n !== '0')) return malformed();
  return { projectId: project, endDate, revision: count(data.revision), projectTotal: total, availability, hasAuthors, daily, authorId: responseAuthorId, author, authorDaily };
};

export const getPRStatistics = async (projectId: string, endDate: string, window: string, authorId: string | null, signal: AbortSignal, admission: PullRequestAdmission, repositoryId: string | null = null): Promise<PRStatistics> => {
  const project = requestId(projectId);
  validateStatisticsWindow(endDate, window);
  if (authorId !== null) positive(authorId);
  const query = new URLSearchParams({ endDate, window });
  if (authorId !== null) query.set('authorId', authorId);
  if (repositoryId !== null) query.set('repositoryId', positive(repositoryId));
  const response = await request(`/api/v1/projects/${project}/pull-request-statistics?${query}`, signal, { headers: { Accept: 'application/json' } }, admission.onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  return json(response, signal, value => {
    if (response.status !== 200) throw new ApiError('protocol', response.status);
    return parsePRStatistics(value, project, endDate, authorId, repositoryId);
  });
};
