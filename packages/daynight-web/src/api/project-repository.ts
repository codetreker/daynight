import { ApiError, assertResponsePrincipal, json, request, requestId } from './client';
import { boolean, id, malformed, record, string } from './validation';

export type RepositoryClassification = 'unchanged' | 'same_repository' | 'different_repository' | 'unverified';
export type RepositoryPreview = {
  readonly projectId: string; readonly projectName: string; readonly currentRepoUrl: string; readonly repoUrl: string;
  readonly repositoryVersion: string; readonly ownershipVersion: string; readonly classification: RepositoryClassification;
  readonly targetGitHubRepositoryId: string | null; readonly unverifiedReason: string | null; readonly bindingsInvalidated: boolean;
};
export type RepositoryReceipt = { readonly projectId: string; readonly repoUrl: string; readonly repositoryVersion: string; readonly changed: boolean; readonly bindingsInvalidated: boolean };

const decimal = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) return malformed();
  return value;
};
const classification = (value: unknown): RepositoryClassification => {
  if (value !== 'unchanged' && value !== 'same_repository' && value !== 'different_repository' && value !== 'unverified') return malformed();
  return value;
};
const parsePreview = (value: unknown, projectId: string, repoUrl: string): RepositoryPreview => {
  const data = record(value), kind = classification(data.classification);
  const result: RepositoryPreview = {
    projectId: id(data.projectId), projectName: string(data.projectName), currentRepoUrl: string(data.currentRepoUrl), repoUrl: string(data.repoUrl),
    repositoryVersion: decimal(data.repositoryVersion), ownershipVersion: decimal(data.ownershipVersion), classification: kind,
    targetGitHubRepositoryId: data.targetGitHubRepositoryId === null ? null : decimal(data.targetGitHubRepositoryId),
    unverifiedReason: data.unverifiedReason === null ? null : string(data.unverifiedReason), bindingsInvalidated: boolean(data.bindingsInvalidated),
  };
  if (result.projectId !== projectId || result.repoUrl !== repoUrl || (kind === 'unchanged') !== (result.currentRepoUrl === repoUrl)
    || result.bindingsInvalidated !== (kind === 'different_repository' || kind === 'unverified')
    || (kind === 'unverified' ? !['unsupported_host', 'no_verified_repository', 'no_github_access', 'provider_unavailable'].includes(result.unverifiedReason!) : result.unverifiedReason !== null)) return malformed();
  return result;
};

export const previewProjectRepository = async (projectId: string, repoUrl: string, userId: string, signal: AbortSignal, onMismatch: () => void): Promise<RepositoryPreview> => {
  const project = requestId(projectId), user = requestId(userId);
  const response = await request(`/api/v1/projects/${project}/repository/preview`, signal, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ repoUrl, expectedUserId: user }),
  });
  assertResponsePrincipal(response, user, onMismatch);
  if (response.ok && response.status !== 200) throw new ApiError('protocol', response.status);
  return json(response, signal, value => parsePreview(value, project, repoUrl));
};

export const saveProjectRepository = async (preview: RepositoryPreview, treatUnverifiedAsSwitch: boolean, userId: string, signal: AbortSignal, onMismatch: () => void, onDispatch: () => void): Promise<RepositoryReceipt> => {
  const project = requestId(preview.projectId), user = requestId(userId);
  parsePreview(preview, project, preview.repoUrl);
  if (preview.classification === 'unverified' ? !treatUnverifiedAsSwitch : treatUnverifiedAsSwitch) throw new ApiError('protocol');
  const response = await request(`/api/v1/projects/${project}/repository`, signal, {
    method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoUrl: preview.repoUrl, expectedUserId: user, repositoryVersion: preview.repositoryVersion, ownershipVersion: preview.ownershipVersion, classification: preview.classification, targetGitHubRepositoryId: preview.targetGitHubRepositoryId, treatUnverifiedAsSwitch }),
  }, onDispatch);
  assertResponsePrincipal(response, user, onMismatch);
  if (response.ok && response.status !== 200) throw new ApiError('protocol', response.status);
  return json(response, signal, value => {
    const data = record(value), changed = preview.currentRepoUrl !== preview.repoUrl;
    const result = { projectId: id(data.projectId), repoUrl: string(data.repoUrl), repositoryVersion: decimal(data.repositoryVersion), changed: boolean(data.changed), bindingsInvalidated: boolean(data.bindingsInvalidated) };
    if (result.projectId !== project || result.repoUrl !== preview.repoUrl || result.changed !== changed || result.bindingsInvalidated !== preview.bindingsInvalidated || BigInt(result.repositoryVersion) !== BigInt(preview.repositoryVersion) + (changed ? 1n : 0n)) return malformed();
    return result;
  });
};
