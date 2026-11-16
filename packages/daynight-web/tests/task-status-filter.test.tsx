import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { TaskStatus } from '../src/api/types';
import { registerOverlay } from '../src/app/overlay';
import { TaskStatusFilter } from '../src/features/projects/TaskStatusFilter';
import { ALL_TASK_STATUSES } from '../src/features/projects/task-status-filter';
import { useTagFilterPopover } from '../src/features/task-tags/useTagFilterPopover';
import { LocaleProvider } from '../src/i18n/LocaleProvider';

const Harness = ({ initial = ALL_TASK_STATUSES }: { initial?: readonly TaskStatus[] }) => {
  const [value, setValue] = useState(initial);
  return <><TaskStatusFilter value={value} onChange={setValue} /><button type="button">Outside</button></>;
};
const setup = (initial?: readonly TaskStatus[]) => render(<LocaleProvider initial={{ locale: 'en', issue: null }}><Harness {...(initial === undefined ? {} : { initial })} /></LocaleProvider>);

const TagPopover = () => {
  const [open, setOpen] = useState(false);
  const popover = useTagFilterPopover(open, setOpen);
  return <details ref={popover.rootRef} open={open} onToggle={event => setOpen(event.currentTarget.open)} onKeyDown={popover.onKeyDown}>
    <summary ref={popover.triggerRef} onClick={event => { event.preventDefault(); setOpen(!open); }}>Tag filter</summary>
    <div ref={popover.panelRef}><input ref={popover.searchRef} aria-label="Find tags" /></div>
  </details>;
};

it('toggles individual and all statuses without closing, including mixed and empty choices', () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Status: All statuses' }));
  const group = screen.getByRole('group', { name: 'Status' });
  const all = within(group).getByRole('checkbox', { name: 'All statuses' }) as HTMLInputElement;
  expect(all).toBeChecked(); expect(all.indeterminate).toBe(false);
  fireEvent.click(within(group).getByRole('checkbox', { name: 'Done' }));
  expect(screen.getByRole('button', { name: 'Status: 4 selected' })).toHaveAttribute('aria-expanded', 'true');
  expect(all).not.toBeChecked(); expect(all.indeterminate).toBe(true);
  fireEvent.click(all);
  expect(all).toBeChecked(); expect(all.indeterminate).toBe(false);
  fireEvent.click(all);
  expect(screen.getByRole('button', { name: 'Status: No statuses selected' })).toHaveAttribute('aria-expanded', 'true');
  expect(all).not.toBeChecked(); expect(all.indeterminate).toBe(false);
  fireEvent.click(within(group).getByRole('checkbox', { name: 'To do' }));
  expect(screen.getByRole('button', { name: 'Status: To do' })).toBeVisible();
  expect(all.indeterminate).toBe(true);
  fireEvent.click(all);
  expect(within(group).getAllByRole('checkbox').every(input => (input as HTMLInputElement).checked)).toBe(true);
});

it('keeps focus and selection through rerenders, restores trigger focus on Escape, and closes on outside pointer', () => {
  const view = setup(['proposed', 'done']);
  const trigger = screen.getByRole('button', { name: 'Status: 2 selected' });
  fireEvent.click(trigger);
  const done = screen.getByRole('checkbox', { name: 'Done' });
  done.focus();
  view.rerender(<LocaleProvider initial={{ locale: 'en', issue: null }}><Harness initial={['proposed', 'done']} /></LocaleProvider>);
  expect(done).toHaveFocus(); expect(done).toBeChecked();
  const outerEscape = vi.fn(); document.addEventListener('keydown', outerEscape);
  fireEvent.keyDown(done, { key: 'Escape' });
  expect(trigger).toHaveFocus(); expect(trigger).toHaveAttribute('aria-expanded', 'false'); expect(outerEscape).not.toHaveBeenCalled();
  document.removeEventListener('keydown', outerEscape);
  fireEvent.click(trigger); fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

it('closes on Escape after tabbing away without taking Escape from another overlay', () => {
  setup();
  const trigger = screen.getByRole('button', { name: 'Status: All statuses' });
  const outside = screen.getByRole('button', { name: 'Outside' });
  fireEvent.click(trigger); outside.focus();
  const release = registerOverlay(outside, null);
  fireEvent.keyDown(outside, { key: 'Escape' });
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  release();
  fireEvent.keyDown(outside, { key: 'Escape' });
  expect(trigger).toHaveAttribute('aria-expanded', 'false'); expect(trigger).toHaveFocus();
});

it('lets a task dialog handle Escape while the filter remains open underneath', () => {
  const onDialogEscape = vi.fn();
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><Harness /><div role="dialog" aria-label="Task details" onKeyDown={event => { if (event.key === 'Escape') onDialogEscape(); }}><button type="button">Close task</button></div></LocaleProvider>);
  const trigger = screen.getByRole('button', { name: 'Status: All statuses' });
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Task details' });
  const release = registerOverlay(dialog, null);
  const close = within(dialog).getByRole('button', { name: 'Close task' });
  close.focus(); fireEvent.keyDown(close, { key: 'Escape' });
  expect(onDialogEscape).toHaveBeenCalledOnce();
  expect(trigger).toHaveAttribute('aria-expanded', 'true'); expect(close).toHaveFocus();
  release();
});

it('coordinates keyboard opening with the tag filter in both directions', async () => {
  const user = userEvent.setup();
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><Harness /><TagPopover /></LocaleProvider>);
  const trigger = screen.getByRole('button', { name: 'Status: All statuses' });
  const tag = screen.getByText('Tag filter');
  tag.focus(); fireEvent.click(tag);
  expect(tag.closest('details')).toHaveAttribute('open');
  trigger.focus(); await user.keyboard('{Enter}');
  expect(tag.closest('details')).not.toHaveAttribute('open');
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  tag.focus(); fireEvent.click(tag);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(tag.closest('details')).toHaveAttribute('open');
  await user.keyboard('{Escape}');
  expect(tag.closest('details')).not.toHaveAttribute('open'); expect(tag).toHaveFocus();
});

it('uses localized labels and summaries', () => {
  render(<LocaleProvider initial={{ locale: 'zh-CN', issue: null }}><Harness initial={[]} /></LocaleProvider>);
  fireEvent.click(screen.getByRole('button', { name: '状态: 未选择状态' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '进行中' }));
  expect(screen.getByRole('button', { name: '状态: 进行中' })).toBeVisible();
  fireEvent.click(screen.getByRole('checkbox', { name: '已完成' }));
  expect(screen.getByRole('button', { name: '状态: 已选 2 项' })).toBeVisible();
});
