import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { createProjectTag, listProjectTags, resolveProjectTags, type ProjectTag } from '../src/api/task-tags';
import type { TaskTag } from '../src/api/types';
import { TagPicker } from '../src/features/task-tags/TagPicker';
import { LocaleProvider } from '../src/i18n/LocaleProvider';

const env = vi.hoisted(() => ({ scope: null as any, access: null as any, listeners: new Set<(event: any) => void>() }));
vi.mock('../src/api/task-tags', async original => ({ ...await original<typeof import('../src/api/task-tags')>(), listProjectTags: vi.fn(), resolveProjectTags: vi.fn(), createProjectTag: vi.fn() }));
vi.mock('../src/features/task-cache/TaskCacheProvider', () => ({ useTaskCacheScope: () => env.scope }));
vi.mock('../src/features/projects/ProjectAccess', () => ({ useProjectAccessSession: () => env.access.session, useProjectAccess: () => env.access }));
const projectId = '00000000-0000-4000-8000-000000000031';
const epoch = '00000000-0000-4000-8000-000000000051';
const alpha: ProjectTag = { id: '00000000-0000-4000-8000-000000000041', projectId, name: 'Alpha', version: 1n, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', usage: { tasks: 0, goals: 0 } };
const beta: ProjectTag = { ...alpha, id: '00000000-0000-4000-8000-000000000042', name: 'Beta' };
const page = (items: ProjectTag[], nextCursor: string | null = null) => ({ items, catalogEpoch: epoch, nextCursor });
const list = vi.mocked(listProjectTags), resolve = vi.mocked(resolveProjectTags), create = vi.mocked(createProjectTag);
const Harness = ({ initial = [], onChange = () => {} }: { initial?: readonly TaskTag[]; onChange?: (tags: readonly TaskTag[]) => void }) => {
  const [value, setValue] = useState(initial);
  return <LocaleProvider initial={{ locale: 'en', issue: null }}><TagPicker projectId={projectId} value={value} onChange={tags => { setValue(tags); onChange(tags); }} canWrite /></LocaleProvider>;
};
beforeEach(() => {
  env.listeners.clear();
  env.scope = { userId: 'user', signal: new AbortController().signal, isInvalidated: false, principalMismatch: vi.fn(), isProjectSuspended: vi.fn().mockReturnValue(false), ready: vi.fn().mockResolvedValue(undefined), subscribe: (listener: (event: any) => void) => { env.listeners.add(listener); return () => env.listeners.delete(listener); } };
  env.access = { session: { waitForFreshAccess: vi.fn().mockResolvedValue({}), revalidateAfterMutation: vi.fn().mockResolvedValue({}) } };
  list.mockReset().mockResolvedValue(page([alpha]));
  resolve.mockReset().mockImplementation(async (_project, ids) => ids.map(id => id === alpha.id ? alpha : beta));
  create.mockReset();
});
afterEach(() => vi.clearAllMocks());

it('keeps selection across catalog pages and removes a selected tag no longer in the catalog', async () => {
  list.mockImplementation(async (_project, query) => query.cursor === null ? page([alpha], 'next') : page([beta]));
  const changes = vi.fn(); render(<Harness onChange={changes} />);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Alpha' }));
  await screen.findByRole('button', { name: 'Remove Alpha' });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Beta' }));
  await waitFor(() => expect(changes).toHaveBeenLastCalledWith([{ id: alpha.id, name: 'Alpha' }, { id: beta.id, name: 'Beta' }]));
  resolve.mockImplementation(async (_project, ids) => {
    if (ids.includes(alpha.id)) throw new ApiError('server', 404, 'tag_not_found');
    return [beta];
  });
  // The changed catalog epoch triggers a fresh selected-ID resolution.
  list.mockResolvedValue({ ...page([beta]), catalogEpoch: '00000000-0000-4000-8000-000000000052' });
  fireEvent.click(screen.getByRole('button', { name: 'First page' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Alpha' })).toBeNull());
  expect(screen.getByRole('button', { name: 'Remove Beta' })).toBeVisible();
});

it('retains the selected draft on resolve failure and retries explicitly', async () => {
  resolve.mockRejectedValueOnce(new ApiError('network')).mockResolvedValue([alpha]);
  render(<Harness initial={[alpha]} />);
  await screen.findByText('Could not load tags.');
  expect(screen.getByRole('button', { name: 'Remove Alpha' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText('Could not load tags.')).toBeNull());
});

it('creates an independent catalog tag and adds it to the local selection', async () => {
  create.mockResolvedValue(beta); const changes = vi.fn(); render(<Harness onChange={changes} />);
  await screen.findByRole('checkbox', { name: 'Alpha' });
  expect(screen.getByText(/cancelling editing will not delete/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Beta ' } });
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  await waitFor(() => expect(changes).toHaveBeenCalledWith([{ id: beta.id, name: 'Beta' }]));
  expect(create.mock.calls[0]!.slice(0, 2)).toEqual([projectId, 'Beta']);
});

it('preserves a later name typed while a create is in flight', async () => {
  const pending = Promise.withResolvers<ProjectTag>(); create.mockReturnValue(pending.promise);
  render(<Harness />); await screen.findByRole('checkbox', { name: 'Alpha' });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta' } });
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Later' } });
  await act(async () => { pending.resolve(beta); await pending.promise; });
  await screen.findByRole('button', { name: 'Remove Beta' });
  expect(screen.getByLabelText('Name')).toHaveValue('Later');
});

it('checks the submitted name after an uncertain create even if the input changed in flight', async () => {
  const pending = Promise.withResolvers<ProjectTag>();
  create.mockImplementation((_project, _name, _signal, admission) => { admission.onDispatch?.(); return pending.promise; });
  list.mockImplementation(async (_project, query) => query.query === 'Beta' ? page([beta]) : page([alpha]));
  render(<Harness />); await screen.findByRole('checkbox', { name: 'Alpha' });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta' } });
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Later' } });
  await act(async () => { pending.reject(new ApiError('network')); await pending.promise.catch(() => {}); });
  await screen.findByText(/outcome is unknown/); expect(screen.getByLabelText('Name')).toHaveValue('Later');
  expect(screen.getByText('Name: Beta')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Check current state' }));
  await screen.findByText('Current tag: Beta');
  expect(list.mock.calls.filter(call => call[1].query !== '').map(call => call[1].query)).toEqual(['Beta']);
  expect(create).toHaveBeenCalledOnce();
});

it('checks an unknown create across pages without replaying the POST', async () => {
  create.mockImplementation(async (_project, _name, _signal, admission) => { admission.onDispatch?.(); throw new ApiError('network'); });
  list.mockImplementation(async (_project, query) => query.query === 'Beta' ? query.cursor === null ? page([alpha], 'next') : page([beta]) : page([alpha]));
  render(<Harness />); await screen.findByRole('checkbox', { name: 'Alpha' });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta' } });
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  await screen.findByText(/outcome is unknown/);
  fireEvent.click(screen.getByRole('button', { name: 'Check current state' }));
  await screen.findByText('Current tag: Beta');
  expect(list.mock.calls.filter(call => call[1].query === 'Beta').map(call => call[1].cursor)).toEqual([null, 'next']);
  expect(create).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('Name')).toHaveValue('Beta');
});

it('retires a late creation response after closing the picker', async () => {
  const pending = Promise.withResolvers<ProjectTag>(); const old = vi.fn(), current = vi.fn();
  create.mockReturnValue(pending.promise);
  const view = render(<Harness onChange={old} />); await screen.findByRole('checkbox', { name: 'Alpha' });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta' } });
  fireEvent.click(screen.getByRole('button', { name: 'New tag' }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  view.unmount(); render(<Harness onChange={current} />); await screen.findByRole('checkbox', { name: 'Alpha' });
  await act(async () => { pending.resolve(beta); await pending.promise; });
  expect(old).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Remove Beta' })).toBeNull();
});
