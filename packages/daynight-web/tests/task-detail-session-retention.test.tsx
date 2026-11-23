import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { browserNavigation } from '../src/app/navigation';
import { getTask } from '../src/api/client';
import { TaskDetailSurface } from '../src/features/task-detail/TaskDetailSurface';
import { TaskDetailSessionBoundary } from '../src/features/task-detail/TaskDetailSession';
import { detailFixture, graphFixture, snapshotFixture } from './helpers/taskDetail';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';
import { renderWithLocale } from './helpers/renderWithLocale';

vi.mock('../src/api/client', async (original) => { const actual = await original<typeof import('../src/api/client')>(); const { fixtureTaskEpoch } = await import('./helpers/taskSync'); const read = vi.fn(); return { ...actual, getTask: read, getTaskObservation: async (...args: Parameters<typeof actual.getTask>) => ({ detail: await read(...(args[4] === undefined ? args.slice(0, 4) : args)), epoch: fixtureTaskEpoch(args[0]) }) }; });
vi.mock('../src/features/task-agent-session/TaskAgentSession', () => ({ TaskAgentSession: () => <div>Private session</div> }));
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const otherId = '20000000-0000-4000-8000-000000000002';
const detail = detailFixture(projectId, taskId, { title: 'Current task', description: 'Private confirmed text', version: 5n });
const other = detailFixture(projectId, otherId);
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const api = { list: vi.fn(async () => ({ items: [], nextCursor: null })), put: vi.fn(), remove: vi.fn(), readText: vi.fn() };
afterEach(() => { cleanup(); browserNavigation().dispose(); vi.restoreAllMocks(); });

it('keeps the Session selection without retaining its private content while the new generation is unreadable', async () => {
  const claim = { claimId: '30000000-0000-4000-8000-000000000001', state: 'active', userId: TEST_VIEWER_ID,
    workerId: '40000000-0000-4000-8000-000000000001', machine: { id: '50000000-0000-4000-8000-000000000001', name: 'worker' },
    platform: 'macos', agent: 'codex', agentControlMode: 'web', worktreeId: '60000000-0000-4000-8000-000000000001',
    phase: 'executing', herdr: null, nativeSessionId: 'session', claimedAt: '2026-11-04T00:00:00Z' };
  const running = detailFixture(projectId, taskId, { title: 'Running task', status: 'in_progress', ready: false, properties: { worker: claim }, version: 5n });
  const world = createTaskSessionWorld(); await world.sync([running, other]);
  const replacement = deferred<typeof running>(); const onNavigate = vi.fn();
  vi.mocked(getTask).mockReset().mockResolvedValueOnce(running).mockReturnValueOnce(replacement.promise);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')));
  const view = (revision: number, tasks: typeof detail[]) => <TaskDetailSessionBoundary><TaskDetailSurface presentation="page" fullscreen={{ active: false, onChange: vi.fn() }} projectId={projectId} taskId={taskId} snapshot={snapshotFixture(tasks, revision)} navigation={{ tab: 'session', path: null }} attachmentApi={api} onNavigate={onNavigate} onSelectTask={vi.fn()} onRefreshGraph={vi.fn()} /></TaskDetailSessionBoundary>;
  const rendered = renderWithLocale(view(1, [running, other]), { locale: 'en', taskCache: { scope: world.scope } });
  try {
    await screen.findByText('Private session');
    let ticket = await world.scope.beginSync(projectId, world.scope.signal);
    await act(async () => {
      await world.scope.observeHistory(ticket, '30000000-0000-4000-8000-000000000003', world.scope.signal);
      ticket = await world.scope.beginSync(projectId, world.scope.signal);
      await world.scope.applySync(ticket, taskSyncFromGraph(graphFixture([running]), { epoch: '30000000-0000-4000-8000-000000000003', versionForTask: () => running.version, propertiesForTask: () => running.properties }), world.scope.signal);
    });
    rendered.rerender(view(2, [running]));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Private session')).toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
  } finally { world.dispose(); }
});
