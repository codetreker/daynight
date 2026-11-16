import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalTaskItem } from '../src/api/personal-tasks';
import { MyTasksPage } from '../src/features/my-tasks/MyTasksPage';
import { renderWithLocale } from './helpers/renderWithLocale';
import { unsupportedSessionObservation } from '../../daynight/src/api/task-observation';
import { CurrentAccountProvider } from '../src/app/CurrentAccountContext';
import { TEST_VIEWER_ID } from './helpers/taskSync';

const mock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../src/features/my-tasks/useMyTasks', () => ({ useMyTasks: () => mock.value }));
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const anchor = '2026-11-13T10:00:00Z';
const activeWorker = { workerId: id(70), state: 'active' as const, machine: { id: id(71), name: 'Current machine' } };
const item = (n: number, overrides: Partial<PersonalTaskItem> = {}): PersonalTaskItem => ({
  project: { id: id(1), name: 'Project', ownerTeam: { id: id(2), kind: 'ordinary', name: 'Team' }, executionWarningMinutes: 120, matchedTaskCount: 17 },
  task: { id: id(n + 10), version: '123456789012345', title: `Task ${n}`, status: 'in_progress', startedAt: '2026-11-13T09:00:00Z', createdAt: '2026-11-13T09:00:00Z', requiredPlatform: null, tags: [], blockedBy: [], ready: false, allowAgents: true, paused: false, worker: null, goal: null },
  session: unsupportedSessionObservation(),
  sessionRow: { taskVersion: 123456789012345n, state: 'no_session', observedAt: anchor, freshUntil: '2026-11-13T10:01:00Z', needsAttention: null, canOpen: false },
  observedAt: anchor, responseTaskAt: anchor, responseSessionAt: anchor, receivedMonotonic: performance.now(), ...overrides,
});
const state = (items: PersonalTaskItem[], overrides: Record<string, unknown> = {}) => ({ items, totalTaskCount: items.length, totalProjectCount: items.length ? 1 : 0, observedAt: anchor, receivedMonotonic: performance.now(), sessionPartial: false, loading: false, loaded: true, stale: false, error: null, refresh: vi.fn(), ...overrides });
beforeEach(() => history.replaceState(null, '', '/my-tasks'));
afterEach(() => vi.useRealTimers());

describe('personal task overview', () => {
  it('shows each current Worker independently of Session and pause, and updates on refresh', () => {
    const a = item(0), b = item(1), c = item(2);
    const worker = (n: number, name: string) => ({ workerId: id(n), state: 'active' as const, machine: { id: id(n + 10), name } });
    mock.value = state([
      { ...a, task: { ...a.task, worker: worker(70, '<worker-one>'), paused: true }, sessionRow: { ...a.sessionRow, state: 'unavailable' } },
      { ...b, task: { ...b.task, worker: worker(71, '第二台机器') }, sessionRow: { ...b.sessionRow, state: 'not_registered', freshUntil: '2026-11-13T09:59:59Z' } },
      c,
    ], { sessionPartial: true });
    const view = renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    expect(screen.getByText('Claim machine: <worker-one>')).toBeInTheDocument();
    expect(screen.getByText('Claim machine: 第二台机器')).toBeInTheDocument();
    expect(within(screen.getByText('Task 2').closest('li')!).getByText('No machine record')).toBeInTheDocument();
    expect(screen.getByText('Session unavailable')).toBeInTheDocument();
    expect(screen.getByText('Session observation expired')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    view.setLocale('zh-CN');
    expect(screen.getByText('认领机器：<worker-one>')).toBeInTheDocument();
    expect(screen.getByText('认领机器：第二台机器')).toBeInTheDocument();
    mock.value = state([{ ...a, task: { ...a.task, worker: worker(72, 'replacement') }, sessionRow: { ...a.sessionRow, state: 'not_registered' } }, b]);
    view.rerender(<MyTasksPage />);
    expect(screen.queryByText('认领机器：<worker-one>')).not.toBeInTheDocument();
    expect(screen.getByText('认领机器：replacement')).toBeInTheDocument();
    expect(screen.queryByText('认领机器：第二台机器')).not.toBeInTheDocument();
  });
  it('shows the returned task fields and retained Worker states', () => {
    const a = item(0), b = item(1), c = item(2);
    mock.value = state([
      { ...a, task: { ...a.task, requiredPlatform: 'linux', tags: [{ id: id(90), name: 'Urgent' }, { id: id(91), name: '前端' }], blockedBy: [id(80)], worker: { workerId: id(70), state: 'completed', machine: { id: id(71), name: 'Previous machine' } } } },
      { ...b, task: { ...b.task, worker: activeWorker }, sessionRow: { ...b.sessionRow, state: 'not_registered' } }, c,
    ]);
    const view = renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    const first = within(screen.getByText('Task 0').closest('li')!);
    expect(first.getByText('Recorded machine: Previous machine')).toBeInTheDocument();
    expect(first.getByText('Linux')).toBeInTheDocument();
    expect(first.getByText('Blocked')).toBeInTheDocument();
    expect(first.getByText('Urgent')).toBeInTheDocument();
    expect(first.getByText('前端')).toBeInTheDocument();
    expect(first.getByText(a.task.id)).toBeInTheDocument();
    expect(first.getByRole('button', { name: 'Copy task ID' })).toBeInTheDocument();
    expect(first.queryByRole('link', { name: /View Goal/ })).not.toBeInTheDocument();
    expect(first.getByText(/Created on/)).toHaveAttribute('datetime', a.task.createdAt);
    expect(screen.getByText('Claim machine: Current machine')).toBeInTheDocument();
    expect(screen.getByText('No machine record')).toBeInTheDocument();
    view.setLocale('zh-CN');
    expect(screen.getByText('执行机器记录：Previous machine')).toBeInTheDocument();
    expect(screen.getByText('被阻塞')).toBeInTheDocument();
  });

  it('retains the page across refresh, clamps it after removal, and links to the real Task and Goal', () => {
    const items = Array.from({ length: 17 }, (_, i) => item(i));
    const last = items[16]!;
    items[16] = { ...last, task: { ...last.task, goal: { id: id(55), title: 'Release goal' } } };
    mock.value = state(items);
    const view = renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    expect(screen.getByText('17 in progress')).toBeInTheDocument();
    expect(screen.getByText('Tasks: 17 · Projects: 1')).toBeInTheDocument();
    expect(screen.queryByText('Task 16')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('link', { name: 'Task 16' })).toHaveAttribute('href', `/projects/${id(1)}/tasks/${last.task.id}`);
    expect(screen.getByRole('link', { name: 'View Goal: Release goal' })).toHaveAttribute('href', `/projects/${id(1)}/tasks/${id(55)}`);
    mock.value = state(items.map(i => ({ ...i })));
    view.rerender(<MyTasksPage />);
    expect(screen.getByText('Task 16')).toBeInTheDocument();
    mock.value = state(items.slice(0, 3), { totalTaskCount: null, totalProjectCount: null, loading: true, loaded: false });
    view.rerender(<MyTasksPage />);
    expect(screen.getByText('Task 0')).toBeInTheDocument();
    mock.value = state([], { totalTaskCount: null, totalProjectCount: null, loaded: false });
    view.rerender(<MyTasksPage />);
    mock.value = state(items);
    view.rerender(<MyTasksPage />);
    expect(screen.getByText('Task 16')).toBeInTheDocument();
    mock.value = state(items.slice(0, 3));
    view.rerender(<MyTasksPage />);
    expect(screen.getByText('Task 0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  it('does not present partial or failed results as a complete empty list or full count', () => {
    const a = item(0);
    mock.value = state([a], { totalTaskCount: null, totalProjectCount: null, loaded: false, error: new Error('failed') });
    const view = renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    expect(screen.getByRole('alert')).toHaveTextContent('Tasks could not be updated');
    expect(screen.getByText('The task list is incomplete; counts cannot be confirmed.')).toBeInTheDocument();
    expect(screen.getByText('1 loaded')).toBeInTheDocument();
    expect(screen.queryByText('Tasks: 1 · Projects: 1')).not.toBeInTheDocument();
    expect(screen.queryByText('17 in progress')).not.toBeInTheDocument();
    mock.value = state([], { totalTaskCount: null, totalProjectCount: null, loaded: false, error: new Error('failed') });
    view.rerender(<MyTasksPage />);
    expect(screen.queryByText('No in-progress tasks')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mock.value.refresh).toHaveBeenCalledOnce();
  });

  it('uses full project IDs to distinguish identical names and spaces', () => {
    const a = item(0); const b = item(1);
    mock.value = state([a, { ...b, project: { ...b.project, id: id(3) } }], { totalProjectCount: 2 });
    renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    expect(screen.getByRole('region', { name: `Project · Team · ${id(1)}` })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: `Project · Team · ${id(3)}` })).toBeInTheDocument();
    expect(screen.getByText(id(1))).toBeInTheDocument();
    expect(screen.getByText(id(3))).toBeInTheDocument();
  });
  it('uses the verified current account before opening a project and reloads changed avatars', () => {
    mock.value = state([item(0)]);
    const user: { id: string; name: string | null; avatarUrl: string | null } = { id: TEST_VIEWER_ID, name: 'Current Alice', avatarUrl: '/avatar-one.png' };
    const page = (profile = user) => <CurrentAccountProvider user={profile} admissionBlocked={false}><MyTasksPage /></CurrentAccountProvider>;
    const view = renderWithLocale(page(), { locale: 'en', taskCache: true });
    expect(screen.getByText('Current Alice')).toBeInTheDocument();
    const row = screen.getByText('Task 0').closest('li')!;
    expect(row.querySelector('img')).toHaveAttribute('src', '/avatar-one.png');
    fireEvent.error(row.querySelector('img')!);
    expect(row.querySelector('img')).toBeNull();
    expect(within(row).getByText('C')).toBeInTheDocument();
    view.rerender(page({ ...user, avatarUrl: '/avatar-two.png' }));
    expect(row.querySelector('img')).toHaveAttribute('src', '/avatar-two.png');
    view.rerender(page({ ...user, name: null }));
    expect(within(row).getByText(TEST_VIEWER_ID.slice(0, 8))).toBeInTheDocument();
    view.rerender(page({ ...user, id: id(999), name: 'Another account' }));
    expect(screen.queryByText('Another account')).not.toBeInTheDocument();
    expect(screen.queryByText('Task 0')).not.toBeInTheDocument();
  });

  it('uses each row response clocks and exact startup and expiry boundaries', () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const first = item(0), second = item(1);
    const current = (value: PersonalTaskItem, offset: string) => ({ ...value, receivedMonotonic: 0,
      responseTaskAt: offset, responseSessionAt: '2026-11-13T20:00:00Z',
      task: { ...value.task, startedAt: anchor, worker: activeWorker },
      sessionRow: { ...value.sessionRow, state: 'warning' as const, observedAt: '2026-11-13T20:00:00Z', freshUntil: '2026-11-13T20:00:30Z', needsAttention: true, canOpen: true } });
    mock.value = state([current(first, '2026-11-13T10:01:59.999Z'), current(second, '2026-11-13T10:02:00Z')]);
    renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    const row = screen.getByText('Task 0').closest('li')!, other = screen.getByText('Task 1').closest('li')!;
    expect(within(row).queryByText(/Session needs checking/)).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /Open Session/ })).toBeInTheDocument();
    expect(within(other).getByText('Session needs checking · Needs attention')).toBeInTheDocument();
    vi.mocked(performance.now).mockReturnValue(1);
    act(() => vi.advanceTimersByTime(1));
    expect(within(row).getByText('Session needs checking · Needs attention')).toBeInTheDocument();
    vi.mocked(performance.now).mockReturnValue(30_000);
    act(() => vi.advanceTimersByTime(29_999));
    expect(within(row).getByText('Session observation expired')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Open Session/ })).not.toBeInTheDocument();
    expect(screen.getByText('Task 0').closest('li')).toBe(row);
  });

  it('renders current Session facts with common labels and keeps unknown-start observations ticking', () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const a = item(0), b = item(1), c = item(2);
    mock.value = state([
      { ...a, receivedMonotonic: 0, task: { ...a.task, paused: true, startedAt: null, worker: activeWorker }, sessionRow: { ...a.sessionRow, state: 'working', canOpen: true, freshUntil: '2026-11-13T10:00:02Z' } },
      { ...b, receivedMonotonic: 0, sessionRow: { ...b.sessionRow, state: 'unavailable', observedAt: null, freshUntil: null } },
      { ...c, receivedMonotonic: 0, task: { ...c.task, worker: activeWorker }, sessionRow: { ...c.sessionRow, state: 'notice', needsAttention: true, canOpen: true } },
    ]);
    const view = renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    expect(screen.getByText('Session working')).toBeInTheDocument();
    expect(screen.getByText('Session unavailable')).toBeInTheDocument();
    expect(screen.getByText('Session needs a response · Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('Duration unknown')).toBeInTheDocument();
    vi.mocked(performance.now).mockReturnValue(2_000);
    act(() => vi.advanceTimersByTime(2_000));
    expect(within(screen.getByText('Task 0').closest('li')!).getByText('Session observation expired')).toBeInTheDocument();
    view.setLocale('zh-CN');
    expect(screen.getByText('Session 需要响应 · 需要关注')).toBeInTheDocument();
  });

  it('reconciles retained observations on visibility restoration and replaces them on refresh', () => {
    vi.useFakeTimers();
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(0);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const a = item(0);
    const old = { ...a, receivedMonotonic: 0, task: { ...a.task, startedAt: null, worker: activeWorker },
      sessionRow: { ...a.sessionRow, state: 'working' as const, freshUntil: '2026-11-13T10:00:01Z', canOpen: true } };
    mock.value = state([old]);
    const view = renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    const row = screen.getByText('Task 0').closest('li')!;
    expect(within(row).getByText('Session working')).toBeInTheDocument();
    visibility.mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
    monotonic.mockReturnValue(2_000);
    act(() => vi.advanceTimersByTime(2_000));
    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(within(row).getByText('Session observation expired')).toBeInTheDocument();
    mock.value = state([{ ...old, receivedMonotonic: 2_000, responseSessionAt: '2026-11-13T10:00:02Z',
      sessionRow: { ...old.sessionRow, state: 'notice', observedAt: '2026-11-13T10:00:02Z', freshUntil: '2026-11-13T10:00:32Z' } }]);
    view.rerender(<MyTasksPage />);
    expect(within(row).getByText('Session needs a response')).toBeInTheDocument();
    expect(screen.getByText('Task 0').closest('li')).toBe(row);
  });

});
