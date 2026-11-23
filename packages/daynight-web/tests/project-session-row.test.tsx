import { fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { GraphTask } from '../src/api/types';
import { StandaloneTaskRow } from '../src/features/projects/StandaloneTaskRow';
import { TaskMemberRow } from '../src/features/task-graph/TaskMemberRow';
import { renderWithLocale } from './helpers/renderWithLocale';

const current = vi.hoisted(() => ({ value: { state: 'pending' as string | null, needsAttention: null as boolean | null, canOpen: true } }));
vi.mock('../src/features/task-session-summary/ProjectTaskObservationsProvider', () => ({
  useProjectTaskObservation: (task: GraphTask) => task.status === 'in_progress' ? current.value : null,
}));
const task: GraphTask = { type: 'task', parentId: null, id: '00000000-0000-4000-8000-000000000001', titlePreview: 'Task', titleTruncated: false,
  assignedTo: null, status: 'in_progress', dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false,
  requiredPlatform: null, allowAgents: true, startedAt: null, completedAt: null, cancelledAt: null,
  createdAt: '2026-11-04T10:00:00Z', updatedAt: '2026-11-04T10:00:00Z' };
const projectId = '00000000-0000-4000-8000-000000000101';

it.each(['standalone', 'chain', 'goal'] as const)('uses the task permission for the empty Session hint in %s', kind => {
  current.value = { state: 'no_session', needsAttention: null, canOpen: false };
  const row = (allowAgents: boolean) => kind === 'standalone'
    ? <StandaloneTaskRow projectId={projectId} task={{ ...task, allowAgents }} title="Example" instanceId="example" onSelectTask={vi.fn()} />
    : <TaskMemberRow projectId={projectId} task={{ ...task, allowAgents }} title="Example" instanceId={kind} workerMachine={undefined} onOpenTask={vi.fn()} />;
  const view = renderWithLocale(<ul>{row(false)}</ul>, { locale: 'en', taskCache: true });
  expect(view.container.querySelector('.task-row-primary-status')).toHaveTextContent('In progress');
  view.rerender(<ul>{row(true)}</ul>);
  expect(view.container).toHaveTextContent('No current session');
});

it.each(['standalone', 'chain', 'goal'] as const)('presents Session state and independent navigation for %s', async (kind) => {
  current.value = { state: 'pending', needsAttention: null, canOpen: true };
  const openTask = vi.fn(), openSession = vi.fn();
  const row = () => kind === 'standalone'
    ? <StandaloneTaskRow projectId={projectId} task={{ ...task }} title="Example" instanceId="example" onSelectTask={openTask} onOpenSession={openSession} />
    : <TaskMemberRow projectId={projectId} task={{ ...task }} title="Example" instanceId={kind} workerMachine={undefined} onOpenTask={openTask} onOpenSession={openSession} />;
  const view = renderWithLocale(<ul>{row()}</ul>, { locale: 'zh-CN', taskCache: true });
  const item = view.container.querySelector('li')!;
  const shortcut = within(item).getByRole('button', { name: /待同步.*打开 Session/ });
  expect(item.querySelector('button button')).toBeNull();
  const user = userEvent.setup(); shortcut.focus(); await user.keyboard('{Enter}');
  expect(openSession).toHaveBeenCalledWith(task.id, shortcut); expect(openTask).not.toHaveBeenCalled();
  current.value = { state: null, needsAttention: null, canOpen: true }; view.rerender(<ul>{row()}</ul>);
  expect(within(item).getByRole('button', { name: /进行中.*打开 Session/ })).toBe(shortcut);
  expect(shortcut).toHaveFocus();
  current.value = { state: 'expired', needsAttention: null, canOpen: false }; view.rerender(<ul>{row()}</ul>);
  expect(within(item).queryByRole('button', { name: /打开 Session/ })).toBeNull();
  expect(item).toHaveTextContent('会话状态已过期');
  expect(item.querySelector('.task-row-title')).toHaveFocus();
  fireEvent.click(item.querySelector('.task-row-title')!);
  expect(openTask).toHaveBeenCalledOnce();
});

it.each([
  ['no_session', '无当前会话'], ['not_registered', '会话未注册'], ['working', '工作中'],
  ['notice', '需要响应'], ['warning', '需要检查'], ['unavailable', '会话不可用'], ['unobserved', '会话尚未观测'], ['expired', '会话状态已过期'],
] as const)('renders %s without inventing a Session action', (state, text) => {
  current.value = { state, needsAttention: null, canOpen: false };
  const view = renderWithLocale(<ul><StandaloneTaskRow projectId={projectId} task={task} title="Example" instanceId="example" onSelectTask={vi.fn()} onOpenSession={vi.fn()} /></ul>, { locale: 'zh-CN', taskCache: true });
  expect(view.container).toHaveTextContent(text);
  expect(within(view.container).queryByRole('button', { name: /打开 Session/ })).toBeNull();
});

it('renders English attention and an independently accessible unavailable Session', () => {
  current.value = { state: 'unavailable', needsAttention: true, canOpen: true };
  const openSession = vi.fn();
  const view = renderWithLocale(<ul><StandaloneTaskRow projectId={projectId} task={task} title="Example" instanceId="example" onSelectTask={vi.fn()} onOpenSession={openSession} /></ul>, { locale: 'en', taskCache: true });
  const action = within(view.container).getByRole('button', { name: /Needs attention.*Open Session/ });
  fireEvent.click(action);
  expect(openSession).toHaveBeenCalledWith(task.id, action);
});

it.each(['standalone', 'chain', 'goal'] as const)('combines warning and attention for %s in both languages and entry states', async kind => {
  for (const [locale, text, openLabel] of [['en', 'Needs attention', 'Open Session'], ['zh-CN', '需要关注', '打开 Session']] as const) {
    for (const canOpen of [false, true]) {
      current.value = { state: 'warning', needsAttention: true, canOpen };
      const openSession = vi.fn();
      const row = kind === 'standalone'
        ? <StandaloneTaskRow projectId={projectId} task={task} title="Example" instanceId="example" onSelectTask={vi.fn()} onOpenSession={openSession} />
        : <TaskMemberRow projectId={projectId} task={task} title="Example" instanceId={kind} workerMachine={undefined} onOpenTask={vi.fn()} onOpenSession={openSession} />;
      const view = renderWithLocale(<ul>{row}</ul>, { locale, taskCache: true });
      const status = view.container.querySelector('[data-session-state="warning"]')!;
      expect(status.firstChild?.textContent).toBe(text);
      expect(status).toHaveAttribute('data-needs-attention', 'true');
      if (canOpen) {
        expect(status).toHaveAccessibleName(new RegExp(`${text}.*${openLabel}`));
        expect(status.tagName).toBe('BUTTON');
        (status as HTMLButtonElement).focus();
        await userEvent.setup().keyboard('{Enter}');
        expect(openSession).toHaveBeenCalledWith(task.id, status);
      } else {
        expect(status.tagName).toBe('SPAN');
        expect(within(view.container).queryByRole('button', { name: new RegExp(openLabel) })).toBeNull();
      }
      view.unmount();
    }
  }
});

it.each([
  ['en', 'Needs checking', 'Needs a response'],
  ['zh-CN', '需要检查', '需要响应'],
] as const)('keeps standalone warning and notice meanings in %s', (locale, warning, notice) => {
  const row = () => <ul><StandaloneTaskRow projectId={projectId} task={task} title="Example" instanceId="example" onSelectTask={vi.fn()} /></ul>;
  for (const needsAttention of [false, null]) {
    current.value = { state: 'warning', needsAttention, canOpen: false };
    const view = renderWithLocale(row(), { locale, taskCache: true });
    expect(view.container.querySelector('[data-session-state="warning"]')).toHaveTextContent(warning);
    view.unmount();
  }
  current.value = { state: 'notice', needsAttention: true, canOpen: false };
  const view = renderWithLocale(row(), { locale, taskCache: true });
  expect(view.container.querySelector('[data-session-state="notice"]')).toHaveTextContent(notice);
});

it('distinguishes English unobserved, unavailable and expired states without offering an entrance', () => {
  const row = () => <ul><StandaloneTaskRow projectId={projectId} task={task} title="Example" instanceId="example" onSelectTask={vi.fn()} onOpenSession={vi.fn()} /></ul>;
  current.value = { state: 'unobserved', needsAttention: null, canOpen: false };
  const view = renderWithLocale(row(), { locale: 'en', taskCache: true });
  expect(view.container).toHaveTextContent('Not yet observed');
  current.value = { state: 'unavailable', needsAttention: null, canOpen: false }; view.rerender(row());
  expect(view.container).toHaveTextContent('Unavailable');
  current.value = { state: 'expired', needsAttention: null, canOpen: false }; view.rerender(row());
  expect(view.container).toHaveTextContent('Observation expired');
  expect(within(view.container).queryByRole('button', { name: /Open Session/ })).toBeNull();
});
