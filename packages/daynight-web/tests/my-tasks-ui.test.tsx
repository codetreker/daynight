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
  task: { id: id(n + 10), version: '123456789012345', title: `Task ${n}`, status: 'in_progress', startedAt: '2026-11-13T09:00:00Z', allowAgents: true, paused: false, worker: null, goal: null },
  session: { schemaVersion: 1, observation: 'observed', registration: 'not_applicable', sessionId: null, nativeSessionId: null, claimId: null, executionGeneration: null, connectionEpoch: null, agentControlMode: null, contentKind: null, provider: null, indicator: null, reason: 'no_execution', activity: null, connectionState: null, lifecycle: null, currentTurnId: null, needsAttention: null, send: { allowed: false, mode: null, reason: 'no_execution' }, observedAt: anchor, lastSeenAt: null, freshUntil: '2026-11-13T10:01:00Z', error: null },
  observedAt: anchor, receivedMonotonic: performance.now(), ...overrides,
});
const state = (items: PersonalTaskItem[], overrides: Record<string, unknown> = {}) => ({ items, totalTaskCount: items.length, totalProjectCount: items.length ? 1 : 0, observedAt: anchor, receivedMonotonic: performance.now(), sessionPartial: false, loading: false, loaded: true, stale: false, error: null, refresh: vi.fn(), ...overrides });
beforeEach(() => history.replaceState(null, '', '/my-tasks'));
afterEach(() => vi.useRealTimers());

describe('personal task overview', () => {
  it('shows each current Worker independently of Session and pause, and updates on refresh', () => {
    const a = item(0), b = item(1), c = item(2);
    const worker = (n: number, name: string) => ({ workerId: id(n), machine: { id: id(n + 10), name } });
    mock.value = state([
      { ...a, task: { ...a.task, worker: worker(70, '<worker-one>'), paused: true }, session: { ...a.session, observation: 'unavailable' } },
      { ...b, task: { ...b.task, worker: worker(71, '第二台机器') }, session: { ...b.session, freshUntil: '2026-11-13T09:59:59Z' } },
      c,
    ], { sessionPartial: true });
    const view = renderWithLocale(<MyTasksPage />, { locale: 'en', taskCache: true });
    expect(screen.getByText('Worker: <worker-one>')).toBeInTheDocument();
    expect(screen.getByText('Worker: 第二台机器')).toBeInTheDocument();
    expect(within(screen.getByText('Task 2').closest('li')!).queryByText(/Worker:/)).not.toBeInTheDocument();
    expect(screen.getByText('Session status unavailable')).toBeInTheDocument();
    expect(screen.getByText('Session observation expired')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    view.setLocale('zh-CN');
    expect(screen.getByText('Worker：<worker-one>')).toBeInTheDocument();
    expect(screen.getByText('Worker：第二台机器')).toBeInTheDocument();
    mock.value = state([{ ...a, task: { ...a.task, worker: worker(72, 'replacement') } }, b]);
    view.rerender(<MyTasksPage />);
    expect(screen.queryByText('Worker：<worker-one>')).not.toBeInTheDocument();
    expect(screen.getByText('Worker：replacement')).toBeInTheDocument();
    expect(screen.queryByText('Worker：第二台机器')).not.toBeInTheDocument();
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
