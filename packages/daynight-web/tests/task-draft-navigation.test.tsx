import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { registerOverlay } from '../src/app/overlay';
import { browserNavigation } from '../src/app/navigation';
import { navigate } from '../src/app/router';
import { DraftNavigationConfirmation, TaskDraftBoundary, useDirtyTaskDraft, useRequestTaskDraftAction, useRetireTaskDraft } from '../src/features/task-detail/TaskDraftNavigation';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import type { CacheEvent } from '../src/features/task-cache/project-cache';
import { renderWithLocale } from './helpers/renderWithLocale';

const projectId = 'a0000000-0000-0000-0000-000000000001';
const taskId = 'b0000000-0000-0000-0000-000000000001';
const path = `/projects/${projectId}/tasks/${taskId}`;
const scopes: TaskCacheScope[] = [];
afterEach(() => { for (const scope of scopes.splice(0)) scope.dispose(); });
const Consumer = ({ discard, retired }: { readonly discard: () => void; readonly retired: boolean }) => {
  const [value, setValue] = useState('');
  const owner = useRef<HTMLElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  useDirtyTaskDraft({ isDirty: () => value !== '', discard: () => { discard(); setValue(''); } });
  useRetireTaskDraft(retired);
  useLayoutEffect(() => registerOverlay(owner.current!, null), []);
  return <><section ref={owner}><textarea aria-label="Draft" ref={editor} value={value} onChange={(event) => setValue(event.target.value)} /></section>
    <DraftNavigationConfirmation owner={owner} fallbackFocus={editor} taskTitle="Task title" /></>;
};
const mount = (page = true) => {
  const scope = createTaskCacheScope({ userId: 'c0000000-0000-0000-0000-000000000001', onIdentityMismatch: vi.fn() });
  scopes.push(scope);
  let event!: (event: CacheEvent) => void;
  vi.spyOn(scope, 'subscribe').mockImplementation((listener) => { event = listener; return () => {}; });
  const discard = vi.fn();
  const view = (retired = false) => <TaskCacheProvider scope={scope}><TaskDraftBoundary projectId={projectId} taskId={taskId} page={page}><Consumer discard={discard} retired={retired} /></TaskDraftBoundary></TaskCacheProvider>;
  const rendered = renderWithLocale(view(), { locale: 'en' });
  return { ...rendered, discard, scope, publish: (value: CacheEvent) => event(value), retire: () => rendered.rerender(view(true)) };
};

describe('task draft lifecycle and confirmation', () => {
  it('keeps same-task tab and attachment changes, cancels and then protects new drafts after discard', () => {
    history.replaceState(null, '', path);
    const result = mount();
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'private draft' } });
    act(() => navigate(`${path}?tab=discussion`));
    act(() => navigate(`${path}/attachments/readme.md`));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    editor.focus();
    act(() => navigate('/projects'));
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(editor).toHaveFocus();
    expect(editor).toHaveValue('private draft');
    act(() => browserNavigation().requestAction(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(result.discard).toHaveBeenCalledOnce();
    expect(editor).toHaveValue('');
    fireEvent.change(editor, { target: { value: 'second draft' } });
    act(() => navigate('/projects'));
    expect(screen.getByRole('alertdialog')).toBeVisible();
  });

  it('guards a modal-to-page transition even when the target task ID is unchanged', () => {
    const { discard } = mount(false);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'modal draft' } });
    act(() => navigate(path));
    expect(location.pathname).toBe('/projects');
    expect(screen.getByRole('alertdialog')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(location.pathname).toBe(path);
    expect(discard).toHaveBeenCalledOnce();
  });

  it('clears only proven project revocation and ends a pending choice without executing it', () => {
    const result = mount();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'private' } });
    act(() => result.publish({ projectId, error: new Error('Temporary read failure') }));
    expect(screen.getByRole('textbox')).toHaveValue('private');
    const action = vi.fn(); act(() => browserNavigation().requestAction(action));
    act(() => result.publish({ projectId: 'unrelated', accessRevoked: true }));
    expect(screen.getByRole('alertdialog')).toBeVisible();
    act(() => result.publish({ projectId, accessRevoked: true }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(action).not.toHaveBeenCalled();
  });

  it.each(['identity', 'task'] as const)('clears private text on %s retirement', (kind) => {
    const result = mount();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'private' } });
    act(() => { if (kind === 'identity') result.scope.dispose(); else result.retire(); });
    expect(result.discard).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox')).toHaveValue('');
    act(() => navigate('/account'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});


const NestedDraft = ({ owner, name, onClose }: { readonly owner: RefObject<HTMLElement | null>; readonly name: string; readonly onClose: () => void }) => {
  const [value, setValue] = useState('');
  const editor = useRef<HTMLTextAreaElement>(null);
  useDirtyTaskDraft({ isDirty: () => value !== '', discard: () => setValue('') });
  const scoped = useRequestTaskDraftAction();
  return <><section ref={owner}><textarea ref={editor} aria-label={name} value={value} onChange={(event) => setValue(event.target.value)} />
    <button type="button" onClick={() => scoped(onClose)}>Close child</button>
    <button type="button" onClick={() => browserNavigation().requestAction(onClose)}>Leave both</button></section>
    <DraftNavigationConfirmation owner={owner} fallbackFocus={editor} taskTitle={name} /></>;
};

it('guards only the closing child and uses one confirmation at the nearest active owner', () => {
  const close = vi.fn();
  const scope = createTaskCacheScope({ userId: 'c0000000-0000-0000-0000-000000000001', onIdentityMismatch: vi.fn() });
  scopes.push(scope);
  const Harness = () => {
    const goal = useRef<HTMLElement>(null), graph = useRef<HTMLElement>(null), child = useRef<HTMLElement>(null);
    useLayoutEffect(() => {
      const a = registerOverlay(goal.current!, null), b = registerOverlay(graph.current!, goal.current!), c = registerOverlay(child.current!, graph.current!);
      return () => { c(); b(); a(); };
    }, []);
    return <TaskCacheProvider scope={scope}><TaskDraftBoundary projectId={projectId} taskId={taskId} page={false}>
      <NestedDraft name="Goal" owner={goal} onClose={close} /></TaskDraftBoundary><section ref={graph} />
      <TaskDraftBoundary projectId={projectId} taskId="b0000000-0000-0000-0000-000000000002" page={false}>
      <NestedDraft name="Child" owner={child} onClose={close} /></TaskDraftBoundary></TaskCacheProvider>;
  };
  renderWithLocale(<Harness />, { locale: 'en' });
  fireEvent.change(screen.getByLabelText('Goal', { selector: 'textarea' }), { target: { value: 'goal draft' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Close child', hidden: true })[1]!);
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.change(screen.getByLabelText('Child', { selector: 'textarea' }), { target: { value: 'child draft' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Leave both', hidden: true })[1]!);
  expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  expect(screen.getByRole('alertdialog')).toHaveTextContent('Child');
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Close child', hidden: true })[1]!);
  expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
  expect(screen.getByLabelText('Goal', { selector: 'textarea' })).toHaveValue('goal draft');
  expect(screen.getByLabelText('Child', { selector: 'textarea' })).toHaveValue('');
  expect(close).toHaveBeenCalledTimes(2);
});
