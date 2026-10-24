import { act, fireEvent, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TaskDetailPageBar } from '../src/features/task-detail/TaskDetailSurface';
import { TaskControlTip, TaskDetailNotice, TaskDetailNotifications } from '../src/features/task-detail/TaskDetailNotice';
import { renderWithLocale } from './helpers/renderWithLocale';

const mount = (event = 1, active = true) => {
  const fallbackFocus = createRef<HTMLHeadingElement>();
  const check = vi.fn();
  const content = (receipt: number, enabled: boolean) => <TaskDetailNotifications fallbackFocus={fallbackFocus}>
    <h2 tabIndex={0} ref={fallbackFocus}>Task</h2>
    <button>Reading control</button>
    <TaskDetailNotice event={receipt} active={enabled} tone="warning" recoverable>
      <p role="alert">The result is unknown.</p><button onClick={check}>Check task</button>
    </TaskDetailNotice>
  </TaskDetailNotifications>;
  const view = renderWithLocale(content(event, active), { locale: 'en' });
  return { ...view, check, update: (receipt: number, enabled = true) => view.rerender(content(receipt, enabled)) };
};
const advance = (milliseconds: number) => act(() => vi.advanceTimersByTime(milliseconds));

describe('task detail notification lifetime', () => {
  it('expires presentation, keeps recovery reachable, and restores focus on reopening and dismissal', () => {
    vi.useFakeTimers();
    const view = mount();
    const layer = view.container.querySelector('.task-detail-notifications')!;
    expect(layer.querySelector('.task-detail-toast')).not.toBeNull();
    advance(7999);
    expect(screen.getByRole('alert')).toBeVisible();
    advance(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(view.check).not.toHaveBeenCalled();
    const reopen = screen.getByRole('button', { name: 'Show task notification' });
    fireEvent.click(reopen);
    expect(screen.getByRole('button', { name: 'Dismiss notification' })).toHaveFocus();
    advance(9000);
    expect(screen.getByRole('alert')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Check task' }));
    expect(view.check).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.getByRole('button', { name: 'Show task notification' })).toHaveFocus();
  });

  it('resumes only after both hover and focus leave, using the remaining lifetime', () => {
    vi.useFakeTimers();
    mount();
    advance(3000);
    const bubble = screen.getByRole('alert').closest('.task-detail-toast')!;
    fireEvent.mouseEnter(bubble);
    act(() => screen.getByRole('button', { name: 'Check task' }).focus());
    fireEvent.mouseLeave(bubble);
    advance(10000);
    expect(screen.getByRole('alert')).toBeVisible();
    fireEvent.mouseEnter(bubble);
    act(() => screen.getByRole('button', { name: 'Reading control' }).focus());
    advance(10000);
    expect(screen.getByRole('alert')).toBeVisible();
    fireEvent.mouseLeave(bubble);
    advance(4999);
    expect(screen.getByRole('alert')).toBeVisible();
    advance(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears interaction from a removed bubble and starts the later event with its own lifetime', () => {
    vi.useFakeTimers();
    const view = mount();
    fireEvent.mouseEnter(screen.getByRole('alert').closest('.task-detail-toast')!);
    view.update(1, false);
    view.update(2);
    advance(8000);
    expect(screen.queryByRole('alert')).toBeNull();
    view.update(3);
    expect(screen.getByRole('alert')).toBeVisible();
    advance(8000);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not reset expiry when language or unrelated rendering changes', () => {
    vi.useFakeTimers();
    const view = mount();
    advance(7000);
    view.setLocale('zh-CN');
    view.update(1);
    expect(screen.getByRole('button', { name: '关闭提示' })).toBeVisible();
    advance(1000);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: '查看任务提示' })).toBeVisible();
  });

  it('keeps focus in the notification when an operation removes its recovery action', () => {
    const fallbackFocus = createRef<HTMLHeadingElement>();
    const content = (checking: boolean) => <TaskDetailNotifications fallbackFocus={fallbackFocus}>
      <h2 ref={fallbackFocus} tabIndex={0}>Task</h2>
      <TaskDetailNotice event={checking} recoverable={checking}>{checking ? <button>Check task</button> : <p role="status">Current task read.</p>}</TaskDetailNotice>
    </TaskDetailNotifications>;
    const view = renderWithLocale(content(true), { locale: 'en' });
    act(() => screen.getByRole('button', { name: 'Check task' }).focus());
    view.rerender(content(false));
    expect(screen.getByRole('button', { name: 'Dismiss notification' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.getByRole('heading', { name: 'Task' })).toHaveFocus();
  });
});

describe('standalone detail language feedback', () => {
  it('floats preference errors, preserves the accessible reason after expiry, and retries from restored feedback', () => {
    vi.useFakeTimers();
    const fallbackFocus = createRef<HTMLHeadingElement>();
    const setItem = vi.fn();
    const view = renderWithLocale(<TaskDetailNotifications fallbackFocus={fallbackFocus}>
      <TaskDetailPageBar projectId="project" /><h2 ref={fallbackFocus} tabIndex={0}>Task</h2>
    </TaskDetailNotifications>, { locale: 'en', issue: { kind: 'write', cause: new Error('storage unavailable') }, getStorage: () => ({ getItem: () => null, setItem }) });
    const topbar = view.container.querySelector('.task-detail-page-topbar')!;
    expect(topbar.querySelector('.locale-notice')).toBeNull();
    const selector = screen.getByRole('combobox');
    const description = selector.getAttribute('aria-describedby')!;
    expect(document.getElementById(description)).not.toBeNull();
    advance(8000);
    expect(screen.queryByRole('status')).toBeNull();
    expect(selector).toHaveAttribute('aria-describedby', description);
    expect(document.getElementById(description)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show task notification' }));
    const retry = screen.getByRole('button', { name: 'Retry saving language' });
    act(() => retry.focus());
    fireEvent.click(retry);
    expect(setItem).toHaveBeenCalledOnce();
    expect(screen.queryByRole('status')).toBeNull();
    expect(selector).not.toHaveAttribute('aria-describedby');
    expect(screen.getByRole('heading', { name: 'Task' })).toHaveFocus();
  });
});

describe('locked control tips', () => {
  it('gives keyboard focus priority over another hovered control and shows only one explanation', () => {
    renderWithLocale(<TaskDetailNotifications fallbackFocus={createRef<HTMLElement>()}>
      <TaskControlTip text="Platform locked." label="Platform"><select disabled><option>Any</option></select></TaskControlTip>
      <TaskControlTip text="Automation locked." label="Automation"><button disabled>Automatic execution</button></TaskControlTip>
    </TaskDetailNotifications>, { locale: 'en' });
    const platform = screen.getByRole('group', { name: 'Platform' });
    const automation = screen.getByRole('group', { name: 'Automation' });
    fireEvent.mouseEnter(platform);
    expect(document.querySelectorAll('.task-control-tip-bubble')).toHaveLength(1);
    expect(document.querySelector('.task-control-tip-bubble')).toHaveTextContent('Platform locked.');
    act(() => automation.focus());
    fireEvent.mouseLeave(platform);
    fireEvent.mouseEnter(platform);
    expect(document.querySelectorAll('.task-control-tip-bubble')).toHaveLength(1);
    expect(document.querySelector('.task-control-tip-bubble')).toHaveTextContent('Automation locked.');
    fireEvent.keyDown(automation, { key: 'Escape' });
    expect(document.querySelector('.task-control-tip-bubble')).toBeNull();
  });
  it('shows on focus, consumes Escape only while visible, and follows the current lock', () => {
    const escape = vi.fn();
    const content = (locked: boolean) => <div onKeyDown={escape}><TaskControlTip text={locked ? 'Changes are locked.' : null} label="Execution platform">
      <select aria-label="Execution platform" disabled={locked}><option>Any</option></select>
    </TaskControlTip></div>;
    const view = renderWithLocale(content(true), { locale: 'en' });
    const wrapper = screen.getByRole('group', { name: 'Execution platform' });
    expect(wrapper).toHaveAccessibleDescription('Changes are locked.');
    act(() => wrapper.focus());
    expect(screen.getByRole('tooltip')).toHaveClass('task-control-tip-bubble');
    fireEvent.keyDown(wrapper, { key: 'Escape' });
    expect(screen.getByRole('tooltip')).toHaveClass('task-control-tip-hidden');
    expect(escape).not.toHaveBeenCalled();
    fireEvent.keyDown(wrapper, { key: 'Escape' });
    expect(escape).toHaveBeenCalledOnce();
    fireEvent.mouseEnter(wrapper);
    view.rerender(content(false));
    expect(screen.queryByRole('tooltip')).toBeNull();
    const enabled = screen.getByRole('combobox');
    act(() => enabled.focus());
    fireEvent.keyDown(enabled, { key: 'Escape' });
    expect(escape).toHaveBeenCalledTimes(2);
  });
});
