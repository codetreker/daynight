import { expect, it, vi } from 'vitest';
import { getProjectAccess } from '../src/api/auth';
import { ApiError, getTaskSync } from '../src/api/client';
import { parseProjectAccess } from '../src/api/auth-parse';
import { directAccessFixture, TEST_VIEWER_ID, taskSyncResponse } from './helpers/taskSync';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { wireResponse } from './helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000101';
const otherId = '00000000-0000-4000-8000-000000000102';
const access = directAccessFixture(projectId);
const admission = () => ({ userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn() });
const signal = () => new AbortController().signal;

it('keeps the profile-free grant version exact in GET access and task-sync without changing opaque properties', async () => {
  const exact = { ...access, directGrant: { ...access.directGrant!, version: 9_223_372_036_854_775_807n } };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(wireResponse(exact, { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })));
  expect((await getProjectAccess(projectId, signal(), admission())).directGrant!.version).toBe(9_223_372_036_854_775_807n);
  const detail = detailFixture(projectId, otherId);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(taskSyncResponse(graphFixture([detail]), { viewerId: TEST_VIEWER_ID, actorAccess: exact, versionForTask: () => 1n, propertiesForTask: () => ({ future: { version: 42 } }) })));
  const { sync } = await getTaskSync(projectId, {}, TEST_VIEWER_ID, signal());
  expect(sync.actorAccess.directGrant!.version).toBe(exact.directGrant.version);
  expect(sync.tasks[0]!.properties).toEqual({ future: { version: 42 } });
});

it('accepts distinct effective and direct roles and the required nullable direct grant', () => {
  expect(parseProjectAccess({ ...access, effectiveRole: 'admin', teamRole: 'admin', canTransfer: true }, projectId, TEST_VIEWER_ID).directGrant!.role).toBe('member');
  expect(parseProjectAccess({ ...access, teamRole: 'member', directGrant: null }, projectId, TEST_VIEWER_ID).directGrant).toBeNull();
  for (const value of [{ effectiveRole: 'member' }, { ...access, effectiveRole: 'owner' }, { ...access, directGrant: { ...access.directGrant, projectId: otherId } }, { ...access, directGrant: { ...access.directGrant, userId: otherId } }]) {
    expect(() => parseProjectAccess(value, projectId, TEST_VIEWER_ID)).toThrow();
  }
});

it('checks response principal before decoding access and rejects a grant for another principal', async () => {
  const owner = admission();
  const response = wireResponse(access, { headers: { 'Daynight-User-ID': otherId } });
  const read = vi.spyOn(response, 'text');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  await expect(getProjectAccess(projectId, signal(), owner)).rejects.toMatchObject({ kind: 'protocol', code: 'principal_mismatch' });
  expect(read).not.toHaveBeenCalled(); expect(owner.onPrincipalMismatch).toHaveBeenCalledOnce();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(wireResponse({ ...access, directGrant: { ...access.directGrant, userId: otherId } }, { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })));
  await expect(getProjectAccess(projectId, signal(), admission())).rejects.toBeInstanceOf(ApiError);
});


it.each([
  { principal: TEST_VIEWER_ID, kind: 'server', code: 'not_found', mismatch: false },
  { principal: null, kind: 'protocol', code: 'protocol', mismatch: false },
  { principal: 'malformed', kind: 'protocol', code: 'protocol', mismatch: false },
  { principal: otherId, kind: 'protocol', code: 'principal_mismatch', mismatch: true },
] as const)('accepts a 404 denial only from the verified principal: $principal', async ({ principal, kind, code, mismatch }) => {
  const owner = admission();
  const response = wireResponse({ error: { code: 'not_found', message: 'Unavailable', requestId: 'safe' } }, {
    status: 404, ...(principal === null ? {} : { headers: { 'Daynight-User-ID': principal } }),
  });
  const read = vi.spyOn(response, 'text');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  await expect(getProjectAccess(projectId, signal(), owner)).rejects.toMatchObject({ kind, code });
  expect(owner.onPrincipalMismatch).toHaveBeenCalledTimes(mismatch ? 1 : 0);
  expect(read).toHaveBeenCalledTimes(kind === 'server' ? 1 : 0);
});
