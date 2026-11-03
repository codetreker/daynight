import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { taskSyncFromGraph } from './helpers/taskSync';
import { getProjectAccess } from '../src/api/auth';
import { ProjectAccessSession } from '../src/features/projects/ProjectAccess';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { directAccessFixture, TEST_VIEWER_ID } from './helpers/taskSync';
import type { ProjectAccess } from '../src/api/auth-types';

vi.mock('../src/api/auth', () => ({ getProjectAccess: vi.fn() }));
const projectId = '00000000-0000-4000-8000-000000000101';
const member = directAccessFixture(projectId);
const admin = directAccessFixture(projectId, TEST_VIEWER_ID, 'admin');
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const cleanups: (() => void)[] = [];
const scopes: TaskCacheScope[] = [];
let visibility: DocumentVisibilityState = 'visible';
const mount = (initialRead = false) => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  scopes.push(scope);
  const session = new ProjectAccessSession(projectId, scope);
  cleanups.push(session.start(initialRead));
  return { session, scope };
};

beforeEach(() => {
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.mocked(getProjectAccess).mockReset().mockResolvedValue(member);
});
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); scopes.splice(0).forEach((scope) => scope.dispose()); vi.useRealTimers(); });

it('coalesces reads and blocks a management refresh until its own revalidation completes', async () => {
  const pending = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValue(pending.promise);
  const { session } = mount();
  const oldSync = session.beginObservation();
  session.publishSync(oldSync, admin);
  const read = session.revalidate();
  expect(session.revalidate()).toBe(read);
  session.publishSync(oldSync, admin);
  expect(session.snapshot()).toMatchObject({ refreshing: true, access: admin });
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  pending.resolve(member);
  await read;
  expect(session.snapshot()).toMatchObject({ status: 'ready', refreshing: false, access: member });
});

it('retains a newer sync snapshot when an earlier GET arrives late without releasing the pending refresh early', async () => {
  const pending = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValue(pending.promise);
  const { session } = mount();
  const read = session.revalidate();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  session.publishSync(session.beginObservation(), admin);
  expect(session.snapshot()).toMatchObject({ access: admin, refreshing: true });
  pending.resolve(member);
  expect(await read).toEqual(admin);
  expect(session.snapshot()).toMatchObject({ access: admin, refreshing: false });
});

it('does not let a sync started before explicit revalidation replace the confirmed GET result', async () => {
  const { session } = mount();
  const stale = session.beginObservation();
  await session.revalidate();
  session.publishSync(stale, admin);
  expect(session.snapshot().access).toEqual(member);
});

it('cancels the old project lifetime and ignores a transport that returns after unmount', async () => {
  const pending = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValue(pending.promise);
  const { session } = mount();
  const read = session.revalidate();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  const signal = vi.mocked(getProjectAccess).mock.calls[0]![1];
  cleanups.pop()!();
  expect(signal.aborted).toBe(true);
  pending.resolve(admin);
  expect(await read).toBeNull();
  expect(session.snapshot().access).toBeNull();
});

it('uses sync receipts for the visible thirty-second budget and pauses its timer while hidden', async () => {
  vi.useFakeTimers();
  const { session } = mount();
  for (let index = 0; index < 8; index++) {
    await vi.advanceTimersByTimeAsync(5_000);
    session.publishSync(session.beginObservation(), member);
  }
  expect(getProjectAccess).not.toHaveBeenCalled();
  visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(getProjectAccess).not.toHaveBeenCalled();
  visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  expect(getProjectAccess).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(getProjectAccess).toHaveBeenCalledTimes(2);
});

it('exposes an access failure without replacing it with a role or an empty result', async () => {
  const failure = new Error('offline');
  vi.mocked(getProjectAccess).mockRejectedValue(failure);
  const { session } = mount();
  session.publishSync(session.beginObservation(), member);
  expect(await session.revalidate()).toBeNull();
  expect(session.snapshot()).toMatchObject({ status: 'error', access: member, error: failure, refreshing: false });
});

it('ignores a captured history denial after a replacement sync applies, even before its access publication', async () => {
  const pending = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValue(pending.promise);
  const { session, scope } = mount();
  const graph = graphFixture([detailFixture(projectId, '00000000-0000-4000-8000-000000000103')]);
  const firstTicket = await scope.beginSync(projectId, scope.signal);
  await scope.applySync(firstTicket, taskSyncFromGraph(graph, { versionForTask: () => 1n }), scope.signal);
  session.publishSync(session.beginObservation(), member);
  const read = session.revalidate();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  const replacementTicket = await scope.beginSync(projectId, scope.signal);
  const replacement = await scope.applySync(replacementTicket, taskSyncFromGraph(graph, { epoch: '00000000-0000-4000-8000-000000000999', versionForTask: () => 1n }), scope.signal);
  const generation = replacement.project.manifest.cacheGeneration;
  pending.reject(new ApiError('server', 404, 'not_found'));
  expect(await read).toBeNull();
  expect(session.snapshot()).toMatchObject({ status: 'loading', access: member, error: null });
  expect(scope.getAuthorizedProject(projectId)!.manifest.cacheGeneration).toBe(generation);
});

it.each(['success', 'failure'] as const)('keeps confirmed revocation when an older access GET settles with %s', async (outcome) => {
  const pending = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValue(pending.promise);
  const { session, scope } = mount();
  const graph = graphFixture([detailFixture(projectId, '00000000-0000-4000-8000-000000000103')]);
  const initialTicket = await scope.beginSync(projectId, scope.signal);
  await scope.applySync(initialTicket, taskSyncFromGraph(graph, { versionForTask: () => 1n }), scope.signal);
  session.publishSync(session.beginObservation(), admin);
  const read = session.revalidate();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  const deniedTicket = await scope.beginSync(projectId, scope.signal);
  await scope.revokeProject(deniedTicket, scope.signal, false);
  expect(session.snapshot()).toMatchObject({ status: 'unavailable', access: null });
  if (outcome === 'success') pending.resolve(admin);
  else pending.reject(new ApiError('network'));
  expect(await read).toBeNull();
  expect(scope.getAuthorizedProject(projectId)).toBeNull();
  expect(session.snapshot()).toMatchObject({ status: 'unavailable', access: null, refreshing: false, error: { code: 'not_found' } });
});
