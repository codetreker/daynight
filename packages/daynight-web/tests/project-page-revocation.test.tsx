import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBObjectStore } from 'fake-indexeddb';
import { openDB } from 'idb';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from '../src/features/task-cache/database';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, getTaskSync } from '../src/api/client';
import { getProjectAccess } from '../src/api/auth';
import { getProject } from '../src/api/project-settings';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { ProjectAccessBoundary, ProjectAccessSession, useProjectAccessSession } from '../src/features/projects/ProjectAccess';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { LocaleProvider } from '../src/i18n/LocaleProvider';
import { TestTaskCacheBoundary } from './helpers/taskCache';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { directAccessFixture, taskSyncFromGraph, taskSyncReadFixture, TEST_VIEWER_ID } from './helpers/taskSync';

vi.mock('../src/api/client', async original => ({ ...await original<typeof import('../src/api/client')>(), getTaskSync: vi.fn() }));
vi.mock('../src/api/auth', async original => ({ ...await original<typeof import('../src/api/auth')>(), getProjectAccess: vi.fn() }));
vi.mock('../src/api/project-settings', async original => ({ ...await original<typeof import('../src/api/project-settings')>(), getProject: vi.fn() }));

class Channel {
  static channels = new Set<Channel>();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(_name: string) { Channel.channels.add(this); }
  postMessage(data: unknown) { for (const peer of Channel.channels) if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data } as MessageEvent<unknown>)); }
  close() { Channel.channels.delete(this); }
}
const projectId = '00000000-0000-4000-8000-000000000031';
const taskId = '00000000-0000-4000-8000-000000000041';
const graph = graphFixture([detailFixture(projectId, taskId, { title: 'Private task' })]);
const scopes: TaskCacheScope[] = [];
const scope = () => { const result = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(result); return result; };
const admit = async (target: TaskCacheScope) => {
  const ticket = await target.beginSync(projectId, target.signal);
  return target.applySync(ticket, taskSyncFromGraph(graph, { query: ticket.epoch === null ? {} : { epoch: ticket.epoch }, versionForTask: () => 1n }), target.signal);
};
afterEach(() => { scopes.splice(0).forEach(item => item.dispose()); vi.unstubAllGlobals(); });

it('withdraws the observed generation in another scope even if access revalidation and cache cleanup fail', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const owner = scope(); await admit(owner);
  const peer = scope(); await admit(peer);
  expect(peer.getAuthorizedProject(projectId)).not.toBeNull();
  vi.mocked(getTaskSync).mockReturnValue(new Promise(() => {}));
  vi.mocked(getProjectAccess).mockRejectedValue(new ApiError('network'));
  let denied = false;
  vi.mocked(getProject).mockImplementation(async () => {
    if (denied) throw new ApiError('server', 404, 'not_found');
    return graph.project;
  });
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={owner}>
    <ProjectPage projectId={projectId} />
  </TestTaskCacheBoundary></LocaleProvider>);
  await screen.findByRole('heading', { name: graph.project.name });
  const original = IDBObjectStore.prototype.put;
  const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'projects' && (args[0] as { state?: string }).state === 'invalidated') throw new DOMException('Injected purge failure', 'QuotaExceededError');
    return original.apply(this, args);
  });
  try {
    denied = true;
    await act(async () => { fireEvent(window, new Event('focus')); });
    await waitFor(() => expect(peer.getAuthorizedProject(projectId)).toBeNull());
    expect(owner.getAuthorizedProject(projectId)).toBeNull();
    expect(screen.queryByRole('heading', { name: graph.project.name })).toBeNull();
    expect(peer.canPreviewProject(projectId)).toBe(false);
  } finally { failure.mockRestore(); }
});

it('keeps a loaded peer on an unbound denial while its own access check fails and later succeeds', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const peer = scope(); await admit(peer);
  const originalGeneration = peer.getAuthorizedProject(projectId)!.manifest.cacheGeneration;
  const cold = scope();
  vi.spyOn(cold, 'beginSync').mockRejectedValue(new Error('cache unavailable'));
  vi.mocked(getTaskSync).mockReturnValue(new Promise(() => {}));
  vi.mocked(getProject).mockRejectedValue(new ApiError('server', 404, 'not_found'));
  vi.mocked(getProjectAccess).mockRejectedValue(new ApiError('network'));
  const events: { accessRestored?: true; accessRevoked?: true; error?: unknown }[] = [];
  peer.subscribe(event => events.push(event));
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={cold}>
    <ProjectPage projectId={projectId} />
  </TestTaskCacheBoundary></LocaleProvider>);
  await waitFor(() => expect(events).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ kind: 'network' }) })));
  expect(peer.isProjectSuspended(projectId)).toBe(false);
  expect(peer.getAuthorizedProject(projectId)!.manifest.cacheGeneration).toBe(originalGeneration);
  expect(events).not.toContainEqual(expect.objectContaining({ accessRevoked: true }));

  vi.mocked(getProjectAccess).mockResolvedValue(directAccessFixture(projectId));
  const reads = vi.mocked(getProjectAccess).mock.calls.length;
  act(() => cold.reportUnboundProjectDenial(projectId));
  await waitFor(() => expect(vi.mocked(getProjectAccess).mock.calls.length).toBeGreaterThan(reads));
  expect(peer.isProjectSuspended(projectId)).toBe(false);
  expect(peer.getAuthorizedProject(projectId)!.manifest.cacheGeneration).toBe(originalGeneration);
});


it('uses a peer independently confirmed denial to purge only its observed generation', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const peer = scope(); await admit(peer);
  const sender = scope();
  vi.mocked(getProjectAccess).mockRejectedValue(new ApiError('server', 404, 'not_found'));
  const db = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  try {
    act(() => sender.reportUnboundProjectDenial(projectId));
    await waitFor(async () => expect(await db.get('projects', [TEST_VIEWER_ID, projectId])).toMatchObject({ state: 'invalidated', invalidatedBy: 'access' }));
    expect(await db.get('summaries', [TEST_VIEWER_ID, projectId, taskId])).toBeUndefined();
    expect(peer.getAuthorizedProject(projectId)).toBeNull();
    expect(peer.canPreviewProject(projectId)).toBe(false);
  } finally { db.close(); }
});

it('prepares the durable generation before a cold peer confirms denial', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const writer = scope(); await admit(writer);
  const peer = scope(); const sender = scope();
  vi.mocked(getProjectAccess).mockRejectedValue(new ApiError('server', 404, 'not_found'));
  const db = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  try {
    expect(peer.getAuthorizedProject(projectId)).toBeNull();
    act(() => sender.reportUnboundProjectDenial(projectId));
    await waitFor(async () => expect(await db.get('projects', [TEST_VIEWER_ID, projectId])).toMatchObject({ state: 'invalidated', invalidatedBy: 'access' }));
    const reopened = scope();
    const ticket = await reopened.beginSync(projectId, reopened.signal);
    expect(ticket.epoch).toBeNull();
    expect(await reopened.readProject(projectId, reopened.signal)).toBeNull();
  } finally { db.close(); }
});

it('checks peer access without waiting indefinitely for a stuck cache ticket', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const peer = scope(); const sender = scope();
  vi.spyOn(peer, 'beginSync').mockReturnValue(new Promise(() => {}));
  vi.mocked(getProjectAccess).mockRejectedValue(new ApiError('network'));
  try {
    await act(async () => { sender.reportUnboundProjectDenial(projectId); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(getProjectAccess).toHaveBeenCalled();
    expect(peer.isProjectSuspended(projectId)).toBe(true);
  } finally { peer.dispose(); vi.useRealTimers(); }
});


it('does not withdraw a peer when an older verification fails after newer project access', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const peer = scope(); await admit(peer);
  const sender = scope(); const pending = Promise.withResolvers<ReturnType<typeof directAccessFixture>>();
  vi.mocked(getProjectAccess).mockReset().mockReturnValueOnce(pending.promise).mockResolvedValue(directAccessFixture(projectId));
  act(() => sender.reportUnboundProjectDenial(projectId));
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  const session = new ProjectAccessSession(projectId, peer);
  expect(session.publishProjectRead(session.beginObservation())).toBe(true);
  pending.reject(new ApiError('server', 404, 'not_found'));
  await waitFor(() => expect(vi.mocked(getProjectAccess).mock.calls.length).toBeGreaterThan(1));
  expect(peer.getAuthorizedProject(projectId)).not.toBeNull();
  expect(peer.canPreviewProject(projectId)).toBe(true);
});

it('reads Project on a new page when its scope was already suspended and the task cache fails', async () => {
  const current = scope();
  current.suspendProject(projectId);
  vi.spyOn(current, 'beginSync').mockRejectedValue(new Error('cache unavailable'));
  vi.mocked(getProject).mockReset().mockResolvedValue(graph.project);
  vi.mocked(getTaskSync).mockReturnValue(new Promise(() => {}));
  vi.mocked(getProjectAccess).mockRejectedValue(new ApiError('network'));
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={current}>
    <ProjectPage projectId={projectId} />
  </TestTaskCacheBoundary></LocaleProvider>);
  expect(await screen.findByRole('heading', { name: graph.project.name })).toBeVisible();
  expect(current.isProjectSuspended(projectId)).toBe(true);
  expect(current.getAuthorizedProject(projectId)).toBeNull();
});

it('rereads after a second withdrawal while access is already unavailable', async () => {
  const current = scope(); current.suspendProject(projectId);
  vi.spyOn(current, 'beginSync').mockReturnValue(new Promise(() => {}));
  vi.mocked(getTaskSync).mockReturnValue(new Promise(() => {}));
  const old = Promise.withResolvers<typeof graph.project>();
  vi.mocked(getProject).mockReset().mockResolvedValueOnce(graph.project).mockReturnValueOnce(old.promise)
    .mockResolvedValue({ ...graph.project, name: 'Current project' });
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={current}>
    <ProjectPage projectId={projectId} />
  </TestTaskCacheBoundary></LocaleProvider>);
  await screen.findByRole('heading', { name: graph.project.name });
  act(() => current.suspendProject(projectId));
  await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
  act(() => current.suspendProject(projectId));
  expect(await screen.findByRole('heading', { name: 'Current project' })).toBeVisible();
  await act(async () => old.resolve(graph.project));
  expect(screen.queryByRole('heading', { name: graph.project.name })).toBeNull();
  expect(current.isProjectSuspended(projectId)).toBe(true);
});

it('rereads independently on access restoration when task-cache preparation is stuck', async () => {
  const current = scope(); current.suspendProject(projectId);
  vi.spyOn(current, 'beginSync').mockReturnValue(new Promise(() => {}));
  vi.mocked(getTaskSync).mockReturnValue(new Promise(() => {}));
  vi.mocked(getProject).mockReset().mockResolvedValueOnce(graph.project).mockResolvedValue({ ...graph.project, name: 'Restored project' });
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={current}>
    <ProjectPage projectId={projectId} />
  </TestTaskCacheBoundary></LocaleProvider>);
  await screen.findByRole('heading', { name: graph.project.name });
  act(() => current.resumeProject(projectId));
  expect(await screen.findByRole('heading', { name: 'Restored project' })).toBeVisible();
  expect(current.getAuthorizedProject(projectId)).toBeNull();
});


it('retires old Project reads after an event-free transfer denial and reads the new state', async () => {
  const current = scope(); current.suspendProject(projectId);
  vi.spyOn(current, 'beginSync').mockReturnValue(new Promise(() => {}));
  vi.mocked(getTaskSync).mockReturnValue(new Promise(() => {}));
  const old = Promise.withResolvers<typeof graph.project>();
  vi.mocked(getProject).mockReset().mockResolvedValueOnce(graph.project).mockReturnValueOnce(old.promise)
    .mockResolvedValue({ ...graph.project, name: 'Current project' });
  let access: ProjectAccessSession | null = null;
  const Probe = () => { access = useProjectAccessSession(projectId); return null; };
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={current}>
    <ProjectAccessBoundary projectId={projectId}><Probe /><ProjectPage projectId={projectId} /></ProjectAccessBoundary>
  </TestTaskCacheBoundary></LocaleProvider>);
  await screen.findByRole('heading', { name: graph.project.name });
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
  act(() => access!.publishMutation(null));
  expect(await screen.findByRole('heading', { name: 'Current project' })).toBeVisible();
  await act(async () => old.resolve(graph.project));
  expect(screen.queryByRole('heading', { name: graph.project.name })).toBeNull();
  expect(current.isProjectSuspended(projectId)).toBe(true);
  expect(current.getAuthorizedProject(projectId)).toBeNull();
});

it('keeps task polling during an ordinary slow Project read', async () => {
  Reflect.set(globalThis, Symbol.for('daynight.pollingIntervals'), { taskSync: 20 });
  const current = scope();
  const pending = Promise.withResolvers<typeof graph.project>();
  vi.mocked(getProject).mockReset().mockImplementation((_id, _signal, _admission, onDispatch) => { onDispatch?.(); return pending.promise; });
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (_projectId, query) => taskSyncReadFixture(taskSyncFromGraph(graph, { query, versionForTask: () => 1n })));
  vi.mocked(getProjectAccess).mockReset().mockResolvedValue(directAccessFixture(projectId));
  try {
    render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={current}>
      <ProjectPage projectId={projectId} />
    </TestTaskCacheBoundary></LocaleProvider>);
    await waitFor(() => expect(vi.mocked(getTaskSync).mock.calls.length).toBeGreaterThan(2));
    await act(async () => pending.resolve(graph.project));
    expect(await screen.findByRole('heading', { name: graph.project.name })).toBeVisible();
  } finally { Reflect.deleteProperty(globalThis, Symbol.for('daynight.pollingIntervals')); }
});

it('bounds a stuck recovery read and resumes task polling', async () => {
  Reflect.set(globalThis, Symbol.for('daynight.pollingIntervals'), { taskSync: 20 });
  const current = scope();
  const slow = Promise.withResolvers<typeof graph.project>();
  vi.mocked(getProject).mockReset().mockResolvedValueOnce(graph.project).mockImplementation((_id, _signal, _admission, onDispatch) => { onDispatch?.(); return slow.promise; });
  vi.mocked(getTaskSync).mockReset().mockRejectedValue(new ApiError('network'));
  vi.mocked(getProjectAccess).mockReset().mockRejectedValue(new ApiError('network'));
  const nativeTimeout = globalThis.setTimeout;
  const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    nativeTimeout(handler, delay === 60_000 ? 120 : delay, ...args)) as typeof setTimeout);
  try {
    render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={current}>
      <ProjectPage projectId={projectId} />
    </TestTaskCacheBoundary></LocaleProvider>);
    await screen.findByRole('heading', { name: graph.project.name });
    act(() => current.suspendProject(projectId));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
    const reads = vi.mocked(getTaskSync).mock.calls.length;
    await screen.findByText('Could not read project information.');
    await waitFor(() => expect(vi.mocked(getTaskSync).mock.calls.length).toBeGreaterThan(reads));
    expect(current.isProjectSuspended(projectId)).toBe(true);
  } finally { timers.mockRestore(); Reflect.deleteProperty(globalThis, Symbol.for('daynight.pollingIntervals')); }
});

it('keeps a slow recovery read alive across automatic graph and access checks', async () => {
  Reflect.set(globalThis, Symbol.for('daynight.pollingIntervals'), { taskSync: 20 });
  const current = scope();
  const slow = Promise.withResolvers<typeof graph.project>();
  vi.mocked(getProject).mockReset().mockResolvedValueOnce(graph.project).mockImplementation((_id, _signal, _admission, onDispatch) => { onDispatch?.(); return slow.promise; });
  vi.mocked(getTaskSync).mockReset().mockRejectedValue(new ApiError('network'));
  vi.mocked(getProjectAccess).mockReset().mockRejectedValue(new ApiError('network'));
  try {
    render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={current}>
      <ProjectPage projectId={projectId} />
    </TestTaskCacheBoundary></LocaleProvider>);
    await screen.findByRole('heading', { name: graph.project.name });
    await waitFor(() => expect(getProjectAccess).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    act(() => current.suspendProject(projectId));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
    const graphReads = vi.mocked(getTaskSync).mock.calls.length;
    const accessReads = vi.mocked(getProjectAccess).mock.calls.length;
    fireEvent(window, new Event('focus'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
    expect(vi.mocked(getTaskSync).mock.calls.length).toBe(graphReads);
    expect(vi.mocked(getProjectAccess).mock.calls.length).toBe(accessReads);
    await act(async () => slow.resolve({ ...graph.project, name: 'Recovered project' }));
    expect(await screen.findByRole('heading', { name: 'Recovered project' })).toBeVisible();
    expect(current.isProjectSuspended(projectId)).toBe(true);
  } finally { Reflect.deleteProperty(globalThis, Symbol.for('daynight.pollingIntervals')); }
});

it('bounds a superseded Project denial with a fresh check despite continued task sync', async () => {
  Reflect.set(globalThis, Symbol.for('daynight.pollingIntervals'), { taskSync: 20 });
  const current = scope();
  const earlier = Promise.withResolvers<typeof graph.project>(), confirm = Promise.withResolvers<typeof graph.project>();
  vi.mocked(getProject).mockReset().mockResolvedValueOnce(graph.project)
    .mockImplementationOnce((_id, _signal, _admission, onDispatch) => { onDispatch?.(); return earlier.promise; })
    .mockImplementation((_id, _signal, _admission, onDispatch) => { onDispatch?.(); return confirm.promise; });
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (_projectId, query) => taskSyncReadFixture(taskSyncFromGraph(graph, { query, versionForTask: () => 1n })));
  vi.mocked(getProjectAccess).mockReset().mockResolvedValue(directAccessFixture(projectId));
  try {
    render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={current}>
      <ProjectPage projectId={projectId} />
    </TestTaskCacheBoundary></LocaleProvider>);
    await screen.findByRole('heading', { name: graph.project.name });
    await waitFor(() => expect(current.getAuthorizedProject(projectId)).not.toBeNull());
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
    const before = vi.mocked(getTaskSync).mock.calls.length;
    await waitFor(() => expect(vi.mocked(getTaskSync).mock.calls.length).toBeGreaterThan(before));
    await act(async () => earlier.reject(new ApiError('server', 404, 'not_found')));
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(3));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    const graphReads = vi.mocked(getTaskSync).mock.calls.length;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
    expect(vi.mocked(getTaskSync).mock.calls.length).toBe(graphReads);
    await act(async () => confirm.reject(new ApiError('server', 404, 'not_found')));
    await waitFor(() => expect(current.getAuthorizedProject(projectId)).toBeNull());
    expect(screen.queryByRole('heading', { name: graph.project.name })).toBeNull();
  } finally { Reflect.deleteProperty(globalThis, Symbol.for('daynight.pollingIntervals')); }
});

it('rereads Project after an independent access denial while an older Project read is pending', async () => {
  const current = scope();
  const earlier = Promise.withResolvers<typeof graph.project>();
  const denied = Promise.withResolvers<ReturnType<typeof directAccessFixture>>();
  vi.mocked(getProject).mockReset().mockReturnValueOnce(earlier.promise).mockResolvedValue({ ...graph.project, name: 'Current project' });
  vi.mocked(getTaskSync).mockReset().mockReturnValue(new Promise(() => {}));
  vi.mocked(getProjectAccess).mockReset().mockReturnValueOnce(denied.promise).mockRejectedValue(new ApiError('network'));
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={current}>
    <ProjectPage projectId={projectId} />
  </TestTaskCacheBoundary></LocaleProvider>);
  await waitFor(() => expect(getProject).toHaveBeenCalledOnce());
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalledOnce());
  await act(async () => denied.reject(new ApiError('server', 404, 'not_found')));
  await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole('heading', { name: 'Current project' })).toBeVisible();
  await act(async () => earlier.resolve(graph.project));
  expect(screen.queryByRole('heading', { name: graph.project.name })).toBeNull();
});

it('does not repeatedly reread Project when Project and its access recheck both return 404', async () => {
  const current = scope();
  vi.mocked(getProject).mockReset().mockRejectedValue(new ApiError('server', 404, 'not_found'));
  vi.mocked(getTaskSync).mockReset().mockReturnValue(new Promise(() => {}));
  vi.mocked(getProjectAccess).mockReset().mockRejectedValue(new ApiError('server', 404, 'not_found'));
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={current}>
    <ProjectPage projectId={projectId} />
  </TestTaskCacheBoundary></LocaleProvider>);
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalled());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
  expect(getProject).toHaveBeenCalledOnce();
  expect(vi.mocked(getProjectAccess).mock.calls.length).toBeLessThanOrEqual(2);
});

it('keeps task data when an older task-sync 404 arrives after a newer Project read', async () => {
  const current = scope(); await admit(current);
  const old = Promise.withResolvers<ReturnType<typeof taskSyncReadFixture>>();
  vi.mocked(getTaskSync).mockReset().mockReturnValueOnce(old.promise).mockReturnValue(new Promise(() => {}));
  vi.mocked(getProject).mockReset().mockResolvedValueOnce(graph.project).mockResolvedValue({ ...graph.project, name: 'Current project' });
  vi.mocked(getProjectAccess).mockReset().mockRejectedValue(new ApiError('network'));
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={current}>
    <ProjectPage projectId={projectId} />
  </TestTaskCacheBoundary></LocaleProvider>);
  await screen.findByRole('heading', { name: graph.project.name });
  await waitFor(() => expect(getTaskSync).toHaveBeenCalledOnce());
  fireEvent(window, new Event('focus'));
  const heading = await screen.findByRole('heading', { name: 'Current project' });
  heading.focus();
  await act(async () => old.reject(new ApiError('server', 404, 'not_found')));
  await waitFor(() => expect(vi.mocked(getProject).mock.calls.length).toBeGreaterThan(2));
  expect(screen.getByRole('heading', { name: 'Current project' })).toBe(heading);
  expect(heading).toHaveFocus();
  expect(current.getAuthorizedProject(projectId)).not.toBeNull();
});

it('rechecks a same-generation peer denial instead of erasing a newer readable Project', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const sender = scope(); await admit(sender);
  const peer = scope(); await admit(peer);
  const ticket = await sender.beginSync(projectId, sender.signal);
  const session = new ProjectAccessSession(projectId, peer);
  expect(session.publishProjectRead(session.beginObservation())).toBe(true);
  const held = Promise.withResolvers<ReturnType<typeof directAccessFixture>>();
  vi.mocked(getProjectAccess).mockReset().mockReturnValue(held.promise);
  const events: { accessRevoked?: true }[] = [];
  peer.subscribe(event => events.push(event));
  await sender.revokeProject(ticket, sender.signal);
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalled());
  expect(peer.getAuthorizedProject(projectId)).not.toBeNull();
  expect(events).not.toContainEqual(expect.objectContaining({ accessRevoked: true }));
  await act(async () => held.resolve(directAccessFixture(projectId)));
  expect(peer.getAuthorizedProject(projectId)).not.toBeNull();
});

it('propagates a confirmed deletion despite a peer Project read', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const sender = scope(); await admit(sender);
  const peer = scope(); await admit(peer);
  const ticket = await sender.beginSync(projectId, sender.signal);
  const session = new ProjectAccessSession(projectId, peer);
  expect(session.publishProjectRead(session.beginObservation())).toBe(true);
  await sender.revokeProject(ticket, sender.signal, true, undefined, true, undefined, { confirmedDeletion: true });
  await waitFor(() => expect(peer.getAuthorizedProject(projectId)).toBeNull());
});

it('withdraws a readable peer only after its own access check confirms a same-generation denial', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const sender = scope(); await admit(sender);
  const peer = scope(); await admit(peer);
  const ticket = await sender.beginSync(projectId, sender.signal);
  const session = new ProjectAccessSession(projectId, peer);
  expect(session.publishProjectRead(session.beginObservation())).toBe(true);
  const held = Promise.withResolvers<ReturnType<typeof directAccessFixture>>();
  vi.mocked(getProjectAccess).mockReset().mockReturnValue(held.promise);
  await sender.revokeProject(ticket, sender.signal);
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalled());
  expect(peer.getAuthorizedProject(projectId)).not.toBeNull();
  await act(async () => held.reject(new ApiError('server', 404, 'not_found')));
  await waitFor(() => expect(peer.getAuthorizedProject(projectId)).toBeNull());
});

it('immediately withdraws a Project-only peer on a confirmed deletion without a cache fence', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const sender = scope(); await admit(sender);
  const ticket = await sender.beginSync(projectId, sender.signal);
  const peer = scope(); vi.spyOn(peer, 'beginSync').mockRejectedValue(new Error('cache unavailable'));
  const held = Promise.withResolvers<typeof graph.project>();
  vi.mocked(getProject).mockReset().mockResolvedValueOnce(graph.project).mockReturnValue(held.promise);
  vi.mocked(getTaskSync).mockReset().mockReturnValue(new Promise(() => {}));
  vi.mocked(getProjectAccess).mockReset().mockRejectedValue(new ApiError('network'));
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={peer}>
    <ProjectPage projectId={projectId} />
  </TestTaskCacheBoundary></LocaleProvider>);
  await screen.findByRole('heading', { name: graph.project.name });
  await sender.revokeProject(ticket, sender.signal, true, undefined, true, undefined, { confirmedDeletion: true });
  await waitFor(() => expect(peer.isProjectSuspended(projectId)).toBe(true));
  expect(screen.queryByRole('heading', { name: graph.project.name })).toBeNull();
  await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
});

it('independently checks a transfer denial and keeps a peer Project already observed as readable', async () => {
  vi.stubGlobal('BroadcastChannel', Channel);
  const sender = scope(); await admit(sender);
  const ticket = await sender.beginSync(projectId, sender.signal);
  const peer = scope(); vi.spyOn(peer, 'beginSync').mockRejectedValue(new Error('cache unavailable'));
  const accessCheck = Promise.withResolvers<ReturnType<typeof directAccessFixture>>();
  vi.mocked(getProject).mockReset().mockResolvedValue(graph.project);
  vi.mocked(getTaskSync).mockReset().mockReturnValue(new Promise(() => {}));
  vi.mocked(getProjectAccess).mockReset().mockReturnValue(accessCheck.promise);
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={peer}>
    <ProjectPage projectId={projectId} />
  </TestTaskCacheBoundary></LocaleProvider>);
  const heading = await screen.findByRole('heading', { name: graph.project.name });
  await sender.revokeProject(ticket, sender.signal);
  await waitFor(() => expect(vi.mocked(getProjectAccess).mock.calls.length).toBeGreaterThan(0));
  expect(screen.getByRole('heading', { name: graph.project.name })).toBe(heading);
  expect(peer.isProjectSuspended(projectId)).toBe(false);
  await act(async () => accessCheck.resolve(directAccessFixture(projectId)));
  expect(screen.getByRole('heading', { name: graph.project.name })).toBe(heading);
});
