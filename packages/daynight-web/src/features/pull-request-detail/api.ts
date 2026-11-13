import { ApiError, assertResponsePrincipal, json, request, requestId } from '../../api/client';
import { boolean, malformed, record, string, timestamp } from '../../api/parse';
import { parseConfigurationRevision } from '../../api/worker-configuration';

export type PullRequestDetail = {
  readonly number: string; readonly id: string; readonly url: string; readonly title: string;
  readonly author: { readonly id: string; readonly login: string } | null;
  readonly state: string; readonly draft: boolean;
  readonly base: { readonly repositoryId: string; readonly repositoryFullName: string; readonly ref: string };
  readonly head: { readonly repositoryId: string | null; readonly repositoryFullName: string | null; readonly ref: string | null; readonly sha: string };
  readonly createdAt: string; readonly updatedAt: string; readonly closedAt: string | null;
  readonly mergedAt: string | null; readonly observedAt: string; readonly revision: string;
  readonly description: string | null;
};

const decimal = (value: unknown): string => parseConfigurationRevision(value);
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);

export const parsePullRequestDetail = (value: unknown, expectedNumber: string): PullRequestDetail => {
  const data = record(value), number = decimal(data.number);
  if (number !== decimal(expectedNumber)) return malformed();
  const base = record(data.base), head = record(data.head);
  const author = nullable(data.author, value => {
    const item = record(value);
    return { id: decimal(item.id), login: string(item.login) };
  });
  return {
    number, id: decimal(data.id), url: string(data.url), title: string(data.title), author,
    state: string(data.state), draft: boolean(data.draft),
    base: { repositoryId: decimal(base.repositoryId), repositoryFullName: string(base.repositoryFullName), ref: string(base.ref) },
    head: { repositoryId: nullable(head.repositoryId, decimal), repositoryFullName: nullable(head.repositoryFullName, string), ref: nullable(head.ref, string), sha: string(head.sha) },
    createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt), closedAt: nullable(data.closedAt, timestamp),
    mergedAt: nullable(data.mergedAt, timestamp), observedAt: timestamp(data.observedAt),
    revision: parseConfigurationRevision(data.revision, true), description: nullable(data.description, string),
  };
};

export type PullRequestAdmission = { readonly userId: string; readonly onPrincipalMismatch: () => void; readonly onDispatch?: () => void };

export const getPullRequestDetail = async (projectId: string, number: string, signal: AbortSignal, admission: PullRequestAdmission): Promise<PullRequestDetail> => {
  const project = requestId(projectId), userId = requestId(admission.userId);
  try { decimal(number); } catch (error) { throw new ApiError('protocol', null, 'protocol', null, error); }
  const response = await request(`/api/v1/projects/${project}/pull-requests/${number}`, signal, { headers: { Accept: 'application/json' } }, admission.onDispatch);
  assertResponsePrincipal(response, userId, admission.onPrincipalMismatch);
  return json(response, signal, value => {
    if (response.status !== 200) throw new ApiError('protocol', response.status);
    return parsePullRequestDetail(value, number);
  });
};
