import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { TaskDetail, TaskTag } from '../src/api/types';
import type { TaskMutationState } from '../src/features/task-detail/TaskDetailSession';
import { TaskTagsEditor } from '../src/features/task-tags/TaskTagsEditor';
import { LocaleProvider } from '../src/i18n/LocaleProvider';

const navigationDraft = vi.hoisted(() => ({ current: null as null | { isDirty: () => boolean; discard: () => void } }));
vi.mock('../src/features/task-detail/TaskDraftNavigation', () => ({ useDirtyTaskDraft: (draft: typeof navigationDraft.current) => { navigationDraft.current = draft; } }));
vi.mock('../src/features/task-tags/TagPicker', () => ({ TagPicker: ({ value, onChange, onNameDirty }: { value: readonly TaskTag[]; onChange: (value: readonly TaskTag[]) => void; onNameDirty: (dirty: boolean) => void }) => <div><label>New name<input onChange={event => onNameDirty(event.currentTarget.value !== '')} /></label><span data-testid="draft">{value.map(tag => tag.name).join(',')}</span><button type="button" onClick={() => onChange([...value, { id: 'b', name: 'Beta' }])}>Add Beta</button></div> }));
const detail: TaskDetail = { id: 'task', projectId: 'project', type: 'task', parentId: null, assignedTo: null, title: 'Task', description: '', status: 'todo', version: 1n, tags: [{ id: 'a', name: 'Alpha' }], allowAgents: false, requiredPlatform: null, ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], properties: {}, startedAt: null, completedAt: null, cancelledAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const idle: TaskMutationState = { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null };
const operation = { action: 'tags' as const, tagIds: ['a'], version: 1n };
const make = (current: TaskDetail, mutation: TaskMutationState, setTags: (ids: readonly string[], version: bigint) => void, reconcile = vi.fn(), canMutate = mutation.phase !== 'pending') => <LocaleProvider initial={{ locale: 'en', issue: null }}><TaskTagsEditor projectId="project" detail={current} tags={current.tags} canMutate={canMutate} mutation={mutation} setTags={setTags} reconcile={reconcile} /></LocaleProvider>;

it('keeps the original draft across fresh detail and requires explicit version adoption', () => {
  const save = vi.fn(); const view = render(make(detail, idle, save));
  fireEvent.click(screen.getByRole('button', { name: 'Edit tags' })); fireEvent.click(screen.getByRole('button', { name: 'Add Beta' }));
  const fresh = { ...detail, version: 2n, tags: [{ id: 'c', name: 'Current' }] }; view.rerender(make(fresh, idle, save));
  expect(screen.getByTestId('draft')).toHaveTextContent('Alpha,Beta'); expect(screen.getAllByText('Current')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Keep draft and use current version' })); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(save).toHaveBeenCalledWith(['a', 'b'], 2n);
});

it('retains edits made while saving and does not let the old receipt close a reopened editor', async () => {
  const save = vi.fn(); const view = render(make(detail, idle, save));
  fireEvent.click(screen.getByRole('button', { name: 'Edit tags' })); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  view.rerender(make(detail, { ...idle, operation, phase: 'pending' }, save));
  fireEvent.click(screen.getByRole('button', { name: 'Add Beta' }));
  view.rerender(make(detail, { ...idle, operation, phase: 'confirmed' }, save));
  await waitFor(() => expect(screen.getByTestId('draft')).toHaveTextContent('Alpha,Beta'));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); fireEvent.click(screen.getByRole('button', { name: 'Edit tags' }));
  expect(screen.getByTestId('draft')).toHaveTextContent('Alpha');
});

it('shows a batched unknown outcome without replaying and keeps the draft', () => {
  const save = vi.fn(); const view = render(make(detail, idle, save));
  fireEvent.click(screen.getByRole('button', { name: 'Edit tags' })); fireEvent.click(screen.getByRole('button', { name: 'Add Beta' })); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  view.rerender(make(detail, { ...idle, operation, phase: 'unknown' }, save));
  expect(screen.getByText(/outcome is unknown/)).toBeVisible(); expect(screen.getByTestId('draft')).toHaveTextContent('Alpha,Beta');
  fireEvent.click(screen.getByRole('button', { name: 'Check current state' })); expect(save).toHaveBeenCalledOnce();
});

 it('retains a new tag name typed while an association save is pending', async () => {
  const save = vi.fn(); const view = render(make(detail, idle, save));
  fireEvent.click(screen.getByRole('button', { name: 'Edit tags' })); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  view.rerender(make(detail, { ...idle, operation, phase: 'pending' }, save));
  fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'later' } });
  view.rerender(make(detail, { ...idle, operation, phase: 'confirmed' }, save));
  await waitFor(() => expect(screen.getByLabelText('New name')).toHaveValue('later'));
});

it('retains a refused draft after detail advances and lets the user compare and adopt the current version', () => {
  const save = vi.fn(); const view = render(make(detail, idle, save));
  fireEvent.click(screen.getByRole('button', { name: 'Edit tags' })); fireEvent.click(screen.getByRole('button', { name: 'Add Beta' })); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const refused: TaskMutationState = { ...idle, operation: { action: 'tags', tagIds: ['a', 'b'], version: 1n }, phase: 'refused', error: new Error('refused') };
  const fresh = { ...detail, version: 2n, tags: [{ id: 'c', name: 'Current' }] }; view.rerender(make(fresh, refused, save));
  expect(screen.getByTestId('draft')).toHaveTextContent('Alpha,Beta');
  expect(screen.getAllByText('Current')).toHaveLength(2); expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Keep draft and use current version' }));
  expect(navigationDraft.current?.isDirty()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save' })); expect(save).toHaveBeenLastCalledWith(['a', 'b'], 2n);
});

it('keeps the draft protected after adopting the current version following conflict', () => {
  const save = vi.fn(); const view = render(make(detail, idle, save));
  fireEvent.click(screen.getByRole('button', { name: 'Edit tags' })); fireEvent.click(screen.getByRole('button', { name: 'Add Beta' })); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const conflict: TaskMutationState = { ...idle, operation: { action: 'tags', tagIds: ['a', 'b'], version: 1n }, phase: 'conflict' };
  const fresh = { ...detail, version: 2n, tags: [{ id: 'c', name: 'Current' }] }; view.rerender(make(fresh, conflict, save));
  expect(screen.getByTestId('draft')).toHaveTextContent('Alpha,Beta');
  fireEvent.click(screen.getByRole('button', { name: 'Keep draft and use current version' }));
  expect(navigationDraft.current?.isDirty()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save' })); expect(save).toHaveBeenLastCalledWith(['a', 'b'], 2n);
});

it('retains later selections when a confirmed save is followed by different current tags', () => {
  const save = vi.fn(); const view = render(make(detail, idle, save));
  fireEvent.click(screen.getByRole('button', { name: 'Edit tags' })); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  view.rerender(make(detail, { ...idle, operation, phase: 'pending' }, save));
  fireEvent.click(screen.getByRole('button', { name: 'Add Beta' }));
  const fresh = { ...detail, version: 3n, tags: [{ id: 'c', name: 'Current' }] };
  view.rerender(make(fresh, { ...idle, operation, phase: 'confirmed' }, save));
  expect(screen.getByTestId('draft')).toHaveTextContent('Alpha,Beta');
  expect(screen.getAllByText('Current')).toHaveLength(2); expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Keep draft and use current version' }));
  expect(navigationDraft.current?.isDirty()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save' })); expect(save).toHaveBeenLastCalledWith(['a', 'b'], 3n);
});

it.each(['Cancel', 'Escape'] as const)('offers recovery after %s closes an editor with an unknown write and failed check', close => {
  const save = vi.fn(), reconcile = vi.fn(); const view = render(make(detail, idle, save, reconcile));
  fireEvent.click(screen.getByRole('button', { name: 'Edit tags' })); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const unknown: TaskMutationState = { ...idle, operation, phase: 'unknown', error: new Error('lost response'), reconciliationError: new Error('offline') };
  view.rerender(make(detail, unknown, save, reconcile, false));
  if (close === 'Cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  else fireEvent.keyDown(screen.getByLabelText('New name'), { key: 'Escape' });
  expect(screen.queryByTestId('draft')).toBeNull();
  expect(screen.getByText(/outcome is unknown/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Edit tags' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Check current state' }));
  expect(reconcile).toHaveBeenCalledOnce(); expect(save).toHaveBeenCalledOnce();
  view.rerender(make(detail, { ...unknown, reconciling: true, reconciliationError: null }, save, reconcile, false));
  expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  view.rerender(make(detail, { ...unknown, phase: 'reconciled', reconciledFrom: 'unknown', reconciliationError: null }, save, reconcile, true));
  fireEvent.click(screen.getByRole('button', { name: 'Edit tags' }));
  expect(screen.getByTestId('draft')).toHaveTextContent('Alpha'); expect(save).toHaveBeenCalledOnce();
});
