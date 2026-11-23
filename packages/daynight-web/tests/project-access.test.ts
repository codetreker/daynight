import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from '../src/features/task-cache/database';
import { ApiError, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
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

it('rechecks access when an independent project read succeeds after an older access request started', async () => {
  const old = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValueOnce(old.promise).mockResolvedValue(member);
  const { session } = mount();
  const read = session.revalidate();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  expect(session.publishProjectRead(session.beginObservation())).toBe(true);
  old.reject(new ApiError('server', 404, 'not_found'));
  await read;
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
  await session.revalidate();
  expect(session.snapshot()).toMatchObject({ status: 'ready', access: member, refreshing: false });
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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
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
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
});

it('pauses background access reads for an inactive retained panel and revalidates on return', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const { session } = mount();
  session.publishSync(session.beginObservation(), admin);
  session.setActive(false);
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(getProjectAccess).not.toHaveBeenCalled();
  session.setActive(true);
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  await session.revalidate();
  expect(session.snapshot()).toMatchObject({ status: 'ready', access: member, refreshing: false });
});

it('ignores a late access response after a retained panel becomes inactive', async () => {
  const pending = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValueOnce(pending.promise).mockResolvedValue(member);
  const { session } = mount();
  const read = session.revalidate();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  const signal = vi.mocked(getProjectAccess).mock.calls[0]![1];
  session.setActive(false);
  expect(signal.aborted).toBe(true);
  session.setActive(true);
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
  await session.revalidate();
  pending.resolve(admin);
  expect(await read).toBeNull();
  expect(session.snapshot()).toMatchObject({ status: 'ready', access: member, refreshing: false });
});

it('holds write admission across an inactive recovery until the returning access check finishes', async () => {
  const old = deferred<ProjectAccess>(), fresh = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const { session, scope } = mount();
  session.publishSync(session.beginObservation(), admin);
  const read = session.revalidate();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(1));
  const resume = pauseAuthRequests();
  session.setActive(false);
  const admitted = vi.fn();
  const waiting = session.waitForFreshAccess(scope.signal, true).then(admitted);
  old.resolve(admin); await read;
  resume();
  await new Promise<void>((done) => setTimeout(done, 0));
  expect(admitted).not.toHaveBeenCalled();
  session.setActive(true);
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
  expect(admitted).not.toHaveBeenCalled();
  fresh.resolve(member); await waiting;
  expect(admitted).toHaveBeenCalledWith(member);
});

it('cancels inactive write admission with its owning lifetime', async () => {
  const { session, scope } = mount();
  session.publishSync(session.beginObservation(), admin);
  session.setActive(false);
  const controller = new AbortController();
  const waiting = session.waitForFreshAccess(controller.signal, true);
  await Promise.resolve();
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  expect(scope.isInvalidated).toBe(false);
});

it('retains a mutation receipt while inactive and verifies it when the panel returns', async () => {
  const { session } = mount();
  session.publishSync(session.beginObservation(), member);
  session.setActive(false);
  session.publishMutation(admin);
  expect(session.snapshot()).toMatchObject({ status: 'ready', access: admin, refreshing: false });
  session.setActive(true);
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  await session.revalidate();
  expect(session.snapshot()).toMatchObject({ status: 'ready', access: member, refreshing: false });
});

it('lets confirmed mutation verification finish across navigation and refreshes again before releasing controls', async () => {
  const protectedResult = deferred<ProjectAccess>(), freshResult = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValueOnce(protectedResult.promise).mockReturnValueOnce(freshResult.promise);
  const { session } = mount();
  session.publishSync(session.beginObservation(), admin);
  const read = session.revalidateAfterMutation();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  const signal = vi.mocked(getProjectAccess).mock.calls[0]![1];
  session.setActive(false);
  expect(signal.aborted).toBe(false);
  session.setActive(true);
  window.dispatchEvent(new Event('focus'));
  expect(signal.aborted).toBe(false);
  expect(getProjectAccess).toHaveBeenCalledOnce();
  protectedResult.resolve(admin);
  expect(await read).toEqual(admin);
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
  expect(session.snapshot()).toMatchObject({ refreshing: true, access: admin });
  freshResult.resolve(member);
  await session.revalidate();
  expect(session.snapshot()).toMatchObject({ status: 'ready', access: member, refreshing: false });
});

it('completes confirmed loss-of-access cleanup across navigation before refreshing', async () => {
  const protectedResult = deferred<ProjectAccess>(), freshResult = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValueOnce(protectedResult.promise).mockReturnValueOnce(freshResult.promise);
  const { session, scope } = mount();
  const revoked = vi.fn();
  const unsubscribe = scope.subscribe((event) => { if (event.projectId === projectId && event.accessRevoked) revoked(); });
  const read = session.revalidateAfterMutation();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  const signal = vi.mocked(getProjectAccess).mock.calls[0]![1];
  session.setActive(false);
  session.setActive(true);
  expect(signal.aborted).toBe(false);
  protectedResult.reject(new ApiError('server', 404, 'not_found'));
  expect(await read).toBeNull();
  expect(revoked).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
  expect(session.snapshot()).toMatchObject({ status: 'unavailable', access: null, refreshing: true });
  freshResult.resolve(member);
  await session.revalidate();
  expect(session.snapshot()).toMatchObject({ status: 'ready', access: member, refreshing: false });
  unsubscribe();
});

it('does not start an access read for an initially inactive retained panel', async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  scopes.push(scope);
  const session = new ProjectAccessSession(projectId, scope, false);
  cleanups.push(session.start(true));
  await Promise.resolve();
  window.dispatchEvent(new Event('focus'));
  expect(getProjectAccess).not.toHaveBeenCalled();
  session.setActive(true);
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  await session.revalidate();
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


it.each(['network', 'identity'] as const)('holds an in-flight access %s failure until identity admission', async (outcome) => {
  const pending = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValueOnce(pending.promise);
  const { session } = mount();
  session.publishSync(session.beginObservation(), admin);
  const read = session.revalidate();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  const resume = pauseAuthRequests();
  pending.reject(new ApiError('network'));
  await new Promise<void>((done) => setTimeout(done, 0));
  expect(session.snapshot()).toMatchObject({ status: 'ready', access: admin, refreshing: true, error: null });
  if (outcome === 'identity') invalidateAuthRequests(); else resume();
  await read; resume();
  if (outcome === 'identity') expect(session.snapshot().status).toBe('ready');
  else expect(session.snapshot().status).toBe('error');
});


it('withdraws a trusted denial during identity pause before foreground replacement and a later network failure', async () => {
  const pending = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValueOnce(pending.promise).mockRejectedValue(new ApiError('network'));
  const { session, scope } = mount();
  const taskId = '00000000-0000-4000-8000-000000000103';
  const graph = graphFixture([detailFixture(projectId, taskId)]);
  const initial = await scope.beginSync(projectId, scope.signal);
  const active = await scope.applySync(initial, taskSyncFromGraph(graph, { versionForTask: () => 1n }), scope.signal);
  session.publishSync(session.beginObservation(), admin);
  const revoked = vi.fn();
  const unsubscribe = scope.subscribe((event) => { if (event.projectId === projectId && event.accessRevoked) revoked(event); });
  const read = session.revalidate();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  const database = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  const resume = pauseAuthRequests();
  try {
    pending.reject(new ApiError('server', 404, 'not_found'));
    await vi.waitFor(() => expect(session.snapshot()).toMatchObject({ status: 'unavailable', access: null }));
    expect(revoked).toHaveBeenCalledOnce();
    expect(revoked).toHaveBeenCalledWith(expect.objectContaining({ projectId, accessRevoked: true, revokedGeneration: active.project.manifest.cacheGeneration, error: expect.objectContaining({ status: 404, code: 'not_found' }) }));
    expect(() => scope.getAuthorizedProject(projectId)).toThrow();
    expect(await database.get('projects', [TEST_VIEWER_ID, projectId])).toMatchObject({ state: 'active' });
    expect(await database.get('summaries', [TEST_VIEWER_ID, projectId, taskId])).toBeDefined();
    window.dispatchEvent(new Event('focus'));
    expect(session.snapshot().access).toBeNull();
    expect(getProjectAccess).toHaveBeenCalledOnce();
    resume();
    await read;
    await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
    await session.waitForFreshAccess(scope.signal);
    expect(session.snapshot()).toMatchObject({ status: 'error', access: null, error: { kind: 'network' } });
    expect(scope.getAuthorizedProject(projectId)).toBeNull();
    expect(await database.get('projects', [TEST_VIEWER_ID, projectId])).toMatchObject({ state: 'invalidated', invalidatedBy: 'access' });
    expect(await database.get('summaries', [TEST_VIEWER_ID, projectId, taskId])).toBeUndefined();
  } finally { resume(); database.close(); unsubscribe(); }
});

it('keeps confirmed denial cleanup owned by the scope if a subscriber deactivates the panel', async () => {
  const pending = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValueOnce(pending.promise);
  const { session, scope } = mount();
  const taskId = '00000000-0000-4000-8000-000000000103';
  const graph = graphFixture([detailFixture(projectId, taskId)]);
  const initial = await scope.beginSync(projectId, scope.signal);
  await scope.applySync(initial, taskSyncFromGraph(graph, { versionForTask: () => 1n }), scope.signal);
  session.publishSync(session.beginObservation(), admin);
  const unsubscribe = session.subscribe(() => { if (session.snapshot().status === 'unavailable') session.setActive(false); });
  const read = session.revalidate();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  const readSignal = vi.mocked(getProjectAccess).mock.calls[0]![1];
  const database = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  const resume = pauseAuthRequests();
  try {
    pending.reject(new ApiError('server', 404, 'not_found'));
    await vi.waitFor(() => expect(session.snapshot()).toMatchObject({ status: 'unavailable', access: null }));
    expect(readSignal.aborted).toBe(true);
    expect(await database.get('projects', [TEST_VIEWER_ID, projectId])).toMatchObject({ state: 'active' });
    resume(); await read;
    expect(scope.getAuthorizedProject(projectId)).toBeNull();
    expect(await database.get('projects', [TEST_VIEWER_ID, projectId])).toMatchObject({ state: 'invalidated', invalidatedBy: 'access' });
    expect(await database.get('summaries', [TEST_VIEWER_ID, projectId, taskId])).toBeUndefined();
  } finally { resume(); database.close(); unsubscribe(); }
});

it('does not withdraw a newer cache generation for a stale denial while identity is paused', async () => {
  const pending = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValueOnce(pending.promise);
  const { session, scope } = mount();
  const graph = graphFixture([detailFixture(projectId, '00000000-0000-4000-8000-000000000103')]);
  const initial = await scope.beginSync(projectId, scope.signal);
  await scope.applySync(initial, taskSyncFromGraph(graph, { versionForTask: () => 1n }), scope.signal);
  session.publishSync(session.beginObservation(), admin);
  const read = session.revalidate();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  const replacement = await scope.beginSync(projectId, scope.signal);
  const current = await scope.applySync(replacement, taskSyncFromGraph(graph, { epoch: '00000000-0000-4000-8000-000000000999', versionForTask: () => 1n }), scope.signal);
  const resume = pauseAuthRequests();
  try {
    pending.reject(new ApiError('server', 404, 'not_found'));
    await new Promise<void>((done) => setTimeout(done, 0));
    expect(session.snapshot()).toMatchObject({ status: 'ready', access: admin, refreshing: true });
    expect(() => scope.getAuthorizedProject(projectId)).toThrow();
    resume(); await read;
    expect(scope.getAuthorizedProject(projectId)!.manifest.cacheGeneration).toBe(current.project.manifest.cacheGeneration);
    expect(session.snapshot().status).toBe('loading');
  } finally { resume(); }
});

it.each(['focus-first', 'visibility-first'] as const)('supersedes a pre-departure access read on foreground return: %s', async (order) => {
  const old = deferred<ProjectAccess>(), fresh = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValueOnce(old.promise).mockReturnValue(fresh.promise);
  const { session } = mount();
  session.publishSync(session.beginObservation(), admin);
  const earlier = session.revalidate();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  const oldSignal = vi.mocked(getProjectAccess).mock.calls[0]![1];
  const resume = pauseAuthRequests();
  if (order === 'focus-first') { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); }
  else { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); }
  expect(oldSignal.aborted).toBe(true);
  old.resolve(admin); await earlier;
  expect(session.snapshot()).toMatchObject({ status: 'ready', access: admin, refreshing: true });
  resume();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
  expect(session.snapshot().refreshing).toBe(true);
  fresh.resolve(member); await session.revalidate();
  expect(session.snapshot()).toMatchObject({ status: 'ready', access: member, refreshing: false });
});

it('waits across protected verification and consecutive foreground returns before admitting access', async () => {
  const protectedResult = deferred<ProjectAccess>(), oldReturn = deferred<ProjectAccess>(), latest = deferred<ProjectAccess>();
  vi.mocked(getProjectAccess).mockReturnValueOnce(protectedResult.promise).mockReturnValueOnce(oldReturn.promise).mockReturnValueOnce(latest.promise);
  const { session, scope } = mount();
  session.publishSync(session.beginObservation(), admin);
  const protectedRead = session.revalidateAfterMutation();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(1));
  window.dispatchEvent(new Event('focus'));
  const result = session.waitForFreshAccess(scope.signal);
  protectedResult.resolve(admin); await protectedRead;
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
  expect(session.snapshot().refreshing).toBe(true);
  const resume = pauseAuthRequests();
  window.dispatchEvent(new Event('focus'));
  oldReturn.resolve(admin);
  await Promise.resolve();
  expect(session.snapshot().refreshing).toBe(true);
  resume();
  await vi.waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(3));
  latest.resolve(member);
  expect(await result).toEqual(member);
  expect(session.snapshot()).toMatchObject({ status: 'ready', access: member, refreshing: false });
});
