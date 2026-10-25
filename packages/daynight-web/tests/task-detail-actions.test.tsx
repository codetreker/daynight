import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TaskDetailActions } from '../src/features/task-detail/TaskDetailActions';
import { renderWithLocale } from './helpers/renderWithLocale';

describe('task detail actions menu', () => {
  it('opens from either keyboard direction, wraps through enabled actions and restores its trigger on Escape', () => {
    const onDelete = vi.fn();
    renderWithLocale(<TaskDetailActions popout="/tasks/example" canDelete onDelete={onDelete} />, { locale: 'en' });
    const trigger = screen.getByRole('button', { name: 'More task actions' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const popout = screen.getByRole('menuitem', { name: 'Open in new tab' });
    const deletion = screen.getByRole('menuitem', { name: 'Delete task' });
    expect(popout).toHaveFocus();
    fireEvent.keyDown(popout, { key: 'ArrowUp' });
    expect(deletion).toHaveFocus();
    fireEvent.keyDown(deletion, { key: 'Home' });
    expect(popout).toHaveFocus();
    fireEvent.keyDown(popout, { key: 'End' });
    expect(deletion).toHaveFocus();
    fireEvent.keyDown(deletion, { key: 'ArrowDown' });
    expect(popout).toHaveFocus();
    expect(fireEvent.keyDown(popout, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Delete task' })).toHaveFocus();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete task' }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps navigation available while deletion is disabled, updates its URL and dismisses outside or on Tab', async () => {
    const onDelete = vi.fn();
    const view = renderWithLocale(<><TaskDetailActions popout="/tasks/example" canDelete={false} onDelete={onDelete} /><button>Close</button></>, { locale: 'en' });
    const trigger = screen.getByRole('button', { name: 'More task actions' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Delete task' })).toBeDisabled();
    const popout = screen.getByRole('menuitem', { name: 'Open in new tab' });
    expect(popout).toHaveFocus();
    expect(popout).toHaveAttribute('target', '_blank');
    expect(popout).toHaveAttribute('rel', 'noopener noreferrer');
    fireEvent.keyDown(popout, { key: 'ArrowDown' });
    expect(popout).toHaveFocus();
    view.rerender(<><TaskDetailActions popout="/tasks/example/attachments/guide.md" canDelete={false} onDelete={onDelete} /><button>Close</button></>);
    expect(popout).toHaveAttribute('href', '/tasks/example/attachments/guide.md');
    await userEvent.setup().tab();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('supports a Chinese deletion-only menu without a new-tab action', () => {
    renderWithLocale(<TaskDetailActions canDelete onDelete={vi.fn()} />, { locale: 'zh-CN' });
    fireEvent.click(screen.getByRole('button', { name: '更多任务操作' }));
    expect(screen.getByRole('menu', { name: '更多任务操作' })).toBeVisible();
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    expect(screen.getByRole('menuitem', { name: '删除任务' })).toHaveFocus();
  });
});
