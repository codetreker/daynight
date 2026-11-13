import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { getProjectAccess } from '../src/api/auth';
import { createProjectTag, deleteProjectTag, getProjectTag, listProjectTags, renameProjectTag, type ProjectTag } from '../src/api/task-tags';
import { ProjectAccessBoundary } from '../src/features/projects/ProjectAccess';
import { ProjectTags } from '../src/features/task-tags/ProjectTags';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { LocaleProvider } from '../src/i18n/LocaleProvider';
import { TestTaskCacheBoundary } from './helpers/taskCache';
import { directAccessFixture, TEST_VIEWER_ID } from './helpers/taskSync';

vi.mock('../src/api/auth', async original => ({ ...await original<typeof import('../src/api/auth')>(), getProjectAccess: vi.fn() }));
vi.mock('../src/api/task-tags', async original => ({ ...await original<typeof import('../src/api/task-tags')>(), listProjectTags: vi.fn(), getProjectTag: vi.fn(), createProjectTag: vi.fn(), renameProjectTag: vi.fn(), deleteProjectTag: vi.fn() }));
const projectId = '00000000-0000-4000-8000-000000000031';
const tag: ProjectTag = { id: '00000000-0000-4000-8000-000000000041', projectId, name: 'backend', version: 3n, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', usage: { tasks: 2, goals: 1 } };
const page = { items: [tag], catalogEpoch: '00000000-0000-4000-8000-000000000051', nextCursor: null };
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
const setup = () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const tree = (active: boolean) => <LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={scope}><ProjectAccessBoundary projectId={projectId} initialRead><ProjectTags projectId={projectId} active={active} /></ProjectAccessBoundary></TestTaskCacheBoundary></LocaleProvider>;
  return { scope, tree, ...render(tree(true)) };
};
beforeEach(() => {
  vi.mocked(getProjectAccess).mockReset().mockImplementation(async () => directAccessFixture(projectId));
  vi.mocked(listProjectTags).mockReset().mockResolvedValue(page);
  vi.mocked(getProjectTag).mockReset().mockResolvedValue(tag);
  vi.mocked(createProjectTag).mockReset(); vi.mocked(renameProjectTag).mockReset(); vi.mocked(deleteProjectTag).mockReset();
});
afterEach(() => { for (const scope of scopes.splice(0)) scope.dispose(); });

it('previews the current resource and cancels without a write, then sends its original version', async () => {
  vi.mocked(deleteProjectTag).mockResolvedValue({ projectId, tagId: tag.id, deleted: true });
  setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(await screen.findByRole('button', { name: 'Delete: backend' }));
  let dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('2 Tasks · 1 Goals')).toBeVisible();
  expect(within(dialog).getByText('Version: 3')).toBeVisible();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(deleteProjectTag).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete: backend' }));
  dialog = await screen.findByRole('dialog'); await within(dialog).findByText('Version: 3');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete tag' }));
  await waitFor(() => expect(deleteProjectTag).toHaveBeenCalledOnce());
  expect(vi.mocked(deleteProjectTag).mock.calls[0]!.slice(0, 3)).toEqual([projectId, tag.id, 3n]);
});

it('keeps rename draft through a conflict and requires explicit use of the observed version', async () => {
  const fresh = { ...tag, name: 'current', version: 4n };
  vi.mocked(renameProjectTag).mockRejectedValueOnce(new ApiError('server', 409, 'version_conflict', null, undefined, undefined, undefined, 'not_committed')).mockResolvedValue({ ...fresh, name: 'draft', version: 5n });
  vi.mocked(getProjectTag).mockResolvedValue(fresh);
  setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(await screen.findByRole('button', { name: 'Rename: backend' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'draft' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await within(dialog).findByText(/This tag changed/);
  await within(dialog).findByText('current');
  expect(within(dialog).getByLabelText('Name')).toHaveValue('draft');
  expect(renameProjectTag).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Use current version' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(renameProjectTag).toHaveBeenCalledTimes(2));
  expect(vi.mocked(renameProjectTag).mock.calls[1]![3]).toBe(4n);
});

it('retains an unknown creation until a successful check and never resends it', async () => {
  const observation = Promise.withResolvers<typeof page>();
  vi.mocked(createProjectTag).mockImplementation(async (_project, _name, _signal, admission) => { admission.onDispatch?.(); throw new ApiError('network'); });
  vi.mocked(listProjectTags).mockResolvedValueOnce(page).mockResolvedValueOnce(page).mockReturnValueOnce(observation.promise);
  setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(await screen.findByRole('button', { name: 'New tag' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'draft' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await within(dialog).findByText(/outcome is unknown/);
  expect(within(dialog).getByLabelText('Name')).toHaveValue('draft');
  expect(within(dialog).getByRole('button', { name: 'I checked; close' })).toBeDisabled();
  await act(async () => { observation.resolve(page); });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'I checked; close' })).toBeEnabled());
  expect(createProjectTag).toHaveBeenCalledOnce();
});

it('does not let a late delete preview replace a newer dialog', async () => {
  const pending = Promise.withResolvers<ProjectTag>(); vi.mocked(getProjectTag).mockReturnValue(pending.promise);
  setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(await screen.findByRole('button', { name: 'Delete: backend' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  await act(async () => { pending.resolve(tag); });
  expect(screen.getByRole('dialog')).toHaveTextContent('New tag');
});


it('retains the draft and unknown outcome after leaving during a dispatched write', async () => {
  const pending = Promise.withResolvers<ProjectTag>();
  vi.mocked(createProjectTag).mockImplementation((_project, _name, _signal, admission) => { admission.onDispatch?.(); return pending.promise; });
  const view = setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  let dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'draft' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(createProjectTag).toHaveBeenCalledOnce());
  view.rerender(view.tree(false));
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(view.tree(true));
  dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText('Name')).toHaveValue('draft');
  expect(within(dialog).getByText(/outcome is unknown/)).toBeVisible();
  expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: 'I checked; close' })).toBeDisabled();
  await act(async () => { pending.resolve({ ...tag, name: 'draft' }); await pending.promise; });
  expect(within(dialog).getByText(/outcome is unknown/)).toBeVisible();
  expect(createProjectTag).toHaveBeenCalledOnce();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check current state' }));
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'I checked; close' })).toBeEnabled());
  expect(createProjectTag).toHaveBeenCalledOnce();
});

it('does not let a revoked write completion affect a dialog opened after access returns', async () => {
  const pending = Promise.withResolvers<ProjectTag>();
  vi.mocked(createProjectTag).mockImplementation((_project, _name, _signal, admission) => { admission.onDispatch?.(); return pending.promise; });
  const view = setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  let dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'old draft' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(createProjectTag).toHaveBeenCalledOnce());
  act(() => view.scope.suspendProject(projectId));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  act(() => view.scope.resumeProject(projectId));
  await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'new draft' } });
  await act(async () => { pending.resolve({ ...tag, name: 'old draft' }); await pending.promise; });
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(within(dialog).getByLabelText('Name')).toHaveValue('new draft');
  expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
  expect(createProjectTag).toHaveBeenCalledOnce();
});

it('retains the dispatched draft and unknown outcome after unmounting and remounting in the same scope', async () => {
  const pending = Promise.withResolvers<ProjectTag>();
  vi.mocked(createProjectTag).mockImplementation((_project, _name, _signal, admission) => { admission.onDispatch?.(); return pending.promise; });
  const view = setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  const original = screen.getByRole('dialog');
  fireEvent.change(within(original).getByLabelText('Name'), { target: { value: 'draft across mount' } });
  fireEvent.click(within(original).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(createProjectTag).toHaveBeenCalledOnce());
  view.unmount();
  render(view.tree(true));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText('Name')).toHaveValue('draft across mount');
  expect(within(dialog).getByText(/outcome is unknown/)).toBeVisible();
  expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: 'I checked; close' })).toBeDisabled();
  await act(async () => { pending.resolve({ ...tag, name: 'draft across mount' }); await pending.promise; });
  expect(within(dialog).getByText(/outcome is unknown/)).toBeVisible();
  expect(createProjectTag).toHaveBeenCalledOnce();
});

it('discards an unmounted draft when its scope loses project access', async () => {
  const pending = Promise.withResolvers<ProjectTag>();
  vi.mocked(createProjectTag).mockImplementation((_project, _name, _signal, admission) => { admission.onDispatch?.(); return pending.promise; });
  const view = setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Name'), { target: { value: 'retired draft' } });
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(createProjectTag).toHaveBeenCalledOnce());
  view.unmount();
  act(() => { view.scope.suspendProject(projectId); view.scope.resumeProject(projectId); });
  render(view.tree(true));
  await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByLabelText('Name')).toHaveValue('');
  await act(async () => { pending.resolve({ ...tag, name: 'retired draft' }); await pending.promise; });
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(within(dialog).getByLabelText('Name')).toHaveValue('');
});

it('reenables writing only after a fresh successful access check following a 403', async () => {
  const check = Promise.withResolvers<ReturnType<typeof directAccessFixture>>();
  vi.mocked(getProjectAccess).mockResolvedValueOnce(directAccessFixture(projectId)).mockReturnValueOnce(check.promise);
  vi.mocked(createProjectTag).mockImplementation(async (_project, _name, _signal, admission) => {
    admission.onDispatch?.(); throw new ApiError('server', 403, 'permission_denied', null, undefined, undefined, undefined, 'not_committed');
  });
  setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'retry draft' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
  expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(within(dialog).getByLabelText('Name')).toHaveValue('retry draft');
  await act(async () => { check.resolve(directAccessFixture(projectId)); await check.promise; });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled());
  expect(createProjectTag).toHaveBeenCalledOnce();
});

it('retires a draft when direct access becomes uncertain in the same turn as unmount', async () => {
  const pending = Promise.withResolvers<ProjectTag>();
  vi.mocked(createProjectTag).mockImplementation((_project, _name, _signal, admission) => { admission.onDispatch?.(); return pending.promise; });
  const view = setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Name'), { target: { value: 'uncertain draft' } });
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(createProjectTag).toHaveBeenCalledOnce());
  type AccessEvent = { projectId: string; directAccessUncertain?: true; accessRestored?: true };
  const emit = (event: AccessEvent) => (view.scope as unknown as { emit: (value: AccessEvent) => void }).emit(event);
  act(() => { emit({ projectId, directAccessUncertain: true }); view.unmount(); });
  act(() => emit({ projectId, accessRestored: true }));
  render(view.tree(true));
  await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByLabelText('Name')).toHaveValue('');
  await act(async () => { pending.resolve({ ...tag, name: 'uncertain draft' }); await pending.promise; });
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(within(dialog).getByLabelText('Name')).toHaveValue('');
});

it.each([[403, 'permission_denied'], [404, 'not_found']] as const)('rechecks project access when a tag preview returns project denial %s', async (status, code) => {
  const check = Promise.withResolvers<ReturnType<typeof directAccessFixture>>();
  vi.mocked(getProjectAccess).mockResolvedValueOnce(directAccessFixture(projectId)).mockReturnValueOnce(check.promise);
  vi.mocked(getProjectTag).mockRejectedValue(new ApiError('server', status, code));
  setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Delete: backend' }));
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
  expect(deleteProjectTag).not.toHaveBeenCalled();
  await act(async () => { check.resolve(directAccessFixture(projectId)); await check.promise; });
});

it('treats a missing tag preview as a resource-level result without project access revalidation', async () => {
  vi.mocked(getProjectTag).mockRejectedValue(new ApiError('server', 404, 'tag_not_found'));
  setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  expect(getProjectAccess).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Delete: backend' }));
  const dialog = screen.getByRole('dialog');
  await within(dialog).findByText('Could not load tags.');
  expect(getProjectAccess).toHaveBeenCalledTimes(1);
  expect(within(dialog).getByRole('button', { name: 'Delete tag' })).toBeDisabled();
  expect(deleteProjectTag).not.toHaveBeenCalled();
});

it('retries a failed permission check without replaying the rejected write or losing the draft', async () => {
  const retry = Promise.withResolvers<ReturnType<typeof directAccessFixture>>();
  vi.mocked(getProjectAccess).mockResolvedValueOnce(directAccessFixture(projectId)).mockRejectedValueOnce(new ApiError('network')).mockReturnValueOnce(retry.promise);
  vi.mocked(createProjectTag).mockImplementation(async (_project, _name, _signal, admission) => {
    admission.onDispatch?.(); throw new ApiError('server', 403, 'permission_denied', null, undefined, undefined, undefined, 'not_committed');
  });
  setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'retained draft' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await within(dialog).findByText('Could not confirm project access. Try again.');
  expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(within(dialog).getByLabelText('Name')).toHaveValue('retained draft');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check permission' }));
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(3));
  expect(within(dialog).getByRole('button', { name: 'Checking permission…' })).toBeDisabled();
  expect(createProjectTag).toHaveBeenCalledOnce();
  await act(async () => { retry.resolve(directAccessFixture(projectId)); await retry.promise; });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled());
  expect(within(dialog).getByLabelText('Name')).toHaveValue('retained draft');
  expect(createProjectTag).toHaveBeenCalledOnce();
});

it('retires a permission check on section exit and requires a fresh check on return', async () => {
  const old = Promise.withResolvers<ReturnType<typeof directAccessFixture>>(), fresh = Promise.withResolvers<ReturnType<typeof directAccessFixture>>();
  vi.mocked(getProjectAccess).mockResolvedValueOnce(directAccessFixture(projectId)).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  vi.mocked(createProjectTag).mockImplementation(async (_project, _name, _signal, admission) => {
    admission.onDispatch?.(); throw new ApiError('server', 403, 'permission_denied', null, undefined, undefined, undefined, 'not_committed');
  });
  const view = setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  let dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'draft' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
  view.rerender(view.tree(false));
  await act(async () => { old.resolve(directAccessFixture(projectId)); await old.promise; });
  view.rerender(view.tree(true)); dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText('Name')).toHaveValue('draft');
  expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check permission' }));
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(3));
  await act(async () => { fresh.resolve(directAccessFixture(projectId)); await fresh.promise; });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled());
  expect(createProjectTag).toHaveBeenCalledOnce();
});

it('does not let a retired permission check unlock a newer pending check', async () => {
  const old = Promise.withResolvers<ReturnType<typeof directAccessFixture>>(), fresh = Promise.withResolvers<ReturnType<typeof directAccessFixture>>();
  vi.mocked(getProjectAccess).mockResolvedValueOnce(directAccessFixture(projectId)).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  vi.mocked(createProjectTag).mockImplementation(async (_project, _name, _signal, admission) => {
    admission.onDispatch?.(); throw new ApiError('server', 403, 'permission_denied', null, undefined, undefined, undefined, 'not_committed');
  });
  const view = setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  let dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'draft' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
  view.rerender(view.tree(false)); view.rerender(view.tree(true));
  dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check permission' }));
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(3));
  await act(async () => { old.resolve(directAccessFixture(projectId)); await old.promise; });
  expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(within(dialog).getByLabelText('Name')).toHaveValue('draft');
  await act(async () => { fresh.resolve(directAccessFixture(projectId)); await fresh.promise; });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled());
  expect(createProjectTag).toHaveBeenCalledOnce();
});

it('retains a denied draft across remount without carrying it to another identity scope', async () => {
  const old = Promise.withResolvers<ReturnType<typeof directAccessFixture>>();
  vi.mocked(getProjectAccess).mockResolvedValueOnce(directAccessFixture(projectId)).mockReturnValueOnce(old.promise);
  vi.mocked(createProjectTag).mockImplementation(async (_project, _name, _signal, admission) => {
    admission.onDispatch?.(); throw new ApiError('server', 403, 'permission_denied', null, undefined, undefined, undefined, 'not_committed');
  });
  const view = setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  const original = screen.getByRole('dialog');
  fireEvent.change(within(original).getByLabelText('Name'), { target: { value: 'scope draft' } });
  fireEvent.click(within(original).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(2));
  view.unmount();
  const remount = render(view.tree(true));
  const retained = await screen.findByRole('dialog');
  expect(within(retained).getByLabelText('Name')).toHaveValue('scope draft');
  expect(within(retained).getByRole('button', { name: 'Save' })).toBeDisabled();
  remount.unmount();
  const otherScope = createTaskCacheScope({ userId: '00000000-0000-4000-8000-000000000099', onIdentityMismatch: vi.fn() }); scopes.push(otherScope);
  vi.mocked(getProjectAccess).mockResolvedValue(directAccessFixture(projectId, otherScope.userId));
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><TestTaskCacheBoundary scope={otherScope}><ProjectAccessBoundary projectId={projectId} initialRead><ProjectTags projectId={projectId} /></ProjectAccessBoundary></TestTaskCacheBoundary></LocaleProvider>);
  await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  const fresh = screen.getByRole('dialog');
  expect(within(fresh).getByLabelText('Name')).toHaveValue('');
  await act(async () => { old.resolve(directAccessFixture(projectId)); await old.promise; });
  expect(within(fresh).getByLabelText('Name')).toHaveValue('');
  expect(within(fresh).getByRole('button', { name: 'Save' })).toBeEnabled();
  expect(createProjectTag).toHaveBeenCalledOnce();
});

it('recovers after a real 404 access withdrawal without an accessRestored event', async () => {
  const recovered = Promise.withResolvers<ReturnType<typeof directAccessFixture>>();
  vi.mocked(getProjectAccess).mockResolvedValueOnce(directAccessFixture(projectId)).mockRejectedValueOnce(new ApiError('server', 404, 'not_found')).mockReturnValueOnce(recovered.promise);
  vi.mocked(createProjectTag).mockImplementation(async (_project, _name, _signal, admission) => {
    admission.onDispatch?.(); throw new ApiError('server', 403, 'permission_denied', null, undefined, undefined, undefined, 'not_committed');
  });
  const view = setup(); const events: { accessRevoked?: true; accessRestored?: true }[] = [];
  const unsubscribe = view.scope.subscribe(event => { if (event.projectId === projectId) events.push(event); });
  await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Name'), { target: { value: 'withdrawn draft' } });
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(events.some(event => event.accessRevoked)).toBe(true));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('button', { name: 'New tag' })).toBeDisabled();
  expect(events.some(event => event.accessRestored)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Check permission' }));
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(3));
  await act(async () => { recovered.resolve(directAccessFixture(projectId)); await recovered.promise; });
  await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  expect(events.some(event => event.accessRestored)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByLabelText('Name')).toHaveValue('');
  expect(createProjectTag).toHaveBeenCalledOnce();
  unsubscribe();
});

it('retires an in-flight permission check when the real project scope is revoked', async () => {
  const old = Promise.withResolvers<ReturnType<typeof directAccessFixture>>();
  vi.mocked(getProjectAccess).mockResolvedValueOnce(directAccessFixture(projectId)).mockRejectedValueOnce(new ApiError('network')).mockReturnValueOnce(old.promise).mockRejectedValue(new ApiError('network'));
  vi.mocked(createProjectTag).mockImplementation(async (_project, _name, _signal, admission) => {
    admission.onDispatch?.(); throw new ApiError('server', 403, 'permission_denied', null, undefined, undefined, undefined, 'not_committed');
  });
  const view = setup(); await screen.findByText('backend'); await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  const original = screen.getByRole('dialog');
  fireEvent.change(within(original).getByLabelText('Name'), { target: { value: 'old draft' } });
  fireEvent.click(within(original).getByRole('button', { name: 'Save' }));
  await within(original).findByText('Could not confirm project access. Try again.');
  fireEvent.click(within(original).getByRole('button', { name: 'Check permission' }));
  await waitFor(() => expect(getProjectAccess).toHaveBeenCalledTimes(3));
  const ticket = await view.scope.beginSync(projectId, view.scope.signal);
  await act(async () => { await view.scope.revokeProject(ticket, view.scope.signal, false); });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await act(async () => { old.resolve(directAccessFixture(projectId)); await old.promise; });
  expect(screen.getByRole('button', { name: 'New tag' })).toBeDisabled();
  vi.mocked(getProjectAccess).mockResolvedValue(directAccessFixture(projectId));
  fireEvent.click(screen.getByRole('button', { name: 'Check permission' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  expect(within(screen.getByRole('dialog')).getByLabelText('Name')).toHaveValue('');
  expect(createProjectTag).toHaveBeenCalledOnce();
});
