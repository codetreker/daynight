import { readFileSync } from 'node:fs';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TaskDetail, WorkerClaim } from '../src/api/types';
import { TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { TaskSessionSummaryProvider, useChainSessionSummary, useSessionChainVisibility, useTaskSessionSummary } from '../src/features/task-session-summary/TaskSessionSummaryProvider';
import { detailFixture, graphFixture, resourceResponse } from './helpers/taskDetail';
import { taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';
import type { TaskSessionSnapshot } from './helpers/session';

const original = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')) as TaskSessionSnapshot;
const projectId = original.identity.projectId; const taskId = original.identity.taskId;
const worker: WorkerClaim = { claimId: original.claimId, state: 'active', userId: TEST_VIEWER_ID, workerId: original.identity.workerId,
  machine: { id: original.identity.workerId, name: 'test' }, platform: 'macos', agent: 'codex', agentControlMode: 'web', worktreeId: original.identity.worktreeId,
  phase: 'executing', herdr: null, nativeSessionId: 'native-thread-1', claimedAt: '2026-10-22T10:00:00Z' };
const scopes: TaskCacheScope[] = [];
async function seed() {
  const task: TaskDetail = detailFixture(projectId, taskId, { status: 'in_progress', startedAt: '2026-10-22T10:00:00Z', properties: { worker: { ...worker } } });
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const signal = new AbortController().signal; const ticket = await scope.beginSync(projectId, signal);
  await scope.applySync(ticket, taskSyncFromGraph(graphFixture([task]), { versionForTask: () => 1n, propertiesForTask: () => task.properties }), signal);
  return scope;
}
afterEach(() => scopes.splice(0).forEach((scope) => scope.dispose()));
const Probe = ({ members = [taskId] }: { readonly members?: readonly string[] }) => {
  const observe = useSessionChainVisibility('chain', members);
  const summary = useTaskSessionSummary(taskId); const chain = useChainSessionSummary(members);
  return <section ref={observe} data-testid="chain"><span data-testid="single">{summary?.indicator ?? 'none'}</span><span data-testid="aggregate">{chain ?? 'none'}</span></section>;
};
function observerFixture() {
  const observers: { callback: IntersectionObserverCallback; element: Element | null; disconnect: ReturnType<typeof vi.fn<() => void>> }[] = [];
  class Observer {
    record: typeof observers[number];
    constructor(callback: IntersectionObserverCallback) { this.record = { callback, element: null, disconnect: vi.fn() }; observers.push(this.record); }
    observe(element: Element) { this.record.element = element; }
    disconnect() { this.record.disconnect(); }
  }
  vi.stubGlobal('IntersectionObserver', Observer);
  const visible = (index: number, isIntersecting: boolean) => { const record = observers[index]!; record.callback([{ target: record.element!, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver); };
  return { observers, visible };
}
it('keeps standalone list rendering safe without a summary provider', () => {
  render(<Probe />); expect(screen.getByTestId('single')).toHaveTextContent('none'); expect(screen.getByTestId('aggregate')).toHaveTextContent('none');
});
it('reads only intersecting chains, shares one result and removes hidden entries', async () => {
  const scope = await seed(); const io = observerFixture();
  const fetch = vi.fn().mockImplementation(() => resourceResponse({ status: 'registered', session: { ...original, activity: 'waiting_input', operations: { canSend: false, canRespond: true, canCancel: false } } }, TEST_VIEWER_ID)); vi.stubGlobal('fetch', fetch);
  const view = render(<TaskCacheProvider scope={scope}><TaskSessionSummaryProvider projectId={projectId}><Probe /></TaskSessionSummaryProvider></TaskCacheProvider>);
  expect(fetch).not.toHaveBeenCalled(); act(() => io.visible(0, true));
  await waitFor(() => expect(screen.getByTestId('single')).toHaveTextContent('notice'));
  expect(screen.getByTestId('aggregate')).toHaveTextContent('notice'); expect(fetch).toHaveBeenCalledOnce();
  act(() => io.visible(0, false)); expect(screen.getByTestId('single')).toHaveTextContent('none');
  view.unmount(); expect(io.observers[0]!.disconnect).toHaveBeenCalled();
  act(() => io.visible(0, true)); expect(fetch).toHaveBeenCalledOnce();
});
it('cancels the departed page and ignores an old observer after membership changes', async () => {
  const scope = await seed(); const io = observerFixture(); const fetch = vi.fn().mockImplementation(() => resourceResponse({ status: 'registered', session: original }, TEST_VIEWER_ID)); vi.stubGlobal('fetch', fetch);
  const Host = ({ members, active }: { readonly members: readonly string[]; readonly active: boolean }) => <TaskCacheProvider scope={scope}><TaskSessionSummaryProvider projectId={projectId} active={active}><Probe members={members} /></TaskSessionSummaryProvider></TaskCacheProvider>;
  const view = render(<Host members={[taskId]} active />); act(() => io.visible(0, true)); await waitFor(() => expect(screen.getByTestId('single')).toHaveTextContent('warning'));
  view.rerender(<Host members={[]} active />); act(() => io.visible(0, true)); expect(screen.getByTestId('single')).toHaveTextContent('none'); expect(fetch).toHaveBeenCalledOnce();
  view.rerender(<Host members={[taskId]} active={false} />); act(() => io.visible(2, true)); expect(fetch).toHaveBeenCalledOnce();
  view.rerender(<Host members={[taskId]} active />); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});
