import { afterEach, expect, it, vi } from 'vitest';
import { getGoalDependencies, parseGoalDependencies } from '../src/api/goal-dependencies';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';
import { wireResponse } from './helpers/wireJson';

const projectId = '10000000-0000-4000-8000-000000000001';
const goalId = '20000000-0000-4000-8000-000000000001';
const target = { projectId, projectName: 'Client', goalId: '20000000-0000-4000-8000-000000000002', title: 'Release criteria', status: 'done', kind: 'internal' };
const page = () => ({ goalId, canEdit: true, revision: '9223372036854775807', completionBlocked: false,
  prerequisites: [{ edgeId: '30000000-0000-4000-8000-000000000001', target }], successors: [], nextCursor: null });
const admission = () => ({ userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn() });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('reads the dedicated bounded no-store resource with exact revision and cursor', async () => {
  const fetch = vi.fn().mockResolvedValue(wireResponse(page(), { headers: viewerHeaders(TEST_VIEWER_ID) }));
  vi.stubGlobal('fetch', fetch);
  const result = await getGoalDependencies(projectId, goalId, 'opaque+cursor', new AbortController().signal, admission());
  expect(result).toEqual({ kind: 'available', page: page() });
  const [url, options] = fetch.mock.calls[0]!;
  expect(url).toBe(`/api/v1/projects/${projectId}/tasks/${goalId}/goal-dependencies?limit=20&cursor=opaque%2Bcursor`);
  expect(options).toMatchObject({ cache: 'no-store', headers: { Accept: 'application/json' } });
});

it('retains the permission projection without inventing target identities', () => {
  const hidden = { goalId, canEdit: false, completionBlocked: true, prerequisites: [{ target: null }], successors: [], nextCursor: null };
  expect(parseGoalDependencies(hidden, projectId, goalId)).toEqual(hidden);
});

it.each([
  (value: ReturnType<typeof page>) => ({ ...value, revision: '01' }),
  (value: ReturnType<typeof page>) => ({ ...value, revision: '9223372036854775808' }),
  (value: ReturnType<typeof page>) => ({ ...value, goalId: target.goalId }),
  (value: ReturnType<typeof page>) => ({ ...value, canEdit: false }),
  (value: ReturnType<typeof page>) => ({ ...value, prerequisites: [{ ...value.prerequisites[0], target: { ...target, kind: 'external' } }] }),
  (value: ReturnType<typeof page>) => ({ ...value, prerequisites: [{ ...value.prerequisites[0], target: { ...target, status: 'proposed' } }] }),
  (value: ReturnType<typeof page>) => ({ ...value, prerequisites: [value.prerequisites[0], value.prerequisites[0]] }),
  (value: ReturnType<typeof page>) => ({ ...value, prerequisites: [{ edgeId: value.prerequisites[0]!.edgeId, target: null, title: 'Leaked' }] }),
])('rejects invalid relationship contracts (%#)', change => {
  expect(() => parseGoalDependencies(change(page()), projectId, goalId)).toThrow();
});

it('recognizes the actual old router JSON 404 before principal validation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(wireResponse({ error: { code: 'not_found', message: 'Not Found', requestId: 'router' } }, { status: 404 })));
  const access = admission();
  await expect(getGoalDependencies(projectId, goalId, null, new AbortController().signal, access)).resolves.toEqual({ kind: 'unavailable' });
  expect(access.onPrincipalMismatch).not.toHaveBeenCalled();
});

it.each([
  { status: 404, headers: viewerHeaders(TEST_VIEWER_ID), code: 'not_found', kind: 'server' },
  { status: 404, headers: { 'Content-Type': 'text/html' }, code: 'not_found', kind: 'protocol' },
  { status: 404, headers: {}, code: 'forbidden', kind: 'server' },
])('preserves actual domain and malformed-router errors (%#)', async ({ status, headers, code, kind }) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(wireResponse({ error: { code, message: 'Unavailable', requestId: 'error' } }, { status, headers })));
  await expect(getGoalDependencies(projectId, goalId, null, new AbortController().signal, admission())).rejects.toMatchObject({ kind, status });
});

it('rejects data from a different principal before consuming its body', async () => {
  const response = wireResponse(page(), { headers: viewerHeaders('40000000-0000-4000-8000-000000000001') });
  const text = vi.spyOn(response, 'text');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const access = admission();
  await expect(getGoalDependencies(projectId, goalId, null, new AbortController().signal, access)).rejects.toMatchObject({ code: 'principal_mismatch' });
  expect(access.onPrincipalMismatch).toHaveBeenCalledOnce(); expect(text).not.toHaveBeenCalled();
});
