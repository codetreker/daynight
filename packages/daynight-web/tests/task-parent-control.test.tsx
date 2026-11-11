import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TaskDetail, TaskSummary } from '../src/api/types';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { ExistingSelection, TaskParentControl } from '../src/features/task-detail/TaskOrganization';
import * as taskDetailHook from '../src/features/task-detail/useTaskDetail';
import type { TaskMutationState } from '../src/features/task-detail/TaskDetailSession';
import { renderWithLocale } from './helpers/renderWithLocale';

const goal = (id: string, title: string) => ({ id, type: 'goal', titlePreview: title, titleTruncated: false } as TaskSummary);
const snapshot = { summaries: new Map([['a', goal('a', 'Goal A')], ['b', goal('b', 'Goal B')]]), index: { nodes: new Map() }, revision: 1 } as unknown as GraphSnapshot;
const detail = { parentId: 'a', version: 9007199254740993n } as TaskDetail;
const idle: TaskMutationState = { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null };

describe('Task Goal control', () => {
  it('moves or removes membership using the exact reviewed Task version', () => {
    const onSelect = vi.fn();
    const view = renderWithLocale(<TaskParentControl detail={detail} snapshot={snapshot} disabled={false} mutation={idle} onSelect={onSelect} onReconcile={vi.fn()} />, { locale: 'en' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Current Goal' }), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal membership' }));
    expect(onSelect).toHaveBeenLastCalledWith('b', 9007199254740993n);
    view.rerender(<TaskParentControl detail={detail} snapshot={snapshot} disabled={false} mutation={idle} onSelect={onSelect} onReconcile={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Current Goal' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal membership' }));
    expect(onSelect).toHaveBeenLastCalledWith(null, 9007199254740993n);
  });
  it('retains the selection on an unknown result and offers a read without replaying the write', () => {
    const onSelect = vi.fn(); const onReconcile = vi.fn();
    const unknown: TaskMutationState = { operation: { action: 'parent', parentId: 'b', version: detail.version }, phase: 'unknown', error: new Error('Connection lost'), reconciling: false, reconciliationError: null };
    const view = renderWithLocale(<TaskParentControl detail={detail} snapshot={snapshot} disabled={false} mutation={idle} onSelect={onSelect} onReconcile={onReconcile} />, { locale: 'en' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Current Goal' }), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal membership' }));
    view.rerender(<TaskParentControl detail={detail} snapshot={snapshot} disabled mutation={unknown} onSelect={onSelect} onReconcile={onReconcile} />);
    expect(screen.getByRole('combobox', { name: 'Current Goal' })).toHaveValue('b');
    expect(screen.getByRole('button', { name: 'Save Goal membership' })).toBeDisabled();
    expect(screen.getByText('Connection lost')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Check current state' }));
    expect(onReconcile).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledOnce();
  });
  it('updates the displayed Goal without a conflict when the user has not made a selection', () => {
    const view = renderWithLocale(<TaskParentControl detail={detail} snapshot={snapshot} disabled={false} mutation={idle} onSelect={vi.fn()} onReconcile={vi.fn()} />, { locale: 'en' });
    view.rerender(<TaskParentControl detail={{ ...detail, parentId: 'b', version: detail.version + 1n }} snapshot={snapshot} disabled={false} mutation={idle} onSelect={vi.fn()} onReconcile={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Current Goal' })).toHaveValue('b');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save Goal membership' })).toBeDisabled();
  });
  it('keeps a pending choice and blocks it when the reviewed version changes', () => {
    const onSelect = vi.fn();
    const view = renderWithLocale(<TaskParentControl detail={detail} snapshot={snapshot} disabled={false} mutation={idle} onSelect={onSelect} onReconcile={vi.fn()} />, { locale: 'en' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Current Goal' }), { target: { value: 'b' } });
    view.rerender(<TaskParentControl detail={{ ...detail, version: detail.version + 1n }} snapshot={snapshot} disabled={false} mutation={idle} onSelect={onSelect} onReconcile={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Current Goal' })).toHaveValue('b');
    expect(screen.getByRole('alert')).toHaveTextContent('The Task changed');
    expect(screen.getByRole('button', { name: 'Save Goal membership' })).toBeDisabled();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review current Task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Goal membership' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b', detail.version + 1n);
  });
  it('retains a new choice after a previous confirmed move when the Task changes again', () => {
    const confirmed: TaskMutationState = { ...idle, operation: { action: 'parent', parentId: 'b', version: detail.version }, phase: 'confirmed' };
    const moved = { ...detail, parentId: 'b', version: detail.version + 1n };
    const view = renderWithLocale(<TaskParentControl detail={moved} snapshot={snapshot} disabled={false} mutation={confirmed} onSelect={vi.fn()} onReconcile={vi.fn()} />, { locale: 'en' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Current Goal' }), { target: { value: 'a' } });
    view.rerender(<TaskParentControl detail={{ ...moved, version: moved.version + 1n }} snapshot={snapshot} disabled={false} mutation={confirmed} onSelect={vi.fn()} onReconcile={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Current Goal' })).toHaveValue('a');
    expect(screen.getByRole('alert')).toHaveTextContent('The Task changed');
    expect(screen.getByRole('button', { name: 'Save Goal membership' })).toBeDisabled();
  });
  it('requires a new review if the selected Task changes Goal or version before submission', () => {
    const setParent = vi.fn();
    const source = { ...detail, title: 'Selected Task', parentId: 'a' };
    const state = { detail: source, canSetParent: true, mutation: idle, error: null, status: 'ready', setParent, retry: vi.fn() } as unknown as ReturnType<typeof taskDetailHook.useTaskDetail>;
    const hook = vi.spyOn(taskDetailHook, 'useTaskDetail').mockReturnValue(state);
    const view = renderWithLocale(<ExistingSelection projectId="project" taskId="task" goalId="target" snapshot={snapshot} onClose={vi.fn()} />, { locale: 'en' });
    expect(screen.getByText('Current Goal: Goal A (a)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add to Goal' })).toBeEnabled();
    hook.mockReturnValue({ ...state, detail: { ...source, parentId: 'b', version: source.version + 1n } });
    view.rerender(<ExistingSelection projectId="project" taskId="task" goalId="target" snapshot={snapshot} onClose={vi.fn()} />);
    expect(screen.getByText('Current Goal: Goal B (b)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add to Goal' })).toBeDisabled();
    expect(setParent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review current Task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Goal' }));
    expect(setParent).toHaveBeenCalledExactlyOnceWith('target', source.version + 1n);
    hook.mockRestore();
  });
});
