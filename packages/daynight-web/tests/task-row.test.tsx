import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockInputProvider } from '../src/features/task-execution/TaskExecutionClock';
import { TaskRow, type TaskRowModel } from '../src/features/task-row/TaskRow';
import { TaskRowStatus } from '../src/features/task-row/TaskRowStatus';
import { renderWithLocale } from './helpers/renderWithLocale';

vi.mock('../src/features/usage/useTaskUsage', () => ({ useTaskUsage: () => ({ summary: null, error: null, pending: true, retry: vi.fn() }) }));

const colors = vi.hoisted(() => ({ value: { items: new Map(), loading: false, error: null as unknown, retry: vi.fn() }, listeners: new Set<() => void>() }));
vi.mock('../src/features/task-tags/useTagColors', () => ({ useTagColors: () => useSyncExternalStore(
  (listener: () => void) => { colors.listeners.add(listener); return () => { colors.listeners.delete(listener); }; }, () => colors.value,
) }));
beforeEach(() => { colors.value = { items: new Map(), loading: false, error: null, retry: vi.fn() }; });
const publishColor = (error: unknown) => act(() => { colors.value = { ...colors.value, error }; for (const listener of colors.listeners) listener(); });

const id = '20000000-0000-4000-8000-000000000001';
const base: TaskRowModel = {
  id, title: 'Complete task title', createdAt: '2026-10-20T10:00:00Z', status: 'todo', assignedTo: null,
  tags: [{ id: 'one', name: 'alpha' }, { id: 'two', name: 'beta' }], allowAgents: true,
  requiredPlatform: 'linux', ready: true, blocked: false, startedAt: null, completedAt: null,
  cancelledAt: null, paused: false, worker: { kind: 'historical', name: 'worker host' }, session: null,
};
const clock = { observedAt: '2026-10-20T10:01:00Z', receivedMonotonic: 0, warningMinutes: 1 } as const;
const tree = (model: TaskRowModel, open = vi.fn(), session = vi.fn(), instanceId = 'instance') =>
  <ClockInputProvider input={clock}><ul><TaskRow projectId="10000000-0000-4000-8000-000000000001" model={model} href={`/projects/p/tasks/${model.id}`} instanceId={instanceId}
    assignee={<span>Assignee: Unassigned</span>} onOpenTask={open} onOpenSession={session} /></ul></ClockInputProvider>;

describe('shared task row', () => {
  it('localizes the current alias while preserving machine labels and values', () => {
    const alias = 'personal-worker (office-linux)';
    const machine = 'DEVBOX-WIN-JE';
    const view = renderWithLocale(tree({ ...base, worker: { kind: 'active', name: machine, currentName: alias } }), { locale: 'zh-CN' });
    expect(screen.getByText(`执行器别名：${alias}`)).toBeVisible();
    view.setLocale('en');
    expect(screen.getByText(`Worker: ${alias}`)).toBeVisible();
    view.setLocale('zh-CN');
    view.rerender(tree({ ...base, worker: { kind: 'active', name: machine } }));
    expect(screen.getByText(`认领机器：${machine}`)).toBeVisible();
    view.rerender(tree({ ...base, worker: { kind: 'active', name: machine, currentName: machine } }));
    expect(screen.getByText(`认领机器：${machine}`)).toBeVisible();
    view.rerender(tree({ ...base, worker: { kind: 'historical', name: machine, currentName: alias } }));
    expect(screen.getByText(`执行器别名：${alias}`)).toBeVisible();
    view.rerender(tree({ ...base, worker: { kind: 'historical', name: machine } }));
    expect(screen.getByText(`执行机器记录：${machine}`)).toBeVisible();
  });

  it('distinguishes a current alias from a recorded execution hostname', () => {
    const view = renderWithLocale(tree({ ...base, worker: { kind: 'historical', name: 'worker host', currentName: 'Current office' } }), { locale: 'en' });
    expect(screen.getByText('Worker: Current office')).toBeVisible();
    expect(screen.queryByText('Recorded machine: Current office')).toBeNull();
    view.rerender(tree(base));
    expect(screen.getByText('Recorded machine: worker host')).toBeVisible();
  });
  it('keeps task, copy and Session actions independent, including modified links and readable ID', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: write } });
    const open = vi.fn(), session = vi.fn();
    renderWithLocale(tree({ ...base, status: 'in_progress', startedAt: null, session: { state: 'pending', needsAttention: false, canOpen: true } }, open, session), { locale: 'en' });
    const link = screen.getByRole('link', { name: 'Complete task title' });
    expect(link).toHaveAttribute('href', `/projects/p/tasks/${id}`);
    const row = link.closest('.task-row')!;
    expect(row).toHaveTextContent(id);
    expect(row).toHaveTextContent('alpha'); expect(row).toHaveTextContent('beta');
    expect(row).toHaveTextContent('worker host'); expect(row).toHaveTextContent('Duration unknown');
    expect(row.querySelector('button button, a button, button a, a a')).toBeNull();
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false); expect(open).not.toHaveBeenCalled();
    fireEvent.click(link); expect(open).toHaveBeenCalledExactlyOnceWith(id, link);
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Copy task ID' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
    expect(write).toHaveBeenCalledExactlyOnceWith(id); expect(open).toHaveBeenCalledOnce();
    const sessionButton = within(row as HTMLElement).getByRole('button', { name: /Open Session/ });
    fireEvent.click(sessionButton); expect(session).toHaveBeenCalledExactlyOnceWith(id, sessionButton);
    expect(open).toHaveBeenCalledOnce();
  });

  it('reports failed or unavailable clipboard access and retries without navigating', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: write } });
    const open = vi.fn();
    renderWithLocale(tree(base, open), { locale: 'en' });
    const copy = screen.getByRole('button', { name: 'Copy task ID' });
    fireEvent.click(copy);
    expect(await screen.findByRole('alert')).toHaveTextContent('Select and copy it manually');
    expect(screen.getByText(id)).toBeVisible(); expect(open).not.toHaveBeenCalled();
    fireEvent.click(copy); expect(await screen.findByRole('status')).toHaveTextContent('Copied');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('ignores a pending copy result after changing task identity', async () => {
    let resolve!: () => void;
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockReturnValue(new Promise<void>(done => { resolve = done; })) } });
    const view = renderWithLocale(tree(base), { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy task ID' }));
    expect(screen.getByRole('button', { name: 'Copy task ID' })).toBeDisabled();
    view.rerender(tree({ ...base, id: '20000000-0000-4000-8000-000000000002' }));
    await act(async () => resolve());
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy task ID' })).toBeEnabled();
  });

  it('gives each rendered instance distinct descriptions while retaining the same target', () => {
    const model = { ...base, status: 'done' as const, startedAt: '2026-10-20T10:00:00Z', completedAt: '2026-10-20T10:00:30Z' };
    renderWithLocale(<ClockInputProvider input={clock}><ul>{['first', 'second'].map(instanceId => <TaskRow key={instanceId} projectId="10000000-0000-4000-8000-000000000001" model={model} href={`/projects/p/tasks/${id}`} instanceId={instanceId} assignee={null} onOpenTask={() => {}} />)}</ul></ClockInputProvider>, { locale: 'en' });
    const links = screen.getAllByRole('link', { name: 'Complete task title' });
    expect(links.map(link => link.id)).toEqual(['first', 'second']);
    expect(links[0]!.getAttribute('aria-describedby')).not.toBe(links[1]!.getAttribute('aria-describedby'));
    for (const link of links) for (const description of link.getAttribute('aria-describedby')!.split(' ')) expect(document.getElementById(description)).not.toBeNull();
  });

  it.each([
    ['active', { kind: 'active' as const, name: 'live machine' }, 'live machine'],
    ['historical', { kind: 'historical' as const, name: 'old machine' }, 'old machine'],
    ['none', { kind: 'none' as const }, 'No machine record'],
    ['unknown', { kind: 'unknown' as const }, 'Worker record unknown'],
    ['error', { kind: 'error' as const }, 'Worker record unavailable'],
  ])('distinguishes %s Worker facts', (_label, worker, text) => {
    renderWithLocale(tree({ ...base, worker }), { locale: 'en' });
    expect(screen.getByText(text, { exact: false })).toBeVisible();
  });

  it.each(['proposed', 'todo', 'in_progress', 'done', 'cancelled'] as const)('shows the task own %s state', status => {
    const model = { ...base, status, ready: false, tags: [] };
    renderWithLocale(tree(model), { locale: 'en' });
    const row = screen.getByRole('link', { name: model.title }).closest('.task-row')!;
    expect(row).toHaveAttribute('data-task-status', status);
    expect(row.querySelectorAll('.task-tag')).toHaveLength(0);
  });

  it.each(['proposed', 'todo', 'in_progress', 'done', 'cancelled'] as const)('renders permission solely from allowAgents for %s and updates it', status => {
    const model = { ...base, status, allowAgents: true, paused: true, worker: { kind: 'none' as const } };
    const view = renderWithLocale(tree(model), { locale: 'zh-CN' });
    const row = screen.getByRole('link', { name: model.title }).closest('.task-row')!;
    const badge = () => row.querySelector('.task-agent-permission');
    expect(badge()).toHaveTextContent('自动执行');
    expect(badge()).toHaveAttribute('aria-label', '自动执行');
    expect(badge()).toHaveAttribute('title', '自动执行');
    view.rerender(tree({ ...model, allowAgents: false, worker: { kind: 'active', name: 'live machine' } }));
    expect(badge()).toBeNull();
    expect(row).toHaveTextContent('live machine');
    view.setLocale('en');
    view.rerender(tree({ ...model, worker: { kind: 'historical', name: 'old machine' } }));
    expect(badge()).toHaveTextContent('Automatic execution');
    expect(badge()).toHaveAttribute('aria-label', 'Automatic execution');
    expect(badge()).toHaveAttribute('title', 'Automatic execution');
    expect(row).toHaveTextContent('old machine');
  });

  it('keeps Working as the primary phrase alongside pause, readiness, blocking and overdue warnings', () => {
    const model = { ...base, status: 'in_progress' as const, startedAt: '2026-10-20T09:00:00Z', paused: true, ready: true, blocked: true,
      session: { state: 'working' as const, needsAttention: false, canOpen: false } };
    renderWithLocale(tree(model), { locale: 'en' });
    const row = screen.getByRole('link', { name: model.title }).closest('.task-row')!;
    expect(row).toHaveClass('standalone-row-stuck');
    expect(row).toHaveAttribute('data-task-status', 'in_progress');
    expect(row.querySelectorAll('.task-row-primary-status')).toHaveLength(1);
    expect(row.querySelector('.task-row-primary-status')?.firstChild?.textContent).toBe('Working');
    for (const selector of ['.task-paused-badge', '.task-ready', '.graph-blocked-badge', '.task-stuck-label']) expect(row.querySelector(selector)).toBeVisible();
    expect(row.querySelector('.task-row-status-lifecycle')).toHaveTextContent('In progress');
  });

  it('distinguishes an unavailable Session from an expired observation without inventing an entry', () => {
    const model = { ...base, status: 'in_progress' as const, session: { state: 'unavailable' as const, needsAttention: null, canOpen: false } };
    const view = renderWithLocale(tree(model), { locale: 'en' });
    expect(screen.getByText('Unavailable')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Open Session/ })).toBeNull();
    view.rerender(tree({ ...model, session: { state: 'expired', needsAttention: null, canOpen: false } }));
    expect(screen.getByText('Observation expired')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Open Session/ })).toBeNull();
  });

  it('updates the empty Session hint with permission and observation while preserving row identity and focus', () => {
    const empty = { state: 'no_session' as const, needsAttention: null, canOpen: false };
    const model = { ...base, status: 'in_progress' as const, allowAgents: false, paused: true, session: empty };
    const view = renderWithLocale(tree(model), { locale: 'zh-CN' });
    const title = screen.getByRole('link', { name: model.title });
    const row = title.closest('.task-row')!;
    title.focus();
    expect(row.querySelector('.task-row-primary-status')).toHaveTextContent('进行中');
    expect(row).toHaveTextContent('进行中'); expect(row).toHaveTextContent('worker host');
    view.rerender(tree({ ...model, allowAgents: true }));
    expect(row).toHaveTextContent('无当前会话'); expect(title).toHaveFocus();
    view.setLocale('en');
    expect(row).toHaveTextContent('No current session');
    view.rerender(tree(model));
    expect(row.querySelector('.task-row-primary-status')).toHaveTextContent('In progress');
    view.rerender(tree({ ...model, session: { state: 'working', needsAttention: false, canOpen: true } }));
    const action = within(row as HTMLElement).getByRole('button', { name: /Working.*Open Session/ });
    action.focus();
    view.rerender(tree({ ...model, session: { state: null, needsAttention: false, canOpen: true } }));
    expect(action).toHaveFocus();
    view.rerender(tree(model));
    expect(title).toHaveFocus(); expect(row.querySelector('.task-row-primary-status')).toHaveTextContent('In progress');
  });

  it('keeps attention and an independently allowed entrance when the empty detail is suppressed', () => {
    const open = vi.fn();
    const model = { ...base, status: 'in_progress' as const, allowAgents: false, session: { state: 'no_session' as const, needsAttention: true, canOpen: true } };
    const view = renderWithLocale(tree(model, vi.fn(), open), { locale: 'en' });
    const action = screen.getByRole('button', { name: /Needs attention.*Open Session/ });
    expect(action).not.toHaveTextContent('No current session');
    fireEvent.click(action); expect(open).toHaveBeenCalledExactlyOnceWith(id, action);
    view.rerender(tree({ ...model, session: { ...model.session, canOpen: false } }));
    expect(screen.getByText('Needs attention')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Open Session/ })).toBeNull();
  });

  it.each([
    ['not_registered', 'Not registered'], ['pending', 'Pending sync'], ['working', 'Working'],
    ['notice', 'Needs a response'], ['warning', 'Needs checking'], ['unavailable', 'Unavailable'],
    ['unobserved', 'Not yet observed'], ['expired', 'Observation expired'],
  ] as const)('retains %s for a manual task', (state, label) => {
    renderWithLocale(tree({ ...base, status: 'in_progress', allowAgents: false, session: { state, needsAttention: false, canOpen: false } }), { locale: 'en' });
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Open Session/ })).toBeNull();
  });


  it('restores focus to the task title when a focused color retry disappears after recovery', async () => {
    colors.value = { ...colors.value, error: new Error('unavailable') };
    renderWithLocale(tree(base), { locale: 'en' });
    const title = screen.getByRole('link', { name: base.title });
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus(); expect(retry).toHaveFocus();
    publishColor(null);
    await waitFor(() => expect(title).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('does not steal focus after the user leaves the color retry or its task is removed', async () => {
    colors.value = { ...colors.value, error: new Error('unavailable') };
    const view = renderWithLocale(<><button type="button">Outside</button>{tree(base)}</>, { locale: 'en' });
    const outside = screen.getByRole('button', { name: 'Outside' });
    screen.getByRole('button', { name: 'Retry' }).focus();
    outside.focus();
    publishColor(null);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull());
    expect(outside).toHaveFocus();
    publishColor(new Error('unavailable'));
    screen.getByRole('button', { name: 'Retry' }).focus();
    view.rerender(<><button type="button">Outside</button></>);
    outside.focus();
    publishColor(null);
    await act(async () => {});
    expect(outside).toHaveFocus();
  });

  it('does not focus a different task when the old task identity is replaced', async () => {
    colors.value = { ...colors.value, error: new Error('unavailable') };
    const view = renderWithLocale(<><button type="button">Outside</button>{tree(base)}</>, { locale: 'en' });
    screen.getByRole('button', { name: 'Retry' }).focus();
    colors.value = { ...colors.value, error: null };
    view.rerender(<><button type="button">Outside</button>{tree({ ...base, id: '20000000-0000-4000-8000-000000000002', title: 'Other task' })}</>);
    await act(async () => {});
    expect(screen.getByRole('link', { name: 'Other task' })).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

});


describe('unified primary task status', () => {
  const phrases = {
    en: { no_session: 'No current session', not_registered: 'Not registered', pending: 'Pending sync', working: 'Working', notice: 'Needs a response', warning: 'Needs checking', unavailable: 'Unavailable', unobserved: 'Not yet observed', expired: 'Observation expired' },
    'zh-CN': { no_session: '无当前会话', not_registered: '会话未注册', pending: '待同步', working: '工作中', notice: '需要响应', warning: '需要检查', unavailable: '会话不可用', unobserved: '会话尚未观测', expired: '会话状态已过期' },
  } as const;
  it.each(['en', 'zh-CN'] as const)('selects one visible phrase for every observation and attention combination in %s', locale => {
    const lifecycle = locale === 'en' ? 'In progress' : '进行中';
    const attention = locale === 'en' ? 'Needs attention' : '需要关注';
    const openLabel = locale === 'en' ? 'Open Session' : '打开 Session';
    const activate = vi.fn();
    const view = renderWithLocale(<TaskRowStatus title="Example" status="in_progress" observation={null} allowAgents onActivate={activate} />, { locale });
    for (const state of [...Object.keys(phrases.en), null] as [...(keyof typeof phrases.en)[], null]) {
      for (const needsAttention of [false, null, true]) for (const canOpen of [false, true]) {
        const expected = state === 'notice' ? phrases[locale].notice : needsAttention === true ? attention : state === null ? lifecycle : phrases[locale][state];
        view.rerender(<TaskRowStatus title="Example" status="in_progress" observation={{ state, needsAttention, canOpen }} allowAgents onActivate={activate} />);
        const status = view.container.querySelector('.task-row-primary-status')!;
        expect(view.container.querySelectorAll('.task-row-primary-status')).toHaveLength(1);
        expect(status.firstChild?.textContent).toBe(expected);
        expect(status.tagName).toBe(canOpen ? 'BUTTON' : 'SPAN');
        expect(status.getAttribute('data-needs-attention')).toBe(needsAttention === true ? 'true' : null);
        if (canOpen) {
          const parts = ['Example', lifecycle, ...(expected === lifecycle ? [] : [expected]), openLabel];
          expect(status).toHaveAccessibleName(parts.join(locale === 'en' ? ', ' : '，'));
          expect(status).toHaveAttribute('title', openLabel);
          expect(status.querySelector('.task-row-status-lifecycle')).toBeNull();
        } else {
          expect(status).toHaveTextContent(lifecycle);
          expect(status.querySelector('.task-row-status-lifecycle') !== null).toBe(expected !== lifecycle);
          expect(view.container.querySelector('button')).toBeNull();
        }
      }
    }
  });

  it.each(['proposed', 'todo', 'done', 'cancelled'] as const)('keeps %s lifecycle and excludes stale Session activity and entrance', status => {
    const view = renderWithLocale(<TaskRowStatus title="Example" status={status} observation={{ state: 'notice', needsAttention: true, canOpen: true }} allowAgents onActivate={vi.fn()} />, { locale: 'en' });
    const primary = view.container.querySelector('.task-row-primary-status')!;
    expect(primary).toHaveClass('root-status', 'graph-status-' + status);
    expect(primary).not.toHaveAttribute('data-needs-attention');
    expect(primary).not.toHaveAttribute('data-session-state');
    expect(primary.querySelector('.task-row-status-lifecycle')).toBeNull();
    expect(primary).not.toHaveTextContent('Needs a response');
    expect(view.container.querySelector('button')).toBeNull();
  });

  it('uses lifecycle fallback for no detail and exposes no button without a caller entrance', () => {
    const view = renderWithLocale(<TaskRowStatus title="Example" status="in_progress" observation={null} allowAgents />, { locale: 'en' });
    expect(view.container.querySelector('.task-row-primary-status')).toHaveTextContent(/^In progress$/);
    view.rerender(<TaskRowStatus title="Example" status="in_progress" observation={{ state: null, needsAttention: null, canOpen: true }} allowAgents />);
    expect(view.container.querySelector('.task-row-primary-status')).toHaveTextContent(/^In progress$/);
    expect(view.container.querySelector('button')).toBeNull();
  });
});
