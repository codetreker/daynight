import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalTaskItem } from '../src/api/personal-tasks';
import { MyTasksPage } from '../src/features/my-tasks/MyTasksPage';
import { renderWithLocale } from './helpers/renderWithLocale';

const mock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../src/features/my-tasks/useMyTasks', () => ({ useMyTasks: () => mock.value }));
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const anchor = '2026-11-13T10:00:00Z';
const item = (n: number, overrides: Partial<PersonalTaskItem> = {}): PersonalTaskItem => ({
  project: { id: id(1), name: 'Project', ownerTeam: { id: id(2), kind: 'ordinary', name: 'Team' }, executionWarningMinutes: 120, matchedTaskCount: 17 },
  task: { id: id(n + 10), version: '123456789012345', title: `Task ${n}`, status: 'in_progress', startedAt: '2026-11-13T09:00:00Z', allowAgents: true, paused: false, goal: null },
  session: { schemaVersion: 1, observation: 'observed', registration: 'not_applicable', sessionId: null, nativeSessionId: null, claimId: null, executionGeneration: null, connectionEpoch: null, agentControlMode: null, contentKind: null, provider: null, indicator: null, reason: 'no_execution', activity: null, connectionState: null, lifecycle: null, currentTurnId: null, needsAttention: null, send: { allowed: false, mode: null, reason: 'no_execution' }, observedAt: anchor, lastSeenAt: null, freshUntil: '2026-11-13T10:01:00Z', error: null },
  observedAt: anchor, receivedMonotonic: performance.now(), ...overrides,
});
const state = (items: PersonalTaskItem[], overrides: Record<string, unknown> = {}) => ({ items, totalTaskCount: items.length, totalProjectCount: items.length ? 1 : 0, observedAt: anchor, receivedMonotonic: performance.now(), sessionPartial: false, loading: false, loaded: true, stale: false, error: null, refresh: vi.fn(), ...overrides });
beforeEach(() => history.replaceState(null, '', '/my-tasks'));
afterEach(() => vi.useRealTimers());

describe('personal task overview', () => {
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

  it('distinguishes no Session, unavailable and expired observations, pause, and unknown start', () => {
    const a = item(0);
    const b = item(1);
    const c = item(2);
    mock.value = state([a, { ...b, task: { ...b.task, startedAt: null, paused: true }, session: { ...b.session, observation: 'unavailable' } }, { ...c, session: { ...c.session, freshUntil: '2026-11-13T09:59:59Z', indicator: 'working', registration: 'registered' } }]);
    const view = renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    expect(screen.getByText('No Session')).toBeInTheDocument();
    expect(screen.getByText('Session status unavailable')).toBeInTheDocument();
    expect(screen.getByText('Session observation expired')).toBeInTheDocument();
    expect(screen.getByText('Execution time unknown')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    view.setLocale('zh-CN');
    expect(screen.getByText('没有 Session')).toBeInTheDocument();
    expect(screen.getByText('Session 观测已过期')).toBeInTheDocument();
  });

  it('expires a live observation as the clock advances without changing rows', () => {
    vi.useFakeTimers();
    const a = item(0);
    mock.value = state([{ ...a, session: { ...a.session, registration: 'registered', indicator: 'working', freshUntil: '2026-11-13T10:00:02Z' } }]);
    renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    const row = screen.getByText('Task 0').closest('li')!;
    expect(within(row).getByText('Session is working')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3_000));
    expect(within(row).getByText('Session observation expired')).toBeInTheDocument();
    expect(screen.getByText('Task 0').closest('li')).toBe(row);
  });

  it('hides both warning sources until two minutes of the current execution have elapsed', () => {
    vi.useFakeTimers();
    const items = [0, 1, 2].map(n => {
      const a = item(n);
      return { ...a, task: { ...a.task, startedAt: anchor }, session: { ...a.session, registration: 'registered' as const,
        indicator: n === 0 ? 'warning' as const : null, connectionState: n === 1 ? 'disconnected' as const : null,
        lifecycle: n === 2 ? 'archived' as const : null, needsAttention: true, freshUntil: '2026-11-13T10:05:00Z' } };
    });
    mock.value = state(items);
    const view = renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    const row = screen.getByText('Task 0').closest('li')!;
    const link = within(row).getByRole('link', { name: 'Task 0' });
    link.focus();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText(/Session needs checking/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Needs attention/)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(59_999));
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.queryByText(/Session needs checking/)).not.toBeInTheDocument();
    mock.value = state(items.map(i => ({ ...i, task: { ...i.task, version: '2' } })));
    view.rerender(<MyTasksPage />);
    expect(screen.getByText('Task 0').closest('li')).toBe(row);
    expect(link).toHaveFocus();
    act(() => vi.advanceTimersByTime(1));
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.getAllByText(/Session needs checking · Needs attention/)).toHaveLength(3);
    view.unmount();
    renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    expect(screen.getAllByText(/Session needs checking · Needs attention/)).toHaveLength(3);
  });

  it('preserves working, notice, unknown start and observation failure precedence during startup', () => {
    vi.useFakeTimers();
    const items = [0, 1, 2, 3, 4, 5, 6].map(n => {
      const a = item(n);
      return { ...a, task: { ...a.task, startedAt: n === 2 ? null : anchor }, session: { ...a.session,
        registration: n === 5 ? 'not_registered' as const : 'registered' as const, indicator: n === 0 ? 'working' as const : n === 1 ? 'notice' as const : 'warning' as const,
        needsAttention: true, freshUntil: n === 3 ? anchor : '2026-11-13T10:05:00Z',
        observation: n === 4 ? 'unavailable' as const : 'observed' as const,
        error: n === 6 ? { code: 'unavailable', message: 'Unavailable' } : null } };
    });
    mock.value = state(items);
    const view = renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    expect(screen.getByText(/Session is working/)).toBeInTheDocument();
    expect(screen.getByText(/Session needs a response · Needs attention/)).toBeInTheDocument();
    expect(screen.getByText(/Session needs checking · Needs attention/)).toBeInTheDocument();
    expect(screen.getByText('Session observation expired')).toBeInTheDocument();
    expect(screen.getAllByText('Session status unavailable')).toHaveLength(2);
    expect(screen.getByText(/Session not registered/)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByText(/Session is working/)).toBeInTheDocument();
    expect(screen.getByText(/Session needs a response/)).toBeInTheDocument();
    view.setLocale('zh-CN');
    expect(screen.getByText(/会话需要响应 · 需要关注/)).toBeInTheDocument();
  });

  it('uses the current observation after refresh and when returning from a hidden page', () => {
    vi.useFakeTimers();
    const a = item(0);
    const warning = { ...a, task: { ...a.task, startedAt: anchor }, session: { ...a.session, registration: 'registered' as const,
      indicator: 'warning' as const, freshUntil: '2026-11-13T10:05:00Z' } };
    const b = item(1);
    const secondWarning = { ...warning, task: { ...b.task, startedAt: anchor } };
    mock.value = state([warning, secondWarning]);
    const view = renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    act(() => vi.advanceTimersByTime(60_000));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const refreshed = { ...warning, observedAt: '2026-11-13T10:01:00Z', receivedMonotonic: performance.now(),
      session: { ...warning.session, indicator: 'working' as const } };
    const refreshedWarning = { ...secondWarning, observedAt: refreshed.observedAt, receivedMonotonic: refreshed.receivedMonotonic };
    mock.value = state([refreshed, refreshedWarning]);
    view.rerender(<MyTasksPage />);
    expect(screen.getByText('Session is working')).toBeInTheDocument();
    view.unmount();
    const remount = renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    act(() => vi.advanceTimersByTime(60_000));
    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.getByText('Session is working')).toBeInTheDocument();
    expect(within(screen.getByText('Task 1').closest('li')!).getByText('Session needs checking')).toBeInTheDocument();
    expect(within(screen.getByText('Task 0').closest('li')!).queryByText(/Session needs checking/)).not.toBeInTheDocument();
    mock.value = state([{ ...refreshed, session: { ...refreshed.session, indicator: 'warning' as const } }, refreshedWarning]);
    remount.rerender(<MyTasksPage />);
    expect(screen.getAllByText('Session needs checking')).toHaveLength(2);
    visibility.mockRestore();
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
});
