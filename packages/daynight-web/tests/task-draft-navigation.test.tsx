import { act, fireEvent, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { registerOverlay } from '../src/app/overlay';
import { browserNavigation } from '../src/app/navigation';
import { useBrowserLocation } from '../src/app/browser-location';
import { useMyTasksHistory } from '../src/app/use-page-history';
import { myTasksHistory, projectHistory, readProjectHistory, type MyTasksReading, type ProjectReading } from '../src/app/page-history';
import { navigate } from '../src/app/router';
import { DraftNavigationConfirmation, MyTasksDraftHost, ProjectDraftHost, ResourceChildDraftHost, TaskDraftBoundary, useDirtyTaskDraft, useRequestTaskDraftAction, useRetireTaskDraft } from '../src/features/task-detail/TaskDraftNavigation';
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


it.each(['summary', 'direct'] as const)('protects a Project %s draft when the same Task switches source', (source) => {
  const userId = 'c0000000-0000-0000-0000-000000000001';
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  scopes.push(scope);
  const initial: ProjectReading = { section: 'tasks', view: 'standalone', projectGraphWitness: null,
    detail: { id: taskId, source, insideProjectGraph: false, navigation: { tab: 'overview', path: null }, goalChildren: null } };
  const otherSource: 'summary' | 'direct' = source === 'summary' ? 'direct' : 'summary';
  history.replaceState(null, '', `/projects/${projectId}`);
  const navigation = browserNavigation();
  navigation.setView(projectHistory(userId, projectId, initial), { replace: true });
  const discard = vi.fn();
  const Harness = () => {
    const location = useBrowserLocation();
    const selection = readProjectHistory(location.view, userId, projectId)!;
    const detail = selection.detail!;
    return <TaskCacheProvider scope={scope}><ProjectDraftHost projectId={projectId} taskId={taskId} source={detail.source} summaryType={'task'} insideProjectGraph={false} graphWitness={null}>
      <TaskDraftBoundary key={detail.source} projectId={projectId} taskId={taskId} page={false}><Consumer discard={discard} retired={false} /></TaskDraftBoundary>
    </ProjectDraftHost></TaskCacheProvider>;
  };
  renderWithLocale(<Harness />, { locale: 'en' });
  const editor = screen.getByRole('textbox');
  fireEvent.change(editor, { target: { value: 'keep this draft' } });
  const same = { ...initial, detail: { ...initial.detail!, navigation: { tab: 'discussion' as const, path: null } } };
  act(() => navigation.setView(projectHistory(userId, projectId, same)));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByRole('textbox')).toBe(editor);
  expect(editor).toHaveValue('keep this draft');
  const next = { ...same, detail: { ...same.detail, source: otherSource } };
  act(() => navigation.setView(projectHistory(userId, projectId, next)));
  expect(screen.getByRole('alertdialog')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(editor).toHaveValue('keep this draft');
  expect(readProjectHistory(navigation.snapshot().view, userId, projectId)!.detail!.source).toBe(source);
  act(() => navigation.setView(projectHistory(userId, projectId, next)));
  fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
  expect(discard).toHaveBeenCalledOnce();
  expect(readProjectHistory(navigation.snapshot().view, userId, projectId)!.detail!.source).toBe(otherSource);
  expect(screen.getByRole('textbox')).not.toBe(editor);
  expect(screen.getByRole('textbox')).toHaveValue('');
});


it.each([['goal', 'direct'], ['goal', 'summary'], ['child', 'direct'], ['child', 'summary']] as const)('keeps the Project %s draft when the same Goal changes from %s', (kind, source) => {
  const userId = 'c0000000-0000-0000-0000-000000000001';
  const childId = 'b0000000-0000-0000-0000-000000000002';
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  scopes.push(scope);
  const initial: ProjectReading = { section: 'tasks', view: 'goals', projectGraphWitness: null,
    detail: { id: taskId, source, insideProjectGraph: false, navigation: { tab: 'overview', path: null },
      goalChildren: { graphRootId: null, task: { id: childId, navigation: { tab: 'overview', path: null } } } } };
  history.replaceState(null, '', `/projects/${projectId}`);
  const navigation = browserNavigation();
  navigation.setView(projectHistory(userId, projectId, initial), { replace: true });
  const discard = vi.fn();
  const Harness = () => {
    const location = useBrowserLocation();
    const selection = readProjectHistory(location.view, userId, projectId)!;
    const content = <TaskDraftBoundary projectId={projectId} taskId={kind === 'goal' ? taskId : childId} page={false} projectSourceSensitive={kind !== 'goal'}><Consumer discard={discard} retired={false} /></TaskDraftBoundary>;
    return <TaskCacheProvider scope={scope}><ProjectDraftHost projectId={projectId} taskId={taskId} source={selection.detail!.source} summaryType={'goal'} insideProjectGraph={false} graphWitness={null}>
      {kind === 'child' ? <ResourceChildDraftHost>{content}</ResourceChildDraftHost> : content}
    </ProjectDraftHost></TaskCacheProvider>;
  };
  renderWithLocale(<Harness />, { locale: 'en' });
  const editor = screen.getByRole('textbox');
  fireEvent.change(editor, { target: { value: 'retained Goal draft' } });
  const nextSource = source === 'summary' ? 'direct' as const : 'summary' as const;
  const next = { ...initial, detail: { ...initial.detail!, source: nextSource } };
  act(() => navigation.setView(projectHistory(userId, projectId, next)));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(readProjectHistory(navigation.snapshot().view, userId, projectId)!.detail!.source).toBe(nextSource);
  expect(screen.getByRole('textbox')).toBe(editor);
  expect(editor).toHaveValue('retained Goal draft');
  expect(discard).not.toHaveBeenCalled();
});


it.each(['goal', 'child'] as const)('protects the %s draft when an available graph cannot confirm the target Goal', (kind) => {
  const userId = 'c0000000-0000-0000-0000-000000000001';
  const childId = 'b0000000-0000-0000-0000-000000000002';
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  scopes.push(scope);
  const initial: ProjectReading = { section: 'tasks', view: 'goals', projectGraphWitness: null,
    detail: { id: taskId, source: 'direct', insideProjectGraph: false, navigation: { tab: 'overview', path: null },
      goalChildren: { graphRootId: null, task: { id: childId, navigation: { tab: 'overview', path: null } } } } };
  history.replaceState(null, '', `/projects/${projectId}`);
  const navigation = browserNavigation();
  navigation.setView(projectHistory(userId, projectId, initial), { replace: true });
  const discard = vi.fn();
  const Harness = () => {
    const location = useBrowserLocation();
    const selection = readProjectHistory(location.view, userId, projectId)!;
    const content = <TaskDraftBoundary projectId={projectId} taskId={kind === 'goal' ? taskId : childId} page={false} projectSourceSensitive={kind !== 'goal'}><Consumer discard={discard} retired={false} /></TaskDraftBoundary>;
    return <TaskCacheProvider scope={scope}><ProjectDraftHost projectId={projectId} taskId={taskId} source={selection.detail!.source} summaryType={null} insideProjectGraph={false} graphWitness={null}>
      {kind === 'child' ? <ResourceChildDraftHost>{content}</ResourceChildDraftHost> : content}
    </ProjectDraftHost></TaskCacheProvider>;
  };
  renderWithLocale(<Harness />, { locale: 'en' });
  const editor = screen.getByRole('textbox');
  fireEvent.change(editor, { target: { value: 'keep Goal reader' } });
  const next = { ...initial, detail: { ...initial.detail!, source: 'summary' as const } };
  act(() => navigation.setView(projectHistory(userId, projectId, next)));
  expect(screen.getByRole('alertdialog')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(editor).toHaveValue('keep Goal reader');
  expect(discard).not.toHaveBeenCalled();
  expect(readProjectHistory(navigation.snapshot().view, userId, projectId)!.detail!.source).toBe('direct');
});

it.each(['goal', 'child'] as const)('keeps overview %s drafts on same-reader navigation and protects leaving', (kind) => {
  const userId = 'c0000000-0000-0000-0000-000000000001';
  const childId = 'b0000000-0000-0000-0000-000000000002';
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  scopes.push(scope);
  const initial: MyTasksReading = { projectPages: { [projectId]: 2 }, detail: { projectId, id: taskId,
    navigation: { tab: 'overview', path: null }, goalChildren: { graphRootId: null, task: { id: childId, navigation: { tab: 'overview', path: null } } } } };
  history.replaceState(null, '', '/my-tasks');
  const navigation = browserNavigation();
  navigation.setView(myTasksHistory(userId, initial), { replace: true });
  const discard = vi.fn();
  const content = <TaskDraftBoundary projectId={projectId} taskId={kind === 'goal' ? taskId : childId} page={false}><Consumer discard={discard} retired={false} /></TaskDraftBoundary>;
  renderWithLocale(<TaskCacheProvider scope={scope}><MyTasksDraftHost projectId={projectId} taskId={taskId}>
    {kind === 'child' ? <ResourceChildDraftHost>{content}</ResourceChildDraftHost> : content}
  </MyTasksDraftHost></TaskCacheProvider>, { locale: 'en' });
  const editor = screen.getByRole('textbox');
  fireEvent.change(editor, { target: { value: 'draft' } });
  const same = { ...initial, detail: { ...initial.detail!, navigation: { tab: 'discussion' as const, path: null },
    goalChildren: { graphRootId: childId, task: { id: childId, navigation: { tab: 'attachments' as const, path: null } } } } };
  act(() => navigation.setView(myTasksHistory(userId, same)));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(editor).toHaveValue('draft');
  const next = kind === 'goal' ? { ...same, detail: null } : { ...same, detail: { ...same.detail, goalChildren: null } };
  act(() => navigation.setView(myTasksHistory(userId, next)));
  expect(screen.getByRole('alertdialog')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(editor).toHaveValue('draft');
  expect(discard).not.toHaveBeenCalled();
});

it('keeps newly admitted overview entries and drafts after an earlier project retirement', () => {
  const userId = 'c0000000-0000-0000-0000-000000000001';
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  scopes.push(scope);
  history.replaceState(null, '', '/my-tasks');
  const { result } = renderHook(() => useMyTasksHistory(userId, true, scope));
  act(() => scope.suspendProject(projectId));
  const initial: MyTasksReading = { projectPages: {}, detail: { projectId, id: taskId, navigation: { tab: 'overview', path: null }, goalChildren: null } };
  act(() => result.current.select(initial));
  const source = history.state;
  const discard = vi.fn();
  renderWithLocale(<TaskCacheProvider scope={scope}><MyTasksDraftHost projectId={projectId} taskId={taskId}>
    <TaskDraftBoundary projectId={projectId} taskId={taskId} page={false}><Consumer discard={discard} retired={false} /></TaskDraftBoundary>
  </MyTasksDraftHost></TaskCacheProvider>, { locale: 'en' });
  const editor = screen.getByRole('textbox');
  fireEvent.change(editor, { target: { value: 'draft' } });
  const next = { ...initial, detail: { ...initial.detail!, navigation: { tab: 'discussion' as const, path: null } } };
  act(() => result.current.select(next));
  expect(result.current.selection).toEqual(next);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  act(() => { history.replaceState(source, '', '/my-tasks'); dispatchEvent(new PopStateEvent('popstate', { state: source })); });
  expect(result.current.selection).toEqual(initial);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(editor).toHaveValue('draft');
  expect(discard).not.toHaveBeenCalled();
});
