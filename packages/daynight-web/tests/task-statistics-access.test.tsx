import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskStatistics } from '../src/features/project-statistics/TaskStatistics';
import { createDateWindow } from '../src/features/project-statistics/date-window';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { createTaskCacheScope, type CacheEvent, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { createLocaleRender } from './helpers/renderWithLocale';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { directAccessFixture, taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';
import { wireResponse } from './helpers/wireJson';

vi.mock('../src/features/task-assignees/TaskAssignees', () => ({ useTaskAssigneeDemand: () => ({ people: new Map() }) }));
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const assignee = '30000000-0000-4000-8000-000000000001';
const signal = () => new AbortController().signal;
const scopes: TaskCacheScope[] = [];
class Channel {
  static channels = new Set<Channel>();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(readonly name: string) { Channel.channels.add(this); }
  postMessage(value: unknown) { for (const peer of Channel.channels) if (peer !== this && peer.name === this.name) queueMicrotask(() => peer.onmessage?.({ data: value } as MessageEvent<unknown>)); }
  close() { Channel.channels.delete(this); }
}
const scope = () => { const result = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(result); return result; };
const apply = async (cache: TaskCacheScope) => {
  const detail = detailFixture(projectId, taskId);
  const ticket = await cache.beginSync(projectId, signal());
  await cache.applySync(ticket, taskSyncFromGraph(graphFixture([detail]), { query: ticket.epoch === null ? {} : { epoch: ticket.epoch }, versionForTask: () => detail.version, propertiesForTask: () => detail.properties }), signal());
};
const snapshot = { graph: { tasks: [
  { id: taskId, createdAt: '2026-03-08T00:00:00Z', assignedTo: assignee },
  { id: '20000000-0000-4000-8000-000000000002', createdAt: '2026-03-08T00:00:00Z', assignedTo: null },
] }, observedAt: '2026-03-08T12:00:00Z', revision: 1 } as unknown as GraphSnapshot;
const window = createDateWindow(Date.parse('2026-03-08T12:00:00Z'), () => 0);
const render = createLocaleRender('en');
beforeEach(() => { Channel.channels.clear(); vi.stubGlobal('BroadcastChannel', Channel); });
afterEach(() => { scopes.splice(0).forEach(cache => cache.dispose()); vi.unstubAllGlobals(); });

it.each(['allowed', 'denied'] as const)('uses the real cross-tab direct access recheck to handle %s access', async (outcome) => {
  const owner = scope(), peer = scope();
  await apply(owner); await apply(peer);
  await peer.beginTaskRead(projectId, taskId, 1, 1, signal());
  const ticket = await owner.beginSync(projectId, signal());
  const events: CacheEvent[] = []; peer.subscribe(event => events.push(event));
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal('fetch', fetcher);
  const content = (current: GraphSnapshot | null) => <TaskCacheProvider scope={peer}><TaskStatistics projectId={projectId} snapshot={current} error={null} onRetry={() => {}} window={window} /></TaskCacheProvider>;
  const view = render(content(snapshot));
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter tasks by assignee' }), { target: { value: assignee } });
  expect(within(screen.getByRole('listbox', { name: 'Tasks created daily' })).getAllByRole('option')[29]).toHaveAccessibleName(/: 1$/);
  await act(async () => { await owner.revokeProject(ticket, signal()); });
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(events.some(event => event.directAccessUncertain && event.accessRevoked && (event.error as { status?: number })?.status === 404)).toBe(true);
  expect(events.some(event => event.accessRevoked && event.peerHintWithdrawal && !event.directAccessUncertain && (event.error as { status?: number })?.status === 404)).toBe(true);
  view.rerender(content(null));
  const response = outcome === 'allowed'
    ? wireResponse(directAccessFixture(projectId), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })
    : wireResponse({ error: { code: 'not_found', message: 'not found', requestId: 'denied' } }, { status: 404, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
  await act(async () => { resolve(response); });
  await waitFor(() => expect(events.some(event => event.directAccessRecheck && (outcome === 'allowed' ? event.error === undefined : (event.error as { status?: number })?.status === 404))).toBe(true));
  view.rerender(content(snapshot));
  expect(screen.getByRole('combobox', { name: 'Filter tasks by assignee' })).toHaveValue(outcome === 'allowed' ? assignee : '');
  expect(within(screen.getByRole('listbox', { name: 'Tasks created daily' })).getAllByRole('option')[29]).toHaveAccessibleName(outcome === 'allowed' ? /: 1$/ : /: 2$/);
  view.unmount();
});
