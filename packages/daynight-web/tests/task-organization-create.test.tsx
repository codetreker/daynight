import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createTask } from '../src/api/client';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { TaskOrganization } from '../src/features/task-detail/TaskOrganization';
import { renderWithLocale } from './helpers/renderWithLocale';
import { detailFixture, snapshotFixture } from './helpers/taskDetail';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), createTask: vi.fn() }));
vi.mock('../src/api/auth', () => ({ listProjectPeople: vi.fn().mockResolvedValue({ items: [], unresolvedUserIds: [] }) }));
vi.mock('../src/features/task-cache/TaskCacheProvider', () => {
  const scope = { userId: 'viewer', signal: new AbortController().signal, isInvalidated: false, principalMismatch: vi.fn(), ready: async () => {} };
  return { useTaskCacheScope: () => scope };
});
vi.mock('../src/features/projects/ProjectAccess', () => ({ ProjectAccessBoundary: ({ children }: { children: React.ReactNode }) => children, useProjectAccess: () => ({ ready: true, session: { waitForFreshAccess: async () => ({}) } }) }));
vi.mock('../src/features/task-tags/TagPicker', () => ({ TagPicker: ({ value, onChange, canWrite }: { value: readonly { id: string; name: string }[]; onChange: (value: readonly { id: string; name: string }[]) => void; canWrite: boolean }) => <div><output aria-label="Selected tags">{value.map(tag => tag.name).join(',')}</output><button type="button" disabled={!canWrite} onClick={() => onChange([{ id: 'tag-a', name: 'Alpha' }])}>Select Alpha</button></div> }));
const snapshot = { summaries: new Map(), index: { nodes: new Map() } } as unknown as GraphSnapshot;
afterEach(() => { cleanup(); document.getElementById('root')?.remove(); vi.clearAllMocks(); });

describe('Task creation', () => {
  it('lets the native menu and composing Escape finish before closing the form', () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    renderWithLocale(<TaskOrganization projectId="escape-project" snapshot={snapshot} onRefreshGraph={vi.fn()} />, { locale: 'en', container: root });
    const opener = screen.getByRole('button', { name: 'New Task' });
    opener.focus(); fireEvent.click(opener);
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Draft' } });
    const select = screen.getByRole('combobox', { name: 'Goal' });
    const matches = vi.spyOn(select, 'matches').mockImplementation(query => query === ':open');
    try {
      const popupEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      fireEvent(select, popupEscape);
      expect(popupEscape.defaultPrevented).toBe(false); expect(title).toHaveValue('Draft');
      matches.mockReturnValue(false);
      fireEvent.keyDown(select, { key: 'Escape', isComposing: true });
      expect(title).toHaveValue('Draft');
      const prevented = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      prevented.preventDefault(); fireEvent(select, prevented);
      expect(title).toHaveValue('Draft');
      fireEvent.keyDown(select, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull(); expect(opener).toHaveFocus();
      expect(createTask).not.toHaveBeenCalled();
    } finally { matches.mockRestore(); }
  });
  it('freezes the submitted draft while a delayed creation is pending', async () => {
    let resolve!: (value: never) => void;
    vi.mocked(createTask).mockReturnValue(new Promise(done => { resolve = done; }));
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    renderWithLocale(<TaskOrganization projectId="project" snapshot={snapshot} onRefreshGraph={vi.fn()} />, { locale: 'en', container: root });
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Submitted title' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Submitted description' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createTask).toHaveBeenCalledOnce());
    expect(vi.mocked(createTask).mock.calls[0]![1]).toMatchObject({ title: 'Submitted title', tagIds: [] });
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Description' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Goal' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Assignee' })).toBeDisabled();
    await act(async () => resolve({} as never));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not inherit tags from the parent Goal', async () => {
    const goal = detailFixture('parent-project', 'parent-goal', { type: 'goal', title: 'Parent', ready: false, tags: [{ id: 'parent-tag', name: 'Parent tag' }] });
    vi.mocked(createTask).mockResolvedValueOnce({} as never);
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    renderWithLocale(<TaskOrganization projectId="parent-project" goalId="parent-goal" snapshot={snapshotFixture([goal])} onRefreshGraph={vi.fn()} />, { locale: 'en', container: root });
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }));
    expect(screen.getByLabelText('Selected tags')).toHaveTextContent('');
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Child' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createTask).toHaveBeenCalledOnce());
    expect(vi.mocked(createTask).mock.calls[0]![1]).toMatchObject({ title: 'Child', parentId: 'parent-goal', tagIds: [] });
  });

  it('submits the selected tags once, freezes the selection while pending, and resets after success', async () => {
    const pending = Promise.withResolvers<never>();
    vi.mocked(createTask).mockReturnValue(pending.promise);
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    renderWithLocale(<TaskOrganization projectId="selected-project" snapshot={snapshot} onRefreshGraph={vi.fn()} />, { locale: 'en', container: root });
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Tagged task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createTask).toHaveBeenCalledOnce());
    expect(vi.mocked(createTask).mock.calls[0]![1]).toMatchObject({ title: 'Tagged task', tagIds: ['tag-a'] });
    expect(screen.getByRole('button', { name: 'Select Alpha' })).toBeDisabled();
    await act(async () => pending.resolve({} as never));
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }));
    expect(screen.getByLabelText('Selected tags')).toHaveTextContent('');
  });

  it('keeps the selection and other fields after a definite rejection and allows retry', async () => {
    vi.mocked(createTask).mockRejectedValueOnce(new ApiError('server', 400, 'tag_not_found', 'request'));
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    renderWithLocale(<TaskOrganization projectId="rejected-project" snapshot={snapshot} onRefreshGraph={vi.fn()} />, { locale: 'en', container: root });
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Draft task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Draft task');
    expect(screen.getByLabelText('Selected tags')).toHaveTextContent('Alpha');
    expect(createTask).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Draft task');
    expect(screen.getByLabelText('Selected tags')).toHaveTextContent('Alpha');
  });

  it('retains the selection after an unknown outcome without replaying creation', async () => {
    vi.mocked(createTask).mockRejectedValueOnce(new ApiError('network'));
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    renderWithLocale(<TaskOrganization projectId="unknown-project" snapshot={snapshot} onRefreshGraph={vi.fn()} />, { locale: 'en', container: root });
    fireEvent.click(screen.getByRole('button', { name: 'New Task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Draft task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText(/The result is unknown/)).toBeVisible();
    expect(screen.getByLabelText('Selected tags')).toHaveTextContent('Alpha');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(createTask).toHaveBeenCalledOnce();
  });
});
