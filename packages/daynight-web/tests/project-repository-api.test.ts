import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import { previewProjectRepository, saveProjectRepository, type RepositoryPreview } from '../src/api/project-repository';

const projectId = '00000000-0000-4000-8000-000000000001', userId = '00000000-0000-4000-8000-000000000002';
const candidate = (): RepositoryPreview => ({ projectId, projectName: 'Project', currentRepoUrl: 'https://github.com/o/old', repoUrl: 'https://github.com/o/new', repositoryVersion: '9007199254740993', ownershipVersion: '9223372036854775807', classification: 'different_repository', targetGitHubRepositoryId: '9007199254740995', unverifiedReason: null, bindingsInvalidated: true });
const receipt = () => ({ projectId, repoUrl: candidate().repoUrl, repositoryVersion: '9007199254740994', changed: true, bindingsInvalidated: true });
const response = (value: unknown, principal = userId, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
const signal = () => new AbortController().signal;
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe('repository change transport', () => {
  it('binds exact decimal preview facts and identity to one save and validates the receipt', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(candidate())).mockResolvedValueOnce(response(receipt())); vi.stubGlobal('fetch', fetch);
    const preview = await previewProjectRepository(projectId, candidate().repoUrl, userId, signal(), vi.fn());
    const dispatched = vi.fn(); expect(await saveProjectRepository(preview, false, userId, signal(), vi.fn(), dispatched)).toEqual(receipt());
    expect(dispatched).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ repoUrl: preview.repoUrl, expectedUserId: userId });
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ repoUrl: preview.repoUrl, expectedUserId: userId, repositoryVersion: preview.repositoryVersion, ownershipVersion: preview.ownershipVersion, classification: preview.classification, targetGitHubRepositoryId: preview.targetGitHubRepositoryId, treatUnverifiedAsSwitch: false });
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'PATCH', cache: 'no-store', credentials: 'same-origin' });
  });
  it.each([
    { projectId: userId }, { repoUrl: 'https://github.com/other/repo' }, { repositoryVersion: 1 }, { repositoryVersion: '01' }, { ownershipVersion: '9223372036854775808' }, { targetGitHubRepositoryId: '0' }, { classification: 'other' }, { bindingsInvalidated: false }, { unverifiedReason: 'provider_unavailable' },
  ])('rejects mismatched or malformed preview facts %j', async patch => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...candidate(), ...patch })));
    await expect(previewProjectRepository(projectId, candidate().repoUrl, userId, signal(), vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('requires explicit unknown choice and refuses mismatched principals or receipts', async () => {
    const unknown = { ...candidate(), classification: 'unverified' as const, unverifiedReason: 'no_github_access' };
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(saveProjectRepository(unknown, false, userId, signal(), vi.fn(), vi.fn())).rejects.toMatchObject({ kind: 'protocol' }); expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(response(candidate(), projectId)); const mismatch = vi.fn();
    await expect(previewProjectRepository(projectId, candidate().repoUrl, userId, signal(), mismatch)).rejects.toMatchObject({ code: 'principal_mismatch' }); expect(mismatch).toHaveBeenCalledOnce();
    for (const patch of [{ projectId: userId }, { repoUrl: 'other' }, { changed: false }, { bindingsInvalidated: false }, { repositoryVersion: candidate().repositoryVersion }]) {
      fetch.mockResolvedValue(response({ ...receipt(), ...patch }));
      await expect(saveProjectRepository(candidate(), false, userId, signal(), vi.fn(), vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
    }
  });
});
