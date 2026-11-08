import { readFileSync } from 'node:fs';
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TaskDetail, TaskSync, WorkerClaim } from '../src/api/types';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { deriveTaskSyncBindings } from '../src/features/task-cache/execution-binding';
import { TaskSessionSummaryProvider, useChainSessionSummary, useSessionChainVisibility, useTaskSessionSummary } from '../src/features/task-session-summary/TaskSessionSummaryProvider';
import { TaskSessionSummaryStore } from '../src/features/task-session-summary/store';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';
import type { TaskSessionSnapshot } from './helpers/session';

const original = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')) as TaskSessionSnapshot;
const projectId = original.identity.projectId;
const taskId = original.identity.taskId;
const childId = '10000000-0000-4000-8000-000000000002';
const otherId = '10000000-0000-4000-8000-000000000003';
const worker: WorkerClaim = { claimId: original.claimId, state: 'active', userId: TEST_VIEWER_ID, workerId: original.identity.workerId,
  machine: { id: original.identity.workerId, name: 'test' }, platform: 'macos', agent: 'codex', agentControlMode: 'web', worktreeId: original.identity.worktreeId,
  phase: 'executing', herdr: null, nativeSessionId: 'native-thread-1', claimedAt: '2026-10-22T10:00:00Z' };
const scopes: TaskCacheScope[] = [];
const stores: TaskSessionSummaryStore[] = [];
async function seed(sessions: TaskSync['sessions'] = { [taskId]: 'notice' }) {
  const tasks: TaskDetail[] = [taskId, childId, otherId].map((id) => detailFixture(projectId, id, {
    status: 'in_progress', startedAt: '2026-10-22T10:00:00Z', properties: { worker: { ...worker } },
  }));
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const signal = new AbortController().signal; const ticket = await scope.beginSync(projectId, signal);
  const sync = taskSyncFromGraph(graphFixture(tasks), { sessions, versionForTask: () => 1n, propertiesForTask: () => ({ worker: { ...worker } }) });
  const result = await scope.applySync(ticket, sync, signal);
  const store = new TaskSessionSummaryStore(scope, projectId); stores.push(store); store.start();
  store.replace({ project: result.project, observedBindings: deriveTaskSyncBindings(ticket, sync), sessions: sync.sessions, receivedMonotonic: performance.now() });
  return { scope, store };
}
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose()); scopes.splice(0).forEach((scope) => scope.dispose());
});
const Probe = ({ members = [taskId] }: { readonly members?: readonly string[] }) => {
  const observe = useSessionChainVisibility('chain', members);
  const summary = useTaskSessionSummary(taskId); const chain = useChainSessionSummary(members);
  return <section ref={observe} data-testid="chain"><span data-testid="single" data-readable={summary !== null}>{summary?.indicator ?? 'none'}</span><span data-testid="aggregate">{chain ?? 'none'}</span></section>;
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
  render(<Probe />); expect(screen.getByTestId('single')).toHaveTextContent('none'); expect(screen.getByTestId('single')).toHaveAttribute('data-readable', 'false'); expect(screen.getByTestId('aggregate')).toHaveTextContent('none');
});
it('projects intersecting chains from the shared snapshot without issuing HTTP', async () => {
  const { store } = await seed(); const io = observerFixture(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const view = render(<TaskSessionSummaryProvider store={store}><Probe /></TaskSessionSummaryProvider>);
  expect(screen.getByTestId('single')).toHaveTextContent('none'); act(() => io.visible(0, true));
  expect(screen.getByTestId('single')).toHaveTextContent('notice'); expect(screen.getByTestId('aggregate')).toHaveTextContent('notice');
  act(() => io.visible(0, false)); expect(screen.getByTestId('single')).toHaveTextContent('none');
  act(() => io.visible(0, true)); expect(screen.getByTestId('single')).toHaveTextContent('notice');
  view.unmount(); expect(io.observers[0]!.disconnect).toHaveBeenCalled();
  act(() => io.visible(0, true)); expect(fetch).not.toHaveBeenCalled();
});
it('retains the page source across presentation departure and ignores obsolete observers', async () => {
  const { store } = await seed(); const io = observerFixture(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const Host = ({ members, active }: { readonly members: readonly string[]; readonly active: boolean }) => <TaskSessionSummaryProvider store={store} active={active}><Probe members={members} /></TaskSessionSummaryProvider>;
  const view = render(<Host members={[taskId]} active />); act(() => io.visible(0, true)); expect(screen.getByTestId('single')).toHaveTextContent('notice');
  view.rerender(<Host members={[]} active />); act(() => io.visible(0, true)); expect(screen.getByTestId('single')).toHaveTextContent('none');
  view.rerender(<Host members={[taskId]} active={false} />); act(() => io.visible(2, true)); expect(screen.getByTestId('single')).toHaveTextContent('none');
  view.rerender(<Host members={[taskId]} active />); expect(screen.getByTestId('single')).toHaveTextContent('notice');
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps the pending entry readable without displaying an annotation', async () => {
  const { store } = await seed({ [taskId]: 'pending' }); const io = observerFixture();
  render(<TaskSessionSummaryProvider store={store}><Probe /></TaskSessionSummaryProvider>); act(() => io.visible(0, true));
  expect(screen.getByTestId('single')).toHaveTextContent('none'); expect(screen.getByTestId('single')).toHaveAttribute('data-readable', 'true');
  expect(screen.getByTestId('aggregate')).toHaveTextContent('none');
});
it('aggregates the registered root and all ordinary members while excluding unrelated chains', async () => {
  const { store } = await seed({ [taskId]: 'notice', [childId]: 'working', [otherId]: 'warning' }); const io = observerFixture();
  render(<TaskSessionSummaryProvider store={store}><Probe members={[taskId, childId]} /></TaskSessionSummaryProvider>); act(() => io.visible(0, true));
  expect(screen.getByTestId('single')).toHaveTextContent('notice'); expect(screen.getByTestId('aggregate')).toHaveTextContent('notice');
});
